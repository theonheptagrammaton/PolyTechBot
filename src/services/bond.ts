import axios from 'axios';
import { prisma } from '../database/prisma';
import { redisCache } from '../database/redis';
import { logger } from '../utils/logger';
import { config } from '../config';
import { transferCommission, COMMISSION_RATE } from './commission';
import { placeOrder as predexonPlaceOrder } from './predexon';
import { ensurePredexonUser } from './user';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BondMarket {
  conditionId: string;
  question: string;
  slug: string;
  endDate: string;
  outcomePrices: number[]; // [yesPrice, noPrice]
  outcomes: string[];      // ['Yes', 'No']
  tokens: Array<{ token_id: string; outcome: string }>;
  liquidity: number;
  volume24hr: number;
  tags?: string[];
  active: boolean;
  closed: boolean;
}

export interface NotificationPayload {
  chatId: string;
  text: string;
  buttons?: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}

type SendNotificationFn = (n: NotificationPayload) => void;

// ─── Market Scanning ────────────────────────────────────────────────────────

/**
 * Fetches active, non-closed markets from Gamma API.
 * Cached for 60s to avoid hammering the API.
 */
export async function fetchBondMarkets(): Promise<BondMarket[]> {
  const cacheKey = 'bond:scan:markets';
  const cached = await redisCache.get<BondMarket[]>(cacheKey);
  if (cached) return cached;

  try {
    const resp = await axios.get(`${GAMMA_API_BASE}/markets`, {
      params: {
        active: true,
        closed: false,
        limit: 200,
      },
      timeout: 15_000,
    });

    const rawMarkets: any[] = resp.data ?? [];
    const markets: BondMarket[] = rawMarkets
      .filter((m: any) => m.conditionId && m.active && !m.closed)
      .map((m: any) => {
        let prices: number[] = [0, 0];
        try {
          const raw = typeof m.outcomePrices === 'string'
            ? JSON.parse(m.outcomePrices)
            : m.outcomePrices;
          prices = Array.isArray(raw) ? raw.map(Number) : [0, 0];
        } catch { /* default */ }

        let outcomes: string[] = ['Yes', 'No'];
        try {
          const raw = typeof m.outcomes === 'string'
            ? JSON.parse(m.outcomes)
            : m.outcomes;
          if (Array.isArray(raw)) outcomes = raw;
        } catch { /* default */ }

        const tokens: Array<{ token_id: string; outcome: string }> = [];
        if (m.clobTokenIds) {
          try {
            const ids = typeof m.clobTokenIds === 'string'
              ? JSON.parse(m.clobTokenIds)
              : m.clobTokenIds;
            if (Array.isArray(ids)) {
              for (let i = 0; i < ids.length; i++) {
                tokens.push({ token_id: ids[i], outcome: outcomes[i] || (i === 0 ? 'Yes' : 'No') });
              }
            }
          } catch { /* skip */ }
        }

        return {
          conditionId: m.conditionId,
          question: m.question || '',
          slug: m.slug || '',
          endDate: m.endDate || '',
          outcomePrices: prices,
          outcomes,
          tokens,
          liquidity: Number(m.liquidity) || 0,
          volume24hr: Number(m.volume24hr) || 0,
          tags: Array.isArray(m.tags) ? m.tags.map((t: any) => typeof t === 'string' ? t : t?.slug || t?.label || '') : [],
          active: !!m.active,
          closed: !!m.closed,
        };
      });

    await redisCache.set(cacheKey, markets, 60);
    return markets;
  } catch (err: any) {
    logger.error(`[bond] Failed to fetch markets: ${err?.message}`);
    return [];
  }
}

// ─── Strategy Filters ───────────────────────────────────────────────────────

interface StrategyForFilter {
  id: string;
  userId: string;
  minProbability: number;
  maxProbability: number;
  maxHoursOut: number;
  maxConcurrent: number;
  includeSports: boolean;
  includeCryptoUpDown: boolean;
  minLiquidity: number | null;
  minVolume: number | null;
  categories: string | null;
  maxSpendPerMarket: number | null;
  dailyBudget: number;
  maxSpendTotal: number | null;
  outcomeSide: string;
}

