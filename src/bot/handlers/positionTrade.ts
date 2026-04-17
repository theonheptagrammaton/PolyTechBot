import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { config } from '../../config';
import { getActivePositions, getClosedPositions, getBalance, ActivePosition, ClosedPosition, fetchTxHashForOrder } from '../../services/portfolio';
import { logger } from '../../utils/logger';
import { transferCommission, COMMISSION_RATE } from '../../services/commission';
import { sendPage, sendImageBufferPage, fetchProfilePhoto } from '../../utils/telegram';
import { ce, esc, EMOJI } from '../../utils/customEmoji';
import { generatePositionPnlImage } from '../../services/pnlImage';
import { RedisBackedState } from '../../utils/redisState';
import { t, Locale } from '../../i18n';

function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

// ─── Helpers: image fetching ────────────────────────────────────────────────

/** Fetches an image URL as a Buffer. Returns undefined on failure. */
async function fetchImageBuffer(url?: string): Promise<Buffer | undefined> {
  if (!url) return undefined;
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return undefined;
  }
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Polymarket CLOB minimum order size in shares/tokens */
const MIN_ORDER_SIZE = 1;

// ─── Caches ────────────────────────────────────────────────────────────────

/** telegramId → fetched positions array (populated when user opens positions page) */
export const positionListCache = new Map<string, ActivePosition[]>();

/** telegramId → fetched closed positions array (populated when user opens closed positions page) */
export const closedPositionListCache = new Map<string, ClosedPosition[]>();

// ─── State ─────────────────────────────────────────────────────────────────

interface PositionTradeState {
  action: 'buy' | 'sell' | 'stop_loss';
  assetId: string;
  conditionId: string;
  negRisk: boolean;
  title: string;
  outcome: string;
  currentSize: number;
  curPrice: number;       // current market price (used as default for confirmations)
  step: 'awaiting_price_size' | 'awaiting_sl_price';
  price?: number;
  size?: number;
  timestamp: number;
}

export const positionTradeState = new RedisBackedState<PositionTradeState>('positionTrade', 600);

// R6: Periodic cleanup of abandoned state entries (every 30 min, remove entries > 10 min old)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, state] of positionTradeState.entries()) {
    if (state.timestamp < cutoff) positionTradeState.delete(key);
  }
}, 30 * 60 * 1000);

// ─── Helpers ───────────────────────────────────────────────────────────────

function getPos(telegramId: string, idx: number): ActivePosition | null {
  const list = positionListCache.get(telegramId);
  if (!list || idx < 0 || idx >= list.length) return null;
  return list[idx];
}

/** Try cache first, then fetch fresh positions from API if cache misses */
async function getPosOrFetch(telegramId: string, idx: number): Promise<ActivePosition | null> {
  const cached = getPos(telegramId, idx);
  if (cached) return cached;

  const user = await getUserByTelegramId(telegramId);
  if (!user?.polymarketProxyAddress) return null;

  const fresh = await getActivePositions(user.polymarketProxyAddress).catch(() => []);
  if (fresh.length > 0) positionListCache.set(telegramId, fresh);
  return idx >= 0 && idx < fresh.length ? fresh[idx] : null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.substring(0, n) + '...' : s;
}

function getClosedPos(telegramId: string, idx: number): ClosedPosition | null {
  const list = closedPositionListCache.get(telegramId);
  if (!list || idx < 0 || idx >= list.length) return null;
  return list[idx];
}

async function getClosedPosOrFetch(telegramId: string, idx: number): Promise<ClosedPosition | null> {
  const cached = getClosedPos(telegramId, idx);
  if (cached) return cached;

  const user = await getUserByTelegramId(telegramId);
  if (!user?.polymarketProxyAddress) return null;

  const fresh = await getClosedPositions(user.polymarketProxyAddress).catch(() => []);
  if (fresh.length > 0) closedPositionListCache.set(telegramId, fresh);
  return idx >= 0 && idx < fresh.length ? fresh[idx] : null;
}

// ─── Full list ─────────────────────────────────────────────────────────────

export async function handleOpenPositionsFull(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'common.loading'));
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) return;

    const lang = getLang(user);

    if (!user.polymarketProxyAddress) {
      await sendPage(ctx, t(lang, 'position.noTradingWallet'), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.wallet'), 'wallet_page')]]),
      });
      return;
    }

    const positions = await getActivePositions(user.polymarketProxyAddress);
    positionListCache.set(telegramId, positions);

    if (positions.length === 0) {
      await sendPage(ctx, t(lang, 'position.noActive'), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.back'), 'portfolio_open_1')]]),
      });
      return;
    }

    let message = `📊 *${t(lang, 'All Active Positions')}* (${positions.length})\n\n`;
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      const pnlSign = pos.cashPnl >= 0 ? '+' : '';
      const pnlEmoji = pos.cashPnl >= 0 ? '🟢' : '🔴';
      message += `${i + 1}) *${pos.outcome}* — ${truncate(pos.title, 45)}\n`;
      message += `   💵 ${pos.size.toFixed(2)} ${t(lang, 'shares')} · ${(pos.curPrice * 100).toFixed(1)}¢ · $${pos.currentValue.toFixed(2)}\n`;
      message += `   ${pnlEmoji} P&L: ${pnlSign}$${pos.cashPnl.toFixed(2)} (${pnlSign}${pos.percentPnl.toFixed(1)}%)\n\n`;
      if (message.length > 3800) {
        message += `_... ${t(lang, 'and')} ${positions.length - i - 1} ${t(lang, 'more')}_`;
        break;
      }
    }

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.backToPositions'), 'portfolio_open_1')]]),
    });
  } catch (error) {
    logger.error('Error showing full positions:', error);
  }
}

// ─── View position detail ──────────────────────────────────────────────────

export async function handlePositionView(ctx: Context, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const pos = await getPosOrFetch(telegramId, idx);
    if (!pos) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'position.notFound'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    const pnlSign = pos.cashPnl >= 0 ? '+' : '';
    const pnlEmoji = pos.cashPnl >= 0 ? '🟢' : '🔴';
    const endDate = pos.endDate
      ? new Date(pos.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'N/A';

    let msg = `📊 *${t(lang, 'Position Detail')}*\n\n`;
    msg += `*${pos.outcome}* — ${pos.title}\n\n`;
    msg += `💰 *${t(lang, 'Position')}*\n`;
    msg += `├ ${t(lang, 'Shares')}: ${pos.size.toFixed(4)}\n`;
    msg += `├ ${t(lang, 'Avg Buy Price')}: ${(pos.avgPrice * 100).toFixed(2)}¢\n`;
    msg += `├ ${t(lang, 'Current Price')}: ${(pos.curPrice * 100).toFixed(2)}¢\n`;
    msg += `├ ${t(lang, 'Invested')}: $${pos.initialValue.toFixed(2)}\n`;
    msg += `└ ${t(lang, 'Current Value')}: $${pos.currentValue.toFixed(2)}\n\n`;
    msg += `📈 *P&L*\n`;
    msg += `├ ${pnlEmoji} ${t(lang, 'Unrealized')}: ${pnlSign}$${pos.cashPnl.toFixed(2)}\n`;
    msg += `├ ROI: ${pnlSign}${pos.percentPnl.toFixed(1)}%\n`;
    msg += `└ ${t(lang, 'Realized')}: $${pos.realizedPnl.toFixed(2)}\n\n`;
    msg += `⏰ ${t(lang, 'Market ends')}: ${endDate}\n`;
    if (pos.redeemable) msg += `${t(lang, 'position.marketResolved')}\n`;

    const viewMarketUrl = (pos.eventSlug || pos.slug)
      ? `https://polymarket.com/event/${pos.eventSlug || pos.slug}`
      : '';

    const detailButtons = pos.redeemable
      ? [
          [Markup.button.callback(t(lang, 'btn.redeemIt'), `pos_redeem_${idx}`)],
          [Markup.button.callback(`📊 P&L`, `pos_pnl_${idx}`)],
          ...(viewMarketUrl ? [[Markup.button.url(t(lang, 'btn.viewOnPolymarket'), viewMarketUrl)]] : []),
          [Markup.button.callback(t(lang, 'btn.backToPositions'), 'portfolio_open_1')],
        ]
      : [
          [
            Markup.button.callback(t(lang, 'btn.buyMore'), `pos_buy_${idx}`),
            Markup.button.callback(t(lang, 'btn.sell'), `pos_sell_${idx}`),
          ],
          [Markup.button.callback(`📊 P&L`, `pos_pnl_${idx}`)],
          ...(viewMarketUrl ? [[Markup.button.url(t(lang, 'btn.viewOnPolymarket'), viewMarketUrl)]] : []),
          [Markup.button.callback(t(lang, 'btn.backToPositions'), 'portfolio_open_1')],
        ];

    await sendPage(ctx, msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(detailButtons),
    });
  } catch (error) {
    logger.error('Error showing position view:', error);
  }
}

