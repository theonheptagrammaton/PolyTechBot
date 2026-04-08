import { logger } from '../utils/logger';
import { redisCache } from '../database/redis';
import {
  getOrders as predexonGetOrders,
  getBalance as predexonGetBalance,
  cancelOrder as predexonCancelOrder,
  cancelAllOrders as predexonCancelAllOrders,
} from './predexon';

const DATA_API = 'https://data-api.polymarket.com';

const ACTIVE_POSITIONS_TTL  = 20;   // seconds
const CLOSED_POSITIONS_TTL  = 60;   // seconds
const FETCH_TIMEOUT_MS      = 8_000; // abort Data API / CLOB fetches after 8s

export interface OpenOrder {
  id: string;
  status: string;
  owner: string;
  maker_address: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  size_matched: string;
  price: string;
  associate_trades: string[];
  outcome: string;
  created_at: number;
  expiration: string;
  order_type: string;
}

export interface Trade {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: string;
  size: string;
  fee_rate_bps: string;
  price: string;
  status: string;
  match_time: string;
  last_update: string;
  outcome: string;
  bucket_index: number;
  owner: string;
  maker_address: string;
  transaction_hash: string;
  trader_side?: string;
}

// Active position from Data API: GET /positions?user={proxyAddress}
export interface ActivePosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
}

// Closed position from Data API: GET /closed-positions?user={proxyAddress}
export interface ClosedPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  timestamp: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
}

export interface PortfolioData {
  openOrders: OpenOrder[];
  trades: Trade[];
  activePositions: ActivePosition[];
  closedPositions: ClosedPosition[];
  balance: string;
}

/**
 * @deprecated — ClobClient no longer used. Use Predexon API directly.
 * Kept as a stub for any remaining callers during migration.
 */
export async function createClobClientForUser(
  _privateKey: string,
  _apiKey: string,
  _apiSecret: string,
  _passphrase: string
): Promise<any> {
  throw new Error('createClobClientForUser is deprecated — use Predexon API');
}

/**
 * Gets user's active positions from Data API (public, no auth needed)
 * Uses proxy wallet address, returns markets where user currently holds tokens
 */
export async function getActivePositions(proxyAddress: string, forceRefresh = false): Promise<ActivePosition[]> {
  const cacheKey = `portfolio:active:${proxyAddress}`;

  // Try cache first (unless forceRefresh)
  const cached = await redisCache.get<ActivePosition[]>(cacheKey).catch(() => null);
  if (!forceRefresh && cached) return cached;

  try {
    logger.info(`Fetching active positions from Data API for ${proxyAddress}`);
    const response = await fetch(`${DATA_API}/positions?user=${proxyAddress}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn(`Data API /positions returned ${response.status}`);
      // Fall back to stale cache instead of returning empty
      if (cached) {
        logger.info(`Returning stale cache (${cached.length} positions) after API ${response.status}`);
        return cached;
      }
      return [];
    }

    const data = await response.json();
    const positions: ActivePosition[] = Array.isArray(data) ? data : [];
    const active = positions.filter((p) => p.size > 0);

    await redisCache.set(cacheKey, active, ACTIVE_POSITIONS_TTL).catch(() => {});
    logger.info(`Fetched ${active.length} active positions`);
    return active;
  } catch (error) {
    logger.warn('Error fetching active positions:', error);
    // Fall back to stale cache instead of returning empty
    if (cached) {
      logger.info(`Returning stale cache (${cached.length} positions) after fetch error`);
      return cached;
    }
    return [];
  }
}

/**
 * Gets user's closed positions from Data API (public, no auth needed)
 * Uses proxy wallet address, returns markets where user exited their position
 */
export async function getClosedPositions(proxyAddress: string, forceRefresh = false): Promise<ClosedPosition[]> {
  const cacheKey = `portfolio:closed:${proxyAddress}`;

  const cached = await redisCache.get<ClosedPosition[]>(cacheKey).catch(() => null);
  if (!forceRefresh && cached) return cached;

  try {
    logger.info(`Fetching closed positions from Data API for ${proxyAddress}`);
    const response = await fetch(`${DATA_API}/closed-positions?user=${proxyAddress}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn(`Data API /closed-positions returned ${response.status}`);
      if (cached) return cached;
      return [];
    }

    const data = await response.json();
    const positions: ClosedPosition[] = Array.isArray(data) ? data : [];
    positions.sort((a, b) => b.timestamp - a.timestamp);

    await redisCache.set(cacheKey, positions, CLOSED_POSITIONS_TTL).catch(() => {});
    logger.info(`Fetched ${positions.length} closed positions`);
    return positions;
  } catch (error) {
    logger.warn('Error fetching closed positions:', error);
    if (cached) return cached;
    return [];
  }
}

