import { redisCache } from '../database/redis';
import { logger } from './logger';

// Redis keys
const BACKOFF_KEY = 'relayer:backoff_until';      // unix-ms timestamp
const HOURLY_COUNT_KEY = 'relayer:req_count';      // rolling hourly request count

// Proactive throttling: if we send more than SOFT_LIMIT requests per hour,
// start adding delays. The Polymarket builder relayer quota is undocumented,
// so this is a conservative default.  Adjust via env if needed.
const SOFT_LIMIT_PER_HOUR = parseInt(process.env.RELAYER_SOFT_LIMIT ?? '40', 10);
const HARD_LIMIT_PER_HOUR = parseInt(process.env.RELAYER_HARD_LIMIT ?? '55', 10);

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
 * Extracts "resets in N seconds" from the error if available, otherwise defaults to 5 min.
 */
export async function setRelayerBackoff(errorMsg: string): Promise<void> {
  let backoffMs: number;
  const resetMatch = errorMsg.match(/resets in (\d+) seconds/i);
  if (resetMatch) {
    const resetSeconds = parseInt(resetMatch[1], 10);
    backoffMs = resetSeconds * 1000;
    logger.warn(`[relayerRL] Quota exhausted, backing off for ${resetSeconds}s`);
  } else {
    backoffMs = 300_000; // 5 minutes default
    logger.warn(`[relayerRL] Rate limited (no reset header), backing off for 300s`);
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
 * Increment the hourly request counter. Call this AFTER each successful relayer call.
 * Returns the new count.
 */
export async function incrementRelayerCount(): Promise<number> {
  try {
    const now = Date.now();
    const hourKey = `${HOURLY_COUNT_KEY}:${Math.floor(now / 3_600_000)}`;
    // Use atomic INCRBYFLOAT (int value, but atomic + sets TTL on new keys)
    const next = await redisCache.incrByFloat(hourKey, 1, 7200);
    return Math.round(next);
  } catch {
    return 0;
  }
}

/**
 * Get current hourly request count.
 */
export async function getRelayerHourlyCount(): Promise<number> {
  try {
    const hourKey = `${HOURLY_COUNT_KEY}:${Math.floor(Date.now() / 3_600_000)}`;
    return (await redisCache.get<number>(hourKey)) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Returns a delay in ms that should be added between relayer calls
 * based on current hourly usage. 0 if under soft limit.
 */
export async function getThrottleDelay(): Promise<number> {
  const count = await getRelayerHourlyCount();
  if (count >= HARD_LIMIT_PER_HOUR) {
    // Over hard limit → block (caller should check isRelayerBackedOff first,
    // but this is a safety net)
    return -1; // signal "do not call"
  }
  if (count >= SOFT_LIMIT_PER_HOUR) {
    // Linear backpressure: 2s per request over the soft limit
    return (count - SOFT_LIMIT_PER_HOUR + 1) * 2000;
  }
  return 0;
}

/**
 * Pre-flight check combining backoff + proactive throttle.
 * Returns { ok: true } if the call can proceed, or { ok: false, reason, waitSec }.
 */
export async function canCallRelayer(): Promise<
  { ok: true } | { ok: false; reason: string; waitSec: number }
> {
  // 1. Check 429 backoff
  const backoffSec = await getRelayerBackoffRemaining();
  if (backoffSec > 0) {
    return { ok: false, reason: 'rate-limited', waitSec: backoffSec };
  }
  // 2. Check proactive hard limit
  const delay = await getThrottleDelay();
  if (delay < 0) {
    return { ok: false, reason: 'hourly-limit', waitSec: 300 };
  }
  return { ok: true };
}
