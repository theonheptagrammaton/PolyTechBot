import { prisma } from '../database/prisma';
import { redisCache } from '../database/redis';
import { logger } from '../utils/logger';
import { config } from '../config';
import { transferCommission, COMMISSION_RATE } from './commission';
import { placeOrder as predexonPlaceOrder, cancelOrder, getOrder, getPositions } from './predexon';
import { ensurePredexonUser } from './user';
import { getUpDownMarkets, UpDownMarket, UPDOWN_COIN_MAP } from './market';
import { fetchSpotPrice, getRoundOpenPrice } from './cryptoPrice';
import { getActivePositions } from './portfolio';
import { manualRedeem } from './redeem';

// ─── Fill-price polling ────────────────────────────────────────────────────
// After placing a market order, poll getOrder() to retrieve the actual fill price
// instead of recording the mid-market price as fillPrice.

const FILL_POLL_INTERVAL_MS = 2_000;
const FILL_POLL_MAX_ATTEMPTS = 10; // 20 seconds max

async function pollActualFillPrice(
  predexonUserId: string,
  orderId: string,
): Promise<{ price: number | null; sizeMatched: string | null }> {
  for (let i = 0; i < FILL_POLL_MAX_ATTEMPTS; i++) {
    try {
      const order = await getOrder(predexonUserId, orderId);
      if (order.status === 'filled') {
        const price = parseFloat(order.price ?? '0');
        return {
          price: isNaN(price) || price <= 0 ? null : price,
          sizeMatched: order.sizeMatched ?? order.size ?? null,
        };
      }
      if (order.status === 'cancelled' || order.status === 'expired') {
        return { price: null, sizeMatched: null };
      }
    } catch (err: any) {
      logger.debug(`[updown] Fill poll attempt ${i + 1}/${FILL_POLL_MAX_ATTEMPTS}: ${err?.message}`);
    }
    await new Promise(r => setTimeout(r, FILL_POLL_INTERVAL_MS));
  }
  return { price: null, sizeMatched: null };
}

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
  // Match coin + timeframe, pick the currently-live round.
  // startDate is the computed round start (endDate − timeframe duration), not event creation time.
  const now = Date.now();
  const candidates = markets.filter(m =>
    m.coin === coin &&
    m.timeframe === timeframe &&
    new Date(m.endDate).getTime() > now &&
    new Date(m.startDate).getTime() <= now
  );
  if (candidates.length === 0) return null;
  // Pick the soonest-ending round (= currently live), not the most recently created
  candidates.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
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
    upPriceMin?: number;
    upPriceMax?: number;
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

    // Fetch LIVE midpoint from CLOB instead of using stale Gamma API price
    let liveMidpoint: number | null = null;
    try {
      const midResp = await fetch(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (midResp.ok) {
        const midData: any = await midResp.json();
        const mid = parseFloat(midData?.mid ?? '0');
        if (!isNaN(mid) && mid > 0 && mid < 1) {
          liveMidpoint = mid;
        }
      }
    } catch (midErr: any) {
      logger.warn(`[updown] Failed to fetch live midpoint for ${tokenId}: ${midErr?.message}`);
    }

    const triggerPrice = liveMidpoint ?? (strategy.direction === 'up' ? market.upPrice : market.downPrice);

    // ── CRITICAL: Verify live CLOB price is within configured range ──
    // The Gamma API price that passed the initial range check can be stale.
    // Re-check against the LIVE midpoint to prevent trades at wrong prices.
    if (strategy.upPriceMin != null && strategy.upPriceMax != null) {
      if (triggerPrice < strategy.upPriceMin || triggerPrice > strategy.upPriceMax) {
        logger.warn(
          `[updown] BLOCKED: live price ${triggerPrice.toFixed(4)} outside range ` +
          `[${strategy.upPriceMin.toFixed(2)}–${strategy.upPriceMax.toFixed(2)}] ` +
          `for strategy ${strategy.id} (${strategy.coin} ${strategy.direction})`
        );
        return { success: false, errorMsg: `live price ${(triggerPrice * 100).toFixed(1)}¢ outside range` };
      }
    }

    let orderResp: any;

    if (strategy.orderType === 'limit' && strategy.limitPrice != null) {
      if (strategy.limitPrice <= 0) {
        return { success: false, errorMsg: 'invalid limit price' };
      }
      // Limit order
      const rawSize = Math.floor((tradeAmount / strategy.limitPrice) * 100) / 100;
      if (rawSize <= 0) {
        return { success: false, errorMsg: 'Trade amount too small for this limit price' };
      }
      const size = String(rawSize);
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
      // "Market" order → actually place a limit order at midpoint + slippage
      // This prevents filling at terrible prices in thin orderbooks
      const slippageFactor = 1 + (strategy.slippage / 100);
      const maxPrice = Math.min(parseFloat((triggerPrice * slippageFactor).toFixed(4)), 0.99);
      const rawSize = Math.floor((tradeAmount / maxPrice) * 100) / 100;

      if (rawSize <= 0) {
        return { success: false, errorMsg: 'Trade amount too small for current price' };
      }

      logger.info(`[updown] Placing slippage-protected order: mid=${triggerPrice} maxPrice=${maxPrice} slippage=${strategy.slippage}% size=${rawSize}`);

      orderResp = await predexonPlaceOrder(predexonUserId, {
        venue: 'polymarket',
        tokenId,
        side: 'buy',
        type: 'limit',
        price: String(maxPrice),
        size: String(rawSize),
      });

      if (!orderResp.orderId) {
        const errMsg = orderResp.error || orderResp.message || 'order rejected';
        return { success: false, errorMsg: errMsg };
      }

      // Auto-cancel after 30s if not filled (don't let it sit forever)
      scheduleLimitTtl(predexonUserId, orderResp.orderId, 30, strategy.id);
    }

    // Get round open price for context
    let roundStartPrice: number | null = null;
    try {
      roundStartPrice = await getRoundOpenPrice(strategy.coin, market.conditionId, market.startDate);
    } catch { /* non-critical */ }

    // Poll the actual fill price from the API
    // All orders are now limit orders (market orders converted to slippage-protected limits)
    let actualFillPrice: number | null = null;
    let actualSizeMatched: string | null = null;
    const fillResult = await pollActualFillPrice(predexonUserId, orderResp.orderId);
    actualFillPrice = fillResult.price;
    actualSizeMatched = fillResult.sizeMatched;
    if (actualFillPrice) {
      logger.info(`[updown] Order ${orderResp.orderId} fill: price=${actualFillPrice} size=${actualSizeMatched} (mid was ${triggerPrice})`);
    } else {
      // DO NOT fall back to triggerPrice — it can be stale and corrupts TP/SL calculations.
      // Leave fillPrice null; the scheduleLimitTtl check interval will update it when filled.
      logger.warn(`[updown] Order ${orderResp.orderId} not yet filled after polling (may still fill via limit TTL check)`);
    }

    // Determine initial status: filled if we got a fill price, otherwise open (limit pending)
    const initialStatus = actualFillPrice ? 'filled' : 'open';

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
        fillPrice: actualFillPrice,
        orderId: orderResp.orderId,
        status: initialStatus,
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
      fillPrice: actualFillPrice ?? undefined,
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
        // Update DB — use order.price if valid, otherwise try sizeMatched-based calc,
        // and fall back to the strategy's limitPrice to ensure fillPrice is never null
        let fillPrice: number | null = null;
        const rawPrice = parseFloat(order.price ?? '0');
        if (!isNaN(rawPrice) && rawPrice > 0) {
          fillPrice = rawPrice;
        } else {
          // Fallback 1: strategy's limitPrice (for explicit limit orders)
          // Fallback 2: trade's triggerPrice (for market orders that have no limitPrice)
          const trade = await prisma.upDownTrade.findFirst({
            where: { orderId },
            select: { triggerPrice: true, strategy: { select: { limitPrice: true } } },
          });
          if (trade?.strategy?.limitPrice != null && trade.strategy.limitPrice > 0) {
            fillPrice = trade.strategy.limitPrice;
            logger.warn(`[updown] Order ${orderId} filled with invalid price (${order.price}), using strategy limitPrice=${fillPrice}`);
          } else if (trade?.triggerPrice != null && trade.triggerPrice > 0) {
            fillPrice = trade.triggerPrice;
            logger.warn(`[updown] Order ${orderId} filled with invalid price (${order.price}), using triggerPrice=${fillPrice}`);
          } else {
            logger.warn(`[updown] Order ${orderId} filled with invalid price: ${order.price}, no fallback available`);
          }
        }
        await prisma.upDownTrade.updateMany({
          where: { orderId },
          data: { status: 'filled', fillPrice },
        });
      } else if (order.status === 'cancelled' || order.status === 'expired') {
        cleanup();
        await prisma.upDownTrade.updateMany({
          where: { orderId },
          data: { status: 'cancelled' },
        });
      }
    } catch (err: any) {
      logger.debug(`[updown] Limit fill check error for ${orderId}: ${err?.message}`);
    }
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

  for (const trade of trades) {
    if (!trade.strategy) continue;
    const strat = trade.strategy;

    // For percentage-based TP/SL we need fillPrice; for fixed-price TP/SL we don't.
    const hasFixedTp = strat.takeProfitPrice != null;
    const hasFixedSl = strat.stopLossPrice != null;
    const hasPctTp = strat.takeProfitPct != null;
    const hasPctSl = strat.stopLossPct != null;
    const hasTp = hasFixedTp || hasPctTp;
    const hasSl = hasFixedSl || hasPctSl;
    if (!hasTp && !hasSl) continue;

    // If ONLY percentage-based TP/SL is configured and fillPrice is missing, skip
    if (trade.fillPrice == null && !hasFixedTp && !hasFixedSl) continue;

    // Prevent race condition: if another tick is already processing this trade's TP/SL, skip it
    const tpSlLockKey = `updown:tpsl_lock:${trade.id}`;
    const alreadyProcessing = await redisCache.get<number>(tpSlLockKey);
    if (alreadyProcessing) continue;

    // Get current LIVE price from CLOB midpoint (never use stale Gamma API prices for TP/SL)
    try {
      if (!trade.tokenId) {
        logger.warn(`[updown] TP/SL: no tokenId for trade ${trade.id}, cannot fetch midpoint`);
        continue;
      }

      let currentPrice: number;
      try {
        const midResp = await fetch(`https://clob.polymarket.com/midpoint?token_id=${trade.tokenId}`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!midResp.ok) {
          // Track consecutive midpoint failures — market may no longer exist
          const mid404Key = `updown:tpsl_mid404:${trade.id}`;
          const mid404Count = ((await redisCache.get<number>(mid404Key)) ?? 0) + 1;
          await redisCache.set(mid404Key, mid404Count, 3600);
          if (mid404Count >= 20) {
            // 20 consecutive failures (~100s) — mark trade as failed, stop retrying
            await prisma.upDownTrade.update({
              where: { id: trade.id },
              data: { tpSlStatus: 'tp_triggered_failed' },
            });
            await redisCache.del(mid404Key);
            logger.warn(`[updown] TP/SL: midpoint 404 x${mid404Count} for trade ${trade.id}, market likely resolved — marking failed`);
          } else {
            logger.warn(`[updown] TP/SL: midpoint API returned ${midResp.status} for trade ${trade.id} (${mid404Count}/20)`);
          }
          continue;
        }
        const midData: any = await midResp.json();
        const mid = parseFloat(midData?.mid ?? '0');
        if (isNaN(mid) || mid <= 0) {
          logger.warn(`[updown] TP/SL: invalid midpoint for trade ${trade.id}: ${midData?.mid}`);
          continue;
        }
        currentPrice = mid;
      } catch (midErr: any) {
        logger.warn(`[updown] TP/SL: failed to fetch CLOB midpoint for trade ${trade.id}: ${midErr?.message}`);
        continue;
      }

      // TP check — fixed price first, then percentage (percentage requires fillPrice)
      let tpTriggered = false;
      if (hasFixedTp && currentPrice >= strat.takeProfitPrice!) {
        tpTriggered = true;
      } else if (hasPctTp && trade.fillPrice != null) {
        const target = trade.fillPrice + (trade.fillPrice * strat.takeProfitPct! / 100);
        if (currentPrice >= target) tpTriggered = true;
      }

      // SL check — fixed price first, then percentage (percentage requires fillPrice)
      let slTriggered = false;
      if (hasFixedSl && currentPrice <= strat.stopLossPrice!) {
        slTriggered = true;
      } else if (hasPctSl && trade.fillPrice != null) {
        const target = trade.fillPrice - (trade.fillPrice * strat.stopLossPct! / 100);
        if (currentPrice <= target) slTriggered = true;
      }

      if (!tpTriggered && !slTriggered) continue;

      if (tpTriggered && slTriggered) {
        logger.info(`[updown] Trade ${trade.id}: both TP and SL triggered at price ${currentPrice}, using TP`);
      }

      const tpSlStatus = tpTriggered ? 'tp_triggered' : 'sl_triggered';

      // Retry counter — give up after 5 failed attempts
      const retryKey = `updown:tpsl_retry:${trade.id}`;
      const retryCount = (await redisCache.get<number>(retryKey)) ?? 0;
      const MAX_TPSL_RETRIES = 5;

      if (retryCount >= MAX_TPSL_RETRIES) {
        logger.warn(`[updown] TP/SL: max retries (${MAX_TPSL_RETRIES}) reached for trade ${trade.id}, giving up`);
        await prisma.upDownTrade.update({
          where: { id: trade.id },
          data: { tpSlStatus: `${tpSlStatus}_failed` },
        });
        await redisCache.del(retryKey);
        if (strat.notificationsEnabled) {
          const label = tpTriggered ? 'Take Profit' : 'Stop Loss';
          sendNotification({
            chatId: trade.user.telegramId,
            text:
              `⚠️ <b>AutoPilot ${label} Failed</b>\n\n` +
              `${coinEmoji(trade.coin)} ${trade.coin} ${trade.direction.toUpperCase()}\n` +
              `Could not execute sell after ${MAX_TPSL_RETRIES} attempts.\n` +
              `The position remains open — please sell manually.`,
          });
        }
        continue;
      }

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
        // Query actual position size from Predexon API instead of computing from fillPrice.
        // This avoids selling more shares than actually held (which caused SafeMath overflow).
        let sellSize = '0';
        try {
          const positions = await getPositions(trade.user.predexonUserId, 'polymarket');
          const pos = positions.find(p => p.tokenId === trade.tokenId && p.status === 'active');
          if (pos && parseFloat(pos.size) > 0) {
            // Floor to 2 decimals to avoid exceeding actual holdings
            sellSize = String(Math.floor(parseFloat(pos.size) * 100) / 100);
            logger.info(`[updown] TP/SL: actual position size=${pos.size}, selling ${sellSize} for trade ${trade.id}`);
          }
        } catch (posErr: any) {
          logger.warn(`[updown] TP/SL: failed to fetch positions for trade ${trade.id}: ${posErr?.message}`);
        }

        // Fallback: if positions API fails, compute from fillPrice with 5% safety buffer
        if (sellSize === '0' && trade.fillPrice != null && trade.fillPrice > 0) {
          const safetyBuffer = 0.95;
          sellSize = String(Math.floor((trade.amount / trade.fillPrice) * safetyBuffer * 100) / 100);
          logger.warn(`[updown] TP/SL: using fallback sell size=${sellSize} for trade ${trade.id} (fillPrice=${trade.fillPrice})`);
        }

        if (sellSize === '0') {
          logger.warn(`[updown] TP/SL: invalid sell size for trade ${trade.id} (fillPrice=${trade.fillPrice})`);
          await redisCache.del(tpSlLockKey); // Release lock so next tick can retry
          await redisCache.set(retryKey, retryCount + 1, 3600);
          continue;
        }

        // Use slippage-protected limit sell (same pattern as buy orders).
        // Sell at currentPrice minus slippage — prevents filling at terrible bids.
        const sellSlippage = strat.slippage ?? 5;
        const slippageFactor = 1 - (sellSlippage / 100);
        const minSellPrice = Math.max(parseFloat((currentPrice * slippageFactor).toFixed(4)), 0.01);
        logger.info(`[updown] TP/SL sell: mid=${currentPrice} minPrice=${minSellPrice} slippage=${sellSlippage}% size=${sellSize}`);

        const sellResp = await predexonPlaceOrder(trade.user.predexonUserId, {
          venue: 'polymarket',
          tokenId: trade.tokenId,
          side: 'sell',
          type: 'limit',
          price: String(minSellPrice),
          size: sellSize,
        });

        if (!sellResp.orderId) {
          logger.warn(`[updown] TP/SL sell order rejected for trade ${trade.id}: ${sellResp.error || sellResp.message || 'no orderId'}`);
          await redisCache.del(tpSlLockKey);
          await redisCache.set(retryKey, retryCount + 1, 3600);
          continue;
        }

        // Track when the TP/SL sell was placed for stale order detection.
        // Do NOT use scheduleLimitTtl — it queries by the orderId column (the original BUY
        // order) and cannot detect fill/cancel of the TP/SL sell stored in tpSlOrderId.
        // monitorPendingTpSlSells() handles fill/cancel/stale detection instead.
        await redisCache.set(`updown:tpsl_sell_at:${trade.id}`, Date.now(), 600);

        await prisma.upDownTrade.update({
          where: { id: trade.id },
          data: {
            tpSlStatus,
            tpSlOrderId: sellResp.orderId || null,
          },
        });
        // Don't clear retry counter yet — monitorPendingTpSlSells clears it on confirmed fill
      } catch (err: any) {
        logger.warn(`[updown] TP/SL sell failed for trade ${trade.id} (attempt ${retryCount + 1}/${MAX_TPSL_RETRIES}): ${err?.message}`);
        await redisCache.del(tpSlLockKey); // Release lock so next tick can retry
        await redisCache.set(retryKey, retryCount + 1, 3600);

        // Notify user on first failure so they're aware
        if (retryCount === 0 && strat.notificationsEnabled) {
          const label = tpTriggered ? 'Take Profit' : 'Stop Loss';
          sendNotification({
            chatId: trade.user.telegramId,
            text:
              `⚠️ <b>AutoPilot ${label} Sell Retry</b>\n\n` +
              `${coinEmoji(trade.coin)} ${trade.coin} ${trade.direction.toUpperCase()}\n` +
              `Sell order failed, retrying... (${err?.message?.slice(0, 80) ?? 'unknown'})`,
          });
        }
        continue;
      }

      // Notification
      if (strat.notificationsEnabled) {
        const emoji = tpTriggered ? '🏆' : '🛑';
        const label = tpTriggered ? 'Take Profit' : 'Stop Loss';
        sendNotification({
          chatId: trade.user.telegramId,
          text:
            `${emoji} <b>AutoPilot ${label} Triggered</b>\n\n` +
            `${coinEmoji(trade.coin)} ${trade.coin} ${trade.direction.toUpperCase()}\n` +
            `Entry: ${trade.fillPrice?.toFixed(2) ?? '?'} → Exit: ${currentPrice.toFixed(2)}\n` +
            `Amount: $${trade.amount.toFixed(2)}`,
        });
      }
    } catch (err: any) {
      logger.warn(`[updown] TP/SL check error for trade ${trade.id}: ${err?.message}`);
      // Release the lock if it was acquired so the next tick can retry
      if (tpSlLockKey) await redisCache.del(tpSlLockKey).catch(() => {});
    }
  }
}