// ─── Position PNL image ───────────────────────────────────────────────────

export async function handlePositionPnl(ctx: Context, idx: number): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    // Always fetch fresh data on Refresh (callback) — stale cache defeats the purpose
    let pos: ActivePosition | null = null;
    if (ctx.callbackQuery) {
      const user = await getUserByTelegramId(telegramId);
      if (user?.polymarketProxyAddress) {
        const fresh = await getActivePositions(user.polymarketProxyAddress, true).catch(() => []);
        if (fresh.length > 0) positionListCache.set(telegramId, fresh);
        pos = idx >= 0 && idx < fresh.length ? fresh[idx] : null;
      }
    } else {
      pos = await getPosOrFetch(telegramId, idx);
    }

    if (!pos) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'position.notFound'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    // Build sender's referral share URL for Telegram's native share dialog
    let shareUrl = '';
    const telegramIdForShare = ctx.from?.id.toString() ?? telegramId;
    try {
      const senderUser = await getUserByTelegramId(telegramIdForShare);
      if (senderUser) {
        const { ensureReferralCode } = await import('../../services/referral');
        const code = await ensureReferralCode(senderUser.id, senderUser.username ?? undefined);
        const refLink = `https://t.me/${config.telegram.botUsername}?start=ref_${code}`;
        const shareText = encodeURIComponent('🌸 Start winning with PolyTech\n');
        shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${shareText}`;
      }
    } catch { /* proceed without share button */ }

    const marketUrl = (pos.eventSlug || pos.slug)
      ? `https://polymarket.com/event/${pos.eventSlug || pos.slug}`
      : '';

    const pnlKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(`📈 ${t(lang, 'Buy')}`, `pos_buy_${idx}`),
        Markup.button.callback(`📉 ${t(lang, 'Sell')}`, `pos_sell_${idx}`),
      ],
      [
        Markup.button.callback(t(lang, 'btn.refresh'), `pos_pnl_${idx}`),
        ...(shareUrl ? [Markup.button.url(t(lang, 'btn.share'), shareUrl)] : []),
      ],
      ...(marketUrl ? [[Markup.button.url(t(lang, 'btn.viewOnPolymarket'), marketUrl)]] : []),
      [Markup.button.callback(t(lang, 'btn.stopLoss'), `pos_sl_${idx}`)],
      [Markup.button.callback(t(lang, 'btn.back'), `pos_view_${idx}`)],
    ]);

    // Build rich HTML caption
    const pnlDir = pos.cashPnl >= 0 ? ce(EMOJI.pnlUp, '📈') : ce(EMOJI.pnlDown, '📉');
    const pnlSign = pos.cashPnl >= 0 ? '+' : '';
    const pctSign = pos.percentPnl >= 0 ? '+' : '';
    const escTitle = pos.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let caption = `${ce(EMOJI.pnlChart, '📊')} <b>${t(lang, 'Position P&L')}</b>\n\n`;
    caption += `${ce(EMOJI.fire, '🔥')} <b>${pos.outcome}</b> — ${escTitle}\n\n`;
    caption += `${ce(EMOJI.diamond, '💎')} <b>P&amp;L:</b>  ${pnlDir} <b>${pnlSign}$${pos.cashPnl.toFixed(2)}</b>\n`;
    caption += `${ce(EMOJI.rocket, '🚀')} <b>ROI:</b>  ${pctSign}${pos.percentPnl.toFixed(1)}%\n\n`;
    caption += `${ce(EMOJI.target, '🎯')} <b>${t(lang, 'Entry')}:</b>  ${(pos.avgPrice * 100).toFixed(1)}¢\n`;
    caption += `${ce(EMOJI.trophy, '🏆')} <b>${t(lang, 'Current')}:</b>  ${(pos.curPrice * 100).toFixed(1)}¢`;

    // Try image generation
    try {
      const [profilePhotoBuffer, eventIconBuffer] = await Promise.all([
        fetchProfilePhoto(ctx),
        fetchImageBuffer(pos.icon),
      ]);
      const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');

      const imageBuffer = await generatePositionPnlImage({
        title: pos.title,
        outcome: pos.outcome,
        cashPnl: pos.cashPnl,
        percentPnl: pos.percentPnl,
        avgPrice: pos.avgPrice,
        curPrice: pos.curPrice,
        invested: pos.initialValue,
        currentValue: pos.currentValue,
        username: ctx.from?.username,
        displayName,
        profilePhotoBuffer,
        eventIconBuffer,
      });

      if (imageBuffer) {
        await sendImageBufferPage(ctx, imageBuffer, caption, {
          parse_mode: 'HTML',
          ...pnlKeyboard,
        });
        return;
      }
    } catch (imgErr) {
      logger.warn('[pnlImage] Position PNL image generation failed, using text fallback:', imgErr);
    }

    // Text fallback (same rich caption, no image)
    await sendPage(ctx, caption, {
      parse_mode: 'HTML',
      ...pnlKeyboard,
    });
  } catch (error) {
    logger.error('Error in handlePositionPnl:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Failed to generate P&L. Please try again.')}`).catch(() => {});
  }
}

/**
 * Share a position PNL image (forwardable, no keyboard)
 */
export async function handlePositionPnlShare(ctx: Context, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'Generating share image...')).catch(() => {});
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const pos = await getPosOrFetch(telegramId, idx);
    if (!pos) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(`⚠️ ${t(lang, 'Position not found.')}`);
      return;
    }

    const [profilePhotoBuffer, eventIconBuffer] = await Promise.all([
      fetchProfilePhoto(ctx),
      fetchImageBuffer(pos.icon),
    ]);
    const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');

    const imageBuffer = await generatePositionPnlImage({
      title: pos.title,
      outcome: pos.outcome,
      cashPnl: pos.cashPnl,
      percentPnl: pos.percentPnl,
      avgPrice: pos.avgPrice,
      curPrice: pos.curPrice,
      invested: pos.initialValue,
      currentValue: pos.currentValue,
      username: ctx.from?.username,
      displayName,
      profilePhotoBuffer,
      eventIconBuffer,
    });

    if (imageBuffer) {
      // Build sender's referral link for the share caption
      let senderReferralLink = '';
      try {
        const senderUser = await getUserByTelegramId(telegramId);
        if (senderUser) {
          const { ensureReferralCode } = await import('../../services/referral');
          const code = await ensureReferralCode(senderUser.id, senderUser.username ?? undefined);
          senderReferralLink = `https://t.me/${config.telegram.botUsername}?start=ref_${code}`;
        }
      } catch { /* proceed without link */ }

      const shareCaption =
        `${ce(EMOJI.cherry, '🌸')} <b>Start winning with PolyTech</b>\n` +
        (senderReferralLink ? `\n${senderReferralLink}` : '');

      await ctx.replyWithPhoto(
        { source: imageBuffer },
        { caption: shareCaption, parse_mode: 'HTML' },
      );
    } else {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.answerCbQuery(t(lang, 'No PNL templates available yet.'), { show_alert: true });
    }
  } catch (error) {
    logger.error('Error in handlePositionPnlShare:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Failed to generate share image.')}`);
  }
}

// ─── Closed Position PNL ────────────────────────────────────────────────────

export async function handleClosedPositionPnl(ctx: Context, idx: number): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    let pos: ClosedPosition | null = null;
    if (ctx.callbackQuery) {
      const user = await getUserByTelegramId(telegramId);
      if (user?.polymarketProxyAddress) {
        const fresh = await getClosedPositions(user.polymarketProxyAddress, true).catch(() => []);
        if (fresh.length > 0) closedPositionListCache.set(telegramId, fresh);
        pos = idx >= 0 && idx < fresh.length ? fresh[idx] : null;
      }
    } else {
      pos = await getClosedPosOrFetch(telegramId, idx);
    }

    if (!pos) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'position.notFound'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    // Compute derived fields from closed position data
    const invested = pos.totalBought * pos.avgPrice;
    const received = invested + pos.realizedPnl;
    const percentPnl = invested > 0 ? (pos.realizedPnl / invested) * 100 : 0;
    const exitPrice = pos.totalBought > 0 ? received / pos.totalBought : 0;

    // Build referral share URL
    let shareUrl = '';
    try {
      const senderUser = await getUserByTelegramId(telegramId);
      if (senderUser) {
        const { ensureReferralCode } = await import('../../services/referral');
        const code = await ensureReferralCode(senderUser.id, senderUser.username ?? undefined);
        const refLink = `https://t.me/${config.telegram.botUsername}?start=ref_${code}`;
        const shareText = encodeURIComponent('🌸 Start winning with PolyTech\n');
        shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${shareText}`;
      }
    } catch { /* proceed without share button */ }

    const marketUrl = (pos.eventSlug || pos.slug)
      ? `https://polymarket.com/event/${pos.eventSlug || pos.slug}`
      : '';

    const pnlKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(t(lang, 'btn.refresh'), `cp_pnl_${idx}`),
        ...(shareUrl ? [Markup.button.url(t(lang, 'btn.share'), shareUrl)] : []),
      ],
      ...(marketUrl ? [[Markup.button.url(t(lang, 'btn.viewOnPolymarket'), marketUrl)]] : []),
      [Markup.button.callback(`« ${t(lang, 'Back to Closed Positions')}`, 'portfolio_closed_1')],
    ]);

    // Build rich HTML caption
    const pnlDir = pos.realizedPnl >= 0 ? ce(EMOJI.pnlUp, '📈') : ce(EMOJI.pnlDown, '📉');
    const pnlSign = pos.realizedPnl >= 0 ? '+' : '';
    const pctSign = percentPnl >= 0 ? '+' : '';
    const escTitle = pos.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let caption = `${ce(EMOJI.pnlChart, '📊')} <b>${t(lang, 'Closed Position P&L')}</b>\n\n`;
    caption += `${ce(EMOJI.fire, '🔥')} <b>${pos.outcome}</b> — ${escTitle}\n\n`;
    caption += `${ce(EMOJI.diamond, '💎')} <b>Realized P&amp;L:</b>  ${pnlDir} <b>${pnlSign}$${pos.realizedPnl.toFixed(2)}</b>\n`;
    caption += `${ce(EMOJI.rocket, '🚀')} <b>ROI:</b>  ${pctSign}${percentPnl.toFixed(1)}%\n\n`;
    caption += `${ce(EMOJI.target, '🎯')} <b>${t(lang, 'Entry')}:</b>  ${(pos.avgPrice * 100).toFixed(1)}¢\n`;
    caption += `${ce(EMOJI.trophy, '🏆')} <b>${t(lang, 'Exit')}:</b>  ${(exitPrice * 100).toFixed(1)}¢\n\n`;
    caption += `💰 <b>${t(lang, 'Invested')}:</b> $${invested.toFixed(2)}\n`;
    caption += `📦 <b>${t(lang, 'Received')}:</b> $${received.toFixed(2)}\n`;
    caption += `📊 <b>${t(lang, 'shares')}:</b> ${pos.totalBought.toFixed(2)}`;

    // Try image generation
    try {
      const [profilePhotoBuffer, eventIconBuffer] = await Promise.all([
        fetchProfilePhoto(ctx),
        fetchImageBuffer(pos.icon),
      ]);
      const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');

      const imageBuffer = await generatePositionPnlImage({
        title: pos.title,
        outcome: pos.outcome,
        cashPnl: pos.realizedPnl,
        percentPnl,
        avgPrice: pos.avgPrice,
        curPrice: exitPrice,
        invested,
        currentValue: received,
        username: ctx.from?.username,
        displayName,
        profilePhotoBuffer,
        eventIconBuffer,
      });

      if (imageBuffer) {
        await sendImageBufferPage(ctx, imageBuffer, caption, {
          parse_mode: 'HTML',
          ...pnlKeyboard,
        });
        return;
      }
    } catch (imgErr) {
      logger.warn('[pnlImage] Closed position PNL image generation failed, using text fallback:', imgErr);
    }

    // Text fallback
    await sendPage(ctx, caption, {
      parse_mode: 'HTML',
      ...pnlKeyboard,
    });
  } catch (error) {
    logger.error('Error in handleClosedPositionPnl:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Failed to generate P&L. Please try again.')}`).catch(() => {});
  }
}

/**
 * Share a closed position PNL image (forwardable, no keyboard)
 */
export async function handleClosedPositionPnlShare(ctx: Context, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'Generating share image...')).catch(() => {});
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const pos = await getClosedPosOrFetch(telegramId, idx);
    if (!pos) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(`⚠️ ${t(lang, 'Position not found.')}`);
      return;
    }

    const invested = pos.totalBought * pos.avgPrice;
    const received = invested + pos.realizedPnl;
    const percentPnl = invested > 0 ? (pos.realizedPnl / invested) * 100 : 0;
    const exitPrice = pos.totalBought > 0 ? received / pos.totalBought : 0;

    const [profilePhotoBuffer, eventIconBuffer] = await Promise.all([
      fetchProfilePhoto(ctx),
      fetchImageBuffer(pos.icon),
    ]);
    const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');

    const imageBuffer = await generatePositionPnlImage({
      title: pos.title,
      outcome: pos.outcome,
      cashPnl: pos.realizedPnl,
      percentPnl,
      avgPrice: pos.avgPrice,
      curPrice: exitPrice,
      invested,
      currentValue: received,
      username: ctx.from?.username,
      displayName,
      profilePhotoBuffer,
      eventIconBuffer,
    });

    if (imageBuffer) {
      let senderReferralLink = '';
      try {
        const senderUser = await getUserByTelegramId(telegramId);
        if (senderUser) {
          const { ensureReferralCode } = await import('../../services/referral');
          const code = await ensureReferralCode(senderUser.id, senderUser.username ?? undefined);
          senderReferralLink = `https://t.me/${config.telegram.botUsername}?start=ref_${code}`;
        }
      } catch { /* proceed without link */ }

      const shareCaption =
        `${ce(EMOJI.cherry, '🌸')} <b>Start winning with PolyTech</b>\n` +
        (senderReferralLink ? `\n${senderReferralLink}` : '');

      await ctx.replyWithPhoto(
        { source: imageBuffer },
        { caption: shareCaption, parse_mode: 'HTML' },
      );
    } else {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.answerCbQuery(t(lang, 'No PNL templates available yet.'), { show_alert: true });
    }
  } catch (error) {
    logger.error('Error in handleClosedPositionPnlShare:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Failed to generate share image.')}`);
  }
}

// ─── Sell flow ─────────────────────────────────────────────────────────────

export async function handlePositionSell(ctx: Context, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const pos = await getPosOrFetch(telegramId, idx);
    if (!pos) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'position.notFound'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    // Redeemable positions (resolved markets) can't be sold — they need to be claimed
    if (pos.redeemable) {
      await ctx.reply(
        `✅ *${t(lang, 'Market Resolved')}*\n\n*${pos.outcome}* — ${truncate(pos.title, 50)}\n\n` +
        t(lang, 'This market has resolved. Use the Redeem button to claim your USDC.'),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'btn.redeemIt'), `pos_redeem_${idx}`)],
            [Markup.button.callback(t(lang, 'btn.backToPositions'), 'portfolio_open_1')],
          ]),
        }
      );
      return;
    }

    positionTradeState.set(telegramId, {
      action: 'sell',
      assetId: pos.asset,
      conditionId: pos.conditionId,
      negRisk: pos.negativeRisk,
      title: pos.title,
      outcome: pos.outcome,
      currentSize: pos.size,
      curPrice: pos.curPrice,
      step: 'awaiting_price_size',
      timestamp: Date.now(),
    });

    const curCents = (pos.curPrice * 100).toFixed(1);
    const msg =
      `📉 *${t(lang, 'Sell Position')}*\n\n` +
      `*${pos.outcome}* — ${truncate(pos.title, 50)}\n\n` +
      `${t(lang, 'You hold')}: *${pos.size.toFixed(4)} ${t(lang, 'shares')}* @ ${t(lang, 'avg')} ${(pos.avgPrice * 100).toFixed(1)}¢\n` +
      `${t(lang, 'Current price')}: *${curCents}¢*  ·  ${t(lang, 'Value')}: *$${pos.currentValue.toFixed(2)}*\n\n` +
      `*${t(lang, 'Enter number of shares to sell')}:*\n` +
      `${t(lang, 'Example')}: \`${pos.size.toFixed(2)}\` (${t(lang, 'sell all')})\n\n` +
      `${t(lang, 'Or choose a quick amount')}:`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('25%', `pos_pct_${idx}_25`),
          Markup.button.callback('50%', `pos_pct_${idx}_50`),
          Markup.button.callback('75%', `pos_pct_${idx}_75`),
          Markup.button.callback('100%', `pos_pct_${idx}_100`),
        ],
        [Markup.button.callback(t(lang, 'btn.cancel'), 'pos_cancel')],
      ]),
    });
  } catch (error) {
    logger.error('Error starting sell flow:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'Could not start sell flow. Please try again.')}`).catch(() => {});
  }
}

