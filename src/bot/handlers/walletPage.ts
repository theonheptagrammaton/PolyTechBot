import path from 'path';
import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { logger } from '../../utils/logger';
import { isBenignTelegramError, sendPage, sendImageBufferPage, fetchProfilePhoto } from '../../utils/telegram';
import { generateAllTimePnlImage, generatePortfolioPnlImage } from '../../services/pnlImage';

const IMG_WALLET    = path.join(__dirname, '../img/wallet.jpg');
const IMG_PORTFOLIO = path.join(__dirname, '../img/portfolio.jpg');
const IMG_POSITIONS = path.join(__dirname, '../img/positions.jpeg');
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
import { autoRedeemPositions } from '../../services/redeem';

/**
 * Shows detailed wallet page with deposit addresses
 */
export async function handleWalletPage(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

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
    const eWallet = ce(EMOJI.walletPurse,    '👜');
    const eFire   = ce('4969918262650340505', '🔥');
    const ePoly   = ce('5837001288457392898', '🟣');
    const eEth    = ce(EMOJI.ethDeposit,      '🔹');
    const eBase   = ce(EMOJI.baseDeposit,     '🟦');
    const eSol    = ce(EMOJI.solanaDeposit,   '🟣');
    const ePm     = ce(EMOJI.polymarket,      '💙');
    const eUsdc   = ce(EMOJI.usdc,            '💲');

    let message = `${eWallet} <b>WALLET</b>\n\n`;
    message += `💰 <b>Deposit Addresses</b>\n\n`;
    message += `${eFire} <b>Supported Tokens: (POL, ETH, BNB, ARB, HYPE, USDT, USDC, USDC.e)</b>\n\n`;

    if (user.depositAddressEvm) {
      message += `${ePoly}<b>Polygon:</b>\n`;
      message += `<code>${esc(user.depositAddressEvm)}</code>\n\n`;

      message += `${eEth}🔸${eBase}<b>ETH/BSC/Base/Arbitrum/Hyper Liquid:</b>\n`;
      message += `<code>${esc(user.depositAddressEvm)}</code>\n\n`;
    } else {
      message += `⚠️ <b>Deposit address not available — please contact support</b>\n\n`;
    }

    if (user.depositAddressSvm) {
      message += `${eSol} <b>Solana:</b>\n`;
      message += `<code>${esc(user.depositAddressSvm)}</code>\n\n`;
    }

    message += `${ePm}<b>Polymarket Profile (Don't Deposit here):</b>\n`;
    if (user.polymarketProxyAddress) {
      message += `<code>${esc(user.polymarketProxyAddress)}</code>\n\n`;
    } else {
      message += `⚠️ <i>Setup incomplete — contact support</i>\n\n`;
    }

    message += `${eUsdc} <b>Balance:</b> $${esc(balance)}\n`;
    message += `💡 <b>Min deposit: $10 USDC</b>`;

    // Buttons: Profile · Portfolio · Refresh / Back · Withdraw / Main Menu
    const profileBtn = user.polymarketProxyAddress
      ? Markup.button.url('👤 Profile', `https://polymarket.com/profile/${user.polymarketProxyAddress}`)
      : null;

    const buttons: any[] = [
      [
        ...(profileBtn ? [profileBtn] : []),
        Markup.button.callback('📊 Portfolio', 'portfolio'),
        Markup.button.callback('🔄 Refresh',   'wallet_page'),
      ],
      [
        Markup.button.callback('💸 Withdraw',  'withdraw_menu'),
        Markup.button.callback('💰 Cashback',  'cashback_page'),
      ],
      [
        Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
      ],
    ];

    await sendPage(ctx, message, {
      parse_mode: 'HTML',
      image_path: IMG_WALLET,
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
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

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

    // Auto-claim any resolved/redeemable positions (fire-and-forget)
    const redeemable = activePositions.filter(p => p.redeemable);
    if (redeemable.length > 0 && user.polymarketProxyAddress) {
      autoRedeemPositions(
        user.encryptedPrivateKey,
        user.polymarketProxyAddress,
        redeemable,
        async (msg) => {
          const sent = await ctx.reply(msg, { parse_mode: 'Markdown' }).catch(() => null);
          if (sent) setTimeout(() => ctx.telegram.deleteMessage(sent.chat.id, sent.message_id).catch(() => {}), 5000);
        },
      ).then(claimed => {
        if (claimed > 0) invalidatePortfolioCache(user.polymarketProxyAddress ?? '');
      }).catch((err) => logger.warn('[redeem] Auto-redeem background error:', err));
    }

    const totalInvested     = activePositions.reduce((s, p) => s + (p.initialValue), 0);
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
      image_path: IMG_PORTFOLIO,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 Active Positions', 'portfolio_open_1')],
        [Markup.button.callback('📋 Open Orders',      'portfolio_orders_1')],
        [Markup.button.callback('📜 Closed Positions', 'portfolio_closed_1')],
        [Markup.button.callback('📝 Trade History',    'portfolio_all_1')],
        [Markup.button.callback('📊 P&L', 'portfolio_pnl')],
        [Markup.button.callback('🔄 Refresh', 'portfolio'), Markup.button.callback('« Back to Wallet', 'wallet_page')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
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
    if (ctx.callbackQuery) await ctx.answerCbQuery('Loading positions...').catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendPage(ctx, '❌ User not found. Use /start to create your wallet.');
      return;
    }

    // Fetch positions and update cache for Buy/Sell/View actions
    // Always force-refresh when triggered by callback (Refresh button or navigation)
    const { positionListCache } = await import('./positionTrade');
    const positions = await getActivePositions(user.polymarketProxyAddress || '', !!ctx.callbackQuery);
    positionListCache.set(telegramId, positions);

    // Auto-claim any resolved/redeemable positions (fire-and-forget, notifies user)
    const redeemable = positions.filter(p => p.redeemable);
    if (redeemable.length > 0 && user.polymarketProxyAddress) {
      autoRedeemPositions(
        user.encryptedPrivateKey,
        user.polymarketProxyAddress,
        redeemable,
        async (msg) => {
          const sent = await ctx.reply(msg, { parse_mode: 'Markdown' }).catch(() => null);
          if (sent) setTimeout(() => ctx.telegram.deleteMessage(sent.chat.id, sent.message_id).catch(() => {}), 5000);
        },
      ).then(claimed => {
        if (claimed > 0) {
          // Invalidate cache so refreshed positions page shows updated balances
          invalidatePortfolioCache(user.polymarketProxyAddress ?? '');
        }
      }).catch((err) => logger.warn('[redeem] Auto-redeem background error:', err));
    }

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
          image_path: IMG_POSITIONS,
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

    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const botUsername = config.telegram.botUsername;

    // Summary header
    const totalValue = positions.reduce((s, p) => s + p.currentValue, 0);
    const totalPnl   = positions.reduce((s, p) => s + p.cashPnl, 0);
    const summarySign  = totalPnl >= 0 ? '+' : '';
    const summaryEmoji = totalPnl >= 0 ? '🟢' : '🔴';

    let message = `📊 <b>Active Positions</b> (${positions.length} total · page ${currentPage}/${totalPages})\n`;
    message += `${summaryEmoji} Total Value: $${totalValue.toFixed(2)} · P&amp;L: ${summarySign}$${totalPnl.toFixed(2)}\n\n`;

    // 900-char budget for position blocks (leaves 124-char header already in message)
    const MSG_LIMIT = 980;
    for (let i = 0; i < pagePositions.length; i++) {
      const pos = pagePositions[i];
      const idx = startIndex + i;
      const num = idx + 1;
      const rawTitle = pos.title || 'Unknown Market';
      const truncTitle = escHtml(rawTitle.length > 46 ? rawTitle.substring(0, 46) + '…' : rawTitle);
      const pnlSign  = pos.cashPnl >= 0 ? '+' : '';
      const pnlEmoji = pos.cashPnl >= 0 ? '🟢' : '🔴';
      const endDate = pos.endDate
        ? new Date(pos.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'N/A';

      const viewLink = `https://t.me/${botUsername}?start=pv_${idx}`;
      const buyLink  = `https://t.me/${botUsername}?start=pb_${idx}`;
      const sellLink = `https://t.me/${botUsername}?start=ps_${idx}`;
      const pnlLink  = `https://t.me/${botUsername}?start=pp_${idx}`;

      let entry = '';
      entry += `<b>${num}) ${escHtml(pos.outcome || 'Unknown')}</b> — ${truncTitle}\n`;
      entry += `   ├ ${pos.size.toFixed(2)} sh · Avg: ${(pos.avgPrice * 100).toFixed(1)}¢ · Now: ${(pos.curPrice * 100).toFixed(1)}¢\n`;
      entry += `   ├ 💰 Invested: $${(pos.initialValue).toFixed(2)} → Value: $${pos.currentValue.toFixed(2)}\n`;
      entry += `   ├ ${pnlEmoji} Unrealized: ${pnlSign}$${pos.cashPnl.toFixed(2)} (${pnlSign}${pos.percentPnl.toFixed(1)}%)\n`;
      if (pos.realizedPnl !== 0) {
        const rSign = pos.realizedPnl >= 0 ? '+' : '';
        entry += `   ├ 💵 Realized: ${rSign}$${pos.realizedPnl.toFixed(2)}\n`;
      }
      const redeemLine = pos.redeemable ? ' · ✅ Redeemable' : '';
      entry += `   ├ 📅 Ends: ${endDate}${redeemLine}\n`;
      entry += `   └ <a href="${viewLink}">👁 View</a> · <a href="${buyLink}">📈 Buy</a> · <a href="${sellLink}">📉 Sell</a> · <a href="${pnlLink}">📊 P&amp;L</a>\n\n`;

      // Stop adding positions if we'd exceed the safe caption limit
      if (message.length + entry.length > MSG_LIMIT) break;
      message += entry;
    }

    const buttons: any[] = [];

    const navRow: any[] = [];
    if (currentPage > 1) navRow.push(Markup.button.callback('◀️ Prev', `portfolio_open_${currentPage - 1}`));
    navRow.push(Markup.button.callback(`${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) navRow.push(Markup.button.callback('Next ▶️', `portfolio_open_${currentPage + 1}`));
    if (navRow.length > 1) buttons.push(navRow);

    buttons.push([
      Markup.button.callback('📊 Portfolio P&L', 'portfolio_pnl'),
    ]);
    buttons.push([
      Markup.button.callback('🔄 Refresh', 'portfolio_open_1'),
      Markup.button.callback('« Portfolio', 'portfolio'),
    ]);
    buttons.push([
      Markup.button.callback('❌ Close All Positions', 'close_all_pos_confirm'),
      Markup.button.callback('🛑 Stop All Orders',    'cancel_all_confirm'),
    ]);
    buttons.push([Markup.button.callback('🏠 Main Menu', 'back_to_menu')]);

    await sendPage(ctx, message, {
      parse_mode: 'HTML',
      image_path: IMG_POSITIONS,
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
    if (ctx.callbackQuery) await ctx.answerCbQuery('Loading open orders...').catch(() => {});

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

    await invalidatePortfolioCache(user.polymarketProxyAddress ?? '');

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

    await invalidatePortfolioCache(user.polymarketProxyAddress ?? '');

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

/**
 * Confirmation dialog before closing all positions.
 * callback: close_all_pos_confirm
 */
export async function handleCloseAllConfirm(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply('❌ User not found.'); return; }

    const positions = await getActivePositions(user.polymarketProxyAddress || '');

    if (positions.length === 0) {
      await sendPage(ctx,
        '✅ No active positions to close.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Active Positions', 'portfolio_open_1')]]),
        }
      );
      return;
    }

    const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);

    await sendPage(ctx,
      `⚠️ *Close All Positions*\n\n` +
      `You have *${positions.length} active position${positions.length > 1 ? 's' : ''}* worth ~*$${totalValue.toFixed(2)}*.\n\n` +
      `This will sell ALL positions immediately at market price.\n` +
      `Illiquid positions may fail individually.\n\n` +
      `⚠️ This action cannot be undone.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`✅ Close All (${positions.length})`, 'close_all_pos_do'),
            Markup.button.callback('« Keep Positions', 'portfolio_open_1'),
          ],
        ]),
      }
    );
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing close all confirmation:', error);
    await ctx.reply('❌ Error loading positions. Please try again.');
  }
}

