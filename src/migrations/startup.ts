import { prisma } from '../database/prisma';
import { getRedisClient } from '../database/redis';
import { logger } from '../utils/logger';

const MIGRATION_PREFIX = 'migration:done:';

async function once(name: string, fn: () => Promise<void>): Promise<void> {
  const redis = getRedisClient();
  const key = `${MIGRATION_PREFIX}${name}`;
  const already = await redis.get(key);
  if (already) return;

  logger.info(`[migration] Running: ${name}`);
  await fn();
  await redis.set(key, '1'); // no TTL — permanent
  logger.info(`[migration] Done: ${name}`);
}

export async function runStartupMigrations(): Promise<void> {
  await once('enable-copy-sells', async () => {
    const result = await prisma.copySubscription.updateMany({
      where: { copySells: false },
      data: { copySells: true },
    });
    logger.info(`[migration] enable-copy-sells: updated ${result.count} subscription(s)`);
  });
}
