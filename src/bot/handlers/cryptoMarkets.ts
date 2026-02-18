import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { logger } from '../../utils/logger';

/**
 * Shows crypto subcategory selection
 */
export async function handleCryptoCategory(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const message =
      '₿ *Crypto — Choose a category*\n\n' +
      'Select a category to browse markets:';

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 Up/Down Crypto', 'crypto_updown')],
        [Markup.button.callback('₿ All Crypto Markets', 'category_crypto')],
        [Markup.button.callback('« Back', 'show_categories')],
      ]),
    });

    logger.info(`Crypto subcategories shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error('Error showing crypto subcategories:', error);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
}

/**
 * Shows Up/Down crypto - No active markets message
 */
export async function handleUpDownCrypto(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const message =
      '📊 *Up/Down Crypto Markets*\n\n' +
      '⏱️ *No active time-based markets right now*\n\n' +
      'These short-term prediction markets (5-minute, 15-minute, 1-hour, 4-hour) ' +
      'are currently not available on Polymarket.\n\n' +
      '💡 *What are Up/Down Markets?*\n' +
      'These markets let you predict if Bitcoin, Ethereum, Solana, or XRP ' +
      'will go UP or DOWN in specific time windows.\n\n' +
      '🔔 *Check back later!*\n' +
      'When these markets become active again, they will appear here automatically.\n\n' +
      '_In the meantime, explore All Crypto Markets for other trading opportunities._';

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('₿ All Crypto Markets', 'category_crypto')],
        [Markup.button.callback('« Back', 'category_crypto_sub')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    });

    logger.info(`Up/Down crypto (no markets) shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error('Error showing up/down crypto:', error);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
}

