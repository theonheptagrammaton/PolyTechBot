import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { logger } from '../../utils/logger';
import { isBenignTelegramError, sendPage } from '../../utils/telegram';
import { config } from '../../config';
import { ce, esc, EMOJI } from '../../utils/customEmoji';
import {
  getPortfolioData,
  getOpenOrders,
  getBalance,
  getActivePositions,
  getClosedPositions,
  cancelOrderById,
  cancelAllOrders,
  invalidatePortfolioCache,
  formatOrderPrice,
  formatTimestamp,
  OpenOrder,
  Trade,
  ActivePosition,
  ClosedPosition,
} from '../../services/portfolio';

/**
 * Shows detailed wallet page with deposit addresses
 */
export async function handleWalletPage(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await sendPage(ctx,
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
    const eWallet = ce(EMOJI.walletPurse,    '👛');
    const eEvm    = ce(EMOJI.ethDeposit,     '🔹');
    const eSol    = ce(EMOJI.solanaDeposit,  '🟣');
    const eUsdc   = ce(EMOJI.usdc,           '💲');

    let message = `${eWallet} <b>WALLET</b>\n\n`;
    message += `💰 <b>Deposit Addresses</b>\n\n`;

    // Show deposit addresses from Bridge API
    if (user.depositAddressEvm) {
      message += `${eEvm} <b>EVM (ETH/Arbitrum/Base/Optimism):</b>\n`;
      message += `<code>${esc(user.depositAddressEvm)}</code>\n\n`;

      message += `${eSol} <b>Solana:</b>\n`;
      message += `<code>${esc(user.depositAddressSvm || '')}</code>\n\n`;

      message += `🟠 <b>Bitcoin:</b>\n`;
      message += `<code>${esc(user.depositAddressBtc || '')}</code>\n\n`;

      message += `🔴 <b>Tron:</b>\n`;
      message += `<code>${esc(user.depositAddressTvm || '')}</code>\n\n`;
    } else {
      message += `⚠️ <b>Legacy Wallet - Please contact support</b>\n\n`;
    }

    // Polymarket Trading Wallet
    message += `🏦 <b>Polymarket Trading Wallet:</b>\n`;
    if (user.polymarketProxyAddress) {
      message += `<code>${esc(user.polymarketProxyAddress)}</code>\n\n`;
    } else {
      message += `⚠️ <i>Setup incomplete - contact support</i>\n\n`;
    }

    // Owner Wallet (EOA)
    message += `📍 <b>Owner Wallet (EOA):</b>\n`;
    message += `<code>${esc(user.walletAddress)}</code>\n\n`;

    // Trading Balance (Real data from API)
    message += `${eUsdc} <b>Balance:</b> $${esc(balance)}\n`;
    message += `💡 <b>Min deposit: $10 USDC</b>`;

    // Buttons
    const buttons = [
      [
        Markup.button.url('👤 Profile', `https://polymarket.com/profile/${user.polymarketProxyAddress || user.walletAddress}`),
        Markup.button.callback('📊 Portfolio', 'portfolio'),
      ],
      [
        Markup.button.callback('💰 Deposit',  'deposit_menu'),
        Markup.button.callback('💸 Withdraw', 'withdraw_menu'),
      ],
      [
        Markup.button.callback('👥 Referrals', 'referral_hub'),
        Markup.button.callback('⚙️ Settings',  'settings_menu'),
      ],
      [
        Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
      ],
    ];

    await sendPage(ctx, message, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Wallet page shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing wallet page:', error);
    await ctx.reply('❌ An error occurred while loading your wallet information.');
  }
}

/**
 * Shows portfolio overview with real summary stats
 */
export async function handlePortfolio(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendPage(ctx, '❌ User not found. Use /start to create your wallet.');
      return;
    }

    const [activePositions, closedPositions, balance] = await Promise.all([
      getActivePositions(user.polymarketProxyAddress || '').catch(() => [] as ActivePosition[]),
      getClosedPositions(user.polymarketProxyAddress || '').catch(() => [] as ClosedPosition[]),
      getBalance(
        user.encryptedPrivateKey, user.encryptedApiKey,
        user.encryptedApiSecret, user.encryptedPassphrase
      ).catch(() => '0.00'),
    ]);

    const totalInvested     = activePositions.reduce((s, p) => s + p.totalBought, 0);
    const totalCurrentValue = activePositions.reduce((s, p) => s + p.currentValue, 0);
    const totalUnrealizedPnl = activePositions.reduce((s, p) => s + p.cashPnl, 0);
    const totalRealizedPnl  = closedPositions.reduce((s, p) => s + p.realizedPnl, 0);

    const unPnlSign  = totalUnrealizedPnl >= 0 ? '+' : '';
    const unPnlEmoji = totalUnrealizedPnl >= 0 ? '🟢' : '🔴';
    const rePnlSign  = totalRealizedPnl >= 0 ? '+' : '';
    const rePnlEmoji = totalRealizedPnl >= 0 ? '🟢' : '🔴';

    let message = '📊 *Portfolio Overview*\n\n';
    message += `💰 Available Balance: *$${balance}*\n\n`;

    if (activePositions.length > 0) {
      message += `📦 *${activePositions.length} Active Position${activePositions.length !== 1 ? 's' : ''}*\n`;
      message += `├ Invested: $${totalInvested.toFixed(2)}\n`;
      message += `├ Current Value: $${totalCurrentValue.toFixed(2)}\n`;
      message += `└ ${unPnlEmoji} Unrealized P&L: ${unPnlSign}$${totalUnrealizedPnl.toFixed(2)}\n\n`;
    } else {
      message += `📦 *No Active Positions*\n\n`;
    }

    if (closedPositions.length > 0) {
      message += `📜 *${closedPositions.length} Closed Position${closedPositions.length !== 1 ? 's' : ''}*\n`;
      message += `└ ${rePnlEmoji} Total Realized P&L: ${rePnlSign}$${totalRealizedPnl.toFixed(2)}\n\n`;
    } else {
      message += `📜 *No Closed Positions*\n\n`;
    }

    message += '_Select a section below for details._';

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 Active Positions', 'portfolio_open_1')],
        [Markup.button.callback('📋 Open Orders',      'portfolio_orders_1')],
        [Markup.button.callback('📜 Closed Positions', 'portfolio_closed_1')],
        [Markup.button.callback('📝 Trade History',    'portfolio_all_1')],
        [Markup.button.callback('« Back to Wallet', 'wallet_page')],
        [Markup.button.callback('🏠 Main Menu',     'back_to_menu')],
      ]),
    });

    logger.info(`Portfolio overview shown to user: ${ctx.from?.id}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing portfolio:', error);
    await ctx.reply('❌ An error occurred while loading portfolio.');
  }
}

/**
 * Shows active positions with pagination (3 per page) and per-position Buy/Sell/View buttons
 */
export async function handleOpenPositions(ctx: Context, page: number = 1): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading positions...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendPage(ctx, '❌ User not found. Use /start to create your wallet.');
      return;
    }

    // Fetch positions and update cache for Buy/Sell/View actions
    const { positionListCache } = await import('./positionTrade');
    const positions = await getActivePositions(user.polymarketProxyAddress || '');
    positionListCache.set(telegramId, positions);

    if (positions.length === 0) {
      // Check for pending open orders so user knows their trades are on the book
      let openOrdersHint = '';
      try {
        const openOrds = await getOpenOrders(
          user.encryptedPrivateKey, user.encryptedApiKey,
          user.encryptedApiSecret, user.encryptedPassphrase
        );
        if (openOrds.length > 0) {
          openOrdersHint =
            `\n\n📋 You have *${openOrds.length} open order${openOrds.length > 1 ? 's' : ''}* waiting to fill.\n` +
            `_Positions appear here once your orders are matched._`;
        }
      } catch { /* non-critical */ }

      await sendPage(ctx,
        `📊 *Active Positions*\n\n📭 No filled positions yet.${openOrdersHint}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📋 Open Orders', 'portfolio_orders_1')],
            [Markup.button.callback('« Portfolio', 'portfolio')],
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    const ITEMS_PER_PAGE = 2;
    const totalPages = Math.ceil(positions.length / ITEMS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const pagePositions = positions.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    const esc = (s: string) => s.replace(/[_*`[\]()]/g, '\\$&');
    const botUsername = config.telegram.botUsername;

    // Summary header
    const totalValue = positions.reduce((s, p) => s + p.currentValue, 0);
    const totalPnl   = positions.reduce((s, p) => s + p.cashPnl, 0);
    const summarySign  = totalPnl >= 0 ? '+' : '';
    const summaryEmoji = totalPnl >= 0 ? '🟢' : '🔴';

    let message = `📊 *Active Positions* (${positions.length} total · page ${currentPage}/${totalPages})\n`;
    message += `${summaryEmoji} Total Value: $${totalValue.toFixed(2)} · P&L: ${summarySign}$${totalPnl.toFixed(2)}\n\n`;

    pagePositions.forEach((pos: ActivePosition, i) => {
      const idx = startIndex + i;
      const num = idx + 1;
      const rawTitle = pos.title || 'Unknown Market';
      const truncTitle = esc(rawTitle.length > 46 ? rawTitle.substring(0, 46) + '…' : rawTitle);
      const pnlSign  = pos.cashPnl >= 0 ? '+' : '';
      const pnlEmoji = pos.cashPnl >= 0 ? '🟢' : '🔴';
      const endDate = pos.endDate
        ? new Date(pos.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'N/A';

      const viewLink = `https://t.me/${botUsername}?start=pv_${idx}`;
      const buyLink  = `https://t.me/${botUsername}?start=pb_${idx}`;
      const sellLink = `https://t.me/${botUsername}?start=ps_${idx}`;

      message += `*${num}) ${esc(pos.outcome || 'Unknown')}* — ${truncTitle}\n`;
      message += `   ├ ${pos.size.toFixed(2)} sh · Avg: ${(pos.avgPrice * 100).toFixed(1)}¢ · Now: ${(pos.curPrice * 100).toFixed(1)}¢\n`;
      message += `   ├ 💰 Invested: $${pos.totalBought.toFixed(2)} → Value: $${pos.currentValue.toFixed(2)}\n`;
      message += `   ├ ${pnlEmoji} Unrealized: ${pnlSign}$${pos.cashPnl.toFixed(2)} (${pnlSign}${pos.percentPnl.toFixed(1)}%)\n`;
      if (pos.realizedPnl !== 0) {
        const rSign = pos.realizedPnl >= 0 ? '+' : '';
        message += `   ├ 💵 Realized: ${rSign}$${pos.realizedPnl.toFixed(2)}\n`;
      }
      const redeemLine = pos.redeemable ? ' · ✅ Redeemable' : '';
      message += `   ├ 📅 Ends: ${endDate}${redeemLine}\n`;
      message += `   └ [👁 View](${viewLink}) · [📈 Buy](${buyLink}) · [📉 Sell](${sellLink})\n\n`;
    });

    const buttons: any[] = [];

    const navRow: any[] = [];
    if (currentPage > 1) navRow.push(Markup.button.callback('◀️ Prev', `portfolio_open_${currentPage - 1}`));
    navRow.push(Markup.button.callback(`${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) navRow.push(Markup.button.callback('Next ▶️', `portfolio_open_${currentPage + 1}`));
    if (navRow.length > 1) buttons.push(navRow);

    buttons.push([
      Markup.button.callback('🔄 Refresh', 'portfolio_open_1'),
      Markup.button.callback('« Portfolio', 'portfolio'),
    ]);
    buttons.push([Markup.button.callback('🏠 Main Menu', 'back_to_menu')]);

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Active positions page ${currentPage} shown to user: ${telegramId}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing active positions:', error);
    await sendPage(ctx,
      '❌ *Error Loading Positions*\n\nPlease try again.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back to Portfolio', 'portfolio')]]),
      }
    ).catch(() => {});
  }
}

/**
 * Shows open (pending) GTC orders with real-time data.
 */
export async function handleOpenOrders(ctx: Context, page: number = 1): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading open orders...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendPage(ctx, '❌ User not found. Use /start to create your wallet.');
      return;
    }

    const openOrders = await getOpenOrders(
      user.encryptedPrivateKey, user.encryptedApiKey,
      user.encryptedApiSecret, user.encryptedPassphrase
    );

    if (openOrders.length === 0) {
      await sendPage(ctx,
        '📋 *Open Orders*\n\n✅ No pending orders.\n\n_All your orders have been filled or cancelled._',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📊 Active Positions', 'portfolio_open_1')],
            [Markup.button.callback('« Portfolio', 'portfolio')],
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    const ITEMS_PER_PAGE = 4;
    const totalPages = Math.ceil(openOrders.length / ITEMS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const pageOrders = openOrders.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    const esc = (s: string) => s.replace(/[_*`[\]()]/g, '\\$&');

    // Summary: total pending value across all orders
    const totalPendingValue = openOrders.reduce((sum, o) => {
      const remaining = parseFloat(o.original_size || '0') - parseFloat(o.size_matched || '0');
      return sum + remaining * parseFloat(o.price || '0');
    }, 0);

    let message = `📋 *Open Orders* — ${openOrders.length} pending · page ${currentPage}/${totalPages}\n`;
    message += `💰 Total Pending Value: ~$${totalPendingValue.toFixed(2)}\n\n`;
    message += `_GTC limit orders on the book, fill automatically._\n\n`;

    pageOrders.forEach((order, i) => {
      const num = startIndex + i + 1;
      const side = order.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
      const price = formatOrderPrice(order.price);
      const sizeMatched = parseFloat(order.size_matched || '0');
      const sizeTotal   = parseFloat(order.original_size || '0');
      const remaining   = sizeTotal - sizeMatched;
      const pctFilled   = sizeTotal > 0 ? ((sizeMatched / sizeTotal) * 100).toFixed(0) : '0';
      const totalValue  = (sizeTotal * parseFloat(order.price || '0')).toFixed(2);
      const remainValue = (remaining * parseFloat(order.price || '0')).toFixed(2);
      const created     = formatTimestamp(order.created_at);
      const outcome     = esc(order.outcome || '—');
      const orderId     = order.id ? order.id.substring(0, 8) + '…' : '—';

      message += `*${num}.* ${side} @ ${price} · \`${orderId}\`\n`;
      message += `   ├ ${outcome}\n`;
      message += `   ├ 📦 ${sizeTotal.toFixed(2)} sh total · ${remaining.toFixed(2)} remaining (${pctFilled}% filled)\n`;
      message += `   ├ 💰 Total: $${totalValue} · Remaining: ~$${remainValue}\n`;
      message += `   └ 📅 ${created}\n\n`;
    });

    // Per-order cancel buttons
    const buttons: any[] = [];
    pageOrders.forEach((_order, i) => {
      const num = startIndex + i + 1;
      buttons.push([
        Markup.button.callback(
          `❌ Cancel Order #${num}`,
          `cancel_ord_confirm_${currentPage}_${i}`
        ),
      ]);
    });

    const navRow: any[] = [];
    if (currentPage > 1) navRow.push(Markup.button.callback('◀️', `portfolio_orders_${currentPage - 1}`));
    navRow.push(Markup.button.callback(`· ${currentPage}/${totalPages} ·`, 'noop'));
    if (currentPage < totalPages) navRow.push(Markup.button.callback('▶️', `portfolio_orders_${currentPage + 1}`));
    if (navRow.length > 1) buttons.push(navRow);

    buttons.push([
      Markup.button.callback('🔄 Refresh',       'portfolio_orders_1'),
      Markup.button.callback('❌ Cancel All',     'cancel_all_confirm'),
    ]);
    buttons.push([Markup.button.callback('« Portfolio', 'portfolio')]);
    buttons.push([Markup.button.callback('🏠 Main Menu', 'back_to_menu')]);

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Open orders page ${currentPage} shown to user: ${telegramId}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing open orders:', error);
    await sendPage(ctx, '❌ Error loading open orders. Please try again.', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('« Portfolio', 'portfolio')]]),
    }).catch(() => {});
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
      await sendPage(ctx, '❌ User not found. Use /start to create your wallet.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    const closedPositions = await getClosedPositions(user.polymarketProxyAddress || '');

    if (closedPositions.length === 0) {
      await sendPage(ctx,
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

    const esc = (s: string) => s.replace(/[_*`[\]()]/g, '\\$&');

    // Pagination
    const ITEMS_PER_PAGE = 3;
    const totalPages = Math.ceil(closedPositions.length / ITEMS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const pagePositions = closedPositions.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    // Summary header
    const totalRealizedPnl = closedPositions.reduce((s, p) => s + p.realizedPnl, 0);
    const totalInvested    = closedPositions.reduce((s, p) => s + p.totalBought, 0);
    const rePnlSign  = totalRealizedPnl >= 0 ? '+' : '';
    const rePnlEmoji = totalRealizedPnl >= 0 ? '🟢' : '🔴';

    let message = `📜 *Closed Positions* (${closedPositions.length} total · page ${currentPage}/${totalPages})\n`;
    message += `${rePnlEmoji} Total Realized P&L: ${rePnlSign}$${totalRealizedPnl.toFixed(2)} on $${totalInvested.toFixed(2)} invested\n\n`;

    pagePositions.forEach((pos: ClosedPosition, index) => {
      const number = startIndex + index + 1;
      const rawTitle = pos.title || (pos.conditionId ? pos.conditionId.substring(0, 20) + '...' : 'Unknown Market');
      const truncTitle = esc(rawTitle.length > 46 ? rawTitle.substring(0, 46) + '...' : rawTitle);
      const pnlSign  = pos.realizedPnl >= 0 ? '+' : '';
      const pnlEmoji = pos.realizedPnl >= 0 ? '🟢' : '🔴';
      const roi      = pos.totalBought > 0 ? (pos.realizedPnl / pos.totalBought) * 100 : 0;
      const roiSign  = roi >= 0 ? '+' : '';
      const closedAt = pos.timestamp
        ? new Date(pos.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'N/A';
      const endDate = pos.endDate
        ? new Date(pos.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'N/A';

      message += `*${number}) ${esc(pos.outcome || 'Unknown')}*\n`;
      message += `   ├ 📌 ${truncTitle}\n`;
      message += `   ├ 💰 Invested: $${pos.totalBought.toFixed(2)} @ avg ${(pos.avgPrice * 100).toFixed(1)}¢\n`;
      message += `   ├ ${pnlEmoji} Realized P&L: ${pnlSign}$${pos.realizedPnl.toFixed(2)} (ROI: ${roiSign}${roi.toFixed(1)}%)\n`;
      message += `   ├ 📅 Closed: ${closedAt}\n`;
      message += `   └ ⏰ Market End: ${endDate}\n\n`;
    });

    // Build buttons
    const buttons: any[] = [];

    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('◀️ Prev', `portfolio_closed_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`Page ${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ▶️', `portfolio_closed_${currentPage + 1}`));
    }
    buttons.push(navRow);

    buttons.push([Markup.button.callback('« Back to Portfolio', 'portfolio')]);
    buttons.push([Markup.button.callback('🏠 Main Menu', 'back_to_menu')]);

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Closed positions page ${currentPage} shown to user: ${telegramId}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing closed positions:', error);
    await sendPage(ctx,
      '❌ *Error Loading Trades*\n\n' +
      'We encountered an error while fetching your trade history.\n\n' +
      'This might be a temporary issue. Please try again.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Portfolio', 'portfolio')],
        ]),
      }
    ).catch(() => {});
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
      await sendPage(ctx, '❌ User not found. Use /start to create your wallet.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    const portfolioData = await getPortfolioData(
      user.encryptedPrivateKey,
      user.encryptedApiKey,
      user.encryptedApiSecret,
      user.encryptedPassphrase,
      user.polymarketProxyAddress || ''
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
      await sendPage(ctx,
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

    const esc = (s: string) => s.replace(/[_*`[\]()]/g, '\\$&');

    // Pagination
    const ITEMS_PER_PAGE = 4;
    const totalPages = Math.ceil(allTransactions.length / ITEMS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageTransactions = allTransactions.slice(startIndex, endIndex);

    let message = `📋 *All Transactions*\n\n`;
    message += `Found ${allTransactions.length} transaction${allTransactions.length !== 1 ? 's' : ''} · page ${currentPage}/${totalPages}\n\n`;

    pageTransactions.forEach((tx, index) => {
      const number = startIndex + index + 1;

      if (tx.type === 'order') {
        const order = tx.data as OpenOrder;
        const side       = order.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
        const price      = formatOrderPrice(order.price);
        const sizeTotal  = parseFloat(order.original_size || '0');
        const sizeMatched = parseFloat(order.size_matched || '0');
        const pctFilled  = sizeTotal > 0 ? ((sizeMatched / sizeTotal) * 100).toFixed(0) : '0';
        const value      = (sizeTotal * parseFloat(order.price || '0')).toFixed(2);
        const created    = formatTimestamp(order.created_at);
        const outcome    = esc(order.outcome || '—');

        message += `*${number}. 📋 OPEN ORDER*\n`;
        message += `   ├ ${side} · ${outcome}\n`;
        message += `   ├ ${sizeTotal.toFixed(2)} sh @ ${price} = $${value}\n`;
        message += `   ├ ${pctFilled}% filled (${sizeMatched.toFixed(2)} / ${sizeTotal.toFixed(2)} sh)\n`;
        message += `   └ 📅 ${created}\n\n`;
      } else {
        const trade      = tx.data as Trade;
        const side       = trade.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
        const price      = formatOrderPrice(trade.price);
        const size       = parseFloat(trade.size || '0');
        const value      = (size * parseFloat(trade.price || '0')).toFixed(2);
        const matchTime  = formatTimestamp(trade.match_time);
        const outcome    = esc(trade.outcome || '—');
        const txHash     = trade.transaction_hash
          ? `${trade.transaction_hash.substring(0, 10)}…${trade.transaction_hash.slice(-8)}`
          : '—';

        message += `*${number}. ✅ FILLED*\n`;
        message += `   ├ ${side} · ${outcome}\n`;
        message += `   ├ ${size.toFixed(2)} sh @ ${price} = $${value}\n`;
        message += `   ├ 📅 ${matchTime}\n`;
        message += `   └ 🔗 Tx: \`${txHash}\`\n\n`;
      }
    });

    // Build buttons
    const buttons: any[] = [];

    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('◀️ Prev', `portfolio_all_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`Page ${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ▶️', `portfolio_all_${currentPage + 1}`));
    }
    buttons.push(navRow);

    buttons.push([Markup.button.callback('« Back to Portfolio', 'portfolio')]);
    buttons.push([Markup.button.callback('🏠 Main Menu', 'back_to_menu')]);

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`All transactions page ${currentPage} shown to user: ${telegramId}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing all transactions:', error);
    await sendPage(ctx,
      '❌ *Error Loading Transactions*\n\n' +
      'We encountered an error while fetching your transactions.\n\n' +
      'This might be a temporary issue. Please try again.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Portfolio', 'portfolio')],
        ]),
      }
    ).catch(() => {});
  }
}

/**
 * Shows withdraw/deposit page
 */
export async function handleWithdraw(ctx: Context): Promise<void> {
  try {
    const { handleDepositMenu } = await import('./deposit');
    await handleDepositMenu(ctx);
  } catch (error) {
    logger.error('Error showing deposit page:', error);
    await ctx.reply('❌ An error occurred while loading deposit page.');
  }
}

// ─── Order Cancellation ────────────────────────────────────────────────────

/**
 * Shows confirmation dialog before cancelling a single order.
 * callback: cancel_ord_confirm_{page}_{idx}
 */
export async function handleCancelOrderConfirm(ctx: Context, page: number, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply('❌ User not found.'); return; }

    // Re-fetch live orders to find the exact one
    const openOrders = await getOpenOrders(
      user.encryptedPrivateKey, user.encryptedApiKey,
      user.encryptedApiSecret, user.encryptedPassphrase
    );

    const ITEMS_PER_PAGE = 4;
    const absoluteIdx = (page - 1) * ITEMS_PER_PAGE + idx;
    const order = openOrders[absoluteIdx];

    if (!order) {
      await sendPage(ctx,
        '⚠️ Order not found — it may have already been filled or cancelled.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Open Orders', 'portfolio_orders_1')]]),
        }
      );
      return;
    }

    const side = order.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
    const price = formatOrderPrice(order.price);
    const size = parseFloat(order.original_size || '0').toFixed(2);
    const esc = (s: string) => s.replace(/[_*`[\]()]/g, '\\$&');

    await sendPage(ctx,
      `⚠️ *Confirm Cancel Order*\n\n` +
      `${side} ${size} shares @ ${price}\n` +
      `Market: ${esc(order.outcome || order.market || '—')}\n\n` +
      `This order will be removed from the book immediately.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Yes, Cancel It', `cancel_ord_do_${page}_${idx}`),
            Markup.button.callback('« Keep Order',       'portfolio_orders_1'),
          ],
        ]),
      }
    );
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing cancel order confirmation:', error);
    await ctx.reply('❌ Error loading order. Please try again.');
  }
}

/**
 * Executes cancellation of a single order.
 * callback: cancel_ord_do_{page}_{idx}
 */
export async function handleCancelOrderExecute(ctx: Context, page: number, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery('Cancelling order...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply('❌ User not found.'); return; }

    // Re-fetch live orders to find the exact order ID
    const openOrders = await getOpenOrders(
      user.encryptedPrivateKey, user.encryptedApiKey,
      user.encryptedApiSecret, user.encryptedPassphrase
    );

    const ITEMS_PER_PAGE = 4;
    const absoluteIdx = (page - 1) * ITEMS_PER_PAGE + idx;
    const order = openOrders[absoluteIdx];

    if (!order) {
      await sendPage(ctx,
        '✅ Order already gone — it was filled or cancelled.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Open Orders', 'portfolio_orders_1')]]),
        }
      );
      return;
    }

    const result = await cancelOrderById(
      user.encryptedPrivateKey, user.encryptedApiKey,
      user.encryptedApiSecret, user.encryptedPassphrase,
      order.id
    );

    await invalidatePortfolioCache(user.encryptedPrivateKey);

    if (result.success) {
      await sendPage(ctx,
        `✅ *Order Cancelled*\n\n` +
        `Your ${order.side} order has been removed from the book.\n\n` +
        `_Any partially filled amount remains as shares in your position._`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📋 Open Orders', 'portfolio_orders_1')],
            [Markup.button.callback('📊 Active Positions', 'portfolio_open_1')],
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        }
      );
      logger.info(`[walletPage] Cancelled order ${order.id.substring(0, 16)}... for user ${telegramId}`);
    } else {
      await sendPage(ctx,
        `❌ *Cancel Failed*\n\nReason: ${result.errorReason || 'Unknown error'}\n\n` +
        `_The order may have already filled._`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Open Orders', 'portfolio_orders_1')]]),
        }
      );
    }
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error cancelling order:', error);
    await ctx.reply('❌ Error cancelling order. Please try again.');
  }
}

/**
 * Shows confirmation dialog before cancelling ALL orders.
 * callback: cancel_all_confirm
 */
export async function handleCancelAllConfirm(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply('❌ User not found.'); return; }

    // Count current open orders for the confirmation message
    const openOrders = await getOpenOrders(
      user.encryptedPrivateKey, user.encryptedApiKey,
      user.encryptedApiSecret, user.encryptedPassphrase
    );

    if (openOrders.length === 0) {
      await sendPage(ctx,
        '✅ No open orders to cancel.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Open Orders', 'portfolio_orders_1')]]),
        }
      );
      return;
    }

    await sendPage(ctx,
      `⚠️ *Cancel All Orders*\n\n` +
      `You have *${openOrders.length} open order${openOrders.length > 1 ? 's' : ''}* on the book.\n\n` +
      `Cancelling all will remove them immediately. Any partial fills are kept.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`✅ Cancel All ${openOrders.length} Orders`, 'cancel_all_do'),
            Markup.button.callback('« Keep Orders', 'portfolio_orders_1'),
          ],
        ]),
      }
    );
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing cancel all confirmation:', error);
    await ctx.reply('❌ Error loading orders. Please try again.');
  }
}