/**
 * Executes bulk close of all active positions.
 * callback: close_all_pos_do
 */
export async function handleCloseAllExecute(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Closing all positions...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply('❌ User not found.'); return; }

    await sendPage(ctx,
      `${ce(EMOJI.loading, '⏳')} <b>Closing all positions...</b>\n\n<i>This may take a moment.</i>`,
      { parse_mode: 'HTML' }
    );

    const { executeCloseAllPositions } = await import('./positionTrade');
    const result = await executeCloseAllPositions(user, user.slippageTolerance ?? 1.0);

    await invalidatePortfolioCache(user.polymarketProxyAddress ?? '');

    const summary = result.closed > 0
      ? `✅ <b>${result.closed} position${result.closed > 1 ? 's' : ''} closed successfully.</b>`
      : `ℹ️ No positions were closed.`;
    const failLine = result.failed > 0
      ? `\n⚠️ ${result.failed} could not be closed (illiquid or too small):\n` +
        result.errors.slice(0, 3).map(e => `• ${esc(e)}`).join('\n')
      : '';

    await sendPage(ctx,
      `${summary}${failLine}\n\n<i>Check your positions for the updated state.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 My Positions', 'portfolio_open_1')],
          [Markup.button.callback('« Portfolio', 'portfolio')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      }
    );

    logger.info(`[walletPage] closeAll user=${telegramId}: closed=${result.closed} failed=${result.failed}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error closing all positions:', error);
    await ctx.reply('❌ Error closing positions. Please try again.');
  }
}

