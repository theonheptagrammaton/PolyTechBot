import { prisma } from '../database/prisma';
import { redisCache } from '../database/redis';
import { logger } from '../utils/logger';
import { config } from '../config';
import { transferCommission, COMMISSION_RATE } from './commission';
import { placeOrder as predexonPlaceOrder, cancelOrder, getOrder } from './predexon';
import { ensurePredexonUser } from './user';
import { getUpDownMarkets, UpDownMarket, UPDOWN_COIN_MAP } from './market';
import { fetchSpotPrice, getRoundOpenPrice } from './cryptoPrice';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NotificationPayload {
  chatId: string;
  text: string;
  buttons?: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}

type SendNotificationFn = (n: NotificationPayload) => void;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Parse "mm:ss" to total seconds */
function parseTimeToSeconds(t: string): number {
  const parts = t.split(':');
  return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
}

/** Get elapsed seconds since round start */
function elapsedSeconds(startDate: string): number {
  const start = new Date(startDate).getTime();
  if (isNaN(start)) return -1;
  return Math.floor((Date.now() - start) / 1000);
}

/** Find the best matching market for a strategy */
function findMatchingMarket(
  coin: string,
  timeframe: string,
  markets: UpDownMarket[],
): UpDownMarket | null {
  // Match coin + timeframe, pick the one that hasn't ended yet and started most recently
  const now = Date.now();
  const candidates = markets.filter(m =>
    m.coin === coin &&
    m.timeframe === timeframe &&
    new Date(m.endDate).getTime() > now &&
    new Date(m.startDate).getTime() <= now
  );
  if (candidates.length === 0) return null;
  // Pick most recently started
  candidates.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
  return candidates[0];
}

/** Get coin emoji from symbol */
function coinEmoji(symbol: string): string {
  for (const info of Object.values(UPDOWN_COIN_MAP)) {
    if (info.symbol === symbol) return info.emoji;
  }
  return '';
}

// ─── Order Execution ────────────────────────────────────────────────────────

interface ExecuteResult {
  success: boolean;
  orderId?: string;
  errorMsg?: string;
  fillPrice?: number;
  actualAmount?: number;
}

