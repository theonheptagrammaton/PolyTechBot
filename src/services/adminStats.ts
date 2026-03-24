import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { redisCache } from '../database/redis';

const DATA_API = 'https://data-api.polymarket.com';
const FETCH_TIMEOUT_MS = 8_000;

export interface AdminStats {
  // Users
  totalUsers: number;
  activeUsers: number;
  walletUsers: number;
  newUsersToday: number;
  newUsersWeek: number;
  newUsersMonth: number;
  copyTradeActiveUsers: number;

  // Trading Volume (from CLOB API, parallel fetch)
  volumeTotal: number;
  volumeToday: number;
  volumeWeek: number;
  volumeMonth: number;
  totalTrades: number;
  tradesToday: number;
  tradesWeek: number;
  tradesMonth: number;

  // Commission / Revenue (from DB — accurate going forward)
  commissionTotal: number;
  commissionToday: number;
  commissionWeek: number;
  commissionMonth: number;

  // Cashback
  cashbackTotal: number;

  // Referral
  totalReferrals: number;
  referralEarnedTotal: number;
  topReferrers: { name: string; count: number; earned: number }[];

  // Copy Trade
  totalSubscriptions: number;
  activeSubscriptions: number;
  copiedFilled: number;
  copiedFailed: number;
  copiedSkipped: number;
  copiedToday: number;
  copiedWeek: number;

  generatedAt: string;
}

const VOLUME_CACHE_KEY = 'admin:stats:volume';
const VOLUME_CACHE_TTL = 15 * 60; // 15 min — CLOB fetch is slow

/**
 * Fetches trading volume from CLOB API for all credentialed users in parallel.
 * Cached separately for 15 minutes.
 */
async function fetchClobVolume(forceRefresh: boolean, dayAgo: Date, weekAgo: Date, monthAgo: Date) {
  if (!forceRefresh) {
    const cached = await redisCache.get<{
      volumeTotal: number; volumeToday: number; volumeWeek: number; volumeMonth: number;
      totalTrades: number; tradesToday: number; tradesWeek: number; tradesMonth: number;
    }>(VOLUME_CACHE_KEY).catch(() => null);
    if (cached) return cached;
  }

  // Use proxy wallet addresses — Data API is public, no auth needed
  const users = await prisma.user.findMany({
    where: { isActive: true, polymarketProxyAddress: { not: null } },
    select: { polymarketProxyAddress: true },
  });

  logger.info(`[adminStats] Fetching activity for ${users.length} proxy wallets from Data API...`);

  const dayAgoTs   = dayAgo.getTime()   / 1000;
  const weekAgoTs  = weekAgo.getTime()  / 1000;
  const monthAgoTs = monthAgo.getTime() / 1000;

  const fetchUserActivity = async (proxyAddress: string): Promise<{ usd: number; ts: number }[]> => {
    try {
      const resp = await fetch(
        `${DATA_API}/activity?user=${proxyAddress}&limit=500`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
      );
      if (!resp.ok) return [];
      const data = await resp.json();
      const items: any[] = Array.isArray(data) ? data : [];
      return items
        .map(t => ({
          usd: t.usdcSize ? parseFloat(t.usdcSize) : (parseFloat(t.size ?? '0') * parseFloat(t.price ?? '0')),
          ts:  typeof t.timestamp === 'number' ? t.timestamp : parseInt(t.timestamp ?? '0', 10),
        }))
        .filter(t => t.usd > 0 && t.ts > 0);
    } catch {
      return [];
    }
  };

  // Fetch all in parallel — Data API is public and handles concurrent requests fine
  const allResults = await Promise.allSettled(
    users.map(u => fetchUserActivity(u.polymarketProxyAddress!))
  );

  let volumeTotal = 0, volumeToday = 0, volumeWeek = 0, volumeMonth = 0;
  let totalTrades = 0, tradesToday = 0, tradesWeek = 0, tradesMonth = 0;

  for (const res of allResults) {
    if (res.status !== 'fulfilled') continue;
    for (const { usd, ts } of res.value) {
      volumeTotal += usd;
      totalTrades += 1;
      if (ts >= dayAgoTs)   { volumeToday += usd; tradesToday += 1; }
      if (ts >= weekAgoTs)  { volumeWeek  += usd; tradesWeek  += 1; }
      if (ts >= monthAgoTs) { volumeMonth += usd; tradesMonth += 1; }
    }
  }

  const result = {
    volumeTotal: parseFloat(volumeTotal.toFixed(2)),
    volumeToday: parseFloat(volumeToday.toFixed(2)),
    volumeWeek:  parseFloat(volumeWeek.toFixed(2)),
    volumeMonth: parseFloat(volumeMonth.toFixed(2)),
    totalTrades, tradesToday, tradesWeek, tradesMonth,
  };

  await redisCache.set(VOLUME_CACHE_KEY, result, VOLUME_CACHE_TTL).catch(() => {});
  logger.info(`[adminStats] Volume: $${volumeTotal.toFixed(2)} across ${totalTrades} trades`);
  return result;
}