// ─── Manual redeem flow ───────────────────────────────────────────────────

export async function handlePositionRedeem(ctx: Context, idx: number): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'Claiming...')).catch(() => {});
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const pos = await getPosOrFetch(telegramId, idx);
    if (!pos) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'position.notFound'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    if (!pos.redeemable) {
      await ctx.reply(`⚠️ ${t(lang, 'This position is not redeemable yet. The market has not resolved.')}`);
      return;
    }

    if (!user || !user.polymarketProxyAddress) {
      await ctx.reply(t(lang, 'common.userNotFoundShort'));
      return;
    }

    // Show claiming in progress
    const loadingMsg = await ctx.reply(
      `${ce(EMOJI.loading, '⏳')} <b>${t(lang, 'Claiming position...')}</b>\n\n<b>${esc(pos.outcome)}</b> — ${esc(truncate(pos.title, 50))}\n\n<i>${t(lang, 'This may take up to 60 seconds.')}</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => null);

    const { manualRedeem } = await import('../../services/redeem');
    const result = await manualRedeem(
      user.encryptedPrivateKey,
      user.polymarketProxyAddress,
      pos,
      user.predexonUserId ?? undefined,
    );

    // Delete loading message
    if (loadingMsg) await ctx.telegram.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id).catch(() => {});

    if (result.success) {
      // Invalidate caches
      positionListCache.delete(telegramId);
      const { invalidatePortfolioCache } = await import('../../services/portfolio');
      await invalidatePortfolioCache(user.polymarketProxyAddress);

      const truncTitle = pos.title.length > 50 ? pos.title.slice(0, 50) + '…' : pos.title;
      await ctx.reply(
        `✅ *${t(lang, 'Position Claimed!')}*\n\n` +
        `*${pos.outcome}* — ${truncTitle}\n\n` +
        `💵 ${t(lang, 'USDC.e has been returned to your wallet.')}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`📊 ${t(lang, 'My Positions')}`, 'portfolio_open_1')],
            [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
          ]),
        }
      );
    } else {
      const isRateLimited = result.error && /rate.?limit|unavailable|quota/i.test(result.error);
      const userError = isRateLimited
        ? t(lang, 'The claiming service is temporarily busy. Your position is safe — please try again later.')
        : (result.error || t(lang, 'Unknown error'));
      await ctx.reply(
        `❌ *${t(lang, 'Claim Failed')}*\n\n` +
        `*${pos.outcome}* — ${truncate(pos.title, 50)}\n\n` +
        `${userError}\n\n_${isRateLimited ? '' : t(lang, 'Please try again.')}_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'btn.tryAgain'), `pos_redeem_${idx}`)],
            [Markup.button.callback(t(lang, 'btn.backToPositions'), 'portfolio_open_1')],
          ]),
        }
      );
    }
  } catch (error) {
    logger.error('Error in manual redeem:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(`❌ ${t(lang, 'An error occurred while claiming. Please try again.')}`, {
      ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.backToPositions'), 'portfolio_open_1')]]),
    }).catch(() => {});
  }
}

// ─── Buy flow ──────────────────────────────────────────────────────────────

export async function handlePositionBuy(ctx: Context, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const pos = await getPosOrFetch(telegramId, idx);
    if (!pos) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'position.notFound'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    positionTradeState.set(telegramId, {
      action: 'buy',
      assetId: pos.asset,
      conditionId: pos.conditionId,
      negRisk: pos.negativeRisk,
      title: pos.title,
      outcome: pos.outcome,
      currentSize: pos.size,
      curPrice: pos.curPrice,
      step: 'awaiting_price_size',
      timestamp: Date.now(),
    });

    // Fetch balance for display
    const balanceStr = user
      ? await getBalance(user.encryptedPrivateKey, user.encryptedApiKey, user.encryptedApiSecret, user.encryptedPassphrase, user.predexonUserId ?? undefined).catch(() => '0.00')
      : '0.00';

    const curCents = (pos.curPrice * 100).toFixed(1);
    const estimatedShares = (10 / pos.curPrice).toFixed(1);
    const msg =
      `📈 *${t(lang, 'Buy More')}*\n\n` +
      `*${pos.outcome}* — ${truncate(pos.title, 50)}\n\n` +
      `${t(lang, 'You already hold')}: *${pos.size.toFixed(4)} ${t(lang, 'shares')}*\n` +
      `${t(lang, 'Current price')}: *${curCents}¢*\n` +
      `💼 ${t(lang, 'Balance')}: *$${balanceStr}*\n\n` +
      `*${t(lang, 'Enter USDC amount to spend')}:*\n` +
      `${t(lang, 'Example')}: \`10\` → ${t(lang, 'buys')} ~${estimatedShares} ${t(lang, 'shares')} ${t(lang, 'at')} ${curCents}¢`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.cancel'), 'pos_cancel')]]),
    });
  } catch (error) {
    logger.error('Error starting buy flow:', error);
  }
}

