import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

/**
 * Derives a key from the encryption key using PBKDF2
 */
function deriveKey(salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    config.app.encryptionKey,
    salt,
    ITERATIONS,
    KEY_LENGTH,
    'sha512'
  );
}

/**
 * Encrypts a string value
 */
export function encrypt(text: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();

  // Format: salt:iv:tag:encrypted
  return `${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts an encrypted string
 */
export function decrypt(encryptedData: string): string {
  const parts = encryptedData.split(':');

  if (parts.length !== 4) {
    throw new Error('Invalid encrypted data format');
  }

  const salt = Buffer.from(parts[0], 'hex');
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const encrypted = parts[3];

  const key = deriveKey(salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Masks sensitive data for logging
 */
export function maskSensitiveData(data: string, visibleChars: number = 4): string {
  if (data.length <= visibleChars * 2) {
    return '***';
  }
  return `${data.slice(0, visibleChars)}...${data.slice(-visibleChars)}`;
}
