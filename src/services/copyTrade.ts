import { ethers } from 'ethers';
import { prisma } from '../database/prisma';
import { redisCache } from '../database/redis';
import { logger } from '../utils/logger';
import { config } from '../config';
import { getActivePositions, ActivePosition, fetchTxHashForOrder } from './portfolio';
import { transferCommission, COMMISSION_RATE } from './commission';
import { placeOrder as predexonPlaceOrder } from './predexon';
import { ensurePredexonUser } from './user';
import { createManagedWsProvider, ManagedWsProvider } from '../utils/wsProvider';

const CLOB_BASE = 'https://clob.polymarket.com';
const DATA_API_BASE = 'https://data-api.polymarket.com';
const CLOB_MIDPOINTS_URL = 'https://clob.polymarket.com/midpoints';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DetectedTrade {
  traderAddress: string;
  marketId: string;   // conditionId
  assetId: string;    // tokenId (YES/NO token)
  outcome: string;    // YES | NO
  side: string;       // BUY | SELL
  size: number;       // shares
  sizeUsd: number;    // shares * price (USDC)
  price: number;
  timestamp: number;
}

export interface NotificationExtra {
  imagePath?: string;
  buttons?: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses a Polymarket wallet address or profile URL into a normalized lowercase address.
 * Returns `{ address }` on success, `{ error }` with a user-friendly message on failure.
 */
export function parseTraderAddress(input: string): { address: string } | { error: string } {
  const trimmed = input.trim();

  // Direct 0x address
  if (/^0x[a-f0-9]{40}$/i.test(trimmed)) return { address: trimmed.toLowerCase() };

  // polymarket.com/profile/0x...
  const profileMatch = trimmed.match(/polymarket\.com\/profile\/(0x[a-f0-9]{40})/i);
  if (profileMatch) return { address: profileMatch[1].toLowerCase() };

  // polymarket.com/profile/USERNAME — username URLs can't be resolved to an address
  const usernameMatch = trimmed.match(/polymarket\.com\/profile\/([a-zA-Z0-9_.-]+)/i);
  if (usernameMatch) {
    return {
      error:
        `⚠️ Username-based profile links are not supported.\n\n` +
        `Open the trader's profile on Polymarket, find the wallet address (<code>0x...</code>), and send it here.`,
    };
  }

  return { error: '❌ Invalid address. Send a <code>0x...</code> address or a Polymarket profile URL containing the wallet address.' };
}

/**
 * Computes the copy order size in USD.
 * Returns 0 if the resulting size is below Polymarket's $1 minimum.
 */
export function computeCopySize(
  fixedAmount: number | null,
  multiplier: number | null,
  sourceSize: number,
  userBalance: number
): number {
  let target: number;

  if (fixedAmount !== null && fixedAmount > 0) {
    target = fixedAmount;
  } else {
    target = sourceSize * (multiplier ?? 1.0);
  }

  // Safety caps
  target = Math.min(target, userBalance * 0.5); // max 50% of balance
  if (target < 1.0) return 0;

  return parseFloat(target.toFixed(2));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isNoOrderbook(err: any): boolean {
  const haystack = [
    err?.message,
    err?.data?.error,
    typeof err?.data === 'string' ? err.data : '',
  ].join(' ').toLowerCase();
  return haystack.includes('orderbook') || haystack.includes('no orderbook');
}

// ─── Trade Detection ──────────────────────────────────────────────────────────

/**
 * Fetches recent MINED trades for a trader address from the CLOB API.
 * Uses Redis to remember the last-seen timestamp so we only process new trades.
 */
async function fetchWithRetry(url: string, maxRetries = 2): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'PolyTech/1.0', 'Accept': 'application/json' },
      });
      return resp;
    } catch (err: any) {
      if (attempt === maxRetries) throw err;
      // Wait 1s before retry
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('fetchWithRetry exhausted');
}

async function fetchNewTradesForTrader(traderAddress: string): Promise<DetectedTrade[]> {
  const redisKey = `copy:last_seen:${traderAddress}`;

  let lastSeen = 0;
  const cached = await redisCache.get<number>(redisKey);
  if (cached) lastSeen = cached;

  try {
    const url = `${DATA_API_BASE}/activity?user=${traderAddress}&limit=50`;
    const resp = await fetchWithRetry(url);

    if (!resp.ok) {
      logger.warn(`[copy] Data API /activity returned ${resp.status} for ${traderAddress}`);
      return [];
    }

    const data: any = await resp.json();
    const rawTrades: any[] = Array.isArray(data) ? data : (data?.data ?? []);

    // First-time initialization: skip all historical trades, just record the cursor
    if (lastSeen === 0 && rawTrades.length > 0) {
      const validTimestamps = rawTrades
        .filter(t => t.type === 'TRADE' || t.status === 'MINED' || t.status === 'CONFIRMED')
        .map(t => {
          const rawTs = t.timestamp ?? t.match_time;
          if (typeof rawTs === 'number') return rawTs < 1e12 ? rawTs * 1000 : rawTs;
          return new Date(rawTs ?? 0).getTime();
        })
        .filter(ts => !isNaN(ts));
      const maxTs = validTimestamps.length > 0 ? Math.max(...validTimestamps) : Date.now();
      await redisCache.set(redisKey, maxTs, 7 * 24 * 3600);
      logger.info(`[copy] First poll for ${traderAddress.slice(0, 8)}...: set cursor to ${new Date(maxTs).toISOString()}, skipping history`);
      return [];
    }

    const newTrades: DetectedTrade[] = [];
    let maxTimestamp = lastSeen;

    for (const t of rawTrades) {
      // Data API uses type === 'TRADE'; CLOB API uses status === 'MINED' | 'CONFIRMED'
      const isTradeActivity = t.type === 'TRADE' || t.status === 'MINED' || t.status === 'CONFIRMED';
      if (!isTradeActivity) continue;

      const rawTs = t.timestamp ?? t.match_time;
      let ts: number;
      if (typeof rawTs === 'number') {
        ts = rawTs < 1e12 ? rawTs * 1000 : rawTs; // convert Unix seconds to ms if needed
      } else {
        ts = new Date(rawTs ?? 0).getTime();
      }

      // Y4: Guard against NaN timestamps (malformed API response)
      if (isNaN(ts)) {
        logger.warn(`[copy] Skipping trade with invalid timestamp: ${rawTs}`);
        continue;
      }

      if (ts <= lastSeen) continue;

      // K6: Per-trade deduplication via Redis (prevents double-processing across polls)
      // R2: Include asset so YES BUY and NO BUY in the same minute are not conflated
      const assetField = t.asset ?? t.asset_id ?? t.conditionId ?? t.market ?? '';
      const dedupeKey = `copy:dedup:${traderAddress}:${assetField}:${(t.side ?? '').toUpperCase()}:${Math.floor(ts / 60000)}`;
      const alreadyProcessed = await redisCache.get<number>(dedupeKey);
      if (alreadyProcessed) {
        logger.debug(`[copy] Skipping duplicate trade (dedup key exists): ${dedupeKey}`);
        continue;
      }
      await redisCache.set(dedupeKey, 1, 300); // 5-minute dedup window

      const price   = parseFloat(t.price ?? '0');
      const size    = parseFloat(t.size ?? '0');
      const sizeUsd = t.usdcSize ? parseFloat(t.usdcSize) : size * price;

      newTrades.push({
        traderAddress,
        marketId: t.conditionId ?? t.market   ?? '',
        assetId:  t.asset       ?? t.asset_id ?? '',
        outcome:  (t.outcome ?? '').toUpperCase() || 'YES',
        side:     (t.side    ?? '').toUpperCase() || 'BUY',
        size,
        sizeUsd,
        price,
        timestamp: ts,
      });

      if (ts > maxTimestamp) maxTimestamp = ts;
    }

    // Update last-seen cursor (keep for 7 days)
    if (maxTimestamp > lastSeen) {
      await redisCache.set(redisKey, maxTimestamp, 7 * 24 * 3600);
    }

    return newTrades;
  } catch (err: any) {
    logger.warn(`[copy] Error fetching trades for ${traderAddress}: ${err?.message}`);
    return [];
  }
}

