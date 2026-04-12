import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId, isUserAdmin, getAllUsers } from '../../services/user';
import { getAdminStats, formatStatsMessage } from '../../services/adminStats';
import { logger } from '../../utils/logger';
import { sendPage } from '../../utils/telegram';
import { ce, EMOJI } from '../../utils/customEmoji';
import { prisma } from '../../database/prisma';
import { RedisBackedState } from '../../utils/redisState';
import { REFERRAL_TIER1_PCT } from '../../services/referral';

// State for admin editing a user's referral rate — stores target userId, TTL 5 min
export const adminRefRateState = new RedisBackedState<{ targetUserId: string; timestamp: number }>('adminRefRate', 300);

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

    // User action buttons (Detail + Delete)
    pageUsers.forEach((u, index) => {
      const number = startIndex + index + 1;
      const name = u.firstName || u.username || 'Unknown';
      const row: any[] = [
        Markup.button.callback(`👤 ${number}. ${name}`, `admin_user_detail_${u.id}`),
      ];
      // Don't allow deleting admins
      if (!u.isAdmin) {
        row.push(Markup.button.callback(`🗑`, `admin_delete_user_${u.id}`));
      }
      buttons.push(row);
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

/**
 * Shows user detail view for admin
 */
export async function handleUserDetail(ctx: Context, userId: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const admin = await getUserByTelegramId(telegramId);
    if (!admin || !isUserAdmin(admin)) {
      await ctx.reply('❌ Unauthorized');
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      await sendPage(ctx, '❌ User not found.');
      return;
    }

    const name = user.firstName || user.username || 'Unknown';
    const refPct = user.customReferralPct != null ? user.customReferralPct : REFERRAL_TIER1_PCT * 100;

    // Count direct referrals
    const refCount = await prisma.user.count({ where: { referredById: userId } });

    let msg = `👤 <b>User Detail</b>\n\n`;
    msg += `<b>Name:</b> ${name}\n`;
    msg += `<b>Username:</b> ${user.username ? '@' + user.username : '—'}\n`;
    msg += `<b>Telegram ID:</b> <code>${user.telegramId}</code>\n`;
    msg += `<b>Wallet:</b> <code>${user.walletAddress}</code>\n`;
    msg += `<b>Status:</b> ${user.isActive ? '✅ Active' : '❌ Inactive'}\n`;
    msg += `<b>Admin:</b> ${user.isAdmin ? '🔐 Yes' : 'No'}\n`;
    msg += `<b>Created:</b> ${user.createdAt.toLocaleDateString()}\n\n`;
    msg += `━━━━━━━━━━━━━━━\n`;
    msg += `<b>Referral Info</b>\n\n`;
    msg += `<b>Ref Code:</b> <code>${user.referralCode || '—'}</code>\n`;
    msg += `<b>Tier 1 Rate:</b> <b>${refPct}%</b>${user.customReferralPct != null ? ' (custom)' : ' (default)'}\n`;
    msg += `<b>Direct Referrals:</b> ${refCount}\n`;
    msg += `<b>Claimable:</b> $${user.referralClaimable.toFixed(2)}\n`;
    msg += `<b>Total Earned:</b> $${user.referralEarnedTotal.toFixed(2)}\n`;

    await sendPage(ctx, msg, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`✏️ Edit Ref Rate (${refPct}%)`, `admin_edit_ref_rate_${userId}`)],
        user.customReferralPct != null
          ? [Markup.button.callback('🔄 Reset to Default (25%)', `admin_reset_ref_rate_${userId}`)]
          : [],
        [Markup.button.callback('👥 Back to Users', 'admin_view_users')],
      ].filter(row => row.length > 0)),
    });
  } catch (error) {
    logger.error('Error in handleUserDetail:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Prompts admin to enter a new referral rate for a user
 */
export async function handleEditRefRate(ctx: Context, userId: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const admin = await getUserByTelegramId(telegramId);
    if (!admin || !isUserAdmin(admin)) return;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, username: true, customReferralPct: true },
    });
    if (!user) {
      await sendPage(ctx, '❌ User not found.');
      return;
    }

    const name = user.firstName || user.username || 'Unknown';
    const currentPct = user.customReferralPct != null ? user.customReferralPct : REFERRAL_TIER1_PCT * 100;

    adminRefRateState.set(telegramId, { targetUserId: userId, timestamp: Date.now() });

    await sendPage(ctx,
      `✏️ <b>Edit Referral Rate</b>\n\n` +
      `User: <b>${name}</b>\n` +
      `Current Tier 1 Rate: <b>${currentPct}%</b>\n\n` +
      `Enter the new Tier 1 referral percentage (1-100):\n` +
      `<i>Example: 40 for 40%</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Cancel', `admin_user_detail_${userId}`)],
        ]),
      }
    );
  } catch (error) {
    logger.error('Error in handleEditRefRate:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Handles admin text input for referral rate change
 */
export async function handleRefRateInput(ctx: Context, text: string): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const stateData = await adminRefRateState.get(telegramId);
    if (!stateData) return;

    adminRefRateState.delete(telegramId);

    const admin = await getUserByTelegramId(telegramId);
    if (!admin || !isUserAdmin(admin)) return;

    const pct = parseFloat(text.trim());
    if (isNaN(pct) || pct < 1 || pct > 100) {
      // Re-set state so they can try again
      adminRefRateState.set(telegramId, stateData);
      await sendPage(ctx,
        `⚠️ Invalid value. Enter a number between 1 and 100.\n\n<i>Example: 40 for 40%</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('❌ Cancel', `admin_user_detail_${stateData.targetUserId}`)],
          ]),
        }
      );
      return;
    }

    await prisma.user.update({
      where: { id: stateData.targetUserId },
      data: { customReferralPct: pct },
    });

    const user = await prisma.user.findUnique({
      where: { id: stateData.targetUserId },
      select: { firstName: true, username: true },
    });
    const name = user?.firstName || user?.username || 'Unknown';

    logger.info(`[admin] ${telegramId} set referral rate for user ${stateData.targetUserId} (${name}) to ${pct}%`);

    await sendPage(ctx,
      `✅ <b>Referral Rate Updated</b>\n\n` +
      `User: <b>${name}</b>\n` +
      `New Tier 1 Rate: <b>${pct}%</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👤 Back to User', `admin_user_detail_${stateData.targetUserId}`)],
          [Markup.button.callback('👥 Back to Users', 'admin_view_users')],
        ]),
      }
    );
  } catch (error) {
    logger.error('Error in handleRefRateInput:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Resets a user's referral rate to default
 */
export async function handleResetRefRate(ctx: Context, userId: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const admin = await getUserByTelegramId(telegramId);
    if (!admin || !isUserAdmin(admin)) return;

    await prisma.user.update({
      where: { id: userId },
      data: { customReferralPct: null },
    });

    logger.info(`[admin] ${telegramId} reset referral rate to default for user ${userId}`);

    // Show user detail again
    await handleUserDetail(ctx, userId);
  } catch (error) {
    logger.error('Error in handleResetRefRate:', error);
    await ctx.reply('❌ An error occurred.');
  }
}
