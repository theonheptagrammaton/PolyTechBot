import { ethers } from 'ethers';
import { decrypt } from '../utils/encryption';
import { config } from '../config';
import { logger } from '../utils/logger';

const RPC_URLS = [
  'https://polygon-rpc.com',
  'https://rpc-mainnet.matic.network',
  'https://polygon-bor-rpc.publicnode.com',
];

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

const GNOSIS_SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes calldata signatures) payable returns (bool success)',
];

async function getProvider(): Promise<ethers.providers.JsonRpcProvider> {
  for (const url of RPC_URLS) {
    try {
      const p = new ethers.providers.JsonRpcProvider(url);
      await Promise.race([
        p.getBlockNumber(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      return p;
    } catch {
      logger.warn(`[withdraw] RPC ${url} unresponsive, trying next...`);
    }
  }
  throw new Error('All RPCs unresponsive');
}

/**
 * Get token balance for a proxy address
 */
export async function getTokenBalance(
  proxyAddress: string,
  tokenAddress: string | 'native',
  decimals: number
): Promise<{ raw: bigint; formatted: string }> {
  const provider = await getProvider();

  let rawBN: ethers.BigNumber;
  if (tokenAddress === 'native') {
    rawBN = await provider.getBalance(proxyAddress);
  } else {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    rawBN = await token.balanceOf(proxyAddress);
  }

  const rawBig = BigInt(rawBN.toString());
  const formatted = parseFloat(ethers.utils.formatUnits(rawBN, decimals)).toFixed(4);
  return { raw: rawBig, formatted };
}

/**
 * Execute a withdrawal from the user's Gnosis Safe proxy.
 * - User's EOA signs the Safe tx (no gas needed)
 * - Platform executor submits execTransaction (pays MATIC gas)
 * - Proxy sends tokens to destination
 */
export async function executeWithdraw(params: {
  encryptedPrivateKey: string;
  proxyAddress: string;
  tokenAddress: string | 'native';
  tokenDecimals: number;
  destinationAddress: string;
  amount: number; // human-readable amount
}): Promise<{ success: boolean; txHash?: string; pending?: boolean; error?: string }> {
  const executorKey = config.commission.platformExecutorKey;

  if (!executorKey) {
    return { success: false, error: 'Platform executor not configured' };
  }

  try {
    const provider = await getProvider();
    const executor = new ethers.Wallet(executorKey, provider);

    const privateKey = decrypt(params.encryptedPrivateKey);
    const userSigner = new ethers.Wallet(privateKey);

    // Parse amount — cap decimal places to token precision
    const maxDecimals = Math.min(params.tokenDecimals, 6);
    const amountBN = ethers.utils.parseUnits(params.amount.toFixed(maxDecimals), params.tokenDecimals);

    const safeContract = new ethers.Contract(params.proxyAddress, GNOSIS_SAFE_ABI, provider);
    const nonce: ethers.BigNumber = await safeContract.nonce();

    let to: string;
    let value: ethers.BigNumber;
    let data: string;

    if (params.tokenAddress === 'native') {
      to = params.destinationAddress;
      value = amountBN;
      data = '0x';
    } else {
      const iface = new ethers.utils.Interface(ERC20_ABI);
      to = params.tokenAddress;
      value = ethers.BigNumber.from(0);
      data = iface.encodeFunctionData('transfer', [params.destinationAddress, amountBN]);
    }

    const operation = 0;
    const safeTxGas = 0;
    const baseGas = 0;
    const gasPrice = 0;
    const gasToken = ethers.constants.AddressZero;
    const refundReceiver = ethers.constants.AddressZero;

    const txHash: string = await safeContract.getTransactionHash(
      to, value, data, operation,
      safeTxGas, baseGas, gasPrice,
      gasToken, refundReceiver,
      nonce
    );

    const signingKey = new ethers.utils.SigningKey(userSigner.privateKey);
    const { v, r, s } = signingKey.signDigest(ethers.utils.arrayify(txHash));
    const signature = ethers.utils.hexlify(ethers.utils.concat([r, s, [v]]));

    logger.info(`[withdraw] Sending Safe execTransaction from ${params.proxyAddress.substring(0, 10)}... → ${params.destinationAddress.substring(0, 10)}...`);

    const safeWithExecutor = safeContract.connect(executor);
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

    logger.info(`[withdraw] Tx submitted: ${tx.hash}`);

    // Wait up to 30s for confirmation — show "pending" if not confirmed in time
    try {
      const receipt = await Promise.race([
        tx.wait(1),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('confirmation timeout')), 30_000)
        ),
      ]);
      logger.info(`[withdraw] Confirmed: ${receipt.transactionHash}`);
      return { success: true, txHash: receipt.transactionHash };
    } catch {
      // Tx was submitted but not yet confirmed — still a success
      logger.info(`[withdraw] Pending: ${tx.hash}`);
      return { success: true, txHash: tx.hash, pending: true };
    }
  } catch (error: any) {
    logger.error('[withdraw] Failed:', error?.message);
    return { success: false, error: error?.message || 'Unknown error' };
  }
}