// ─── TP/SL Sell Order Monitor ──────────────────────────────────────────────
// Watches TP/SL sell orders that were placed but may not have filled.
// - Filled    → clean up (success)
// - Cancelled → reset tpSlStatus to null so checkUpDownTpSl retries
// - Stale >90s → cancel stale order and reset for retry at fresh price

async function monitorPendingTpSlSells(sendNotification: SendNotificationFn): Promise<void> {
  const pendingTrades = await prisma.upDownTrade.findMany({
    where: {
      tpSlStatus: { in: ['tp_triggered', 'sl_triggered'] },
      tpSlOrderId: { not: null },
    },
    include: {
      strategy: true,
      user: { select: { telegramId: true, predexonUserId: true } },
    },
  });

  for (const trade of pendingTrades) {
    if (!trade.tpSlOrderId || !trade.user.predexonUserId) continue;

    try {
      const order = await getOrder(trade.user.predexonUserId, trade.tpSlOrderId);

      if (order.status === 'filled') {
        // Sell filled — clean up
        await redisCache.del(`updown:tpsl_retry:${trade.id}`);
        await redisCache.del(`updown:tpsl_sell_at:${trade.id}`);
        logger.info(`[updown] TP/SL sell confirmed filled for trade ${trade.id}`);
        continue;
      }

      if (order.status === 'cancelled' || order.status === 'expired') {
        // Sell was cancelled/expired — reset for retry
        const retryKey = `updown:tpsl_retry:${trade.id}`;
        const retryCount = (await redisCache.get<number>(retryKey)) ?? 0;
        await redisCache.set(retryKey, retryCount + 1, 3600);

        await prisma.upDownTrade.update({
          where: { id: trade.id },
          data: { tpSlStatus: null, tpSlOrderId: null },
        });
        await redisCache.del(`updown:tpsl_sell_at:${trade.id}`);
        logger.info(`[updown] TP/SL sell cancelled/expired for trade ${trade.id}, reset for retry (attempt ${retryCount + 1})`);
        continue;
      }

      // Order still open — check age and cancel if stale
      const sellTime = await redisCache.get<number>(`updown:tpsl_sell_at:${trade.id}`);
      const age = sellTime ? Date.now() - sellTime : 120_000; // default 2min if timestamp unknown

      if (age > 90_000) {
        // Stale sell order (>90s) — cancel and retry at fresh price
        try {
          await cancelOrder(trade.user.predexonUserId, trade.tpSlOrderId);
        } catch { /* order may already be gone */ }

        const retryKey = `updown:tpsl_retry:${trade.id}`;
        const retryCount = (await redisCache.get<number>(retryKey)) ?? 0;
        await redisCache.set(retryKey, retryCount + 1, 3600);

        await prisma.upDownTrade.update({
          where: { id: trade.id },
          data: { tpSlStatus: null, tpSlOrderId: null },
        });
        await redisCache.del(`updown:tpsl_sell_at:${trade.id}`);
        logger.info(`[updown] TP/SL sell stale (${Math.round(age / 1000)}s), cancelled for retry (attempt ${retryCount + 1}) trade ${trade.id}`);
      }
    } catch (err: any) {
      // 404 = order no longer exists on Predexon — treat like cancelled/expired
      if (err?.message?.includes('404')) {
        const retryKey = `updown:tpsl_retry:${trade.id}`;
        const retryCount = (await redisCache.get<number>(retryKey)) ?? 0;

        if (retryCount >= 5) {
          const failStatus = trade.tpSlStatus === 'tp_triggered' ? 'tp_triggered_failed' : 'sl_triggered_failed';
          await prisma.upDownTrade.update({
            where: { id: trade.id },
            data: { tpSlStatus: failStatus, tpSlOrderId: null },
          });
          await redisCache.del(retryKey);
          await redisCache.del(`updown:tpsl_sell_at:${trade.id}`);
          logger.warn(`[updown] TP/SL sell order 404: max retries reached for trade ${trade.id}, marking as failed`);
        } else {
          await redisCache.set(retryKey, retryCount + 1, 3600);
          await prisma.upDownTrade.update({
            where: { id: trade.id },
            data: { tpSlStatus: null, tpSlOrderId: null },
          });
          await redisCache.del(`updown:tpsl_sell_at:${trade.id}`);
          logger.info(`[updown] TP/SL sell order 404: reset for retry (attempt ${retryCount + 1}/5) trade ${trade.id}`);
        }
      } else {
        logger.warn(`[updown] TP/SL sell monitor error for trade ${trade.id}: ${err?.message}`);
      }
    }
  }
}

