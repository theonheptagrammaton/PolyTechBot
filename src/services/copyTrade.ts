import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { prisma } from '../database/prisma';
import { redisCache } from '../database/redis';
import { logger } from '../utils/logger';
import { decrypt } from '../utils/encryption';
import { config } from '../config';
import { getActivePositions, ActivePosition } from './portfolio';
import { createClobClientForUser } from './portfolio';
import { transferCommission, COMMISSION_RATE } from './commission';

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
  sizeUsd: number;    // shares * price
  price: number;
  timestamp: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses a Polymarket wallet address or profile URL into a normalized lowercase address.
 * Returns null if the input is not recognizable.
 */
export function parseTraderAddress(input: string): string | null {
  const trimmed = input.trim().toLowerCase();

  // Direct 0x address
  if (/^0x[a-f0-9]{40}$/.test(trimmed)) return trimmed;

  // polymarket.com/profile/0x...
  const profileMatch = trimmed.match(/polymarket\.com\/profile\/(0x[a-f0-9]{40})/i);
  if (profileMatch) return profileMatch[1].toLowerCase();

  return null;
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

// ─── Trade Detection ──────────────────────────────────────────────────────────

/**
 * Fetches recent MINED trades for a trader address from the CLOB API.
 * Uses Redis to remember the last-seen timestamp so we only process new trades.
 */
async function fetchNewTradesForTrader(traderAddress: string): Promise<DetectedTrade[]> {
  const redisKey = `copy:last_seen:${traderAddress}`;

  let lastSeen = 0;
  const cached = await redisCache.get<number>(redisKey);
  if (cached) lastSeen = cached;

  try {
    const url = `${DATA_API_BASE}/activity?user=${traderAddress}&limit=50`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });

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
  },
  trade: DetectedTrade,
  copySize: number
): Promise<ExecResult> {
  if (!user.polymarketProxyAddress) {
    return { status: 'skipped', errorMsg: 'no proxy address' };
  }

  try {
    const privateKey = decrypt(user.encryptedPrivateKey);
    const apiKey = decrypt(user.encryptedApiKey);
    const apiSecret = decrypt(user.encryptedApiSecret);
    const passphrase = decrypt(user.encryptedPassphrase);

    const wallet = new Wallet(privateKey);
    const clobClient = new ClobClient(
      config.polymarket.host,
      config.polymarket.chainId,
      wallet,
      { key: apiKey, secret: apiSecret, passphrase },
      2, // GNOSIS_SAFE signature type
      user.polymarketProxyAddress
    );

    // Fetch market info for tick size and negRisk
    let tickSize = '0.01';
    let isNegRisk = false;
    let tokenId = trade.assetId;

    try {
      const mResp = await fetch(`${CLOB_BASE}/markets/${trade.marketId}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (mResp.ok) {
        const m = await mResp.json();
        if (m.minimum_tick_size) tickSize = String(m.minimum_tick_size);
        if (m.neg_risk !== undefined) isNegRisk = !!m.neg_risk;
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
    const tick = parseFloat(tickSize);
    const decimals = tickSize.includes('.') ? tickSize.split('.')[1].length : 2;
    const slippagePct  = user.slippageTolerance ?? 1.0;
    const slippageMult = slippagePct / 100;

    let price: number;
    let size: number;
    let commissionAmt = 0; // only used for BUY

    if (isSell) {
      // For SELL: find user's position for this token and determine sell size proportionally
      const positions = await getActivePositions(user.polymarketProxyAddress);
      const pos = positions.find((p) => p.asset === tokenId);

      if (!pos || pos.size <= 0) {
        return { status: 'skipped', errorMsg: 'no matching position to sell' };
      }

      // Sell the same number of shares the trader sold, capped by the user's position.
      // If the trader sold MORE shares than the user holds, skip — we cannot proportionally
      // replicate the trade without knowing the trader's full position size.
      const traderShares = parseFloat((trade.sizeUsd / trade.price).toFixed(4));

      if (traderShares >= pos.size) {
        return { status: 'skipped', errorMsg: `trader sold ${traderShares.toFixed(4)} shares but user only holds ${pos.size.toFixed(4)}` };
      }

      size = traderShares;

      if (size < 1) {
        return { status: 'skipped', errorMsg: 'sell size too small' };
      }

      // Floor price = market price − user slippage%, snapped down to tick, min 0.01
      price = parseFloat(
        Math.max(Math.round((trade.price * (1 - slippageMult)) / tick) * tick, 0.01).toFixed(decimals)
      );
    } else {
      // For BUY
      commissionAmt = parseFloat((copySize * COMMISSION_RATE).toFixed(6));
      const tradeAmount = parseFloat((copySize - commissionAmt).toFixed(6));

      // Worst-case price = market price + user slippage%, snapped up to tick, max 0.99
      price = parseFloat(
        Math.min(Math.round((trade.price * (1 + slippageMult)) / tick) * tick, 0.99).toFixed(decimals)
      );
      // Estimated shares (for min-size guard only — FAK order passes USD amount)
      size = parseFloat((tradeAmount / price).toFixed(4));

      if (size < 0.01) {
        return { status: 'skipped', errorMsg: 'buy size too small' };
      }

      // FAK market order: pass USD amount, not shares
      const orderResp = await clobClient.createAndPostMarketOrder(
        { tokenID: tokenId, side: Side.BUY, amount: tradeAmount, price, feeRateBps: 0 } as any,
        { tickSize: tickSize as any, negRisk: isNegRisk },
        OrderType.FAK
      );

      if (!orderResp.success || !orderResp.orderID) {
        const errMsg = orderResp.errorMsg || (orderResp as any).error || 'order rejected';
        return { status: 'failed', errorMsg: errMsg };
      }

      // Collect commission for BUY trades (fire-and-forget)
      if (config.commission?.adminWalletAddress) {
        transferCommission(
          user.encryptedPrivateKey,
          user.polymarketProxyAddress,
          commissionAmt,
          user.id
        ).catch((err) =>
          logger.warn(`[copy] Commission transfer failed for user ${user.telegramId}: ${err?.message}`)
        );
      }

      return { status: 'filled', orderID: orderResp.orderID };
    }

    // SELL path: FAK market order, amount = shares
    const orderResp = await clobClient.createAndPostMarketOrder(
      { tokenID: tokenId, side: Side.SELL, amount: size, price, feeRateBps: 0 } as any,
      { tickSize: tickSize as any, negRisk: isNegRisk },
      OrderType.FAK
    );

    if (!orderResp.success || !orderResp.orderID) {
      const errMsg = orderResp.errorMsg || (orderResp as any).error || 'order rejected';
      return { status: 'failed', errorMsg: errMsg };
    }
    // (No commission on SELL)
    return { status: 'filled', orderID: orderResp.orderID };
  } catch (err: any) {
    return { status: 'failed', errorMsg: err?.message ?? 'unknown error' };
  }
}

// ─── Per-Trader Tick ──────────────────────────────────────────────────────────

/**
 * Processes all new trades for one trader address and executes copies for each subscriber.
 * `sendNotification` is injected so the service stays decoupled from Telegraf.
 */
async function tickForTrader(
  traderAddress: string,
  sendNotification: (telegramId: string, message: string) => Promise<void>
): Promise<void> {
  // Load active subscriptions first — needed for both new-trade processing and TP/SL checks
  const subs = await prisma.copySubscription.findMany({
    where: { traderAddress, isActive: true },
    include: { user: true },
  });

  if (subs.length === 0) return;

  const newTrades = await fetchNewTradesForTrader(traderAddress);

  if (newTrades.length > 0) {
  // Y5: Fetch balance once per user at tick start (not once per trade×subscription)
  const balanceCache = new Map<string, number>();
  // Fetch positions once per proxy address at tick start (needed for first-entry detection)
  const positionCache = new Map<string, ActivePosition[]>();

  for (const sub of subs) {
    if (balanceCache.has(sub.userId)) continue;
    try {
      const client = await createClobClientForUser(
        sub.user.encryptedPrivateKey,
        sub.user.encryptedApiKey,
        sub.user.encryptedApiSecret,
        sub.user.encryptedPassphrase
      );
      const balData = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' as any });
      balanceCache.set(sub.userId, balData?.balance ? parseFloat(balData.balance) / 1_000_000 : 0);
    } catch (err: any) {
      logger.warn(`[copy] Failed to fetch balance for user ${sub.user.telegramId}: ${err?.message}`);
      balanceCache.set(sub.userId, 0);
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

  for (const trade of newTrades) {
    for (const sub of subs) {
      const user = sub.user;

      // Auto-stop check using cached balance
      try {
        const balance = balanceCache.get(sub.userId) ?? 0;

        if (balance < sub.autoStopBelowBalance) {
          await prisma.copySubscription.update({
            where: { id: sub.id },
            data: { isActive: false },
          });

          const shortAddr = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
          await sendNotification(
            user.telegramId,
            `⚠️ *Copy Stopped — Low Balance*\n\n` +
            `Trader: \`${shortAddr}\`\n` +
            `Balance $${balance.toFixed(2)} < Minimum $${sub.autoStopBelowBalance.toFixed(2)}\n\n` +
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
          const shortAddr = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
          await sendNotification(
            user.telegramId,
            `⏭ *Trade Skipped*\n\n` +
            `Trader: \`${shortAddr}\`\n` +
            `Market: \`${trade.marketId.slice(0, 20)}...\`\n` +
            `Side: ${trade.side} ${trade.outcome}\n` +
            `Reason: Copy size below minimum`
          );
          continue;
        }

        // Execute the copy
        const result = await executeCopyOrder(user, trade, copySize);

        // Save to DB
        await prisma.copiedTrade.create({
          data: {
            userId: user.id,
            traderAddress,
            marketId: trade.marketId,
            assetId: trade.assetId || null,
            outcome: trade.outcome,
            side: trade.side,
            sourceSize: trade.sizeUsd,
            copiedSize: copySize,
            price: trade.price,
            orderID: result.orderID ?? null,
            status: result.status,
            errorMsg: result.errorMsg ?? null,
          },
        });

        // Send Telegram notification
        const shortAddr = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
        const modeLabel = sub.fixedAmount
          ? `$${sub.fixedAmount} fixed`
          : `×${(sub.multiplier ?? 1).toFixed(2)}`;
        const safeMd = (s: string) => s.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

        if (result.status === 'filled') {
          await sendNotification(
            user.telegramId,
            `✅ *Trade Copied*\n\n` +
            `Trader: \`${shortAddr}\`\n` +
            `Market: \`${trade.marketId.slice(0, 20)}...\`\n` +
            `Side: ${trade.side} ${trade.outcome}\n` +
            `Original: $${trade.sizeUsd.toFixed(2)}\n` +
            `Copied: $${copySize.toFixed(2)} (${modeLabel})\n` +
            `Order: \`${result.orderID}\``
          );
        } else if (result.status === 'failed') {
          await sendNotification(
            user.telegramId,
            `❌ *Copy Failed*\n\n` +
            `Market: \`${trade.marketId.slice(0, 20)}...\`\n` +
            `Error: ${safeMd(result.errorMsg ?? 'unknown error')}\n` +
            `Copy size: $${copySize.toFixed(2)}`
          );
        } else if (result.status === 'skipped') {
          // D2: Notify user when a trade was skipped (BUY or SELL)
          await sendNotification(
            user.telegramId,
            `⏭ *Trade Skipped*\n\n` +
            `Trader: \`${shortAddr}\`\n` +
            `Market: \`${trade.marketId.slice(0, 20)}...\`\n` +
            `Side: ${trade.side} ${trade.outcome}\n` +
            `Reason: ${safeMd(result.errorMsg ?? 'no position found')}`
          );
        }
      } catch (err: any) {
        logger.error(`[copy] Error processing sub ${sub.id}: ${err?.message}`);
      }
    }
  }
  } // end if (newTrades.length > 0)

  // TP/SL check — run once per subscription after all new trades are processed
  for (const sub of subs) {
    if (sub.takeProfitPct != null || sub.stopLossPct != null) {
      await checkTpSlPositions(
        sub.user,
        { traderAddress: sub.traderAddress, takeProfitPct: sub.takeProfitPct, stopLossPct: sub.stopLossPct },
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
  },
  sub: {
    traderAddress: string;
    takeProfitPct: number | null;
    stopLossPct: number | null;
  },
  sendNotification: (telegramId: string, msg: string) => Promise<void>
): Promise<void> {
  if (sub.takeProfitPct == null && sub.stopLossPct == null) return;

  // Find open BUY positions that have not yet been TP/SL exited
  const openPositions = await prisma.copiedTrade.findMany({
    where: {
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

    const tpPrice = sub.takeProfitPct != null
      ? pos.price * (1 + sub.takeProfitPct / 100)
      : null;
    const slPrice = sub.stopLossPct != null
      ? pos.price * (1 - sub.stopLossPct / 100)
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
      sizeUsd: pos.copiedSize,
      price: currentPrice,
      timestamp: Date.now(),
    };

    const result = await executeCopyOrder(user, syntheticTrade, pos.copiedSize);

    // Mark as TP/SL exited regardless of order result (prevents retry loops)
    await prisma.copiedTrade.update({
      where: { id: pos.id },
      data: { tpSlStatus: triggerType },
    });

    // Send notification
    const shortAddr = `${sub.traderAddress.slice(0, 6)}...${sub.traderAddress.slice(-4)}`;
    const entryFormatted = (pos.price * 100).toFixed(0) + '¢';
    const exitFormatted  = (currentPrice * 100).toFixed(0) + '¢';
    const changePct = ((currentPrice - pos.price) / pos.price * 100).toFixed(1);
    const changeSign = currentPrice >= pos.price ? '+' : '';
    const icon = triggerType === 'tp_triggered' ? '📈' : '🛑';
    const label = triggerType === 'tp_triggered' ? 'Take Profit Triggered' : 'Stop Loss Triggered';

    const statusLine = result.status === 'filled'
      ? `✅ Sell order placed`
      : result.status === 'skipped'
        ? `⏭ Skipped: ${result.errorMsg ?? ''}`
        : `❌ Error: ${result.errorMsg ?? 'unknown'}`;

    await sendNotification(
      user.telegramId,
      `${icon} *${label}*\n\n` +
      `Trader: \`${shortAddr}\`\n` +
      `Entry: ${entryFormatted}  →  Exit: ${exitFormatted}\n` +
      `Change: ${changeSign}${changePct}%\n` +
      statusLine
    );
  }
}

// ─── Monitor ──────────────────────────────────────────────────────────────────

let monitorInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the copy trade polling monitor.
 * Call once after bot.launch().
 * @param sendNotification Injected function to send Telegram messages.
 * @param intervalSeconds Polling interval (default: 30).
 */
export function startCopyTradeMonitor(
  sendNotification: (telegramId: string, message: string) => Promise<void>,
  intervalSeconds = 30
): void {
  if (monitorInterval) {
    logger.warn('[copy] Monitor already running — skipping duplicate start');
    return;
  }

  logger.info(`[copy] Starting copy trade monitor (interval: ${intervalSeconds}s)`);

  const tick = async () => {
    try {
      // Find all unique trader addresses with at least one active subscription
      const rows = await prisma.copySubscription.findMany({
        where: { isActive: true },
        select: { traderAddress: true },
        distinct: ['traderAddress'],
      });

      if (rows.length === 0) return;

      await Promise.allSettled(
        rows.map((r) => tickForTrader(r.traderAddress, sendNotification))
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
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    logger.info('[copy] Copy trade monitor stopped');
  }
}
