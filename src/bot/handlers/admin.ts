import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId, isUserAdmin, getAllUsers } from '../../services/user';
import { getAdminStats, formatStatsMessage } from '../../services/adminStats';
import { logger } from '../../utils/logger';
import { sendPage } from '../../utils/telegram';
import { ce, EMOJI } from '../../utils/customEmoji';

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

    // Send loading message
    const loadingMsg = await ctx.reply(ce(EMOJI.loading, '⏳') + ' Loading statistics...\n\n<i>This may take a moment...</i>', {
      parse_mode: 'HTML',
    });

    // Get comprehensive stats (always fresh)
    const stats = await getAdminStats(true);
    const statsMessage = formatStatsMessage(stats);

    // Delete loading message
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
    } catch (e) {
      // Ignore if can't delete
    }

    // Send stats with refresh button
    await sendPage(ctx, statsMessage, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh Stats', 'admin_refresh_stats')],
        [Markup.button.callback('👥 View Users', 'admin_view_users')],
      ]),
    });

    logger.info(`Stats displayed for admin: ${telegramId}`);
  } catch (error) {
    logger.error('Error in stats handler:', error);
    await ctx.reply('❌ An error occurred while fetching statistics.');
  }
}

/**
 * Handles refresh stats button
 */
export async function handleRefreshStats(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Refreshing stats...');

    const telegramId = ctx.from?.id.toString();

    if (!telegramId) {
      return;
    }

    const user = await getUserByTelegramId(telegramId);

    if (!user || !isUserAdmin(user)) {
      await ctx.answerCbQuery('❌ Unauthorized');
      return;
    }

    // Get fresh stats (force refresh)
    const stats = await getAdminStats(true);
    const statsMessage = formatStatsMessage(stats);

    // Update message
    await sendPage(ctx, statsMessage, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh Stats', 'admin_refresh_stats')],
        [Markup.button.callback('👥 View Users', 'admin_view_users')],
      ]),
    });

    logger.info(`Stats refreshed for admin: ${telegramId}`);
  } catch (error) {
    logger.error('Error refreshing stats:', error);
    await ctx.answerCbQuery('❌ Error refreshing stats');
  }
}

/**
 * Handles view users button
 */
export async function handleViewUsersButton(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();
    await handleUsers(ctx);
  } catch (error) {
    logger.error('Error in view users button:', error);
  }
}

export async function handleUsers(ctx: Context, page: number = 1): Promise<void> {
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

    // Pagination
    const usersPerPage = 5;
    const totalPages = Math.ceil(users.length / usersPerPage);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * usersPerPage;
    const endIndex = startIndex + usersPerPage;
    const pageUsers = users.slice(startIndex, endIndex);

    let message = `👥 *USERS MANAGEMENT*\n\n`;
    message += `Total Users: ${users.length}\n`;
    message += `Page ${currentPage}/${totalPages}\n\n`;

    pageUsers.forEach((u, index) => {
      const number = startIndex + index + 1;
      const status = u.isActive ? '✅' : '❌';
      const adminBadge = u.isAdmin ? '🔐 ADMIN' : '';
      const name = u.firstName || u.username || 'Unknown';

      message += `*${number}. ${name}* ${status} ${adminBadge}\n`;
      message += `├ TG ID: \`${u.telegramId}\`\n`;
      message += `├ Wallet: \`${u.walletAddress.slice(0, 10)}...\`\n`;
      message += `└ Created: ${u.createdAt.toLocaleDateString()}\n\n`;
    });

    // Build buttons
    const buttons: any[] = [];

    // User action buttons (Delete buttons)
    pageUsers.forEach((u, index) => {
      const number = startIndex + index + 1;
      const name = u.firstName || u.username || 'Unknown';
      // Don't allow deleting admins
      if (!u.isAdmin) {
        buttons.push([
          Markup.button.callback(`🗑 Delete ${number}. ${name}`, `admin_delete_user_${u.id}`),
        ]);
      }
    });

    // Pagination buttons
    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('◀️ Previous', `admin_users_page_${currentPage - 1}`));
    }
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ▶️', `admin_users_page_${currentPage + 1}`));
    }
    if (navRow.length > 0) {
      buttons.push(navRow);
    }

    // Back button
    buttons.push([Markup.button.callback('« Back to Stats', 'admin_back_to_stats')]);

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Users list page ${currentPage} displayed for admin: ${telegramId}`);
  } catch (error) {
    logger.error('Error in users handler:', error);
    await ctx.reply('❌ An error occurred while fetching users.');
  }
}

/**
 * Handles user pagination
 */
export async function handleUsersPage(ctx: Context, page: number): Promise<void> {
  try {
    await ctx.answerCbQuery();
    await handleUsers(ctx, page);
  } catch (error) {
    logger.error('Error in users page handler:', error);
  }
}

/**
 * Handles delete user confirmation
 */
export async function handleDeleteUserConfirm(ctx: Context, userId: string): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      return;
    }

    const admin = await getUserByTelegramId(telegramId);
    if (!admin || !isUserAdmin(admin)) {
      await ctx.answerCbQuery('❌ Unauthorized');
      return;
    }

    // Get user to delete
    const { prisma } = await import('../../database/prisma');
    const userToDelete = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!userToDelete) {
      await sendPage(ctx, '❌ User not found.');
      return;
    }

    // Don't allow deleting admins
    if (userToDelete.isAdmin) {
      await sendPage(ctx, '❌ Cannot delete admin users.');
      return;
    }

    const name = userToDelete.firstName || userToDelete.username || 'Unknown';

    const message =
      '⚠️ *CONFIRM USER DELETION*\n\n' +
      `User: *${name}*\n` +
      `Telegram ID: \`${userToDelete.telegramId}\`\n` +
      `Wallet: \`${userToDelete.walletAddress}\`\n\n` +
      '🗑 *This will permanently delete:*\n' +
      '• User account\n' +
      '• All associated data\n' +
      '• Cannot be undone\n\n' +
      '⚠️ *Note:* User can re-register with /start\n\n' +
      'Are you sure?';

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Yes, Delete', `admin_delete_confirmed_${userId}`),
          Markup.button.callback('❌ Cancel', 'admin_view_users'),
        ],
      ]),
    });

    logger.info(`Delete confirmation shown for user ${userId}`);
  } catch (error) {
    logger.error('Error showing delete confirmation:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Handles confirmed user deletion
 */
export async function handleDeleteUserConfirmed(ctx: Context, userId: string): Promise<void> {
  try {
    await ctx.answerCbQuery('Deleting user...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      return;
    }

    const admin = await getUserByTelegramId(telegramId);
    if (!admin || !isUserAdmin(admin)) {
      await ctx.answerCbQuery('❌ Unauthorized');
      return;
    }

    // Delete user from database
    const { prisma } = await import('../../database/prisma');
    const deletedUser = await prisma.user.delete({
      where: { id: userId },
    });

    // Invalidate cache
    const { invalidateUserCache } = await import('../../services/user');
    await invalidateUserCache(deletedUser);

    const name = deletedUser.firstName || deletedUser.username || 'Unknown';

    const message =
      '✅ *USER DELETED SUCCESSFULLY*\n\n' +
      `User: *${name}*\n` +
      `Telegram ID: \`${deletedUser.telegramId}\`\n\n` +
      '🗑 All data has been permanently deleted.\n' +
      '💡 User can re-register anytime using /start';

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('👥 Back to Users', 'admin_view_users')]]),
    });

    logger.info(`User deleted by admin ${telegramId}: ${deletedUser.telegramId} (${name})`);
  } catch (error: any) {
    logger.error('Error deleting user:', error);
    await sendPage(ctx,
      '❌ *Error Deleting User*\n\n' +
      'An error occurred while deleting the user. Please try again or check server logs.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'admin_view_users')]]),
      }
    );
  }
}