// ─── Stop Loss flow ────────────────────────────────────────────────────────

export async function handlePositionStopLoss(ctx: Context, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const pos = await getPosOrFetch(telegramId, idx);
    if (!pos) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'position.notFound'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    positionTradeState.set(telegramId, {
      action: 'stop_loss',
      assetId: pos.asset,
      conditionId: pos.conditionId,
      negRisk: pos.negativeRisk,
      title: pos.title,
      outcome: pos.outcome,
      currentSize: pos.size,
      curPrice: pos.curPrice,
      step: 'awaiting_sl_price',
      timestamp: Date.now(),
    });

    const curCents = (pos.curPrice * 100).toFixed(1);
    const suggestSl = ((pos.curPrice * 0.8) * 100).toFixed(0); // 20% below as example

    const msg =
      `🛑 *${t(lang, 'Stop Loss')}*\n\n` +
      `*${pos.outcome}* — ${truncate(pos.title, 50)}\n\n` +
      `${t(lang, 'You hold')}: *${pos.size.toFixed(4)} ${t(lang, 'shares')}*\n` +
      `${t(lang, 'Current price')}: *${curCents}¢*\n\n` +
      `${t(lang, 'Enter the stop loss price in cents (must be below current price).')}` + `\n` +
      `${t(lang, 'A GTC limit sell order will be placed for all your shares.')}\n\n` +
      `${t(lang, 'Example')}: \`${suggestSl}\` → ${t(lang, 'sells at')} ${suggestSl}¢`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.cancel'), 'pos_cancel')]]),
    });
  } catch (error) {
    logger.error('Error starting stop loss flow:', error);
  }
}

