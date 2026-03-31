import { User } from '@prisma/client';
import { prisma } from '../database/prisma';
import { redisCache } from '../database/redis';
import { encrypt, decrypt } from '../utils/encryption';
import { logger } from '../utils/logger';
import { createWallet } from './wallet';
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

    // Create new EVM wallet (for commission transfers & other chain ops)
    const walletInfo = await createWallet();
    logger.info(`EVM wallet created: ${walletInfo.address}`);

    // Setup Polymarket account via Predexon (managed wallet, no Builder quota)
    logger.info('Setting up Polymarket account via Predexon...');
    const polymarketSetup = await setupPolymarketAccount(walletInfo.privateKey, walletInfo.address);

    logger.info('✅ Predexon account setup complete:');
    logger.info(`  - Predexon userId: ${polymarketSetup.predexonUserId}`);
    logger.info(`  - Polymarket wallet: ${polymarketSetup.proxyAddress}`);

    const polymarketProxyAddress = polymarketSetup.proxyAddress;

    // Encrypt sensitive data
    const encryptedPrivateKey = encrypt(walletInfo.privateKey);
    // Legacy CLOB credentials — Predexon manages trading, store placeholder
    const encryptedApiKey = encrypt(polymarketSetup.apiKey);
    const encryptedApiSecret = encrypt(polymarketSetup.apiSecret);
    const encryptedPassphrase = encrypt(polymarketSetup.passphrase);

    // Check if user should be admin
    const isAdmin = config.telegram.adminUserIds.includes(parseInt(telegramId, 10));

    // Save user to database with deposit addresses and Predexon userId
    const user = await prisma.user.create({
      data: {
        telegramId,
        username,
        firstName,
        lastName,
        walletAddress: walletInfo.address,
        encryptedPrivateKey,
        predexonUserId: polymarketSetup.predexonUserId,
        polymarketProxyAddress,
        depositAddressEvm: polymarketSetup.depositAddresses.evm,
        depositAddressSvm: polymarketSetup.depositAddresses.svm,
        depositAddressBtc: polymarketSetup.depositAddresses.btc,
        depositAddressTvm: polymarketSetup.depositAddresses.tvm,
        encryptedApiKey,
        encryptedApiSecret,
        encryptedPassphrase,
        tradingEnabled: true, // Predexon handles approvals automatically
        isAdmin,
      },
    });

    logger.info(`User created successfully: ${user.id}`);

    // Cache user data
    await cacheUser(user);

    return {
      user,
      walletInfo: {
        walletAddress: walletInfo.address,
        privateKey: walletInfo.privateKey,
        polymarketProxyAddress,
      },
      polymarketCredentials: {
        apiKey: polymarketSetup.apiKey,
        apiSecret: polymarketSetup.apiSecret,
        passphrase: polymarketSetup.passphrase,
      },
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

    // Lazy migration: if user has no predexonUserId, create one now
    if (!user.predexonUserId) {
      logger.warn(`User ${user.id} has no Predexon userId, migrating...`);
      await ensurePredexonUser(user);
    }

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
 * Ensures a user has a Predexon userId. Creates one via lazy migration if missing.
 * Updates the DB record and invalidates cache.
 */
export async function ensurePredexonUser(user: User): Promise<string> {
  if (user.predexonUserId) return user.predexonUserId;

  const { createAndWaitForUser } = await import('./predexon');
  const predexonUser = await createAndWaitForUser();

  await prisma.user.update({
    where: { id: user.id },
    data: {
      predexonUserId: predexonUser.userId,
      polymarketProxyAddress: predexonUser.polymarketWalletAddress,
      tradingEnabled: true,
    },
  });

  // Update the in-memory object too
  user.predexonUserId = predexonUser.userId;
  user.polymarketProxyAddress = predexonUser.polymarketWalletAddress;
  user.tradingEnabled = true;

  await invalidateUserCache(user);

  logger.info(`[lazyMigration] Predexon user created for ${user.id}: ${predexonUser.userId}`);
  return predexonUser.userId;
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
  if (user.isAdmin) return true;
  const telegramIdNum = parseInt(user.telegramId, 10);
  return config.telegram.adminUserIds.includes(telegramIdNum);
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
 * Replaces the user's wallet with a new private key (import wallet flow).
 * Re-derives Polymarket proxy via CREATE2 — if the wallet was previously used on
 * Polymarket the same proxy address is reused automatically.
 */
export async function replaceUserWallet(
  userId: string,
  privateKey: string,
): Promise<{ walletAddress: string; polymarketProxyAddress: string }> {
  const { getWalletFromPrivateKey } = await import('./wallet');
  const eoaAddress = getWalletFromPrivateKey(privateKey).address;

  // Duplicate-wallet check: another user must not own this EOA
  const existing = await prisma.user.findFirst({
    where: { walletAddress: eoaAddress, NOT: { id: userId } },
  });
  if (existing) {
    throw new Error('This wallet address is already in use by another account.');
  }

  logger.info(`[importWallet] Setting up Polymarket account via Predexon for EOA: ${eoaAddress}`);
  const setup = await setupPolymarketAccount(privateKey, eoaAddress);
  logger.info(`[importWallet] Predexon userId: ${setup.predexonUserId}, Proxy: ${setup.proxyAddress}`);

  const encryptedPrivateKey  = encrypt(privateKey);
  const encryptedApiKey      = encrypt(setup.apiKey);
  const encryptedApiSecret   = encrypt(setup.apiSecret);
  const encryptedPassphrase  = encrypt(setup.passphrase);

  // Fetch the old user record so we can invalidate its cache keys
  const oldUser = await prisma.user.findUnique({ where: { id: userId } });

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      walletAddress:         eoaAddress,
      encryptedPrivateKey,
      predexonUserId:        setup.predexonUserId,
      polymarketProxyAddress: setup.proxyAddress,
      depositAddressEvm:     setup.depositAddresses.evm,
      depositAddressSvm:     setup.depositAddresses.svm,
      depositAddressBtc:     setup.depositAddresses.btc,
      depositAddressTvm:     setup.depositAddresses.tvm,
      encryptedApiKey,
      encryptedApiSecret,
      encryptedPassphrase,
      tradingEnabled:        true, // Predexon handles approvals automatically
    },
  });

  // Invalidate old cache keys (old wallet address etc.)
  if (oldUser) await invalidateUserCache(oldUser);

  // Cache fresh record
  await Promise.all([
    redisCache.set(`user:telegram:${updatedUser.telegramId}`, updatedUser, 3600),
    redisCache.set(`user:wallet:${updatedUser.walletAddress}`, updatedUser, 3600),
    redisCache.set(`user:id:${updatedUser.id}`, updatedUser, 3600),
  ]);

  return { walletAddress: eoaAddress, polymarketProxyAddress: setup.proxyAddress };
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
