import { ethers, Wallet, Contract, providers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { ClobClient } from '@polymarket/clob-client';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { logger } from '../utils/logger';
import { decrypt } from '../utils/encryption';
import { redisCache } from '../database/redis';
import { config } from '../config';

// USDC Contract Addresses
const USDC_ADDRESSES = {
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC on Polygon PoS
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on Ethereum
  solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC on Solana
};

// RPC Endpoints - Using reliable public nodes
const RPC_URLS = {
  polygon: 'https://rpc.ankr.com/polygon',
  ethereum: 'https://eth.llamarpc.com',
  solana: 'https://api.mainnet-beta.solana.com',
};

// Polymarket Relayer URL (used by approveAndDepositWithRelayer)
const POLYMARKET_RELAYER_URL = 'https://relayer-v2.polymarket.com/';

// RPC fallback list (same as withdraw.ts)
const POLYGON_RPC_LIST = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://1rpc.io/matic',
];

// Gnosis Safe ABI — same minimal set as withdraw.ts
const GNOSIS_SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes calldata signatures) payable returns (bool success)',
];

// Polymarket Contract Addresses (Polygon)
const POLYMARKET_ADDRESSES = {
  USDCe: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e on Polygon
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045', // Conditional Tokens Framework
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // CTF Exchange (for deposit)
  NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a', // Neg Risk CTF Exchange
  NEG_RISK_ADAPTER: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296', // Neg Risk Adapter
};

// Keep old constants for backwards compatibility
const POLYMARKET_DEPOSIT_CONTRACT = POLYMARKET_ADDRESSES.CTF_EXCHANGE;
const NEG_RISK_OPERATOR = POLYMARKET_ADDRESSES.NEG_RISK_CTF_EXCHANGE;
const CTF_CONTRACT = POLYMARKET_ADDRESSES.CTF;

// ERC20 ABI (minimal)
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// Polymarket CTF Exchange ABI (minimal)
const CTF_EXCHANGE_ABI = [
  'function deposit(uint256 amount)',
];

// CTF Contract ABI (for trading approval)
const CTF_ABI = [
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
];

export interface BalanceInfo {
  balance: string; // Human readable (e.g., "100.50")
  balanceRaw: string; // Raw balance (wei/lamports)
  chain: string;
  usdValue: string;
}

/**
 * Get USDC balance on EVM chains (Polygon, Ethereum)
 */
async function getEVMBalance(
  walletAddress: string,
  chain: 'polygon' | 'ethereum'
): Promise<BalanceInfo> {
  try {
    const provider = new providers.JsonRpcProvider(RPC_URLS[chain]);
    const usdcAddress = USDC_ADDRESSES[chain];

    // Create USDC contract instance
    const usdcContract = new Contract(usdcAddress, ERC20_ABI, provider);

    // Get balance
    const balance = await usdcContract.balanceOf(walletAddress);
    const decimals = await usdcContract.decimals();

    // Convert to human readable
    const balanceFormatted = ethers.utils.formatUnits(balance, decimals);

    logger.info(`${chain} USDC balance for ${walletAddress}: ${balanceFormatted}`);

    return {
      balance: balanceFormatted,
      balanceRaw: balance.toString(),
      chain,
      usdValue: balanceFormatted, // USDC = $1
    };
  } catch (error) {
    logger.error(`Error getting ${chain} balance:`, error);
    throw new Error(`Failed to get ${chain} balance`);
  }
}

/**
 * Get USDC balance on Solana
 */