async function showStopLossConfirmation(
  ctx: Context,
  telegramId: string,
  state: PositionTradeState,
  slPrice: number,
): Promise<void> {
  const user = await getUserByTelegramId(telegramId);
  const lang = getLang(user);

  positionTradeState.set(telegramId, { ...state, price: slPrice, timestamp: Date.now() });

  const slCents   = (slPrice * 100).toFixed(1);
  const curCents  = (state.curPrice * 100).toFixed(1);
  const estValue  = (state.currentSize * slPrice).toFixed(2);
  const dropPct   = (((state.curPrice - slPrice) / state.curPrice) * 100).toFixed(1);

  const msg =
    `🛑 *${t(lang, 'Stop Loss Confirmation')}*\n\n` +
    `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
    `📦 ${t(lang, 'Shares to sell')}: *${state.currentSize.toFixed(4)}*\n` +
    `📊 ${t(lang, 'Current price')}: *${curCents}¢*\n` +
    `🎯 ${t(lang, 'Stop loss price')}: *${slCents}¢* (${dropPct}% ${t(lang, 'below')})\n` +
    `💰 ${t(lang, 'Est. proceeds')}: ~$${estValue}\n\n` +
    `_${t(lang, 'A GTC limit SELL order will be placed at')} ${slCents}¢._\n` +
    `_${t(lang, 'It will fill automatically when the price drops to this level.')}_`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(`✅ ${t(lang, 'Place Stop Loss')}`, 'pos_execute_sl'),
        Markup.button.callback(t(lang, 'btn.cancel'), 'pos_cancel'),
      ],
    ]),
  });
}

export async function handlePositionExecuteStopLoss(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  await ctx.answerCbQuery(t(((ctx as any).userLanguage as Locale) || 'en', 'Placing stop loss...')).catch(() => {});

  const state = await positionTradeState.get(telegramId);
  if (!state || state.action !== 'stop_loss' || !state.price) {
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(t(lang, 'common.sessionExpired')).catch(() => {});
    return;
  }
  positionTradeState.delete(telegramId);

  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user?.polymarketProxyAddress) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(`❌ ${t(lang, 'Trading wallet not set up.')}`).catch(() => {});
      return;
    }

    const lang = getLang(user);

    const { ensurePredexonUser } = await import('../../services/user');
    const { placeOrder: predexonPlaceOrder } = await import('../../services/predexon');

    const predexonUserId = await ensurePredexonUser(user);

    // Snap price to 0.01 tick
    const tick       = 0.01;
    const snappedPrice = parseFloat(Math.max(Math.round(state.price / tick) * tick, 0.01).toFixed(2));
    const shares     = Math.floor(state.currentSize * 10000) / 10000;

    logger.info(
      `[stopLoss] Placing GTC SELL: ${shares} shares of ${state.outcome} ` +
      `assetId=${state.assetId.substring(0, 16)}... price=${snappedPrice}`
    );

    const orderResp = await predexonPlaceOrder(predexonUserId, {
      venue: 'polymarket',
      tokenId: state.assetId,
      side: 'sell',
      type: 'limit',
      size: String(shares),
      price: String(snappedPrice),
    });

    if (!orderResp.orderId) {
      const errMsg = (orderResp as any).error || (orderResp as any).message || 'Order rejected by exchange';
      throw new Error(errMsg);
    }

    const slCents = (snappedPrice * 100).toFixed(1);
    await ctx.reply(
      `✅ *${t(lang, 'Stop Loss Placed')}*\n\n` +
      `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
      `🛑 ${t(lang, 'Trigger price')}: *${slCents}¢*\n` +
      `📦 ${t(lang, 'Shares')}: *${shares}*\n\n` +
      `_${t(lang, 'GTC limit sell order resting on the book. Cancel it from Open Orders if needed.')}_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.openOrders'), 'portfolio_orders_1')],
          [Markup.button.callback(`📊 ${t(lang, 'My Positions')}`, 'portfolio_open_1')],
          [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
        ]),
      },
    ).catch(() => {});

    logger.info(
      `[stopLoss] Placed: user=${telegramId} outcome=${state.outcome} price=${snappedPrice} shares=${shares} orderId=${orderResp.orderId}`
    );
  } catch (error: any) {
    logger.error('[stopLoss] Error executing stop loss:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(
      `❌ *${t(lang, 'Stop Loss Failed')}*\n\n${error?.message || t(lang, 'Unknown error')}\n\n${t(lang, 'Please try again.')}`,
      { parse_mode: 'Markdown' },
    ).catch(() => {});
  }
}

// ─── Quick % sell ──────────────────────────────────────────────────────────

export async function handlePositionSellPct(ctx: Context, idx: number, pct: number): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    let state = await positionTradeState.get(telegramId);
    let pos = getPos(telegramId, idx);

    // If either is missing, rebuild from a fresh position fetch
    if (!state || !pos) {
      pos = await getPosOrFetch(telegramId, idx);
      if (!pos) {
        const lang = ((ctx as any).userLanguage as Locale) || 'en';
        await ctx.answerCbQuery(`⚠️ ${t(lang, 'Position not found. Please refresh.')}`, { show_alert: true });
        return;
      }
      state = {
        action: 'sell',
        assetId: pos.asset,
        conditionId: pos.conditionId,
        negRisk: pos.negativeRisk,
        title: pos.title,
        outcome: pos.outcome,
        currentSize: pos.size,
        curPrice: pos.curPrice,
        step: 'awaiting_price_size',
        timestamp: Date.now(),
      };
      positionTradeState.set(telegramId, state);
    }

    // Floor to 2 decimals — never sell more shares than the user owns
    const shares = Math.floor((pos.size * pct) / 100 * 100) / 100;

    if (shares < MIN_ORDER_SIZE) {
      const minPct = Math.ceil((MIN_ORDER_SIZE / pos.size) * 100);
      await ctx.answerCbQuery(
        `❌ Min order: ${MIN_ORDER_SIZE} shares. ${pct}% = ${shares.toFixed(2)} shares. Try ${minPct}%+.`,
        { show_alert: true }
      );
      return;
    }

    await ctx.answerCbQuery();

    // F2: Apply slippage floor to SELL
    const { getUserByTelegramId: getUser } = await import('../../services/user');
    const sellUser = await getUser(telegramId);
    const slippagePct = sellUser?.slippageTolerance ?? 1.0;
    const price = Math.max(pos.curPrice * (1 - slippagePct / 100), 0.01);

    // Refresh timestamp so the 10-min cleanup interval doesn't delete state
    // between the % click and the confirm button press
    positionTradeState.set(telegramId, { ...state, timestamp: Date.now() });

    await showSellConfirmation(ctx, telegramId, state, price, shares);
  } catch (error) {
    logger.error('Error in quick pct sell:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    try { await ctx.answerCbQuery(`❌ ${t(lang, 'An error occurred. Please try again.')}`, { show_alert: true }); } catch {}
  }
}

// ─── Text input handler ────────────────────────────────────────────────────

export async function handlePositionTradeInput(ctx: Context, text: string): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const state = await positionTradeState.get(telegramId);
  if (!state) return;

  const user = await getUserByTelegramId(telegramId);
  const lang = getLang(user);

  if (Date.now() - state.timestamp > 10 * 60 * 1000) {
    positionTradeState.delete(telegramId);
    await ctx.reply(t(lang, 'common.sessionExpired'));
    return;
  }

  const val = parseFloat(text.trim().replace(/[^0-9.,]/g, '').replace(',', '.'));

  if (isNaN(val) || val <= 0) {
    await ctx.reply(
      state.action === 'sell'
        ? `❌ ${t(lang, 'Enter the number of shares to sell. Example:')} \`7.5\``
        : state.action === 'stop_loss'
        ? `❌ ${t(lang, 'Enter the stop loss price in cents. Example:')} \`35\` ${t(lang, 'for')} 35¢`
        : `❌ ${t(lang, 'Enter the USDC amount to spend. Example:')} \`10\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (state.action === 'stop_loss') {
    // val is in cents (e.g. 35 = 35¢ = 0.35)
    const slPrice = val > 1 ? val / 100 : val; // support both 35 and 0.35
    if (slPrice >= state.curPrice) {
      await ctx.reply(
        `❌ ${t(lang, 'Stop loss price must be below current price.')}\n\n` +
        `${t(lang, 'Current')}: *${(state.curPrice * 100).toFixed(1)}¢*\n${t(lang, 'You entered')}: *${(slPrice * 100).toFixed(1)}¢*`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    if (slPrice < 0.01) {
      await ctx.reply(`❌ ${t(lang, 'Minimum price is 1¢.')}`, { parse_mode: 'Markdown' });
      return;
    }
    await showStopLossConfirmation(ctx, telegramId, state, slPrice);
    return;
  }

  if (state.action === 'sell') {
    // Floor to 4 decimals — never sell more than owned
    const shares = Math.floor(val * 10000) / 10000;
    if (shares > state.currentSize * 1.001) {
      await ctx.reply(`❌ ${t(lang, 'You only have')} ${state.currentSize.toFixed(4)} ${t(lang, 'shares')}. ${t(lang, 'Cannot sell')} ${shares}.`);
      return;
    }
    if (shares < MIN_ORDER_SIZE) {
      await ctx.reply(
        `❌ ${t(lang, 'Minimum order size is')} *${MIN_ORDER_SIZE} ${t(lang, 'shares')}*. ${t(lang, 'You entered')} ${shares.toFixed(4)} ${t(lang, 'shares')}.\n\n` +
        `${t(lang, 'Your position')}: ${state.currentSize.toFixed(4)} ${t(lang, 'shares')} — ${t(lang, 'enter at least')} ${MIN_ORDER_SIZE}.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    // F2: Apply slippage floor to SELL (mirrors BUY path above)
    const { getUserByTelegramId: getUser } = await import('../../services/user');
    const sellUser = await getUser(telegramId);
    const slippagePct = sellUser?.slippageTolerance ?? 1.0;
    const price = Math.max(state.curPrice * (1 - slippagePct / 100), 0.01);
    await showSellConfirmation(ctx, telegramId, state, price, Math.min(shares, state.currentSize));
  } else {
    // Buy: val is dollar amount; derive worst price from market price + user slippage
    const usdAmount = val;
    const { getUserByTelegramId: getUser } = await import('../../services/user');
    const buyUser = await getUser(telegramId);
    const slippagePct  = buyUser?.slippageTolerance ?? 1.0;
    const slippageMult = 1 + slippagePct / 100;
    const price = Math.min(state.curPrice * slippageMult, 0.99);
    const estimatedShares = usdAmount / price;
    if (estimatedShares < MIN_ORDER_SIZE) {
      const minUsd = (MIN_ORDER_SIZE * price).toFixed(2);
      await ctx.reply(
        `❌ ${t(lang, 'Minimum order size is')} *${MIN_ORDER_SIZE} ${t(lang, 'shares')}*. ${t(lang, 'At')} ${(state.curPrice * 100).toFixed(1)}¢, ${t(lang, 'you need at least')} *$${minUsd}*.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    await showBuyConfirmation(ctx, telegramId, state, price, usdAmount, slippagePct);
  }
}

// ─── Confirmation messages ─────────────────────────────────────────────────

async function showSellConfirmation(
  ctx: Context,
  telegramId: string,
  state: PositionTradeState,
  price: number,
  shares: number
): Promise<void> {
  const user = await getUserByTelegramId(telegramId);
  const lang = getLang(user);

  positionTradeState.set(telegramId, { ...state, price, size: shares });

  const estProceeds = shares * price;
  const commissionAmt = estProceeds * COMMISSION_RATE;
  const netProceeds = estProceeds - commissionAmt;

  const msg =
    `⚠️ *${t(lang, 'Confirm SELL Order')}*\n\n` +
    `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
    `📉 ${t(lang, 'Sell')}: *${shares.toFixed(4)} ${t(lang, 'shares')}*\n` +
    `💰 ${t(lang, 'Min price')}: *${(price * 100).toFixed(2)}¢*\n` +
    `💵 ${t(lang, 'Est. proceeds')}: *$${estProceeds.toFixed(2)}*\n` +
    `📊 ${t(lang, 'Platform fee')} (1%): *-$${commissionAmt.toFixed(2)}*\n` +
    `💰 ${t(lang, 'Net to wallet')}: *$${netProceeds.toFixed(2)}*\n\n` +
    `_${t(lang, 'Market order — executes immediately at the best available price.')}_`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(`✅ ${t(lang, 'Confirm Sell')}`, 'pos_execute_sell'),
        Markup.button.callback(t(lang, 'btn.cancel'), 'pos_cancel'),
      ],
    ]),
  });
}

