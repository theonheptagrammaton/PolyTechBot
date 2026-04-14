import axios from 'axios';
import { redisCache } from '../database/redis';
import { logger } from '../utils/logger';

const BINANCE_API = 'https://api.binance.com/api/v3';

/**
 * Fetch current spot price for a coin from Binance.
 * Cached for 5 seconds in Redis.
 */
export async function fetchSpotPrice(symbol: string): Promise<number> {
  const upper = symbol.toUpperCase();
  const cacheKey = `spot:price:${upper}`;
  const cached = await redisCache.get<number>(cacheKey);
  if (cached != null) return cached;

  try {
    const resp = await axios.get(`${BINANCE_API}/ticker/price`, {
      params: { symbol: `${upper}USDT` },
      timeout: 5_000,
    });
    const price = parseFloat(resp.data?.price);
    if (isNaN(price)) throw new Error(`Invalid price for ${upper}`);

    await redisCache.set(cacheKey, price, 5);
    return price;
  } catch (err: any) {
    logger.warn(`[cryptoPrice] Failed to fetch ${upper}: ${err?.message}`);
    throw err;
  }
}

/**
 * Get the spot price at the beginning of a market round.
 * The first call for a given round records the opening price;
 * subsequent calls return the cached value.
 *
 * @param coin - e.g. "BTC"
 * @param roundKey - unique round identifier (e.g. conditionId or startDate ISO)
 * @param roundStartDate - optional ISO date of the round start. When provided,
 *   the function checks how long ago the round started. If the round started
 *   more than 30 seconds ago and no cached price exists, the current spot
 *   price is unreliable as a round-open proxy — log a warning. This prevents
 *   silently caching a mid-round price after a bot restart.
 */
export async function getRoundOpenPrice(
  coin: string,
  roundKey: string,
  roundStartDate?: string,
): Promise<number> {
  const cacheKey = `spot:open:${coin.toUpperCase()}:${roundKey}`;
  const cached = await redisCache.get<number>(cacheKey);
  if (cached != null) return cached;

  // If round already started more than 30s ago, the current spot is NOT
  // a reliable open price — still cache it (better than nothing) but warn.
  if (roundStartDate) {
    const elapsed = Date.now() - new Date(roundStartDate).getTime();
    if (elapsed > 30_000) {
      logger.warn(
        `[cryptoPrice] Round open price for ${coin}/${roundKey} requested ${Math.round(elapsed / 1000)}s after round start — value may be inaccurate`,
      );
    }
  }

  const price = await fetchSpotPrice(coin);
  await redisCache.set(cacheKey, price, 1200); // 20min TTL
  return price;
}
