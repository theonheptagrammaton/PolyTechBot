import { ethers } from 'ethers';
import { decrypt } from '../utils/encryption';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getPolygonProvider } from '../utils/provider';

const BRIDGE_API_URL = 'https://bridge.polymarket.com';

// USDC.e on Polygon — always the source token for cross-chain withdrawals
const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Destination USDC addresses per chain
const BRIDGE_CHAIN_CONFIG: Record<string, { chainId: string; toTokenAddress: string }> = {
  ethereum: { chainId: '1',                toTokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  bsc:      { chainId: '56',               toTokenAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
  solana:   { chainId: '1151111081099710',  toTokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
};

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

const GNOSIS_SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes calldata signatures) payable returns (bool success)',
];

/**
 * Create a Bridge withdrawal address.
 * Sends proxyAddress + destination info to Bridge API, returns the EVM address to send USDC.e to.
 */
async function createBridgeWithdrawAddress(
  proxyAddress: string,
  chain: string,
  recipientAddr: string,
): Promise<string> {
  const chainConfig = BRIDGE_CHAIN_CONFIG[chain];
  if (!chainConfig) throw new Error(`Unsupported bridge chain: ${chain}`);

  // Bridge API expects lowercase hex for EVM recipient addresses
  const normalizedRecipient = recipientAddr.startsWith('0x')
    ? recipientAddr.toLowerCase()
    : recipientAddr;

  const requestBody = {
    address: proxyAddress.toLowerCase(),
    toChainId: chainConfig.chainId,
    toTokenAddress: chainConfig.toTokenAddress,
    recipientAddr: normalizedRecipient,
  };
  logger.info(`[withdraw] Bridge withdraw request: ${JSON.stringify(requestBody)}`);

  const response = await fetch(`${BRIDGE_API_URL}/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bridge API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  logger.info(`[withdraw] Bridge withdraw response: ${JSON.stringify(data)}`);

  const bridgeAddress = data.address?.evm;
  if (!bridgeAddress) throw new Error('Bridge API returned no EVM withdrawal address');
  if (!ethers.utils.isAddress(bridgeAddress)) throw new Error(`Bridge API returned invalid EVM address: ${bridgeAddress}`);
  return bridgeAddress;
}

/**
 * Execute a cross-chain withdrawal via Bridge API.
 * Sends USDC.e from proxy → Bridge address → Bridge delivers USDC on destination chain.
 */
export async function executeBridgeWithdraw(params: {
  encryptedPrivateKey: string;
  proxyAddress: string;
  chain: string;
  recipientAddr: string;
  amount: number;
}): Promise<{ success: boolean; txHash?: string; pending?: boolean; error?: string }> {
  try {
    const bridgeAddress = await createBridgeWithdrawAddress(
      params.proxyAddress,
      params.chain,
      params.recipientAddr,
    );
    logger.info(`[withdraw] Sending ${params.amount} USDC.e to Bridge address ${bridgeAddress} for ${params.chain} withdrawal`);

    return await executeWithdraw({
      encryptedPrivateKey: params.encryptedPrivateKey,
      proxyAddress: params.proxyAddress,
      tokenAddress: USDC_E_POLYGON,
      tokenDecimals: 6,
      destinationAddress: bridgeAddress,
      amount: params.amount,
    });
  } catch (error: any) {
    logger.error('[withdraw] Bridge withdraw failed:', error?.message);
    return { success: false, error: error?.message || 'Unknown error' };
  }
}

/**
 * Get token balance for a proxy address
 */
export async function getTokenBalance(
  proxyAddress: string,
  tokenAddress: string | 'native',
  decimals: number
): Promise<{ raw: bigint; formatted: string }> {
  const provider = await getPolygonProvider();

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
    const provider = await getPolygonProvider();
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

    // Dynamic gas pricing — Polygon enforces a minimum gas tip (~25-30 gwei)
    const feeData = await provider.getFeeData();
    const MIN_PRIORITY = ethers.utils.parseUnits('30', 'gwei');
    const MIN_MAX_FEE  = ethers.utils.parseUnits('100', 'gwei');
    const rawPriority = feeData.maxPriorityFeePerGas ?? MIN_PRIORITY;
    const rawMaxFee   = feeData.maxFeePerGas ?? MIN_MAX_FEE;
    // Use whichever is higher: RPC suggestion or minimum floor, then bump 30%
    const boostedPriority = (rawPriority.gt(MIN_PRIORITY) ? rawPriority : MIN_PRIORITY).mul(130).div(100);
    const boostedMaxFee   = (rawMaxFee.gt(MIN_MAX_FEE) ? rawMaxFee : MIN_MAX_FEE).mul(130).div(100);

    const safeWithExecutor = safeContract.connect(executor);
    const tx = await Promise.race([
      safeWithExecutor.execTransaction(
        to, value, data, operation,
        safeTxGas, baseGas, gasPrice,
        gasToken, refundReceiver,
        signature,
        {
          gasLimit: 200_000,
          maxPriorityFeePerGas: boostedPriority,
          maxFeePerGas: boostedMaxFee,
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
