/**
 * Predexon Data API client — analytics endpoints for Backtest & Analyze features.
 *
 * Uses config.predexon.dataUrl (https://api.predexon.com) + x-api-key auth.
 * All responses cached in Redis with 5-minute TTL.
 *
 * NOTE: Endpoint paths inferred from MCP tool naming conventions.
 * If any path is wrong, fix the constant at the top — all functions use them.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { redisCache } from '../database/redis';

// ── Helpers ────────────────────────────────────────────────────────────────

const DATA_URL = () => config.predexon.dataUrl;
const CACHE_TTL = 300; // 5 minutes

function headers(): Record<string, string> {
  return {
    'x-api-key': config.predexon.apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function pdxGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const query = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') query.set(k, String(v));
    }
  }
  const qs = query.toString() ? `?${query.toString()}` : '';
  const url = `${DATA_URL()}${path}${qs}`;

  logger.debug(`[predexonData] GET ${url}`);

  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error(`[predexonData] ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
    throw new Error(`Predexon Data API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/** Cached GET — checks Redis first, stores on miss. */
async function cachedGet<T>(cacheKey: string, path: string, params?: Record<string, string | number | undefined>, ttl = CACHE_TTL): Promise<T> {
  const cached = await redisCache.get<T>(cacheKey);
  if (cached) return cached;

  const data = await pdxGet<T>(path, params);
  await redisCache.set(cacheKey, data, ttl).catch(() => {});
  return data;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface PdxMarket {
  condition_id: string;
  title: string;
  status: string;
  outcomes: Array<{
    label: string;
    price: number;
    token_id?: string;
  }>;
  volume?: number;
  open_interest?: number;
  liquidity?: number;
  expiration?: string;
  tags?: string[];
  volume_1d?: number;
  volume_7d?: number;
  volume_30d?: number;
  trades_1d?: number;
  trades_7d?: number;
  trades_30d?: number;
  [key: string]: unknown;
}

export interface PdxCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PdxTrade {
  token_id: string;
  side: string;
  price: number;
  amount_usd: number;
  timestamp: number;
  [key: string]: unknown;
}

export interface PdxPrice {
  price: number;
  timestamp: number;
}

export interface PdxVolumePoint {
  timestamp: number;
  total_volume: number;
  buy_volume: number;
  sell_volume: number;
}

export interface PdxOiPoint {
  timestamp: number;
  open_interest: number;
}

export interface PdxSmartMoney {
  condition_id: string;
  net_buyers: number;
  net_sellers: number;
  smart_volume?: number;
  dominant_side?: string;
  wallets?: Array<{
    wallet: string;
    side: string;
    volume: number;
    pnl?: number;
  }>;
  [key: string]: unknown;
}

export interface PdxSmartActivity {
  condition_id: string;
  title: string;
  smart_wallet_count: number;
  smart_volume: number;
  smart_realized_pnl?: number;
  avg_smart_roi?: number;
  [key: string]: unknown;
}

export interface PdxWalletProfile {
  wallet: string;
  styles?: string[];
  metrics?: {
    all_time?: PdxWalletMetrics;
    '30d'?: PdxWalletMetrics;
    '7d'?: PdxWalletMetrics;
    '1d'?: PdxWalletMetrics;
  };
  [key: string]: unknown;
}

export interface PdxWalletMetrics {
  realized_pnl?: number;
  total_pnl?: number;
  volume?: number;
  roi?: number;
  win_rate?: number;
  trades?: number;
  profit_factor?: number;
  avg_trade_usd?: number;
}

export interface PdxWalletPnl {
  summary?: {
    realized_pnl: number;
    unrealized_pnl: number;
    total_pnl: number;
    fees_paid: number;
  };
  pnl_over_time?: Array<{
    timestamp: number;
    cumulative_pnl: number;
  }>;
}

export interface PdxWalletMarket {
  condition_id: string;
  title: string;
  total_pnl: number;
  realized_pnl?: number;
  volume?: number;
  trades?: number;
  roi?: number;
  win_rate?: number;
  [key: string]: unknown;
}

export interface PdxHolder {
  wallet: string;
  shares: number;
  value?: number;
  avg_price?: number;
  trades?: number;
  side?: string;
}

export interface PdxSimilarWallet {
  wallet: string;
  overlap_markets: number;
  overlap_pct: number;
  total_pnl?: number;
  roi?: number;
  [key: string]: unknown;
}

export interface PdxCryptoUpDown {
  condition_id: string;
  title: string;
  asset: string;
  timeframe: string;
  status: string;
  start_time?: number;
  end_time?: number;
  outcomes?: Array<{
    label: string;
    price: number;
    token_id?: string;
  }>;
  [key: string]: unknown;
}

export interface PdxBinanceCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  [key: string]: unknown;
}

