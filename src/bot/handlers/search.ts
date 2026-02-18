import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { searchMarkets, formatVolume, parseOutcomePrices, parseOutcomes } from '../../services/market';
import { logger } from '../../utils/logger';

/**
 * Shows search prompt
 */
export async function handleSearchPrompt(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const message =
      '🔍 *Search Markets*\n\n' +
      'Send me a keyword to search for markets.\n\n' +
      '*Examples:*\n' +
      '• `Trump`\n' +
      '• `Bitcoin`\n' +
      '• `NFL`\n' +
      '• `election`\n\n' +
      '💡 _Minimum 3 characters required_';

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'back_to_menu')],
      ]),
    });

    logger.info(`Search prompt shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error('Error showing search prompt:', error);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
}

/**
 * Handles search command
 */
export async function handleSearchCommand(ctx: Context): Promise<void> {
  try {
    // @ts-ignore - Telegraf types
    const message = ctx.message?.text || '';
    const keyword = message.replace('/search', '').trim();

    if (!keyword) {
      await ctx.reply(
        '🔍 *Search Markets*\n\n' +
        'Usage: `/search [keyword]`\n\n' +
        '*Examples:*\n' +
        '• `/search Trump`\n' +
        '• `/search Bitcoin`\n' +
        '• `/search NFL`\n\n' +
        '💡 _Minimum 3 characters required_',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (keyword.length < 3) {
      await ctx.reply(
        '⚠️ *Keyword too short*\n\n' +
        'Please enter at least 3 characters to search.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await handleSearch(ctx, keyword, 1);
  } catch (error) {
    logger.error('Error in search command:', error);
    await ctx.reply('❌ An error occurred while searching. Please try again.');
  }
}

/**
 * Performs market search with pagination
 */
export async function handleSearch(ctx: Context, keyword: string, page: number = 1): Promise<void> {
  try {
    const loadingMsg = await ctx.reply(`🔍 Searching for "${keyword}"...`);

    const markets = await searchMarkets(keyword);

    // Delete loading message
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
    } catch {}

    if (markets.length === 0) {
      await ctx.reply(
        '😔 *No Results Found*\n\n' +
        `No markets found for "${keyword}".\n\n` +
        '💡 *Try:*\n' +
        '• Using different keywords\n' +
        '• Checking spelling\n' +
        '• Using shorter terms',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔍 New Search', 'search_markets')],
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    // Pagination
    const MARKETS_PER_PAGE = 5;
    const totalPages = Math.ceil(markets.length / MARKETS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * MARKETS_PER_PAGE;
    const endIndex = startIndex + MARKETS_PER_PAGE;
    const pageMarkets = markets.slice(startIndex, endIndex);

    // Build message
    let message = `🔍 *Search Results for "${keyword}"*\n\n`;
    message += `Found ${markets.length} market${markets.length > 1 ? 's' : ''}\n\n`;

    pageMarkets.forEach((market, index) => {
      const number = startIndex + index + 1;
      const volume = formatVolume(market.volume24hr);
      const liquidity = formatVolume(market.liquidity || 0);
      const endDate = new Date(market.endDate).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });

      message += `${number}) ${market.question}\n`;

      // Show prices
      const prices = parseOutcomePrices(market);
      const outcomes = parseOutcomes(market);

      if (prices.length >= 2 && outcomes.length >= 2) {
        const price1 = parseFloat(prices[0] || '0');
        const price2 = parseFloat(prices[1] || '0');

        if (!isNaN(price1) && !isNaN(price2)) {
          const yesPrice = (price1 * 100).toFixed(1);
          const noPrice = (price2 * 100).toFixed(1);
          message += `├ ${outcomes[0]} ${yesPrice}¢ · ${outcomes[1]} ${noPrice}¢\n`;
        }
      }

      message += `├ 24h Vol ${volume} · Liq ${liquidity} · Exp ${endDate}\n`;
      message += `└ [Trade](https://polymarket.com/event/${market.slug}) · [View](https://polymarket.com/event/${market.slug})\n\n`;
    });

    // Build buttons
    const buttons: any[] = [];

    // Pagination row
    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('◀️ Prev', `search_page_${keyword}_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`Page ${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ▶️', `search_page_${keyword}_${currentPage + 1}`));
    }
    buttons.push(navRow);

    // Action buttons
    buttons.push([
      Markup.button.callback('🔍 New Search', 'search_markets'),
      Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
    ]);

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Search results for "${keyword}" shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error(`Error searching for "${keyword}":`, error);
    await ctx.reply('❌ An error occurred while searching. Please try again.');
  }
}