async function getSolanaBalance(walletAddress: string): Promise<BalanceInfo> {
  try {
    const connection = new Connection(RPC_URLS.solana, 'confirmed');
    const usdcMint = new PublicKey(USDC_ADDRESSES.solana);
    const walletPubkey = new PublicKey(walletAddress);

    // Get associated token account
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      mint: usdcMint,
    });

    if (tokenAccounts.value.length === 0) {
      // No USDC account found
      return {
        balance: '0',
        balanceRaw: '0',
        chain: 'solana',
        usdValue: '0',
      };
    }

    const tokenAccount = tokenAccounts.value[0];
    const balance = tokenAccount.account.data.parsed.info.tokenAmount.uiAmount;
    const balanceRaw = tokenAccount.account.data.parsed.info.tokenAmount.amount;

    logger.info(`Solana USDC balance for ${walletAddress}: ${balance}`);

    return {
      balance: balance.toString(),
      balanceRaw: balanceRaw.toString(),
      chain: 'solana',
      usdValue: balance.toString(),
    };
  } catch (error) {
    logger.error('Error getting Solana balance:', error);
    // Return 0 instead of throwing if account doesn't exist
    return {
      balance: '0',
      balanceRaw: '0',
      chain: 'solana',
      usdValue: '0',
    };
  }
}

/**
 * Get USDC balance for all chains
 */
export async function getAllBalances(
  evmAddress: string,
  solanaAddress?: string
): Promise<{
  polygon: BalanceInfo;
  ethereum: BalanceInfo;
  solana: BalanceInfo;
  total: string;
}> {
  try {
    const cacheKey = `balance:all:${evmAddress}`;
    const cached = await redisCache.get<any>(cacheKey);

    if (cached) {
      logger.debug('Returning cached all balances');
      return cached;
    }

    // Fetch all balances in parallel
    const [polygon, ethereum, solana] = await Promise.all([
      getEVMBalance(evmAddress, 'polygon'),
      getEVMBalance(evmAddress, 'ethereum'),
      solanaAddress ? getSolanaBalance(solanaAddress) : Promise.resolve({
        balance: '0',
        balanceRaw: '0',
        chain: 'solana',
        usdValue: '0',
      }),
    ]);

    // Calculate total
    const total = (
      parseFloat(polygon.balance) +
      parseFloat(ethereum.balance) +
      parseFloat(solana.balance)
    ).toFixed(2);

    const result = {
      polygon,
      ethereum,
      solana,
      total,
    };

    // Cache for 1 minute
    await redisCache.set(cacheKey, result, 60);

    return result;
  } catch (error) {
    logger.error('Error getting all balances:', error);
    throw new Error('Failed to get balances');
  }
}

/**
 * Get balance for specific chain
 */
export async function getChainBalance(
  chain: 'polygon' | 'ethereum' | 'solana',
  address: string
): Promise<BalanceInfo> {
  try {
    const cacheKey = `balance:${chain}:${address}`;
    const cached = await redisCache.get<BalanceInfo>(cacheKey);

    if (cached) {
      logger.debug(`Returning cached ${chain} balance`);
      return cached;
    }

    let balance: BalanceInfo;

    if (chain === 'solana') {
      balance = await getSolanaBalance(address);
    } else {
      balance = await getEVMBalance(address, chain);
    }

    // Cache for 1 minute
    await redisCache.set(cacheKey, balance, 60);

    return balance;
  } catch (error) {
    logger.error(`Error getting ${chain} balance:`, error);
    throw new Error(`Failed to get ${chain} balance`);
  }
}

/**
 * Approve USDC for Polymarket deposit
 */
export async function approveUSDC(
  encryptedPrivateKey: string,
  amount: string
): Promise<string> {
  try {
    logger.info('Approving USDC for Polymarket deposit');

    const privateKey = decrypt(encryptedPrivateKey);
    const provider = new providers.JsonRpcProvider(RPC_URLS.polygon);
    const wallet = new Wallet(privateKey, provider);

    // USDC contract
    const usdcContract = new Contract(USDC_ADDRESSES.polygon, ERC20_ABI, wallet);

    // Convert amount to raw (6 decimals for USDC)
    const amountRaw = ethers.utils.parseUnits(amount, 6);

    // Check current allowance
    const currentAllowance = await usdcContract.allowance(
      wallet.address,
      POLYMARKET_DEPOSIT_CONTRACT
    );

    if (currentAllowance.gte(amountRaw)) {
      logger.info('USDC already approved');
      return 'already_approved';
    }

    // Approve
    const tx = await usdcContract.approve(POLYMARKET_DEPOSIT_CONTRACT, amountRaw);
    logger.info(`USDC approve tx sent: ${tx.hash}`);

    // Wait for confirmation
    const receipt = await tx.wait();
    logger.info(`USDC approve confirmed: ${receipt.transactionHash}`);

    return receipt.transactionHash;
  } catch (error) {
    logger.error('Error approving USDC:', error);
    throw new Error('Failed to approve USDC');
  }
}