async function showBuyConfirmation(
  ctx: Context,
  telegramId: string,
  state: PositionTradeState,
  price: number,
  usdAmount: number,
  slippagePct: number = 1.0
): Promise<void> {
  const user = await getUserByTelegramId(telegramId);
  const lang = getLang(user);

  const commissionAmt = usdAmount * COMMISSION_RATE;
  const tradeAmount = usdAmount - commissionAmt;

  if (tradeAmount < 1.0) {
    await ctx.reply(
      `❌ *${t(lang, 'Minimum order is $1.00')}*\n\n${t(lang, 'After the 1% platform fee, your trade amount would be')} $${tradeAmount.toFixed(2)}. ${t(lang, 'Please enter at least')} $1.02.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const shares = parseFloat((tradeAmount / price).toFixed(4));
  positionTradeState.set(telegramId, { ...state, price, size: shares });

  const msg =
    `⚠️ *${t(lang, 'Confirm BUY Order')}*\n\n` +
    `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
    `📈 ${t(lang, 'Buy')}: *~${shares.toFixed(4)} ${t(lang, 'shares')}*\n` +
    `💰 ${t(lang, 'Max price')}: *${(price * 100).toFixed(2)}¢* (${t(lang, 'slippage')}: ${slippagePct}%)\n` +
    `💵 ${t(lang, 'Total')}: *$${usdAmount.toFixed(2)}*\n` +
    `📊 ${t(lang, 'Platform fee')} (1%): *-$${commissionAmt.toFixed(2)}*\n` +
    `💰 ${t(lang, 'Trade amount')}: *$${tradeAmount.toFixed(2)}*\n\n` +
    `_${t(lang, 'FAK market order — fills immediately at best available ask.')}_`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(`✅ ${t(lang, 'Confirm Buy')}`, 'pos_execute_buy'),
        Markup.button.callback(t(lang, 'btn.cancel'), 'pos_cancel'),
      ],
    ]),
  });
}

// ─── Cancel ────────────────────────────────────────────────────────────────

export async function handlePositionCancel(ctx: Context): Promise<void> {
  try {
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.answerCbQuery(t(lang, 'Cancelled'));
    const telegramId = ctx.from?.id.toString();
    if (telegramId) positionTradeState.delete(telegramId);

    const keyboard = Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.backToPositions'), 'portfolio_open_1')]]);
    try {
      await ctx.editMessageText(`❌ ${t(lang, 'Trade cancelled.')}`, { ...keyboard });
    } catch {
      await ctx.reply(`❌ ${t(lang, 'Trade cancelled.')}`, { ...keyboard });
    }
  } catch (error) {
    logger.error('Error cancelling position trade:', error);
  }
}

// ─── Execute sell ──────────────────────────────────────────────────────────

