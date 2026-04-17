/**
 * Backtest service — simulates strategy performance against historical data.
 * Results are persisted to the BacktestResult DB model.
 */

import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import {
  fetchClosedMarkets,
  fetchTrades,
  fetchCandlesticks,
  fetchCryptoUpDown,
  fetchBinanceCandles,
  fetchMarketPrice,
  PdxMarket,
  PdxTrade,
  PdxCryptoUpDown,
} from './predexonData';

// ── Types ──────────────────────────────────────────────────────────────────

export interface BacktestParams {
  lookbackDays: number; // 7, 14, 30
}

export interface BacktestTrade {
  marketTitle: string;
  conditionId: string;
  outcome: string;
  entryPrice: number;
  exitPrice: number; // 1.0 for win, 0.0 for loss, or TP/SL price
  amount: number;
  pnl: number;
  timestamp: number;
}

export interface BacktestResult {
  strategyLabel: string;
  strategyType: 'bond' | 'copy' | 'updown';
  lookbackDays: number;
  periodStart: Date;
  periodEnd: Date;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  roi: number;
  avgProfit: number;
  maxDrawdown: number;
  trades: BacktestTrade[];
}

// ── Pure Bond Filter (no Redis side effects) ───────────────────────────────

interface BondFilterParams {
  minProbability: number;
  maxProbability: number;
  maxHoursOut: number;
  includeSports: boolean;
  includeCryptoUpDown: boolean;
  minLiquidity: number | null;
  minVolume: number | null;
  categories: string | null;
  outcomeSide: string;
  fixedAmount: number;
  dailyBudget: number;
}

interface BondFilterResult {
  pass: boolean;
  outcome: string;
  price: number;
  tokenId: string;
  reason?: string;
}

/**
 * Pure version of applyStrategyFilters from bond.ts — no Redis, no DB.
 * Used for backtest simulation only.
 */
function applyBondFiltersPure(market: PdxMarket, params: BondFilterParams): BondFilterResult {
  const fail = (reason: string): BondFilterResult => ({
    pass: false, outcome: '', price: 0, tokenId: '', reason,
  });

  // Extract prices
  const outcomes = market.outcomes ?? [];
  const yesPrice = outcomes[0]?.price ?? 0;
  const noPrice = outcomes[1]?.price ?? (1 - yesPrice);
  const yesPct = yesPrice * 100;
  const noPct = noPrice * 100;

  // Select side
  let chosenPct: number;
  let chosenOutcome: string;
  let chosenPrice: number;
  let tokenId: string;

  if (params.outcomeSide === 'yes') {
    chosenPct = yesPct; chosenOutcome = 'Yes'; chosenPrice = yesPrice;
    tokenId = outcomes[0]?.token_id ?? '';
  } else if (params.outcomeSide === 'no') {
    chosenPct = noPct; chosenOutcome = 'No'; chosenPrice = noPrice;
    tokenId = outcomes[1]?.token_id ?? '';
  } else {
    // auto: pick higher probability side
    if (yesPct >= noPct) {
      chosenPct = yesPct; chosenOutcome = 'Yes'; chosenPrice = yesPrice;
      tokenId = outcomes[0]?.token_id ?? '';
    } else {
      chosenPct = noPct; chosenOutcome = 'No'; chosenPrice = noPrice;
      tokenId = outcomes[1]?.token_id ?? '';
    }
  }

  // 1. Probability range
  if (chosenPct < params.minProbability || chosenPct > params.maxProbability) {
    return fail('probability');
  }

  // 2. Max hours out
  if (market.expiration) {
    const hoursOut = (new Date(market.expiration).getTime() - Date.now()) / 3_600_000;
    if (hoursOut > params.maxHoursOut) return fail('hours_out');
  }

  // 3. Sports filter
  const tags = (market.tags ?? []).map(t => typeof t === 'string' ? t.toLowerCase() : '');
  const title = (market.title ?? '').toLowerCase();
  const isSports = tags.some(t => /sport|nba|nfl|nhl|mlb|soccer|football|basketball|tennis|ufc/i.test(t));
  if (isSports && !params.includeSports) return fail('sports');

  // 4. Crypto up-down filter
  const isCryptoUpDown = tags.some(t => /crypto/i.test(t)) && /\b(up|down|above|below)\b/i.test(title);
  if (isCryptoUpDown && !params.includeCryptoUpDown) return fail('crypto_updown');

  // 5. Liquidity
  if (params.minLiquidity != null && (market.liquidity ?? 0) < params.minLiquidity) {
    return fail('liquidity');
  }

  // 6. Volume
  const vol24 = market.volume_1d ?? market.volume ?? 0;
  if (params.minVolume != null && vol24 < params.minVolume) {
    return fail('volume');
  }

  // 7. Categories
  if (params.categories) {
    const allowed = params.categories.split(',').map(c => c.trim().toLowerCase());
    const hasMatch = tags.some(t => allowed.includes(t));
    if (!hasMatch) return fail('categories');
  }

  return { pass: true, outcome: chosenOutcome, price: chosenPrice, tokenId };
}

