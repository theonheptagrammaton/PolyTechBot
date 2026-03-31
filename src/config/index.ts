import dotenv from 'dotenv';
import { exit } from 'process';

dotenv.config();

interface Config {
  telegram: {
    botToken: string;
    botUsername: string;
    adminUserIds: number[];
    groupBotToken?: string;
    requiredGroupId?: number;
    requiredGroupLink?: string;
    webhookDomain?: string;
    webhookPort?: number;
  };
  predexon: {
    apiKey: string;
    tradeUrl: string;
    dataUrl: string;
  };
  polymarket: {
    host: string;
    chainId: number;
    builder: {
      apiKey: string;
      secret: string;
      passphrase: string;
    };
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
  commission: {
    adminWalletAddress: string;
    platformExecutorKey: string;
  };
  referral: {
    treasuryKey: string;
  };
  polygonWssRpcUrl?: string;
}

function validateConfig(): Config {
  const requiredEnvVars = [
    'TELEGRAM_BOT_TOKEN',
    'DATABASE_URL',
    'ENCRYPTION_KEY',
    'PREDEXON_API_KEY',
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
      botUsername: (process.env.BOT_USERNAME || '').replace(/^@/, ''),
      adminUserIds: adminIds,
      groupBotToken: process.env.TELEGRAM_GROUP_BOT_TOKEN || undefined,
      requiredGroupId: process.env.TELEGRAM_REQUIRED_GROUP_ID
        ? parseInt(process.env.TELEGRAM_REQUIRED_GROUP_ID, 10)
        : undefined,
      requiredGroupLink: process.env.TELEGRAM_GROUP_LINK || undefined,
      webhookDomain: process.env.WEBHOOK_DOMAIN || undefined,
      webhookPort: parseInt(process.env.WEBHOOK_PORT || '8443', 10),
    },
    predexon: {
      apiKey: process.env.PREDEXON_API_KEY!,
      tradeUrl: process.env.PREDEXON_TRADE_URL || 'https://trade.predexon.com',
      dataUrl: process.env.PREDEXON_DATA_URL || 'https://api.predexon.com',
    },
    polymarket: {
      host: process.env.POLYMARKET_HOST || 'https://clob.polymarket.com',
      chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || '137', 10),
      builder: {
        apiKey: process.env.POLY_BUILDER_API_KEY || '',
        secret: process.env.POLY_BUILDER_SECRET || '',
        passphrase: process.env.POLY_BUILDER_PASSPHRASE || '',
      },
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
    commission: {
      adminWalletAddress: process.env.ADMIN_WALLET_ADDRESS || '',
      platformExecutorKey: process.env.PLATFORM_EXECUTOR_KEY || '',
    },
    referral: {
      treasuryKey: process.env.REFERRAL_TREASURY_KEY || '',
    },
    polygonWssRpcUrl: process.env.POLYGON_WSS_RPC_URL || undefined,
  };
}

export const config = validateConfig();