/**
 * /pnl + pnl_alltime action — All-time P&L summary (unrealized + realized) with image
 */
export async function handlePnl(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('❌ User not found. Use /start to create your wallet.');
      return;
    }

    // Only show loading message for /pnl command, not for callback actions (Refresh)
    let loadingMsg: any = null;
    if (!ctx.callbackQuery) {
      loadingMsg = await ctx.reply('📊 Fetching P&L...');
    }

    const forceRefresh = !!ctx.callbackQuery;
    const [activePositions, closedPositions, balance, profilePhotoBuffer] = await Promise.all([
      getActivePositions(user.polymarketProxyAddress || '', forceRefresh).catch(() => [] as ActivePosition[]),
      getClosedPositions(user.polymarketProxyAddress || '', forceRefresh).catch(() => [] as ClosedPosition[]),
      getBalance(
        user.encryptedPrivateKey, user.encryptedApiKey,
        user.encryptedApiSecret, user.encryptedPassphrase
      ).catch(() => '0.00'),
      fetchProfilePhoto(ctx),
    ]);

    if (loadingMsg) {
      try { await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id); } catch { /* non-critical */ }
    }

    // Update position cache so subsequent position actions work
    if (activePositions.length > 0) {
      const { positionListCache } = await import('./positionTrade');
      positionListCache.set(telegramId, activePositions);
    }

    const totalUnrealized = activePositions.reduce((s, p) => s + p.cashPnl, 0);
    const totalRealized   = closedPositions.reduce((s, p) => s + p.realizedPnl, 0);
    const totalPnl        = totalUnrealized + totalRealized;
    // Use initialValue from API — the authoritative cost basis for active positions
    const activeInvested  = activePositions.reduce((s, p) => s + (p.initialValue), 0);
    const closedInvested  = closedPositions.reduce((s, p) => s + p.totalBought, 0);
    const totalInvested   = activeInvested + closedInvested;
    const percentPnl      = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');

    const pnlKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Refresh', 'pnl_alltime'),
        Markup.button.callback('📤 Share', 'pnl_share_alltime'),
      ],
      [Markup.button.callback('📊 Full Portfolio', 'portfolio')],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ]);

    // Build rich HTML caption
    const pnlDir = totalPnl >= 0 ? ce(EMOJI.pnlUp, '📈') : ce(EMOJI.pnlDown, '📉');
    const pnlSign = totalPnl >= 0 ? '+' : '';
    const pctSign = percentPnl >= 0 ? '+' : '';

    let caption = `${ce(EMOJI.pnlChart, '📊')} <b>All-Time P&amp;L</b>\n\n`;
    caption += `${ce(EMOJI.diamond, '💎')} <b>Total P&amp;L:</b>  ${pnlDir} <b>${pnlSign}$${totalPnl.toFixed(2)}</b>\n`;
    caption += `${ce(EMOJI.rocket, '🚀')} <b>ROI:</b>  ${pctSign}${percentPnl.toFixed(1)}%\n\n`;
    caption += `${ce(EMOJI.bag, '💰')} <b>Invested:</b>  $${totalInvested.toFixed(2)}\n`;
    caption += `${ce(EMOJI.trophy, '🏆')} <b>Portfolio Value:</b>  $${(totalInvested + totalPnl).toFixed(2)}\n`;
    caption += `${ce(EMOJI.usdc, '💲')} <b>Balance:</b>  $${balance}\n`;
    caption += `${ce(EMOJI.briefcase, '💼')} <b>Positions:</b>  ${activePositions.length} active`;

    // Try image generation
    try {
      const imageBuffer = await generateAllTimePnlImage({
        totalPnl,
        percentPnl,
        totalInvested,
        balance,
        positionCount: activePositions.length,
        username: ctx.from?.username,
        displayName,
        profilePhotoBuffer,
      });

      if (imageBuffer) {
        await sendImageBufferPage(ctx, imageBuffer, caption, {
          parse_mode: 'HTML',
          ...pnlKeyboard,
        });
        return;
      }
    } catch (imgErr) {
      logger.warn('[pnlImage] All-time PNL image generation failed, using text fallback:', imgErr);
    }

    // Text fallback (same rich caption, no image)
    await sendPage(ctx, caption, {
      parse_mode: 'HTML',
      ...pnlKeyboard,
    });
  } catch (error) {
    logger.error('Error in handlePnl:', error);
    await ctx.reply('❌ Failed to fetch P&L. Please try again.').catch(() => {});
  }
}