interface FilterResult {
  pass: boolean;
  outcome: string;
  price: number;
  tokenId: string;
  reason?: string;
}

export async function applyStrategyFilters(
  market: BondMarket,
  strategy: StrategyForFilter,
): Promise<FilterResult> {
  const fail = (reason: string): FilterResult => ({
    pass: false, outcome: '', price: 0, tokenId: '', reason,
  });

  // Determine which side to buy
  const yesPrice = market.outcomePrices[0] ?? 0;
  const noPrice = market.outcomePrices[1] ?? 0;
  const yesPct = yesPrice * 100;
  const noPct = noPrice * 100;

  let chosenOutcome: string;
  let chosenPrice: number;
  let chosenTokenIdx: number;

  if (strategy.outcomeSide === 'yes') {
    chosenOutcome = 'Yes';
    chosenPrice = yesPrice;
    chosenTokenIdx = 0;
  } else if (strategy.outcomeSide === 'no') {
    chosenOutcome = 'No';
    chosenPrice = noPrice;
    chosenTokenIdx = 1;
  } else {
    // auto: pick whichever side has higher probability
    if (yesPct >= noPct) {
      chosenOutcome = 'Yes';
      chosenPrice = yesPrice;
      chosenTokenIdx = 0;
    } else {
      chosenOutcome = 'No';
      chosenPrice = noPrice;
      chosenTokenIdx = 1;
    }
  }

  const chosenPct = chosenPrice * 100;

  // 1. Probability range
  if (chosenPct < strategy.minProbability || chosenPct > strategy.maxProbability) {
    return fail(`probability ${chosenPct.toFixed(1)}% out of range`);
  }

  // 2. maxHoursOut
  if (market.endDate) {
    const endTime = new Date(market.endDate).getTime();
    if (isNaN(endTime)) return fail('invalid market endDate');
    const hoursLeft = (endTime - Date.now()) / (1000 * 60 * 60);
    if (hoursLeft <= 0) return fail('market already expired');
    if (hoursLeft > strategy.maxHoursOut) return fail(`expires in ${hoursLeft.toFixed(0)}h > ${strategy.maxHoursOut}h`);
  }

  // 3. maxConcurrent — count active bond positions for this user+strategy
  const openPositions = await prisma.bondTrade.count({
    where: {
      strategyId: strategy.id,
      status: 'filled',
    },
  });
  if (openPositions >= strategy.maxConcurrent) {
    return fail(`max concurrent ${strategy.maxConcurrent} reached`);
  }

  // 4. Sports / CryptoUpDown filters
  const tags = (market.tags || []).map(t => t.toLowerCase());
  const isSports = tags.some(t => t.includes('sport') || t.includes('nba') || t.includes('nfl') || t.includes('mlb') || t.includes('soccer') || t.includes('football'));
  const isCryptoUpDown = tags.some(t => t.includes('crypto')) &&
    (market.question.toLowerCase().includes('up or down') || market.question.toLowerCase().includes('above') || market.question.toLowerCase().includes('below'));

  if (isSports && !strategy.includeSports) return fail('sports market excluded');
  if (isCryptoUpDown && !strategy.includeCryptoUpDown) return fail('crypto up/down excluded');

  // 5. Min liquidity
  if (strategy.minLiquidity != null && market.liquidity < strategy.minLiquidity) {
    return fail(`liquidity $${market.liquidity.toFixed(0)} < min $${strategy.minLiquidity}`);
  }

  // 6. Min volume
  if (strategy.minVolume != null && market.volume24hr < strategy.minVolume) {
    return fail(`volume $${market.volume24hr.toFixed(0)} < min $${strategy.minVolume}`);
  }

  // 7. Categories filter
  if (strategy.categories) {
    const allowed = strategy.categories.split(',').map(c => c.trim().toLowerCase());
    const marketTags = tags;
    if (!allowed.some(a => marketTags.includes(a))) {
      return fail('category not in allowed list');
    }
  }

  // 8. Dedup — don't buy same market twice for same strategy within 24h
  const dedupKey = `bond:dedup:${strategy.id}:${market.conditionId}`;
  const alreadyBought = await redisCache.get<number>(dedupKey);
  if (alreadyBought) return fail('already bought (dedup)');

  // 9. Max spend per market
  if (strategy.maxSpendPerMarket != null) {
    const spentKey = `bond:spent_per_market:${strategy.id}:${market.conditionId}`;
    const spent = (await redisCache.get<number>(spentKey)) ?? 0;
    if (spent >= strategy.maxSpendPerMarket) return fail('max spend per market reached');
  }

  // 10. Daily budget
  const today = new Date().toISOString().slice(0, 10);
  const dailyKey = `bond:daily:${strategy.id}:${today}`;
  const dailySpent = (await redisCache.get<number>(dailyKey)) ?? 0;
  if (dailySpent >= strategy.dailyBudget) return fail('daily budget exhausted');

  // 11. Daily loss pause
  const pausedKey = `bond:paused_today:${strategy.id}:${today}`;
  const paused = await redisCache.get<number>(pausedKey);
  if (paused) return fail('paused due to daily loss');

  // 12. Max spend total (lifetime)
  if (strategy.maxSpendTotal != null) {
    const totalKey = `bond:total:${strategy.id}`;
    const totalSpent = (await redisCache.get<number>(totalKey)) ?? 0;
    if (totalSpent >= strategy.maxSpendTotal) return fail('lifetime max spend reached');
  }

  // Resolve token
  const token = market.tokens[chosenTokenIdx];
  if (!token?.token_id) return fail('no token ID');

  return {
    pass: true,
    outcome: chosenOutcome,
    price: chosenPrice,
    tokenId: token.token_id,
  };
}