export async function getAdminStats(forceRefresh = false): Promise<AdminStats> {
  const cacheKey = 'admin:stats:v3';
  if (!forceRefresh) {
    const cached = await redisCache.get<AdminStats>(cacheKey).catch(() => null);
    if (cached) return cached;
  }

  logger.info('[adminStats] Calculating...');

  const now = new Date();
  const dayAgo   = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // DB queries + CLOB volume in parallel
  const [
    dbResults,
    volumeData,
  ] = await Promise.all([
    Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { polymarketProxyAddress: { not: null } } }),
      prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: monthAgo } } }),
      prisma.user.count({ where: { copySubscriptions: { some: { isActive: true, isPaused: false } } } }),
      prisma.commissionLog.aggregate({ _sum: { amount: true } }),
      prisma.commissionLog.aggregate({ _sum: { amount: true }, where: { createdAt: { gte: dayAgo } } }),
      prisma.commissionLog.aggregate({ _sum: { amount: true }, where: { createdAt: { gte: weekAgo } } }),
      prisma.commissionLog.aggregate({ _sum: { amount: true }, where: { createdAt: { gte: monthAgo } } }),
      prisma.user.aggregate({ _sum: { cashbackEarnedTotal: true } }),
      prisma.user.count({ where: { referredById: { not: null } } }),
      prisma.user.aggregate({ _sum: { referralEarnedTotal: true } }),
      prisma.user.groupBy({
        by: ['referredById'],
        where: { referredById: { not: null } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 3,
      }),
      prisma.copySubscription.count(),
      prisma.copySubscription.count({ where: { isActive: true, isPaused: false } }),
      prisma.copiedTrade.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.copiedTrade.count({ where: { createdAt: { gte: dayAgo  }, status: 'filled' } }),
      prisma.copiedTrade.count({ where: { createdAt: { gte: weekAgo }, status: 'filled' } }),
    ]),
    fetchClobVolume(forceRefresh, dayAgo, weekAgo, monthAgo),
  ]);

  const [
    totalUsers, activeUsers, walletUsers,
    newUsersToday, newUsersWeek, newUsersMonth,
    copyTradeActiveUsers,
    commissionAgg, commissionTodayAgg, commissionWeekAgg, commissionMonthAgg,
    cashbackAgg,
    totalReferrals, referralAgg, topReferrerRows,
    totalSubscriptions, activeSubscriptions,
    copiedStatusGroups, copiedToday, copiedWeek,
  ] = dbResults;

  // Resolve top referrer names
  const topReferrers: { name: string; count: number; earned: number }[] = [];
  for (const row of topReferrerRows) {
    if (!row.referredById) continue;
    const u = await prisma.user.findUnique({
      where: { id: row.referredById },
      select: { username: true, firstName: true, referralEarnedTotal: true },
    });
    const name = u?.username ? `@${u.username}` : (u?.firstName ?? row.referredById.slice(0, 8));
    topReferrers.push({ name, count: row._count.id, earned: u?.referralEarnedTotal ?? 0 });
  }

  const statusMap = Object.fromEntries(copiedStatusGroups.map(g => [g.status, g._count.id]));

  const stats: AdminStats = {
    totalUsers, activeUsers, walletUsers,
    newUsersToday, newUsersWeek, newUsersMonth,
    copyTradeActiveUsers,

    ...volumeData,

    commissionTotal:  commissionAgg._sum.amount       ?? 0,
    commissionToday:  commissionTodayAgg._sum.amount  ?? 0,
    commissionWeek:   commissionWeekAgg._sum.amount   ?? 0,
    commissionMonth:  commissionMonthAgg._sum.amount  ?? 0,

    cashbackTotal: cashbackAgg._sum.cashbackEarnedTotal ?? 0,

    totalReferrals,
    referralEarnedTotal: referralAgg._sum.referralEarnedTotal ?? 0,
    topReferrers,

    totalSubscriptions, activeSubscriptions,
    copiedFilled:  statusMap['filled']  ?? 0,
    copiedFailed:  statusMap['failed']  ?? 0,
    copiedSkipped: statusMap['skipped'] ?? 0,
    copiedToday, copiedWeek,

    generatedAt: now.toISOString(),
  };

  await redisCache.set(cacheKey, stats, 300).catch(() => {});
  logger.info('[adminStats] Done');
  return stats;
}

