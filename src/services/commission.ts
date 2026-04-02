import { ethers } from 'ethers';
import { decrypt } from '../utils/encryption';
import { config } from '../config';
import { logger } from '../utils/logger';
import { creditReferralCommission } from './referral';
import { prisma } from '../database/prisma';

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
  'https://polygon-bor-rpc.publicnode.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://1rpc.io/matic',
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
  traderId?: string,          // DB user ID — used to credit referral earnings
  predexonUserId?: string     // if set, use Predexon withdraw path instead of Safe signing
): Promise<{ success: boolean; txHash?: string }> {
  const adminWallet = config.commission.adminWalletAddress;

  // Predexon-managed wallets: use Predexon withdraw API (no EOA Safe signing needed)
  if (predexonUserId && adminWallet) {
    return _transferCommissionPredexon(predexonUserId, commissionUsdc, adminWallet, traderId);
  }

  // Serialize per-proxy to prevent Safe nonce races when two trades fire simultaneously
  return enqueueForProxy(proxyAddress, () =>
    _transferCommission(encryptedPrivateKey, proxyAddress, commissionUsdc, traderId)
  );
}

async function _transferCommissionPredexon(
  predexonUserId: string,
  commissionUsdc: number,
  adminWallet: string,
  traderId?: string,
): Promise<{ success: boolean; txHash?: string }> {
  if (commissionUsdc < 0.01) {
    logger.info(`[commission] Predexon: amount $${commissionUsdc.toFixed(6)} too small — skipping`);
    return { success: true };
  }

  try {
    const { withdraw } = await import('./predexon');
    const result = await withdraw(predexonUserId, {
      venue: 'polymarket',
      amount: commissionUsdc.toFixed(6),
      destinationAddress: adminWallet,
      chain: 'polygon',
    });

    logger.info(`[commission] Predexon commission $${commissionUsdc.toFixed(4)} → ${adminWallet.substring(0, 10)}... tx: ${result.transactionHash}`);

    prisma.commissionLog.create({ data: { userId: traderId ?? null, amount: commissionUsdc } })
      .catch((err) => logger.warn('[commission] Failed to log commission:', err?.message || err));

    if (traderId) {
      creditReferralCommission(traderId, commissionUsdc).catch((err) => {
        logger.warn('[commission] creditReferralCommission failed:', err?.message || err);
      });
      import('./cashback').then(({ creditCashback }) => {
        creditCashback(traderId, commissionUsdc).catch((err) => {
          logger.warn('[commission] creditCashback failed:', err?.message || err);
        });
      });
    }

    return { success: true, txHash: result.transactionHash };
  } catch (error: any) {
    logger.error(`[commission] Predexon commission failed: ${error?.message ?? String(error)}`);
    return { success: false };
  }
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
    // Build list of responsive providers (try all in parallel, keep working ones)
    const providerResults = await Promise.allSettled(
      RPC_URLS.map(async (url) => {
        const p = new ethers.providers.JsonRpcProvider(url);
        await Promise.race([
          p.getBlockNumber(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        return p;
      })
    );
    const providers = providerResults
      .filter((r): r is PromiseFulfilledResult<ethers.providers.JsonRpcProvider> => r.status === 'fulfilled')
      .map(r => r.value);

    if (providers.length === 0) throw new Error('All RPCs unresponsive');

    // Use first responsive provider for read calls (nonce, tx hash)
    const provider = providers[0];

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

    const txParams = {
      gasLimit: 200_000,
      maxPriorityFeePerGas: ethers.utils.parseUnits('50', 'gwei'),
      maxFeePerGas: ethers.utils.parseUnits('200', 'gwei'),
    };

    logger.info(
      `[commission] Submitting Safe execTransaction via ${providers.length} RPC(s): $${commissionUsdc.toFixed(4)} USDC.e ` +
      `from ${proxyAddress.substring(0, 10)}... → ${adminWallet.substring(0, 10)}...`
    );

    // Submit to ALL responsive RPCs simultaneously — ensures at least one broadcasts to the network.
    // Single-RPC submission often results in the node accepting but not forwarding the TX.
    const txSends = providers.map(async (p) => {
      const exec = new ethers.Wallet(executorKey, p);
      const safe = new ethers.Contract(proxyAddress, GNOSIS_SAFE_ABI, p).connect(exec);
      return (safe as any).execTransaction(
        to, value, data, operation,
        safeTxGas, baseGas, gasPrice,
        gasToken, refundReceiver,
        signature,
        txParams
      ) as Promise<ethers.ContractTransaction>;
    });

    // Take first successful send (others may fail with "already known" — that's fine)
    let tx: ethers.ContractTransaction | null = null;
    const sendResults = await Promise.allSettled(txSends);
    for (const res of sendResults) {
      if (res.status === 'fulfilled') { tx = res.value; break; }
    }
    if (!tx) {
      const errs = sendResults.map(r => r.status === 'rejected' ? r.reason?.message : 'ok').join('; ');
      throw new Error(`All RPC sends failed: ${errs}`);
    }

    logger.info(`[commission] Fee tx submitted: ${tx.hash} — waiting for confirmation`);

    // Wait for 1 confirmation. Use the provider that successfully submitted.
    let receipt: ethers.providers.TransactionReceipt;
    try {
      receipt = await Promise.race([
        tx.wait(1),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('confirmation timeout after 60s')), 60_000)),
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

    // Log commission to DB for admin stats
    prisma.commissionLog.create({ data: { userId: traderId ?? null, amount: commissionUsdc } })
      .catch((err) => logger.warn('[commission] Failed to log commission:', err?.message || err));

    // Credit referral earnings + cashback (fire-and-forget — don't block trade)
    if (traderId) {
      creditReferralCommission(traderId, commissionUsdc).catch((err) => {
        logger.warn('[commission] creditReferralCommission failed:', err?.message || err);
      });

      import('./cashback').then(({ creditCashback }) => {
        creditCashback(traderId, commissionUsdc).catch((err) => {
          logger.warn('[commission] creditCashback failed:', err?.message || err);
        });
      });
    }

    return { success: true, txHash: tx.hash };
  } catch (error: any) {
    logger.error(`[commission] Fee transfer failed: ${error?.message ?? String(error)}`);
    return { success: false };
  }
}
