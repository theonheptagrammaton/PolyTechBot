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
  specialty:      string;   // Primary specialty (first/dominant)
  specialties:    string[]; // All matched specialties from activity feed
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

/**
 * Category patterns: label → regex.
 * Order matters only for the "primary" specialty pick (first match wins).
 */
const SPECIALTY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: '₿ Crypto',        re: /\b(btc|bitcoin|eth|ethereum|crypto|defi|token|solana|nft|altcoin|web3|blockchain)\b/ },
  { label: '🏛️ Politics',    re: /\b(election|president|vote|trump|harris|democrat|republican|senate|congress|politics|ballot|primary|campaign|white house|supreme court|legislation)\b/ },
  { label: '⚽ Sports',       re: /\b(nba|nfl|nhl|mlb|soccer|football|basketball|tennis|sport|league|championship|world cup|ufc|boxing|formula|f1|grand prix|olympics|gold medal|medal|player|team|coach|season|playoffs|finals|bracket)\b/ },
  { label: '🎮 E-Sports',     re: /\b(esport|gaming|valorant|dota|counter.strike|cs2|league of legends|overwatch|rocket league|fortnite|apex legends|twitch)\b/ },
  { label: '💻 Tech',         re: /\b(apple|microsoft|google|meta|amazon|tesla|nvidia|intel|samsung|iphone|android|macos|windows|startup|ipo|acquisition|merger|ceo|product launch)\b/ },
  { label: '🤖 AI',           re: /\b(ai|openai|gpt|chatgpt|claude|anthropic|gemini|llm|machine learning|artificial intelligence|midjourney|stable diffusion|agi)\b/ },
  { label: '🌍 Geopolitics',  re: /\b(war|russia|ukraine|israel|conflict|military|nato|geopolit|china|taiwan|iran|north korea|sanction|treaty|invasion|border|coup|ceasefire)\b/ },
  { label: '💵 Finance',      re: /\b(stocks?|s&p|nasdaq|dow|fed|interest rate|inflation|gdp|bond|gold|oil|commodity|earnings|treasury|yield|recession|ecb|forex|currency|usd|eur|jpy|gbp|central bank)\b/ },
  { label: '🎬 Entertainment', re: /\b(celebrity|oscar|emmy|grammy|taylor|entertainment|music|film|movie|tv|series|netflix|box office|award|grammy|billboard|album|concert|actor|actress)\b/ },
];

/**
 * Derive ALL matching specialties from market titles in activity feed.
 * Returns array of matched labels; falls back to ['📊 General'] if none match.
 * First element is the "primary" specialty (highest trade-count category).
 */
function deriveSpecialties(trades: any[]): string[] {
  // Build per-category trade counts using only TRADE events
  const counts = new Map<string, number>();

  for (const t of trades) {
    const type = (t.type ?? 'TRADE').toUpperCase();
    if (type !== 'TRADE') continue;

    const text = (t.title ?? t.question ?? t.marketQuestion ?? t.description ?? '').toLowerCase();
    if (!text) continue;

    for (const { label, re } of SPECIALTY_PATTERNS) {
      if (re.test(text)) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }

  if (counts.size === 0) return ['📊 General'];

  // Sort by trade count descending; return all with at least 1 trade
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);

  return sorted;
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
  limit = 100,
  timePeriod: 'DAY' | 'WEEK' | 'MONTH' | 'ALL' = 'ALL',
  orderBy: 'PNL' | 'VOL' = 'PNL',
): Promise<SmartWalletInfo[]> {
  const cacheKey = `sw:v8:${limit}:${timePeriod}:${orderBy}`;
  const cached = await redisCache.get<SmartWalletInfo[]>(cacheKey);
  if (cached && cached.length > 0) return cached;

  const entries = await fetchLeaderboard(limit, timePeriod, orderBy);
  if (entries.length === 0) return [];

  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      const address = (entry.proxyWallet ?? '').toLowerCase();
      if (!address) return null;

      const activity = await fetchActivity(address);

      const pnlAbs = typeof entry.pnl === 'number' ? entry.pnl : 0;
      const volAbs = typeof entry.vol === 'number' ? entry.vol : 0;
      const pnlPct = volAbs > 0
        ? parseFloat((pnlAbs / volAbs * 100).toFixed(1))
        : 0;

      const { tradeCount, winRatePct, avgTradeSizeUsd } = analyseActivity(activity);
      const specialties = deriveSpecialties(activity);

      const rawName = entry.userName ?? '';
      const displayName = rawName && rawName !== 'Anonymous'
        ? rawName
        : `${address.slice(0, 6)}...${address.slice(-4)}`;

      return {
        address,
        displayName,
        copyCount:       0,
        specialty:       specialties[0], // primary (highest trade count)
        specialties,
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

// ─── Single Trader Stats ──────────────────────────────────────────────────────

export interface TraderStats {
  displayName: string;
  winRatePct: number;   // -1 = not enough data
  tradeCount: number;
  pnlAbs: number | null;
}

/**
 * Fetches profile stats for an arbitrary trader address.
 * Used in the copy-add review step.
 */
export async function fetchTraderStats(address: string): Promise<TraderStats> {
  const addr = address.toLowerCase();

  const [activityResult, profileResult, closedResult] = await Promise.allSettled([
    fetchActivity(addr),
    fetch(`https://gamma-api.polymarket.com/users?address=${addr}`, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`https://data-api.polymarket.com/closed-positions?user=${addr}&limit=500`, {
      signal: AbortSignal.timeout(6000),
      headers: { Accept: 'application/json' },
    }).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  const trades = activityResult.status === 'fulfilled' ? activityResult.value : [];
  const { tradeCount, winRatePct } = analyseActivity(trades);

  const profileData = profileResult.status === 'fulfilled' ? profileResult.value : null;
  const profileArr  = Array.isArray(profileData) ? profileData : (profileData ? [profileData] : []);
  const profile     = profileArr[0] ?? null;
  const rawName     = profile?.name ?? profile?.username ?? profile?.pseudonym ?? '';
  const displayName = rawName && rawName !== 'Anonymous'
    ? rawName
    : `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const closedData = closedResult.status === 'fulfilled' ? closedResult.value : null;
  const closedArr  = Array.isArray(closedData) ? closedData : [];
  const pnlAbs     = closedArr.length > 0
    ? closedArr.reduce((sum: number, p: any) => sum + (typeof p.realizedPnl === 'number' ? p.realizedPnl : 0), 0)
    : null;

  return { displayName, winRatePct, tradeCount, pnlAbs };
}