/**
 * Deposit USDC to Polymarket
 */
export async function depositToPolymarket(
  encryptedPrivateKey: string,
  amount: string
): Promise<string> {
  try {
    logger.info(`Depositing ${amount} USDC to Polymarket`);

    const privateKey = decrypt(encryptedPrivateKey);
    const provider = new providers.JsonRpcProvider(RPC_URLS.polygon);
    const wallet = new Wallet(privateKey, provider);

    // CTF Exchange contract
    const ctfContract = new Contract(POLYMARKET_DEPOSIT_CONTRACT, CTF_EXCHANGE_ABI, wallet);

    // Convert amount to raw (6 decimals for USDC)
    const amountRaw = ethers.utils.parseUnits(amount, 6);

    // Deposit
    const tx = await ctfContract.deposit(amountRaw);
    logger.info(`Polymarket deposit tx sent: ${tx.hash}`);

    // Wait for confirmation
    const receipt = await tx.wait();
    logger.info(`Polymarket deposit confirmed: ${receipt.transactionHash}`);

    return receipt.transactionHash;
  } catch (error) {
    logger.error('Error depositing to Polymarket:', error);
    throw new Error('Failed to deposit to Polymarket');
  }
}

/**
 * Enable trading by doing ALL required approvals (GASLESS!)
 * According to Polymarket docs, we need 3 approvals:
 * 1. USDC.e → CTF Contract (to split USDC into outcome tokens)
 * 2. CTF tokens → CTF Exchange (to trade outcome tokens)
 * 3. CTF tokens → Neg Risk CTF Exchange (to trade neg-risk markets)
 */
