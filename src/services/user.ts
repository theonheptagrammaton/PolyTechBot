import { User } from '@prisma/client';
import { prisma } from '../database/prisma';
import { redisCache } from '../database/redis';
import { encrypt, decrypt } from '../utils/encryption';
import { logger } from '../utils/logger';
import { createWallet } from './wallet';
import { updatePolymarketProfile } from './polymarket';
import { setupPolymarketAccount } from './polymarketSetup';
import { config } from '../config';

export interface PolymarketCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

export interface UserWalletInfo {
  walletAddress: string; // EVM wallet for deposits (Polygon, Ethereum, BNB)
  privateKey: string;
  polymarketProxyAddress: string; // Polymarket Safe/Proxy for trading (don't deposit here)
}

export interface UserWithCredentials {
  user: User;
  walletInfo: UserWalletInfo;
  polymarketCredentials: PolymarketCredentials;
}

/**
 * Creates a new user with wallet and Polymarket credentials
 */
export async function createUserWithWallet(
  telegramId: string,
  username?: string,
  firstName?: string,
  lastName?: string
): Promise<UserWithCredentials> {
  try {
    logger.info(`Creating new user with wallet for Telegram ID: ${telegramId}`);

    // Check if user already exists
    const existingUser = await getUserByTelegramId(telegramId);
    if (existingUser) {
      logger.info(`User already exists: ${telegramId}`);
      return getCompleteUserInfo(existingUser);
    }

    // Create new EVM wallet (for deposits: Polygon, Ethereum, BNB)
    const walletInfo = await createWallet();
    logger.info(`EVM wallet created: ${walletInfo.address}`);

    // Setup complete Polymarket account (API credentials + Proxy wallet)
    logger.info('Setting up Polymarket account...');
    const polymarketSetup = await setupPolymarketAccount(walletInfo.privateKey);

    logger.info('✅ Complete Polymarket account setup:');
    logger.info(`  - EOA: ${polymarketSetup.eoaAddress}`);
    logger.info(`  - Proxy: ${polymarketSetup.proxyAddress}`);
    logger.info(`  - API Key: ${polymarketSetup.apiKey.substring(0, 10)}...`);

    const polymarketCreds = {
      apiKey: polymarketSetup.apiKey,
      apiSecret: polymarketSetup.apiSecret,
      passphrase: polymarketSetup.passphrase,
    };

    const polymarketProxyAddress = polymarketSetup.proxyAddress;

    // Encrypt sensitive data
    const encryptedPrivateKey = encrypt(walletInfo.privateKey);
    const encryptedApiKey = encrypt(polymarketCreds.apiKey);
    const encryptedApiSecret = encrypt(polymarketCreds.apiSecret);
    const encryptedPassphrase = encrypt(polymarketCreds.passphrase);

    // Check if user should be admin
    const isAdmin = config.telegram.adminUserIds.includes(parseInt(telegramId, 10));

    // Save user to database with deposit addresses
    const user = await prisma.user.create({
      data: {
        telegramId,
        username,
        firstName,
        lastName,
        walletAddress: walletInfo.address,
        encryptedPrivateKey,
        polymarketProxyAddress,
        depositAddressEvm: polymarketSetup.depositAddresses.evm,
        depositAddressSvm: polymarketSetup.depositAddresses.svm,
        depositAddressBtc: polymarketSetup.depositAddresses.btc,
        depositAddressTvm: polymarketSetup.depositAddresses.tvm,
        encryptedApiKey,
        encryptedApiSecret,
        encryptedPassphrase,
        isAdmin,
      },
    });

    logger.info(`User created successfully: ${user.id}`);

    // Enable trading automatically (one-time approval for CTF contract)
    logger.info('[Setup] Enabling trading for new user...');
    const { enableTrading } = await import('./deposit');
    enableTrading(encryptedPrivateKey)
      .then(async (result) => {
        if (result.success) {
          // Update user record to mark trading as enabled
          await prisma.user.update({
            where: { id: user.id },
            data: { tradingEnabled: true },
          });
          logger.info(`✅ Trading enabled successfully for user: ${user.id}`);
        } else {
          logger.warn(`⚠️ Could not enable trading for user: ${user.id} (can be done later)`);
        }
      })
      .catch((error) => {
        logger.error('[Setup] Enable trading failed (non-blocking):', error);
      });

    // Try to update Polymarket profile with bot name
    // This runs in background and doesn't block user creation
    updatePolymarketProfile(walletInfo.privateKey, 'PolyTech Bot')
      .then((success) => {
        if (success) {
          logger.info(`Polymarket profile updated for user: ${user.id}`);
        } else {
          logger.warn(`Could not update Polymarket profile for user: ${user.id} (will show as "anon")`);
        }
      })
      .catch((error) => {
        logger.error('Profile update failed (non-blocking):', error);
      });

    // Cache user data
    await cacheUser(user);

    return {
      user,
      walletInfo: {
        walletAddress: walletInfo.address,
        privateKey: walletInfo.privateKey,
        polymarketProxyAddress,
      },
      polymarketCredentials: polymarketCreds,
    };
  } catch (error) {
    logger.error('Error creating user with wallet:', error);
    throw new Error('Failed to create user with wallet');
  }
}