export async function handlePositionExecuteSell(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const state = await positionTradeState.get(telegramId);
    if (!state || state.price === undefined || state.size === undefined) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'common.sessionExpired'), {
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.back'), 'portfolio_open_1')]]),
      });
      return;
    }
    positionTradeState.delete(telegramId);

    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    try { await ctx.editMessageText(ce(EMOJI.loading, '⏳') + ` ${t(lang, 'Placing sell order...')}`, { parse_mode: 'HTML' }); } catch { await ctx.reply(ce(EMOJI.loading, '⏳') + ` ${t(lang, 'Placing sell order...')}`, { parse_mode: 'HTML' }); }

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply(t(lang, 'common.userNotFoundShort')); return; }

    const userLang = getLang(user);

    try {
      // Grab pos from cache BEFORE deleting it (needed for PNL card avgPrice)
      const cachedList = positionListCache.get(telegramId) ?? [];
      const soldPos = cachedList.find(p => p.asset === state.assetId) ?? null;

      const result = await executePositionOrder(user, state.assetId, state.conditionId, state.negRisk, 'sell', state.price, state.size);

      // Invalidate caches so next positions view is fresh
      positionListCache.delete(telegramId);
      try {
        const { invalidatePortfolioCache } = await import('../../services/portfolio');
        await invalidatePortfolioCache(user.polymarketProxyAddress ?? '');
      } catch {}

      const doneKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`📊 ${t(userLang, 'My Positions')}`, 'portfolio_open_1')],
        [Markup.button.callback(t(userLang, 'btn.mainMenu'), 'back_to_menu')],
      ]);

      const sellSize  = state.size!;
      const sellPrice = state.price!;
      const buildSellMsg = (txLine: string) =>
        `✅ *${t(userLang, 'Sell Executed!')}*\n\n` +
        `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
        `📉 ${t(userLang, 'Shares')}: *${sellSize.toFixed(4)}*\n` +
        `💰 ${t(userLang, 'Min price')}: *${(sellPrice * 100).toFixed(2)}¢*\n` +
        `💵 ${t(userLang, 'Est. proceeds')}: *$${(sellSize * sellPrice).toFixed(2)}*\n` +
        txLine +
        `_${t(userLang, 'Market sell executed — your position has been closed or reduced.')}_`;

      let sentMsg: any;
      try {
        sentMsg = await ctx.editMessageText(buildSellMsg(`🔗 ${t(userLang, 'Transaction Hash')}: _${t(userLang, 'fetching...')}_\n`), { parse_mode: 'Markdown', ...doneKeyboard });
      } catch {
        sentMsg = await ctx.reply(buildSellMsg(`🔗 ${t(userLang, 'Transaction Hash')}: _${t(userLang, 'fetching...')}_\n`), { parse_mode: 'Markdown', ...doneKeyboard });
      }

      // Fire-and-forget: fetch on-chain tx hash and update message
      if (user.polymarketProxyAddress) {
        const proxyAddr = user.polymarketProxyAddress;
        const assetId   = state.assetId;
        const placedAt  = Date.now() - 5_000;
        const chatId    = ctx.chat?.id;
        const msgId     = sentMsg?.message_id;
        if (chatId && msgId) {
          (async () => {
            try {
              const txHash = await fetchTxHashForOrder(proxyAddr, assetId, placedAt);
              const txLine = txHash
                ? `🔗 [${t(userLang, 'Transaction Hash')}](https://polygonscan.com/tx/${txHash})\n`
                : ``;
              await ctx.telegram.editMessageText(
                chatId, msgId, undefined,
                buildSellMsg(txLine),
                { parse_mode: 'Markdown', ...doneKeyboard },
              );
            } catch {
              // Non-fatal
            }
          })();
        }
      }

      // Fire-and-forget: send PNL card after successful sell
      if (soldPos) {
        (async () => {
          try {
            const avgPrice = soldPos.avgPrice ?? 0;
            const invested = state.size! * avgPrice;
            const proceeds = state.size! * state.price!;
            const cashPnl = proceeds - invested;
            const percentPnl = invested > 0 ? (cashPnl / invested) * 100 : 0;

            const profilePhotoBuffer = await fetchProfilePhoto(ctx).catch(() => undefined);

            const imgBuffer = await generatePositionPnlImage({
              title: state.title,
              outcome: state.outcome,
              cashPnl,
              percentPnl,
              avgPrice,
              curPrice: state.price!,
              invested,
              currentValue: proceeds,
              username: ctx.from?.username,
              displayName: ctx.from?.first_name,
              profilePhotoBuffer,
            });

            if (imgBuffer) {
              await ctx.replyWithPhoto(
                { source: imgBuffer },
                { caption: `${cashPnl >= 0 ? '🟢' : '🔴'} <b>${t(userLang, 'Realized P&L')}: ${cashPnl >= 0 ? '+' : ''}$${cashPnl.toFixed(2)}</b>`, parse_mode: 'HTML' }
              );
            }
          } catch (pnlErr) {
            logger.warn('[positionTrade] PNL card after sell failed (non-fatal):', pnlErr);
          }
        })();
      }
    } catch (err: any) {
      logger.error('[positionTrade] Sell failed:', err);
      const classified = classifyOrderError(err, 'sell');
      const errKeyboard = Markup.inlineKeyboard([[Markup.button.callback(t(userLang, 'btn.back'), 'portfolio_open_1')]]);
      const errMsg = `❌ *${t(userLang, 'Sell Failed')}*\n\n${classified.message}`;
      try {
        await ctx.editMessageText(errMsg, { parse_mode: 'Markdown', ...errKeyboard });
      } catch {
        await ctx.reply(errMsg, { parse_mode: 'Markdown', ...errKeyboard });
      }
    }
  } catch (error) {
    logger.error('Error executing sell:', error);
  }
}

// ─── Execute buy ───────────────────────────────────────────────────────────

export async function handlePositionExecuteBuy(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const state = await positionTradeState.get(telegramId);
    if (!state || state.price === undefined || state.size === undefined) {
      const lang = ((ctx as any).userLanguage as Locale) || 'en';
      await ctx.reply(t(lang, 'common.sessionExpired'), {
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.back'), 'portfolio_open_1')]]),
      });
      return;
    }
    positionTradeState.delete(telegramId);

    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    try { await ctx.editMessageText(ce(EMOJI.loading, '⏳') + ` ${t(lang, 'Placing buy order...')}`, { parse_mode: 'HTML' }); } catch { await ctx.reply(ce(EMOJI.loading, '⏳') + ` ${t(lang, 'Placing buy order...')}`, { parse_mode: 'HTML' }); }

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply(t(lang, 'common.userNotFoundShort')); return; }

    const userLang = getLang(user);

    try {
      const result = await executePositionOrder(user, state.assetId, state.conditionId, state.negRisk, 'buy', state.price, state.size);

      // Invalidate caches so next positions view is fresh
      positionListCache.delete(telegramId);
      try {
        const { invalidatePortfolioCache } = await import('../../services/portfolio');
        await invalidatePortfolioCache(user.polymarketProxyAddress ?? '');
      } catch {}

      const buySize   = state.size!;
      const buyPrice  = state.price!;
      const usdAmount = buySize * buyPrice;

      const buyDoneKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`📊 ${t(userLang, 'My Positions')}`, 'portfolio_open_1')],
        [Markup.button.callback(t(userLang, 'btn.mainMenu'), 'back_to_menu')],
      ]);

      const buildBuyMsg = (txLine: string) =>
        `✅ *${t(userLang, 'Buy Order Placed!')}*\n\n` +
        `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
        `📈 ${t(userLang, 'Shares')}: *~${buySize.toFixed(4)}*\n` +
        `💰 ${t(userLang, 'Price')}: *${(buyPrice * 100).toFixed(2)}¢*\n` +
        `💵 USDC: *$${usdAmount.toFixed(2)}*\n` +
        txLine +
        `_${t(userLang, 'Order will be filled when matched.')}_`;

      let sentBuyMsg: any;
      try {
        sentBuyMsg = await ctx.editMessageText(buildBuyMsg(`🔗 ${t(userLang, 'Transaction Hash')}: _${t(userLang, 'fetching...')}_\n`), { parse_mode: 'Markdown', ...buyDoneKeyboard });
      } catch {
        sentBuyMsg = await ctx.reply(buildBuyMsg(`🔗 ${t(userLang, 'Transaction Hash')}: _${t(userLang, 'fetching...')}_\n`), { parse_mode: 'Markdown', ...buyDoneKeyboard });
      }

      // Fire-and-forget: fetch on-chain tx hash and update message
      if (user.polymarketProxyAddress) {
        const proxyAddr = user.polymarketProxyAddress;
        const assetId   = state.assetId;
        const placedAt  = Date.now() - 5_000;
        const chatId    = ctx.chat?.id;
        const msgId     = sentBuyMsg?.message_id;
        if (chatId && msgId) {
          (async () => {
            try {
              const txHash = await fetchTxHashForOrder(proxyAddr, assetId, placedAt);
              const txLine = txHash
                ? `🔗 [${t(userLang, 'Transaction Hash')}](https://polygonscan.com/tx/${txHash})\n`
                : ``;
              await ctx.telegram.editMessageText(
                chatId, msgId, undefined,
                buildBuyMsg(txLine),
                { parse_mode: 'Markdown', ...buyDoneKeyboard },
              );
            } catch {
              // Non-fatal
            }
          })();
        }
      }
    } catch (err: any) {
      logger.error('[positionTrade] Buy failed:', err);
      const errKeyboard = Markup.inlineKeyboard([[Markup.button.callback(t(userLang, 'btn.back'), 'portfolio_open_1')]]);
      const errMsg = `❌ *${t(userLang, 'Buy Failed')}*\n\n${t(userLang, 'Order could not be placed. Check your balance and try again.')}`;
      try {
        await ctx.editMessageText(errMsg, { parse_mode: 'Markdown', ...errKeyboard });
      } catch {
        await ctx.reply(errMsg, { parse_mode: 'Markdown', ...errKeyboard });
      }
    }
  } catch (error) {
    logger.error('Error executing buy:', error);
  }
}

// ─── Core CLOB order ───────────────────────────────────────────────────────

