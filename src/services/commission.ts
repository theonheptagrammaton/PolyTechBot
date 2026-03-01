import { ethers } from 'ethers';
import { decrypt } from '../utils/encryption';
import { config } from '../config';
import { logger } from '../utils/logger';
import { creditReferralCommission } from './referral';

// Per-proxy serialization: prevents two concurrent execTransactions from racing on the same Safe nonce
const proxyQueue = new Map<string, Promise<unknown>>();

function enqueueForProxy<T>(proxyAddress: string, fn: () => Promise<T>): Promise<T> {
  const prev = proxyQueue.get(proxyAddress) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn regardless of previous result
  const queued = next.catch(() => {}); // keep queue alive even on error
  proxyQueue.set(proxyAddress, queued);
  // F3: Clean up after the queue drains — prevents unbounded Map growth as unique
  // proxy addresses accumulate over the lifetime of the process.
  queued.then(() => {
    if (proxyQueue.get(proxyAddress) === queued) proxyQueue.delete(proxyAddress);
  });
  return next;
}

// Multiple RPCs — tried in order until one works
const RPC_URLS = [
  'https://polygon-rpc.com',
  'https://rpc-mainnet.matic.network',
  'https://polygon-bor-rpc.publicnode.com',
];
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** Platform commission rate: 1% */
export const COMMISSION_RATE = 0.01;

// Gnosis Safe ABI — only what we need
const GNOSIS_SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes calldata signatures) payable returns (bool success)',
];

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
];

/**
 * Transfers USDC.e commission from user's Gnosis Safe proxy wallet to admin wallet.
 *
 * Mechanism:
 *  1. User's EOA signs a Gnosis Safe transaction hash (raw ECDSA, no gas)
 *  2. Platform executor (MATIC-funded) submits execTransaction on-chain
 *  3. The Safe proxy sends USDC.e to admin wallet
 *
 * The user pays no gas. Platform pays ~$0.003 MATIC per transaction.
 */
export function transferCommission(
  encryptedPrivateKey: string,
  proxyAddress: string,       // user's Gnosis Safe proxy address
  commissionUsdc: number,     // human-readable e.g. 0.10 for $0.10
  traderId?: string           // DB user ID — used to credit referral earnings
): Promise<{ success: boolean; txHash?: string }> {
  // Serialize per-proxy to prevent Safe nonce races when two trades fire simultaneously
  return enqueueForProxy(proxyAddress, () =>
    _transferCommission(encryptedPrivateKey, proxyAddress, commissionUsdc, traderId)
  );
}

