import { redisCache } from '../database/redis';

/**
 * A Map-like state store backed by Redis for persistence across bot restarts.
 * In-memory Map is used as a fast primary store; Redis is the fallback.
 * When a key is not found in memory, Redis is checked and the value is restored to memory.
 */
export class RedisBackedState<T> {
  private mem = new Map<string, T>();
  private prefix: string;
  private ttlSec: number;

  constructor(prefix: string, ttlSec: number = 600) {
    this.prefix = prefix;
    this.ttlSec = ttlSec;
  }

  private redisKey(id: string): string {
    return `state:${this.prefix}:${id}`;
  }

  /** Set value in both memory and Redis */
  set(id: string, value: T): void {
    this.mem.set(id, value);
    redisCache.set(this.redisKey(id), value, this.ttlSec).catch(() => {});
  }

  /** Async get — checks memory first, falls back to Redis */
  async get(id: string): Promise<T | undefined> {
    const mem = this.mem.get(id);
    if (mem !== undefined) return mem;
    const val = await redisCache.get<T>(this.redisKey(id));
    if (val) {
      this.mem.set(id, val); // restore to memory for subsequent sync access
      return val;
    }
    return undefined;
  }

  /** Sync get — memory only (no Redis fallback) */
  getSync(id: string): T | undefined {
    return this.mem.get(id);
  }

  /** Sync has — memory only */
  has(id: string): boolean {
    return this.mem.has(id);
  }

  /** Async has — checks memory first, falls back to Redis */
  async hasAsync(id: string): Promise<boolean> {
    if (this.mem.has(id)) return true;
    const val = await redisCache.get<T>(this.redisKey(id));
    if (val) {
      this.mem.set(id, val);
      return true;
    }
    return false;
  }

  /** Delete from both memory and Redis */
  delete(id: string): void {
    this.mem.delete(id);
    redisCache.del(this.redisKey(id)).catch(() => {});
  }

  /** Iterate over in-memory entries (used by cleanup intervals) */
  entries(): IterableIterator<[string, T]> {
    return this.mem.entries();
  }
}