export async function executeUpDownOrder(
  user: {
    id: string;
    telegramId: string;
    encryptedPrivateKey: string;
    polymarketProxyAddress: string | null;
    predexonUserId?: string | null;
  },
  market: UpDownMarket,
  strategy: {
    id: string;
    amount: number;
    slippage: number;
    direction: string;
    orderType: string;
    limitPrice: number | null;
    limitTtlSeconds: number;
    coin: string;
  },
  sendNotification?: SendNotificationFn,
): Promise<ExecuteResult> {
  if (!user.polymarketProxyAddress) {
    return { success: false, errorMsg: 'no proxy address' };
  }

  try {
    const predexonUserId = await ensurePredexonUser(user as any);
    const amount = strategy.amount;
    const commissionAmt = parseFloat((amount * COMMISSION_RATE).toFixed(6));
    const tradeAmount = parseFloat((amount - commissionAmt).toFixed(6));

    if (tradeAmount < 1.0) {
      return { success: false, errorMsg: 'trade amount too small after commission' };
    }

    const tokenId = strategy.direction === 'up' ? market.upTokenId : market.downTokenId;
    const triggerPrice = strategy.direction === 'up' ? market.upPrice : market.downPrice;

    let orderResp: any;

    if (strategy.orderType === 'limit' && strategy.limitPrice != null) {
      if (strategy.limitPrice <= 0) {
        return { success: false, errorMsg: 'invalid limit price' };
      }
      // Limit order
      const size = String(Math.floor((tradeAmount / strategy.limitPrice) * 100) / 100);
      orderResp = await predexonPlaceOrder(predexonUserId, {
        venue: 'polymarket',
        tokenId,
        side: 'buy',
        type: 'limit',
        price: String(strategy.limitPrice),
        size,
      });

      if (!orderResp.orderId) {
        const errMsg = orderResp.error || orderResp.message || 'limit order rejected';
        return { success: false, errorMsg: errMsg };
      }

      // Schedule TTL cancel
      scheduleLimitTtl(predexonUserId, orderResp.orderId, strategy.limitTtlSeconds, strategy.id);
    } else {
      // Market order
      orderResp = await predexonPlaceOrder(predexonUserId, {
        venue: 'polymarket',
        tokenId,
        side: 'buy',
        type: 'market',
        amount: String(tradeAmount),
      });

      if (!orderResp.orderId) {
        const errMsg = orderResp.error || orderResp.message || 'order rejected';
        return { success: false, errorMsg: errMsg };
      }
    }

    // Get round open price for context
    let roundStartPrice: number | null = null;
    try {
      roundStartPrice = await getRoundOpenPrice(strategy.coin, market.conditionId);
    } catch { /* non-critical */ }

    // Record trade in DB
    await prisma.upDownTrade.create({
      data: {
        userId: user.id,
        strategyId: strategy.id,
        conditionId: market.conditionId,
        tokenId,
        question: (market.coin + ' ' + market.timeframe + ' ' + strategy.direction).slice(0, 255),
        coin: strategy.coin,
        direction: strategy.direction,
        roundStartPrice,
        triggerPrice,
        amount: tradeAmount,
        fillPrice: strategy.orderType === 'market' ? triggerPrice : null,
        orderId: orderResp.orderId,
        status: strategy.orderType === 'market' ? 'filled' : 'open',
      },
    });

    // Increment roundsExecuted
    await prisma.upDownStrategy.update({
      where: { id: strategy.id },
      data: { roundsExecuted: { increment: 1 } },
    });

    // Commission (fire-and-forget)
    if (config.commission?.adminWalletAddress) {
      transferCommission(
        user.encryptedPrivateKey,
        user.polymarketProxyAddress,
        commissionAmt,
        user.id,
        user.predexonUserId ?? undefined,
      ).catch((err) =>
        logger.warn(`[updown] Commission transfer failed for user ${user.telegramId}: ${err?.message}`)
      );
    }

    return {
      success: true,
      orderId: orderResp.orderId,
      fillPrice: triggerPrice,
      actualAmount: tradeAmount,
    };
  } catch (err: any) {
    // Record failed trade (use post-commission amount for consistency with successful trades)
    const tokenId = strategy.direction === 'up' ? market.upTokenId : market.downTokenId;
    const triggerPrice = strategy.direction === 'up' ? market.upPrice : market.downPrice;
    const failedTradeAmt = parseFloat((strategy.amount - strategy.amount * COMMISSION_RATE).toFixed(6));
    await prisma.upDownTrade.create({
      data: {
        userId: user.id,
        strategyId: strategy.id,
        conditionId: market.conditionId,
        tokenId,
        question: (market.coin + ' ' + market.timeframe + ' ' + strategy.direction).slice(0, 255),
        coin: strategy.coin,
        direction: strategy.direction,
        triggerPrice,
        amount: failedTradeAmt,
        status: 'failed',
        errorMsg: (err?.message ?? 'unknown error').slice(0, 255),
      },
    }).catch(e => logger.warn(`[updown] Failed to log failed trade: ${e?.message}`));

    return { success: false, errorMsg: err?.message ?? 'unknown error' };
  }
}

// ─── Limit Order TTL Management ─────────────────────────────────────────────

const _limitTimers = new Map<string, { cancel: ReturnType<typeof setTimeout>; check: ReturnType<typeof setInterval>; createdAt: number }>();

