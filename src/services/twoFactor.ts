import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { encrypt, decrypt } from '../utils/encryption';
import { prisma } from '../database/prisma';
import { invalidateUserCache } from './user';

/**
 * Generate 2FA secret for user
 */
export async function generateTwoFactorSecret(
  telegramId: string,
  username?: string
): Promise<{ secret: string; qrCode: string; backupCodes: string[] }> {
  try {
    // Generate secret
    const secret = speakeasy.generateSecret({
      name: `Polymarket Bot (${username || telegramId})`,
      issuer: 'Polymarket Trading Bot',
      length: 32,
    });

    // Generate QR code
    const qrCode = await QRCode.toDataURL(secret.otpauth_url || '');

    // Generate 12 backup codes
    const backupCodes = generateBackupCodes(12);

    logger.info(`2FA secret generated for user: ${telegramId}`);

    return {
      secret: secret.base32,
      qrCode,
      backupCodes,
    };
  } catch (error) {
    logger.error('Error generating 2FA secret:', error);
    throw new Error('Failed to generate 2FA secret');
  }
}

/**
 * Generate backup codes
 */
function generateBackupCodes(count: number): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // Generate 8-character alphanumeric code
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(code);
  }
  return codes;
}

/**
 * Enable 2FA for user
 */
export async function enableTwoFactor(
  telegramId: string,
  secret: string,
  token: string,
  backupCodes: string[]
): Promise<boolean> {
  try {
    // Verify token first
    const isValid = verifyTwoFactorToken(secret, token);
    if (!isValid) {
      logger.warn(`Invalid 2FA token during setup for user: ${telegramId}`);
      return false;
    }

    // Encrypt secret and backup codes
    const encryptedSecret = encrypt(secret);
    const encryptedBackupCodes = encrypt(JSON.stringify(backupCodes));

    // Update user in database
    const user = await prisma.user.update({
      where: { telegramId },
      data: {
        twoFactorSecret: encryptedSecret,
        twoFactorEnabled: true,
        backupCodes: encryptedBackupCodes,
      },
    });

    // Invalidate user cache
    await invalidateUserCache(user);

    logger.info(`2FA enabled for user: ${telegramId}`);
    return true;
  } catch (error) {
    logger.error('Error enabling 2FA:', error);
    throw new Error('Failed to enable 2FA');
  }
}

/**
 * Disable 2FA for user
 */
export async function disableTwoFactor(telegramId: string): Promise<void> {
  try {
    const user = await prisma.user.update({
      where: { telegramId },
      data: {
        twoFactorSecret: null,
        twoFactorEnabled: false,
        backupCodes: null,
      },
    });

    // Invalidate user cache
    await invalidateUserCache(user);

    logger.info(`2FA disabled for user: ${telegramId}`);
  } catch (error) {
    logger.error('Error disabling 2FA:', error);
    throw new Error('Failed to disable 2FA');
  }
}

/**
 * Verify 2FA token
 */
export function verifyTwoFactorToken(secret: string, token: string): boolean {
  try {
    const verified = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token,
      window: 2, // Allow 2 windows (60 seconds) of drift
    });

    return verified;
  } catch (error) {
    logger.error('Error verifying 2FA token:', error);
    return false;
  }
}

/**
 * Verify 2FA token for user (from database)
 */
export async function verifyUserTwoFactorToken(
  telegramId: string,
  token: string
): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId },
      select: { twoFactorSecret: true, twoFactorEnabled: true, backupCodes: true },
    });

    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return false;
    }

    // Decrypt secret
    const secret = decrypt(user.twoFactorSecret);

    // First try TOTP verification
    const isValid = verifyTwoFactorToken(secret, token);
    if (isValid) {
      return true;
    }

    // If TOTP fails, try backup codes
    if (user.backupCodes) {
      const backupCodes = JSON.parse(decrypt(user.backupCodes)) as string[];
      const backupCodeIndex = backupCodes.indexOf(token.toUpperCase());

      if (backupCodeIndex !== -1) {
        // Remove used backup code
        backupCodes.splice(backupCodeIndex, 1);

        // Update database
        const updatedUser = await prisma.user.update({
          where: { telegramId },
          data: {
            backupCodes: encrypt(JSON.stringify(backupCodes)),
          },
        });

        // Invalidate user cache
        await invalidateUserCache(updatedUser);

        logger.info(`Backup code used for user: ${telegramId}, remaining: ${backupCodes.length}`);
        return true;
      }
    }

    return false;
  } catch (error) {
    logger.error('Error verifying user 2FA token:', error);
    return false;
  }
}

/**
 * Check if user has 2FA enabled
 */
export async function isTwoFactorEnabled(telegramId: string): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId },
      select: { twoFactorEnabled: true },
    });

    return user?.twoFactorEnabled || false;
  } catch (error) {
    logger.error('Error checking 2FA status:', error);
    return false;
  }
}

/**
 * Get remaining backup codes count
 */
export async function getRemainingBackupCodes(telegramId: string): Promise<number> {
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId },
      select: { backupCodes: true },
    });

    if (!user || !user.backupCodes) {
      return 0;
    }

    const backupCodes = JSON.parse(decrypt(user.backupCodes)) as string[];
    return backupCodes.length;
  } catch (error) {
    logger.error('Error getting backup codes count:', error);
    return 0;
  }
}