// ─── Auto-Claim Resolved Positions ──────────────────────────────────────────

let _redeemRunning = false;

async function checkUpDownResolutions(sendNotification: SendNotificationFn): Promise<void> {
  if (_redeemRunning) return;
  _redeemRunning = true;
  try {
    await checkUpDownResolutionsInner(sendNotification);
  } finally {
    _redeemRunning = false;
  }
}

async function checkUpDownResolutionsInner(sendNotification: SendNotificationFn): Promise<void> {
  // Find filled trades with no tpSlStatus (haven't been exited or redeemed yet)
  const trades = await prisma.upDownTrade.findMany({
    where: {
      status: 'filled',
      tpSlStatus: null,
    },
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
      strategy: { select: { notificationsEnabled: true, label: true } },
    },
  });

  if (trades.length === 0) return;

  // Group by proxy address (1 Data API call per user)
  const byProxy = new Map<string, typeof trades>();
  for (const trade of trades) {
    if (!trade.user.polymarketProxyAddress) continue;
    const key = trade.user.polymarketProxyAddress.toLowerCase();
    if (!byProxy.has(key)) byProxy.set(key, []);
    byProxy.get(key)!.push(trade);
  }

  for (const [proxyAddress, userTrades] of byProxy) {
    try {
      const positions = await getActivePositions(proxyAddress);

      for (const trade of userTrades) {
        const pos = positions.find(p =>
          p.conditionId === trade.conditionId && p.redeemable
        );
        if (!pos) continue;

        // Prevent double-processing
        const lockKey = `updown:redeem_lock:${trade.id}`;
        const locked = await redisCache.get<number>(lockKey);
        if (locked) continue;
        await redisCache.set(lockKey, 1, 120);

        try {
          const result = await manualRedeem(
            trade.user.encryptedPrivateKey,
            trade.user.polymarketProxyAddress!,
            pos,
            trade.user.predexonUserId ?? undefined,
          );

          if (result.success) {
            await prisma.upDownTrade.update({
              where: { id: trade.id },
              data: { tpSlStatus: 'redeemed' },
            });
            logger.info(`[updown] Auto-claimed resolved trade ${trade.id}: ${trade.question.slice(0, 50)}`);

            const notify = trade.strategy?.notificationsEnabled ?? true;
            if (notify) {
              sendNotification({
                chatId: trade.user.telegramId,
                text:
                  `✅ <b>AutoPilot Position Claimed</b>\n\n` +
                  `${coinEmoji(trade.coin)} ${trade.coin} ${trade.direction.toUpperCase()}\n` +
                  `📊 ${trade.question.slice(0, 100)}\n` +
                  `💵 $${trade.amount.toFixed(2)} → USDC returned to wallet`,
              });
            }
          } else {
            logger.warn(`[updown] Auto-redeem failed for trade ${trade.id}: ${result.error}`);
            await redisCache.del(lockKey);
          }
        } catch (err: any) {
          logger.warn(`[updown] Auto-redeem error for trade ${trade.id}: ${err?.message}`);
          await redisCache.del(lockKey);
        }

        // Delay between redemptions to avoid rate limiting
        await new Promise(r => setTimeout(r, 3_000));
      }
    } catch (err: any) {
      logger.warn(`[updown] Resolution check error for proxy ${proxyAddress.slice(0, 10)}: ${err?.message}`);
    }
  }
}

