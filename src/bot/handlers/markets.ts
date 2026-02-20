import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import {
  getTopEvents,
  getEventsByCategory,
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
    await ctx.answerCbQuery('Loading events...');

    // Get bot username for deep links
    const botUsername = ctx.botInfo?.username || process.env.BOT_USERNAME || 'PolymarketTradingBot';

    let events;
    let categoryName;
    let categoryEmoji;

    const EVENTS_PER_PAGE = 5;

    if (category === 'all') {
      categoryName = 'Top Events';
      categoryEmoji = '🔥';
      events = await getTopEvents(30); // Get more for pagination
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

      events = await getEventsByCategory(category, 30); // Get more for pagination
    }

    if (!events || events.length === 0) {
      await ctx.editMessageText(
        `${categoryEmoji} *${categoryName}*\n\n` +
        '😔 No active events found in this category right now.\n\n' +
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
    const totalPages = Math.ceil(events.length / EVENTS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * EVENTS_PER_PAGE;
    const endIndex = startIndex + EVENTS_PER_PAGE;
    const pageEvents = events.slice(startIndex, endIndex);

    // Build message with event list
    const lastUpdate = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    let message = `${categoryEmoji} *${categoryName}* · ${lastUpdate}\n\n`;

    pageEvents.forEach((event, index) => {
      const number = startIndex + index + 1;
      const volume = formatVolume(event.volume24hr);
      const liquidity = formatVolume(event.liquidity || 0);
      const marketCount = event.markets?.length || 0;

      message += `${number}) *${event.title}*\n`;

      // Find the most popular market (highest volume)
      if (event.markets && event.markets.length > 0) {
        const topMarket = event.markets
          .filter(m => m.volume24hr > 0)
          .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0))[0];

        if (topMarket) {
          const prices = parseOutcomePrices(topMarket);
          const outcomes = parseOutcomes(topMarket);

          if (prices.length >= 2 && outcomes.length >= 2) {
            const price1 = parseFloat(prices[0] || '0');
            const price2 = parseFloat(prices[1] || '0');

            if (!isNaN(price1) && !isNaN(price2)) {
              const yesPrice = (price1 * 100).toFixed(1);
              const noPrice = (price2 * 100).toFixed(1);

              // Show market count for multi-market events
              if (marketCount > 1) {
                message += `📊 ${marketCount} markets\n`;
              }

              // Show top market's question if it's different from event title
              if (topMarket.question !== event.title) {
                message += `├ ${topMarket.question}\n`;
              }

              message += `├ ${outcomes[0]} ${yesPrice}¢ · ${outcomes[1]} ${noPrice}¢\n`;
            }
          }
        }
      }

      message += `├ 24h Vol ${volume} · Liq ${liquidity}\n`;
      message += `└ [View on Polymarket](https://polymarket.com/event/${event.slug}) · [Trade](https://t.me/${botUsername}?start=event_${event.id})\n\n`;
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

    // Refresh, Back and Main Menu rows
    buttons.push([
      Markup.button.callback('🔄 Refresh', `refresh_category_${category}`),
    ]);
    buttons.push([
      Markup.button.callback('« Back', 'show_categories'),
      Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
    ]);

    try {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard(buttons),
      });
    } catch (editError: any) {
      // If message is not modified (same content), just acknowledge
      if (editError.description?.includes('message is not modified')) {
        logger.debug(`Message not modified for category ${category} - data is the same`);
        // Message is already showing the latest data, no need to update
      } else {
        throw editError; // Re-throw other errors
      }
    }

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
 * Shows event details with all markets
 */
export async function handleEventDetails(ctx: Context, eventId: string): Promise<void> {
  try {
    await ctx.reply('🔄 Loading event details...');

    // Get bot username and user's default amount
    const botUsername = ctx.botInfo?.username || process.env.BOT_USERNAME || 'PolymarketTradingBot';
    const telegramId = ctx.from?.id.toString();
    let defaultAmount = 25;

    if (telegramId) {
      const { getUserByTelegramId } = await import('../../services/user');
      const user = await getUserByTelegramId(telegramId);
      if (user) {
        defaultAmount = user.defaultTradeAmount || 25;
      }
    }

    // Fetch event details from API
    const axios = (await import('axios')).default;
    const response = await axios.get(`https://gamma-api.polymarket.com/events/${eventId}`, {
      timeout: 10000,
    });

    const event = response.data;

    if (!event) {
      await ctx.reply('❌ Event not found.');
      return;
    }

    // Build event details message
    let message = `📊 *${event.title}*\n\n`;

    if (event.description) {
      message += `${event.description.substring(0, 200)}${event.description.length > 200 ? '...' : ''}\n\n`;
    }

    message += `💰 *24h Volume:* ${formatVolume(event.volume24hr)}\n`;
    message += `💎 *Total Volume:* ${formatVolume(event.volume)}\n`;
    message += `💧 *Liquidity:* ${formatVolume(event.liquidity)}\n\n`;

    // Show all markets in this event
    if (event.markets && Array.isArray(event.markets) && event.markets.length > 0) {
      message += `*Markets (${event.markets.length}):*\n\n`;

      // Sort markets by volume
      const sortedMarkets = event.markets
        .filter((m: any) => m.volume24hr > 0)
        .sort((a: any, b: any) => (b.volume24hr || 0) - (a.volume24hr || 0))
        .slice(0, 10); // Show top 10 markets

      sortedMarkets.forEach((market: any, index: number) => {
        const prices = parseOutcomePrices(market);
        const outcomes = parseOutcomes(market);

        message += `${index + 1}. ${market.question}\n`;

        if (prices.length >= 2 && outcomes.length >= 2) {
          const price1 = parseFloat(prices[0] || '0');
          const price2 = parseFloat(prices[1] || '0');

          if (!isNaN(price1) && !isNaN(price2)) {
            const yesPrice = (price1 * 100).toFixed(1);
            const noPrice = (price2 * 100).toFixed(1);
            message += `   ${outcomes[0]} ${yesPrice}¢ · ${outcomes[1]} ${noPrice}¢\n`;
          }
        }

        message += `   Vol: ${formatVolume(market.volume24hr)}\n`;

        // Add trade links - use condition_id for reliable market lookup
        const marketId = market.condition_id || market.id || market.slug;
        message += `   [Buy Yes $${defaultAmount}](https://t.me/${botUsername}?start=trade_${marketId}_yes_${defaultAmount}) · `;
        message += `[Buy No $${defaultAmount}](https://t.me/${botUsername}?start=trade_${marketId}_no_${defaultAmount}) · `;
        message += `[💰 Custom](https://t.me/${botUsername}?start=trade_${marketId}_custom)\n\n`;
      });

      if (event.markets.length > 10) {
        message += `_...and ${event.markets.length - 10} more markets_\n\n`;
      }
    }

    message += `\n🔗 [View on Polymarket](https://polymarket.com/event/${event.slug})`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Back to Markets', 'show_categories')],
      ]),
    });

    logger.info(`Event ${eventId} details shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error(`Error showing event ${eventId}:`, error);
    await ctx.reply('❌ An error occurred while loading event details.');
  }
}

/**
 * Shows market details
 * @deprecated Use handleEventDetails instead
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
 * Refresh category data by clearing cache and reloading
 */
export async function handleRefreshCategory(ctx: Context, category: string, page: number = 1): Promise<void> {
  try {
    // Clear cache for this category
    const { redisCache } = await import('../../database/redis');
    const limit = 30;
    const cacheKey = category === 'all'
      ? `markets:top_events:${limit}`
      : `events:category:${category}:${limit}`;

    await redisCache.del(cacheKey);

    logger.info(`Cache cleared for category: ${category}`);

    // Reload the category with fresh data
    await handleCategorySelection(ctx, category, page);

    // If we got here without error, data was refreshed successfully
    await ctx.answerCbQuery('✅ Data refreshed!');
  } catch (error: any) {
    logger.error(`Error refreshing category ${category}:`, error);

    // Check if it's just because message wasn't modified
    if (error.description?.includes('message is not modified')) {
      await ctx.answerCbQuery('✅ Already showing latest data');
    } else {
      await ctx.answerCbQuery('❌ Error refreshing data');
    }
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
