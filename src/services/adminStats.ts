import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { redisCache } from '../database/redis';

export interface AdminStats {
  // Users
  totalUsers: number;
  activeUsers: number;
  walletUsers: number;
  newUsersToday: number;
  newUsersWeek: number;
  newUsersMonth: number;
  copyTradeActiveUsers: number;

  // Commission / Revenue
  commissionTotal: number;
  commissionToday: number;
  commissionWeek: number;
  commissionMonth: number;
  estimatedVolumeTotal: number;

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

const COMMISSION_RATE = 0.01; // 1%

export async function getAdminStats(forceRefresh = false): Promise<AdminStats> {
  const cacheKey = 'admin:stats:v2';
  if (!forceRefresh) {
    const cached = await redisCache.get<AdminStats>(cacheKey).catch(() => null);
    if (cached) return cached;
  }

  logger.info('[adminStats] Calculating...');

  const now = new Date();
  const dayAgo   = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    activeUsers,
    walletUsers,
    newUsersToday,
    newUsersWeek,
    newUsersMonth,
    copyTradeActiveUsers,
    commissionAgg,
    commissionToday,
    commissionWeek,
    commissionMonth,
    cashbackAgg,
    totalReferrals,
    referralAgg,
    topReferrerRows,
    totalSubscriptions,
    activeSubscriptions,
    copiedStatusGroups,
    copiedToday,
    copiedWeek,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isActive: true } }),
    prisma.user.count({ where: { polymarketProxyAddress: { not: null } } }),
    prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: monthAgo } } }),
    // Users with at least 1 active non-paused subscription
    prisma.user.count({
      where: { copySubscriptions: { some: { isActive: true, isPaused: false } } },
    }),

    // Commission totals
    prisma.commissionLog.aggregate({ _sum: { amount: true } }),
    prisma.commissionLog.aggregate({ _sum: { amount: true }, where: { createdAt: { gte: dayAgo } } }),
    prisma.commissionLog.aggregate({ _sum: { amount: true }, where: { createdAt: { gte: weekAgo } } }),
    prisma.commissionLog.aggregate({ _sum: { amount: true }, where: { createdAt: { gte: monthAgo } } }),

    // Cashback
    prisma.user.aggregate({ _sum: { cashbackEarnedTotal: true } }),

    // Referrals
    prisma.user.count({ where: { referredById: { not: null } } }),
    prisma.user.aggregate({ _sum: { referralEarnedTotal: true } }),

    // Top 3 referrers — count of users they referred
    prisma.user.groupBy({
      by: ['referredById'],
      where: { referredById: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 3,
    }),

    // Copy trade subscriptions
    prisma.copySubscription.count(),
    prisma.copySubscription.count({ where: { isActive: true, isPaused: false } }),

    // Copied trade status breakdown
    prisma.copiedTrade.groupBy({ by: ['status'], _count: { id: true } }),

    // Copied trades today / this week
    prisma.copiedTrade.count({ where: { createdAt: { gte: dayAgo }, status: 'filled' } }),
    prisma.copiedTrade.count({ where: { createdAt: { gte: weekAgo }, status: 'filled' } }),
  ]);

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

  // Flatten copied trade status counts
  const statusMap = Object.fromEntries(copiedStatusGroups.map(g => [g.status, g._count.id]));

  const commissionTotal = commissionAgg._sum.amount ?? 0;

  const stats: AdminStats = {
    totalUsers,
    activeUsers,
    walletUsers,
    newUsersToday,
    newUsersWeek,
    newUsersMonth,
    copyTradeActiveUsers,

    commissionTotal,
    commissionToday:  commissionToday._sum.amount  ?? 0,
    commissionWeek:   commissionWeek._sum.amount   ?? 0,
    commissionMonth:  commissionMonth._sum.amount  ?? 0,
    estimatedVolumeTotal: COMMISSION_RATE > 0 ? commissionTotal / COMMISSION_RATE : 0,

    cashbackTotal: cashbackAgg._sum.cashbackEarnedTotal ?? 0,

    totalReferrals,
    referralEarnedTotal: referralAgg._sum.referralEarnedTotal ?? 0,
    topReferrers,

    totalSubscriptions,
    activeSubscriptions,
    copiedFilled:  statusMap['filled']  ?? 0,
    copiedFailed:  statusMap['failed']  ?? 0,
    copiedSkipped: statusMap['skipped'] ?? 0,
    copiedToday,
    copiedWeek,

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

  m += '💰 *COMMISSION (REVENUE)*\n';
  m += `├ All Time: *${formatVolume(s.commissionTotal)}*\n`;
  m += `├ Today: *${formatVolume(s.commissionToday)}*\n`;
  m += `├ This Week: *${formatVolume(s.commissionWeek)}*\n`;
  m += `├ This Month: *${formatVolume(s.commissionMonth)}*\n`;
  m += `├ Est. Total Volume: *${formatVolume(s.estimatedVolumeTotal)}*\n`;
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
  m += `_Cached 5 min · Commission tracked from DB_`;

  return m;
}
