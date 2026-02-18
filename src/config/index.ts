import dotenv from 'dotenv';
import { exit } from 'process';

dotenv.config();

interface Config {
  telegram: {
    botToken: string;
    adminUserIds: number[];
  };
  polymarket: {
    host: string;
    chainId: number;
  };
  database: {
    url: string;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  app: {
    nodeEnv: string;
    logLevel: string;
    encryptionKey: string;
  };
}

function validateConfig(): Config {
  const requiredEnvVars = [
    'TELEGRAM_BOT_TOKEN',
    'DATABASE_URL',
    'ENCRYPTION_KEY',
  ];

  const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);

  if (missingVars.length > 0) {
    console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
    exit(1);
  }

  // Validate encryption key length (must be 32 characters for AES-256)
  if (process.env.ENCRYPTION_KEY!.length !== 32) {
    console.error('ENCRYPTION_KEY must be exactly 32 characters for AES-256 encryption');
    exit(1);
  }

  const adminIds = process.env.ADMIN_USER_IDS
    ? process.env.ADMIN_USER_IDS.split(',').map((id) => parseInt(id.trim(), 10))
    : [];

  return {
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN!,
      adminUserIds: adminIds,
    },
    polymarket: {
      host: process.env.POLYMARKET_HOST || 'https://clob.polymarket.com',
      chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || '137', 10),
    },
    database: {
      url: process.env.DATABASE_URL!,
    },
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
    },
    app: {
      nodeEnv: process.env.NODE_ENV || 'development',
      logLevel: process.env.LOG_LEVEL || 'info',
      encryptionKey: process.env.ENCRYPTION_KEY!,
    },
  };
}

export const config = validateConfig();
