import { ethers, Wallet, Contract, providers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { ClobClient } from '@polymarket/clob-client';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
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
  polygon: 'https://polygon-bor-rpc.publicnode.com', // More reliable than polygon-rpc.com
  ethereum: 'https://eth.llamarpc.com',
  solana: 'https://api.mainnet-beta.solana.com',
};

// Polymarket Relayer URL (using v2 endpoint)
const POLYMARKET_RELAYER_URL = 'https://relayer-v2.polymarket.com/';

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
  encryptedPrivateKey: string
): Promise<{ success: boolean; txHash?: string; alreadyEnabled?: boolean }> {
  try {
    logger.info('[Relayer] Enabling trading with all required approvals...');

    const privateKey = decrypt(encryptedPrivateKey);
    const provider = new providers.JsonRpcProvider(RPC_URLS.polygon);
    const wallet = new Wallet(privateKey, provider);

    // Check if already approved (check one of the approvals)
    const ctfContract = new Contract(CTF_CONTRACT, CTF_ABI, provider);
    const isApproved = await ctfContract.isApprovedForAll(
      wallet.address,
      NEG_RISK_OPERATOR
    );

    if (isApproved) {
      logger.info('[Relayer] Trading already enabled');
      return { success: true, alreadyEnabled: true };
    }

    // Create BuilderConfig with builder credentials from env
    logger.info('[Relayer] Creating BuilderConfig with builder credentials...');
    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: config.polymarket.builder.apiKey,
        secret: config.polymarket.builder.secret,
        passphrase: config.polymarket.builder.passphrase,
      },
    });

    logger.info('[Relayer] BuilderConfig created successfully');

    // Initialize Relayer Client with builder config
    logger.info('[Relayer] Initializing RelayClient...');
    const relayerClient = new RelayClient(
      POLYMARKET_RELAYER_URL,
      137,
      wallet,
      builderConfig,
      RelayerTxType.SAFE
    );

    // Prepare all 3 approval transactions
    const erc20Interface = new ethers.utils.Interface(ERC20_ABI);
    const ctfInterface = new ethers.utils.Interface(CTF_ABI);

    const transactions = [
      // 1. Approve USDC.e for CTF Contract (to split USDC into outcome tokens)
      {
        to: POLYMARKET_ADDRESSES.USDCe,
        data: erc20Interface.encodeFunctionData('approve', [
          POLYMARKET_ADDRESSES.CTF,
          ethers.constants.MaxUint256,
        ]),
        value: '0',
      },
      // 2. Approve CTF tokens for CTF Exchange (to trade outcome tokens)
      {
        to: POLYMARKET_ADDRESSES.CTF,
        data: ctfInterface.encodeFunctionData('setApprovalForAll', [
          POLYMARKET_ADDRESSES.CTF_EXCHANGE,
          true,
        ]),
        value: '0',
      },
      // 3. Approve CTF tokens for Neg Risk CTF Exchange (to trade neg-risk markets)
      {
        to: POLYMARKET_ADDRESSES.CTF,
        data: ctfInterface.encodeFunctionData('setApprovalForAll', [
          POLYMARKET_ADDRESSES.NEG_RISK_CTF_EXCHANGE,
          true,
        ]),
        value: '0',
      },
    ];

    logger.info('[Relayer] Executing 3 gasless approval transactions...');
    logger.info('  1. USDC.e → CTF Contract');
    logger.info('  2. CTF → CTF Exchange');
    logger.info('  3. CTF → Neg Risk Exchange');

    // Execute all 3 approvals in one batch (gasless)
    const response = await relayerClient.execute(
      transactions,
      'Enable trading on Polymarket (3 approvals)'
    );

    logger.info('[Relayer] Waiting for transaction confirmation...');
    const result = await response.wait();

    logger.info('[Relayer] All trading approvals completed!', result);

    const txHash = result?.transactionHash || 'relayer_submitted';

    return { success: true, txHash };
  } catch (error) {
    logger.error('[Relayer] Error enabling trading:', error);
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