// ── Market Data ────────────────────────────────────────────────────────────

export async function fetchClosedMarkets(params: {
  limit?: number;
  search?: string;
  tags?: string[];
  min_volume?: number;
}): Promise<PdxMarket[]> {
  const key = `pdx:markets:closed:${JSON.stringify(params)}`;
  const raw: any = await cachedGet(key, '/v2/markets', {
    status: 'closed',
    limit: params.limit ?? 100,
    search: params.search,
    min_volume: params.min_volume,
    sort: 'expiration',
  });
  return Array.isArray(raw) ? raw : (raw?.markets ?? raw?.data ?? []);
}

export async function fetchOpenMarkets(params?: {
  limit?: number;
  search?: string;
  condition_id?: string;
}): Promise<PdxMarket[]> {
  const key = `pdx:markets:open:${JSON.stringify(params ?? {})}`;
  const raw: any = await cachedGet(key, '/v2/markets', {
    status: 'open',
    limit: params?.limit ?? 20,
    search: params?.search,
    condition_id: params?.condition_id,
  });
  return Array.isArray(raw) ? raw : (raw?.markets ?? raw?.data ?? []);
}

// ── Price & Candlesticks ───────────────────────────────────────────────────

export async function fetchCandlesticks(
  conditionId: string,
  interval: number = 1440,
  startTime?: number,
  endTime?: number,
): Promise<PdxCandle[]> {
  const key = `pdx:candles:${conditionId}:${interval}:${startTime ?? ''}:${endTime ?? ''}`;
  const raw: any = await cachedGet(key, '/v2/candlesticks', {
    condition_id: conditionId,
    interval,
    start_time: startTime,
    end_time: endTime,
  });
  return Array.isArray(raw) ? raw : (raw?.candles ?? raw?.data ?? []);
}

export async function fetchMarketPrice(
  tokenId: string,
  atTime?: number,
): Promise<PdxPrice> {
  const key = `pdx:price:${tokenId}:${atTime ?? 'now'}`;
  return cachedGet<PdxPrice>(key, '/v2/price', {
    token_id: tokenId,
    at_time: atTime,
  }, 60); // shorter TTL for current prices
}

// ── Trades ─────────────────────────────────────────────────────────────────

export async function fetchTrades(params: {
  condition_id?: string;
  token_id?: string;
  wallet?: string;
  market_slug?: string;
  start_time?: number;
  end_time?: number;
  limit?: number;
  order?: 'asc' | 'desc';
  min_total?: number;
}): Promise<PdxTrade[]> {
  const key = `pdx:trades:${JSON.stringify(params)}`;
  const raw: any = await cachedGet(key, '/v2/trades', params as any);
  return Array.isArray(raw) ? raw : (raw?.trades ?? raw?.data ?? []);
}

// ── Volume ─────────────────────────────────────────────────────────────────

export async function fetchVolumeChart(
  conditionId: string,
  granularity: 'hour' | 'day' | 'week' = 'day',
  startTime?: number,
  endTime?: number,
): Promise<PdxVolumePoint[]> {
  const key = `pdx:volchart:${conditionId}:${granularity}:${startTime ?? ''}:${endTime ?? ''}`;
  const raw: any = await cachedGet(key, '/v2/volume-chart', {
    condition_id: conditionId,
    granularity,
    start_time: startTime,
    end_time: endTime,
  });
  return Array.isArray(raw) ? raw : (raw?.data ?? raw?.volume ?? []);
}

// ── Open Interest ──────────────────────────────────────────────────────────

export async function fetchOpenInterest(
  conditionId: string,
  granularity: 'day' | 'week' | 'month' = 'day',
  startTime?: number,
  endTime?: number,
): Promise<PdxOiPoint[]> {
  const key = `pdx:oi:${conditionId}:${granularity}:${startTime ?? ''}:${endTime ?? ''}`;
  const raw: any = await cachedGet(key, '/v2/open-interest', {
    condition_id: conditionId,
    granularity,
    start_time: startTime,
    end_time: endTime,
  });
  return Array.isArray(raw) ? raw : (raw?.data ?? []);
}

// ── Smart Money ────────────────────────────────────────────────────────────

export async function fetchSmartMoney(
  conditionId: string,
  filters?: {
    min_realized_pnl?: number;
    min_roi?: number;
    min_trades?: number;
    min_volume?: number;
    window?: '1d' | '7d' | '30d' | 'all_time';
  },
): Promise<PdxSmartMoney> {
  const key = `pdx:smart:${conditionId}:${JSON.stringify(filters ?? {})}`;
  return cachedGet<PdxSmartMoney>(key, '/v2/smart-money', {
    condition_id: conditionId,
    min_realized_pnl: filters?.min_realized_pnl ?? 1000,
    min_roi: filters?.min_roi,
    min_trades: filters?.min_trades,
    min_volume: filters?.min_volume,
    window: filters?.window ?? 'all_time',
  });
}