// ─── Order Execution ────────────────────────────────────────────────────────

interface ExecuteResult {
  success: boolean;
  orderId?: string;
  errorMsg?: string;
  filledPrice?: number;
  actualAmount?: number;
}

export async function executeBondOrder(
  user: {
    id: string;
    telegramId: string;
    encryptedPrivateKey: string;
    polymarketProxyAddress: string | null;
    predexonUserId?: string | null;
  },
  market: BondMarket,
  strategy: {
    id: string;
    fixedAmount: number;
    slippage: number;
  },
  tokenId: string,
  outcome: string,
  price: number,
): Promise<ExecuteResult> {
  if (!user.polymarketProxyAddress) {
    return { success: false, errorMsg: 'no proxy address' };
  }

  try {
    const predexonUserId = await ensurePredexonUser(user as any);
    const amount = strategy.fixedAmount;
    const commissionAmt = parseFloat((amount * COMMISSION_RATE).toFixed(6));
    const tradeAmount = parseFloat((amount - commissionAmt).toFixed(6));

    if (tradeAmount < 1.0) {
      return { success: false, errorMsg: 'trade amount too small after commission' };
    }

    // Place market BUY order
    const orderResp = await predexonPlaceOrder(predexonUserId, {
      venue: 'polymarket',
      tokenId,
      side: 'buy',
      type: 'market',
      amount: String(tradeAmount),
    });

    if (!orderResp.orderId) {
      const errMsg = (orderResp as any).error || (orderResp as any).message || 'order rejected';
      return { success: false, errorMsg: errMsg };
    }

    // Record trade in DB
    await prisma.bondTrade.create({
      data: {
        userId: user.id,
        strategyId: strategy.id,
        conditionId: market.conditionId,
        tokenId,
        question: market.question.slice(0, 255),
        outcome,
        probability: price,
        amount: tradeAmount,
        price,
        orderId: orderResp.orderId,
        status: 'filled',
      },
    });

    // Update Redis spend trackers
    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = `bond:daily:${strategy.id}:${today}`;
    const totalKey = `bond:total:${strategy.id}`;
    const dedupKey = `bond:dedup:${strategy.id}:${market.conditionId}`;
    const perMarketKey = `bond:spent_per_market:${strategy.id}:${market.conditionId}`;

    const [dailySpent, totalSpent, perMarketSpent] = await Promise.all([
      redisCache.get<number>(dailyKey).then(v => v ?? 0),
      redisCache.get<number>(totalKey).then(v => v ?? 0),
      redisCache.get<number>(perMarketKey).then(v => v ?? 0),
    ]);

    await Promise.all([
      redisCache.set(dailyKey, dailySpent + tradeAmount, 90_000), // 25h
      redisCache.set(totalKey, totalSpent + tradeAmount),
      redisCache.set(dedupKey, 1, 86_400), // 24h
      redisCache.set(perMarketKey, perMarketSpent + tradeAmount, 604_800), // 7d
    ]);

    // Commission (fire-and-forget)
    if (config.commission?.adminWalletAddress) {
      transferCommission(
        user.encryptedPrivateKey,
        user.polymarketProxyAddress,
        commissionAmt,
        user.id,
        user.predexonUserId ?? undefined
      ).catch((err) =>
        logger.warn(`[bond] Commission transfer failed for user ${user.telegramId}: ${err?.message}`)
      );
    }

    return {
      success: true,
      orderId: orderResp.orderId,
      filledPrice: price,
      actualAmount: tradeAmount,
    };
  } catch (err: any) {
    // Record failed trade (amount = intended tradeAmount after commission)
    const failedTradeAmt = parseFloat((strategy.fixedAmount - strategy.fixedAmount * COMMISSION_RATE).toFixed(6));
    await prisma.bondTrade.create({
      data: {
        userId: user.id,
        strategyId: strategy.id,
        conditionId: market.conditionId,
        tokenId,
        question: market.question.slice(0, 255),
        outcome,
        probability: price,
        amount: failedTradeAmt,
        price,
        status: 'failed',
        errorMsg: (err?.message ?? 'unknown error').slice(0, 255),
      },
    }).catch(e => logger.warn(`[bond] Failed to log failed trade: ${e?.message}`));

    return { success: false, errorMsg: err?.message ?? 'unknown error' };
  }
}

