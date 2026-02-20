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
    message += '_Deposit/Withdraw in and out of your Polymarket wallet instantly_\n\n';
    message += '💰 *Deposit Addresses (Bridge API)*\n\n';

    // Show deposit addresses from Bridge API
    if (user.depositAddressEvm) {
      message += '🔷 *EVM Chains (Ethereum/Arbitrum/Base/Optimism):*\n';
      message += `\`${user.depositAddressEvm}\`\n`;
      message += '_Supports USDC, ETH, and other ERC20 tokens_\n\n';

      message += '🟣 *Solana:*\n';
      message += `\`${user.depositAddressSvm}\`\n`;
      message += '_Supports USDC, SOL, and other SPL tokens_\n\n';

      message += '🟠 *Bitcoin:*\n';
      message += `\`${user.depositAddressBtc}\`\n`;
      message += '_BTC deposits automatically converted to USDC.e_\n\n';

      message += '🔴 *Tron:*\n';
      message += `\`${user.depositAddressTvm}\`\n`;
      message += '_Supports USDT(TRC20), TRX_\n\n';

      message += '💸 _All deposits auto-convert to USDC.e on Polygon_\n\n';
    } else {
      // Fallback for old users without deposit addresses
      message += '⚠️ *Legacy Wallet - Please contact support*\n\n';
    }

    // Polymarket Trading Wallet
    message += '🏦 *Polymarket Trading Wallet*\n';
    if (user.polymarketProxyAddress) {
      message += `\`${user.polymarketProxyAddress}\`\n`;
      message += '✅ _Active and ready for trading_\n\n';
    } else {
      message += '⚠️ _Setup incomplete - contact support_\n\n';
    }

    // Owner Wallet (EOA)
    message += '📍 *Owner Wallet (EOA)*\n';
    message += `\`${user.walletAddress}\`\n`;
    message += '_Used for transaction signing_\n\n';

    // Trading Balance (Real data from API)
    message += `💰 *Current Trading Balance:* $${balance}\n`;
    message += '💡 *Minimum deposit: $10 USDC*';

    // Buttons
    const buttons = [
      [
        Markup.button.url('👤 Profile', `https://polymarket.com/profile/${user.polymarketProxyAddress || user.walletAddress}`),
        Markup.button.callback('📊 Portfolio', 'portfolio'),
      ],
      [
        Markup.button.callback('⚙️ Settings', 'settings_menu'),
        Markup.button.callback('💰 Deposit', 'deposit_menu'),
      ],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    }).catch((err: any) => {
      // Ignore "message is not modified" errors
      if (!err.message?.includes('message is not modified')) {
        throw err;
      }
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
        [Markup.button.callback('📊 Active Positions', 'portfolio_open_1')],
        [Markup.button.callback('📜 Closed Positions', 'portfolio_closed_1')],
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

    const positions = portfolioData.activePositions; // Only active positions (size > 0)

    if (positions.length === 0) {
      await ctx.editMessageText(
        '📊 *Active Positions*\n\n' +
        '📭 You have no active positions.\n\n' +
        'Your active bets/shares in markets will appear here.',
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
    const totalPages = Math.ceil(positions.length / ITEMS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pagePositions = positions.slice(startIndex, endIndex);

    // Build message
    let message = `📊 *Active Positions*\n\n`;
    message += `Found ${positions.length} active position${positions.length > 1 ? 's' : ''}\n\n`;

    pagePositions.forEach((position, index) => {
      const number = startIndex + index + 1;
      const market = position.market || 'Unknown Market';
      const outcome = position.outcome || 'Unknown';
      const size = parseFloat(position.size || '0');
      const shares = isNaN(size) ? '0.00' : size.toFixed(2);
      const unrealizedPnl = parseFloat(position.unrealized_pnl || '0');
      const pnl = isNaN(unrealizedPnl) ? 'N/A' : `$${unrealizedPnl.toFixed(2)}`;

      message += `${number}) *${outcome}*\n`;
      message += `├ Market: ${market.substring(0, 50)}${market.length > 50 ? '...' : ''}\n`;
      message += `├ Shares: ${shares}\n`;
      message += `├ Unrealized P&L: ${pnl}\n`;
      message += `└ Asset ID: ${position.asset_id.substring(0, 10)}...\n\n`;
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

    const closedPositions = portfolioData.closedPositions; // Positions I exited or settled

    if (closedPositions.length === 0) {
      await ctx.editMessageText(
        '📜 *Closed Positions*\n\n' +
        '📭 You have no closed positions.\n\n' +
        'Positions you exited or settled markets will appear here.',
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
    const totalPages = Math.ceil(closedPositions.length / ITEMS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pagePositions = closedPositions.slice(startIndex, endIndex);

    // Build message
    let message = `📜 *Closed Positions*\n\n`;
    message += `Found ${closedPositions.length} closed position${closedPositions.length > 1 ? 's' : ''}\n\n`;

    pagePositions.forEach((position, index) => {
      const number = startIndex + index + 1;
      const market = position.market || 'Unknown Market';
      const outcome = position.outcome || 'Unknown';
      const realizedPnlNum = parseFloat(position.realized_pnl || '0');
      const costBasisNum = parseFloat(position.cost_basis || '0');
      const realizedPnl = isNaN(realizedPnlNum) ? 'N/A' : `$${realizedPnlNum.toFixed(2)}`;
      const costBasis = isNaN(costBasisNum) ? 'N/A' : `$${costBasisNum.toFixed(2)}`;

      message += `${number}) *${outcome}*\n`;
      message += `├ Market: ${market.substring(0, 50)}${market.length > 50 ? '...' : ''}\n`;
      message += `├ Cost Basis: ${costBasis}\n`;
      message += `├ Realized P&L: ${realizedPnl}\n`;
      message += `└ Asset ID: ${position.asset_id.substring(0, 10)}...\n\n`;
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