// ── Bond Backtest ──────────────────────────────────────────────────────────

export async function backtestBond(
  strategy: {
    id: string;
    label: string | null;
    fixedAmount: number;
    dailyBudget: number;
    minProbability: number;
    maxProbability: number;
    maxHoursOut: number;
    maxConcurrent: number;
    includeSports: boolean;
    includeCryptoUpDown: boolean;
    minLiquidity: number | null;
    minVolume: number | null;
    categories: string | null;
    outcomeSide: string;
  },
  params: BacktestParams,
  userId: string,
): Promise<string> {
  const now = new Date();
  const periodStart = new Date(now.getTime() - params.lookbackDays * 86_400_000);

  // Fetch closed markets
  const markets = await fetchClosedMarkets({ limit: 100 });

  const filterParams: BondFilterParams = {
    minProbability: strategy.minProbability,
    maxProbability: strategy.maxProbability,
    maxHoursOut: strategy.maxHoursOut,
    includeSports: strategy.includeSports,
    includeCryptoUpDown: strategy.includeCryptoUpDown,
    minLiquidity: strategy.minLiquidity,
    minVolume: strategy.minVolume,
    categories: strategy.categories,
    outcomeSide: strategy.outcomeSide,
    fixedAmount: strategy.fixedAmount,
    dailyBudget: strategy.dailyBudget,
  };

  const trades: BacktestTrade[] = [];
  let dailySpend: Record<string, number> = {};

  for (const market of markets) {
    const filter = applyBondFiltersPure(market, filterParams);
    if (!filter.pass) continue;

    // Budget simulation: daily budget check
    const day = market.expiration
      ? new Date(market.expiration).toISOString().slice(0, 10)
      : now.toISOString().slice(0, 10);
    const spent = dailySpend[day] ?? 0;
    if (spent + strategy.fixedAmount > strategy.dailyBudget) continue;
    dailySpend[day] = spent + strategy.fixedAmount;

    // Concurrent limit: count open positions at this point
    const concurrentAtTime = trades.filter(t => {
      const tDay = new Date(t.timestamp * 1000).toISOString().slice(0, 10);
      return tDay === day;
    }).length;
    if (concurrentAtTime >= strategy.maxConcurrent) continue;

    // Determine resolution: which side won?
    // For closed markets, the winning outcome should have price ~1.0
    const outcomes = market.outcomes ?? [];
    const yesPrice = outcomes[0]?.price ?? 0;
    const winnerIsYes = yesPrice > 0.5;
    const chosenWon = (filter.outcome === 'Yes' && winnerIsYes)
      || (filter.outcome === 'No' && !winnerIsYes);

    const exitPrice = chosenWon ? 1.0 : 0.0;
    const pnl = chosenWon
      ? (1.0 - filter.price) * strategy.fixedAmount
      : -filter.price * strategy.fixedAmount;

    trades.push({
      marketTitle: market.title ?? '',
      conditionId: market.condition_id,
      outcome: filter.outcome,
      entryPrice: filter.price,
      exitPrice,
      amount: strategy.fixedAmount,
      pnl: parseFloat(pnl.toFixed(2)),
      timestamp: market.expiration
        ? Math.floor(new Date(market.expiration).getTime() / 1000)
        : Math.floor(now.getTime() / 1000),
    });
  }

  const result = buildResult(
    strategy.label ?? `Bond #${strategy.id.slice(-4)}`,
    'bond',
    params.lookbackDays,
    periodStart,
    now,
    trades,
    strategy.fixedAmount,
  );

  // Save to DB
  const saved = await prisma.backtestResult.create({
    data: {
      userId,
      strategyType: 'bond',
      strategyId: strategy.id,
      strategyLabel: result.strategyLabel,
      lookbackDays: result.lookbackDays,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      totalTrades: result.totalTrades,
      wins: result.wins,
      losses: result.losses,
      winRate: result.winRate,
      totalPnl: result.totalPnl,
      roi: result.roi,
      avgProfit: result.avgProfit,
      maxDrawdown: result.maxDrawdown,
      tradesJson: JSON.stringify(result.trades.slice(0, 50)), // limit stored detail
    },
  });

  return saved.id;
}