async function executePositionOrder(
  user: any,
  assetId: string,
  conditionId: string,
  negRisk: boolean,
  action: 'buy' | 'sell',
  price: number,
  size: number
): Promise<{ orderID: string }> {
  // Predexon handles approvals, balance refresh, and order signing automatically
  const { ensurePredexonUser } = await import('../../services/user');
  const { placeOrder: predexonPlaceOrder } = await import('../../services/predexon');

  const predexonUserId = await ensurePredexonUser(user);

  // Normalize precision: floor sells to avoid exceeding actual position, round buys normally
  const cleanSize = action === 'sell'
    ? Math.floor(size * 100) / 100      // Floor — never sell more than owned
    : parseFloat(size.toFixed(2));
  const cleanPrice = parseFloat(price.toFixed(4));

  if (action === 'sell') {
    if (cleanSize < MIN_ORDER_SIZE) {
      throw new Error(`Position too small to sell (${cleanSize} shares, min ${MIN_ORDER_SIZE})`);
    }

    logger.info(
      `[positionTrade] Predexon market SELL: ${cleanSize} shares (raw=${size}) assetId=${assetId.substring(0, 16)}... negRisk=${negRisk}`
    );

    let sellOrderResponse;
    try {
      sellOrderResponse = await predexonPlaceOrder(predexonUserId, {
        venue: 'polymarket',
        tokenId: assetId,
        side: 'sell',
        type: 'market',
        size: String(cleanSize),
      });
    } catch (err: any) {
      throw classifyOrderError(err, 'sell');
    }

    if (!sellOrderResponse.orderId) {
      const errMsg = (sellOrderResponse as any).error || (sellOrderResponse as any).message || 'Sell order not filled';
      throw classifyOrderError(new Error(errMsg), 'sell');
    }

    // Transfer 1% commission from estimated sell proceeds (fire-and-forget)
    const sellCommissionUsdc = cleanPrice * cleanSize * COMMISSION_RATE;
    transferCommission(user.encryptedPrivateKey, user.polymarketProxyAddress!, sellCommissionUsdc, user.id, user.predexonUserId ?? undefined)
      .catch((feeErr) => {
        logger.warn('[positionTrade] Commission transfer after sell failed (non-fatal):', feeErr);
      });

    return { orderID: sellOrderResponse.orderId };
  }

  // BUY: market order via Predexon
  const buyAmount = parseFloat((cleanSize * cleanPrice).toFixed(6));

  logger.info(`[positionTrade] Predexon market BUY: amount=$${buyAmount} negRisk=${negRisk}`);

  let buyOrderResponse;
  try {
    buyOrderResponse = await predexonPlaceOrder(predexonUserId, {
      venue: 'polymarket',
      tokenId: assetId,
      side: 'buy',
      type: 'market',
      amount: String(buyAmount),
    });
  } catch (err: any) {
    throw classifyOrderError(err, 'buy');
  }

  if (!buyOrderResponse.orderId) {
    const errMsg = (buyOrderResponse as any).error || (buyOrderResponse as any).message || 'Buy order placement failed';
    logger.error(`[positionTrade] Predexon buy rejected: ${errMsg}`);
    throw classifyOrderError(new Error(errMsg), 'buy');
  }

  // Transfer 1% commission after successful order (fire-and-forget)
  const buyCommissionUsdc = cleanPrice * cleanSize * COMMISSION_RATE;
  transferCommission(user.encryptedPrivateKey, user.polymarketProxyAddress!, buyCommissionUsdc, user.id, user.predexonUserId ?? undefined)
    .catch((feeErr) => {
      logger.warn('[positionTrade] Commission transfer after buy failed (non-fatal):', feeErr);
    });

  return { orderID: buyOrderResponse.orderId };
}

/** Maps raw API / network errors to user-friendly messages */
function classifyOrderError(err: any, side: 'buy' | 'sell'): Error {
  const raw = String(err?.message ?? '');
  logger.error(`[positionTrade] ${side} order failed (raw): ${raw}`);

  if (/no orders found|liquidity|no matching|empty book/i.test(raw))
    return new Error('Market is illiquid — no orders on the book. Try again later.');
  if (/balance|allowance|insufficient/i.test(raw))
    return new Error('Insufficient balance or allowance. Your on-chain balance may have changed.');
  if (/order failed|order rejected|matching failed/i.test(raw))
    return new Error('Order could not be matched — market may be illiquid or closed.');
  if (/timed? ?out|ETIMEDOUT|ECONNRESET/i.test(raw))
    return new Error('Network timeout while placing order. Try again.');
  // Fallback: strip "Predexon API error: ..." prefix for cleaner display
  const cleaned = raw.replace(/^Predexon API error:\s*\d+\s*[A-Za-z ]*\s*—\s*/, '').trim();
  return new Error(cleaned || `${side} order failed`);
}

/**
 * Closes all active positions: sells open positions at market price and
 * redeems any resolved (redeemable) positions in a single bulk action.
 * Called from the "Close All Positions" bulk action.
 */
export async function executeCloseAllPositions(
  user: any,
  slippagePct: number = 1.0,
): Promise<{ closed: number; redeemed: number; failed: number; errors: string[] }> {
  const allPositions = await getActivePositions(user.polymarketProxyAddress);
  const sellable   = allPositions.filter(pos => pos.size > 0 && !pos.redeemable);
  const redeemable = allPositions.filter(pos => pos.size > 0 &&  pos.redeemable);
  let closed = 0;
  let redeemed = 0;
  let failed = 0;
  const errors: string[] = [];

  // 1) Sell open positions sequentially (avoid rate-limit / nonce collisions on Predexon)
  for (const pos of sellable) {
    if (pos.size < MIN_ORDER_SIZE) {
      failed++;
      errors.push(`${pos.outcome}: too small (${pos.size.toFixed(2)} sh, min ${MIN_ORDER_SIZE})`);
      continue;
    }

    // First attempt with user's slippage, retry with 5x slippage on failure
    const attempts = [slippagePct, Math.min(slippagePct * 5, 50)];
    let success = false;

    for (const slip of attempts) {
      try {
        const price = Math.max(pos.curPrice * (1 - slip / 100), 0.01);
        await executePositionOrder(user, pos.asset, pos.conditionId, pos.negativeRisk, 'sell', price, pos.size);
        logger.info(`[positionTrade] closeAll: closed ${pos.outcome} (${pos.size.toFixed(2)} sh, slip=${slip}%)`);
        closed++;
        success = true;
        break;
      } catch (err: any) {
        logger.warn(`[positionTrade] closeAll: attempt slip=${slip}% failed for ${pos.outcome}: ${err.message}`);
      }
    }

    if (!success) {
      failed++;
      errors.push(`${pos.outcome}: Order could not be matched — market may be illiquid or closed.`);
    }
  }

  // 2) Redeem resolved positions sequentially with delay between attempts
  if (redeemable.length > 0) {
    const { manualRedeem } = await import('../../services/redeem');
    for (let i = 0; i < redeemable.length; i++) {
      const pos = redeemable[i];
      try {
        const result = await manualRedeem(
          user.encryptedPrivateKey,
          user.polymarketProxyAddress,
          pos,
          user.predexonUserId ?? undefined,
        );
        if (result.success) {
          logger.info(`[positionTrade] closeAll: redeemed ${pos.outcome} / ${pos.title.slice(0, 40)}`);
          redeemed++;
        } else {
          logger.warn(`[positionTrade] closeAll: redeem failed for ${pos.outcome}: ${result.error}`);
          failed++;
          errors.push(`${pos.outcome}: redeem failed — ${result.error || 'unknown error'}`);
          // If rate-limited, stop trying more redeems
          if (result.error && /rate.?limit/i.test(result.error)) {
            logger.warn(`[positionTrade] closeAll: relayer rate-limited, stopping redeem loop`);
            // Count remaining as failed
            for (let j = i + 1; j < redeemable.length; j++) {
              failed++;
              errors.push(`${redeemable[j].outcome}: skipped — relayer rate-limited`);
            }
            break;
          }
        }
      } catch (err: any) {
        logger.warn(`[positionTrade] closeAll: redeem threw for ${pos.outcome}: ${err?.message}`);
        failed++;
        errors.push(`${pos.outcome}: redeem error — ${err?.message || 'unknown error'}`);
      }
      // Delay between redeem attempts to avoid rate limiting
      if (i < redeemable.length - 1) {
        await new Promise(r => setTimeout(r, 3_000));
      }
    }
  }

  return { closed, redeemed, failed, errors };
}
