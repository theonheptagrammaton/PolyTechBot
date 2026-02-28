import { logger } from '../utils/logger';
import { redisCache } from '../database/redis';

const LEADERBOARD_API = 'https://data-api.polymarket.com/v1/leaderboard';
const DATA_API_BASE   = 'https://data-api.polymarket.com';
const CACHE_TTL       = 5 * 60; // 5 minutes
const ACTIVITY_LIMIT  = 500;    // fetch more trades for better win-rate accuracy

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SmartWalletInfo {
  address:        string;
  displayName:    string;
  copyCount:      number;   // PolyTech users who have ever copied this trader
  specialty:      string;   // Derived from market titles in activity feed
  pnlPct:         number;   // P&L % (pnl / vol × 100)
  pnlAbs:         number;   // Absolute P&L in USD (from leaderboard)
  volume:         number;   // Trading volume in USD (from leaderboard)
  tradeCount:     number;   // Total TRADE events in fetched activity window
  winRatePct:     number;   // Win rate % from SELL-based closed positions; -1 = insufficient data
  avgTradeSizeUsd: number;  // Average trade size in USD
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fetch top traders from Polymarket's official leaderboard. */
async function fetchLeaderboard(limit: number, timePeriod = 'ALL', orderBy = 'PNL'): Promise<any[]> {
  try {
    const url = `${LEADERBOARD_API}?timePeriod=${timePeriod}&orderBy=${orderBy}&limit=${limit}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      logger.warn(`[smartWallets] Leaderboard API ${res.status}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn('[smartWallets] Leaderboard fetch failed:', err);
    return [];
  }
}

/** Fetch recent activity trades for a wallet. */
async function fetchActivity(address: string): Promise<any[]> {
  try {
    const url = `${DATA_API_BASE}/activity?user=${address}&limit=${ACTIVITY_LIMIT}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (data?.data ?? []);
  } catch {
    return [];
  }
}

/** Derive specialty label from market titles in activity feed. */
function deriveSpecialty(trades: any[]): string {
  const text = trades
    .map(t => (t.title ?? t.question ?? t.marketQuestion ?? t.description ?? '').toLowerCase())
    .join(' ');

  if (/\b(btc|bitcoin|eth|ethereum|crypto|defi|token|solana|nft)\b/.test(text))                        return '₿ Crypto';
  if (/\b(election|president|vote|trump|harris|democrat|republican|senate|congress|politics)\b/.test(text)) return '🏛️ Politics';
  if (/\b(esport|gaming|game|valorant|dota|counter.strike|cs2|league of legends)\b/.test(text))        return '🎮 E-Sports';
  if (/\b(nba|nfl|soccer|football|basketball|tennis|sport|league|championship|world cup|ufc)\b/.test(text)) return '⚽ Sports';
  if (/\b(ai|openai|gpt|claude|tech|apple|microsoft|google|nvidia)\b/.test(text))                      return '💻 Tech';
  if (/\b(war|russia|ukraine|israel|conflict|military|nato|geopolit)\b/.test(text))                    return '🌍 Geopolitics';
  if (/\b(celebrity|oscar|emmy|grammy|taylor|entertainment|music|film|movie|tv)\b/.test(text))         return '🎬 Entertainment';

  return '📊 General';
}

/** Extract USD value from an activity record. */
function tradeValue(t: any): number {
  const usdcSize = typeof t.usdcSize === 'number' ? t.usdcSize : parseFloat(t.usdcSize ?? '0');
  const size     = typeof t.size    === 'number' ? t.size    : parseFloat(t.size    ?? '0');
  const price    = typeof t.price   === 'number' ? t.price   : parseFloat(t.price   ?? '0');
  return usdcSize > 0 ? usdcSize : size * price;
}

/**
 * Analyse activity feed to produce tradeCount, winRatePct, and avgTradeSizeUsd.
 *
 * Win rate is computed ONLY from explicit SELL exits (not REDEEMs) because:
 * - REDEEM events (market resolved in trader's favour) are always wins →
 *   including them would inflate win rate to ~100% for all top traders.
 * - Losing positions that expire worthless generate NO activity event, so
 *   losses are invisible regardless of approach.
 *
 * A SELL-based rate gives meaningful variation:
 * - Traders who frequently sell partial positions have real exit data.
 * - Traders who never sell (only redeem) return winRatePct = -1 (N/A).
 * - Minimum 5 sell-closed markets required for a meaningful %; below that → -1.
 */
function analyseActivity(trades: any[]): {
  tradeCount:     number;
  winRatePct:     number;
  avgTradeSizeUsd: number;
} {
  const marketBuys  = new Map<string, number>(); // conditionId → total USD spent
  const marketSells = new Map<string, number>(); // conditionId → total USD received
  let tradeCount   = 0;
  let totalUsd     = 0;

  for (const t of trades) {
    const type = (t.type ?? 'TRADE').toUpperCase();
    if (type !== 'TRADE') continue;

    const side = t.side ?? '';
    if (side !== 'BUY' && side !== 'SELL') continue;

    const conditionId = t.conditionId ?? '';
    const value       = tradeValue(t);

    tradeCount++;
    totalUsd += value;

    if (!conditionId) continue;

    if (side === 'BUY') {
      marketBuys.set(conditionId,  (marketBuys.get(conditionId)  ?? 0) + value);
    } else {
      marketSells.set(conditionId, (marketSells.get(conditionId) ?? 0) + value);
    }
  }

  // Win rate: only SELL-closed markets (both a BUY and a SELL seen in window)
  let closedCount = 0;
  let wins        = 0;

  for (const [cid, sellTotal] of marketSells.entries()) {
    const buyTotal = marketBuys.get(cid);
    if (buyTotal == null) continue; // SELL without a matching BUY in window → skip
    closedCount++;
    if (sellTotal > buyTotal) wins++;
  }

  const winRatePct    = closedCount >= 5
    ? parseFloat((wins / closedCount * 100).toFixed(1))
    : -1; // not enough data

  const avgTradeSizeUsd = tradeCount > 0
    ? parseFloat((totalUsd / tradeCount).toFixed(0))
    : 0;

  return { tradeCount, winRatePct, avgTradeSizeUsd };
}

/** Format a USD amount compactly: 382544 → "$382.5K", 1200000 → "$1.2M" */
export function fmtUsd(n: number | undefined | null): string {
  const num = (n == null || isNaN(n as number)) ? 0 : (n as number);
  const abs = Math.abs(num);
  if (abs >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Returns top `limit` traders from Polymarket's all-time PnL leaderboard.
 * Enriched with win rate, trade count, and specialty from the activity feed.
 * Results are cached for 5 minutes.
 */
export async function getTopSmartWallets(
  limit = 50,
  timePeriod = 'ALL',
  orderBy = 'PNL',
): Promise<SmartWalletInfo[]> {
  const cacheKey = `sw:v7:${limit}:${timePeriod}:${orderBy}`;
  const cached = await redisCache.get<SmartWalletInfo[]>(cacheKey);
  if (cached && cached.length > 0) return cached;

  const entries = await fetchLeaderboard(limit, timePeriod, orderBy);
  if (entries.length === 0) return [];

  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      const address = (entry.proxyWallet ?? '').toLowerCase();
      if (!address) return null;

      const [, activity] = await Promise.all([
        Promise.resolve(0), // copyCount removed from display
        fetchActivity(address),
      ]);

      const pnlAbs = typeof entry.pnl === 'number' ? entry.pnl : 0;
      const volAbs = typeof entry.vol === 'number' ? entry.vol : 0;
      const pnlPct = volAbs > 0
        ? parseFloat((pnlAbs / volAbs * 100).toFixed(1))
        : 0;

      const { tradeCount, winRatePct, avgTradeSizeUsd } = analyseActivity(activity);

      const rawName = entry.userName ?? '';
      const displayName = rawName && rawName !== 'Anonymous'
        ? rawName
        : `${address.slice(0, 6)}...${address.slice(-4)}`;

      return {
        address,
        displayName,
        copyCount:       0,
        specialty:       deriveSpecialty(activity),
        pnlPct,
        pnlAbs,
        volume:          volAbs,
        tradeCount,
        winRatePct,
        avgTradeSizeUsd,
      } as SmartWalletInfo;
    })
  );

  const wallets = results
    .filter((r): r is PromiseFulfilledResult<SmartWalletInfo> =>
      r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  if (wallets.length > 0) {
    await redisCache.set(cacheKey, wallets, CACHE_TTL);
  }

  logger.info(`[smartWallets] Loaded ${wallets.length} wallets (all-time leaderboard)`);
  return wallets;
}