function scheduleLimitTtl(
  predexonUserId: string,
  orderId: string,
  ttlSeconds: number,
  strategyId: string,
): void {
  function cleanup() {
    const timers = _limitTimers.get(orderId);
    if (timers) {
      clearInterval(timers.check);
      clearTimeout(timers.cancel);
      _limitTimers.delete(orderId);
    }
  }

  // Check fill status every 3s
  const checkInterval = setInterval(async () => {
    try {
      const order = await getOrder(predexonUserId, orderId);
      if (order.status === 'filled') {
        cleanup();
        // Update DB
        const price = parseFloat(order.price ?? '0');
        if (isNaN(price) || price <= 0) {
          logger.warn(`[updown] Limit order ${orderId} filled with invalid price: ${order.price}`);
        }
        await prisma.upDownTrade.updateMany({
          where: { orderId },
          data: { status: 'filled', fillPrice: isNaN(price) ? null : price },
        });
      } else if (order.status === 'cancelled' || order.status === 'expired') {
        cleanup();
        await prisma.upDownTrade.updateMany({
          where: { orderId },
          data: { status: 'cancelled' },
        });
      }
    } catch { /* ignore check errors */ }
  }, 3000);

  // Cancel after TTL
  const cancelTimer = setTimeout(async () => {
    cleanup();
    try {
      // Check if already filled before cancelling (prevents race with check interval)
      const trade = await prisma.upDownTrade.findFirst({
        where: { orderId },
        select: { status: true },
      });
      if (trade && trade.status === 'filled') {
        return; // Already filled by check interval, don't cancel
      }

      await cancelOrder(predexonUserId, orderId);
      await prisma.upDownTrade.updateMany({
        where: { orderId, status: 'open' },
        data: { status: 'cancelled' },
      });
    } catch (err: any) {
      logger.warn(`[updown] Failed to cancel limit order ${orderId}: ${err?.message}`);
    }
  }, ttlSeconds * 1000);

  _limitTimers.set(orderId, { cancel: cancelTimer, check: checkInterval, createdAt: Date.now() });
}

// ─── TP/SL Check ────────────────────────────────────────────────────────────

