const express = require('express');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
const COMMISSION_RATE = 0.01; // 1% — volume = commission / rate

if (!DASHBOARD_TOKEN) {
  console.error('DASHBOARD_TOKEN env var is required');
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth middleware ---
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = header.slice(7);
  if (token !== DASHBOARD_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Auth endpoint (unprotected) ---
app.post('/api/auth', (req, res) => {
  const { token } = req.body;
  if (token === DASHBOARD_TOKEN) {
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid token' });
});

// Protect all other /api/* routes
app.use('/api', authMiddleware);

// --- Period helper ---
function periodToDate(period) {
  if (!period || period === 'all') return null;
  if (period === 'today') {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  const now = new Date();
  const map = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
  };
  const ms = map[period];
  if (!ms) return null;
  return new Date(now.getTime() - ms);
}

function truncUnit(period) {
  return (period === '24h' || period === 'today') ? 'hour' : 'day';
}

// --- Overview KPIs ---
app.get('/api/stats/overview', async (req, res) => {
  try {
    const since = periodToDate(req.query.period);
    const dateFilter = since ? { createdAt: { gte: since } } : {};

    const [totalUsers, totalTrades, commissionAgg, activeSubs, filledTrades, failedTrades, skippedTrades, activeBondStrats, activeUpdownStrats, totalBondTrades, totalUpdownTrades] = await Promise.all([
      prisma.user.count({ where: dateFilter }),
      prisma.copiedTrade.count({ where: dateFilter }),
      prisma.commissionLog.aggregate({ where: dateFilter, _sum: { amount: true } }),
      prisma.copySubscription.count({ where: { isActive: true, isPaused: false } }),
      prisma.copiedTrade.count({ where: { ...dateFilter, status: 'filled' } }),
      prisma.copiedTrade.count({ where: { ...dateFilter, status: 'failed' } }),
      prisma.copiedTrade.count({ where: { ...dateFilter, status: 'skipped' } }),
      prisma.bondStrategy.count({ where: { isActive: true, isPaused: false } }),
      prisma.upDownStrategy.count({ where: { isActive: true, isPaused: false } }),
      prisma.bondTrade.count({ where: dateFilter }),
      prisma.upDownTrade.count({ where: dateFilter }),
    ]);

    const totalCommission = commissionAgg._sum.amount || 0;

    res.json({
      totalUsers,
      totalTrades,
      filledTrades,
      failedTrades,
      skippedTrades,
      totalVolume: totalCommission / COMMISSION_RATE,
      totalCommission,
      activeSubs,
      activeBondStrats,
      activeUpdownStrats,
      totalBondTrades,
      totalUpdownTrades,
    });
  } catch (err) {
    console.error('overview error:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// --- Users time-series ---
app.get('/api/stats/users', async (req, res) => {
  try {
    const since = periodToDate(req.query.period);
    const unit = truncUnit(req.query.period);
    const dateClause = since ? `WHERE "createdAt" >= '${since.toISOString()}'` : '';

    const newUsers = await prisma.$queryRawUnsafe(`
      SELECT DATE_TRUNC('${unit}', "createdAt") AS date, COUNT(*)::int AS count
      FROM users ${dateClause}
      GROUP BY date ORDER BY date
    `);

    // Active users = users who have at least 1 copied trade in period
    const activeClause = since ? `WHERE ct."createdAt" >= '${since.toISOString()}'` : '';
    const activeUsers = await prisma.$queryRawUnsafe(`
      SELECT DATE_TRUNC('${unit}', ct."createdAt") AS date, COUNT(DISTINCT ct."userId")::int AS count
      FROM copied_trades ct ${activeClause}
      GROUP BY date ORDER BY date
    `);

    // Cumulative users
    const cumulative = await prisma.$queryRawUnsafe(`
      SELECT date, SUM(count) OVER (ORDER BY date) AS cumulative FROM (
        SELECT DATE_TRUNC('${unit}', "createdAt") AS date, COUNT(*)::int AS count
        FROM users ${dateClause}
        GROUP BY date
      ) sub ORDER BY date
    `);

    const totalUsers = await prisma.user.count();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
    const [newToday, newWeek] = await Promise.all([
      prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.user.count({ where: { createdAt: { gte: weekStart } } }),
    ]);

    // Active in period
    const activeDateFilter = since ? { createdAt: { gte: since } } : {};
    const activeInPeriodRaw = await prisma.copiedTrade.findMany({
      where: activeDateFilter,
      select: { userId: true },
      distinct: ['userId'],
    });

    res.json({
      kpis: { totalUsers, newToday, newWeek, activeInPeriod: activeInPeriodRaw.length },
      newUsers: serializeBigInt(newUsers),
      activeUsers: serializeBigInt(activeUsers),
      cumulative: serializeBigInt(cumulative),
    });
  } catch (err) {
    console.error('users stats error:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// --- Trades time-series ---
app.get('/api/stats/trades', async (req, res) => {
  try {
    const since = periodToDate(req.query.period);
    const unit = truncUnit(req.query.period);
    const dateClause = since ? `WHERE "createdAt" >= '${since.toISOString()}'` : '';

    const dailyCounts = await prisma.$queryRawUnsafe(`
      SELECT DATE_TRUNC('${unit}', "createdAt") AS date,
        COUNT(*) FILTER (WHERE side = 'BUY')::int AS buys,
        COUNT(*) FILTER (WHERE side = 'SELL')::int AS sells,
        COUNT(*)::int AS total
      FROM copied_trades ${dateClause}
      GROUP BY date ORDER BY date
    `);

    const dailyVolumeRaw = await prisma.$queryRawUnsafe(`
      SELECT DATE_TRUNC('${unit}', "createdAt") AS date,
        COALESCE(SUM(amount), 0) AS commission
      FROM commission_logs ${dateClause}
      GROUP BY date ORDER BY date
    `);
    const dailyVolume = dailyVolumeRaw.map(d => ({ date: d.date, volume: Number(d.commission) / COMMISSION_RATE }));

    const statusBreakdown = await prisma.$queryRawUnsafe(`
      SELECT DATE_TRUNC('${unit}', "createdAt") AS date,
        COUNT(*) FILTER (WHERE status = 'filled')::int AS filled,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped
      FROM copied_trades ${dateClause}
      GROUP BY date ORDER BY date
    `);

    // KPIs
    const dateFilter = since ? { createdAt: { gte: since } } : {};
    const [total, filled, failed, skipped, avgAgg] = await Promise.all([
      prisma.copiedTrade.count({ where: dateFilter }),
      prisma.copiedTrade.count({ where: { ...dateFilter, status: 'filled' } }),
      prisma.copiedTrade.count({ where: { ...dateFilter, status: 'failed' } }),
      prisma.copiedTrade.count({ where: { ...dateFilter, status: 'skipped' } }),
      prisma.copiedTrade.aggregate({ where: { ...dateFilter, status: 'filled' }, _avg: { copiedSize: true } }),
    ]);

    res.json({
      kpis: { total, filled, failed, skipped, avgTradeSize: avgAgg._avg.copiedSize || 0 },
      dailyCounts: serializeBigInt(dailyCounts),
      dailyVolume: serializeBigInt(dailyVolume),
      statusBreakdown: serializeBigInt(statusBreakdown),
    });
  } catch (err) {
    console.error('trades stats error:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// --- Copy Trade stats ---
app.get('/api/stats/copy-trade', async (req, res) => {
  try {
    const since = periodToDate(req.query.period);
    const unit = truncUnit(req.query.period);
    const dateClause = since ? `WHERE "createdAt" >= '${since.toISOString()}'` : '';

    const dailyCopied = await prisma.$queryRawUnsafe(`
      SELECT DATE_TRUNC('${unit}', "createdAt") AS date,
        COUNT(*) FILTER (WHERE status = 'filled')::int AS filled,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped
      FROM copied_trades ${dateClause}
      GROUP BY date ORDER BY date
    `);

    // Active subs over time — use subscription createdAt
    const subDateClause = since ? `WHERE "createdAt" >= '${since.toISOString()}'` : '';
    const subsOverTime = await prisma.$queryRawUnsafe(`
      SELECT DATE_TRUNC('${unit}', "createdAt") AS date,
        COUNT(*) FILTER (WHERE "isActive" = true)::int AS active,
        COUNT(*) FILTER (WHERE "isPaused" = true)::int AS paused
      FROM copy_subscriptions ${subDateClause}
      GROUP BY date ORDER BY date
    `);

    // Top tracked wallets
    const topWallets = await prisma.$queryRawUnsafe(`
      SELECT "traderAddress", COUNT(*)::int AS trade_count
      FROM copied_trades ${dateClause}
      GROUP BY "traderAddress"
      ORDER BY trade_count DESC LIMIT 20
    `);

    // KPIs
    const [activeSubs, pausedSubs, totalCopied, filledCopied] = await Promise.all([
      prisma.copySubscription.count({ where: { isActive: true, isPaused: false } }),
      prisma.copySubscription.count({ where: { isActive: true, isPaused: true } }),
      prisma.copiedTrade.count({ where: since ? { createdAt: { gte: since } } : {} }),
      prisma.copiedTrade.count({ where: { ...(since ? { createdAt: { gte: since } } : {}), status: 'filled' } }),
    ]);

    res.json({
      kpis: {
        activeSubs,
        pausedSubs,
        totalCopied,
        fillRate: totalCopied > 0 ? ((filledCopied / totalCopied) * 100).toFixed(1) : '0.0',
      },
      dailyCopied: serializeBigInt(dailyCopied),
      subsOverTime: serializeBigInt(subsOverTime),
      topWallets: serializeBigInt(topWallets),
    });
  } catch (err) {
    console.error('copy-trade stats error:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// --- Financials ---
app.get('/api/stats/financials', async (req, res) => {
  try {
    const since = periodToDate(req.query.period);
    const unit = truncUnit(req.query.period);
    const dateClause = since ? `WHERE "createdAt" >= '${since.toISOString()}'` : '';

    const dailyCommission = await prisma.$queryRawUnsafe(`
      SELECT DATE_TRUNC('${unit}', "createdAt") AS date,
        COALESCE(SUM(amount), 0) AS commission
      FROM commission_logs ${dateClause}
      GROUP BY date ORDER BY date
    `);

    const cumulativeRevenue = await prisma.$queryRawUnsafe(`
      SELECT date, SUM(commission) OVER (ORDER BY date) AS cumulative FROM (
        SELECT DATE_TRUNC('${unit}', "createdAt") AS date,
          COALESCE(SUM(amount), 0) AS commission
        FROM commission_logs ${dateClause}
        GROUP BY date
      ) sub ORDER BY date
    `);

    // Recent commission logs
    const recentLogs = await prisma.commissionLog.findMany({
      take: 50,
      orderBy: { createdAt: 'desc' },
      where: since ? { createdAt: { gte: since } } : {},
    });

    // KPIs
    const commAgg = await prisma.commissionLog.aggregate({
      where: since ? { createdAt: { gte: since } } : {},
      _sum: { amount: true },
    });
    const cashbackAgg = await prisma.user.aggregate({ _sum: { cashbackEarnedTotal: true } });
    const referralAgg = await prisma.user.aggregate({ _sum: { referralEarnedTotal: true } });
    const totalCommission = commAgg._sum.amount || 0;
    const totalCashback = cashbackAgg._sum.cashbackEarnedTotal || 0;
    const totalReferral = referralAgg._sum.referralEarnedTotal || 0;

    res.json({
      kpis: {
        totalCommission,
        totalCashback,
        totalReferral,
        netRevenue: totalCommission - totalCashback - totalReferral,
      },
      dailyCommission: serializeBigInt(dailyCommission),
      cumulativeRevenue: serializeBigInt(cumulativeRevenue),
      recentLogs,
    });
  } catch (err) {
    console.error('financials error:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// --- Users list (paginated) ---
app.get('/api/stats/users/list', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const search = (req.query.search || '').trim();
    const sort = req.query.sort || 'createdAt';
    const order = req.query.order === 'asc' ? 'asc' : 'desc';
    const skip = (page - 1) * limit;

    const allowedSorts = ['createdAt', 'username', 'firstName', 'referralEarnedTotal', 'cashbackEarnedTotal'];
    const orderBy = allowedSorts.includes(sort) ? { [sort]: order } : { createdAt: 'desc' };

    const where = search ? {
      OR: [
        { username: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { telegramId: { contains: search } },
      ],
    } : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        select: {
          id: true,
          telegramId: true,
          username: true,
          firstName: true,
          createdAt: true,
          referralCode: true,
          referralEarnedTotal: true,
          cashbackEarnedTotal: true,
          referredBy: { select: { username: true, firstName: true } },
          _count: {
            select: {
              referrals: true,
              copySubscriptions: true,
              bondStrategies: true,
              updownStrategies: true,
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    // Fetch total trade volume per user (sum of copiedSize from filled trades)
    const userIds = users.map(u => u.id);
    const volumeAggs = userIds.length > 0 ? await prisma.copiedTrade.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, status: 'filled' },
      _sum: { copiedSize: true },
    }) : [];
    const volumeMap = {};
    volumeAggs.forEach(v => { volumeMap[v.userId] = v._sum.copiedSize || 0; });

    const result = users.map(u => ({
      id: u.id,
      telegramId: u.telegramId,
      username: u.username,
      firstName: u.firstName,
      createdAt: u.createdAt,
      referralCode: u.referralCode,
      referredBy: u.referredBy ? (u.referredBy.username || u.referredBy.firstName || '-') : null,
      referralCount: u._count.referrals,
      referralEarnedTotal: u.referralEarnedTotal,
      cashbackEarnedTotal: u.cashbackEarnedTotal,
      copySubCount: u._count.copySubscriptions,
      bondStratCount: u._count.bondStrategies,
      updownStratCount: u._count.updownStrategies,
      totalTradeVolume: volumeMap[u.id] || 0,
    }));

    res.json({ users: result, total, page, limit });
  } catch (err) {
    console.error('users list error:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// --- User detail ---
app.get('/api/stats/users/detail/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        telegramId: true,
        username: true,
        firstName: true,
        lastName: true,
        createdAt: true,
        referralCode: true,
        referralEarnedTotal: true,
        referralClaimable: true,
        cashbackEarnedTotal: true,
        cashbackClaimable: true,
        defaultTradeAmount: true,
        slippageTolerance: true,
        tradingEnabled: true,
        isAdmin: true,
        isActive: true,
        referredBy: { select: { id: true, username: true, firstName: true } },
        referrals: {
          select: { id: true, username: true, firstName: true, telegramId: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        _count: {
          select: {
            copySubscriptions: true,
            copiedTrades: true,
            bondStrategies: true,
            bondTrades: true,
            updownStrategies: true,
            updownTrades: true,
            referrals: true,
          },
        },
      },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    const [recentCopied, recentBond, recentUpdown] = await Promise.all([
      prisma.copiedTrade.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, side: true, outcome: true, copiedSize: true, price: true, status: true, createdAt: true, traderAddress: true },
      }),
      prisma.bondTrade.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, question: true, outcome: true, amount: true, price: true, probability: true, status: true, createdAt: true },
      }),
      prisma.upDownTrade.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, coin: true, direction: true, amount: true, triggerPrice: true, fillPrice: true, status: true, createdAt: true },
      }),
    ]);

    res.json({ ...user, recentCopied, recentBond, recentUpdown });
  } catch (err) {
    console.error('user detail error:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// --- Auto Strategies stats ---
app.get('/api/stats/auto-strategies', async (req, res) => {
  try {
    const since = periodToDate(req.query.period);
    const unit = truncUnit(req.query.period);
    const dateFilter = since ? { createdAt: { gte: since } } : {};

    const [
      activeBond, pausedBond, totalBondTrades, filledBondTrades,
      activeUpdown, pausedUpdown, totalUpdownTrades, filledUpdownTrades,
    ] = await Promise.all([
      prisma.bondStrategy.count({ where: { isActive: true, isPaused: false } }),
      prisma.bondStrategy.count({ where: { isActive: true, isPaused: true } }),
      prisma.bondTrade.count({ where: dateFilter }),
      prisma.bondTrade.count({ where: { ...dateFilter, status: 'filled' } }),
      prisma.upDownStrategy.count({ where: { isActive: true, isPaused: false } }),
      prisma.upDownStrategy.count({ where: { isActive: true, isPaused: true } }),
      prisma.upDownTrade.count({ where: dateFilter }),
      prisma.upDownTrade.count({ where: { ...dateFilter, status: 'filled' } }),
    ]);

    const bondDateClause = since ? `WHERE "createdAt" >= '${since.toISOString()}'` : '';
    const updownDateClause = since ? `WHERE "createdAt" >= '${since.toISOString()}'` : '';

    const dailyBondTrades = await prisma.$queryRawUnsafe(`
      SELECT DATE_TRUNC('${unit}', "createdAt") AS date,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'filled')::int AS filled,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM bond_trades ${bondDateClause}
      GROUP BY date ORDER BY date
    `);

    const dailyUpdownTrades = await prisma.$queryRawUnsafe(`
      SELECT DATE_TRUNC('${unit}', "createdAt") AS date,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'filled')::int AS filled,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM updown_trades ${updownDateClause}
      GROUP BY date ORDER BY date
    `);

    // Top users by strategy count
    const topUsers = await prisma.$queryRawUnsafe(`
      SELECT u.id, u.username, u."firstName",
        (SELECT COUNT(*)::int FROM bond_strategies bs WHERE bs."userId" = u.id AND bs."isActive" = true) AS bond_count,
        (SELECT COUNT(*)::int FROM updown_strategies us WHERE us."userId" = u.id AND us."isActive" = true) AS updown_count
      FROM users u
      WHERE EXISTS (SELECT 1 FROM bond_strategies bs WHERE bs."userId" = u.id AND bs."isActive" = true)
         OR EXISTS (SELECT 1 FROM updown_strategies us WHERE us."userId" = u.id AND us."isActive" = true)
      ORDER BY (
        (SELECT COUNT(*) FROM bond_strategies bs WHERE bs."userId" = u.id AND bs."isActive" = true) +
        (SELECT COUNT(*) FROM updown_strategies us WHERE us."userId" = u.id AND us."isActive" = true)
      ) DESC
      LIMIT 20
    `);

    res.json({
      kpis: {
        activeBond, pausedBond, totalBondTrades, filledBondTrades,
        bondFillRate: totalBondTrades > 0 ? ((filledBondTrades / totalBondTrades) * 100).toFixed(1) : '0.0',
        activeUpdown, pausedUpdown, totalUpdownTrades, filledUpdownTrades,
        updownFillRate: totalUpdownTrades > 0 ? ((filledUpdownTrades / totalUpdownTrades) * 100).toFixed(1) : '0.0',
      },
      dailyBondTrades: serializeBigInt(dailyBondTrades),
      dailyUpdownTrades: serializeBigInt(dailyUpdownTrades),
      topUsers: serializeBigInt(topUsers),
    });
  } catch (err) {
    console.error('auto-strategies error:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// --- Live feed ---
app.get('/api/feed/recent', async (req, res) => {
  try {
    const trades = await prisma.copiedTrade.findMany({
      take: 50,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { username: true, firstName: true } },
      },
    });
    res.json(trades);
  } catch (err) {
    console.error('feed error:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// --- BigInt serializer ---
function serializeBigInt(data) {
  return JSON.parse(JSON.stringify(data, (_, v) => typeof v === 'bigint' ? Number(v) : v));
}

// --- SPA fallback ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Startup with DB connection retry ---
async function start() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await prisma.$connect();
      console.log('Database connected');
      break;
    } catch (err) {
      console.error(`DB connection attempt ${attempt}/10 failed: ${err.message}`);
      if (attempt === 10) {
        console.error('Could not connect to database after 10 attempts, exiting');
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  app.listen(PORT, () => {
    console.log(`Dashboard running on port ${PORT}`);
  });
}

start();
