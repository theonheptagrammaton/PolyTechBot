/**
 * Internal Stop Loss Monitor
 *
 * Instead of placing a limit-sell order (which fills immediately on the CLOB
 * because sell-limit < best-bid), SLs are stored in Redis and a 10-second
 * polling loop checks midpoint prices. When price <= trigger, a market sell
 * is executed via Predexon.
 */

import { redisCache, getRedisClient } from '../database/redis';
import { logger } from '../utils/logger';

const CLOB_MIDPOINTS_URL = 'https://clob.polymarket.com/midpoints';
const SL_INDEX_KEY = 'pos:sl:index';
const SL_PREFIX = 'pos:sl:';
const SL_TTL = 30 * 24 * 3600; // 30 days

// ── Types ────────────��───────────────────────────────���───────────────────────

export interface PendingStopLoss {
  telegramId: string;
  assetId: string;
  conditionId: string;
  negRisk: boolean;
  outcome: string;
  title: string;
  triggerPrice: number; // decimal 0–1
  shares: number;
  createdAt: number;
  retries: number;
}

type SendNotificationFn = (
  chatId: string,
  text: string,
  opts?: { buttons?: any[] },
) => void;

// ── Redis helpers ────────────────────────────────────────��───────────────────

function slKey(telegramId: string, assetId: string): string {
  return `${SL_PREFIX}${telegramId}:${assetId}`;
}

export async function addStopLoss(sl: PendingStopLoss): Promise<void> {
  const key = slKey(sl.telegramId, sl.assetId);
  await redisCache.set(key, sl, SL_TTL);
  await getRedisClient().sadd(SL_INDEX_KEY, `${sl.telegramId}:${sl.assetId}`);
}

export async function removeStopLoss(telegramId: string, assetId: string): Promise<void> {
  const key = slKey(telegramId, assetId);
  await redisCache.del(key);
  await getRedisClient().srem(SL_INDEX_KEY, `${telegramId}:${assetId}`);
}

export async function getStopLoss(telegramId: string, assetId: string): Promise<PendingStopLoss | null> {
  return redisCache.get<PendingStopLoss>(slKey(telegramId, assetId));
}

export async function getUserStopLosses(telegramId: string): Promise<PendingStopLoss[]> {
  const members = await getRedisClient().smembers(SL_INDEX_KEY);
  const prefix = `${telegramId}:`;
  const userMembers = members.filter((m) => m.startsWith(prefix));
  const results: PendingStopLoss[] = [];
  for (const m of userMembers) {
    const sl = await redisCache.get<PendingStopLoss>(`${SL_PREFIX}${m}`);
    if (sl) results.push(sl);
  }
  return results;
}

// ── Monitor ───────────────���───────────────────────────────���──────────────────

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let _sendNotification: SendNotificationFn | null = null;

const MAX_RETRIES = 10;