export function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

export function formatStatsMessage(s: AdminStats): string {
  let m = '📊 *ADMIN STATISTICS*\n\n';

  m += '👥 *USERS*\n';
  m += `├ Total: *${s.totalUsers}* · Active: *${s.activeUsers}* · With Wallet: *${s.walletUsers}*\n`;
  m += `├ New Today: *${s.newUsersToday}* · Week: *${s.newUsersWeek}* · Month: *${s.newUsersMonth}*\n`;
  m += `└ Copy Trade Users: *${s.copyTradeActiveUsers}*\n\n`;

  m += '📈 *TRADING VOLUME*\n';
  m += `├ Today: *${formatVolume(s.volumeToday)}* (${s.tradesToday} trades)\n`;
  m += `├ This Week: *${formatVolume(s.volumeWeek)}* (${s.tradesWeek} trades)\n`;
  m += `├ This Month: *${formatVolume(s.volumeMonth)}* (${s.tradesMonth} trades)\n`;
  m += `└ All Time: *${formatVolume(s.volumeTotal)}* (${s.totalTrades} trades)\n\n`;

  m += '💰 *COMMISSION (REVENUE)*\n';
  m += `├ Today: *${formatVolume(s.commissionToday)}*\n`;
  m += `├ This Week: *${formatVolume(s.commissionWeek)}*\n`;
  m += `├ This Month: *${formatVolume(s.commissionMonth)}*\n`;
  m += `├ All Time: *${formatVolume(s.commissionTotal)}*\n`;
  m += `└ Cashback Paid: *${formatVolume(s.cashbackTotal)}*\n\n`;

  m += '🔗 *REFERRAL*\n';
  m += `├ Total Referred Users: *${s.totalReferrals}*\n`;
  m += `├ Total Referral Paid: *${formatVolume(s.referralEarnedTotal)}*\n`;
  if (s.topReferrers.length > 0) {
    m += `└ Top Referrers:\n`;
    s.topReferrers.forEach((r, i) => {
      const prefix = i === s.topReferrers.length - 1 ? '     └' : '     ├';
      m += `${prefix} ${r.name} — *${r.count}* refs · *${formatVolume(r.earned)}* earned\n`;
    });
  } else {
    m += `└ No referrals yet\n`;
  }
  m += '\n';

  m += '⚡ *COPY TRADE*\n';
  m += `├ Subscriptions: *${s.totalSubscriptions}* total · *${s.activeSubscriptions}* active\n`;
  m += `├ Filled: *${s.copiedFilled}* · Failed: *${s.copiedFailed}* · Skipped: *${s.copiedSkipped}*\n`;
  m += `└ Copied Today: *${s.copiedToday}* · This Week: *${s.copiedWeek}*\n\n`;

  m += `🕒 _Generated: ${new Date(s.generatedAt).toLocaleString()}_\n`;
  m += `_Volume cached 15 min · Commission from DB_`;

  return m;
}