async function _transferCommission(
  encryptedPrivateKey: string,
  proxyAddress: string,
  commissionUsdc: number,
  traderId?: string
): Promise<{ success: boolean; txHash?: string }> {
  const adminWallet = config.commission.adminWalletAddress;
  const executorKey = config.commission.platformExecutorKey;

  if (!adminWallet) {
    logger.warn('[commission] ADMIN_WALLET_ADDRESS not set — skipping commission transfer');
    return { success: false };
  }

  if (!executorKey) {
    logger.warn('[commission] PLATFORM_EXECUTOR_KEY not set — skipping commission transfer');
    return { success: false };
  }

  if (!proxyAddress) {
    logger.warn('[commission] proxyAddress is empty — skipping commission transfer');
    return { success: false };
  }

  // Skip sub-cent amounts (dust)
  if (commissionUsdc < 0.01) {
    logger.info(`[commission] Amount $${commissionUsdc.toFixed(6)} too small — skipping`);
    return { success: true };
  }

  try {
    // Try each RPC until one is responsive
    let provider!: ethers.providers.JsonRpcProvider;
    for (const url of RPC_URLS) {
      try {
        const p = new ethers.providers.JsonRpcProvider(url);
        await Promise.race([
          p.getBlockNumber(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('rpc timeout')), 5000)),
        ]);
        provider = p;
        break;
      } catch {
        logger.warn(`[commission] RPC ${url} unresponsive, trying next...`);
      }
    }
    if (!provider) throw new Error('All RPCs unresponsive');

    // Platform executor — pays gas for the execTransaction call
    const executor = new ethers.Wallet(executorKey, provider);

    // User's EOA — signs the Safe transaction (no gas needed)
    const privateKey = decrypt(encryptedPrivateKey);
    const userSigner = new ethers.Wallet(privateKey);

    // USDC.e has 6 decimals
    const amountRaw = Math.round(commissionUsdc * 1e6);

    // Encode ERC20 transfer(adminWallet, amount)
    const iface = new ethers.utils.Interface(ERC20_ABI);
    const transferData = iface.encodeFunctionData('transfer', [adminWallet, amountRaw]);

    // Connect to user's Gnosis Safe proxy
    const safeContract = new ethers.Contract(proxyAddress, GNOSIS_SAFE_ABI, provider);

    // Get current nonce to prevent replay attacks
    const nonce: ethers.BigNumber = await safeContract.nonce();

    // Gnosis Safe tx parameters — standard CALL (operation=0), no gas refund
    const to = USDC_E_ADDRESS;
    const value = 0;
    const data = transferData;
    const operation = 0;        // CALL
    const safeTxGas = 0;        // no gas refund to executor
    const baseGas = 0;
    const gasPrice = 0;
    const gasToken = ethers.constants.AddressZero;
    const refundReceiver = ethers.constants.AddressZero;

    // Compute the Safe transaction hash (EIP-712 via Safe's own function)
    const txHash: string = await safeContract.getTransactionHash(
      to, value, data, operation,
      safeTxGas, baseGas, gasPrice,
      gasToken, refundReceiver,
      nonce
    );

    // User's EOA signs the hash with raw ECDSA (no Ethereum prefix — Safe uses ecrecover directly)
    const signingKey = new ethers.utils.SigningKey(userSigner.privateKey);
    const { v, r, s } = signingKey.signDigest(ethers.utils.arrayify(txHash));

    // Pack v, r, s into 65-byte signature: r (32) + s (32) + v (1)
    const signature = ethers.utils.hexlify(
      ethers.utils.concat([r, s, [v]])
    );

    logger.info(
      `[commission] Submitting Safe execTransaction: $${commissionUsdc.toFixed(4)} USDC.e ` +
      `from ${proxyAddress.substring(0, 10)}... → ${adminWallet.substring(0, 10)}...`
    );

    // Platform executor submits the signed transaction on-chain (pays MATIC gas)
    // Polygon requires maxPriorityFeePerGas >= 30 Gwei (EIP-1559)
    const safeWithExecutor = safeContract.connect(executor);

    // 15s timeout on the send itself — if RPC hangs, abort
    const tx = await Promise.race([
      safeWithExecutor.execTransaction(
        to, value, data, operation,
        safeTxGas, baseGas, gasPrice,
        gasToken, refundReceiver,
        signature,
        {
          gasLimit: 200_000,
          maxPriorityFeePerGas: ethers.utils.parseUnits('30', 'gwei'),
          maxFeePerGas: ethers.utils.parseUnits('100', 'gwei'),
        }
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('send timeout after 15s')), 15_000)
      ),
    ]);

    logger.info(`[commission] Fee tx submitted: ${tx.hash} — waiting for confirmation`);

    // Wait for 1 confirmation before releasing the queue lock.
    // This ensures the Safe nonce increments on-chain before the next queued commission reads it.
    // Commission is already fire-and-forget at the call site, so waiting here doesn't block the user.
    let receipt: ethers.providers.TransactionReceipt;
    try {
      receipt = await Promise.race([
        tx.wait(1),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('confirmation timeout after 30s')), 30_000)),
      ]);
      if (receipt.status === 1) {
        logger.info(`[commission] Fee confirmed on-chain: ${receipt.transactionHash}`);
      } else {
        logger.warn(`[commission] Fee tx reverted on-chain: ${receipt.transactionHash}`);
      }
    } catch (waitErr: any) {
      if (waitErr?.replacement?.hash) {
        logger.info(`[commission] Fee tx replaced, replacement: ${waitErr.replacement.hash} (cancelled=${waitErr.cancelled})`);
      } else {
        logger.warn(`[commission] Fee tx wait failed: ${waitErr?.message || waitErr}`);
      }
    }

    // Credit referral earnings (fire-and-forget — doesn't block trade)
    if (traderId) {
      creditReferralCommission(traderId, commissionUsdc).catch((err) => {
        logger.warn('[commission] creditReferralCommission failed:', err?.message || err);
      });
    }

    return { success: true, txHash: tx.hash };
  } catch (error: any) {
    logger.error('[commission] Fee transfer failed:', error?.message || error);
    return { success: false };
  }
}
