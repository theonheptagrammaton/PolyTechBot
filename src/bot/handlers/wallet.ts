import { Context } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { logger } from '../../utils/logger';

export async function handleWallet(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();

    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply(
        '❌ You don\'t have a wallet yet.\n\n' +
        'Use /start to create your Polymarket wallet.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const walletMessage =
      '💼 *Your Wallet Information*\n\n' +
      `📍 Address: \`${user.walletAddress}\`\n\n` +
      `📅 Created: ${user.createdAt.toLocaleDateString()}\n\n` +
      '⚠️ *Security Note:*\n' +
      'Your private key is securely stored and encrypted.\n' +
      'For security reasons, we only showed your private key once during wallet creation.\n\n' +
      '💡 Use /help to see available commands.';

    await ctx.reply(walletMessage, { parse_mode: 'Markdown' });

    logger.info(`Wallet info displayed for user: ${telegramId}`);
  } catch (error) {
    logger.error('Error in wallet handler:', error);
    await ctx.reply('❌ An error occurred while fetching your wallet information.');
  }
}
