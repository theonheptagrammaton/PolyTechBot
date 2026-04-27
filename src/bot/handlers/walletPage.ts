import path from 'path';
import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { logger } from '../../utils/logger';
import { isBenignTelegramError, sendPage, sendImageBufferPage, fetchProfilePhoto, notifyAdmins } from '../../utils/telegram';
import { generateAllTimePnlImage, generatePortfolioPnlImage } from '../../services/pnlImage';
import { prisma } from '../../database/prisma';

const IMG_WALLET      = path.join(__dirname, '../img/wallet.PNG');
const IMG_PORTFOLIO   = path.join(__dirname, '../img/portfolio.PNG');
const IMG_POSITIONS   = path.join(__dirname, '../img/positions.jpeg');
const IMG_LIMITORDERS = path.join(__dirname, '../img/limitorders.PNG');
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
import { getClaimedConditionIds } from '../../services/redeem';
import { t, Locale } from '../../i18n';

function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

/**
 * Shows detailed wallet page with deposit addresses
 */
export async function handleWalletPage(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'common.cannotIdentify'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      const lang: Locale = 'en';
      await sendPage(ctx,
        t(lang, 'wallet.noWallet'),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'btn.back'), 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    const lang = getLang(user);

    // Fetch real balance
    let balance = '0.00';
    try {
      balance = await getBalance(
        user.encryptedPrivateKey,
        user.encryptedApiKey,
        user.encryptedApiSecret,
        user.encryptedPassphrase,
        user.predexonUserId ?? undefined
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

    let message = `${eWallet} <b>${t(lang, 'WALLET')}</b>\n\n`;
    message += `💰 <b>${t(lang, 'Deposit Addresses')}</b>\n\n`;
    message += `${eFire} <b>${t(lang, 'Supported Tokens: (POL, ETH, BNB, ARB, HYPE, USDT, USDC, USDC.e)')}</b>\n\n`;

    if (user.depositAddressEvm) {
      message += `${ePoly}<b>${t(lang, 'Polygon')}:</b>\n`;
      message += `<code>${esc(user.depositAddressEvm)}</code>\n\n`;

      message += `${eEth}🔸${eBase}<b>${t(lang, 'ETH/BSC/Base/Arbitrum/Hyper Liquid')}:</b>\n`;
      message += `<code>${esc(user.depositAddressEvm)}</code>\n\n`;
    } else {
      message += `⚠️ <b>${t(lang, 'Deposit address not available — please contact support')}</b>\n\n`;
    }

    if (user.depositAddressSvm) {
      message += `${eSol} <b>${t(lang, 'Solana')}:</b>\n`;
      message += `<code>${esc(user.depositAddressSvm)}</code>\n\n`;
    }

    message += `${ePm}<b>${t(lang, 'Polymarket Profile (Don\'t Deposit here)')}:</b>\n`;
    if (user.polymarketProxyAddress) {
      message += `<code>${esc(user.polymarketProxyAddress)}</code>\n\n`;
    } else {
      message += `⚠️ <i>${t(lang, 'Setup incomplete — contact support')}</i>\n\n`;
    }

    message += `${eUsdc} <b>${t(lang, 'Balance')}:</b> $${esc(balance)}\n`;
    message += `💡 <b>${t(lang, 'Min deposit: $10 USDC')}</b>\n\n`;
    message += `⚠️ <i>Your balance is currently in USDC.e (Bridged USDC). USDC.e cannot be deposited directly to centralized exchanges (Binance, Coinbase, etc.). You must bridge/swap to native USDC first.</i>`;

    // Buttons: Profile · Portfolio · Refresh / Back · Withdraw / Main Menu
    const profileBtn = user.polymarketProxyAddress
      ? Markup.button.url(`👤 ${t(lang, 'Profile')}`, `https://polymarket.com/profile/${user.polymarketProxyAddress}`)
      : null;

    const buttons: any[] = [
      [
        ...(profileBtn ? [profileBtn] : []),
        Markup.button.callback(t(lang, 'btn.portfolio'), 'portfolio'),
        Markup.button.callback(t(lang, 'btn.refresh'), 'wallet_page'),
      ],
      [
        Markup.button.callback(t(lang, 'btn.withdraw'), 'withdraw_menu'),
        Markup.button.callback(t(lang, 'menu.cashback'), 'cashback_page'),
      ],
      [
        Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu'),
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
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(t(lang, 'wallet.errorLoading'));
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
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await sendPage(ctx, t(lang, 'common.userNotFound'));
      return;
    }

    const lang = getLang(user);

    // Force-refresh when navigated via callback so portfolio and active positions stay in sync
    const forceRefresh = !!ctx.callbackQuery;
    const [activePositions, closedPositions, balance] = await Promise.all([
      getActivePositions(user.polymarketProxyAddress || '', forceRefresh).catch(() => [] as ActivePosition[]),
      getClosedPositions(user.polymarketProxyAddress || '', forceRefresh).catch(() => [] as ClosedPosition[]),
      getBalance(
        user.encryptedPrivateKey, user.encryptedApiKey,
        user.encryptedApiSecret, user.encryptedPassphrase,
        user.predexonUserId ?? undefined
      ).catch(() => '0.00'),
    ]);

    // Apply same claimed-filter as handleOpenPositions so counts are consistent
    const redeemable = activePositions.filter(p => p.redeemable);
    let visiblePositions = activePositions;
    if (redeemable.length > 0 && user.polymarketProxyAddress) {
      const claimedIds = await getClaimedConditionIds(
        user.polymarketProxyAddress,
        redeemable.map(p => p.conditionId as string),
      );
      if (claimedIds.size > 0) {
        visiblePositions = activePositions.filter(p =>
          p.size > 0 ||                           // on-chain proof: not yet settled
          !p.redeemable ||                         // not redeemable → always show
          !claimedIds.has(p.conditionId as string)  // no claimed key → show
        );
        logger.info(`[portfolio] Filtered ${activePositions.length - visiblePositions.length} claimed positions (${claimedIds.size} claimed keys)`);
      }
    }

    // Sync positionListCache so active positions page & sell/view actions use the same data
    if (visiblePositions.length > 0) {
      const { positionListCache } = await import('./positionTrade');
      positionListCache.set(telegramId, visiblePositions);
    }

    const totalInvested     = visiblePositions.reduce((s, p) => s + (p.initialValue), 0);
    const totalCurrentValue = visiblePositions.reduce((s, p) => s + p.currentValue, 0);
    const totalUnrealizedPnl = visiblePositions.reduce((s, p) => s + p.cashPnl, 0);
    const totalRealizedPnl  = closedPositions.reduce((s, p) => s + p.realizedPnl, 0) + visiblePositions.reduce((s, p) => s + p.realizedPnl, 0);
    const totalClosedInvested = closedPositions.reduce((s, p) => s + p.totalBought * p.avgPrice, 0);

    const unPnlSign  = totalUnrealizedPnl >= 0 ? '+' : '';
    const unPnlEmoji = totalUnrealizedPnl >= 0 ? '🟢' : '🔴';
    const rePnlSign  = totalRealizedPnl >= 0 ? '+' : '';
    const rePnlEmoji = totalRealizedPnl >= 0 ? '🟢' : '🔴';

    let message = `📊 *${t(lang, 'Portfolio Overview')}*\n\n`;
    message += `💰 ${t(lang, 'Available Balance')}: *$${balance}*\n\n`;

    if (visiblePositions.length > 0) {
      message += `📦 *${visiblePositions.length} ${t(lang, 'Active Position')}${visiblePositions.length !== 1 ? 's' : ''}*\n`;
      message += `├ ${t(lang, 'Invested')}: $${totalInvested.toFixed(2)}\n`;
      message += `├ ${t(lang, 'Current Value')}: $${totalCurrentValue.toFixed(2)}\n`;
      message += `└ ${unPnlEmoji} ${t(lang, 'Unrealized P&L')}: ${unPnlSign}$${totalUnrealizedPnl.toFixed(2)}\n\n`;
    } else {
      message += `📦 *${t(lang, 'No Active Positions')}*\n\n`;
    }

    if (closedPositions.length > 0) {
      message += `📜 *${closedPositions.length} ${t(lang, 'Closed Position')}${closedPositions.length !== 1 ? 's' : ''}*\n`;
      message += `├ ${t(lang, 'Invested')}: $${totalClosedInvested.toFixed(2)} → ${t(lang, 'Received')}: $${(totalClosedInvested + totalRealizedPnl).toFixed(2)}\n`;
      message += `└ ${rePnlEmoji} ${t(lang, 'Total Realized P&L')}: ${rePnlSign}$${totalRealizedPnl.toFixed(2)}\n\n`;
    } else {
      message += `📜 *${t(lang, 'No Closed Positions')}*\n\n`;
    }

    message += `_${t(lang, 'Select a section below for details.')}_`;

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      image_path: IMG_PORTFOLIO,
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn.activePositions'), 'portfolio_open_1')],
        [Markup.button.callback(t(lang, 'btn.openOrders'), 'portfolio_orders_1')],
        [Markup.button.callback(t(lang, 'btn.closedPositions'), 'portfolio_closed_1')],
        [Markup.button.callback(t(lang, 'btn.tradeHistory'), 'portfolio_all_1')],
        [Markup.button.callback(t(lang, 'btn.pnl'), 'portfolio_pnl')],
        [Markup.button.callback(t(lang, 'btn.refresh'), 'portfolio'), Markup.button.callback(t(lang, 'btn.backToWallet'), 'wallet_page')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
      ]),
    });

    logger.info(`Portfolio overview shown to user: ${ctx.from?.id}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing portfolio:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(t(lang, 'portfolio.errorLoading'));
  }
}

/**
 * Shows active positions with pagination (3 per page) and per-position Buy/Sell/View buttons
 */
export async function handleOpenPositions(ctx: Context, page: number = 1): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'portfolio.loadingPositions')).catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await sendPage(ctx, t(lang, 'common.userNotFound'));
      return;
    }

    const lang = getLang(user);

    // Fetch positions and update cache for Buy/Sell/View actions
    // Always force-refresh when triggered by callback (Refresh button or navigation)
    const { positionListCache } = await import('./positionTrade');
    const positions = await getActivePositions(user.polymarketProxyAddress || '', !!ctx.callbackQuery);

    // Filter out positions that are redeemable AND already claimed AND have no shares left.
    // Positions with size > 0 are ALWAYS shown — even if Redis has a claimed key, the on-chain
    // state (size > 0) proves the claim hasn't actually settled yet.
    const redeemable = positions.filter(p => p.redeemable);
    let visiblePositions = positions;
    logger.info(`[openPositions] user=${telegramId} api=${positions.length} redeemable=${redeemable.length}`);
    if (redeemable.length > 0 && user.polymarketProxyAddress) {
      const claimedIds = await getClaimedConditionIds(
        user.polymarketProxyAddress,
        redeemable.map(p => p.conditionId as string),
      );
      if (claimedIds.size > 0) {
        visiblePositions = positions.filter(p =>
          p.size > 0 ||                           // on-chain proof: not yet settled
          !p.redeemable ||                         // not redeemable → always show
          !claimedIds.has(p.conditionId as string)  // no claimed key → show
        );
        logger.info(`[openPositions] user=${telegramId} claimed=${claimedIds.size} visible=${visiblePositions.length}`);
      }
    }

    // Filter out 100% loss positions: market resolved against user, nothing to claim/redeem.
    // These are dead positions that belong in Closed Positions, not Active.
    // A redeemable position with currentValue=0 means user held the losing side — skip it.
    visiblePositions = visiblePositions.filter(p => p.currentValue > 0);

    positionListCache.set(telegramId, visiblePositions);

    if (visiblePositions.length === 0) {
      // Check for pending open orders so user knows their trades are on the book
      let openOrdersHint = '';
      try {
        const openOrds = await getOpenOrders(
          user.encryptedPrivateKey, user.encryptedApiKey,
          user.encryptedApiSecret, user.encryptedPassphrase,
          user.predexonUserId ?? undefined
        );
        if (openOrds.length > 0) {
          openOrdersHint =
            `\n\n📋 ${t(lang, 'You have')} *${openOrds.length} ${t(lang, 'open order')}${openOrds.length > 1 ? 's' : ''}* ${t(lang, 'waiting to fill')}.\n` +
            `_${t(lang, 'Positions appear here once your orders are matched.')}_`;
        }
      } catch { /* non-critical */ }

      await sendPage(ctx,
        `📊 *${t(lang, 'Active Positions')}*\n\n📭 ${t(lang, 'No filled positions yet.')}${openOrdersHint}`,
        {
          parse_mode: 'Markdown',
          image_path: IMG_POSITIONS,
          ...Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'btn.openOrders'), 'portfolio_orders_1')],
            [Markup.button.callback(`« ${t(lang, 'Portfolio')}`, 'portfolio')],
            [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    const ITEMS_PER_PAGE = 1;
    const totalPages = Math.ceil(visiblePositions.length / ITEMS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const pagePositions = visiblePositions.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const botUsername = config.telegram.botUsername;

    // Summary header
    const totalValue = visiblePositions.reduce((s, p) => s + p.currentValue, 0);
    const totalPnl   = visiblePositions.reduce((s, p) => s + p.cashPnl, 0);
    const summarySign  = totalPnl >= 0 ? '+' : '';
    const summaryEmoji = totalPnl >= 0 ? '🟢' : '🔴';

    let message = `📊 <b>${t(lang, 'Active Positions')}</b> (${visiblePositions.length} ${t(lang, 'total')} · ${t(lang, 'page')} ${currentPage}/${totalPages})\n`;
    message += `${summaryEmoji} ${t(lang, 'Total Value')}: $${totalValue.toFixed(2)} · P&amp;L: ${summarySign}$${totalPnl.toFixed(2)}\n\n`;

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
      entry += `   ├ ${pos.size.toFixed(2)} ${t(lang, 'sh')} · ${t(lang, 'Avg')}: ${(pos.avgPrice * 100).toFixed(1)}¢ · ${t(lang, 'Now')}: ${(pos.curPrice * 100).toFixed(1)}¢\n`;
      entry += `   ├ 💰 ${t(lang, 'Invested')}: $${(pos.initialValue).toFixed(2)} → ${t(lang, 'Value')}: $${pos.currentValue.toFixed(2)}\n`;
      entry += `   ├ ${pnlEmoji} ${t(lang, 'Unrealized')}: ${pnlSign}$${pos.cashPnl.toFixed(2)} (${pnlSign}${pos.percentPnl.toFixed(1)}%)\n`;
      if (pos.realizedPnl !== 0) {
        const rSign = pos.realizedPnl >= 0 ? '+' : '';
        entry += `   ├ 💵 ${t(lang, 'Realized')}: ${rSign}$${pos.realizedPnl.toFixed(2)}\n`;
      }
      entry += `   ├ 📅 ${t(lang, 'Ends')}: ${endDate}\n`;
      if (pos.redeemable) {
        const redeemLink = `https://t.me/${botUsername}?start=pr_${idx}`;
        entry += `   └ <a href="${redeemLink}">💰 ${t(lang, 'Redeem It')}</a> · <a href="${viewLink}">👁 ${t(lang, 'View')}</a> · <a href="${pnlLink}">📊 P&amp;L</a>\n\n`;
      } else {
        entry += `   └ <a href="${viewLink}">👁 ${t(lang, 'View')}</a> · <a href="${buyLink}">📈 ${t(lang, 'Buy')}</a> · <a href="${sellLink}">📉 ${t(lang, 'Sell')}</a> · <a href="${pnlLink}">📊 P&amp;L</a>\n\n`;
      }

      message += entry;
    }

    const buttons: any[] = [];

    const navRow: any[] = [];
    if (currentPage > 1) navRow.push(Markup.button.callback('◀️ Prev', `portfolio_open_${currentPage - 1}`));
    navRow.push(Markup.button.callback(`${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) navRow.push(Markup.button.callback('Next ▶️', `portfolio_open_${currentPage + 1}`));
    if (navRow.length > 1) buttons.push(navRow);

    buttons.push([
      Markup.button.callback(`📊 ${t(lang, 'Portfolio P&L')}`, 'portfolio_pnl'),
    ]);
    buttons.push([
      Markup.button.callback(t(lang, 'btn.refresh'), 'portfolio_open_1'),
      Markup.button.callback(`« ${t(lang, 'Portfolio')}`, 'portfolio'),
    ]);
    buttons.push([
      Markup.button.callback(`❌ ${t(lang, 'Close All Positions')}`, 'close_all_pos_confirm'),
      Markup.button.callback(`🛑 ${t(lang, 'Stop All Orders')}`, 'cancel_all_confirm'),
    ]);
    buttons.push([Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')]);

    await sendPage(ctx, message, {
      parse_mode: 'HTML',
      image_path: IMG_POSITIONS,
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Active positions page ${currentPage} shown to user: ${telegramId}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing active positions:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await sendPage(ctx,
      `❌ *${t(lang, 'Error Loading Positions')}*\n\n${t(lang, 'Please try again.')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(`« ${t(lang, 'Back to Portfolio')}`, 'portfolio')]]),
      }
    ).catch(() => {});
  }
}