/**
 * Executes cancellation of ALL open orders.
 * callback: cancel_all_do
 */
export async function handleCancelAllExecute(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Cancelling all orders...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply('❌ User not found.'); return; }

    const result = await cancelAllOrders(
      user.encryptedPrivateKey, user.encryptedApiKey,
      user.encryptedApiSecret, user.encryptedPassphrase
    );

    await invalidatePortfolioCache(user.encryptedPrivateKey);

    if (result.failed === -1) {
      await sendPage(ctx,
        '❌ *Cancel All Failed*\n\nCould not reach the exchange. Please try again.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Open Orders', 'portfolio_orders_1')]]),
        }
      );
      return;
    }

    const summary = result.cancelled > 0
      ? `✅ *${result.cancelled} order${result.cancelled > 1 ? 's' : ''} cancelled successfully.*`
      : `✅ No orders were cancelled.`;
    const failLine = result.failed > 0 ? `\n⚠️ ${result.failed} could not be cancelled (may have filled).` : '';

    await sendPage(ctx,
      `${summary}${failLine}\n\n_Any partial fills remain as positions._`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Active Positions', 'portfolio_open_1')],
          [Markup.button.callback('« Portfolio', 'portfolio')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      }
    );

    logger.info(`[walletPage] Cancel all for user ${telegramId}: ${result.cancelled} cancelled, ${result.failed} failed`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error cancelling all orders:', error);
    await ctx.reply('❌ Error cancelling orders. Please try again.');
  }
}
