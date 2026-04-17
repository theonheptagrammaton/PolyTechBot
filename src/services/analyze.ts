/**
 * Analyze service — market analysis, wallet analysis, and smart money scanning.
 * Aggregates data from Predexon Data API for the Telegram Analyze feature.
 */

import { logger } from '../utils/logger';
import { redisCache } from '../database/redis';
import {
  fetchCandlesticks,
  fetchVolumeChart,
  fetchOpenInterest,
  fetchSmartMoney,
  fetchSmartActivity,
  fetchWalletProfile,
  fetchWalletPnl,
  fetchWalletMarkets,
  fetchTopHolders,
  fetchSimilarWallets,
  fetchOpenMarkets,
  PdxCandle,
  PdxSmartMoney,
  PdxSmartActivity,
  PdxWalletProfile,
  PdxWalletMetrics,
  PdxWalletMarket,
  PdxHolder,
  PdxSimilarWallet,
  PdxVolumePoint,
  PdxOiPoint,
} from './predexonData';

const AZ_CACHE_TTL = 300; // 5 min

// ── Types ──────────────────────────────────────────────────────────────────

export interface MarketAnalysis {
  conditionId: string;
  title: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  openInterest: number;

  priceTrend: {
    open7d: number;
    current: number;
    changePct: number;
    high7d: number;
    low7d: number;
    volatility: 'Low' | 'Medium' | 'High';
  };

  volumeAnalysis: {
    dailyAvg: number;
    buyVolume: number;
    sellVolume: number;
    buySellRatio: number;
    oiChange7d: number;
  };

  smartMoney: {
    netBuyers: number;
    netSellers: number;
    smartVolume: number;
    signal: 'Bullish' | 'Bearish' | 'Neutral';
    dominantSide: 'YES' | 'NO' | 'MIXED';
  };

  topHoldersYes: PdxHolder[];
  topHoldersNo: PdxHolder[];
}

export interface WalletAnalysis {
  address: string;
  styles: string[];

  allTime: WalletMetricsSummary;
  thirtyDay: WalletMetricsSummary;
  sevenDay: WalletMetricsSummary;

  topMarkets: PdxWalletMarket[];
  pnlHistory: Array<{ timestamp: number; cumulative_pnl: number }>;
}

export interface WalletMetricsSummary {
  totalPnl: number;
  roi: number;
  volume: number;
  winRate: number;
  trades: number;
  profitFactor: number;
  avgTradeSize: number;
}

export interface SmartMoneyScan {
  markets: SmartMarketEntry[];
  hasMore: boolean;
}