/**
 * Shows open (pending) GTC orders with real-time data.
 */
export async function handleOpenOrders(ctx: Context, page: number = 1): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'Loading open orders...')).catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await sendPage(ctx, t(lang, 'common.userNotFound'));
      return;
    }

    const lang = getLang(user);

    const openOrders = await getOpenOrders(
      user.encryptedPrivateKey, user.encryptedApiKey,
      user.encryptedApiSecret, user.encryptedPassphrase,
      user.predexonUserId ?? undefined
    );

    if (openOrders.length === 0) {
      await sendPage(ctx,
        `📋 *${t(lang, 'Open Orders')}*\n\n✅ ${t(lang, 'No pending orders.')}\n\n_${t(lang, 'All your orders have been filled or cancelled.')}_`,
        {
          parse_mode: 'Markdown',
          image_path: IMG_LIMITORDERS,
          ...Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'btn.activePositions'), 'portfolio_open_1')],
            [Markup.button.callback(`« ${t(lang, 'Portfolio')}`, 'portfolio')],
            [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
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

    let message = `📋 *${t(lang, 'Open Orders')}* — ${openOrders.length} ${t(lang, 'pending')} · ${t(lang, 'page')} ${currentPage}/${totalPages}\n`;
    message += `💰 ${t(lang, 'Total Pending Value')}: ~$${totalPendingValue.toFixed(2)}\n\n`;
    message += `_${t(lang, 'GTC limit orders on the book, fill automatically.')}_\n\n`;

    pageOrders.forEach((order, i) => {
      const num = startIndex + i + 1;
      const side = order.side === 'BUY' ? `🟢 ${t(lang, 'BUY')}` : `🔴 ${t(lang, 'SELL')}`;
      const price = formatOrderPrice(order.price);
      const sizeMatched = parseFloat(order.size_matched || '0');
      const sizeTotal   = parseFloat(order.original_size || '0');
      const remaining   = sizeTotal - sizeMatched;
      const pctFilled   = sizeTotal > 0 ? ((sizeMatched / sizeTotal) * 100).toFixed(0) : '0';
      const totalValue  = (sizeTotal * parseFloat(order.price || '0')).toFixed(2);
      const remainValue = (remaining * parseFloat(order.price || '0')).toFixed(2);
      const created     = formatTimestamp(order.created_at);
      const outcome     = esc(order.outcome || order.order_type?.toUpperCase() || '—');
      const orderId     = order.id ? order.id.substring(0, 8) + '…' : '—';

      message += `*${num}.* ${side} @ ${price} · \`${orderId}\`\n`;
      if (outcome && outcome !== '—') message += `   ├ ${outcome}\n`;
      message += `   ├ 📦 ${sizeTotal.toFixed(2)} ${t(lang, 'sh')} ${t(lang, 'total')} · ${remaining.toFixed(2)} ${t(lang, 'remaining')} (${pctFilled}% ${t(lang, 'filled')})\n`;
      message += `   ├ 💰 ${t(lang, 'Total')}: $${totalValue} · ${t(lang, 'Remaining')}: ~$${remainValue}\n`;
      if (created && created !== '—') message += `   └ 📅 ${created}\n\n`;
      else message += '\n';
    });

    // Per-order cancel buttons
    const buttons: any[] = [];
    pageOrders.forEach((_order, i) => {
      const num = startIndex + i + 1;
      buttons.push([
        Markup.button.callback(
          `❌ ${t(lang, 'Cancel Order')} #${num}`,
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
      Markup.button.callback(t(lang, 'btn.refresh'), 'portfolio_orders_1'),
      Markup.button.callback(`❌ ${t(lang, 'Cancel All')}`, 'cancel_all_confirm'),
    ]);
    buttons.push([Markup.button.callback(`« ${t(lang, 'Portfolio')}`, 'portfolio')]);
    buttons.push([Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')]);

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      image_path: IMG_LIMITORDERS,
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Open orders page ${currentPage} shown to user: ${telegramId}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing open orders:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await sendPage(ctx, `❌ ${t(lang, 'Error loading open orders. Please try again.')}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback(`« ${t(lang, 'Portfolio')}`, 'portfolio')]]),
    }).catch(() => {});
  }
}

/**
 * Shows closed positions (trades) with pagination
 */
export async function handleClosedPositions(ctx: Context, page: number = 1): Promise<void> {
  try {
    await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'Loading closed positions...'));

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'common.cannotIdentify'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await sendPage(ctx, t(lang, 'common.userNotFound'), {
        parse_mode: 'Markdown',
      });
      return;
    }

    const lang = getLang(user);

    const closedPositions = await getClosedPositions(user.polymarketProxyAddress || '');

    // Sync closedPositionListCache so PNL actions can look up by index
    {
      const { closedPositionListCache } = await import('./positionTrade');
      closedPositionListCache.set(telegramId, closedPositions);
    }

    if (closedPositions.length === 0) {
      await sendPage(ctx,
        `📜 *${t(lang, 'Closed Positions')}*\n\n` +
        `📭 ${t(lang, 'You have no closed positions.')}\n\n` +
        t(lang, 'Positions you exited or settled markets will appear here.'),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`« ${t(lang, 'Back to Portfolio')}`, 'portfolio')],
            [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
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
    const totalInvested    = closedPositions.reduce((s, p) => s + p.totalBought * p.avgPrice, 0);
    const rePnlSign  = totalRealizedPnl >= 0 ? '+' : '';
    const rePnlEmoji = totalRealizedPnl >= 0 ? '🟢' : '🔴';

    let message = `📜 *${t(lang, 'Closed Positions')}* (${closedPositions.length} ${t(lang, 'total')} · ${t(lang, 'page')} ${currentPage}/${totalPages})\n`;
    message += `${rePnlEmoji} ${t(lang, 'Total Realized P&L')}: ${rePnlSign}$${totalRealizedPnl.toFixed(2)} ${t(lang, 'on')} $${totalInvested.toFixed(2)} ${t(lang, 'invested')}\n\n`;

    pagePositions.forEach((pos: ClosedPosition, index) => {
      const number = startIndex + index + 1;
      const rawTitle = pos.title || (pos.conditionId ? pos.conditionId.substring(0, 20) + '...' : 'Unknown Market');
      const truncTitle = esc(rawTitle.length > 46 ? rawTitle.substring(0, 46) + '...' : rawTitle);
      const pnlSign  = pos.realizedPnl >= 0 ? '+' : '';
      const pnlEmoji = pos.realizedPnl >= 0 ? '🟢' : '🔴';
      const invested   = pos.totalBought * pos.avgPrice;
      const roi        = invested > 0 ? (pos.realizedPnl / invested) * 100 : 0;
      const roiSign    = roi >= 0 ? '+' : '';
      const closedAt   = pos.timestamp
        ? new Date(pos.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'N/A';
      const endDate = pos.endDate
        ? new Date(pos.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'N/A';

      const received       = invested + pos.realizedPnl;
      const exitPriceCents = pos.totalBought > 0 ? ((received / pos.totalBought) * 100).toFixed(1) : '—';

      message += `*${number}) ${esc(pos.outcome || 'Unknown')}*\n`;
      message += `   ├ 📌 ${truncTitle}\n`;
      message += `   ├ 📊 ${pos.totalBought.toFixed(2)} ${t(lang, 'shares')} · ${t(lang, 'Buy')}: ${(pos.avgPrice * 100).toFixed(1)}¢ → ${t(lang, 'Exit')}: ${exitPriceCents}¢\n`;
      message += `   ├ 💰 ${t(lang, 'Invested')}: $${invested.toFixed(2)} · ${t(lang, 'Received')}: $${received.toFixed(2)}\n`;
      message += `   ├ ${pnlEmoji} ${t(lang, 'Realized P&L')}: ${pnlSign}$${pos.realizedPnl.toFixed(2)} (ROI: ${roiSign}${roi.toFixed(1)}%)\n`;
      message += `   ├ 📅 ${t(lang, 'Closed')}: ${closedAt}\n`;
      message += `   └ ⏰ ${t(lang, 'Market End')}: ${endDate}\n\n`;
    });

    // Build buttons
    const buttons: any[] = [];

    // Per-position PNL buttons
    pagePositions.forEach((_pos: ClosedPosition, index) => {
      const globalIdx = startIndex + index;
      const number = globalIdx + 1;
      buttons.push([Markup.button.callback(`📊 #${number} P&L`, `cp_pnl_${globalIdx}`)]);
    });

    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('◀️ Prev', `portfolio_closed_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`${t(lang, 'Page')} ${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ▶️', `portfolio_closed_${currentPage + 1}`));
    }
    buttons.push(navRow);

    buttons.push([Markup.button.callback(`« ${t(lang, 'Back to Portfolio')}`, 'portfolio')]);
    buttons.push([Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')]);

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Closed positions page ${currentPage} shown to user: ${telegramId}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing closed positions:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await sendPage(ctx,
      `❌ *${t(lang, 'Error Loading Trades')}*\n\n` +
      `${t(lang, 'We encountered an error while fetching your trade history.')}\n\n` +
      t(lang, 'This might be a temporary issue. Please try again.'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`« ${t(lang, 'Back to Portfolio')}`, 'portfolio')],
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
    await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'Loading all transactions...'));

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'common.cannotIdentify'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await sendPage(ctx, t(lang, 'common.userNotFound'), {
        parse_mode: 'Markdown',
      });
      return;
    }

    const lang = getLang(user);

    const [portfolioData, bondTrades, updownTrades, copiedTrades] = await Promise.all([
      getPortfolioData(
        user.encryptedPrivateKey,
        user.encryptedApiKey,
        user.encryptedApiSecret,
        user.encryptedPassphrase,
        user.polymarketProxyAddress || '',
        user.predexonUserId ?? undefined
      ),
      prisma.bondTrade.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { strategy: { select: { label: true } } },
      }),
      prisma.upDownTrade.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { strategy: { select: { label: true } } },
      }),
      prisma.copiedTrade.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { subscription: { select: { label: true } } },
      }),
    ]);

    const openOrders = portfolioData.openOrders;
    const trades = portfolioData.trades;

    // Combine and sort all transactions
    interface Transaction {
      type: 'order' | 'trade' | 'bond' | 'autopilot' | 'copy';
      data: any;
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
      ...bondTrades.map((bt) => ({
        type: 'bond' as const,
        data: bt,
        timestamp: bt.createdAt.getTime(),
      })),
      ...updownTrades.map((ut) => ({
        type: 'autopilot' as const,
        data: ut,
        timestamp: ut.createdAt.getTime(),
      })),
      ...copiedTrades.map((ct) => ({
        type: 'copy' as const,
        data: ct,
        timestamp: ct.createdAt.getTime(),
      })),
    ].sort((a, b) => b.timestamp - a.timestamp);

    if (allTransactions.length === 0) {
      await sendPage(ctx,
        `📋 *${t(lang, 'All Transactions')}*\n\n` +
        `📭 ${t(lang, 'You have no transactions yet.')}\n\n` +
        t(lang, 'Your trading activity will appear here.'),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`« ${t(lang, 'Back to Portfolio')}`, 'portfolio')],
            [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
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

    let message = `📋 *${t(lang, 'All Transactions')}*\n\n`;
    message += `${t(lang, 'Found')} ${allTransactions.length} ${t(lang, 'transaction')}${allTransactions.length !== 1 ? 's' : ''} · ${t(lang, 'page')} ${currentPage}/${totalPages}\n\n`;

    pageTransactions.forEach((tx, index) => {
      const number = startIndex + index + 1;

      if (tx.type === 'order') {
        const order = tx.data as OpenOrder;
        const side       = order.side === 'BUY' ? `🟢 ${t(lang, 'BUY')}` : `🔴 ${t(lang, 'SELL')}`;
        const price      = formatOrderPrice(order.price);
        const sizeTotal  = parseFloat(order.original_size || '0');
        const sizeMatched = parseFloat(order.size_matched || '0');
        const pctFilled  = sizeTotal > 0 ? ((sizeMatched / sizeTotal) * 100).toFixed(0) : '0';
        const value      = (sizeTotal * parseFloat(order.price || '0')).toFixed(2);
        const created    = formatTimestamp(order.created_at);
        const outcome    = esc(order.outcome || '—');

        message += `*${number}. 📋 ${t(lang, 'OPEN ORDER')}*\n`;
        message += `   ├ ${side} · ${outcome}\n`;
        message += `   ├ ${sizeTotal.toFixed(2)} ${t(lang, 'sh')} @ ${price} = $${value}\n`;
        message += `   ├ ${pctFilled}% ${t(lang, 'filled')} (${sizeMatched.toFixed(2)} / ${sizeTotal.toFixed(2)} ${t(lang, 'sh')})\n`;
        message += `   └ 📅 ${created}\n\n`;
      } else if (tx.type === 'trade') {
        const trade      = tx.data as Trade;
        const side       = trade.side === 'BUY' ? `🟢 ${t(lang, 'BUY')}` : `🔴 ${t(lang, 'SELL')}`;
        const price      = formatOrderPrice(trade.price);
        const size       = parseFloat(trade.size || '0');
        const value      = (size * parseFloat(trade.price || '0')).toFixed(2);
        const matchTime  = formatTimestamp(trade.match_time);
        const outcome    = esc(trade.outcome || '—');
        const txHash     = trade.transaction_hash
          ? `${trade.transaction_hash.substring(0, 10)}…${trade.transaction_hash.slice(-8)}`
          : '—';

        message += `*${number}. ✅ ${t(lang, 'FILLED')}*\n`;
        message += `   ├ ${side} · ${outcome}\n`;
        message += `   ├ ${size.toFixed(2)} ${t(lang, 'sh')} @ ${price} = $${value}\n`;
        message += `   ├ 📅 ${matchTime}\n`;
        message += `   └ 🔗 Tx: \`${txHash}\`\n\n`;
      } else if (tx.type === 'bond') {
        const bt = tx.data;
        const statusIcon = bt.status === 'filled' ? '✅' : bt.status === 'failed' ? '❌' : '⏳';
        const outcome = esc(bt.outcome || '—');
        const question = esc(bt.question.length > 40 ? bt.question.slice(0, 40) + '…' : bt.question);
        const label = bt.strategy?.label ? esc(bt.strategy.label) : 'Bond';
        const time = formatTimestamp(bt.createdAt);

        message += `*${number}. ${statusIcon} BOND*\n`;
        message += `   ├ 🟢 BUY · ${outcome}\n`;
        message += `   ├ $${bt.amount.toFixed(2)} @ ${(bt.price * 100).toFixed(1)}¢\n`;
        message += `   ├ 📌 ${question}\n`;
        message += `   ├ 🏷 ${label}\n`;
        message += `   └ 📅 ${time}\n\n`;
      } else if (tx.type === 'autopilot') {
        const ut = tx.data;
        const statusIcon = ut.status === 'filled' ? '✅' : ut.status === 'failed' ? '❌' : '⏳';
        const dir = ut.direction === 'up' ? '🟢 UP' : '🔴 DOWN';
        const label = ut.strategy?.label ? esc(ut.strategy.label) : 'AutoPilot';
        const question = esc(ut.question.length > 40 ? ut.question.slice(0, 40) + '…' : ut.question);
        const time = formatTimestamp(ut.createdAt);
        const tpsl = ut.tpSlStatus ? ` · ${ut.tpSlStatus === 'tp_triggered' ? '🎯 TP' : '🛑 SL'}` : '';

        message += `*${number}. ${statusIcon} AUTOPILOT*\n`;
        message += `   ├ ${dir} · ${esc(ut.coin)}${tpsl}\n`;
        message += `   ├ $${ut.amount.toFixed(2)}${ut.fillPrice ? ` @ ${(ut.fillPrice * 100).toFixed(1)}¢` : ''}\n`;
        message += `   ├ 📌 ${question}\n`;
        message += `   ├ 🏷 ${label}\n`;
        message += `   └ 📅 ${time}\n\n`;
      } else if (tx.type === 'copy') {
        const ct = tx.data;
        const statusIcon = ct.status === 'filled' ? '✅' : ct.status === 'failed' ? '❌' : ct.status === 'skipped' ? '⏭' : '⏳';
        const side = ct.side === 'BUY' ? `🟢 ${t(lang, 'BUY')}` : `🔴 ${t(lang, 'SELL')}`;
        const outcome = esc(ct.outcome || '—');
        const label = ct.subscription?.label ? esc(ct.subscription.label) : esc(ct.traderAddress.slice(0, 8) + '…');
        const time = formatTimestamp(ct.createdAt);
        const tpsl = ct.tpSlStatus ? ` · ${ct.tpSlStatus === 'tp_triggered' ? '🎯 TP' : '🛑 SL'}` : '';

        message += `*${number}. ${statusIcon} COPY*\n`;
        message += `   ├ ${side} · ${outcome}${tpsl}\n`;
        message += `   ├ $${ct.copiedSize.toFixed(2)} @ ${(ct.price * 100).toFixed(1)}¢\n`;
        message += `   ├ 👤 ${label}\n`;
        message += `   └ 📅 ${time}\n\n`;
      }
    });

    // Build buttons
    const buttons: any[] = [];

    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('◀️ Prev', `portfolio_all_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`${t(lang, 'Page')} ${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ▶️', `portfolio_all_${currentPage + 1}`));
    }
    buttons.push(navRow);

    buttons.push([Markup.button.callback(`« ${t(lang, 'Back to Portfolio')}`, 'portfolio')]);
    buttons.push([Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')]);

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`All transactions page ${currentPage} shown to user: ${telegramId}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing all transactions:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await sendPage(ctx,
      `❌ *${t(lang, 'Error Loading Transactions')}*\n\n` +
      `${t(lang, 'We encountered an error while fetching your transactions.')}\n\n` +
      t(lang, 'This might be a temporary issue. Please try again.'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`« ${t(lang, 'Back to Portfolio')}`, 'portfolio')],
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
    if (!user) { await ctx.reply(t(((ctx as any).userLanguage as Locale) || 'en', 'common.userNotFoundShort')); return; }

    const lang = getLang(user);

    // Re-fetch live orders to find the exact one
    const openOrders = await getOpenOrders(
      user.encryptedPrivateKey, user.encryptedApiKey,
      user.encryptedApiSecret, user.encryptedPassphrase,
      user.predexonUserId ?? undefined
    );

    const ITEMS_PER_PAGE = 4;
    const absoluteIdx = (page - 1) * ITEMS_PER_PAGE + idx;
    const order = openOrders[absoluteIdx];

    if (!order) {
      await sendPage(ctx,
        `⚠️ ${t(lang, 'Order not found — it may have already been filled or cancelled.')}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback(`« ${t(lang, 'Open Orders')}`, 'portfolio_orders_1')]]),
        }
      );
      return;
    }

    const side = order.side === 'BUY' ? `🟢 ${t(lang, 'BUY')}` : `🔴 ${t(lang, 'SELL')}`;
    const price = formatOrderPrice(order.price);
    const size = parseFloat(order.original_size || '0').toFixed(2);
    const esc = (s: string) => s.replace(/[_*`[\]()]/g, '\\$&');

    await sendPage(ctx,
      `⚠️ *${t(lang, 'Confirm Cancel Order')}*\n\n` +
      `${side} ${size} ${t(lang, 'shares')} @ ${price}\n` +
      `${t(lang, 'Market')}: ${esc(order.outcome || order.market || '—')}\n\n` +
      t(lang, 'This order will be removed from the book immediately.'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`✅ ${t(lang, 'Yes, Cancel It')}`, `cancel_ord_do_${page}_${idx}`),
            Markup.button.callback(`« ${t(lang, 'Keep Order')}`, 'portfolio_orders_1'),
          ],
        ]),
      }
    );
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing cancel order confirmation:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Error loading order. Please try again.')}`);
  }
}