/**
 * portfolio_pnl action — Portfolio PNL (unrealized only) with image
 */
export async function handlePortfolioPnl(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('❌ User not found. Use /start to create your wallet.');
      return;
    }

    const [activePositions, balance, profilePhotoBuffer] = await Promise.all([
      getActivePositions(user.polymarketProxyAddress || '', true).catch(() => [] as ActivePosition[]),
      getBalance(
        user.encryptedPrivateKey, user.encryptedApiKey,
        user.encryptedApiSecret, user.encryptedPassphrase
      ).catch(() => '0.00'),
      fetchProfilePhoto(ctx),
    ]);

    // Update position cache so subsequent position actions work
    if (activePositions.length > 0) {
      const { positionListCache } = await import('./positionTrade');
      positionListCache.set(telegramId, activePositions);
    }

    const unrealizedPnl = activePositions.reduce((s, p) => s + p.cashPnl, 0);
    // Use initialValue from API — the authoritative cost basis for active positions
    const totalInvested = activePositions.reduce((s, p) => s + (p.initialValue), 0);
    const percentPnl    = totalInvested > 0 ? (unrealizedPnl / totalInvested) * 100 : 0;

    const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');

    const pnlKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Refresh', 'portfolio_pnl'),
        Markup.button.callback('📤 Share', 'pnl_share_portfolio'),
      ],
      [Markup.button.callback('« Portfolio', 'portfolio')],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ]);

    // Build rich HTML caption
    const pnlDir = unrealizedPnl >= 0 ? ce(EMOJI.pnlUp, '📈') : ce(EMOJI.pnlDown, '📉');
    const pnlSign = unrealizedPnl >= 0 ? '+' : '';
    const pctSign = percentPnl >= 0 ? '+' : '';

    let caption = `${ce(EMOJI.pnlChart, '📊')} <b>Portfolio P&amp;L</b>\n\n`;
    caption += `${ce(EMOJI.diamond, '💎')} <b>Unrealized P&amp;L:</b>  ${pnlDir} <b>${pnlSign}$${unrealizedPnl.toFixed(2)}</b>\n`;
    caption += `${ce(EMOJI.rocket, '🚀')} <b>ROI:</b>  ${pctSign}${percentPnl.toFixed(1)}%\n\n`;
    caption += `${ce(EMOJI.bag, '💰')} <b>Invested:</b>  $${totalInvested.toFixed(2)}\n`;
    caption += `${ce(EMOJI.trophy, '🏆')} <b>Portfolio Value:</b>  $${(totalInvested + unrealizedPnl).toFixed(2)}\n`;
    caption += `${ce(EMOJI.usdc, '💲')} <b>Balance:</b>  $${balance}\n`;
    caption += `${ce(EMOJI.briefcase, '💼')} <b>Positions:</b>  ${activePositions.length} active`;

    // Try image generation
    try {
      const imageBuffer = await generatePortfolioPnlImage({
        unrealizedPnl,
        percentPnl,
        totalInvested,
        balance,
        positionCount: activePositions.length,
        username: ctx.from?.username,
        displayName,
        profilePhotoBuffer,
      });

      if (imageBuffer) {
        await sendImageBufferPage(ctx, imageBuffer, caption, {
          parse_mode: 'HTML',
          ...pnlKeyboard,
        });
        return;
      }
    } catch (imgErr) {
      logger.warn('[pnlImage] Portfolio PNL image generation failed, using text fallback:', imgErr);
    }

    // Text fallback (same rich caption, no image)
    await sendPage(ctx, caption, {
      parse_mode: 'HTML',
      ...pnlKeyboard,
    });
  } catch (error) {
    logger.error('Error in handlePortfolioPnl:', error);
    await ctx.reply('❌ Failed to fetch P&L. Please try again.').catch(() => {});
  }
}

