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
 * @param coin - e.g. "BTC"
 * @param roundKey - unique round identifier (e.g. conditionId or startDate ISO)
 */
export async function getRoundOpenPrice(coin: string, roundKey: string): Promise<number> {
  const cacheKey = `spot:open:${coin.toUpperCase()}:${roundKey}`;
  const cached = await redisCache.get<number>(cacheKey);
  if (cached != null) return cached;

  const price = await fetchSpotPrice(coin);
  await redisCache.set(cacheKey, price, 1200); // 20min TTL
  return price;
}
