import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    redisClient.on('connect', () => {
      logger.info('Connected to Redis');
    });

    redisClient.on('error', (error) => {
      logger.error('Redis connection error:', error);
    });

    redisClient.on('reconnecting', () => {
      logger.info('Reconnecting to Redis...');
    });
  }

  return redisClient;
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Disconnected from Redis');
  }
}

// Cache helper functions
export class RedisCache {
  private client: Redis;
  private defaultTTL: number = 3600; // 1 hour in seconds

  constructor() {
    this.client = getRedisClient();
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (error) {
      logger.error(`Redis GET error for key ${key}:`, error);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttl: number = this.defaultTTL): Promise<boolean> {
    try {
      await this.client.setex(key, ttl, JSON.stringify(value));
      return true;
    } catch (error) {
      logger.error(`Redis SET error for key ${key}:`, error);
      return false;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      logger.error(`Redis DELETE error for key ${key}:`, error);
      return false;
    }
  }

  // Alias for delete
  async del(key: string): Promise<boolean> {
    return this.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      logger.error(`Redis EXISTS error for key ${key}:`, error);
      return false;
    }
  }

  async increment(key: string, by: number = 1): Promise<number> {
    try {
      return await this.client.incrby(key, by);
    } catch (error) {
      logger.error(`Redis INCREMENT error for key ${key}:`, error);
      throw error;
    }
  }

  async incrByFloat(key: string, by: number, ttl?: number): Promise<number> {
    try {
      const result = await this.client.incrbyfloat(key, by);
      // Set TTL on newly created keys (TTL = -1 means no expiry, i.e. key was just created by INCRBYFLOAT)
      if (ttl) {
        const currentTtl = await this.client.ttl(key);
        if (currentTtl === -1) {
          await this.client.expire(key, ttl);
        }
      }
      return parseFloat(result);
    } catch (error) {
      logger.error(`Redis INCRBYFLOAT error for key ${key}:`, error);
      throw error;
    }
  }

  async setWithExpiry(key: string, value: string, seconds: number): Promise<boolean> {
    try {
      await this.client.setex(key, seconds, value);
      return true;
    } catch (error) {
      logger.error(`Redis SETEX error for key ${key}:`, error);
      return false;
    }
  }
}

export const redisCache = new RedisCache();

/**
 * Creates a dedicated ioredis connection for BullMQ.
 * BullMQ requires maxRetriesPerRequest: null (uses blocking commands).
 * Each call returns a new connection — BullMQ manages its own lifecycle.
 */
export function createBullMQConnection(): Redis {
  return new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      return Math.min(times * 50, 2000);
    },
  });
}