async function checkUpDownTpSl(sendNotification: SendNotificationFn): Promise<void> {
  // Find filled trades with no tpSlStatus and linked to an active strategy
  const trades = await prisma.upDownTrade.findMany({
    where: {
      status: 'filled',
      tpSlStatus: null,
      strategy: { isActive: true },
    },
    include: {
      strategy: true,
      user: { select: { telegramId: true, predexonUserId: true } },
    },
  });

  if (trades.length === 0) return;

  // Fetch markets once for all trades
  let markets: Awaited<ReturnType<typeof getUpDownMarkets>>;
  try {
    markets = await getUpDownMarkets();
  } catch (err: any) {
    logger.warn(`[updown] TP/SL failed to fetch markets: ${err?.message}`);
    return;
  }

  for (const trade of trades) {
    if (!trade.strategy || trade.fillPrice == null) continue;
    const strat = trade.strategy;

    // Prevent race condition: if another tick is already processing this trade's TP/SL, skip it
    const tpSlLockKey = `updown:tpsl_lock:${trade.id}`;
    const alreadyProcessing = await redisCache.get<number>(tpSlLockKey);
    if (alreadyProcessing) continue;

    // Check if any TP/SL is configured
    const hasTp = strat.takeProfitPct != null || strat.takeProfitPrice != null;
    const hasSl = strat.stopLossPct != null || strat.stopLossPrice != null;
    if (!hasTp && !hasSl) continue;

    // Get current midpoint price from the market
    try {
      const market = markets.find(m => m.conditionId === trade.conditionId);
      if (!market) continue; // Market expired or not found

      const currentPrice = trade.direction === 'up' ? market.upPrice : market.downPrice;

      // TP check
      let tpTriggered = false;
      if (strat.takeProfitPrice != null && currentPrice >= strat.takeProfitPrice) {
        tpTriggered = true;
      } else if (strat.takeProfitPct != null) {
        const target = trade.fillPrice + (trade.fillPrice * strat.takeProfitPct / 100);
        if (currentPrice >= target) tpTriggered = true;
      }

      // SL check (independent of TP — both can trigger, TP takes priority)
      let slTriggered = false;
      if (strat.stopLossPrice != null && currentPrice <= strat.stopLossPrice) {
        slTriggered = true;
      } else if (strat.stopLossPct != null) {
        const target = trade.fillPrice - (trade.fillPrice * strat.stopLossPct / 100);
        if (currentPrice <= target) slTriggered = true;
      }

      if (!tpTriggered && !slTriggered) continue;

      if (tpTriggered && slTriggered) {
        logger.info(`[updown] Trade ${trade.id}: both TP and SL triggered at price ${currentPrice}, using TP`);
      }

      const tpSlStatus = tpTriggered ? 'tp_triggered' : 'sl_triggered';

      // Claim lock to prevent double-processing (60s TTL as safety net)
      await redisCache.set(tpSlLockKey, 1, 60);

      // Place SELL order
      if (!trade.user.predexonUserId) {
        logger.warn(`[updown] TP/SL: no predexonUserId for trade ${trade.id}, marking status only`);
        await prisma.upDownTrade.update({
          where: { id: trade.id },
          data: { tpSlStatus: `${tpSlStatus}_no_sell` },
        });
        continue;
      }

      try {
        // fillPrice for market orders is the mid-market price at order time (approximation).
        // Actual fill may be worse due to slippage, so we apply a 2% haircut to avoid
        // trying to sell more shares than we actually hold.
        const slippageBuffer = 0.98;
        const sellSize = trade.fillPrice > 0
          ? String(Math.floor((trade.amount / trade.fillPrice) * slippageBuffer * 100) / 100)
          : '0';
        if (sellSize === '0') {
          logger.warn(`[updown] TP/SL: invalid sell size for trade ${trade.id} (fillPrice=${trade.fillPrice})`);
          continue;
        }

        const sellResp = await predexonPlaceOrder(trade.user.predexonUserId, {
          venue: 'polymarket',
          tokenId: trade.tokenId,
          side: 'sell',
          type: 'market',
          size: sellSize,
        });

        await prisma.upDownTrade.update({
          where: { id: trade.id },
          data: {
            tpSlStatus,
            tpSlOrderId: sellResp.orderId || null,
          },
        });
      } catch (err: any) {
        logger.warn(`[updown] TP/SL sell failed for trade ${trade.id}: ${err?.message}`);
        continue;
      }

      // Notification
      if (strat.notificationsEnabled) {
        const emoji = tpTriggered ? '🏆' : '🛑';
        const label = tpTriggered ? 'Take Profit' : 'Stop Loss';
        sendNotification({
          chatId: trade.user.telegramId,
          text:
            `${emoji} <b>Up-Down ${label} Triggered</b>\n\n` +
            `${coinEmoji(trade.coin)} ${trade.coin} ${trade.direction.toUpperCase()}\n` +
            `Entry: ${trade.fillPrice.toFixed(2)} → Exit: ${currentPrice.toFixed(2)}\n` +
            `Amount: $${trade.amount.toFixed(2)}`,
        });
      }
    } catch (err: any) {
      logger.warn(`[updown] TP/SL check error for trade ${trade.id}: ${err?.message}`);
    }
  }
}

// ─── Main Monitor ───────────────────────────────────────────────────────────

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let tpSlInterval: ReturnType<typeof setInterval> | null = null;
let limitSweepInterval: ReturnType<typeof setInterval> | null = null;
let _sendNotification: SendNotificationFn | null = null;
let _tickRunning = false;