/**
 * Executes cancellation of a single order.
 * callback: cancel_ord_do_{page}_{idx}
 */
export async function handleCancelOrderExecute(ctx: Context, page: number, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'Cancelling order...'));

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply(t(((ctx as any).userLanguage as Locale) || 'en', 'common.userNotFoundShort')); return; }

    const lang = getLang(user);

    // Re-fetch live orders to find the exact order ID
    const openOrders = await getOpenOrders(
      user.encryptedPrivateKey, user.encryptedApiKey,
      user.encryptedApiSecret, user.encryptedPassphrase,
      user.predexonUserId ?? undefined
    );

    const ITEMS_PER_PAGE = 4;
    const absoluteIdx = (page - 1) * ITEMS_PER_PAGE + idx;
    const order = openOrders[absoluteIdx];

    if (!order) {
      await sendPage(ctx,
        `✅ ${t(lang, 'Order already gone — it was filled or cancelled.')}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback(`« ${t(lang, 'Open Orders')}`, 'portfolio_orders_1')]]),
        }
      );
      return;
    }

    const result = await cancelOrderById(
      user.encryptedPrivateKey, user.encryptedApiKey,
      user.encryptedApiSecret, user.encryptedPassphrase,
      order.id,
      user.predexonUserId ?? undefined
    );

    await invalidatePortfolioCache(user.polymarketProxyAddress ?? '');

    if (result.success) {
      await sendPage(ctx,
        `✅ *${t(lang, 'Order Cancelled')}*\n\n` +
        `${t(lang, 'Your')} ${order.side} ${t(lang, 'order has been removed from the book.')}\n\n` +
        `_${t(lang, 'Any partially filled amount remains as shares in your position.')}_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'btn.openOrders'), 'portfolio_orders_1')],
            [Markup.button.callback(t(lang, 'btn.activePositions'), 'portfolio_open_1')],
            [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
          ]),
        }
      );
      logger.info(`[walletPage] Cancelled order ${order.id.substring(0, 16)}... for user ${telegramId}`);
    } else {
      await sendPage(ctx,
        `❌ *${t(lang, 'Cancel Failed')}*\n\n${t(lang, 'Reason')}: ${result.errorReason || t(lang, 'Unknown error')}\n\n` +
        `_${t(lang, 'The order may have already filled.')}_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback(`« ${t(lang, 'Open Orders')}`, 'portfolio_orders_1')]]),
        }
      );
    }
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error cancelling order:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Error cancelling order. Please try again.')}`);
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
    if (!user) { await ctx.reply(t(((ctx as any).userLanguage as Locale) || 'en', 'common.userNotFoundShort')); return; }

    const lang = getLang(user);

    // Count current open orders for the confirmation message
    const openOrders = await getOpenOrders(
      user.encryptedPrivateKey, user.encryptedApiKey,
      user.encryptedApiSecret, user.encryptedPassphrase,
      user.predexonUserId ?? undefined
    );

    if (openOrders.length === 0) {
      await sendPage(ctx,
        `✅ ${t(lang, 'No open orders to cancel.')}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback(`« ${t(lang, 'Open Orders')}`, 'portfolio_orders_1')]]),
        }
      );
      return;
    }

    await sendPage(ctx,
      `⚠️ *${t(lang, 'Cancel All Orders')}*\n\n` +
      `${t(lang, 'You have')} *${openOrders.length} ${t(lang, 'open order')}${openOrders.length > 1 ? 's' : ''}* ${t(lang, 'on the book')}.\n\n` +
      `${t(lang, 'Cancelling all will remove them immediately. Any partial fills are kept.')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`✅ ${t(lang, 'Cancel All')} ${openOrders.length} ${t(lang, 'Orders')}`, 'cancel_all_do'),
            Markup.button.callback(`« ${t(lang, 'Keep Orders')}`, 'portfolio_orders_1'),
          ],
        ]),
      }
    );
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing cancel all confirmation:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Error loading orders. Please try again.')}`);
  }
}

