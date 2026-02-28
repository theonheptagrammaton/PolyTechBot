import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const isDev = process.env.NODE_ENV !== 'production';

// R11: Only emit query events in development (avoids unnecessary overhead in production)
const prismaClientSingleton = () => {
  return new PrismaClient({
    log: isDev
      ? [
          { level: 'query', emit: 'event' },
          { level: 'error', emit: 'stdout' },
          { level: 'warn', emit: 'stdout' },
        ]
      : [
          { level: 'error', emit: 'stdout' },
          { level: 'warn', emit: 'stdout' },
        ],
  });
};

declare global {
  var prismaGlobal: undefined | ReturnType<typeof prismaClientSingleton>;
}

export const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

// R9: Always persist singleton to globalThis (prevents connection leaks on hot-reload in dev)
globalThis.prismaGlobal = prisma;

// Log queries in development only
if (isDev) {
  prisma.$on('query', (e) => {
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