/**
 * Gets user's open orders from Predexon API
 */
export async function getOpenOrders(
  _privateKey: string,
  _apiKey: string,
  _apiSecret: string,
  _passphrase: string,
  predexonUserId?: string
): Promise<OpenOrder[]> {
  if (!predexonUserId) {
    logger.warn('getOpenOrders called without predexonUserId');
    return [];
  }
  try {
    logger.info('Fetching open orders from Predexon API');
    const orders = await predexonGetOrders(predexonUserId, 'polymarket');
    const liveOrders = orders
      .filter((o) => o.status === 'open')
      .map((o) => ({
        id: o.orderId,
        status: 'LIVE',
        owner: '',
        maker_address: '',
        market: '',
        asset_id: o.tokenId,
        side: o.side?.toUpperCase() ?? '',
        original_size: o.size ?? '0',
        size_matched: o.sizeMatched ?? '0',
        price: o.price ?? '0',
        associate_trades: [],
        outcome: '',
        created_at: 0,
        expiration: '',
        order_type: o.type ?? '',
      })) as OpenOrder[];

    logger.info(`Fetched ${liveOrders.length} open orders`);
    return liveOrders;
  } catch (error) {
    logger.warn('Error fetching open orders:', error);
    return [];
  }
}

/**
 * Invalidates cached active positions for a proxy address so the next fetch is fresh.
 */
export async function invalidatePortfolioCache(proxyAddress: string): Promise<void> {
  if (!proxyAddress) return;
  await redisCache.del(`portfolio:active:${proxyAddress}`).catch(() => {});
}

/**
 * Cancels a single open order by its order ID.
 * Returns { success, cancelledId, errorReason }
 */
export async function cancelOrderById(
  _privateKey: string,
  _apiKey: string,
  _apiSecret: string,
  _passphrase: string,
  orderId: string,
  predexonUserId?: string
): Promise<{ success: boolean; errorReason?: string }> {
  if (!predexonUserId) return { success: false, errorReason: 'no predexonUserId' };
  try {
    await predexonCancelOrder(predexonUserId, orderId);
    logger.info(`[portfolio] Cancelled order ${orderId.substring(0, 16)}...`);
    return { success: true };
  } catch (error: any) {
    logger.error('Error cancelling order:', error);
    return { success: false, errorReason: error?.message ?? 'API error' };
  }
}

/**
 * Cancels ALL open orders for the user via Predexon.
 */
export async function cancelAllOrders(
  _privateKey: string,
  _apiKey: string,
  _apiSecret: string,
  _passphrase: string,
  predexonUserId?: string
): Promise<{ cancelled: number; failed: number }> {
  if (!predexonUserId) return { cancelled: 0, failed: -1 };
  try {
    await predexonCancelAllOrders(predexonUserId, 'polymarket');
    logger.info(`[portfolio] Cancel all orders sent via Predexon`);
    return { cancelled: -1, failed: 0 }; // Predexon doesn't return count
  } catch (error: any) {
    logger.error('Error cancelling all orders:', error);
    return { cancelled: 0, failed: -1 };
  }
}

