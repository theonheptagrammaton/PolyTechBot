import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import {
  getTopMarkets,
  getMarketsByCategory,
  formatVolume,
  formatPrice,
  parseOutcomePrices,
  parseOutcomes,
} from '../../services/market';
import { logger } from '../../utils/logger';

/**
 * Shows market categories
 */
export async function handleShowCategories(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    await ctx.editMessageText(
      '📊 *Browse Polymarket*\n\n' +
      'Select a category to explore the most popular prediction markets:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🏛️ Politics', 'category_politics')],
          [Markup.button.callback('₿ Crypto', 'category_crypto')],
          [Markup.button.callback('⚽ Sports', 'category_sports')],
          [Markup.button.callback('💼 Business', 'category_business')],
          [Markup.button.callback('🎬 Pop Culture', 'category_pop-culture')],
          [Markup.button.callback('🔥 Top Markets (All)', 'category_all')],
          [Markup.button.callback('« Back', 'back_to_menu')],
        ]),
      }
    );

    logger.info(`Categories shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error('Error showing categories:', error);
    await ctx.reply('❌ An error occurred while loading categories. Please try again.');
  }
}

/**
 * Shows markets for a specific category with pagination
 */
export async function handleCategorySelection(ctx: Context, category: string, page: number = 1): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading markets...');

    let markets;
    let categoryName;
    let categoryEmoji;

    const MARKETS_PER_PAGE = 5;

    if (category === 'all') {
      categoryName = 'Top Markets';
      categoryEmoji = '🔥';
      markets = await getTopMarkets(30); // Get more for pagination
    } else {
      const categoryMap: Record<string, { name: string; emoji: string }> = {
        'politics': { name: 'Politics', emoji: '🏛️' },
        'crypto': { name: 'Crypto', emoji: '₿' },
        'sports': { name: 'Sports', emoji: '⚽' },
        'business': { name: 'Business', emoji: '💼' },
        'pop-culture': { name: 'Pop Culture', emoji: '🎬' },
      };

      const cat = categoryMap[category];
      categoryName = cat?.name || category;
      categoryEmoji = cat?.emoji || '📊';

      markets = await getMarketsByCategory(category, 30); // Get more for pagination
    }

    if (!markets || markets.length === 0) {
      await ctx.editMessageText(
        `${categoryEmoji} *${categoryName}*\n\n` +
        '😔 No active markets found in this category right now.\n\n' +
        'Try another category or check back later!',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back to Categories', 'show_categories')],
          ]),
        }
      );
      return;
    }

    // Calculate pagination
    const totalPages = Math.ceil(markets.length / MARKETS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * MARKETS_PER_PAGE;
    const endIndex = startIndex + MARKETS_PER_PAGE;
    const pageMarkets = markets.slice(startIndex, endIndex);

    // Build message with market list
    let message = `🔍 *Market Search — ${categoryName}*\n\n`;

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

      // Show outcome probabilities if available - with safe parsing
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
      message += `└ [Trade](https://polymarket.com/event/${market.slug}) · [View on Polymarket](https://polymarket.com/event/${market.slug})\n\n`;
    });

    // Build pagination buttons
    const buttons: any[] = [];

    // Prev/Next row
    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('◀️ Prev', `page_${category}_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`Page ${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ▶️', `page_${category}_${currentPage + 1}`));
    }
    buttons.push(navRow);

    // Back and Main Menu row
    buttons.push([
      Markup.button.callback('« Back', 'show_categories'),
      Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Category ${category} page ${currentPage} shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error(`Error showing category ${category}:`, error);
    await ctx.editMessageText(
      '❌ *Error Loading Markets*\n\n' +
      'We encountered an error while fetching markets. This might be a temporary issue.\n\n' +
      'Please try again in a moment.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Categories', 'show_categories')],
        ]),
      }
    );
  }
}

/**
 * Shows market details
 */
export async function handleMarketDetails(ctx: Context, marketId: string): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading market details...');

    const { getMarketDetails } = await import('../../services/market');
    const market = await getMarketDetails(marketId);

    if (!market) {
      await ctx.reply('❌ Market not found.');
      return;
    }

    let message = `📊 *Market Details*\n\n`;
    message += `*${market.question}*\n\n`;

    if (market.image) {
      message += `🖼️ [View Image](${market.image})\n\n`;
    }

    message += `💰 *24h Volume:* ${formatVolume(market.volume24hr)}\n`;
    message += `💎 *Total Volume:* ${formatVolume(market.volumeNum)}\n`;
    message += `💧 *Liquidity:* ${formatVolume(market.liquidity)}\n`;
    message += `📅 *End Date:* ${new Date(market.endDate).toLocaleDateString()}\n\n`;

    const prices = parseOutcomePrices(market);
    const outcomes = parseOutcomes(market);

    if (prices.length > 0 && outcomes.length > 0) {
      message += `*Current Odds:*\n`;
      outcomes.forEach((outcome, i) => {
        if (prices[i]) {
          message += `• ${outcome}: ${formatPrice(prices[i])}\n`;
        }
      });
      message += '\n';
    }

    message += `🔗 [Trade on Polymarket](https://polymarket.com/event/${market.slug})\n\n`;
    message += '📝 _Trading via bot coming soon..._';

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([
        [Markup.button.url('📈 Trade Now', `https://polymarket.com/event/${market.slug}`)],
        [Markup.button.callback('« Back to Markets', 'show_categories')],
      ]),
    });

    logger.info(`Market ${marketId} details shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error(`Error showing market ${marketId}:`, error);
    await ctx.reply('❌ An error occurred while loading market details.');
  }
}

/**
 * Back to menu handler
 */
export async function handleBackToMenu(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    await ctx.editMessageText(
      '🏠 *Main Menu*\n\n' +
      'What would you like to do?',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Browse Markets', 'show_categories')],
          [Markup.button.callback('🔍 Search Markets', 'search_markets')],
          [Markup.button.callback('💼 My Wallet', 'show_wallet')],
        ]),
      }
    );
  } catch (error) {
    logger.error('Error going back to menu:', error);
  }
}

/**
 * Show wallet info handler - redirects to wallet page
 */
export async function handleShowWallet(ctx: Context): Promise<void> {
  try {
    // Import and call the wallet page handler
    const { handleWalletPage } = await import('./walletPage');
    await handleWalletPage(ctx);
  } catch (error) {
    logger.error('Error showing wallet:', error);
    await ctx.reply('❌ An error occurred while fetching your wallet information.');
  }
}