export async function enableTrading(
  encryptedPrivateKey: string,
  proxyAddress?: string,
  predexonUserId?: string
): Promise<{ success: boolean; txHash?: string; alreadyEnabled?: boolean }> {
  if (predexonUserId) {
    logger.info('[deposit] enableTrading: Predexon user — skipping (Predexon manages approvals)');
    return { success: true, alreadyEnabled: true };
  }

  try {
    logger.info('[Trading] Enabling trading with all required approvals...');

    const privateKey = decrypt(encryptedPrivateKey);

    // Find a working RPC — race all in parallel, first to respond wins
    let provider: providers.JsonRpcProvider;
    try {
      provider = await Promise.any(
        POLYGON_RPC_LIST.map(async (url) => {
          const p = new providers.JsonRpcProvider(url);
          await Promise.race([
            p.getBlockNumber(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
          ]);
          return p;
        })
      );
    } catch {
      throw new Error('All RPCs unresponsive');
    }

    const ethersWallet = new Wallet(privateKey);
    const checkAddress = proxyAddress || ethersWallet.address;
    const ctfContract = new Contract(CTF_CONTRACT, CTF_ABI, provider);

    const NATIVE_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
    const nativeUsdcContract = new Contract(NATIVE_USDC, ERC20_ABI, provider);
    const usdceContract = new Contract(POLYMARKET_ADDRESSES.USDCe, ERC20_ABI, provider);

    const threshold = ethers.utils.parseUnits('1000', 6);

    const [
      stdApproved, negRiskApproved, negRiskAdapterApproved,
      nativeCtfAllowance, nativeNegRiskAllowance, nativeAdapterAllowance,
      usdceCtfAllowance, usdceNegRiskAllowance, usdceAdapterAllowance,
    ] = await Promise.all([
      ctfContract.isApprovedForAll(checkAddress, POLYMARKET_ADDRESSES.CTF_EXCHANGE),
      ctfContract.isApprovedForAll(checkAddress, POLYMARKET_ADDRESSES.NEG_RISK_CTF_EXCHANGE),
      ctfContract.isApprovedForAll(checkAddress, POLYMARKET_ADDRESSES.NEG_RISK_ADAPTER),
      nativeUsdcContract.allowance(checkAddress, POLYMARKET_ADDRESSES.CTF_EXCHANGE),
      nativeUsdcContract.allowance(checkAddress, POLYMARKET_ADDRESSES.NEG_RISK_CTF_EXCHANGE),
      nativeUsdcContract.allowance(checkAddress, POLYMARKET_ADDRESSES.NEG_RISK_ADAPTER),
      usdceContract.allowance(checkAddress, POLYMARKET_ADDRESSES.CTF_EXCHANGE),
      usdceContract.allowance(checkAddress, POLYMARKET_ADDRESSES.NEG_RISK_CTF_EXCHANGE),
      usdceContract.allowance(checkAddress, POLYMARKET_ADDRESSES.NEG_RISK_ADAPTER),
    ]);

    const nativeCtfOk       = (nativeCtfAllowance as ethers.BigNumber).gte(threshold);
    const nativeNegRiskOk   = (nativeNegRiskAllowance as ethers.BigNumber).gte(threshold);
    const nativeAdapterOk   = (nativeAdapterAllowance as ethers.BigNumber).gte(threshold);
    const usdceCtfOk        = (usdceCtfAllowance as ethers.BigNumber).gte(threshold);
    const usdceNegRiskOk    = (usdceNegRiskAllowance as ethers.BigNumber).gte(threshold);
    const usdceAdapterOk    = (usdceAdapterAllowance as ethers.BigNumber).gte(threshold);

    logger.info(
      `[Trading] On-chain approvals for ${checkAddress.slice(0, 10)}... — ` +
      `CTF ERC1155: ${stdApproved}, NegRisk ERC1155: ${negRiskApproved}, NegRiskAdapter ERC1155: ${negRiskAdapterApproved}, ` +
      `NativeUSDC→CTF: ${nativeCtfOk}, NativeUSDC→NegRisk: ${nativeNegRiskOk}, NativeUSDC→Adapter: ${nativeAdapterOk}, ` +
      `USDCe→CTF: ${usdceCtfOk}, USDCe→NegRisk: ${usdceNegRiskOk}, USDCe→Adapter: ${usdceAdapterOk}`
    );

    if (stdApproved && negRiskApproved && negRiskAdapterApproved && nativeCtfOk && nativeNegRiskOk && nativeAdapterOk && usdceCtfOk && usdceNegRiskOk && usdceAdapterOk) {
      logger.info('[Trading] All approvals already set on-chain');
      return { success: true, alreadyEnabled: true };
    }

    // Build list of approval calls needed
    const erc20Iface = new ethers.utils.Interface(ERC20_ABI);
    const ctfIface   = new ethers.utils.Interface(CTF_ABI);

    type ApprovalCall = { to: string; data: string; label: string };
    const calls: ApprovalCall[] = [];

    if (!nativeCtfOk)    calls.push({ to: NATIVE_USDC, data: erc20Iface.encodeFunctionData('approve', [POLYMARKET_ADDRESSES.CTF_EXCHANGE, ethers.constants.MaxUint256]), label: 'NativeUSDC→CTF_Exchange' });
    if (!nativeNegRiskOk) calls.push({ to: NATIVE_USDC, data: erc20Iface.encodeFunctionData('approve', [POLYMARKET_ADDRESSES.NEG_RISK_CTF_EXCHANGE, ethers.constants.MaxUint256]), label: 'NativeUSDC→NegRisk' });
    if (!nativeAdapterOk) calls.push({ to: NATIVE_USDC, data: erc20Iface.encodeFunctionData('approve', [POLYMARKET_ADDRESSES.NEG_RISK_ADAPTER, ethers.constants.MaxUint256]), label: 'NativeUSDC→NegRiskAdapter' });
    if (!usdceCtfOk)     calls.push({ to: POLYMARKET_ADDRESSES.USDCe, data: erc20Iface.encodeFunctionData('approve', [POLYMARKET_ADDRESSES.CTF_EXCHANGE, ethers.constants.MaxUint256]), label: 'USDCe→CTF_Exchange' });
    if (!usdceNegRiskOk) calls.push({ to: POLYMARKET_ADDRESSES.USDCe, data: erc20Iface.encodeFunctionData('approve', [POLYMARKET_ADDRESSES.NEG_RISK_CTF_EXCHANGE, ethers.constants.MaxUint256]), label: 'USDCe→NegRisk' });
    if (!usdceAdapterOk) calls.push({ to: POLYMARKET_ADDRESSES.USDCe, data: erc20Iface.encodeFunctionData('approve', [POLYMARKET_ADDRESSES.NEG_RISK_ADAPTER, ethers.constants.MaxUint256]), label: 'USDCe→NegRiskAdapter' });
    if (!stdApproved)           calls.push({ to: POLYMARKET_ADDRESSES.CTF, data: ctfIface.encodeFunctionData('setApprovalForAll', [POLYMARKET_ADDRESSES.CTF_EXCHANGE, true]), label: 'CTF→CTF_Exchange' });
    if (!negRiskApproved)       calls.push({ to: POLYMARKET_ADDRESSES.CTF, data: ctfIface.encodeFunctionData('setApprovalForAll', [POLYMARKET_ADDRESSES.NEG_RISK_CTF_EXCHANGE, true]), label: 'CTF→NegRisk' });
    if (!negRiskAdapterApproved) calls.push({ to: POLYMARKET_ADDRESSES.CTF, data: ctfIface.encodeFunctionData('setApprovalForAll', [POLYMARKET_ADDRESSES.NEG_RISK_ADAPTER, true]), label: 'CTF→NegRiskAdapter' });

    logger.info(`[Trading] Setting ${calls.length} missing approvals: ${calls.map(c => c.label).join(', ')}`);

    // Use Gnosis Safe execTransaction (same as withdraw.ts) — platform executor pays gas.
    // This executes approvals ON the correct proxy (checkAddress = user.polymarketProxyAddress),
    // unlike the builder relayer which uses its own unrelated proxy address.
    const executorKey = config.commission?.platformExecutorKey;
    if (!executorKey) {
      logger.error('[Trading] platformExecutorKey not configured — cannot set approvals');
      return { success: false };
    }

    const executor   = new Wallet(executorKey, provider);
    const userSigner = new Wallet(privateKey);
    const signingKey = new ethers.utils.SigningKey(userSigner.privateKey);

    const safeContract = new ethers.Contract(checkAddress, GNOSIS_SAFE_ABI, provider);
    const safeWithExecutor = safeContract.connect(executor);

    // Get current nonce once, then pre-compute all nonces for parallel broadcast
    const baseNonce: ethers.BigNumber = await safeContract.nonce();
    logger.info(`[Trading] Broadcasting ${calls.length} approval txs in parallel (base nonce: ${baseNonce.toString()})`);

    const txPromises = calls.map(async (call, i) => {
      const nonce = baseNonce.add(i);
      const txHash: string = await safeContract.getTransactionHash(
        call.to, 0, call.data, 0,
        0, 0, 0,
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        nonce
      );
      const { v, r, s } = signingKey.signDigest(ethers.utils.arrayify(txHash));
      const signature = ethers.utils.hexlify(ethers.utils.concat([r, s, [v]]));

      logger.info(`[Trading]   → ${call.label} (nonce=${nonce.toString()})`);
      const tx = await Promise.race([
        safeWithExecutor.execTransaction(
          call.to, 0, call.data, 0,
          0, 0, 0,
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
          signature,
          {
            gasLimit: 150_000,
            nonce: await executor.getTransactionCount('pending').then(n => n + i),
            maxPriorityFeePerGas: ethers.utils.parseUnits('30', 'gwei'),
            maxFeePerGas: ethers.utils.parseUnits('300', 'gwei'),
          }
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('execTransaction timeout')), 30_000)),
      ]);
      const receipt = await (tx as ethers.ContractTransaction).wait(1);
      logger.info(`[Trading]   ✓ ${call.label} confirmed: ${receipt.transactionHash}`);
      return receipt.transactionHash;
    });

    const hashes = await Promise.all(txPromises);
    const lastTxHash = hashes[hashes.length - 1];

    return { success: true, txHash: lastTxHash };
  } catch (error) {
    logger.error('[Trading] Error enabling trading:', error);
    return { success: false };
  }
}