// ─── Daily Loss Check ───────────────────────────────────────────────────────

/**
 * Checks if a strategy has exceeded its daily loss limit.
 * For bond trading, loss = amount spent on markets that resolved against us.
 * Simplified: we check how much was spent today. If maxDailyLoss is set and
 * the count of failed/low-confidence trades exceeds it, pause the strategy.
 */
export async function checkDailyLoss(
  strategyId: string,
  maxDailyLoss: number,
  sendNotification?: SendNotificationFn,
  chatId?: string,
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const pausedKey = `bond:paused_today:${strategyId}:${today}`;

  // Already paused today
  const alreadyPaused = await redisCache.get<number>(pausedKey);
  if (alreadyPaused) return true;

  // Calculate today's realized losses
  const startOfDay = new Date(today + 'T00:00:00Z');
  const trades = await prisma.bondTrade.findMany({
    where: {
      strategyId,
      status: 'filled',
      createdAt: { gte: startOfDay },
    },
    select: { amount: true, price: true },
  });

  // Daily loss = total capital at risk today
  // For bond trading: we buy at high probability, so risk per trade = amount
  // (if market resolves against us, we lose the full amount)
  // Using total spent as the risk metric — conservative but accurate
  let totalSpent = 0;
  for (const t of trades) {
    totalSpent += t.amount;
  }

  if (totalSpent === 0) return false;

  // Use total spent as the loss limit (worst-case: all markets resolve wrong)
  const estimatedLoss = totalSpent;

  if (estimatedLoss >= maxDailyLoss) {
    await redisCache.set(pausedKey, 1, 90_000); // 25h

    if (sendNotification && chatId) {
      sendNotification({
        chatId,
        text:
          `⚠️ <b>Bond Strategy Paused</b>\n\n` +
          `Daily loss limit of $${maxDailyLoss.toFixed(2)} reached.\n` +
          `Estimated exposure: $${estimatedLoss.toFixed(2)}\n` +
          `Strategy will resume tomorrow (UTC).`,
      });
    }

    return true;
  }

  return false;
}