/**
 * Gets user's trade history.
 * Note: Predexon doesn't have a dedicated trades endpoint — returns empty for now.
 * Trade history is visible via positions and orders.
 */
export async function getTrades(
  _privateKey: string,
  _apiKey: string,
  _apiSecret: string,
  _passphrase: string
): Promise<Trade[]> {
  // Trade history via Predexon is available through orders endpoint
  // For now return empty — positions provide the key data users need
  return [];
}

/**
 * Gets user's complete portfolio data
 */
export async function getPortfolioData(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string,
  proxyAddress: string,
  predexonUserId?: string
): Promise<PortfolioData> {
  logger.info('Fetching complete portfolio data');

  const [openOrders, trades, activePositions, closedPositions] = await Promise.all([
    getOpenOrders(privateKey, apiKey, apiSecret, passphrase, predexonUserId),
    getTrades(privateKey, apiKey, apiSecret, passphrase),
    getActivePositions(proxyAddress),
    getClosedPositions(proxyAddress),
  ]);

  let balance = '0.00';
  // Balance is now fetched via Predexon in getBalance() — use placeholder here
  // The wallet page handler calls getBalance() directly with predexonUserId
  try {
    if (predexonUserId) {
      const balances = await predexonGetBalance(predexonUserId, 'polymarket');
      if (balances.length > 0) {
        balance = parseFloat(balances[0].available).toFixed(2);
      }
    }
  } catch (err) {
    logger.warn('Error fetching balance:', err);
  }

  logger.info(
    `Portfolio: ${activePositions.length} active, ${closedPositions.length} closed, ${openOrders.length} orders, ${trades.length} trades`
  );

  return { openOrders, trades, activePositions, closedPositions, balance };
}

/**
 * Polls Data API activity feed to find the on-chain transaction hash for a recently
 * placed market order. Retries up to `maxRetries` times with `retryDelayMs` between
 * attempts so that newly mined Polygon transactions have time to be indexed.
 *
 * @param proxyAddress  - User's Polymarket proxy wallet
 * @param assetId       - Token ID (outcome share) that was traded
 * @param afterMs       - Only consider activity entries after this Unix timestamp (ms)
 * @param maxRetries    - Number of poll attempts (default 4)
 * @param retryDelayMs  - Delay between attempts in ms (default 3 000)
 * @returns The 0x transaction hash string, or null if not found within retries
 */
export async function fetchTxHashForOrder(
  proxyAddress: string,
  assetId: string,
  afterMs: number,
  maxRetries = 4,
  retryDelayMs = 3_000,
): Promise<string | null> {
  for (let i = 0; i < maxRetries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, retryDelayMs));
    try {
      const resp = await fetch(
        `${DATA_API}/activity?user=${proxyAddress}&limit=20`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!resp.ok) continue;

      const data: any = await resp.json();
      const items: any[] = Array.isArray(data) ? data : (data?.data ?? []);

      for (const item of items) {
        const isTrade = item.type === 'TRADE' || item.status === 'MINED' || item.status === 'CONFIRMED';
        if (!isTrade) continue;

        // Match by asset_id / asset token ID
        const itemAsset: string = item.asset_id ?? item.asset ?? '';
        if (itemAsset !== assetId) continue;

        // Only consider trades that happened after the order was placed
        const rawTs = item.timestamp ?? item.match_time;
        let ts: number;
        if (typeof rawTs === 'number') ts = rawTs < 1e12 ? rawTs * 1000 : rawTs;
        else ts = new Date(rawTs ?? 0).getTime();
        if (isNaN(ts) || ts < afterMs) continue;

        if (item.transaction_hash) return item.transaction_hash as string;
      }
    } catch (err) {
      logger.warn(`[portfolio] fetchTxHashForOrder attempt ${i + 1} error:`, err);
    }
  }
  return null;
}