// ── Copy Trade Backtest ────────────────────────────────────────────────────

export async function backtestCopy(
  subscription: {
    id: string;
    label: string | null;
    traderAddress: string;
    fixedAmount: number | null;
    multiplier: number | null;
    buyMethod: string;
    followBuys: boolean;
    copySells: boolean;
    copySide: string;
    priceMin: number | null;
    priceMax: number | null;
    takeProfitPct: number | null;
    stopLossPct: number | null;
    dailySpendMax: number | null;
    singleTradeMax: number | null;
  },
  params: BacktestParams,
  userId: string,
): Promise<string> {
  const now = new Date();
  const periodStart = new Date(now.getTime() - params.lookbackDays * 86_400_000);
  const startTs = Math.floor(periodStart.getTime() / 1000);
  const endTs = Math.floor(now.getTime() / 1000);

  // Fetch leader's trades
  const leaderTrades = await fetchTrades({
    wallet: subscription.traderAddress,
    start_time: startTs,
    end_time: endTs,
    limit: 500,
    order: 'asc',
  });

  const trades: BacktestTrade[] = [];
  let dailySpend: Record<string, number> = {};

  for (const lt of leaderTrades) {
    // Side filter
    if (lt.side === 'BUY' && !subscription.followBuys) continue;
    if (lt.side === 'SELL' && !subscription.copySells) continue;

    // Price filter (cents)
    const priceCents = lt.price * 100;
    if (subscription.priceMin != null && priceCents < subscription.priceMin) continue;
    if (subscription.priceMax != null && priceCents > subscription.priceMax) continue;

    // Daily spend limit
    const day = new Date(lt.timestamp * 1000).toISOString().slice(0, 10);
    const spent = dailySpend[day] ?? 0;
    const amount = subscription.fixedAmount ?? (lt.amount_usd * (subscription.multiplier ?? 1));
    const cappedAmount = subscription.singleTradeMax
      ? Math.min(amount, subscription.singleTradeMax)
      : amount;

    if (subscription.dailySpendMax && spent + cappedAmount > subscription.dailySpendMax) continue;
    if (lt.side === 'BUY') dailySpend[day] = spent + cappedAmount;

    // Only simulate BUY trades for PnL (SELL is exit)
    if (lt.side !== 'BUY') continue;

    // Simulate: assume the market eventually resolves
    // Estimate PnL: if TP/SL set, simulate price movement
    let exitPrice = lt.price > 0.5 ? 1.0 : 0.0; // simple: high prob wins
    let pnl: number;

    if (subscription.takeProfitPct && lt.price < 1.0) {
      const tpPrice = lt.price * (1 + subscription.takeProfitPct / 100);
      if (tpPrice < 1.0) exitPrice = Math.min(tpPrice, 1.0);
    }
    if (subscription.stopLossPct) {
      const slPrice = lt.price * (1 - subscription.stopLossPct / 100);
      // If price could hit SL (random walk simulation simplified)
      if (lt.price > 0.5 && slPrice > 0) {
        // Assume TP hits more often for high-prob trades
        exitPrice = lt.price > 0.7 ? 1.0 : slPrice;
      }
    }

    pnl = (exitPrice - lt.price) * cappedAmount;

    trades.push({
      marketTitle: `Trade @ ${(lt.price * 100).toFixed(0)}¢`,
      conditionId: lt.token_id ?? '',
      outcome: lt.side,
      entryPrice: lt.price,
      exitPrice,
      amount: parseFloat(cappedAmount.toFixed(2)),
      pnl: parseFloat(pnl.toFixed(2)),
      timestamp: lt.timestamp,
    });
  }

  const tradeAmount = subscription.fixedAmount ?? 25;
  const result = buildResult(
    subscription.label ?? `Copy ${subscription.traderAddress.slice(0, 8)}...`,
    'copy',
    params.lookbackDays,
    periodStart,
    now,
    trades,
    tradeAmount,
  );

  const saved = await prisma.backtestResult.create({
    data: {
      userId,
      strategyType: 'copy',
      strategyId: subscription.id,
      strategyLabel: result.strategyLabel,
      lookbackDays: result.lookbackDays,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      totalTrades: result.totalTrades,
      wins: result.wins,
      losses: result.losses,
      winRate: result.winRate,
      totalPnl: result.totalPnl,
      roi: result.roi,
      avgProfit: result.avgProfit,
      maxDrawdown: result.maxDrawdown,
      tradesJson: JSON.stringify(result.trades.slice(0, 50)),
    },
  });

  return saved.id;
}

// ── Up-Down Backtest ───────────────────────────────────────────────────────

