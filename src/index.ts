import { config } from './config';
import { logger } from './utils/logger';
import { connectDatabase, disconnectDatabase } from './database/prisma';
import { getRedisClient, disconnectRedis } from './database/redis';
import { TelegramBot } from './bot';

async function main(): Promise<void> {
  try {
    logger.info('🚀 Starting Polymarket Telegram Bot...');
    logger.info(`Environment: ${config.app.nodeEnv}`);

    // Connect to PostgreSQL
    logger.info('Connecting to PostgreSQL...');
    await connectDatabase();

    // Connect to Redis
    logger.info('Connecting to Redis...');
    const redis = getRedisClient();
    await redis.ping();
    logger.info('Redis connected successfully');

    // Initialize Telegram bot
    logger.info('Initializing Telegram bot...');
    const bot = new TelegramBot();
    await bot.start();

    logger.info('✅ All services started successfully');
    logger.info('Bot is ready to accept commands!');

  } catch (error) {
    logger.error('❌ Failed to start application:', error);
    await cleanup();
    process.exit(1);
  }
}

async function cleanup(): Promise<void> {
  logger.info('Cleaning up resources...');

  try {
    await disconnectDatabase();
    await disconnectRedis();
    logger.info('Cleanup completed');
  } catch (error) {
    logger.error('Error during cleanup:', error);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal');
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal');
  await cleanup();
  process.exit(0);
});

// Start the application
main().catch(async (error) => {
  logger.error('Fatal error:', error);
  await cleanup();
  process.exit(1);
});
