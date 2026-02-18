import { ethers, Wallet, Contract, providers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { RelayClient, CallType } from '@polymarket/relayer-client';
import { logger } from '../utils/logger';
import { decrypt } from '../utils/encryption';
import { redisCache } from '../database/redis';

// USDC Contract Addresses
const USDC_ADDRESSES = {
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC on Polygon PoS
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on Ethereum
  solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC on Solana
};

// RPC Endpoints
const RPC_URLS = {
  polygon: 'https://polygon-rpc.com',
  ethereum: 'https://eth.llamarpc.com',
  solana: 'https://api.mainnet-beta.solana.com',
};

// Polymarket Relayer URL
const POLYMARKET_RELAYER_URL = 'https://polygon-relayer.polymarket.com';

// Polymarket Deposit Contract (Polygon)
const POLYMARKET_DEPOSIT_CONTRACT = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'; // CTF Exchange

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

    // Initialize Relayer Client
    const relayerClient = new RelayClient(
      POLYMARKET_RELAYER_URL,
      137, // Polygon chain ID
      wallet
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

    // Create batch ProxyTransactions
    // CallType.Call = normal contract call
    const transactions = [
      {
        to: USDC_ADDRESSES.polygon,
        typeCode: CallType.Call,
        data: approveData,
        value: '0',
      },
      {
        to: POLYMARKET_DEPOSIT_CONTRACT,
        typeCode: CallType.Call,
        data: depositData,
        value: '0',
      },
    ];

    logger.info('[Relayer] Executing gasless transactions via Relayer...');

    // Execute batch transactions through relayer (gasless!)
    const result = await relayerClient.executeProxyTransactions(
      transactions,
      'Approve and deposit USDC to Polymarket'
    );

    logger.info(`[Relayer] Transactions submitted! Response:`, result);

    // Return transaction info
    return result.hash || 'relayer_submitted';
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