// ─── Order Execution ──────────────────────────────────────────────────────────

interface ExecResult {
  status: 'filled' | 'failed' | 'skipped';
  orderID?: string;
  errorMsg?: string;
  // F4: Our execution price (worst-case limit we submitted), used as TP/SL entry price.
  // Distinct from trade.price (the trader's fill price) which could differ due to slippage.
  filledPrice?: number;
}

async function executeCopyOrder(
  user: {
    id: string;
    telegramId: string;
    encryptedPrivateKey: string;
    encryptedApiKey: string;
    encryptedApiSecret: string;
    encryptedPassphrase: string;
    polymarketProxyAddress: string | null;
    slippageTolerance: number;
    predexonUserId?: string | null;
  },
  trade: DetectedTrade,
  copySize: number,
  subSlippage?: number   // per-subscription slippage (falls back to user.slippageTolerance)
): Promise<ExecResult> {
  if (!user.polymarketProxyAddress) {
    return { status: 'skipped', errorMsg: 'no proxy address' };
  }

  try {
    // Ensure Predexon user exists (lazy migration for existing users)
    const predexonUserId = await ensurePredexonUser(user as any);

    // Fetch market info for tokenId resolution
    let tokenId = trade.assetId;

    try {
      const mResp = await fetch(`${CLOB_BASE}/markets/${trade.marketId}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (mResp.ok) {
        const m = await mResp.json();
        // Resolve tokenId from market if assetId is empty
        if (!tokenId && m.tokens?.length) {
          const outcomeIdx = trade.outcome === 'YES' ? 0 : 1;
          tokenId = m.tokens[outcomeIdx]?.token_id ?? '';
        }
      }
    } catch { /* proceed with defaults */ }

    if (!tokenId) {
      return { status: 'failed', errorMsg: 'could not resolve tokenId' };
    }

    const isSell = trade.side === 'SELL';
    const slippagePct  = (subSlippage ?? user.slippageTolerance) ?? 1.0;
    const slippageMult = slippagePct / 100;

    let size: number;
    let commissionAmt = 0; // only used for BUY

    if (isSell) {
      // For SELL: find user's position for this token and determine sell size proportionally
      const positions = await getActivePositions(user.polymarketProxyAddress);
      const pos = positions.find((p) => p.asset === tokenId);

      if (!pos || pos.size <= 0) {
        return { status: 'skipped', errorMsg: 'no matching position to sell' };
      }

      const traderShares = parseFloat((trade.sizeUsd / trade.price).toFixed(4));
      size = Math.min(traderShares, pos.size);

      if (size < 1) {
        return { status: 'skipped', errorMsg: 'sell size too small' };
      }

      // SELL via Predexon — market order
      const orderResp = await predexonPlaceOrder(predexonUserId, {
        venue: 'polymarket',
        tokenId,
        side: 'sell',
        type: 'market',
        size: String(size),
      });

      if (!orderResp.orderId) {
        const errMsg = (orderResp as any).error || (orderResp as any).message || 'order rejected';
        if (isNoOrderbook({ message: errMsg })) {
          return { status: 'skipped', errorMsg: 'market closed/no orderbook' };
        }
        return { status: 'failed', errorMsg: errMsg };
      }
      // (No commission on SELL)
      return { status: 'filled', orderID: orderResp.orderId };
    }

    // BUY path
    commissionAmt = parseFloat((copySize * COMMISSION_RATE).toFixed(6));
    const tradeAmount = parseFloat((copySize - commissionAmt).toFixed(6));

    if (tradeAmount < 1.0) {
      return { status: 'skipped', errorMsg: 'trade amount too small after commission' };
    }

    const price = trade.price * (1 + slippageMult);
    size = parseFloat((tradeAmount / price).toFixed(4));

    if (size < 0.01) {
      return { status: 'skipped', errorMsg: 'buy size too small' };
    }

    // BUY via Predexon — market order (amount = USD to spend)
    const orderResp = await predexonPlaceOrder(predexonUserId, {
      venue: 'polymarket',
      tokenId,
      side: 'buy',
      type: 'market',
      amount: String(tradeAmount),
    });

    if (!orderResp.orderId) {
      const errMsg = (orderResp as any).error || (orderResp as any).message || 'order rejected';
      if (isNoOrderbook({ message: errMsg })) {
        return { status: 'skipped', errorMsg: 'market closed/no orderbook' };
      }
      return { status: 'failed', errorMsg: errMsg };
    }

    // Collect commission for BUY trades (fire-and-forget)
    if (config.commission?.adminWalletAddress) {
      transferCommission(
        user.encryptedPrivateKey,
        user.polymarketProxyAddress,
        commissionAmt,
        user.id,
        user.predexonUserId ?? undefined
      ).catch((err) =>
        logger.warn(`[copy] Commission transfer failed for user ${user.telegramId}: ${err?.message}`)
      );
    }

    return { status: 'filled', orderID: orderResp.orderId, filledPrice: price };
  } catch (err: any) {
    if (isNoOrderbook(err)) {
      return { status: 'skipped', errorMsg: 'market closed/no orderbook' };
    }
    return { status: 'failed', errorMsg: err?.message ?? 'unknown error' };
  }
}

// ─── Per-Trader Tick ──────────────────────────────────────────────────────────

// ─── Market Info Cache (for notification titles) ──────────────────────────────

async function fetchMarketInfo(conditionId: string): Promise<{ question: string; slug: string; eventSlug: string } | null> {
  if (!conditionId) return null;
  const cacheKey = `copy:mktinfo3:${conditionId}`;
  const cached = await redisCache.get<{ question: string; slug: string; eventSlug: string }>(cacheKey);
  if (cached) return cached;
  try {
    // Gamma API has the event slug (CLOB API only has market_slug, not event slug)
    const gammaResp = await fetchWithRetry(`https://gamma-api.polymarket.com/markets?conditionId=${conditionId}&limit=1`);
    if (gammaResp.ok) {
      const gammaData = await gammaResp.json();
      const gm = Array.isArray(gammaData) ? gammaData[0] : null;
      if (gm) {
        const slug = gm.slug ?? gm.marketSlug ?? '';
        const eventSlug = gm.events?.[0]?.slug ?? gm.event?.slug ?? slug;
        const result = { question: gm.question ?? conditionId.slice(0, 20), slug, eventSlug };
        await redisCache.set(cacheKey, result, 3600);
        return result;
      }
    }
    // Fallback: CLOB API — event slug will equal market slug (acceptable for binary markets)
    const resp = await fetchWithRetry(`${CLOB_BASE}/markets/${conditionId}`);
    if (!resp.ok) return null;
    const m = await resp.json();
    if (!m || !m.condition_id) return null;
    const slug = m.market_slug ?? '';
    const result = { question: m.question ?? conditionId.slice(0, 20), slug, eventSlug: slug };
    await redisCache.set(cacheKey, result, 3600);
    return result;
  } catch {
    return null;
  }
}

/**
 * Processes all new trades for one trader address and executes copies for each subscriber.
 * `sendNotification` is injected so the service stays decoupled from Telegraf.
 */
async function tickForTrader(
  traderAddress: string,
  sendNotification: (telegramId: string, message: string, extra?: NotificationExtra) => Promise<void>,
  preloadedTrades?: DetectedTrade[],
): Promise<void> {
  // Load active subscriptions first — needed for both new-trade processing and TP/SL checks
  const subs = await prisma.copySubscription.findMany({
    where: { traderAddress, isActive: true, isPaused: false },
    include: {
      user: {
        select: {
          id: true,
          telegramId: true,
          encryptedPrivateKey: true,
          encryptedApiKey: true,
          encryptedApiSecret: true,
          encryptedPassphrase: true,
          polymarketProxyAddress: true,
          slippageTolerance: true,
          predexonUserId: true,
        },
      },
    },
  });

  if (subs.length === 0) return;

  const newTrades = preloadedTrades ?? await fetchNewTradesForTrader(traderAddress);

  if (newTrades.length > 0) {
  // Y5: Fetch balance once per user at tick start (not once per trade×subscription)
  const balanceCache = new Map<string, number>();
  // Tracks users whose balance fetch failed this tick — skip auto-stop for them
  const balanceFetchFailed = new Set<string>();
  // Fetch positions once per proxy address at tick start (needed for first-entry detection)
  const positionCache = new Map<string, ActivePosition[]>();

  for (const sub of subs) {
    if (balanceCache.has(sub.userId) || balanceFetchFailed.has(sub.userId)) continue;
    try {
      const { getBalance } = await import('./predexon');
      const predexonId = await ensurePredexonUser(sub.user as any);
      const balances = await getBalance(predexonId, 'polymarket');
      const avail = balances.length > 0 ? parseFloat(balances[0].available) : 0;
      balanceCache.set(sub.userId, avail);
    } catch (err: any) {
      logger.warn(`[copy] Failed to fetch balance for user ${sub.user.telegramId}: ${err?.message}`);
      balanceFetchFailed.add(sub.userId);
    }

    // Pre-fetch positions for users with fixedAmount so we can detect first-entry BUYs
    if (sub.fixedAmount !== null && sub.user.polymarketProxyAddress) {
      const proxy = sub.user.polymarketProxyAddress;
      if (!positionCache.has(proxy)) {
        try {
          positionCache.set(proxy, await getActivePositions(proxy));
        } catch {
          positionCache.set(proxy, []);
        }
      }
    }
  }

  // Tracks (userId + tradeKey) pairs already notified this tick — prevents duplicate
  // notifications when a user has multiple subscriptions to the same trader.
  const notifiedThisTick = new Set<string>();

  for (const trade of newTrades) {
    for (const sub of subs) {
      const user = sub.user;

      // Auto-stop check using cached balance
      try {
        // Skip if balance fetch failed this tick — avoid false auto-stops
        if (balanceFetchFailed.has(sub.userId)) continue;

        // ── Trade behavior filtering ────────────────────────────────────────
        // Determine the effective side to execute (may differ from leader's side)
        let effectiveSide = trade.side;
        let effectiveOutcome = trade.outcome;

        if (sub.counterTrade) {
          // Counter trade: flip the side
          effectiveSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
          effectiveOutcome = trade.outcome === 'YES' ? 'NO' : 'YES';
        } else if (sub.buyOnSells && trade.side === 'SELL') {
          // Buy when leader sells
          effectiveSide = 'BUY';
        } else {
          // Normal mode: check followBuys / copySells
          if (trade.side === 'BUY' && !sub.followBuys) continue;
          if (trade.side === 'SELL' && !sub.copySells) continue;
        }

        // Copy side filter (only copy YES, NO, or both outcomes)
        if (sub.copySide === 'yes' && effectiveOutcome !== 'YES') continue;
        if (sub.copySide === 'no' && effectiveOutcome !== 'NO') continue;

        const balance = balanceCache.get(sub.userId) ?? 0;

        if (balance < sub.autoStopBelowBalance) {
          await prisma.copySubscription.update({
            where: { id: sub.id },
            data: { isActive: false },
          });

          const shortAddr = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
          await sendNotification(
            user.telegramId,
            `⚠️ <b>Copy Stopped — Low Balance</b>\n\n` +
            `Trader: <code>${shortAddr}</code>\n` +
            `Balance $${balance.toFixed(2)} &lt; Minimum $${sub.autoStopBelowBalance.toFixed(2)}\n\n` +
            `Use /deposit to top up`
          );

          logger.info(`[copy] Auto-stopped subscription ${sub.id} — balance $${balance.toFixed(2)}`);
          continue;
        }

        // Compute copy size
        // For BUY trades with a fixedAmount: use fixedAmount only on first entry
        // (no existing position). Subsequent BUYs use proportional sizing based on
        // the ratio established at first entry (stored in Redis), or the explicit
        // multiplier if one is configured.
        let copySize: number;
        if (trade.side === 'BUY' && sub.fixedAmount !== null && sub.fixedAmount > 0) {
          const proxy = user.polymarketProxyAddress ?? '';
          const userPositions = positionCache.get(proxy) ?? [];
          const hasPosition   = userPositions.some((p) => p.asset === trade.assetId);
          const ratioKey      = `copy:ratio:${sub.id}:${trade.assetId}`;

          if (!hasPosition) {
            // ── First entry: use fixedAmount ──────────────────────────────────
            copySize = computeCopySize(sub.fixedAmount, null, trade.sizeUsd, balance);
            // Persist ratio for subsequent trades (skip if no explicit multiplier exists)
            if (sub.multiplier === null && copySize > 0 && trade.sizeUsd > 0) {
              await redisCache.set(ratioKey, copySize / trade.sizeUsd, 90 * 24 * 3600);
            }
          } else if (sub.multiplier !== null) {
            // ── Has position + explicit multiplier: use multiplier ────────────
            copySize = computeCopySize(null, sub.multiplier, trade.sizeUsd, balance);
          } else {
            // ── Has position + fixedAmount only: use stored ratio ─────────────
            const storedRatio = await redisCache.get<number>(ratioKey);
            if (storedRatio !== null) {
              copySize = computeCopySize(null, storedRatio, trade.sizeUsd, balance);
            } else {
              // Redis evicted — re-enter with fixedAmount and re-establish ratio
              copySize = computeCopySize(sub.fixedAmount, null, trade.sizeUsd, balance);
              if (copySize > 0 && trade.sizeUsd > 0) {
                await redisCache.set(ratioKey, copySize / trade.sizeUsd, 90 * 24 * 3600);
              }
            }
          }
        } else {
          // SELL trades or multiplier-only subscriptions: existing logic unchanged
          copySize = computeCopySize(
            sub.fixedAmount ?? null,
            sub.multiplier ?? null,
            trade.sizeUsd,
            balance
          );
        }

        if (copySize === 0) {
          await prisma.copiedTrade.create({
            data: {
              subscriptionId: sub.id,
              userId: user.id,
              traderAddress,
              marketId: trade.marketId,
              assetId: trade.assetId || null,
              outcome: trade.outcome,
              side: trade.side,
              sourceSize: trade.sizeUsd,
              copiedSize: 0,
              price: trade.price,
              status: 'skipped',
              errorMsg: 'copy size below minimum',
            },
          });
          if (sub.notificationsEnabled) {
            const shortAddr = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
            await sendNotification(
              user.telegramId,
              `⏭ <b>Trade Skipped</b>\n\n` +
              `Trader: <code>${shortAddr}</code>\n` +
              `Market: <code>${trade.marketId.slice(0, 20)}...</code>\n` +
              `Side: ${trade.side} ${trade.outcome}\n` +
              `Reason: Copy size below minimum`
            );
          }
          continue;
        }

        // ── Filter: price range (BUY only — priceMin/priceMax in cents 0–100) ─────
        if (effectiveSide === 'BUY') {
          const priceCents = trade.price * 100;
          if (sub.priceMin != null && priceCents < sub.priceMin) {
            await prisma.copiedTrade.create({ data: { subscriptionId: sub.id, userId: user.id, traderAddress, marketId: trade.marketId, assetId: trade.assetId || null, outcome: effectiveOutcome, side: effectiveSide, sourceSize: trade.sizeUsd, copiedSize: 0, price: trade.price, status: 'skipped', errorMsg: `price ${priceCents.toFixed(1)}c below min filter` } });
            if (sub.notificationsEnabled) await sendNotification(user.telegramId, `⏭ <b>Trade Skipped</b>\n\nTrader: <code>${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}</code>\nReason: Price ${priceCents.toFixed(1)}¢ &lt; min ${sub.priceMin}¢`);
            continue;
          }
          if (sub.priceMax != null && priceCents > sub.priceMax) {
            await prisma.copiedTrade.create({ data: { subscriptionId: sub.id, userId: user.id, traderAddress, marketId: trade.marketId, assetId: trade.assetId || null, outcome: effectiveOutcome, side: effectiveSide, sourceSize: trade.sizeUsd, copiedSize: 0, price: trade.price, status: 'skipped', errorMsg: `price ${priceCents.toFixed(1)}c above max filter` } });
            if (sub.notificationsEnabled) await sendNotification(user.telegramId, `⏭ <b>Trade Skipped</b>\n\nTrader: <code>${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}</code>\nReason: Price ${priceCents.toFixed(1)}¢ &gt; max ${sub.priceMax}¢`);
            continue;
          }
        }

        // ── Filter: single trade max cap (BUY only) ───────────────────────────────
        if (effectiveSide === 'BUY' && sub.singleTradeMax != null && copySize > sub.singleTradeMax) {
          copySize = sub.singleTradeMax;
          if (copySize < 1.0) {
            await prisma.copiedTrade.create({ data: { subscriptionId: sub.id, userId: user.id, traderAddress, marketId: trade.marketId, assetId: trade.assetId || null, outcome: effectiveOutcome, side: effectiveSide, sourceSize: trade.sizeUsd, copiedSize: 0, price: trade.price, status: 'skipped', errorMsg: 'below min after singleTradeMax cap' } });
            continue;
          }
        }

        // ── Filter: min buy amount (BUY only) ───────────────────────────────────
        if (effectiveSide === 'BUY' && sub.minBuyAmount != null && copySize < sub.minBuyAmount) {
          await prisma.copiedTrade.create({ data: { subscriptionId: sub.id, userId: user.id, traderAddress, marketId: trade.marketId, assetId: trade.assetId || null, outcome: effectiveOutcome, side: effectiveSide, sourceSize: trade.sizeUsd, copiedSize: 0, price: trade.price, status: 'skipped', errorMsg: `copy size $${copySize.toFixed(2)} below min $${sub.minBuyAmount}` } });
          continue;
        }

        // ── Filter: max spend per market (BUY only) ─────────────────────────────
        if (effectiveSide === 'BUY' && sub.maxSpendPerMarket != null) {
          const mktKey = `copy:mktspend:${sub.id}:${trade.marketId}`;
          const spentOnMarket = (await redisCache.get<number>(mktKey)) ?? 0;
          if (spentOnMarket + copySize > sub.maxSpendPerMarket) {
            await prisma.copiedTrade.create({ data: { subscriptionId: sub.id, userId: user.id, traderAddress, marketId: trade.marketId, assetId: trade.assetId || null, outcome: effectiveOutcome, side: effectiveSide, sourceSize: trade.sizeUsd, copiedSize: 0, price: trade.price, status: 'skipped', errorMsg: `market spend limit ($${spentOnMarket.toFixed(2)}/$${sub.maxSpendPerMarket})` } });
            continue;
          }
        }

        // ── Filter: max spend total (BUY only) ─────────────────────────────────
        if (effectiveSide === 'BUY' && sub.maxSpendTotal != null) {
          const totalKey = `copy:totalspend:${sub.id}`;
          const spentTotal = (await redisCache.get<number>(totalKey)) ?? 0;
          if (spentTotal + copySize > sub.maxSpendTotal) {
            await prisma.copiedTrade.create({ data: { subscriptionId: sub.id, userId: user.id, traderAddress, marketId: trade.marketId, assetId: trade.assetId || null, outcome: effectiveOutcome, side: effectiveSide, sourceSize: trade.sizeUsd, copiedSize: 0, price: trade.price, status: 'skipped', errorMsg: `total spend limit reached` } });
            continue;
          }
        }

        // ── Filter: daily spend limit (BUY only) ──────────────────────────────────
        if (effectiveSide === 'BUY' && sub.dailySpendMax != null) {
          const today = new Date().toISOString().slice(0, 10);
          const spendKey = `copy:daily:${sub.id}:${today}`;
          const spentToday = (await redisCache.get<number>(spendKey)) ?? 0;
          if (spentToday + copySize > sub.dailySpendMax) {
            await prisma.copiedTrade.create({ data: { subscriptionId: sub.id, userId: user.id, traderAddress, marketId: trade.marketId, assetId: trade.assetId || null, outcome: effectiveOutcome, side: effectiveSide, sourceSize: trade.sizeUsd, copiedSize: 0, price: trade.price, status: 'skipped', errorMsg: `daily limit reached ($${spentToday.toFixed(2)}/$${sub.dailySpendMax})` } });
            if (sub.notificationsEnabled) await sendNotification(user.telegramId, `⏭ <b>Trade Skipped — Daily Limit</b>\n\nTrader: <code>${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}</code>\nLimit: $${sub.dailySpendMax} · Spent: $${spentToday.toFixed(2)}`);
            continue;
          }
        }

        // Build the effective trade (may have flipped side/outcome for counter trade)
        const effectiveTrade: DetectedTrade = {
          ...trade,
          side: effectiveSide,
          outcome: effectiveOutcome,
        };

        // Execute the copy
        const result = await executeCopyOrder(user, effectiveTrade, copySize, sub.slippage);

        // Delay between orders to avoid Cloudflare 1015 rate limiting on CLOB
        await new Promise(r => setTimeout(r, 1200));

        // Save to DB
        await prisma.copiedTrade.create({
          data: {
            subscriptionId: sub.id,
            userId: user.id,
            traderAddress,
            marketId: trade.marketId,
            assetId: trade.assetId || null,
            outcome: effectiveOutcome,
            side: effectiveSide,
            sourceSize: trade.sizeUsd,
            copiedSize: copySize,
            price: result.filledPrice ?? trade.price,
            orderID: result.orderID ?? null,
            status: result.status,
            errorMsg: result.errorMsg ?? null,
          },
        });

        // Track spend for successful BUY fills
        if (result.status === 'filled' && effectiveSide === 'BUY') {
          // Daily spend
          if (sub.dailySpendMax != null) {
            const today = new Date().toISOString().slice(0, 10);
            const spendKey = `copy:daily:${sub.id}:${today}`;
            const spentToday = (await redisCache.get<number>(spendKey)) ?? 0;
            await redisCache.set(spendKey, spentToday + copySize, 25 * 3600);
          }
          // Per-market spend
          if (sub.maxSpendPerMarket != null) {
            const mktKey = `copy:mktspend:${sub.id}:${trade.marketId}`;
            const spent = (await redisCache.get<number>(mktKey)) ?? 0;
            await redisCache.set(mktKey, spent + copySize, 90 * 24 * 3600);
          }
          // Total spend
          if (sub.maxSpendTotal != null) {
            const totalKey = `copy:totalspend:${sub.id}`;
            const spent = (await redisCache.get<number>(totalKey)) ?? 0;
            await redisCache.set(totalKey, spent + copySize, 365 * 24 * 3600);
          }
        }

        // Send Telegram notification (respects notificationsEnabled per subscription)
        if (sub.notificationsEnabled) {
          const tradeKey = `${user.telegramId}:${trade.marketId}:${trade.assetId}:${effectiveSide}:${trade.timestamp}`;
          const alreadyNotified = notifiedThisTick.has(tradeKey);

          const shortAddr = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
          const traderName = sub.label || shortAddr;
          const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

          if (result.status === 'filled' && !alreadyNotified) {
            notifiedThisTick.add(tradeKey);
            const mktInfo = await fetchMarketInfo(trade.marketId).catch(() => null);
            const question = mktInfo?.question ?? trade.marketId.slice(0, 40);
            const marketUrl = (mktInfo?.eventSlug || mktInfo?.slug)
              ? `https://polymarket.com/event/${mktInfo!.eventSlug || mktInfo!.slug}`
              : `https://polymarket.com/profile/${traderAddress}`;
            const shares = trade.size > 0 ? trade.size : (trade.price > 0 ? trade.sizeUsd / trade.price : 0);
            const sideLabel = effectiveSide === 'BUY' ? 'BOUGHT' : 'SOLD';

            // Fetch on-chain tx hash for the copy order (non-blocking with short timeout)
            let txLine = '';
            if (user.polymarketProxyAddress && trade.assetId) {
              const txHash = await fetchTxHashForOrder(
                user.polymarketProxyAddress,
                trade.assetId,
                Date.now() - 30_000, // trades placed in the last 30s
                3,   // max retries
                3_000,
              ).catch(() => null);
              if (txHash) {
                txLine = `\n🔗 <a href="https://polygonscan.com/tx/${txHash}">Transaction Hash</a>`;
              }
            }

            const msg =
              `⚡ <b>${escHtml(traderName)}</b> just <b>${sideLabel} ${effectiveOutcome}</b> for <b>${copySize.toFixed(2)} USDC</b>\n\n` +
              `📊 Market: <b>${escHtml(question)}</b>\n` +
              `🎯 Outcome: <b>${effectiveOutcome}</b>\n` +
              `💰 Price: <b>$${trade.price.toFixed(3)}</b>\n` +
              `📈 Shares: <b>${shares.toFixed(2)}</b>\n` +
              `💵 USDC Amount: <b>${copySize.toFixed(2)} USDC</b>\n` +
              txLine +
              `\n<a href="${marketUrl}">View Market</a>`;

            const IMG_COPYTRADE = require('path').join(__dirname, '../bot/img/copytrade.jpg');
            await sendNotification(user.telegramId, msg, {
              imagePath: IMG_COPYTRADE,
              buttons: [
                [
                  { text: '📊 View Market', url: marketUrl },
                  { text: '🌸 View Portfolio', callback_data: 'portfolio' },
                ],
                [{ text: '× Close', callback_data: 'close_notif' }],
              ],
            });
          } else if (result.status === 'failed' && !alreadyNotified) {
            notifiedThisTick.add(tradeKey);
            // Suppress duplicate failure notifications for the same sub+market within 1 hour
            const failNotifKey = `copy:failnotif:${sub.id}:${trade.marketId}`;
            const alreadyFailNotified = await redisCache.get<number>(failNotifKey);
            if (!alreadyFailNotified) {
              await redisCache.set(failNotifKey, 1, 3600);
              await sendNotification(
                user.telegramId,
                `❌ <b>Copy Failed</b>\n\n` +
                `Market: <code>${trade.marketId.slice(0, 20)}...</code>\n` +
                `Error: ${escHtml((result.errorMsg ?? 'unknown error').slice(0, 120))}\n` +
                `Copy size: $${copySize.toFixed(2)}`
              );
            }
          } else if (result.status === 'skipped' && !alreadyNotified) {
            notifiedThisTick.add(tradeKey);
            await sendNotification(
              user.telegramId,
              `⏭ <b>Trade Skipped</b>\n\n` +
              `Trader: <code>${shortAddr}</code>\n` +
              `Market: <code>${trade.marketId.slice(0, 20)}...</code>\n` +
              `Side: ${effectiveSide} ${effectiveOutcome}\n` +
              `Reason: ${escHtml(result.errorMsg ?? 'no position found')}`
            );
          }
        }
      } catch (err: any) {
        logger.error(`[copy] Error processing sub ${sub.id}: ${err?.message}`);
      }
    }
  }
  } // end if (newTrades.length > 0)

  // TP/SL check — run once per subscription after all new trades are processed
  for (const sub of subs) {
    if (sub.takeProfitPct != null || sub.stopLossPct != null || sub.takeProfitFixed != null || sub.stopLossFixed != null) {
      await checkTpSlPositions(
        sub.user,
        {
          subscriptionId: sub.id,
          traderAddress: sub.traderAddress,
          takeProfitPct: sub.takeProfitPct,
          stopLossPct: sub.stopLossPct,
          takeProfitFixed: sub.takeProfitFixed ?? null,
          stopLossFixed: sub.stopLossFixed ?? null,
          slippage: sub.slippage,
        },
        sendNotification
      ).catch((err) =>
        logger.error(`[copy] TP/SL check error for ${sub.userId}: ${err?.message}`)
      );
    }
  }
}

// ─── TP/SL Position Check ─────────────────────────────────────────────────────

/**
 * Checks open copied BUY positions for a user/subscription pair and triggers
 * TP or SL exits when the current midpoint price crosses the configured threshold.
 */
async function checkTpSlPositions(
  user: {
    id: string;
    telegramId: string;
    encryptedPrivateKey: string;
    encryptedApiKey: string;
    encryptedApiSecret: string;
    encryptedPassphrase: string;
    polymarketProxyAddress: string | null;
    slippageTolerance: number;
    predexonUserId?: string | null;
  },
  sub: {
    subscriptionId: string;
    traderAddress: string;
    takeProfitPct: number | null;
    stopLossPct: number | null;
    takeProfitFixed: number | null;
    stopLossFixed: number | null;
    slippage?: number;
  },
  sendNotification: (telegramId: string, msg: string, extra?: NotificationExtra) => Promise<void>
): Promise<void> {
  if (sub.takeProfitPct == null && sub.stopLossPct == null && sub.takeProfitFixed == null && sub.stopLossFixed == null) return;

  // Find open BUY positions that have not yet been TP/SL exited.
  // Filter by subscriptionId so that re-creating a subscription to the same trader
  // does not accidentally TP/SL exit positions from a previous subscription.
  // Legacy records (subscriptionId = null, created before this field was added)
  // are intentionally excluded — they cannot be attributed to a specific subscription.
  const openPositions = await prisma.copiedTrade.findMany({
    where: {
      subscriptionId: sub.subscriptionId,
      userId: user.id,
      traderAddress: sub.traderAddress,
      side: 'BUY',
      status: 'filled',
      tpSlStatus: null,
      assetId: { not: null },
    },
  });

  if (openPositions.length === 0) return;

  logger.debug(`[copy] TP/SL check for ${user.id}: ${openPositions.length} open positions`);

  // Batch-fetch midpoint prices from CLOB
  const tokenIds = [...new Set(openPositions.map((p) => p.assetId!))];
  let midpoints: Record<string, string> = {};

  try {
    const url = `${CLOB_MIDPOINTS_URL}?token_ids=${tokenIds.join(',')}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (resp.ok) {
      const data: any = await resp.json();
      midpoints = data?.midpoints ?? {};
    } else {
      logger.warn(`[copy] Midpoints API returned ${resp.status}`);
      return;
    }
  } catch (err: any) {
    logger.warn(`[copy] Failed to fetch midpoints: ${err?.message}`);
    return;
  }

  for (const pos of openPositions) {
    const currentPriceStr = midpoints[pos.assetId!];
    if (currentPriceStr == null) continue;

    const currentPrice = parseFloat(currentPriceStr);
    if (isNaN(currentPrice) || pos.price <= 0) continue;

    // TP price: percentage-based (relative to entry) or fixed (absolute in 0–1 decimal)
    const tpPrice = sub.takeProfitPct != null
      ? pos.price * (1 + sub.takeProfitPct / 100)
      : sub.takeProfitFixed != null
      ? sub.takeProfitFixed / 100  // fixed is in cents, convert to decimal (e.g. 85¢ → 0.85)
      : null;

    // SL price: percentage-based (relative to entry) or fixed (absolute in 0–1 decimal)
    const slPrice = sub.stopLossPct != null
      ? pos.price * (1 - sub.stopLossPct / 100)
      : sub.stopLossFixed != null
      ? sub.stopLossFixed / 100  // fixed is in cents, convert to decimal
      : null;

    let triggerType: 'tp_triggered' | 'sl_triggered' | null = null;

    if (tpPrice != null && currentPrice >= tpPrice) {
      triggerType = 'tp_triggered';
    } else if (slPrice != null && currentPrice <= slPrice) {
      triggerType = 'sl_triggered';
    }

    if (!triggerType) continue;

    logger.info(
      `[copy] ${triggerType} for user ${user.id} on asset ${pos.assetId} ` +
      `entry=${pos.price.toFixed(4)} current=${currentPrice.toFixed(4)}`
    );

    // Build synthetic SELL trade
    const syntheticTrade: DetectedTrade = {
      traderAddress: sub.traderAddress,
      marketId: pos.marketId,
      assetId: pos.assetId!,
      outcome: pos.outcome,
      side: 'SELL',
      size: currentPrice > 0 ? pos.copiedSize / currentPrice : 0,
      sizeUsd: pos.copiedSize,
      price: currentPrice,
      timestamp: Date.now(),
    };

    const result = await executeCopyOrder(user, syntheticTrade, pos.copiedSize, sub.slippage);

    // Mark as TP/SL exited only when order was placed or skipped (not on hard failure,
    // so the next tick can retry). 'skipped' means user has no position to sell —
    // marking it prevents repeated pointless retries.
    if (result.status !== 'failed') {
      await prisma.copiedTrade.update({
        where: { id: pos.id },
        data: { tpSlStatus: triggerType },
      });
    }

    // Send notification
    const shortAddr = `${sub.traderAddress.slice(0, 6)}...${sub.traderAddress.slice(-4)}`;
    const entryFormatted = (pos.price * 100).toFixed(0) + '¢';
    const exitFormatted  = (currentPrice * 100).toFixed(0) + '¢';
    const changePct = ((currentPrice - pos.price) / pos.price * 100).toFixed(1);
    const changeSign = currentPrice >= pos.price ? '+' : '';
    const icon = triggerType === 'tp_triggered' ? '📈' : '🛑';
    const label = triggerType === 'tp_triggered' ? 'Take Profit Triggered' : 'Stop Loss Triggered';

    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const statusLine = result.status === 'filled'
      ? `✅ Sell order placed`
      : result.status === 'skipped'
        ? `⏭ Skipped: ${escHtml(result.errorMsg ?? '')}`
        : `❌ Error: ${escHtml(result.errorMsg ?? 'unknown')}`;

    await sendNotification(
      user.telegramId,
      `${icon} <b>${label}</b>\n\n` +
      `Trader: <code>${shortAddr}</code>\n` +
      `Entry: ${entryFormatted}  →  Exit: ${exitFormatted}\n` +
      `Change: ${changeSign}${changePct}%\n` +
      statusLine
    );
  }
}

// ─── Monitor ──────────────────────────────────────────────────────────────────

let monitorInterval: ReturnType<typeof setInterval> | null = null;
// F5: Flag set on shutdown — in-flight ticks check this before processing each trader
// to avoid orphaned DB writes and Telegram sends after the bot process is stopping.
let monitorStopped = false;

/**
 * Starts the copy trade polling monitor.
 * Call once after bot.launch().
 * @param sendNotification Injected function to send Telegram messages.
 * @param intervalSeconds Polling interval (default: 30).
 */
export function startCopyTradeMonitor(
  sendNotification: (telegramId: string, message: string, extra?: NotificationExtra) => Promise<void>,
  intervalSeconds = 60
): void {
  if (monitorInterval) {
    logger.warn('[copy] Monitor already running — skipping duplicate start');
    return;
  }

  monitorStopped = false;
  logger.info(`[copy] Starting copy trade monitor (interval: ${intervalSeconds}s)`);

  // Start on-chain WebSocket listener if WSS URL is configured
  startOnChainListener(sendNotification).catch((err) =>
    logger.warn(`[copy] On-chain listener failed to start: ${err?.message}`)
  );

  const tick = async () => {
    if (monitorStopped) return;
    try {
      // Refresh in-memory trader set so newly added subscriptions are picked up
      await refreshOnChainFilters();

      // Find all unique trader addresses with at least one active subscription
      const rows = await prisma.copySubscription.findMany({
        where: { isActive: true },
        select: { traderAddress: true },
        distinct: ['traderAddress'],
      });

      if (rows.length === 0) return;

      await Promise.allSettled(
        rows.map((r) => {
          if (monitorStopped) return Promise.resolve();
          // When on-chain listener is active, polling only handles TP/SL checks.
          // Pass [] as preloadedTrades to skip fetching new trades from the API.
          const trades = onChainListenerActive ? [] : undefined;
          return tickForTrader(r.traderAddress, sendNotification, trades);
        })
      );
    } catch (err: any) {
      logger.error(`[copy] Monitor tick error: ${err?.message}`);
    }
  };

  monitorInterval = setInterval(tick, intervalSeconds * 1_000);

  // Also run immediately on start
  tick().catch((err) => logger.error('[copy] Initial tick error:', err));
}

export function stopCopyTradeMonitor(): void {
  monitorStopped = true;
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    logger.info('[copy] Copy trade monitor stopped');
  }
  stopOnChainListener();
}

// ─── On-Chain WebSocket Listener ──────────────────────────────────────────────

const CTF_EXCHANGE_ADDRESS    = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE   = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

const ORDER_FILLED_ABI = [
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

// In-memory set of tracked trader addresses (lowercase). Refreshed periodically.
let activeTraderSet = new Set<string>();
let onChainListenerActive = false;
let managedWsProvider: ManagedWsProvider | null = null;
// Injected sendNotification from startCopyTradeMonitor — reused by on-chain handlers
let _sendNotification: ((telegramId: string, message: string, extra?: NotificationExtra) => Promise<void>) | null = null;

/**
 * Resolves a conditional token ID to its market conditionId and outcome.
 * Results are cached in Redis for 7 days (token↔market mapping is immutable).
 */
async function resolveToken(tokenId: string): Promise<{ conditionId: string; outcome: 'YES' | 'NO' } | null> {
  if (!tokenId || tokenId === '0') return null;
  const cacheKey = `ctf:token:${tokenId}`;
  const cached = await redisCache.get<{ conditionId: string; outcome: 'YES' | 'NO' }>(cacheKey);
  if (cached) return cached;

  try {
    const resp = await fetchWithRetry(
      `${CLOB_BASE}/markets?clob_token_ids=${tokenId}`,
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const markets: any[] = Array.isArray(data) ? data : (data?.data ?? []);
    if (!markets.length) return null;

    const market = markets[0];
    const conditionId: string = market.condition_id ?? market.conditionId ?? '';
    if (!conditionId) return null;

    const tokens: any[] = market.tokens ?? [];
    const tokenEntry = tokens.find((t: any) => t.token_id === tokenId);
    const outcome = (tokenEntry?.outcome ?? tokens[0]?.outcome ?? 'YES').toUpperCase() as 'YES' | 'NO';

    const result = { conditionId, outcome };
    await redisCache.set(cacheKey, result, 7 * 24 * 3600);
    return result;
  } catch {
    return null;
  }
}

/**
 * Parses an OrderFilled event into a DetectedTrade for the given leader address.
 * Returns null if the leader is not the maker or taker of this fill.
 */
async function parseOrderFilledEvent(
  args: {
    maker: string;
    taker: string;
    makerAssetId: ethers.BigNumber;
    takerAssetId: ethers.BigNumber;
    makerAmountFilled: ethers.BigNumber;
    takerAmountFilled: ethers.BigNumber;
  },
  leaderAddress: string,
): Promise<DetectedTrade | null> {
  const maker = args.maker.toLowerCase();
  const taker = args.taker.toLowerCase();
  const leader = leaderAddress.toLowerCase();

  const isLeaderMaker = maker === leader;
  const isLeaderTaker = taker === leader;
  if (!isLeaderMaker && !isLeaderTaker) return null;

  const makerBuys = args.makerAssetId.eq(0); // makerAssetId == 0 means maker provides USDC (buying shares)

  // Determine leader's side
  let side: 'BUY' | 'SELL';
  if (isLeaderMaker) {
    side = makerBuys ? 'BUY' : 'SELL';
  } else {
    // leader is taker: if maker buys, taker sells (provides shares); if maker sells, taker buys
    side = makerBuys ? 'SELL' : 'BUY';
  }

  // Resolve USDC and share amounts (all amounts in 1e6 units on Polymarket)
  const usdcAmtRaw  = makerBuys ? args.makerAmountFilled : args.takerAmountFilled;
  const shareAmtRaw = makerBuys ? args.takerAmountFilled : args.makerAmountFilled;
  const shareTokenId = (makerBuys ? args.takerAssetId : args.makerAssetId).toString();

  const size    = usdcAmtRaw.gt(0) && shareAmtRaw.gt(0) ? shareAmtRaw.toNumber() / 1e6 : 0;
  const sizeUsd = usdcAmtRaw.toNumber() / 1e6;
  const price   = size > 0 ? sizeUsd / size : 0;

  if (size <= 0 || !shareTokenId || shareTokenId === '0') return null;

  const resolved = await resolveToken(shareTokenId);
  if (!resolved) {
    logger.debug(`[copy:onchain] Could not resolve tokenId ${shareTokenId.slice(0, 20)}...`);
    return null;
  }

  return {
    traderAddress: leader,
    marketId:  resolved.conditionId,
    assetId:   shareTokenId,
    outcome:   resolved.outcome,
    side,
    size,
    sizeUsd,
    price,
    timestamp: Date.now(),
  };
}

/**
 * Refreshes the in-memory set of active trader addresses from the DB.
 */
export async function refreshOnChainFilters(): Promise<void> {
  const rows = await prisma.copySubscription.findMany({
    where: { isActive: true },
    select: { traderAddress: true },
    distinct: ['traderAddress'],
  });
  activeTraderSet = new Set(rows.map((r) => r.traderAddress.toLowerCase()));
  logger.debug(`[copy:onchain] Tracking ${activeTraderSet.size} trader address(es)`);
}

/**
 * Starts the on-chain WebSocket listener for CTFExchange OrderFilled events.
 * Only starts if config.polygonWssRpcUrl is set. Silently no-ops otherwise.
 */
export async function startOnChainListener(
  sendNotification: (telegramId: string, message: string, extra?: NotificationExtra) => Promise<void>,
): Promise<void> {
  if (!config.polygonWssRpcUrl) {
    logger.warn('[copy:onchain] POLYGON_WSS_RPC_URL not set — on-chain listener disabled, using polling only');
    return;
  }
  if (onChainListenerActive) return;

  _sendNotification = sendNotification;
  await refreshOnChainFilters();

  const wsm = createManagedWsProvider(config.polygonWssRpcUrl);
  managedWsProvider = wsm;

  wsm.onConnected((provider) => {
    onChainListenerActive = true;
    logger.info(`[copy:onchain] Listener active for ${activeTraderSet.size} trader(s)`);

    const attachListeners = (address: string, label: string) => {
      const contract = new ethers.Contract(address, ORDER_FILLED_ABI, provider);
      contract.on('OrderFilled', async (
        _orderHash: string,
        maker: string,
        taker: string,
        makerAssetId: ethers.BigNumber,
        takerAssetId: ethers.BigNumber,
        makerAmountFilled: ethers.BigNumber,
        takerAmountFilled: ethers.BigNumber,
        _fee: ethers.BigNumber,
      ) => {
        const makerLc = maker.toLowerCase();
        const takerLc = taker.toLowerCase();
        if (!activeTraderSet.has(makerLc) && !activeTraderSet.has(takerLc)) return;

        const leaders = new Set<string>();
        if (activeTraderSet.has(makerLc)) leaders.add(makerLc);
        if (activeTraderSet.has(takerLc)) leaders.add(takerLc);

        for (const leaderAddress of leaders) {
          try {
            const trade = await parseOrderFilledEvent(
              { maker, taker, makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled },
              leaderAddress,
            );
            if (!trade) continue;

            logger.info(`[copy:onchain] ${label} trade detected: ${trade.side} ${trade.outcome} $${trade.sizeUsd.toFixed(2)} for ${leaderAddress.slice(0, 8)}...`);

            if (_sendNotification) {
              tickForTrader(leaderAddress, _sendNotification, [trade]).catch((err) =>
                logger.error(`[copy:onchain] tickForTrader error: ${err?.message}`)
              );
            }
          } catch (err: any) {
            logger.warn(`[copy:onchain] Event parse error: ${err?.message}`);
          }
        }
      });
    };

    attachListeners(CTF_EXCHANGE_ADDRESS, 'CTF');
    attachListeners(NEG_RISK_CTF_EXCHANGE, 'NegRisk');
  });

  wsm.onDisconnected(() => {
    onChainListenerActive = false;
    logger.warn('[copy:onchain] Disconnected — polling fallback active until reconnect');
  });
}

export function stopOnChainListener(): void {
  if (managedWsProvider) {
    managedWsProvider.destroy();
    managedWsProvider = null;
  }
  onChainListenerActive = false;
  _sendNotification = null;
}