/**
 * Gets user's USDC balance from Predexon API.
 * Legacy signature kept for callers; new code should pass predexonUserId.
 */
const BALANCE_CACHE_TTL       = 30;  // seconds — fresh cache
const BALANCE_STALE_CACHE_TTL = 300; // 5 minutes — shown as fallback

export async function getBalance(
  privateKey: string,
  _apiKey: string,
  _apiSecret: string,
  _passphrase: string,
  predexonUserId?: string
): Promise<string> {
  const keyHash   = privateKey.slice(-8);
  const cacheKey  = `balance:${keyHash}`;
  const staleKey  = `balance:stale:${keyHash}`;

  try {
    const cached = await redisCache.get<string>(cacheKey);
    if (cached !== null && cached !== undefined) return cached;

    if (!predexonUserId) {
      logger.warn('getBalance called without predexonUserId');
      return '0.00';
    }

    const balances = await predexonGetBalance(predexonUserId, 'polymarket');
    let balance = '0.00';
    if (balances.length > 0) {
      balance = parseFloat(balances[0].available).toFixed(2);
    }

    await Promise.all([
      redisCache.set(cacheKey, balance, BALANCE_CACHE_TTL),
      redisCache.set(staleKey, balance, BALANCE_STALE_CACHE_TTL),
    ]).catch(() => {});

    logger.info(`Balance: $${balance}`);
    return balance;
  } catch (error) {
    logger.warn('Error fetching balance:', (error as any)?.message ?? String(error));
    const stale = await redisCache.get<string>(staleKey).catch(() => null);
    if (stale !== null && stale !== undefined) {
      logger.info(`Balance (stale): $${stale}`);
      return stale;
    }
    return '0.00';
  }
}

export interface MainMenuStats {
  balance: string;       // Available USDC
  positionsValue: string; // Sum of active position currentValue
  ordersValue: string;    // Remaining notional locked in open orders
  netWorth: string;       // balance + positionsValue + ordersValue
}

/**
 * Fetches the four summary stats shown on the main menu.
 * All sub-calls run in parallel; errors fall back to zero.
 */
export async function getMainMenuStats(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string,
  proxyAddress: string | null,
  predexonUserId?: string
): Promise<MainMenuStats> {
  const [balanceResult, positionsResult, ordersResult] = await Promise.allSettled([
    getBalance(privateKey, apiKey, apiSecret, passphrase, predexonUserId),
    proxyAddress ? getActivePositions(proxyAddress) : Promise.resolve([]),
    getOpenOrders(privateKey, apiKey, apiSecret, passphrase, predexonUserId),
  ]);

  const balance       = balanceResult.status === 'fulfilled' ? parseFloat(balanceResult.value) : 0;
  const positions     = positionsResult.status === 'fulfilled' ? positionsResult.value : [];
  const orders        = ordersResult.status === 'fulfilled' ? ordersResult.value : [];

  const positionsValue = positions.reduce((sum, p) => sum + (p.currentValue ?? 0), 0);
  const ordersValue    = orders.reduce((sum, o) => {
    const remaining = parseFloat(o.original_size) - parseFloat(o.size_matched);
    return sum + Math.max(0, remaining) * parseFloat(o.price);
  }, 0);
  const netWorth = balance + positionsValue + ordersValue;

  return {
    balance:        balance.toFixed(2),
    positionsValue: positionsValue.toFixed(2),
    ordersValue:    ordersValue.toFixed(2),
    netWorth:       netWorth.toFixed(2),
  };
}

export function formatOrderPrice(price: string): string {
  return `${(parseFloat(price) * 100).toFixed(1)}¢`;
}

export function formatOrderSize(size: string): string {
  const n = parseFloat(size);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toFixed(2);
}

export function calculateTradeValue(size: string, price: string): string {
  return `$${(parseFloat(size) * parseFloat(price)).toFixed(2)}`;
}

export function formatTimestamp(timestamp: string | number): string {
  const date =
    typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp * 1000);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