export function startUpDownMonitor(sendNotification: SendNotificationFn): void {
  if (monitorInterval) return;
  _sendNotification = sendNotification;

  logger.info('[updown] Starting up-down monitor (5s tick)');
  monitorInterval = setInterval(() => {
    if (_tickRunning) return;
    updownTick().catch(err => logger.error(`[updown] Tick error: ${err?.message}`));
  }, 5_000);

  // TP/SL check every 15s
  tpSlInterval = setInterval(() => {
    checkUpDownTpSl(sendNotification).catch(err =>
      logger.error(`[updown] TP/SL check error: ${err?.message}`)
    );
  }, 15_000);

  // Periodic sweep of _limitTimers to clean up leaked entries (every 5 min)
  limitSweepInterval = setInterval(() => {
    const maxAge = 3600_000; // 1 hour — no limit order TTL should exceed this
    const now = Date.now();
    for (const [orderId, timers] of _limitTimers.entries()) {
      if (now - timers.createdAt > maxAge) {
        clearInterval(timers.check);
        clearTimeout(timers.cancel);
        _limitTimers.delete(orderId);
        logger.warn(`[updown] Swept stale limit timer for order ${orderId} (age: ${Math.round((now - timers.createdAt) / 1000)}s)`);
      }
    }
  }, 300_000); // 5 min

  // Recover orphaned limit orders from DB (handles restart scenario)
  recoverOrphanedLimitOrders().catch(err =>
    logger.warn(`[updown] Orphaned limit order recovery failed: ${err?.message}`)
  );

  // First tick after 5s
  setTimeout(() => {
    updownTick().catch(err => logger.error(`[updown] Initial tick error: ${err?.message}`));
  }, 5_000);
}

/** Cancel orphaned 'open' limit orders that have no in-memory timer (e.g. after restart) */
async function recoverOrphanedLimitOrders(): Promise<void> {
  const orphans = await prisma.upDownTrade.findMany({
    where: { status: 'open' },
    include: { user: { select: { predexonUserId: true } } },
  });

  if (orphans.length === 0) return;
  logger.info(`[updown] Found ${orphans.length} orphaned open limit orders, cancelling...`);

  for (const trade of orphans) {
    if (!trade.orderId || !trade.user.predexonUserId) {
      await prisma.upDownTrade.update({
        where: { id: trade.id },
        data: { status: 'cancelled' },
      });
      continue;
    }

    try {
      // Check if the order actually filled while we were down
      const order = await getOrder(trade.user.predexonUserId, trade.orderId);
      if (order.status === 'filled') {
        const price = parseFloat(order.price ?? '0');
        await prisma.upDownTrade.update({
          where: { id: trade.id },
          data: { status: 'filled', fillPrice: isNaN(price) ? null : price },
        });
        logger.info(`[updown] Orphaned order ${trade.orderId} was actually filled at ${price}`);
      } else if (order.status === 'cancelled' || order.status === 'expired') {
        await prisma.upDownTrade.update({
          where: { id: trade.id },
          data: { status: 'cancelled' },
        });
      } else {
        // Still open — cancel it
        await cancelOrder(trade.user.predexonUserId, trade.orderId);
        await prisma.upDownTrade.update({
          where: { id: trade.id },
          data: { status: 'cancelled' },
        });
        logger.info(`[updown] Cancelled orphaned order ${trade.orderId}`);
      }
    } catch (err: any) {
      logger.warn(`[updown] Failed to recover orphaned order ${trade.orderId}: ${err?.message}`);
      // Mark as cancelled to prevent infinite retry
      await prisma.upDownTrade.update({
        where: { id: trade.id },
        data: { status: 'cancelled' },
      }).catch(() => {});
    }
  }
}

export function stopUpDownMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  if (tpSlInterval) {
    clearInterval(tpSlInterval);
    tpSlInterval = null;
  }
  if (limitSweepInterval) {
    clearInterval(limitSweepInterval);
    limitSweepInterval = null;
  }
  // Clear limit timers (both check intervals and cancel timeouts)
  for (const timers of _limitTimers.values()) {
    clearInterval(timers.check);
    clearTimeout(timers.cancel);
  }
  _limitTimers.clear();
  logger.info('[updown] Up-down monitor stopped');
}

async function updownTick(): Promise<void> {
  if (_tickRunning) return;
  _tickRunning = true;
  try {
    await updownTickInner();
  } finally {
    _tickRunning = false;
  }
}