/**
 * Executes cancellation of ALL open orders.
 * callback: cancel_all_do
 */
export async function handleCancelAllExecute(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'Cancelling all orders...'));

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply(t(((ctx as any).userLanguage as Locale) || 'en', 'common.userNotFoundShort')); return; }

    const lang = getLang(user);

    const result = await cancelAllOrders(
      user.encryptedPrivateKey, user.encryptedApiKey,
      user.encryptedApiSecret, user.encryptedPassphrase,
      user.predexonUserId ?? undefined
    );

    await invalidatePortfolioCache(user.polymarketProxyAddress ?? '');

    if (result.failed === -1) {
      await sendPage(ctx,
        `❌ *${t(lang, 'Cancel All Failed')}*\n\n${t(lang, 'Could not reach the exchange. Please try again.')}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback(`« ${t(lang, 'Open Orders')}`, 'portfolio_orders_1')]]),
        }
      );
      return;
    }

    const summary = result.cancelled > 0
      ? `✅ *${result.cancelled} ${t(lang, 'order')}${result.cancelled > 1 ? 's' : ''} ${t(lang, 'cancelled successfully.')}*`
      : `✅ ${t(lang, 'No orders were cancelled.')}`;
    const failLine = result.failed > 0 ? `\n⚠️ ${result.failed} ${t(lang, 'could not be cancelled (may have filled).')}` : '';

    await sendPage(ctx,
      `${summary}${failLine}\n\n_${t(lang, 'Any partial fills remain as positions.')}_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.activePositions'), 'portfolio_open_1')],
          [Markup.button.callback(`« ${t(lang, 'Portfolio')}`, 'portfolio')],
          [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
        ]),
      }
    );

    logger.info(`[walletPage] Cancel all for user ${telegramId}: ${result.cancelled} cancelled, ${result.failed} failed`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error cancelling all orders:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Error cancelling orders. Please try again.')}`);
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
    if (!user) { await ctx.reply(t(((ctx as any).userLanguage as Locale) || 'en', 'common.userNotFoundShort')); return; }

    const lang = getLang(user);

    const positions = await getActivePositions(user.polymarketProxyAddress || '');

    if (positions.length === 0) {
      await sendPage(ctx,
        `✅ ${t(lang, 'No active positions to close.')}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback(`« ${t(lang, 'Active Positions')}`, 'portfolio_open_1')]]),
        }
      );
      return;
    }

    const sellableCount   = positions.filter(p => !p.redeemable).length;
    const redeemableCount = positions.filter(p =>  p.redeemable).length;
    const totalValue      = positions.reduce((sum, p) => sum + p.currentValue, 0);

    const breakdownLines: string[] = [];
    if (sellableCount > 0)   breakdownLines.push(`• ${t(lang, 'Sell')} *${sellableCount}* ${t(lang, 'open position')}${sellableCount > 1 ? 's' : ''} ${t(lang, 'at market price')}`);
    if (redeemableCount > 0) breakdownLines.push(`• ${t(lang, 'Redeem')} *${redeemableCount}* ${t(lang, 'resolved position')}${redeemableCount > 1 ? 's' : ''}`);

    await sendPage(ctx,
      `⚠️ *${t(lang, 'Close All Positions')}*\n\n` +
      `${t(lang, 'You have')} *${positions.length} ${t(lang, 'active position')}${positions.length > 1 ? 's' : ''}* ${t(lang, 'worth')} ~*$${totalValue.toFixed(2)}*.\n\n` +
      `${breakdownLines.join('\n')}\n\n` +
      `${t(lang, 'Illiquid positions may fail individually.')}\n\n` +
      `⚠️ ${t(lang, 'This action cannot be undone.')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`✅ ${t(lang, 'Close All')} (${positions.length})`, 'close_all_pos_do'),
            Markup.button.callback(`« ${t(lang, 'Keep Positions')}`, 'portfolio_open_1'),
          ],
        ]),
      }
    );
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing close all confirmation:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Error loading positions. Please try again.')}`);
  }
}

