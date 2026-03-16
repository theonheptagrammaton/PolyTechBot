import http from 'http';
// Bootstrap global proxy before any HTTP requests (for geoblock bypass)
if (process.env.GLOBAL_AGENT_HTTP_PROXY || process.env.GLOBAL_AGENT_HTTPS_PROXY) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('global-agent/bootstrap');
}
import { config } from './config';
import { logger } from './utils/logger';
import { connectDatabase, disconnectDatabase } from './database/prisma';
import { getRedisClient, disconnectRedis } from './database/redis';
import { TelegramBot } from './bot';

let healthServer: http.Server;

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

    // Health check endpoint for Docker/Coolify
    healthServer = http.createServer((_, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const healthPort = parseInt(process.env.HEALTH_PORT || '3000', 10);
    healthServer.listen(healthPort, () => {
      logger.info(`Health check listening on port ${healthPort}`);
    });

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
    if (healthServer) healthServer.close();
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
