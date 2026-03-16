import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { logger } from '../utils/logger';
import { decrypt } from '../utils/encryption';
import { redisCache } from '../database/redis';

const DATA_API = 'https://data-api.polymarket.com';

const ACTIVE_POSITIONS_TTL  = 20;   // seconds
const CLOSED_POSITIONS_TTL  = 60;   // seconds

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
 * Creates CLOB client for user (authenticated)
 */
export async function createClobClientForUser(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<ClobClient> {
  const decryptedPrivateKey = decrypt(privateKey);
  const wallet = new Wallet(decryptedPrivateKey);
  return new ClobClient(
    'https://clob.polymarket.com',
    137,
    wallet,
    {
      key: decrypt(apiKey),
      secret: decrypt(apiSecret),
      passphrase: decrypt(passphrase),
    },
    2
  );
}

/**
 * Gets user's active positions from Data API (public, no auth needed)
 * Uses proxy wallet address, returns markets where user currently holds tokens
 */
export async function getActivePositions(proxyAddress: string, forceRefresh = false): Promise<ActivePosition[]> {
  const cacheKey = `portfolio:active:${proxyAddress}`;
  if (forceRefresh) {
    await redisCache.del(cacheKey).catch(() => {});
  } else {
    const cached = await redisCache.get<ActivePosition[]>(cacheKey).catch(() => null);
    if (cached) return cached;
  }

  try {
    logger.info(`Fetching active positions from Data API for ${proxyAddress}`);
    const response = await fetch(`${DATA_API}/positions?user=${proxyAddress}`);

    if (!response.ok) {
      logger.warn(`Data API /positions returned ${response.status}`);
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
    return [];
  }
}

/**
 * Gets user's closed positions from Data API (public, no auth needed)
 * Uses proxy wallet address, returns markets where user exited their position
 */
export async function getClosedPositions(proxyAddress: string, forceRefresh = false): Promise<ClosedPosition[]> {
  const cacheKey = `portfolio:closed:${proxyAddress}`;
  if (forceRefresh) {
    await redisCache.del(cacheKey).catch(() => {});
  } else {
    const cached = await redisCache.get<ClosedPosition[]>(cacheKey).catch(() => null);
    if (cached) return cached;
  }

  try {
    logger.info(`Fetching closed positions from Data API for ${proxyAddress}`);
    const response = await fetch(`${DATA_API}/closed-positions?user=${proxyAddress}`);

    if (!response.ok) {
      logger.warn(`Data API /closed-positions returned ${response.status}`);
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
    return [];
  }
}

/**
 * Gets user's open orders from CLOB API (authenticated)
 */
export async function getOpenOrders(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<OpenOrder[]> {
  try {
    // No cache — open orders must always be fresh so users see their new GTC orders immediately
    logger.info('Fetching open orders from CLOB API');
    const client = await createClobClientForUser(privateKey, apiKey, apiSecret, passphrase);
    const openOrders = await client.getOpenOrders();
    const liveOrders = (openOrders as OpenOrder[]).filter((o) => o.status === 'LIVE');

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
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string,
  orderId: string
): Promise<{ success: boolean; errorReason?: string }> {
  try {
    const client = await createClobClientForUser(privateKey, apiKey, apiSecret, passphrase);
    const result: any = await client.cancelOrder({ orderID: orderId });

    // SDK returns { canceled: [orderId], not_canceled: {} }
    const canceledList: string[] = result?.canceled ?? [];
    if (canceledList.includes(orderId)) {
      logger.info(`[portfolio] Cancelled order ${orderId.substring(0, 16)}...`);
      return { success: true };
    }

    const reason = result?.not_canceled?.[orderId] ?? 'unknown reason';
    logger.warn(`[portfolio] Order not cancelled: ${reason}`);
    return { success: false, errorReason: String(reason) };
  } catch (error: any) {
    logger.error('Error cancelling order:', error);
    return { success: false, errorReason: error?.message ?? 'API error' };
  }
}

/**
 * Cancels ALL open orders for the user.
 * Returns { cancelled, failed }
 */
export async function cancelAllOrders(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<{ cancelled: number; failed: number }> {
  try {
    const client = await createClobClientForUser(privateKey, apiKey, apiSecret, passphrase);
    const result: any = await client.cancelAll();

    const cancelled = (result?.canceled ?? []).length as number;
    const failed = Object.keys(result?.not_canceled ?? {}).length;
    logger.info(`[portfolio] Cancel all: ${cancelled} cancelled, ${failed} failed`);
    return { cancelled, failed };
  } catch (error: any) {
    logger.error('Error cancelling all orders:', error);
    return { cancelled: 0, failed: -1 };
  }
}

/**
 * Gets user's trade history from CLOB API (authenticated)
 */
export async function getTrades(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<Trade[]> {
  try {
    logger.info('Fetching trades from CLOB API');
    const client = await createClobClientForUser(privateKey, apiKey, apiSecret, passphrase);
    const trades = await client.getTrades();
    const sorted = (trades as Trade[]).sort(
      (a, b) => new Date(b.match_time).getTime() - new Date(a.match_time).getTime()
    );

    logger.info(`Fetched ${sorted.length} trades`);
    return sorted;
  } catch (error) {
    logger.warn('Error fetching trades:', error);
    return [];
  }
}

/**
 * Gets user's complete portfolio data
 */
export async function getPortfolioData(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string,
  proxyAddress: string
): Promise<PortfolioData> {
  logger.info('Fetching complete portfolio data');

  const [openOrders, trades, activePositions, closedPositions] = await Promise.all([
    getOpenOrders(privateKey, apiKey, apiSecret, passphrase),
    getTrades(privateKey, apiKey, apiSecret, passphrase),
    getActivePositions(proxyAddress),
    getClosedPositions(proxyAddress),
  ]);

  let balance = '0.00';
  try {
    const client = await createClobClientForUser(privateKey, apiKey, apiSecret, passphrase);
    const balanceData = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' as any });
    if (balanceData?.balance) {
      balance = (parseFloat(balanceData.balance) / 1_000_000).toFixed(2);
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
 * Gets user's USDC balance from CLOB API
 */
const BALANCE_CACHE_TTL = 30; // seconds — short enough to stay accurate, long enough to help rapid trades

export async function getBalance(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<string> {
  try {
    // Use a hash of the API key as cache key (unique per user, no sensitive data)
    const keyHash = privateKey.slice(-8); // last 8 chars of encrypted key as identifier
    const cacheKey = `balance:${keyHash}`;
    const cached = await redisCache.get<string>(cacheKey);
    if (cached !== null && cached !== undefined) return cached;

    const client = await createClobClientForUser(privateKey, apiKey, apiSecret, passphrase);
    const balanceData = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' as any });

    let balance = '0.00';
    if (balanceData?.balance) {
      balance = (parseFloat(balanceData.balance) / 1_000_000).toFixed(2);
    }

    await redisCache.set(cacheKey, balance, BALANCE_CACHE_TTL);
    logger.info(`Balance: $${balance}`);
    return balance;
  } catch (error) {
    logger.warn('Error fetching balance:', error);
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
  proxyAddress: string | null
): Promise<MainMenuStats> {
  const [balanceResult, positionsResult, ordersResult] = await Promise.allSettled([
    getBalance(privateKey, apiKey, apiSecret, passphrase),
    proxyAddress ? getActivePositions(proxyAddress) : Promise.resolve([]),
    getOpenOrders(privateKey, apiKey, apiSecret, passphrase),
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