/**
 * Executes bulk close of all active positions.
 * callback: close_all_pos_do
 */
export async function handleCloseAllExecute(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'Closing all positions...'));

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply(t(((ctx as any).userLanguage as Locale) || 'en', 'common.userNotFoundShort')); return; }

    const lang = getLang(user);

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    await sendPage(ctx,
      `${ce(EMOJI.loading, '⏳')} <b>${t(lang, 'Closing all positions...')}</b>\n\n<i>${t(lang, 'This may take a moment. You can continue using the bot.')}</i>`,
      { parse_mode: 'HTML' }
    );

    // Run in background so the bot stays responsive
    const bot = ctx.telegram;
    (async () => {
      try {
        const { executeCloseAllPositions } = await import('./positionTrade');
        const result = await executeCloseAllPositions(user, user.slippageTolerance ?? 1.0);

        await invalidatePortfolioCache(user.polymarketProxyAddress ?? '');

        // If any redeem hit the NegRiskAdapter overflow path, alert admins with a single summary
        // so they can manually help the (likely legacy) user unstick those positions.
        if (result.overflowPositions.length > 0) {
          const overflowLines = result.overflowPositions.slice(0, 10).map(p =>
            `• ${esc(p.outcome)} — ${esc(p.title.slice(0, 40))} (cid: <code>${p.conditionId.slice(0, 20)}…</code>)`
          );
          const overflowMore = result.overflowPositions.length > 10
            ? `\n…and ${result.overflowPositions.length - 10} more`
            : '';
          notifyAdmins(bot,
            `⚠️ <b>Manual Redeem Needed (Close All)</b>\n` +
            `User: <code>${user.telegramId}</code>` + (user.username ? ` (@${user.username})` : '') + `\n` +
            `Proxy: <code>${user.polymarketProxyAddress}</code>\n` +
            `${result.overflowPositions.length} position(s) stuck on Builder overflow:\n` +
            overflowLines.join('\n') + overflowMore + `\n` +
            `Reason: NegRiskAdapter SafeMath overflow; not in Predexon ledger.`
          ).catch((err) => logger.warn('[walletPage] notifyAdmins (overflow) failed:', err));
        }

        const lines: string[] = [];
        if (result.closed > 0)   lines.push(`✅ <b>${result.closed} ${t(lang, 'position')}${result.closed > 1 ? 's' : ''} ${t(lang, 'sold')}</b> ${t(lang, 'at market price')}.`);
        if (result.redeemed > 0) lines.push(`💵 <b>${result.redeemed} ${t(lang, 'resolved position')}${result.redeemed > 1 ? 's' : ''} ${t(lang, 'redeemed')}</b> — USDC.e ${t(lang, 'returned to your wallet')}.`);
        if (lines.length === 0)  lines.push(`ℹ️ ${t(lang, 'No positions were closed.')}`);
        const summary = lines.join('\n');
        const failLine = result.failed > 0
          ? `\n\n⚠️ ${result.failed} ${t(lang, 'could not be closed (illiquid, too small, or redeem failed)')}:\n` +
            result.errors.slice(0, 3).map(e => `• ${esc(e)}`).join('\n')
          : '';

        await bot.sendMessage(chatId,
          `${summary}${failLine}\n\n<i>${t(lang, 'Check your positions for the updated state.')}</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback(`📊 ${t(lang, 'My Positions')}`, 'portfolio_open_1')],
              [Markup.button.callback(`« ${t(lang, 'Portfolio')}`, 'portfolio')],
              [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
            ]),
          }
        );

        logger.info(`[walletPage] closeAll user=${telegramId}: closed=${result.closed} redeemed=${result.redeemed} failed=${result.failed}`);
      } catch (error: any) {
        logger.error('Error closing all positions (background):', error);
        await bot.sendMessage(chatId, `❌ ${t(lang, 'Error closing positions. Please try again.')}`).catch(() => {});
      }
    })();
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error closing all positions:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Error closing positions. Please try again.')}`);
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
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'common.userNotFound'));
      return;
    }

    const lang = getLang(user);

    // Only show loading message for /pnl command, not for callback actions (Refresh)
    let loadingMsg: any = null;
    if (!ctx.callbackQuery) {
      loadingMsg = await ctx.reply(`📊 ${t(lang, 'Fetching P&L...')}`);
    }

    const forceRefresh = !!ctx.callbackQuery;
    const [activePositions, closedPositions, balance, profilePhotoBuffer] = await Promise.all([
      getActivePositions(user.polymarketProxyAddress || '', forceRefresh).catch(() => [] as ActivePosition[]),
      getClosedPositions(user.polymarketProxyAddress || '', forceRefresh).catch(() => [] as ClosedPosition[]),
      getBalance(
        user.encryptedPrivateKey, user.encryptedApiKey,
        user.encryptedApiSecret, user.encryptedPassphrase,
        user.predexonUserId ?? undefined
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
    const activeRealized  = activePositions.reduce((s, p) => s + p.realizedPnl, 0);
    const closedRealized  = closedPositions.reduce((s, p) => s + p.realizedPnl, 0);
    const totalPnl        = totalUnrealized + activeRealized + closedRealized;
    const activeInvested  = activePositions.reduce((s, p) => s + p.initialValue, 0);
    const closedInvested  = closedPositions.reduce((s, p) => s + p.totalBought * p.avgPrice, 0);
    const totalInvested   = activeInvested + closedInvested;
    const percentPnl      = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    // All-time card stats — each position's total PnL = unrealized + realized
    const tradeCount = activePositions.length + closedPositions.length;
    const allPnls = [
      ...activePositions.map(p => p.cashPnl + p.realizedPnl),
      ...closedPositions.map(p => p.realizedPnl),
    ];
    const bestTrade  = allPnls.length > 0 ? Math.max(...allPnls) : 0;
    const worstTrade = allPnls.length > 0 ? Math.min(...allPnls) : 0;

    const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');

    const pnlKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(t(lang, 'btn.refresh'), 'pnl_alltime'),
        Markup.button.callback(t(lang, 'btn.share'), 'pnl_share_alltime'),
      ],
      [Markup.button.callback(`📊 ${t(lang, 'Full Portfolio')}`, 'portfolio')],
      [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
    ]);

    // Build rich HTML caption
    const pnlDir = totalPnl >= 0 ? ce(EMOJI.pnlUp, '📈') : ce(EMOJI.pnlDown, '📉');
    const pnlSign = totalPnl >= 0 ? '+' : '';
    const pctSign = percentPnl >= 0 ? '+' : '';

    let caption = `${ce(EMOJI.pnlChart, '📊')} <b>${t(lang, 'All-Time P&L')}</b>\n\n`;
    caption += `${ce(EMOJI.diamond, '💎')} <b>${t(lang, 'Total P&L')}:</b>  ${pnlDir} <b>${pnlSign}$${totalPnl.toFixed(2)}</b>\n`;
    caption += `${ce(EMOJI.rocket, '🚀')} <b>ROI:</b>  ${pctSign}${percentPnl.toFixed(1)}%\n\n`;
    caption += `${ce(EMOJI.bag, '💰')} <b>${t(lang, 'Trades')}:</b>  ${tradeCount}\n`;
    const bestSign = bestTrade >= 0 ? '+' : '-';
    const worstSign = worstTrade >= 0 ? '+' : '-';
    caption += `${ce(EMOJI.trophy, '🏆')} <b>${t(lang, 'Best Trade')}:</b>  ${bestSign}$${Math.abs(bestTrade).toFixed(2)}\n`;
    caption += `${ce(EMOJI.usdc, '💲')} <b>${t(lang, 'Worst Trade')}:</b>  ${worstSign}$${Math.abs(worstTrade).toFixed(2)}\n`;
    caption += `${ce(EMOJI.briefcase, '💼')} <b>${t(lang, 'Balance')}:</b>  $${balance}`;

    // Try image generation
    try {
      const imageBuffer = await generateAllTimePnlImage({
        totalPnl,
        tradeCount,
        bestTrade,
        worstTrade,
        balance,
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
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Failed to fetch P&L. Please try again.')}`).catch(() => {});
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
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'common.userNotFound'));
      return;
    }

    const lang = getLang(user);

    const [activePositions, balance, profilePhotoBuffer] = await Promise.all([
      getActivePositions(user.polymarketProxyAddress || '', true).catch(() => [] as ActivePosition[]),
      getBalance(
        user.encryptedPrivateKey, user.encryptedApiKey,
        user.encryptedApiSecret, user.encryptedPassphrase,
        user.predexonUserId ?? undefined
      ).catch(() => '0.00'),
      fetchProfilePhoto(ctx),
    ]);

    // Update position cache so subsequent position actions work
    if (activePositions.length > 0) {
      const { positionListCache } = await import('./positionTrade');
      positionListCache.set(telegramId, activePositions);
    }

    const unrealizedPnl = activePositions.reduce((s, p) => s + p.cashPnl, 0);
    const totalInvested = activePositions.reduce((s, p) => s + (p.initialValue), 0);
    const percentPnl    = totalInvested > 0 ? (unrealizedPnl / totalInvested) * 100 : 0;

    const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');

    const pnlKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(t(lang, 'btn.refresh'), 'portfolio_pnl'),
        Markup.button.callback(t(lang, 'btn.share'), 'pnl_share_portfolio'),
      ],
      [Markup.button.callback(`« ${t(lang, 'Portfolio')}`, 'portfolio')],
      [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
    ]);

    // Build rich HTML caption
    const pnlDir = unrealizedPnl >= 0 ? ce(EMOJI.pnlUp, '📈') : ce(EMOJI.pnlDown, '📉');
    const pnlSign = unrealizedPnl >= 0 ? '+' : '';
    const pctSign = percentPnl >= 0 ? '+' : '';

    let caption = `${ce(EMOJI.pnlChart, '📊')} <b>${t(lang, 'Portfolio P&L')}</b>\n\n`;
    caption += `${ce(EMOJI.diamond, '💎')} <b>${t(lang, 'Unrealized P&L')}:</b>  ${pnlDir} <b>${pnlSign}$${unrealizedPnl.toFixed(2)}</b>\n`;
    caption += `${ce(EMOJI.rocket, '🚀')} <b>ROI:</b>  ${pctSign}${percentPnl.toFixed(1)}%\n\n`;
    caption += `${ce(EMOJI.bag, '💰')} <b>${t(lang, 'Invested')}:</b>  $${totalInvested.toFixed(2)}\n`;
    caption += `${ce(EMOJI.trophy, '🏆')} <b>${t(lang, 'Portfolio Value')}:</b>  $${(totalInvested + unrealizedPnl).toFixed(2)}\n`;
    caption += `${ce(EMOJI.usdc, '💲')} <b>${t(lang, 'Balance')}:</b>  $${balance}\n`;
    caption += `${ce(EMOJI.briefcase, '💼')} <b>${t(lang, 'Positions')}:</b>  ${activePositions.length} ${t(lang, 'active')}`;

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
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Failed to fetch P&L. Please try again.')}`).catch(() => {});
  }
}

