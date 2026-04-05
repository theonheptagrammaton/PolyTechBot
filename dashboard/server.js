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
  return period === '24h' ? 'hour' : 'day';
}

// --- Overview KPIs ---
app.get('/api/stats/overview', async (req, res) => {
  try {
    const since = periodToDate(req.query.period);
    const dateFilter = since ? { createdAt: { gte: since } } : {};

    const [totalUsers, totalTrades, commissionAgg, activeSubs, filledTrades, failedTrades, skippedTrades] = await Promise.all([
      prisma.user.count({ where: dateFilter }),
      prisma.copiedTrade.count({ where: dateFilter }),
      prisma.commissionLog.aggregate({ where: dateFilter, _sum: { amount: true } }),
      prisma.copySubscription.count({ where: { isActive: true, isPaused: false } }),
      prisma.copiedTrade.count({ where: { ...dateFilter, status: 'filled' } }),
      prisma.copiedTrade.count({ where: { ...dateFilter, status: 'failed' } }),
      prisma.copiedTrade.count({ where: { ...dateFilter, status: 'skipped' } }),
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

app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
});