// ─── Monitor ────────────────────────────────────────────────────────────────

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let _sendNotification: SendNotificationFn | null = null;

export function startBondMonitor(sendNotification: SendNotificationFn): void {
  if (monitorInterval) return;
  _sendNotification = sendNotification;

  logger.info('[bond] Starting bond monitor (60s tick)');
  monitorInterval = setInterval(() => {
    bondTick().catch(err => logger.error(`[bond] Tick error: ${err?.message}`));
  }, 60_000);

  // First tick after 10s
  setTimeout(() => {
    bondTick().catch(err => logger.error(`[bond] Initial tick error: ${err?.message}`));
  }, 10_000);
}

export function stopBondMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    logger.info('[bond] Bond monitor stopped');
  }
}

async function bondTick(): Promise<void> {
  // Fetch all active, unpaused strategies
  const strategies = await prisma.bondStrategy.findMany({
    where: { isActive: true, isPaused: false },
    include: {
      user: {
        select: {
          id: true,
          telegramId: true,
          encryptedPrivateKey: true,
          polymarketProxyAddress: true,
          predexonUserId: true,
        },
      },
    },
  });

  if (strategies.length === 0) return;

  const now = Date.now();

  for (const strat of strategies) {
    try {
      // Check scan interval
      const lastTickKey = `bond:last_tick:${strat.id}`;
      const lastTick = (await redisCache.get<number>(lastTickKey)) ?? 0;
      const intervalMs = strat.scanInterval * 60 * 1000;
      if (now - lastTick < intervalMs) continue;

      await redisCache.set(lastTickKey, now);

      // Check daily loss
      if (strat.maxDailyLoss != null) {
        const paused = await checkDailyLoss(
          strat.id,
          strat.maxDailyLoss,
          _sendNotification ?? undefined,
          strat.user.telegramId,
        );
        if (paused) continue;
      }

      // Fetch markets
      const markets = await fetchBondMarkets();
      if (markets.length === 0) continue;

      // Apply filters to each market
      for (const market of markets) {
        const result = await applyStrategyFilters(market, strat);
        if (!result.pass) continue;

        // Execute order
        const execResult = await executeBondOrder(
          strat.user,
          market,
          strat,
          result.tokenId,
          result.outcome,
          result.price,
        );

        if (execResult.success && _sendNotification && strat.notificationsEnabled) {
          const pct = (result.price * 100).toFixed(1);
          _sendNotification({
            chatId: strat.user.telegramId,
            text:
              `🔗 <b>Bond Trade Filled</b>\n\n` +
              `📊 ${market.question.slice(0, 100)}\n` +
              `🎯 ${result.outcome} @ ${pct}%\n` +
              `💵 $${execResult.actualAmount?.toFixed(2) ?? strategy_amount(strat)}\n` +
              `📋 Strategy: ${strat.label || strat.id.slice(0, 8)}`,
          });
        } else if (!execResult.success && _sendNotification && strat.notificationsEnabled) {
          _sendNotification({
            chatId: strat.user.telegramId,
            text:
              `❌ <b>Bond Trade Failed</b>\n\n` +
              `📊 ${market.question.slice(0, 100)}\n` +
              `Reason: ${execResult.errorMsg?.slice(0, 100)}`,
          });
        }

        // Small delay between trades to avoid rate limiting
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (err: any) {
      logger.error(`[bond] Strategy ${strat.id} tick error: ${err?.message}`);
    }
  }
}

function strategy_amount(s: { fixedAmount: number }): string {
  return s.fixedAmount.toFixed(2);
}