export interface SmartMarketEntry {
  conditionId: string;
  title: string;
  smartWalletCount: number;
  smartVolume: number;
  direction: 'YES' | 'NO' | 'MIXED';
  avgSmartRoi: number;
  buyCount: number;
  sellCount: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function metricsToSummary(m: PdxWalletMetrics | undefined): WalletMetricsSummary {
  return {
    totalPnl: m?.total_pnl ?? m?.realized_pnl ?? 0,
    roi: m?.roi ?? 0,
    volume: m?.volume ?? 0,
    winRate: m?.win_rate ?? 0,
    trades: m?.trades ?? 0,
    profitFactor: m?.profit_factor ?? 0,
    avgTradeSize: m?.avg_trade_usd ?? 0,
  };
}

function calcVolatility(candles: PdxCandle[]): 'Low' | 'Medium' | 'High' {
  if (candles.length < 2) return 'Low';
  const changes = candles.slice(1).map((c, i) => Math.abs(c.close - candles[i].close));
  const avg = changes.reduce((s, v) => s + v, 0) / changes.length;
  if (avg > 0.10) return 'High';
  if (avg > 0.04) return 'Medium';
  return 'Low';
}

// ── Market Analysis ────────────────────────────────────────────────────────

export async function analyzeMarket(conditionId: string): Promise<MarketAnalysis | null> {
  const cacheKey = `az:market:${conditionId}`;
  const cached = await redisCache.get<MarketAnalysis>(cacheKey);
  if (cached) return cached;

  try {
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - 7 * 86400;
    const thirtyDaysAgo = now - 30 * 86400;

    // Parallel fetch — use allSettled for graceful degradation
    const [marketsR, candlesR, volumeR, oiR, smartR, holdersYR, holdersNR] = await Promise.allSettled([
      fetchOpenMarkets({ condition_id: conditionId, limit: 1 }),
      fetchCandlesticks(conditionId, 1440, sevenDaysAgo, now),
      fetchVolumeChart(conditionId, 'day', sevenDaysAgo, now),
      fetchOpenInterest(conditionId, 'day', thirtyDaysAgo, now),
      fetchSmartMoney(conditionId, { min_realized_pnl: 1000 }),
      fetchTopHolders(conditionId, 'yes', 5),
      fetchTopHolders(conditionId, 'no', 5),
    ]);

    const markets = marketsR.status === 'fulfilled' ? marketsR.value : [];
    const market = markets[0];
    if (!market) {
      logger.warn(`[analyze] Market not found: ${conditionId}`);
      return null;
    }

    const candles: PdxCandle[] = candlesR.status === 'fulfilled' ? candlesR.value : [];
    const volume: PdxVolumePoint[] = volumeR.status === 'fulfilled' ? volumeR.value : [];
    const oi: PdxOiPoint[] = oiR.status === 'fulfilled' ? oiR.value : [];
    const smart: PdxSmartMoney = smartR.status === 'fulfilled' ? smartR.value : { condition_id: conditionId, net_buyers: 0, net_sellers: 0 };
    const holdersYes: PdxHolder[] = holdersYR.status === 'fulfilled' ? holdersYR.value : [];
    const holdersNo: PdxHolder[] = holdersNR.status === 'fulfilled' ? holdersNR.value : [];

    // Price trend
    const yesPrice = market.outcomes?.[0]?.price ?? 0;
    const noPrice = market.outcomes?.[1]?.price ?? (1 - yesPrice);
    const open7d = candles.length > 0 ? candles[0].open : yesPrice;
    const high7d = candles.length > 0 ? Math.max(...candles.map(c => c.high)) : yesPrice;
    const low7d = candles.length > 0 ? Math.min(...candles.map(c => c.low)) : yesPrice;
    const changePct = open7d > 0 ? ((yesPrice - open7d) / open7d) * 100 : 0;

    // Volume analysis
    const totalBuyVol = volume.reduce((s, v) => s + (v.buy_volume ?? 0), 0);
    const totalSellVol = volume.reduce((s, v) => s + (v.sell_volume ?? 0), 0);
    const dailyAvg = volume.length > 0
      ? volume.reduce((s, v) => s + v.total_volume, 0) / volume.length
      : 0;
    const buySellRatio = totalSellVol > 0 ? totalBuyVol / totalSellVol : totalBuyVol > 0 ? 999 : 1;

    // OI change
    const oiChange7d = oi.length >= 2 ? (oi[oi.length - 1].open_interest - oi[0].open_interest) : 0;

    // Smart money signal
    const netBuyers = smart.net_buyers ?? 0;
    const netSellers = smart.net_sellers ?? 0;
    let signal: 'Bullish' | 'Bearish' | 'Neutral' = 'Neutral';
    let dominantSide: 'YES' | 'NO' | 'MIXED' = 'MIXED';
    if (netBuyers > netSellers * 1.5) { signal = 'Bullish'; dominantSide = 'YES'; }
    else if (netSellers > netBuyers * 1.5) { signal = 'Bearish'; dominantSide = 'NO'; }

    const result: MarketAnalysis = {
      conditionId,
      title: market.title ?? '',
      yesPrice,
      noPrice,
      volume: market.volume ?? 0,
      openInterest: market.open_interest ?? 0,
      priceTrend: {
        open7d,
        current: yesPrice,
        changePct: parseFloat(changePct.toFixed(1)),
        high7d,
        low7d,
        volatility: calcVolatility(candles),
      },
      volumeAnalysis: {
        dailyAvg: parseFloat(dailyAvg.toFixed(0)),
        buyVolume: parseFloat(totalBuyVol.toFixed(0)),
        sellVolume: parseFloat(totalSellVol.toFixed(0)),
        buySellRatio: parseFloat(buySellRatio.toFixed(2)),
        oiChange7d: parseFloat(oiChange7d.toFixed(0)),
      },
      smartMoney: {
        netBuyers,
        netSellers,
        smartVolume: smart.smart_volume ?? 0,
        signal,
        dominantSide,
      },
      topHoldersYes: holdersYes,
      topHoldersNo: holdersNo,
    };

    await redisCache.set(cacheKey, result, AZ_CACHE_TTL).catch(() => {});
    return result;
  } catch (err: any) {
    logger.error(`[analyze] analyzeMarket failed: ${err?.message}`);
    return null;
  }
}

// ── Wallet Analysis ────────────────────────────────────────────────────────

export async function analyzeWallet(address: string): Promise<WalletAnalysis | null> {
  const addr = address.toLowerCase();
  const cacheKey = `az:wallet:${addr}`;
  const cached = await redisCache.get<WalletAnalysis>(cacheKey);
  if (cached) return cached;

  try {
    const [profileR, pnlR, marketsR] = await Promise.allSettled([
      fetchWalletProfile(addr),
      fetchWalletPnl(addr, 'day'),
      fetchWalletMarkets(addr, { sort_by: 'total_pnl', order: 'desc', limit: 5 }),
    ]);

    const profile: PdxWalletProfile = profileR.status === 'fulfilled'
      ? profileR.value
      : { wallet: addr };

    const pnl = pnlR.status === 'fulfilled' ? pnlR.value : {};
    const topMarkets: PdxWalletMarket[] = marketsR.status === 'fulfilled' ? marketsR.value : [];

    const result: WalletAnalysis = {
      address: addr,
      styles: profile.styles ?? [],
      allTime: metricsToSummary(profile.metrics?.all_time),
      thirtyDay: metricsToSummary(profile.metrics?.['30d']),
      sevenDay: metricsToSummary(profile.metrics?.['7d']),
      topMarkets,
      pnlHistory: pnl.pnl_over_time ?? [],
    };

    await redisCache.set(cacheKey, result, AZ_CACHE_TTL).catch(() => {});
    return result;
  } catch (err: any) {
    logger.error(`[analyze] analyzeWallet failed: ${err?.message}`);
    return null;
  }
}

// ── Smart Money Scanner ────────────────────────────────────────────────────

const SMART_PAGE_SIZE = 10;

export async function scanSmartMoney(page: number = 1): Promise<SmartMoneyScan> {
  const cacheKey = `az:smart:${page}`;
  const cached = await redisCache.get<SmartMoneyScan>(cacheKey);
  if (cached) return cached;

  try {
    // Fetch a bit more than page size to detect hasMore
    const items = await fetchSmartActivity({
      min_realized_pnl: 1000,
      status: 'open',
      sort_by: 'smart_volume',
      limit: SMART_PAGE_SIZE + 1,
    });

    const hasMore = items.length > SMART_PAGE_SIZE;
    const pageItems = items.slice(0, SMART_PAGE_SIZE);

    // For each market, fetch smart money direction
    const enriched = await Promise.allSettled(
      pageItems.map(async (item: PdxSmartActivity) => {
        let direction: 'YES' | 'NO' | 'MIXED' = 'MIXED';
        let buyCount = 0;
        let sellCount = 0;
        try {
          const sm = await fetchSmartMoney(item.condition_id, { min_realized_pnl: 1000 });
          buyCount = sm.net_buyers ?? 0;
          sellCount = sm.net_sellers ?? 0;
          if (buyCount > sellCount * 1.5) direction = 'YES';
          else if (sellCount > buyCount * 1.5) direction = 'NO';
        } catch { /* graceful fallback */ }

        return {
          conditionId: item.condition_id,
          title: item.title ?? '',
          smartWalletCount: item.smart_wallet_count ?? 0,
          smartVolume: item.smart_volume ?? 0,
          direction,
          avgSmartRoi: item.avg_smart_roi ?? 0,
          buyCount,
          sellCount,
        } as SmartMarketEntry;
      })
    );

    const markets = enriched
      .filter((r): r is PromiseFulfilledResult<SmartMarketEntry> => r.status === 'fulfilled')
      .map(r => r.value);

    const result: SmartMoneyScan = { markets, hasMore };
    await redisCache.set(cacheKey, result, AZ_CACHE_TTL).catch(() => {});
    return result;
  } catch (err: any) {
    logger.error(`[analyze] scanSmartMoney failed: ${err?.message}`);
    return { markets: [], hasMore: false };
  }
}

// ── Sub-page Helpers ───────────────────────────────────────────────────────

export async function getMarketVolumeDetail(conditionId: string) {
  const now = Math.floor(Date.now() / 1000);
  return fetchVolumeChart(conditionId, 'day', now - 30 * 86400, now);
}

export async function getMarketHolders(conditionId: string, side: 'yes' | 'no') {
  return fetchTopHolders(conditionId, side, 10);
}

export async function getWalletPnlHistory(address: string) {
  return fetchWalletPnl(address.toLowerCase(), 'day');
}

export async function getWalletMarketsPage(address: string, page: number = 1) {
  const limit = 10;
  return fetchWalletMarkets(address.toLowerCase(), {
    sort_by: 'total_pnl',
    order: 'desc',
    limit,
  });
}

export async function getWalletSimilar(address: string) {
  return fetchSimilarWallets(address.toLowerCase(), 10);
}
