import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { config } from '../config';
import { logger } from '../utils/logger';
import { maskSensitiveData } from '../utils/encryption';

export interface PolymarketCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

/**
 * Creates Polymarket API credentials for a wallet
 */
export async function createPolymarketCredentials(
  privateKey: string
): Promise<PolymarketCredentials> {
  try {
    logger.info('Creating Polymarket API credentials...');

    // Create wallet from private key
    const wallet = new Wallet(privateKey);

    logger.info(`Creating credentials for wallet: ${wallet.address}`);

    // Create temporary CLOB client
    const tempClient = new ClobClient(
      config.polymarket.host,
      config.polymarket.chainId,
      wallet
    );

    // Derive API credentials
    const apiCreds = await tempClient.createOrDeriveApiKey();

    if (!apiCreds || !apiCreds.key || !apiCreds.secret || !apiCreds.passphrase) {
      throw new Error('Failed to create API credentials: Invalid response');
    }

    logger.info('Polymarket API credentials created successfully');
    logger.debug(`API Key: ${maskSensitiveData(apiCreds.key)}`);

    return {
      apiKey: apiCreds.key,
      apiSecret: apiCreds.secret,
      passphrase: apiCreds.passphrase,
    };
  } catch (error) {
    logger.error('Error creating Polymarket credentials:', error);
    throw new Error('Failed to create Polymarket API credentials');
  }
}

/**
 * Creates a full CLOB client with credentials
 */
export async function createClobClient(
  privateKey: string,
  credentials: PolymarketCredentials
): Promise<ClobClient> {
  try {
    const wallet = new Wallet(privateKey);

    const client = new ClobClient(
      config.polymarket.host,
      config.polymarket.chainId,
      wallet,
      {
        key: credentials.apiKey,
        secret: credentials.apiSecret,
        passphrase: credentials.passphrase,
      },
      0 as any // Signature type 0 for EOA (Externally Owned Account)
    );

    logger.info(`CLOB client created for wallet: ${wallet.address}`);

    return client;
  } catch (error) {
    logger.error('Error creating CLOB client:', error);
    throw new Error('Failed to create CLOB client');
  }
}

/**
 * Validates Polymarket credentials
 */
export async function validateCredentials(
  privateKey: string,
  credentials: PolymarketCredentials
): Promise<boolean> {
  try {
    const client = await createClobClient(privateKey, credentials);

    // Try to get server time to validate connection
    await client.getServerTime();

    logger.info('Polymarket credentials validated successfully');
    return true;
  } catch (error) {
    logger.error('Error validating Polymarket credentials:', error);
    return false;
  }
}
