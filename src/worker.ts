/**
 * Copy Trade Worker — runs as a separate process/container.
 * Handles all copy trading polling independently from the Telegraf bot.
 * Notifications are enqueued via BullMQ (Redis-backed), which the bot's
 * notification worker drains at a rate-limited 25 msg/s.
 */
// Must run before any module that pulls in @polymarket/builder-relayer-client.
import { silenceThirdPartyLogs } from './utils/silenceLibs';
silenceThirdPartyLogs();

import http from 'http';
import { config } from './config';
import { logger } from './utils/logger';
import { connectDatabase, disconnectDatabase } from './database/prisma';
import { getRedisClient, disconnectRedis } from './database/redis';
import { startCopyTradeMonitor, stopCopyTradeMonitor } from './services/copyTrade';
import { enqueueNotification, startNotificationWorker, closeNotificationWorker } from './utils/notificationQueue';
import { Telegraf } from 'telegraf';
import { prepareImageBuffer } from './utils/telegram';
import { NotificationExtra } from './services/copyTrade';

let healthServer: http.Server | null = null;

async function main(): Promise<void> {
  logger.info('[worker] Starting copy trade worker...');

  // Connect DB + Redis
  await connectDatabase();
  const redis = getRedisClient();
  await redis.ping();
  logger.info('[worker] DB and Redis connected');

  // Minimal Telegraf instance — only used for sending messages (no launch, no handlers)
  const tg = new Telegraf(config.telegram.botToken);

  const directSend = async (telegramId: string, message: string, extra?: NotificationExtra): Promise<void> => {
    try {
      if (extra?.imagePath) {
        const buf = await prepareImageBuffer(extra.imagePath);
        await tg.telegram.sendPhoto(
          telegramId,
          { source: buf },
          {
            caption: message,
            parse_mode: 'HTML',
            reply_markup: extra.buttons ? { inline_keyboard: extra.buttons } : undefined,
          } as any,
        );
      } else {
        await tg.telegram.sendMessage(telegramId, message, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: extra?.buttons ? { inline_keyboard: extra.buttons } : undefined,
        } as any);
      }
    } catch (err: any) {
      logger.warn(`[worker] Failed to send notification to ${telegramId}: ${err?.message}`);
      throw err; // re-throw so BullMQ can retry
    }
  };

  // Start rate-limited notification worker
  startNotificationWorker(directSend);

  // Start copy trade monitor — enqueues notifications through BullMQ queue
  startCopyTradeMonitor(enqueueNotification);

  // Minimal health check
  const healthPort = parseInt(process.env.HEALTH_PORT || '3001', 10);
  healthServer = http.createServer((_, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  healthServer.listen(healthPort, () => {
    logger.info(`[worker] Health check listening on port ${healthPort}`);
  });

  logger.info('[worker] Copy trade worker running');
}

async function cleanup(): Promise<void> {
  logger.info('[worker] Shutting down...');
  stopCopyTradeMonitor();
  await closeNotificationWorker();
  if (healthServer) healthServer.close();
  await disconnectDatabase();
  await disconnectRedis();
  logger.info('[worker] Shutdown complete');
}

process.on('SIGINT',  async () => { await cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });

main().catch(async (err) => {
  logger.error('[worker] Fatal error:', err);
  await cleanup();
  process.exit(1);
});
