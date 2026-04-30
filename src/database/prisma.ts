import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../utils/logger';

const isDev = process.env.NODE_ENV !== 'production';

// R11: Only emit query events in development (avoids unnecessary overhead in production).
// Errors and warnings are emitted as events (not stdout) so we can route through
// our winston logger and filter benign noise (P2025 from concurrent deletes, etc.).
const prismaClientSingleton = () => {
  return new PrismaClient({
    log: isDev
      ? [
          { level: 'query', emit: 'event' },
          { level: 'error', emit: 'event' },
          { level: 'warn', emit: 'event' },
        ]
      : [
          { level: 'error', emit: 'event' },
          { level: 'warn', emit: 'event' },
        ],
  });
};

declare global {
  var prismaGlobal: undefined | ReturnType<typeof prismaClientSingleton>;
}

export const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

// R9: Always persist singleton to globalThis (prevents connection leaks on hot-reload in dev)
globalThis.prismaGlobal = prisma;

// Benign error patterns surfaced by Prisma's internal logger that our handlers
// already swallow with try/catch — log them at debug instead of error.
const BENIGN_PRISMA_ERROR_RE =
  /\b(P2025|Record (to (update|delete|connect|disconnect)|to delete) does not exist|An operation failed because it depends on one or more records that were required but not found)\b/i;

prisma.$on('error' as never, (event: Prisma.LogEvent) => {
  const msg = event.message ?? '';
  if (BENIGN_PRISMA_ERROR_RE.test(msg)) {
    logger.debug(`[prisma] benign: ${msg}`);
    return;
  }
  logger.error(`[prisma] ${msg}` + (event.target ? ` (target=${event.target})` : ''));
});

prisma.$on('warn' as never, (event: Prisma.LogEvent) => {
  logger.warn(`[prisma] ${event.message ?? ''}`);
});

// Log queries in development only
if (isDev) {
  prisma.$on('query' as never, (e: Prisma.QueryEvent) => {
    logger.debug('Query: ' + e.query);
    logger.debug('Params: ' + e.params);
    logger.debug('Duration: ' + e.duration + 'ms');
  });
}

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info('Connected to PostgreSQL database');
  } catch (error) {
    logger.error('Failed to connect to database:', error);
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    logger.info('Disconnected from PostgreSQL database');
  } catch (error) {
    logger.error('Failed to disconnect from database:', error);
    throw error;
  }
}