async function tick(): Promise<void> {
  try {
    const redis = getRedisClient();
    const members = await redis.smembers(SL_INDEX_KEY);
    if (members.length === 0) {
      logger.debug('[stopLoss] No active stop losses to check');
      return;
    }

    // Load all SLs, prune stale index entries
    const sls: PendingStopLoss[] = [];
    const staleMembers: string[] = [];
    for (const m of members) {
      const sl = await redisCache.get<PendingStopLoss>(`${SL_PREFIX}${m}`);
      if (sl) {
        sls.push(sl);
      } else {
        staleMembers.push(m);
      }
    }
    if (staleMembers.length > 0) {
      await redis.srem(SL_INDEX_KEY, ...staleMembers);
    }
    if (sls.length === 0) return;

    // Fetch midpoints for all unique tokens
    const uniqueTokens = [...new Set(sls.map((s) => s.assetId))];
    let midpoints: Record<string, string> = {};
    try {
      const url = `${CLOB_MIDPOINTS_URL}?token_ids=${uniqueTokens.join(',')}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!resp.ok) return;
      const data: any = await resp.json();
      midpoints = data && typeof data === 'object' && !data.error ? data : {};
    } catch {
      return; // retry next tick
    }

    for (const sl of sls) {
      const priceStr = midpoints[sl.assetId];
      if (priceStr == null) continue;

      const currentPrice = parseFloat(priceStr);
      if (isNaN(currentPrice) || currentPrice <= 0) continue;
      if (currentPrice > sl.triggerPrice) continue;

      // ── SL triggered ─────────────────────────────────────────────────
      const lockKey = `pos:sl:lock:${sl.telegramId}:${sl.assetId}`;
      const locked = await redisCache.get<number>(lockKey);
      if (locked != null) continue;
      await redisCache.set(lockKey, 1, 60);

      logger.info(
        `[stopLoss] TRIGGERED: user=${sl.telegramId} asset=${sl.assetId.substring(0, 16)}... ` +
          `trigger=${sl.triggerPrice.toFixed(4)} current=${currentPrice.toFixed(4)}`,
      );

      try {
        const { getUserByTelegramId, ensurePredexonUser } = await import('./user');
        const { placeOrder: predexonPlaceOrder } = await import('./predexon');
        const { transferCommission, COMMISSION_RATE } = await import('./commission');

        const user = await getUserByTelegramId(sl.telegramId);
        if (!user?.polymarketProxyAddress) {
          await removeStopLoss(sl.telegramId, sl.assetId);
          continue;
        }

        const predexonUserId = await ensurePredexonUser(user);

        // Fetch actual position size from Predexon API instead of using stale sl.shares.
        // If user partially sold since SL was created, sl.shares would be too large
        // and the sell order would fail with "not enough balance".
        let cleanSize = 0;
        try {
          const { getPositions } = await import('./predexon');
          const positions = await getPositions(predexonUserId, 'polymarket');
          const pos = positions.find(p => p.tokenId === sl.assetId && p.status === 'active');
          if (pos && parseFloat(pos.size) > 0) {
            cleanSize = Math.floor(parseFloat(pos.size) * 100) / 100;
            logger.info(`[stopLoss] Actual position size=${pos.size}, selling ${cleanSize} (sl.shares was ${sl.shares})`);
          }
        } catch (posErr: any) {
          logger.warn(`[stopLoss] Failed to fetch actual position for ${sl.assetId}: ${posErr?.message}`);
        }

        // Fallback: use sl.shares if API failed, with 5% safety buffer
        if (cleanSize <= 0) {
          cleanSize = Math.floor(sl.shares * 0.95 * 100) / 100;
          logger.warn(`[stopLoss] Using fallback size=${cleanSize} (sl.shares=${sl.shares} × 0.95)`);
        }

        if (cleanSize <= 0) {
          await removeStopLoss(sl.telegramId, sl.assetId);
          continue;
        }

        // Polymarket CLOB only supports limit orders for sells — 'market' type is rejected.
        // Use aggressive limit price (current price minus slippage) to fill immediately.
        const slippagePct = user.slippageTolerance ?? 5.0;
        const limitSellPrice = Math.max(
          parseFloat((currentPrice * (1 - slippagePct / 100)).toFixed(4)),
          0.01,
        );
        const orderResp = await predexonPlaceOrder(predexonUserId, {
          venue: 'polymarket',
          tokenId: sl.assetId,
          side: 'sell',
          type: 'limit',
          price: String(limitSellPrice),
          size: String(cleanSize),
        });

        if (!orderResp.orderId) {
          const errMsg =
            (orderResp as any).error || (orderResp as any).message || 'Order rejected';
          throw new Error(errMsg);
        }

        // ── Verify fill — don't assume orderId means filled ──
        const { getOrder: predexonGetOrder, cancelOrder: predexonCancelOrder } = await import('./predexon');
        let slFinalStatus = orderResp.status;
        let slFilledSize = parseFloat(orderResp.sizeMatched || '0');

        if (slFinalStatus !== 'filled' && slFilledSize < cleanSize * 0.95) {
          for (let att = 1; att <= 5; att++) {
            await new Promise(r => setTimeout(r, 1500));
            try {
              const os = await predexonGetOrder(predexonUserId, orderResp.orderId);
              slFinalStatus = os.status;
              slFilledSize = parseFloat(os.sizeMatched || '0');
              if (slFinalStatus === 'filled' || slFilledSize >= cleanSize * 0.95) break;
            } catch {}
          }
        }

        // Cancel unfilled remainder
        if (slFinalStatus !== 'filled' && slFinalStatus !== 'cancelled') {
          try { await predexonCancelOrder(predexonUserId, orderResp.orderId); } catch {}
        }

        if (slFilledSize <= 0) {
          throw new Error(`Stop loss sell not filled (order ${orderResp.orderId})`);
        }

        // Commission: ONLY on actually filled amount
        const commissionUsdc = limitSellPrice * slFilledSize * COMMISSION_RATE;
        transferCommission(
          user.encryptedPrivateKey,
          user.polymarketProxyAddress!,
          commissionUsdc,
          user.id,
          user.predexonUserId ?? undefined,
        ).catch((err) => logger.warn('[stopLoss] Commission failed (non-fatal):', err));

        // Done — remove SL + lock
        await removeStopLoss(sl.telegramId, sl.assetId);
        await redisCache.del(lockKey);

        // Notify user
        const triggerCents = (sl.triggerPrice * 100).toFixed(1);
        const currentCents = (currentPrice * 100).toFixed(1);
        const esc = (s: string) =>
          s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const title =
          sl.title.length > 50 ? sl.title.substring(0, 47) + '...' : sl.title;
        const partialWarn = slFilledSize < cleanSize * 0.95
          ? `\n⚠️ Partial fill: ${slFilledSize.toFixed(2)} of ${cleanSize} shares`
          : '';

        _sendNotification?.(
          sl.telegramId,
          `🛑 <b>Stop Loss Triggered</b>\n\n` +
            `<b>${esc(sl.outcome)}</b> — ${esc(title)}\n\n` +
            `📉 Trigger: ${triggerCents}¢  →  Market: ${currentCents}¢\n` +
            `📦 Shares sold: ${slFilledSize.toFixed(2)}` + partialWarn + `\n` +
            `✅ Sell order filled`,
        );

        logger.info(
          `[stopLoss] Executed: user=${sl.telegramId} shares=${slFilledSize}/${cleanSize} orderId=${orderResp.orderId}`,
        );
      } catch (err: any) {
        logger.error(
          `[stopLoss] Failed for user ${sl.telegramId}: ${err?.message}`,
        );
        await redisCache.del(lockKey);

        // Increment retries; remove after MAX_RETRIES
        const newRetries = (sl.retries || 0) + 1;
        if (newRetries >= MAX_RETRIES) {
          await removeStopLoss(sl.telegramId, sl.assetId);
          _sendNotification?.(
            sl.telegramId,
            `🛑 <b>Stop Loss Removed</b>\n\n` +
              `<b>${sl.outcome}</b>\n` +
              `Failed ${MAX_RETRIES} times — please set it again if needed.`,
          );
        } else {
          await redisCache.set(
            slKey(sl.telegramId, sl.assetId),
            { ...sl, retries: newRetries },
            SL_TTL,
          );
        }
      }
    }
  } catch (err: any) {
    logger.error(`[stopLoss] Monitor tick error: ${err?.message}`);
  }
}

export function startStopLossMonitor(sendNotification: SendNotificationFn): void {
  if (monitorInterval) return;
  _sendNotification = sendNotification;
  monitorInterval = setInterval(tick, 10_000);
  logger.info('[stopLoss] Monitor started (10s interval)');
}

export function stopStopLossMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    logger.info('[stopLoss] Monitor stopped');
  }
}
