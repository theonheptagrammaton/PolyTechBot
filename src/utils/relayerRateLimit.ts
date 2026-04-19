import { redisCache } from '../database/redis';
import { logger } from './logger';

// Redis keys
const BACKOFF_KEY = 'relayer:backoff_until';      // unix-ms timestamp

/**
 * Returns true if we should skip relayer calls due to an active 429 backoff.
 */
export async function isRelayerBackedOff(): Promise<boolean> {
  try {
    const until = await redisCache.get<number>(BACKOFF_KEY);
    if (until && Date.now() < until) return true;
    return false;
  } catch {
    return false; // Redis failure → allow the call (fail-open)
  }
}

/**
 * Returns the number of seconds remaining on the backoff, or 0 if not backed off.
 */
export async function getRelayerBackoffRemaining(): Promise<number> {
  try {
    const until = await redisCache.get<number>(BACKOFF_KEY);
    if (!until) return 0;
    const remaining = Math.ceil((until - Date.now()) / 1000);
    return remaining > 0 ? remaining : 0;
  } catch {
    return 0;
  }
}

/**
 * Mark the relayer as rate-limited.
 * Extracts "resets in N seconds" from the error if available, otherwise defaults to 60s.
 */
export async function setRelayerBackoff(errorMsg: string): Promise<void> {
  let backoffMs: number;
  const resetMatch = errorMsg.match(/resets in (\d+) seconds/i);
  if (resetMatch) {
    const resetSeconds = parseInt(resetMatch[1], 10);
    backoffMs = resetSeconds * 1000;
    logger.warn(`[relayerRL] Quota exhausted, backing off for ${resetSeconds}s`);
  } else {
    backoffMs = 60_000; // 60s default (verified account — short backoff)
    logger.warn(`[relayerRL] Rate limited (no reset header), backing off for 60s`);
  }
  const until = Date.now() + backoffMs;
  const ttlSec = Math.ceil(backoffMs / 1000) + 60; // extra 60s margin
  await redisCache.set(BACKOFF_KEY, until, ttlSec).catch(() => {});
}

/**
 * Returns true if the error indicates a 429 / quota exhaustion.
 */
export function isRateLimitError(msg: string): boolean {
  return /429|too many requests|quota exceeded|rate.?limit/i.test(msg);
}

/**
 * Pre-flight check: only blocks if the relayer returned a real 429 recently.
 * Returns { ok: true } if the call can proceed, or { ok: false, reason, waitSec }.
 */
export async function canCallRelayer(): Promise<
  { ok: true } | { ok: false; reason: string; waitSec: number }
> {
  const backoffSec = await getRelayerBackoffRemaining();
  if (backoffSec > 0) {
    return { ok: false, reason: 'rate-limited', waitSec: backoffSec };
  }
  return { ok: true };
}