/**
 * Gets complete user info including decrypted credentials
 */
export async function getCompleteUserInfo(user: User): Promise<UserWithCredentials> {
  try {
    const privateKey = decrypt(user.encryptedPrivateKey);
    const apiKey = decrypt(user.encryptedApiKey);
    const apiSecret = decrypt(user.encryptedApiSecret);
    const passphrase = decrypt(user.encryptedPassphrase);

    // For backwards compatibility, if proxy address is null, we should create it
    let polymarketProxyAddress = user.polymarketProxyAddress;
    if (!polymarketProxyAddress) {
      logger.warn(`User ${user.id} has no proxy address, fetching/creating one...`);
      const { getExistingProxyAddress } = await import('./polymarketSetup');
      polymarketProxyAddress = await getExistingProxyAddress(privateKey);

      // If still no proxy, this is an old user - they need to use the new system
      if (!polymarketProxyAddress) {
        throw new Error('No Polymarket proxy address found. Please contact support.');
      }

      // Update user with the proxy address
      await prisma.user.update({
        where: { id: user.id },
        data: { polymarketProxyAddress },
      });
    }

    return {
      user,
      walletInfo: {
        walletAddress: user.walletAddress,
        privateKey,
        polymarketProxyAddress,
      },
      polymarketCredentials: {
        apiKey,
        apiSecret,
        passphrase,
      },
    };
  } catch (error) {
    logger.error('Error getting complete user info:', error);
    throw new Error('Failed to decrypt user credentials');
  }
}

/**
 * Gets user by Telegram ID
 */
export async function getUserByTelegramId(telegramId: string): Promise<User | null> {
  try {
    // Try cache first
    const cacheKey = `user:telegram:${telegramId}`;
    const cachedUser = await redisCache.get<User>(cacheKey);

    if (cachedUser) {
      logger.debug(`User found in cache: ${telegramId}`);
      return cachedUser;
    }

    // Get from database
    const user = await prisma.user.findUnique({
      where: { telegramId },
    });

    if (user) {
      await cacheUser(user);
    }

    return user;
  } catch (error) {
    logger.error('Error getting user by Telegram ID:', error);
    return null;
  }
}

/**
 * Gets user by wallet address
 */
export async function getUserByWalletAddress(walletAddress: string): Promise<User | null> {
  try {
    const cacheKey = `user:wallet:${walletAddress}`;
    const cachedUser = await redisCache.get<User>(cacheKey);

    if (cachedUser) {
      return cachedUser;
    }

    const user = await prisma.user.findUnique({
      where: { walletAddress },
    });

    if (user) {
      await cacheUser(user);
    }

    return user;
  } catch (error) {
    logger.error('Error getting user by wallet address:', error);
    return null;
  }
}

/**
 * Updates user information
 */
export async function updateUser(
  userId: string,
  data: {
    username?: string;
    firstName?: string;
    lastName?: string;
    isActive?: boolean;
  }
): Promise<User> {
  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data,
    });

    await cacheUser(user);

    return user;
  } catch (error) {
    logger.error('Error updating user:', error);
    throw new Error('Failed to update user');
  }
}

/**
 * Caches user data in Redis
 */
async function cacheUser(user: User): Promise<void> {
  const ttl = 3600; // 1 hour

  await Promise.all([
    redisCache.set(`user:telegram:${user.telegramId}`, user, ttl),
    redisCache.set(`user:wallet:${user.walletAddress}`, user, ttl),
    redisCache.set(`user:id:${user.id}`, user, ttl),
  ]);
}

/**
 * Invalidates user cache
 */
export async function invalidateUserCache(user: User): Promise<void> {
  await Promise.all([
    redisCache.delete(`user:telegram:${user.telegramId}`),
    redisCache.delete(`user:wallet:${user.walletAddress}`),
    redisCache.delete(`user:id:${user.id}`),
  ]);
}

/**
 * Checks if user is admin
 */
export function isUserAdmin(user: User): boolean {
  return user.isAdmin;
}

/**
 * Gets all users (admin only)
 */
export async function getAllUsers(): Promise<User[]> {
  try {
    return await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });
  } catch (error) {
    logger.error('Error getting all users:', error);
    throw new Error('Failed to get users');
  }
}

/**
 * Gets user count
 */
export async function getUserCount(): Promise<number> {
  try {
    const cacheKey = 'stats:user:count';
    const cachedCount = await redisCache.get<number>(cacheKey);

    if (cachedCount !== null) {
      return cachedCount;
    }

    const count = await prisma.user.count();
    await redisCache.set(cacheKey, count, 300); // Cache for 5 minutes

    return count;
  } catch (error) {
    logger.error('Error getting user count:', error);
    return 0;
  }
}
