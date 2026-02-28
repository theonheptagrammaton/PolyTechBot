import { redisCache } from '../database/redis';
import { logger } from '../utils/logger';
import { getAllUsers } from './user';
import { getPortfolioData } from './portfolio';

export interface AdminStats {
  // User Stats
  totalUsers: number;
  activeUsers: number;
  newUsersToday: number;
  newUsersWeek: number;
  newUsersMonth: number;

  // Trading Volume (USDC)
  totalVolume: number;
  dailyVolume: number;
  weeklyVolume: number;
  monthlyVolume: number;

  // Trade Counts
  totalTrades: number;
  dailyTrades: number;
  weeklyTrades: number;
  monthlyTrades: number;

  // Open Orders
  totalOpenOrders: number;

  // Generated timestamp
  generatedAt: string;
}

/**
 * Gets comprehensive admin statistics
 */
export async function getAdminStats(forceRefresh: boolean = false): Promise<AdminStats> {
  try {
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cacheKey = 'admin:stats:comprehensive';
      const cached = await redisCache.get<AdminStats>(cacheKey);

      if (cached) {
        logger.debug('Returning cached admin stats');
        return cached;
      }
    }

    logger.info('Calculating admin statistics...');

    // Get all users
    const users = await getAllUsers();
    const activeUsers = users.filter(u => u.isActive);

    // Time boundaries
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // User stats
    const newUsersToday = users.filter(u => u.createdAt >= oneDayAgo).length;
    const newUsersWeek = users.filter(u => u.createdAt >= oneWeekAgo).length;
    const newUsersMonth = users.filter(u => u.createdAt >= oneMonthAgo).length;

    // Trading stats - fetch from Polymarket API
    let totalVolume = 0;
    let dailyVolume = 0;
    let weeklyVolume = 0;
    let monthlyVolume = 0;

    let totalTrades = 0;
    let dailyTrades = 0;
    let weeklyTrades = 0;
    let monthlyTrades = 0;

    let totalOpenOrders = 0;

    // Iterate through active users and get their portfolio data
    // Note: This can be slow for many users, so we cache the result
    for (const user of activeUsers) {
      try {
        // Skip if user doesn't have credentials
        if (!user.encryptedPrivateKey || !user.encryptedApiKey) {
          continue;
        }

        // Get portfolio data (pass encrypted — getPortfolioData decrypts internally)
        const portfolio = await getPortfolioData(
          user.encryptedPrivateKey,
          user.encryptedApiKey,
          user.encryptedApiSecret,
          user.encryptedPassphrase,
          user.polymarketProxyAddress || ''
        );

        // Count open orders
        totalOpenOrders += portfolio.openOrders.length;

        // Calculate trade volumes and counts
        for (const trade of portfolio.trades) {
          const tradeValue = parseFloat(trade.size) * parseFloat(trade.price);
          const tradeDate = new Date(trade.match_time);

          totalVolume += tradeValue;
          totalTrades += 1;

          if (tradeDate >= oneDayAgo) {
            dailyVolume += tradeValue;
            dailyTrades += 1;
          }

          if (tradeDate >= oneWeekAgo) {
            weeklyVolume += tradeValue;
            weeklyTrades += 1;
          }

          if (tradeDate >= oneMonthAgo) {
            monthlyVolume += tradeValue;
            monthlyTrades += 1;
          }
        }
      } catch (error) {
        logger.debug(`Error fetching portfolio for user ${user.id}:`, error);
        // Continue with other users
      }
    }

    const stats: AdminStats = {
      // User stats
      totalUsers: users.length,
      activeUsers: activeUsers.length,
      newUsersToday,
      newUsersWeek,
      newUsersMonth,

      // Trading volume
      totalVolume: parseFloat(totalVolume.toFixed(2)),
      dailyVolume: parseFloat(dailyVolume.toFixed(2)),
      weeklyVolume: parseFloat(weeklyVolume.toFixed(2)),
      monthlyVolume: parseFloat(monthlyVolume.toFixed(2)),

      // Trade counts
      totalTrades,
      dailyTrades,
      weeklyTrades,
      monthlyTrades,

      // Open orders
      totalOpenOrders,

      // Timestamp
      generatedAt: now.toISOString(),
    };

    // Cache for 5 minutes
    await redisCache.set('admin:stats:comprehensive', stats, 300);

    logger.info('Admin statistics calculated successfully');
    return stats;
  } catch (error) {
    logger.error('Error calculating admin statistics:', error);
    throw new Error('Failed to calculate admin statistics');
  }
}

/**
 * Formats volume in a human-readable way
 */
export function formatVolume(volume: number): string {
  if (volume >= 1000000) {
    return `$${(volume / 1000000).toFixed(2)}M`;
  } else if (volume >= 1000) {
    return `$${(volume / 1000).toFixed(2)}K`;
  } else {
    return `$${volume.toFixed(2)}`;
  }
}

/**
 * Formats stats message for Telegram
 */
export function formatStatsMessage(stats: AdminStats): string {
  let message = '📊 *ADMIN STATISTICS*\n\n';

  // User Statistics
  message += '👥 *USER STATS*\n';
  message += `├ Total Users: *${stats.totalUsers}*\n`;
  message += `├ Active Users: *${stats.activeUsers}*\n`;
  message += `├ New Today: *${stats.newUsersToday}*\n`;
  message += `├ New This Week: *${stats.newUsersWeek}*\n`;
  message += `└ New This Month: *${stats.newUsersMonth}*\n\n`;

  // Trading Volume
  message += '💰 *TRADING VOLUME*\n';
  message += `├ Total: *${formatVolume(stats.totalVolume)}*\n`;
  message += `├ Today: *${formatVolume(stats.dailyVolume)}*\n`;
  message += `├ This Week: *${formatVolume(stats.weeklyVolume)}*\n`;
  message += `└ This Month: *${formatVolume(stats.monthlyVolume)}*\n\n`;

  // Trade Counts
  message += '📈 *TRADES*\n';
  message += `├ Total Trades: *${stats.totalTrades}*\n`;
  message += `├ Today: *${stats.dailyTrades}*\n`;
  message += `├ This Week: *${stats.weeklyTrades}*\n`;
  message += `└ This Month: *${stats.monthlyTrades}*\n\n`;

  // Open Orders
  message += `🟢 *Open Orders:* ${stats.totalOpenOrders}\n\n`;

  // Averages
  if (stats.totalUsers > 0) {
    const avgVolumePerUser = stats.totalVolume / stats.activeUsers;
    message += '📊 *AVERAGES*\n';
    message += `├ Avg Volume/User: *${formatVolume(avgVolumePerUser)}*\n`;

    if (stats.totalTrades > 0) {
      const avgTradeSize = stats.totalVolume / stats.totalTrades;
      message += `└ Avg Trade Size: *${formatVolume(avgTradeSize)}*\n\n`;
    } else {
      message += '\n';
    }
  }

  // Footer
  message += `🕒 Generated: ${new Date(stats.generatedAt).toLocaleString()}\n`;
  message += '💡 Stats cached for 5 minutes';

  return message;
}
