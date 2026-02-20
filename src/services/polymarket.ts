import { ClobClient } from '@polymarket/clob-client';
import { RelayClient } from '@polymarket/relayer-client';
import { Wallet } from '@ethersproject/wallet';
import { providers } from 'ethers';
import { config } from '../config';
import { logger } from '../utils/logger';
import { maskSensitiveData } from '../utils/encryption';
import axios from 'axios';

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
 * Gets Polymarket Proxy/Safe wallet address after it's been created
 * Note: The proxy is created by Polymarket on first deposit, not by us
 * This function only retrieves an existing proxy address
 */
export async function getPolymarketProxyAddress(privateKey: string): Promise<string | null> {
  try {
    logger.info('Checking for existing Polymarket proxy address...');

    const provider = new providers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
    const wallet = new Wallet(privateKey, provider);

    // Create Relayer client to check for proxy address
    const relayerClient = new RelayClient(
      'https://polygon-relayer.polymarket.com',
      137, // Polygon chain ID
      wallet
    );

    // Try to get existing proxy address
    try {
      const relayPayload = await relayerClient.getRelayPayload(wallet.address, 'EOA');

      if (relayPayload && relayPayload.address) {
        logger.info(`Polymarket proxy address found: ${relayPayload.address}`);
        return relayPayload.address;
      }
    } catch (error) {
      logger.debug('No existing proxy address found (this is normal for new accounts)');
    }

    // No proxy exists yet - will be created on first deposit
    logger.info('No proxy address yet - will be created by Polymarket on first deposit');
    return null;
  } catch (error) {
    logger.error('Error checking Polymarket proxy address:', error);
    return null;
  }
}

/**
 * Updates user's Polymarket proxy address in database
 * Call this after first deposit to fetch and save the proxy address
 */
export async function updateUserProxyAddress(userId: string, privateKey: string): Promise<string | null> {
  try {
    const proxyAddress = await getPolymarketProxyAddress(privateKey);

    if (proxyAddress) {
      // Update in database
      const { prisma } = await import('../database/prisma');
      await prisma.user.update({
        where: { id: userId },
        data: { polymarketProxyAddress: proxyAddress },
      });

      logger.info(`Updated proxy address for user ${userId}: ${proxyAddress}`);
      return proxyAddress;
    }

    return null;
  } catch (error) {
    logger.error('Error updating user proxy address:', error);
    return null;
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

/**
 * Updates Polymarket profile (username/pseudonym)
 */
export async function updatePolymarketProfile(
  privateKey: string,
  username: string
): Promise<boolean> {
  try {
    logger.info(`Attempting to update Polymarket profile with username: ${username}`);

    const wallet = new Wallet(privateKey);
    const address = wallet.address;

    // Create signature for authentication
    const timestamp = Date.now();
    const message = `Update profile for ${address} at ${timestamp}`;
    const signature = await wallet.signMessage(message);

    // Try different possible endpoints (Polymarket's profile API)
    const endpoints = [
      'https://clob.polymarket.com/profile',
      'https://gamma-api.polymarket.com/profile',
      'https://strapi-matic.poly.market/profiles',
    ];

    for (const endpoint of endpoints) {
      try {
        logger.debug(`Trying profile update endpoint: ${endpoint}`);

        const response = await axios.post(
          endpoint,
          {
            address: address.toLowerCase(),
            username: username,
            pseudonym: username,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'POLY-ADDRESS': address.toLowerCase(),
              'POLY-SIGNATURE': signature,
              'POLY-TIMESTAMP': timestamp.toString(),
            },
            timeout: 10000,
          }
        );

        if (response.status === 200 || response.status === 201) {
          logger.info(`Successfully updated Polymarket profile to: ${username}`);
          return true;
        }
      } catch (endpointError: any) {
        logger.debug(`Endpoint ${endpoint} failed:`, endpointError.message);
        // Continue to next endpoint
      }
    }

    logger.warn('All profile update endpoints failed. Profile may need manual update on Polymarket website.');
    return false;
  } catch (error) {
    logger.error('Error updating Polymarket profile:', error);
    return false;
  }
}
