import { Wallet } from '@ethersproject/wallet';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from '../utils/logger';
import { maskSensitiveData } from '../utils/encryption';

export interface WalletInfo {
  address: string;
  privateKey: string;
}

export interface SolanaWalletInfo {
  address: string;
  privateKey: string; // Base58 encoded
}

/**
 * Creates a new Ethereum wallet
 */
export async function createWallet(): Promise<WalletInfo> {
  try {
    logger.info('Creating new wallet...');

    // Create a random wallet
    const wallet = Wallet.createRandom();

    const walletInfo: WalletInfo = {
      address: wallet.address,
      privateKey: wallet.privateKey,
    };

    logger.info(`Wallet created successfully: ${walletInfo.address}`);
    logger.debug(`Private key: ${maskSensitiveData(walletInfo.privateKey)}`);

    return walletInfo;
  } catch (error) {
    logger.error('Error creating wallet:', error);
    throw new Error('Failed to create wallet');
  }
}

/**
 * Validates if a private key is valid
 */
export function isValidPrivateKey(privateKey: string): boolean {
  try {
    new Wallet(privateKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets wallet from private key
 */
export function getWalletFromPrivateKey(privateKey: string): Wallet {
  try {
    return new Wallet(privateKey);
  } catch (error) {
    logger.error('Error loading wallet from private key:', error);
    throw new Error('Invalid private key');
  }
}

/**
 * Validates if an address is a valid Ethereum address
 */
export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Creates a new Solana wallet
 */
export async function createSolanaWallet(): Promise<SolanaWalletInfo> {
  try {
    logger.info('Creating new Solana wallet...');

    // Create a random Solana keypair
    const keypair = Keypair.generate();

    const walletInfo: SolanaWalletInfo = {
      address: keypair.publicKey.toBase58(),
      privateKey: bs58.encode(keypair.secretKey),
    };

    logger.info(`Solana wallet created successfully: ${walletInfo.address}`);
    logger.debug(`Solana private key: ${maskSensitiveData(walletInfo.privateKey)}`);

    return walletInfo;
  } catch (error) {
    logger.error('Error creating Solana wallet:', error);
    throw new Error('Failed to create Solana wallet');
  }
}

/**
 * Validates if an address is a valid Solana address
 */
export function isValidSolanaAddress(address: string): boolean {
  try {
    // Solana addresses are Base58 encoded and typically 32-44 characters
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  } catch {
    return false;
  }
}