async function updownTickInner(): Promise<void> {
  const sendNotification = _sendNotification;
  if (!sendNotification) return;

  // Get active, unpaused strategies
  const strategies = await prisma.upDownStrategy.findMany({
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

  // Fetch all up/down markets once
  let markets: UpDownMarket[];
  try {
    markets = await getUpDownMarkets();
  } catch (err: any) {
    logger.warn(`[updown] Failed to fetch markets: ${err?.message}`);
    return;
  }

  for (const strat of strategies) {
    try {
      await processStrategy(strat, markets, sendNotification);
    } catch (err: any) {
      logger.warn(`[updown] Strategy ${strat.id} error: ${err?.message}`);
    }
  }
}

async function processStrategy(
  strat: any,
  markets: UpDownMarket[],
  sendNotification: SendNotificationFn,
): Promise<void> {
  // 1. Max rounds check
  if (strat.roundsExecuted >= strat.maxRounds) {
    // Auto-pause
    await prisma.upDownStrategy.update({
      where: { id: strat.id },
      data: { isPaused: true },
    });
    if (strat.notificationsEnabled) {
      sendNotification({
        chatId: strat.user.telegramId,
        text:
          `⏹ <b>Up-Down Strategy Paused</b>\n\n` +
          `${coinEmoji(strat.coin)} ${strat.label || strat.coin} reached max rounds (${strat.maxRounds}).\n` +
          `Strategy has been auto-paused.`,
      });
    }
    return;
  }

  // 2. Find matching market
  const market = findMatchingMarket(strat.coin, strat.timeframe, markets);
  if (!market) return;

  // 3. Dedup — already traded this round?
  const dedupKey = `updown:dedup:${strat.id}:${market.conditionId}`;
  const alreadyTraded = await redisCache.get<number>(dedupKey);
  if (alreadyTraded) return;

  // 4. Time range check
  const elapsed = elapsedSeconds(market.startDate);
  if (elapsed < 0) return;
  const startSec = parseTimeToSeconds(strat.timeRangeStart);
  const endSec = parseTimeToSeconds(strat.timeRangeEnd);
  if (elapsed < startSec || elapsed > endSec) return;

  // 5. UP price check
  const upPrice = market.upPrice;
  if (upPrice < strat.upPriceMin || upPrice > strat.upPriceMax) return;

  // 6. Spot price change check
  try {
    const currentSpot = await fetchSpotPrice(strat.coin);
    const openSpot = await getRoundOpenPrice(strat.coin, market.conditionId);
    const delta = currentSpot - openSpot;
    if (delta < strat.priceChangeMin || delta > strat.priceChangeMax) return;
  } catch {
    // If price fetch fails, skip this tick
    return;
  }

  // All triggers passed — execute!
  logger.info(`[updown] Strategy ${strat.id} triggered on ${market.conditionId}`);

  // Set dedup key BEFORE execution to prevent race condition with concurrent ticks
  await redisCache.set(dedupKey, 1, 1200); // 20min

  const result = await executeUpDownOrder(
    strat.user,
    market,
    strat,
    sendNotification,
  );

  // On failure, remove the optimistic dedup key so the strategy can retry
  if (!result.success) {
    await redisCache.del(dedupKey);
  }

  // Send notification
  if (strat.notificationsEnabled) {
    if (result.success) {
      const dir = strat.direction === 'up' ? '🟢 UP' : '🔴 DOWN';
      const orderStr = strat.orderType === 'limit'
        ? `Limit @ ${strat.limitPrice}`
        : 'Market';
      sendNotification({
        chatId: strat.user.telegramId,
        text:
          `✅ <b>Up-Down Trade Executed</b>\n\n` +
          `${coinEmoji(strat.coin)} ${strat.coin} ${strat.timeframe}\n` +
          `Direction: ${dir} · ${orderStr}\n` +
          `Amount: $${result.actualAmount?.toFixed(2) ?? strat.amount.toFixed(2)}\n` +
          `Round: ${strat.roundsExecuted + 1}/${strat.maxRounds}`,
      });
    } else {
      sendNotification({
        chatId: strat.user.telegramId,
        text:
          `❌ <b>Up-Down Trade Failed</b>\n\n` +
          `${coinEmoji(strat.coin)} ${strat.coin} ${strat.timeframe}\n` +
          `Error: ${result.errorMsg?.slice(0, 100) ?? 'unknown'}`,
      });
    }
  }
}