export async function backtestUpDown(
  strategy: {
    id: string;
    label: string | null;
    coin: string;
    timeframe: string;
    direction: string;
    amount: number;
    upPriceMin: number;
    upPriceMax: number;
    timeRangeStart: string;
    timeRangeEnd: string;
    maxRounds: number;
  },
  params: BacktestParams,
  userId: string,
): Promise<string> {
  const now = new Date();
  const periodStart = new Date(now.getTime() - params.lookbackDays * 86_400_000);
  const startTs = Math.floor(periodStart.getTime() / 1000);
  const endTs = Math.floor(now.getTime() / 1000);

  // Fetch closed crypto up/down rounds
  const rounds = await fetchCryptoUpDown({
    asset: strategy.coin.toLowerCase(),
    timeframe: strategy.timeframe.toLowerCase().replace('-', '').replace(' ', ''),
    status: 'closed',
    limit: 200,
    end_after: startTs,
    end_before: endTs,
  });

  const trades: BacktestTrade[] = [];
  let roundsExecuted = 0;

  for (const round of rounds) {
    if (roundsExecuted >= strategy.maxRounds) break;

    // Check UP price range
    const outcomes = round.outcomes ?? [];
    const upPrice = outcomes[0]?.price ?? 0;
    if (upPrice < strategy.upPriceMin || upPrice > strategy.upPriceMax) continue;

    // Simulate trade
    const isUp = strategy.direction === 'up';
    const entryPrice = isUp ? upPrice : (1 - upPrice);

    // Determine resolution from final prices
    const finalUpPrice = outcomes[0]?.price ?? 0;
    const upWon = finalUpPrice > 0.5;
    const chosenWon = (isUp && upWon) || (!isUp && !upWon);
    const exitPrice = chosenWon ? 1.0 : 0.0;
    const pnl = (exitPrice - entryPrice) * strategy.amount;

    trades.push({
      marketTitle: round.title ?? `${strategy.coin} ${strategy.timeframe}`,
      conditionId: round.condition_id,
      outcome: isUp ? 'Up' : 'Down',
      entryPrice,
      exitPrice,
      amount: strategy.amount,
      pnl: parseFloat(pnl.toFixed(2)),
      timestamp: round.end_time ?? Math.floor(now.getTime() / 1000),
    });

    roundsExecuted++;
  }

  const result = buildResult(
    strategy.label ?? `UpDown ${strategy.coin} ${strategy.timeframe}`,
    'updown',
    params.lookbackDays,
    periodStart,
    now,
    trades,
    strategy.amount,
  );

  const saved = await prisma.backtestResult.create({
    data: {
      userId,
      strategyType: 'updown',
      strategyId: strategy.id,
      strategyLabel: result.strategyLabel,
      lookbackDays: result.lookbackDays,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      totalTrades: result.totalTrades,
      wins: result.wins,
      losses: result.losses,
      winRate: result.winRate,
      totalPnl: result.totalPnl,
      roi: result.roi,
      avgProfit: result.avgProfit,
      maxDrawdown: result.maxDrawdown,
      tradesJson: JSON.stringify(result.trades.slice(0, 50)),
    },
  });

  return saved.id;
}

// ── Result Builder ─────────────────────────────────────────────────────────

function buildResult(
  label: string,
  type: 'bond' | 'copy' | 'updown',
  lookbackDays: number,
  periodStart: Date,
  periodEnd: Date,
  trades: BacktestTrade[],
  tradeAmount: number,
): BacktestResult {
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalInvested = trades.reduce((s, t) => s + t.amount, 0);
  const roi = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  const avgProfit = trades.length > 0 ? totalPnl / trades.length : 0;

  // Max drawdown: largest peak-to-trough
  let peak = 0;
  let maxDrawdown = 0;
  let cumPnl = 0;
  for (const t of trades) {
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    strategyLabel: label,
    strategyType: type,
    lookbackDays,
    periodStart,
    periodEnd,
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? parseFloat(((wins / trades.length) * 100).toFixed(1)) : 0,
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    roi: parseFloat(roi.toFixed(1)),
    avgProfit: parseFloat(avgProfit.toFixed(2)),
    maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
    trades,
  };
}

// ── Fetch History ──────────────────────────────────────────────────────────

export async function getBacktestHistory(userId: string, page: number = 1, pageSize: number = 5) {
  const skip = (page - 1) * pageSize;
  const [results, total] = await Promise.all([
    prisma.backtestResult.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.backtestResult.count({ where: { userId } }),
  ]);
  return { results, total, page, totalPages: Math.ceil(total / pageSize) };
}

export async function getBacktestById(id: string) {
  return prisma.backtestResult.findUnique({ where: { id } });
}