/**
 * Handles back to stats button
 */
export async function handleBackToStats(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    // Re-run stats command
    await handleStats(ctx);
  } catch (error) {
    logger.error('Error going back to stats:', error);
  }
}

/**
 * Resets admin's own account for testing
 * Allows admin to test the onboarding flow from scratch
 */
export async function handleResetMe(ctx: Context): Promise<void> {
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

    const message =
      '⚠️ *RESET YOUR ACCOUNT*\n\n' +
      '🗑 *This will delete:*\n' +
      '• Your user account\n' +
      '• All wallet data\n' +
      '• All associated data\n\n' +
      '✅ *After reset you can:*\n' +
      '• Test /start as a new user\n' +
      '• Go through complete onboarding\n' +
      '• See new user experience\n\n' +
      '⚠️ *Note:* You can re-register immediately with /start\n\n' +
      'Are you sure you want to reset?';

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Yes, Reset Me', 'admin_reset_me_confirmed'),
          Markup.button.callback('❌ Cancel', 'admin_reset_me_cancel'),
        ],
      ]),
    });

    logger.info(`Reset confirmation shown for admin: ${telegramId}`);
  } catch (error) {
    logger.error('Error in reset me handler:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Handles confirmed admin self-reset
 */
export async function handleResetMeConfirmed(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Resetting your account...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user || !isUserAdmin(user)) {
      await ctx.answerCbQuery('❌ Unauthorized');
      return;
    }

    // Prevent deleting the last admin (bot would become unmanageable)
    const { prisma } = await import('../../database/prisma');
    const otherAdminCount = await prisma.user.count({
      where: { isAdmin: true, id: { not: user.id } },
    });
    if (otherAdminCount === 0) {
      await sendPage(ctx,
        '❌ *Cannot Reset Last Admin*\n\n' +
        'You are the only admin. Add another admin before resetting your account.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Delete user from database (including admin)
    await prisma.user.delete({
      where: { id: user.id },
    });

    // Invalidate cache
    const { invalidateUserCache } = await import('../../services/user');
    await invalidateUserCache(user);

    const message =
      '✅ *ACCOUNT RESET SUCCESSFUL*\n\n' +
      '🗑 Your account has been deleted.\n\n' +
      '🚀 *Next Steps:*\n' +
      '1. Use /start to create a new account\n' +
      '2. Test the complete onboarding flow\n' +
      '3. Experience the new user journey\n\n' +
      '💡 You can now see exactly what new users see!';

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
    });

    logger.info(`Admin self-reset completed: ${telegramId} (${user.firstName || user.username})`);
  } catch (error: any) {
    logger.error('Error resetting admin account:', error);
    await sendPage(ctx,
      '❌ *Error Resetting Account*\n\n' +
      'An error occurred while resetting your account. Please check server logs.',
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Handles reset cancel
 */
export async function handleResetMeCancel(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Reset cancelled');
    await sendPage(ctx, '❌ Reset cancelled. Your account is unchanged.', {
      parse_mode: 'Markdown',
    });
  } catch (error) {
    logger.error('Error cancelling reset:', error);
  }
}