export async function fetchSmartActivity(
  params?: {
    min_realized_pnl?: number;
    min_roi?: number;
    min_trades?: number;
    status?: 'open' | 'closed';
    sort_by?: string;
    limit?: number;
    window?: string;
  },
): Promise<PdxSmartActivity[]> {
  const key = `pdx:smartact:${JSON.stringify(params ?? {})}`;
  const raw: any = await cachedGet(key, '/v2/smart-activity', {
    min_realized_pnl: params?.min_realized_pnl ?? 1000,
    min_roi: params?.min_roi,
    min_trades: params?.min_trades,
    status: params?.status ?? 'open',
    sort_by: params?.sort_by ?? 'smart_volume',
    limit: params?.limit ?? 20,
    window: params?.window ?? 'all_time',
  });
  return Array.isArray(raw) ? raw : (raw?.markets ?? raw?.data ?? []);
}

// ── Wallet Analytics ───────────────────────────────────────────────────────

export async function fetchWalletProfile(address: string): Promise<PdxWalletProfile> {
  const key = `pdx:wprofile:${address}`;
  return cachedGet<PdxWalletProfile>(key, '/v2/wallet-profile', { wallet: address });
}

export async function fetchWalletPnl(
  address: string,
  granularity: 'day' | 'week' | 'month' | 'all' = 'day',
  startTime?: number,
  endTime?: number,
): Promise<PdxWalletPnl> {
  const key = `pdx:wpnl:${address}:${granularity}:${startTime ?? ''}:${endTime ?? ''}`;
  return cachedGet<PdxWalletPnl>(key, '/v2/pnl', {
    wallet: address,
    granularity,
    start_time: startTime,
    end_time: endTime,
  });
}

export async function fetchWalletMarkets(
  address: string,
  params?: {
    sort_by?: string;
    order?: 'asc' | 'desc';
    limit?: number;
    min_trades?: number;
  },
): Promise<PdxWalletMarket[]> {
  const key = `pdx:wmkts:${address}:${JSON.stringify(params ?? {})}`;
  const raw: any = await cachedGet(key, '/v2/wallet-markets', {
    wallet: address,
    sort_by: params?.sort_by ?? 'total_pnl',
    order: params?.order ?? 'desc',
    limit: params?.limit ?? 10,
    min_trades: params?.min_trades,
  });
  return Array.isArray(raw) ? raw : (raw?.markets ?? raw?.data ?? []);
}

export async function fetchTopHolders(
  conditionId: string,
  side?: 'yes' | 'no',
  limit: number = 10,
): Promise<PdxHolder[]> {
  const key = `pdx:holders:${conditionId}:${side ?? 'all'}:${limit}`;
  const raw: any = await cachedGet(key, '/v2/top-holders', {
    condition_id: conditionId,
    side,
    limit,
  });
  return Array.isArray(raw) ? raw : (raw?.holders ?? raw?.data ?? []);
}

export async function fetchSimilarWallets(
  address: string,
  limit: number = 10,
): Promise<PdxSimilarWallet[]> {
  const key = `pdx:similar:${address}:${limit}`;
  const raw: any = await cachedGet(key, '/v2/similar-wallets', {
    wallet: address,
    limit,
  });
  return Array.isArray(raw) ? raw : (raw?.wallets ?? raw?.data ?? []);
}

// ── Crypto Up-Down ─────────────────────────────────────────────────────────

export async function fetchCryptoUpDown(params: {
  asset?: string;
  timeframe?: string;
  status?: 'open' | 'closed';
  limit?: number;
  sort?: 'asc' | 'desc';
  end_after?: number;
  end_before?: number;
}): Promise<PdxCryptoUpDown[]> {
  const key = `pdx:updown:${JSON.stringify(params)}`;
  const raw: any = await cachedGet(key, '/v2/crypto-updown', params as any);
  return Array.isArray(raw) ? raw : (raw?.markets ?? raw?.data ?? []);
}

// ── Binance Candles ────────────────────────────────────────────────────────

export async function fetchBinanceCandles(
  symbol: string,
  interval: string = '1m',
  startTime?: number,
  endTime?: number,
  limit: number = 500,
): Promise<PdxBinanceCandle[]> {
  const key = `pdx:binance:${symbol}:${interval}:${startTime ?? ''}:${endTime ?? ''}`;
  const raw: any = await cachedGet(key, '/v2/binance/candles', {
    symbol,
    interval,
    start_time: startTime,
    end_time: endTime,
    limit,
  });
  return Array.isArray(raw) ? raw : (raw?.candles ?? raw?.data ?? []);
}