// ─── Main Monitor ───────────────────────────────────────────────────────────

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let tpSlInterval: ReturnType<typeof setInterval> | null = null;
let redeemInterval: ReturnType<typeof setInterval> | null = null;
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

  // TP/SL check every 15s (also monitors pending sell orders)
  tpSlInterval = setInterval(() => {
    checkUpDownTpSl(sendNotification).catch(err =>
      logger.error(`[updown] TP/SL check error: ${err?.message}`)
    );
    monitorPendingTpSlSells(sendNotification).catch(err =>
      logger.error(`[updown] TP/SL sell monitor error: ${err?.message}`)
    );
  }, 15_000);

  // Auto-claim resolved positions every 2 minutes
  redeemInterval = setInterval(() => {
    checkUpDownResolutions(sendNotification).catch(err =>
      logger.error(`[updown] Resolution check error: ${err?.message}`)
    );
  }, 120_000);

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
        let fillPrice: number | null = null;
        const rawPrice = parseFloat(order.price ?? '0');
        if (!isNaN(rawPrice) && rawPrice > 0) {
          fillPrice = rawPrice;
        } else {
          // Fallback 1: strategy's limitPrice; Fallback 2: trade's triggerPrice
          const strat = trade.strategyId ? await prisma.upDownStrategy.findUnique({ where: { id: trade.strategyId }, select: { limitPrice: true } }) : null;
          if (strat?.limitPrice != null && strat.limitPrice > 0) {
            fillPrice = strat.limitPrice;
            logger.warn(`[updown] Orphaned order ${trade.orderId} filled with invalid price (${order.price}), using strategy limitPrice=${fillPrice}`);
          } else if (trade.triggerPrice != null && trade.triggerPrice > 0) {
            fillPrice = trade.triggerPrice;
            logger.warn(`[updown] Orphaned order ${trade.orderId} filled with invalid price (${order.price}), using triggerPrice=${fillPrice}`);
          }
        }
        await prisma.upDownTrade.update({
          where: { id: trade.id },
          data: { status: 'filled', fillPrice },
        });
        logger.info(`[updown] Orphaned order ${trade.orderId} was actually filled at ${fillPrice}`);
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
  if (redeemInterval) {
    clearInterval(redeemInterval);
    redeemInterval = null;
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

/** Get remaining seconds until market end */
function getRemainingSeconds(market: UpDownMarket): number {
  const endMs = new Date(market.endDate).getTime();
  return Math.max(0, Math.floor((endMs - Date.now()) / 1000));
}

/** Resolve directions to execute based on strategy direction mode.
 *  priceMin/priceMax represent the "chosen side" price range the user configured.
 */
function getDirections(direction: string, upPrice: number, priceMin: number, priceMax: number): string[] {
  const downPrice = 1 - upPrice;
  switch (direction) {
    case 'up': return ['up'];
    case 'down': return ['down'];
    case 'both': {
      // Only include sides whose price is in range
      const dirs: string[] = [];
      if (upPrice >= priceMin && upPrice <= priceMax) dirs.push('up');
      if (downPrice >= priceMin && downPrice <= priceMax) dirs.push('down');
      return dirs;
    }
    case 'either': {
      // Pick whichever side is in range; return empty if neither qualifies
      if (upPrice >= priceMin && upPrice <= priceMax) return ['up'];
      if (downPrice >= priceMin && downPrice <= priceMax) return ['down'];
      return [];
    }
    default: return ['up'];
  }
}

async function processStrategy(
  strat: any,
  markets: UpDownMarket[],
  sendNotification: SendNotificationFn,
): Promise<void> {
  // 1. Max rounds check
  if (strat.roundsExecuted >= strat.maxRounds) {
    await prisma.upDownStrategy.update({
      where: { id: strat.id },
      data: { isPaused: true },
    });
    if (strat.notificationsEnabled) {
      sendNotification({
        chatId: strat.user.telegramId,
        text:
          `⏹ <b>AutoPilot Strategy Paused</b>\n\n` +
          `${coinEmoji(strat.coin)} ${strat.label || strat.coin} reached max rounds (${strat.maxRounds}).\n` +
          `Strategy has been auto-paused.`,
      });
    }
    return;
  }

  // Parse multi-values
  const coins: string[] = strat.coins ? strat.coins.split(',') : [strat.coin];
  const timeframes: string[] = strat.timeframes ? strat.timeframes.split(',') : [strat.timeframe];

  for (const coin of coins) {
    for (const tf of timeframes) {
      // 2. Find matching market
      const market = findMatchingMarket(coin, tf, markets);
      if (!market) continue;

      // 3. Dedup — already traded this round?
      const dedupKey = `updown:dedup:${strat.id}:${market.conditionId}`;
      const alreadyTraded = await redisCache.get<number>(dedupKey);
      if (alreadyTraded) continue;

      // 4. Entry window check (new: entryWindowSecs)
      if (strat.entryWindowSecs != null) {
        const remaining = getRemainingSeconds(market);
        if (remaining > strat.entryWindowSecs) continue;
      } else {
        // Legacy: use timeRangeStart/End
        const elapsed = elapsedSeconds(market.startDate);
        if (elapsed < 0) continue;
        const startSec = parseTimeToSeconds(strat.timeRangeStart);
        const endSec = parseTimeToSeconds(strat.timeRangeEnd);
        if (elapsed < startSec || elapsed > endSec) continue;
      }

      // 5. Price range check — fetch LIVE CLOB midpoints instead of stale Gamma API prices.
      //    Gamma API prices can be significantly outdated, causing trades outside the user's range.
      let liveUpPrice = market.upPrice;
      let liveDownPrice = market.downPrice;
      try {
        const upMidResp = await fetch(`https://clob.polymarket.com/midpoint?token_id=${market.upTokenId}`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (upMidResp.ok) {
          const upMidData: any = await upMidResp.json();
          const mid = parseFloat(upMidData?.mid ?? '0');
          if (!isNaN(mid) && mid > 0 && mid < 1) {
            liveUpPrice = mid;
            liveDownPrice = 1 - mid;
          }
        }
      } catch (midErr: any) {
        logger.debug(`[updown] Failed to fetch live midpoint for range check (${coin}/${tf}): ${midErr?.message}`);
        // Fall back to Gamma API prices — still better than skipping the trade
      }

      if (strat.direction === 'down') {
        // User configured range for DOWN side
        if (liveDownPrice < strat.upPriceMin || liveDownPrice > strat.upPriceMax) continue;
      } else if (strat.direction === 'both' || strat.direction === 'either') {
        // Pass if EITHER side is in range (getDirections will pick the right one)
        const upInRange = liveUpPrice >= strat.upPriceMin && liveUpPrice <= strat.upPriceMax;
        const downInRange = liveDownPrice >= strat.upPriceMin && liveDownPrice <= strat.upPriceMax;
        if (!upInRange && !downInRange) continue;
      } else {
        // 'up' or default — check UP price
        if (liveUpPrice < strat.upPriceMin || liveUpPrice > strat.upPriceMax) continue;
      }

      // 6. Spot price change check (legacy filters)
      if (strat.priceChangeMin > -9999 || strat.priceChangeMax < 9999) {
        try {
          const currentSpot = await fetchSpotPrice(coin);
          const openSpot = await getRoundOpenPrice(coin, market.conditionId, market.startDate);
          const delta = currentSpot - openSpot;
          if (delta < strat.priceChangeMin || delta > strat.priceChangeMax) continue;
        } catch {
          continue;
        }
      }

      // All triggers passed — determine directions
      const directions = getDirections(strat.direction, liveUpPrice, strat.upPriceMin, strat.upPriceMax);

      for (const dir of directions) {
        const dirDedupKey = `updown:dedup:${strat.id}:${market.conditionId}:${dir}`;
        const alreadyDir = await redisCache.get<number>(dirDedupKey);
        if (alreadyDir) continue;

        logger.info(`[updown] Strategy ${strat.id} triggered on ${market.conditionId} [${coin}/${tf}/${dir}]`);

        // Set dedup BEFORE execution
        await redisCache.set(dedupKey, 1, 1200); // 20min
        await redisCache.set(dirDedupKey, 1, 1200);

        // Build a strategy-like object with the current direction for execution
        const execStrat = { ...strat, coin, direction: dir };

        const result = await executeUpDownOrder(
          strat.user,
          market,
          execStrat,
          sendNotification,
        );

        // Handle failure
        if (!result.success) {
          const msg = (result.errorMsg ?? '').toLowerCase();
          const isFatalForRound =
            msg.includes('not enough balance') ||
            msg.includes('insufficient') ||
            msg.includes('balance too low') ||
            msg.includes('no proxy address') ||
            msg.includes('trade amount too small');

          if (isFatalForRound) {
            const failCountKey = `updown:balance_fail:${strat.id}`;
            const prevFails = (await redisCache.get<number>(failCountKey)) ?? 0;
            const failCount = prevFails + 1;
            await redisCache.set(failCountKey, failCount, 3600);

            if (failCount >= 3) {
              await prisma.upDownStrategy.update({
                where: { id: strat.id },
                data: { isPaused: true },
              });
              await redisCache.del(failCountKey);
              logger.warn(`[updown] Strategy ${strat.id} auto-paused after ${failCount} consecutive balance failures`);
              if (strat.notificationsEnabled) {
                sendNotification({
                  chatId: strat.user.telegramId,
                  text:
                    `⏸ <b>AutoPilot Strategy Auto-Paused</b>\n\n` +
                    `${coinEmoji(coin)} ${strat.label || coin}\n` +
                    `Reason: Insufficient balance (${failCount} consecutive failures)\n\n` +
                    `Deposit funds and resume the strategy manually.`,
                });
              }
              return; // Stop processing this strategy entirely
            }
            logger.warn(`[updown] Strategy ${strat.id} balance failure ${failCount}/3, skipping rest of round`);
          } else {
            await redisCache.del(dedupKey);
            await redisCache.del(dirDedupKey);
          }
        } else {
          // Success — reset failure counter
          const failCountKey = `updown:balance_fail:${strat.id}`;
          await redisCache.del(failCountKey);
        }

        // Send notification
        if (strat.notificationsEnabled) {
          if (result.success) {
            const dirLabel = dir === 'up' ? '🟢 UP' : '🔴 DOWN';
            const orderStr = strat.orderType === 'limit'
              ? `Limit @ ${strat.limitPrice}`
              : 'Market';
            sendNotification({
              chatId: strat.user.telegramId,
              text:
                `✅ <b>AutoPilot Trade Executed</b>\n\n` +
                `${coinEmoji(coin)} ${coin} ${tf}\n` +
                `Direction: ${dirLabel} · ${orderStr}\n` +
                `Amount: $${result.actualAmount?.toFixed(2) ?? strat.amount.toFixed(2)}\n` +
                `Round: ${strat.roundsExecuted + 1}/${strat.maxRounds}`,
            });
          } else {
            sendNotification({
              chatId: strat.user.telegramId,
              text:
                `❌ <b>AutoPilot Trade Failed</b>\n\n` +
                `${coinEmoji(coin)} ${coin} ${tf}\n` +
                `Error: ${result.errorMsg?.slice(0, 100) ?? 'unknown'}`,
            });
          }
        }
      }
    }
  }
}