/**
 * Check if trading is enabled for a wallet
 */
export async function isTradingEnabled(walletAddress: string): Promise<boolean> {
  try {
    const provider = new providers.JsonRpcProvider(RPC_URLS.polygon);
    const ctfContract = new Contract(CTF_CONTRACT, CTF_ABI, provider);

    const isApproved = await ctfContract.isApprovedForAll(
      walletAddress,
      NEG_RISK_OPERATOR
    );

    return isApproved;
  } catch (error) {
    logger.error('Error checking trading status:', error);
    return false;
  }
}

/**
 * Approve and Deposit USDC to Polymarket using Relayer API (GASLESS!)
 * This function uses Polymarket's Relayer to cover all gas fees
 */
export async function approveAndDepositWithRelayer(
  encryptedPrivateKey: string,
  amount: string
): Promise<string> {
  try {
    logger.info(`[Relayer] Approving and depositing ${amount} USDC to Polymarket (gasless)`);

    const privateKey = decrypt(encryptedPrivateKey);
    const provider = new providers.JsonRpcProvider(RPC_URLS.polygon);
    const wallet = new Wallet(privateKey, provider);

    // Create ClobClient to get builder config
    const clobClient = new ClobClient(
      'https://clob.polymarket.com',
      137,
      wallet
    );

    // Get builder config
    const builderConfig = clobClient.builderConfig;

    // Initialize Relayer Client with builder config
    const relayerClient = new RelayClient(
      POLYMARKET_RELAYER_URL,
      137,
      wallet,
      builderConfig,
      RelayerTxType.SAFE
    );

    // Convert amount to raw (6 decimals for USDC)
    const amountRaw = ethers.utils.parseUnits(amount, 6);

    logger.info('[Relayer] Creating batch transactions for approve and deposit...');

    // Create contract interfaces for encoding
    const usdcInterface = new ethers.utils.Interface(ERC20_ABI);
    const ctfInterface = new ethers.utils.Interface(CTF_EXCHANGE_ABI);

    // Encode approve transaction
    const approveData = usdcInterface.encodeFunctionData('approve', [
      POLYMARKET_DEPOSIT_CONTRACT,
      amountRaw,
    ]);

    // Encode deposit transaction
    const depositData = ctfInterface.encodeFunctionData('deposit', [amountRaw]);

    // Create batch transactions
    const transactions = [
      {
        to: USDC_ADDRESSES.polygon,
        data: approveData,
        value: '0',
      },
      {
        to: POLYMARKET_DEPOSIT_CONTRACT,
        data: depositData,
        value: '0',
      },
    ];

    logger.info('[Relayer] Executing gasless transactions via Relayer...');

    // Execute batch transactions through relayer (gasless!)
    const response = await relayerClient.execute(
      transactions,
      'Approve and deposit USDC to Polymarket'
    );

    logger.info('[Relayer] Waiting for transaction confirmation...');
    const result = await response.wait();

    logger.info(`[Relayer] Transactions confirmed!`, result);

    // Return transaction info
    return result?.transactionHash || 'relayer_submitted';
  } catch (error) {
    logger.error('[Relayer] Error with gasless deposit:', error);
    throw new Error('Failed to execute gasless deposit');
  }
}

/**
 * Format balance for display
 */
export function formatBalance(balance: string): string {
  const num = parseFloat(balance);
  if (num >= 1000) {
    return `$${(num / 1000).toFixed(2)}K`;
  }
  return `$${num.toFixed(2)}`;
}
