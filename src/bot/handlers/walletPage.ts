import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { logger } from '../../utils/logger';
import {
  getPortfolioData,
  getBalance,
  formatOrderPrice,
  formatOrderSize,
  calculateTradeValue,
  formatTimestamp,
  OpenOrder,
  Trade,
} from '../../services/portfolio';

/**
 * Shows detailed wallet page with deposit addresses
 */
export async function handleWalletPage(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.editMessageText(
        '❌ You don\'t have a wallet yet.\n\n' +
        'Use /start to create your Polymarket wallet.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back', 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    // Fetch real balance
    let balance = '0.00';
    try {
      balance = await getBalance(
        user.encryptedPrivateKey,
        user.encryptedApiKey,
        user.encryptedApiSecret,
        user.encryptedPassphrase
      );
      logger.info(`Balance fetched for user ${telegramId}: $${balance}`);
    } catch (balanceError) {
      logger.error('Error fetching balance for wallet page:', balanceError);
      // Continue with 0.00 balance
    }

    // Build wallet message
    let message = '💼 *WALLET*\n\n';
    message += '_Deposit/Withdraw in and out of your Polygun safe wallet instantly_\n\n';
    message += '💼 *Deposit Wallets*\n\n';

    // Polygon (POL, USDC, USDC.e)
    message += '🟢 *Polygon (POL, USDC, USDC.e):*\n';
    message += `\`${user.walletAddress}\`\n\n`;

    // Solana (SOL, USDT, USDC)
    if (user.solanaAddress) {
      message += '🟣 *Solana (SOL, USDT, USDC):*\n';
      message += `\`${user.solanaAddress}\`\n\n`;
    }

    // Ethereum (ETH, USDT, USDC) - same address as Polygon (EVM compatible)
    message += '🔵 *Ethereum (ETH, USDT, USDC):*\n';
    message += `\`${user.walletAddress}\`\n\n`;

    // BNB (BNB, USDT, USDC) - same address as Polygon (EVM compatible)
    message += '🟡 *BNB (BNB, USDT, USDC):*\n';
    message += `\`${user.walletAddress}\`\n\n`;

    // Polymarket Wallet (Don't Deposit Here)
    message += '✅ *Polymarket Wallet: (Don\'t Deposit Here)*\n';
    message += `\`${user.walletAddress}\`\n\n`;

    // Trading Balance (Real data from API)
    message += `💰 *Current Trading Balance:* $${balance}\n`;
    message += '💡 *Minimum deposit amount is $10 worth of tokens.*';

    // Buttons
    const buttons = [
      [
        Markup.button.url('👤 Profile', `https://polymarket.com/profile/${user.walletAddress}`),
        Markup.button.callback('📊 Portfolio', 'portfolio'),
      ],
      [
        Markup.button.callback('🔐 2FA Settings', '2fa_menu'),
        Markup.button.callback('💸 Withdraw', 'withdraw'),
      ],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Wallet page shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing wallet page:', error);
    await ctx.reply('❌ An error occurred while loading your wallet information.');
  }
}

/**
 * Shows portfolio with tabs
 */
export async function handlePortfolio(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const message =
      '📊 *Portfolio*\n\n' +
      'View your trading activity and positions:\n\n' +
      '💡 Select a category below to see your transactions.';

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🟢 Open Positions', 'portfolio_open_1')],
        [Markup.button.callback('🔴 Closed Positions', 'portfolio_closed_1')],
        [Markup.button.callback('📋 All Transactions', 'portfolio_all_1')],
        [Markup.button.callback('« Back to Wallet', 'wallet_page')],
      ]),
    });

    logger.info(`Portfolio menu shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error('Error showing portfolio:', error);
    await ctx.reply('❌ An error occurred while loading portfolio.');
  }
}

/**
 * Shows open positions with pagination
 */
export async function handleOpenPositions(ctx: Context, page: number = 1): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading open positions...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.editMessageText('❌ User not found. Use /start to create your wallet.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    const portfolioData = await getPortfolioData(
      user.encryptedPrivateKey,
      user.encryptedApiKey,
      user.encryptedApiSecret,
      user.encryptedPassphrase
    );

    const openOrders = portfolioData.openOrders;

    if (openOrders.length === 0) {
      await ctx.editMessageText(
        '🟢 *Open Positions*\n\n' +
        '📭 You have no open positions.\n\n' +
        'Open positions appear here when you place orders on Polymarket.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back to Portfolio', 'portfolio')],
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    // Pagination
    const ITEMS_PER_PAGE = 5;
    const totalPages = Math.ceil(openOrders.length / ITEMS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageOrders = openOrders.slice(startIndex, endIndex);

    // Build message
    let message = `🟢 *Open Positions*\n\n`;
    message += `Found ${openOrders.length} open position${openOrders.length > 1 ? 's' : ''}\n\n`;

    pageOrders.forEach((order, index) => {
      const number = startIndex + index + 1;
      const side = order.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
      const price = formatOrderPrice(order.price);
      const size = formatOrderSize(order.original_size);
      const filled = formatOrderSize(order.size_matched);
      const value = calculateTradeValue(order.original_size, order.price);
      const created = formatTimestamp(order.created_at);

      message += `${number}) *${order.outcome}*\n`;
      message += `├ ${side} · ${price}\n`;
      message += `├ Size: ${size} · Filled: ${filled}\n`;
      message += `├ Value: ${value}\n`;
      message += `└ Created: ${created}\n\n`;
    });

    // Build buttons
    const buttons: any[] = [];

    // Pagination row
    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('◀️ Prev', `portfolio_open_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`Page ${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ▶️', `portfolio_open_${currentPage + 1}`));
    }
    buttons.push(navRow);

    // Action buttons
    buttons.push([Markup.button.callback('« Back to Portfolio', 'portfolio')]);
    buttons.push([Markup.button.callback('🏠 Main Menu', 'back_to_menu')]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Open positions page ${currentPage} shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing open positions:', error);
    await ctx.editMessageText(
      '❌ *Error Loading Positions*\n\n' +
      'We encountered an error while fetching your positions.\n\n' +
      'This might be a temporary issue. Please try again.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Portfolio', 'portfolio')],
        ]),
      }
    );
  }
}

/**
 * Shows closed positions (trades) with pagination
 */
export async function handleClosedPositions(ctx: Context, page: number = 1): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading closed positions...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.editMessageText('❌ User not found. Use /start to create your wallet.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    const portfolioData = await getPortfolioData(
      user.encryptedPrivateKey,
      user.encryptedApiKey,
      user.encryptedApiSecret,
      user.encryptedPassphrase
    );

    const trades = portfolioData.trades;

    if (trades.length === 0) {
      await ctx.editMessageText(
        '🔴 *Closed Positions*\n\n' +
        '📭 You have no closed positions.\n\n' +
        'Your completed trades will appear here.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back to Portfolio', 'portfolio')],
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    // Pagination
    const ITEMS_PER_PAGE = 5;
    const totalPages = Math.ceil(trades.length / ITEMS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageTrades = trades.slice(startIndex, endIndex);

    // Build message
    let message = `🔴 *Closed Positions*\n\n`;
    message += `Found ${trades.length} completed trade${trades.length > 1 ? 's' : ''}\n\n`;

    pageTrades.forEach((trade, index) => {
      const number = startIndex + index + 1;
      const side = trade.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
      const price = formatOrderPrice(trade.price);
      const size = formatOrderSize(trade.size);
      const value = calculateTradeValue(trade.size, trade.price);
      const matchTime = formatTimestamp(trade.match_time);

      message += `${number}) *${trade.outcome}*\n`;
      message += `├ ${side} · ${price}\n`;
      message += `├ Size: ${size}\n`;
      message += `├ Value: ${value}\n`;
      message += `└ Date: ${matchTime}\n\n`;
    });

    // Build buttons
    const buttons: any[] = [];

    // Pagination row
    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('◀️ Prev', `portfolio_closed_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`Page ${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ▶️', `portfolio_closed_${currentPage + 1}`));
    }
    buttons.push(navRow);

    // Action buttons
    buttons.push([Markup.button.callback('« Back to Portfolio', 'portfolio')]);
    buttons.push([Markup.button.callback('🏠 Main Menu', 'back_to_menu')]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Closed positions page ${currentPage} shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing closed positions:', error);
    await ctx.editMessageText(
      '❌ *Error Loading Trades*\n\n' +
      'We encountered an error while fetching your trade history.\n\n' +
      'This might be a temporary issue. Please try again.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Portfolio', 'portfolio')],
        ]),
      }
    );
  }
}

/**
 * Shows all transactions (open + closed) with pagination
 */
export async function handleAllTransactions(ctx: Context, page: number = 1): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading all transactions...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.editMessageText('❌ User not found. Use /start to create your wallet.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    const portfolioData = await getPortfolioData(
      user.encryptedPrivateKey,
      user.encryptedApiKey,
      user.encryptedApiSecret,
      user.encryptedPassphrase
    );

    const openOrders = portfolioData.openOrders;
    const trades = portfolioData.trades;

    // Combine and sort all transactions
    interface Transaction {
      type: 'order' | 'trade';
      data: OpenOrder | Trade;
      timestamp: number;
    }

    const allTransactions: Transaction[] = [
      ...openOrders.map((order) => ({
        type: 'order' as const,
        data: order,
        timestamp: order.created_at,
      })),
      ...trades.map((trade) => ({
        type: 'trade' as const,
        data: trade,
        timestamp: new Date(trade.match_time).getTime(),
      })),
    ].sort((a, b) => b.timestamp - a.timestamp);

    if (allTransactions.length === 0) {
      await ctx.editMessageText(
        '📋 *All Transactions*\n\n' +
        '📭 You have no transactions yet.\n\n' +
        'Your trading activity will appear here.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back to Portfolio', 'portfolio')],
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    // Pagination
    const ITEMS_PER_PAGE = 5;
    const totalPages = Math.ceil(allTransactions.length / ITEMS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageTransactions = allTransactions.slice(startIndex, endIndex);

    // Build message
    let message = `📋 *All Transactions*\n\n`;
    message += `Found ${allTransactions.length} transaction${allTransactions.length > 1 ? 's' : ''}\n\n`;

    pageTransactions.forEach((tx, index) => {
      const number = startIndex + index + 1;

      if (tx.type === 'order') {
        const order = tx.data as OpenOrder;
        const side = order.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
        const price = formatOrderPrice(order.price);
        const size = formatOrderSize(order.original_size);
        const value = calculateTradeValue(order.original_size, order.price);
        const created = formatTimestamp(order.created_at);

        message += `${number}) 🟢 *OPEN ORDER*\n`;
        message += `├ ${order.outcome}\n`;
        message += `├ ${side} · ${price}\n`;
        message += `├ Size: ${size} · Value: ${value}\n`;
        message += `└ ${created}\n\n`;
      } else {
        const trade = tx.data as Trade;
        const side = trade.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
        const price = formatOrderPrice(trade.price);
        const size = formatOrderSize(trade.size);
        const value = calculateTradeValue(trade.size, trade.price);
        const matchTime = formatTimestamp(trade.match_time);

        message += `${number}) ✅ *COMPLETED*\n`;
        message += `├ ${trade.outcome}\n`;
        message += `├ ${side} · ${price}\n`;
        message += `├ Size: ${size} · Value: ${value}\n`;
        message += `└ ${matchTime}\n\n`;
      }
    });

    // Build buttons
    const buttons: any[] = [];

    // Pagination row
    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('◀️ Prev', `portfolio_all_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`Page ${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ▶️', `portfolio_all_${currentPage + 1}`));
    }
    buttons.push(navRow);

    // Action buttons
    buttons.push([Markup.button.callback('« Back to Portfolio', 'portfolio')]);
    buttons.push([Markup.button.callback('🏠 Main Menu', 'back_to_menu')]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`All transactions page ${currentPage} shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing all transactions:', error);
    await ctx.editMessageText(
      '❌ *Error Loading Transactions*\n\n' +
      'We encountered an error while fetching your transactions.\n\n' +
      'This might be a temporary issue. Please try again.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Portfolio', 'portfolio')],
        ]),
      }
    );
  }
}

/**
 * Shows withdraw/deposit page
 */
export async function handleWithdraw(ctx: Context): Promise<void> {
  try {
    // Import and call deposit handler
    const { handleDepositMenu } = await import('./deposit');
    await handleDepositMenu(ctx);
  } catch (error) {
    logger.error('Error showing deposit page:', error);
    await ctx.reply('❌ An error occurred while loading deposit page.');
  }
}