/**
 * pnl_share_* actions — Re-send PNL image without keyboard (forwardable)
 */
export async function handlePnlShare(ctx: Context, type: 'alltime' | 'portfolio'): Promise<void> {
  try {
    await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'Generating share image...')).catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) return;

    const lang = getLang(user);

    const [activePositions, closedPositions, balance, profilePhotoBuffer] = await Promise.all([
      getActivePositions(user.polymarketProxyAddress || '').catch(() => [] as ActivePosition[]),
      getClosedPositions(user.polymarketProxyAddress || '').catch(() => [] as ClosedPosition[]),
      getBalance(
        user.encryptedPrivateKey, user.encryptedApiKey,
        user.encryptedApiSecret, user.encryptedPassphrase,
        user.predexonUserId ?? undefined
      ).catch(() => '0.00'),
      fetchProfilePhoto(ctx),
    ]);

    const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');
    let imageBuffer: Buffer | null = null;

    if (type === 'alltime') {
      const totalUnrealized = activePositions.reduce((s, p) => s + p.cashPnl, 0);
      const activeRealized  = activePositions.reduce((s, p) => s + p.realizedPnl, 0);
      const closedRealized  = closedPositions.reduce((s, p) => s + p.realizedPnl, 0);
      const totalPnl        = totalUnrealized + activeRealized + closedRealized;

      const tradeCount = activePositions.length + closedPositions.length;
      const allPnls = [
        ...activePositions.map(p => p.cashPnl + p.realizedPnl),
        ...closedPositions.map(p => p.realizedPnl),
      ];
      const bestTrade  = allPnls.length > 0 ? Math.max(...allPnls) : 0;
      const worstTrade = allPnls.length > 0 ? Math.min(...allPnls) : 0;

      imageBuffer = await generateAllTimePnlImage({
        totalPnl, tradeCount, bestTrade, worstTrade, balance,
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
      const shareCaption = `${ce(EMOJI.pnlChart, '📊')} ${t(lang, 'My P&L')} — <b>Polytech Sniper Bot</b>`;
      await ctx.replyWithPhoto(
        { source: imageBuffer },
        { caption: shareCaption, parse_mode: 'HTML' },
      );
    } else {
      await ctx.answerCbQuery(t(lang, 'No PNL templates available yet.'), { show_alert: true });
    }
  } catch (error) {
    logger.error('Error in handlePnlShare:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Failed to generate share image.')}`);
  }
}
