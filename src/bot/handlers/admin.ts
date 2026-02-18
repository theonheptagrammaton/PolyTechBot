import { Context } from 'telegraf';
import { getUserByTelegramId, isUserAdmin, getAllUsers, getUserCount } from '../../services/user';
import { logger } from '../../utils/logger';

export async function handleStats(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();

    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);

    if (!user || !isUserAdmin(user)) {
      await ctx.reply('❌ This command is only available to administrators.');
      return;
    }

    const userCount = await getUserCount();
    const users = await getAllUsers();

    const activeUsers = users.filter(u => u.isActive).length;
    const admins = users.filter(u => u.isAdmin).length;

    const statsMessage =
      '📊 *Bot Statistics*\n\n' +
      `👥 Total Users: ${userCount}\n` +
      `✅ Active Users: ${activeUsers}\n` +
      `🔐 Admins: ${admins}\n` +
      `💼 Total Wallets: ${userCount}\n\n` +
      `📅 Generated: ${new Date().toLocaleString()}`;

    await ctx.reply(statsMessage, { parse_mode: 'Markdown' });

    logger.info(`Stats displayed for admin: ${telegramId}`);
  } catch (error) {
    logger.error('Error in stats handler:', error);
    await ctx.reply('❌ An error occurred while fetching statistics.');
  }
}

export async function handleUsers(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();

    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);

    if (!user || !isUserAdmin(user)) {
      await ctx.reply('❌ This command is only available to administrators.');
      return;
    }

    const users = await getAllUsers();

    if (users.length === 0) {
      await ctx.reply('No users found.');
      return;
    }

    // Split users into chunks to avoid message size limits
    const maxUsersPerMessage = 10;
    const chunks = [];

    for (let i = 0; i < users.length; i += maxUsersPerMessage) {
      chunks.push(users.slice(i, i + maxUsersPerMessage));
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      let message = `👥 *Users List (${i + 1}/${chunks.length})*\n\n`;

      chunk.forEach((u, index) => {
        const number = i * maxUsersPerMessage + index + 1;
        const status = u.isActive ? '✅' : '❌';
        const adminBadge = u.isAdmin ? '🔐' : '';
        const name = u.firstName || u.username || 'Unknown';

        message += `${number}. ${status}${adminBadge} ${name}\n`;
        message += `   ID: \`${u.telegramId}\`\n`;
        message += `   Wallet: \`${u.walletAddress.slice(0, 10)}...${u.walletAddress.slice(-8)}\`\n`;
        message += `   Created: ${u.createdAt.toLocaleDateString()}\n\n`;
      });

      await ctx.reply(message, { parse_mode: 'Markdown' });
    }

    logger.info(`Users list displayed for admin: ${telegramId}`);
  } catch (error) {
    logger.error('Error in users handler:', error);
    await ctx.reply('❌ An error occurred while fetching users.');
  }
}