/**
 * pnl_share_* actions — Re-send PNL image without keyboard (forwardable)
 */
export async function handlePnlShare(ctx: Context, type: 'alltime' | 'portfolio'): Promise<void> {
  try {
    await ctx.answerCbQuery('Generating share image...').catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) return;

    const [activePositions, closedPositions, balance, profilePhotoBuffer] = await Promise.all([
      getActivePositions(user.polymarketProxyAddress || '').catch(() => [] as ActivePosition[]),
      getClosedPositions(user.polymarketProxyAddress || '').catch(() => [] as ClosedPosition[]),
      getBalance(
        user.encryptedPrivateKey, user.encryptedApiKey,
        user.encryptedApiSecret, user.encryptedPassphrase
      ).catch(() => '0.00'),
      fetchProfilePhoto(ctx),
    ]);

    const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');
    let imageBuffer: Buffer | null = null;

    if (type === 'alltime') {
      const totalUnrealized = activePositions.reduce((s, p) => s + p.cashPnl, 0);
      const totalRealized   = closedPositions.reduce((s, p) => s + p.realizedPnl, 0);
      const totalPnl        = totalUnrealized + totalRealized;
      const activeInvested  = activePositions.reduce((s, p) => s + (p.initialValue), 0);
      const closedInvested  = closedPositions.reduce((s, p) => s + p.totalBought, 0);
      const totalInvested   = activeInvested + closedInvested;
      const percentPnl      = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

      imageBuffer = await generateAllTimePnlImage({
        totalPnl, percentPnl, totalInvested, balance,
        positionCount: activePositions.length,
        username: ctx.from?.username,
        displayName,
        profilePhotoBuffer,
      });
    } else {
      const unrealizedPnl = activePositions.reduce((s, p) => s + p.cashPnl, 0);
      const totalInvested = activePositions.reduce((s, p) => s + (p.initialValue), 0);
      const percentPnl    = totalInvested > 0 ? (unrealizedPnl / totalInvested) * 100 : 0;

      imageBuffer = await generatePortfolioPnlImage({
        unrealizedPnl, percentPnl, totalInvested, balance,
        positionCount: activePositions.length,
        username: ctx.from?.username,
        displayName,
        profilePhotoBuffer,
      });
    }

    if (imageBuffer) {
      const shareCaption = `${ce(EMOJI.pnlChart, '📊')} My P&amp;L — <b>Polytech Sniper Bot</b>`;
      await ctx.replyWithPhoto(
        { source: imageBuffer },
        { caption: shareCaption, parse_mode: 'HTML' },
      );
    } else {
      await ctx.answerCbQuery('No PNL templates available yet.', { show_alert: true });
    }
  } catch (error) {
    logger.error('Error in handlePnlShare:', error);
    await ctx.reply('❌ Failed to generate share image.');
  }
}
