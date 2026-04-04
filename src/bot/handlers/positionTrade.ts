import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { config } from '../../config';
import { getActivePositions, ActivePosition, fetchTxHashForOrder } from '../../services/portfolio';
import { logger } from '../../utils/logger';
import { transferCommission, COMMISSION_RATE } from '../../services/commission';
import { sendPage, sendImageBufferPage, fetchProfilePhoto } from '../../utils/telegram';
import { ce, EMOJI } from '../../utils/customEmoji';
import { generatePositionPnlImage } from '../../services/pnlImage';
import { RedisBackedState } from '../../utils/redisState';

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

// ─── Full list ─────────────────────────────────────────────────────────────

export async function handleOpenPositionsFull(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading...');
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) return;

    if (!user.polymarketProxyAddress) {
      await sendPage(ctx, '📊 *Active Positions*\n\n⚠️ No trading wallet found.\n\nGo to 💼 My Wallet to set up your account first.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('💼 My Wallet', 'wallet_page')]]),
      });
      return;
    }

    const positions = await getActivePositions(user.polymarketProxyAddress);
    positionListCache.set(telegramId, positions);

    if (positions.length === 0) {
      await sendPage(ctx, '📊 *Active Positions*\n\n📭 No active positions.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'portfolio_open_1')]]),
      });
      return;
    }

    let message = `📊 *All Active Positions* (${positions.length})\n\n`;
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      const pnlSign = pos.cashPnl >= 0 ? '+' : '';
      const pnlEmoji = pos.cashPnl >= 0 ? '🟢' : '🔴';
      message += `${i + 1}) *${pos.outcome}* — ${truncate(pos.title, 45)}\n`;
      message += `   💵 ${pos.size.toFixed(2)} shares · ${(pos.curPrice * 100).toFixed(1)}¢ · $${pos.currentValue.toFixed(2)}\n`;
      message += `   ${pnlEmoji} P&L: ${pnlSign}$${pos.cashPnl.toFixed(2)} (${pnlSign}${pos.percentPnl.toFixed(1)}%)\n\n`;
      if (message.length > 3800) {
        message += `_... and ${positions.length - i - 1} more_`;
        break;
      }
    }

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('« Back to Positions', 'portfolio_open_1')]]),
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
      await ctx.reply('⚠️ Position not found. You may have no active positions.');
      return;
    }

    const pnlSign = pos.cashPnl >= 0 ? '+' : '';
    const pnlEmoji = pos.cashPnl >= 0 ? '🟢' : '🔴';
    const endDate = pos.endDate
      ? new Date(pos.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'N/A';

    let msg = `📊 *Position Detail*\n\n`;
    msg += `*${pos.outcome}* — ${pos.title}\n\n`;
    msg += `💰 *Position*\n`;
    msg += `├ Shares: ${pos.size.toFixed(4)}\n`;
    msg += `├ Avg Buy Price: ${(pos.avgPrice * 100).toFixed(2)}¢\n`;
    msg += `├ Current Price: ${(pos.curPrice * 100).toFixed(2)}¢\n`;
    msg += `├ Invested: $${pos.initialValue.toFixed(2)}\n`;
    msg += `└ Current Value: $${pos.currentValue.toFixed(2)}\n\n`;
    msg += `📈 *P&L*\n`;
    msg += `├ ${pnlEmoji} Unrealized: ${pnlSign}$${pos.cashPnl.toFixed(2)}\n`;
    msg += `├ ROI: ${pnlSign}${pos.percentPnl.toFixed(1)}%\n`;
    msg += `└ Realized: $${pos.realizedPnl.toFixed(2)}\n\n`;
    msg += `⏰ Market ends: ${endDate}\n`;
    if (pos.redeemable) msg += `✅ _Redeemable_\n`;

    await sendPage(ctx, msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📈 Buy More', `pos_buy_${idx}`),
          Markup.button.callback('📉 Sell', `pos_sell_${idx}`),
        ],
        [Markup.button.callback('📊 P&L', `pos_pnl_${idx}`)],
        [Markup.button.callback('« Back to Positions', 'portfolio_open_1')],
      ]),
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
      await ctx.reply('⚠️ Position not found. You may have no active positions.');
      return;
    }

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

    const pnlKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('📈 Buy', `pos_buy_${idx}`),
        Markup.button.callback('📉 Sell', `pos_sell_${idx}`),
      ],
      [
        Markup.button.callback('🔄 Refresh', `pos_pnl_${idx}`),
        ...(shareUrl ? [Markup.button.url('📤 Share', shareUrl)] : []),
      ],
      [Markup.button.callback('🛑 Stop Loss', `pos_sl_${idx}`)],
      [Markup.button.callback('« Back', `pos_view_${idx}`)],
    ]);

    // Build rich HTML caption
    const pnlDir = pos.cashPnl >= 0 ? ce(EMOJI.pnlUp, '📈') : ce(EMOJI.pnlDown, '📉');
    const pnlSign = pos.cashPnl >= 0 ? '+' : '';
    const pctSign = pos.percentPnl >= 0 ? '+' : '';
    const escTitle = pos.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let caption = `${ce(EMOJI.pnlChart, '📊')} <b>Position P&amp;L</b>\n\n`;
    caption += `${ce(EMOJI.fire, '🔥')} <b>${pos.outcome}</b> — ${escTitle}\n\n`;
    caption += `${ce(EMOJI.diamond, '💎')} <b>P&amp;L:</b>  ${pnlDir} <b>${pnlSign}$${pos.cashPnl.toFixed(2)}</b>\n`;
    caption += `${ce(EMOJI.rocket, '🚀')} <b>ROI:</b>  ${pctSign}${pos.percentPnl.toFixed(1)}%\n\n`;
    caption += `${ce(EMOJI.target, '🎯')} <b>Entry:</b>  ${(pos.avgPrice * 100).toFixed(1)}¢\n`;
    caption += `${ce(EMOJI.trophy, '🏆')} <b>Current:</b>  ${(pos.curPrice * 100).toFixed(1)}¢`;

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
    await ctx.reply('❌ Failed to generate P&L. Please try again.').catch(() => {});
  }
}

/**
 * Share a position PNL image (forwardable, no keyboard)
 */
export async function handlePositionPnlShare(ctx: Context, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery('Generating share image...').catch(() => {});
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const pos = await getPosOrFetch(telegramId, idx);
    if (!pos) {
      await ctx.reply('⚠️ Position not found.');
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
      await ctx.answerCbQuery('No PNL templates available yet.', { show_alert: true });
    }
  } catch (error) {
    logger.error('Error in handlePositionPnlShare:', error);
    await ctx.reply('❌ Failed to generate share image.');
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
      await ctx.reply('⚠️ Position not found. You may have no active positions.');
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
      `📉 *Sell Position*\n\n` +
      `*${pos.outcome}* — ${truncate(pos.title, 50)}\n\n` +
      `You hold: *${pos.size.toFixed(4)} shares* @ avg ${(pos.avgPrice * 100).toFixed(1)}¢\n` +
      `Current price: *${curCents}¢*  ·  Value: *$${pos.currentValue.toFixed(2)}*\n\n` +
      `*Enter number of shares to sell:*\n` +
      `Example: \`${pos.size.toFixed(2)}\` (sell all)\n\n` +
      `Or choose a quick amount:`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('25%', `pos_pct_${idx}_25`),
          Markup.button.callback('50%', `pos_pct_${idx}_50`),
          Markup.button.callback('75%', `pos_pct_${idx}_75`),
          Markup.button.callback('100%', `pos_pct_${idx}_100`),
        ],
        [Markup.button.callback('❌ Cancel', 'pos_cancel')],
      ]),
    });
  } catch (error) {
    logger.error('Error starting sell flow:', error);
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
      await ctx.reply('⚠️ Position not found. You may have no active positions.');
      return;
    }

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

    const curCents = (pos.curPrice * 100).toFixed(1);
    const estimatedShares = (10 / pos.curPrice).toFixed(1);
    const msg =
      `📈 *Buy More*\n\n` +
      `*${pos.outcome}* — ${truncate(pos.title, 50)}\n\n` +
      `You already hold: *${pos.size.toFixed(4)} shares*\n` +
      `Current price: *${curCents}¢*\n\n` +
      `*Enter USDC amount to spend:*\n` +
      `Example: \`10\` → buys ~${estimatedShares} shares at ${curCents}¢`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'pos_cancel')]]),
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
      await ctx.reply('⚠️ Position not found. You may have no active positions.');
      return;
    }

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
      `🛑 *Stop Loss*\n\n` +
      `*${pos.outcome}* — ${truncate(pos.title, 50)}\n\n` +
      `You hold: *${pos.size.toFixed(4)} shares*\n` +
      `Current price: *${curCents}¢*\n\n` +
      `Enter the *stop loss price in cents* (must be below current price).\n` +
      `A GTC limit sell order will be placed for all your shares.\n\n` +
      `Example: \`${suggestSl}\` → sells at ${suggestSl}¢`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'pos_cancel')]]),
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
  positionTradeState.set(telegramId, { ...state, price: slPrice, timestamp: Date.now() });

  const slCents   = (slPrice * 100).toFixed(1);
  const curCents  = (state.curPrice * 100).toFixed(1);
  const estValue  = (state.currentSize * slPrice).toFixed(2);
  const dropPct   = (((state.curPrice - slPrice) / state.curPrice) * 100).toFixed(1);

  const msg =
    `🛑 *Stop Loss Confirmation*\n\n` +
    `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
    `📦 Shares to sell: *${state.currentSize.toFixed(4)}*\n` +
    `📊 Current price: *${curCents}¢*\n` +
    `🎯 Stop loss price: *${slCents}¢* (${dropPct}% below)\n` +
    `💰 Est. proceeds: ~$${estValue}\n\n` +
    `_A GTC limit SELL order will be placed at ${slCents}¢._\n` +
    `_It will fill automatically when the price drops to this level._`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Place Stop Loss', 'pos_execute_sl'),
        Markup.button.callback('❌ Cancel', 'pos_cancel'),
      ],
    ]),
  });
}

export async function handlePositionExecuteStopLoss(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  await ctx.answerCbQuery('Placing stop loss…').catch(() => {});

  const state = await positionTradeState.get(telegramId);
  if (!state || state.action !== 'stop_loss' || !state.price) {
    await ctx.reply('❌ Session expired. Please start again.').catch(() => {});
    return;
  }
  positionTradeState.delete(telegramId);

  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user?.polymarketProxyAddress) {
      await ctx.reply('❌ Trading wallet not set up.').catch(() => {});
      return;
    }

    const { ensurePredexonUser } = await import('../../services/user');
    const { placeOrder: predexonPlaceOrder } = await import('../../services/predexon');

    const predexonUserId = await ensurePredexonUser(user);

    // Snap price to 0.01 tick
    const tick       = 0.01;
    const snappedPrice = parseFloat(Math.max(Math.round(state.price / tick) * tick, 0.01).toFixed(2));
    const shares     = parseFloat(state.currentSize.toFixed(4));

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
      `✅ *Stop Loss Placed*\n\n` +
      `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
      `🛑 Trigger price: *${slCents}¢*\n` +
      `📦 Shares: *${shares}*\n\n` +
      `_GTC limit sell order resting on the book. Cancel it from Open Orders if needed._`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 Open Orders', 'portfolio_orders_1')],
          [Markup.button.callback('📊 My Positions', 'portfolio_open_1')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      },
    ).catch(() => {});

    logger.info(
      `[stopLoss] Placed: user=${telegramId} outcome=${state.outcome} price=${snappedPrice} shares=${shares} orderID=${orderResp.orderID}`
    );
  } catch (error: any) {
    logger.error('[stopLoss] Error executing stop loss:', error);
    await ctx.reply(
      `❌ *Stop Loss Failed*\n\n${error?.message || 'Unknown error'}\n\nPlease try again.`,
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
        await ctx.answerCbQuery('⚠️ Position not found. Please refresh.', { show_alert: true });
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

    const shares = parseFloat(((pos.size * pct) / 100).toFixed(2));

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
  }
}

// ─── Text input handler ────────────────────────────────────────────────────

export async function handlePositionTradeInput(ctx: Context, text: string): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const state = await positionTradeState.get(telegramId);
  if (!state) return;

  if (Date.now() - state.timestamp > 10 * 60 * 1000) {
    positionTradeState.delete(telegramId);
    await ctx.reply('❌ Session expired. Please start again.');
    return;
  }

  const val = parseFloat(text.trim().replace(/[^0-9.,]/g, '').replace(',', '.'));

  if (isNaN(val) || val <= 0) {
    await ctx.reply(
      state.action === 'sell'
        ? '❌ Enter the number of shares to sell. Example: `7.5`'
        : state.action === 'stop_loss'
        ? '❌ Enter the stop loss price in cents. Example: `35` for 35¢'
        : '❌ Enter the USDC amount to spend. Example: `10`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (state.action === 'stop_loss') {
    // val is in cents (e.g. 35 = 35¢ = 0.35)
    const slPrice = val > 1 ? val / 100 : val; // support both 35 and 0.35
    if (slPrice >= state.curPrice) {
      await ctx.reply(
        `❌ Stop loss price must be *below* current price.\n\n` +
        `Current: *${(state.curPrice * 100).toFixed(1)}¢*\nYou entered: *${(slPrice * 100).toFixed(1)}¢*`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    if (slPrice < 0.01) {
      await ctx.reply('❌ Minimum price is 1¢.', { parse_mode: 'Markdown' });
      return;
    }
    await showStopLossConfirmation(ctx, telegramId, state, slPrice);
    return;
  }

  if (state.action === 'sell') {
    const shares = parseFloat(val.toFixed(4));
    if (shares > state.currentSize * 1.001) {
      await ctx.reply(`❌ You only have ${state.currentSize.toFixed(4)} shares. Cannot sell ${shares}.`);
      return;
    }
    if (shares < MIN_ORDER_SIZE) {
      await ctx.reply(
        `❌ Minimum order size is *${MIN_ORDER_SIZE} shares*. You entered ${shares.toFixed(4)} shares.\n\n` +
        `Your position: ${state.currentSize.toFixed(4)} shares — enter at least ${MIN_ORDER_SIZE}.`,
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
        `❌ Minimum order size is *${MIN_ORDER_SIZE} shares*. At ${(state.curPrice * 100).toFixed(1)}¢, you need at least *$${minUsd}*.`,
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
  positionTradeState.set(telegramId, { ...state, price, size: shares });

  const estProceeds = shares * price;
  const commissionAmt = estProceeds * COMMISSION_RATE;
  const netProceeds = estProceeds - commissionAmt;

  const msg =
    `⚠️ *Confirm SELL Order*\n\n` +
    `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
    `📉 Sell: *${shares.toFixed(4)} shares*\n` +
    `💰 Min price: *${(price * 100).toFixed(2)}¢*\n` +
    `💵 Est. proceeds: *$${estProceeds.toFixed(2)}*\n` +
    `📊 Platform fee (1%): *-$${commissionAmt.toFixed(2)}*\n` +
    `💰 Net to wallet: *$${netProceeds.toFixed(2)}*\n\n` +
    `_Market order — executes immediately at the best available price._`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Confirm Sell', 'pos_execute_sell'),
        Markup.button.callback('❌ Cancel', 'pos_cancel'),
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
  const commissionAmt = usdAmount * COMMISSION_RATE;
  const tradeAmount = usdAmount - commissionAmt;

  if (tradeAmount < 1.0) {
    await ctx.reply(
      `❌ *Minimum order is $1.00*\n\nAfter the 1% platform fee, your trade amount would be $${tradeAmount.toFixed(2)}. Please enter at least $1.02.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const shares = parseFloat((tradeAmount / price).toFixed(4));
  positionTradeState.set(telegramId, { ...state, price, size: shares });

  const msg =
    `⚠️ *Confirm BUY Order*\n\n` +
    `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
    `📈 Buy: *~${shares.toFixed(4)} shares*\n` +
    `💰 Max price: *${(price * 100).toFixed(2)}¢* (slippage: ${slippagePct}%)\n` +
    `💵 Total: *$${usdAmount.toFixed(2)}*\n` +
    `📊 Platform fee (1%): *-$${commissionAmt.toFixed(2)}*\n` +
    `💰 Trade amount: *$${tradeAmount.toFixed(2)}*\n\n` +
    `_FAK market order — fills immediately at best available ask._`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Confirm Buy', 'pos_execute_buy'),
        Markup.button.callback('❌ Cancel', 'pos_cancel'),
      ],
    ]),
  });
}

// ─── Cancel ────────────────────────────────────────────────────────────────

export async function handlePositionCancel(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Cancelled');
    const telegramId = ctx.from?.id.toString();
    if (telegramId) positionTradeState.delete(telegramId);

    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('« Back to Positions', 'portfolio_open_1')]]);
    try {
      await ctx.editMessageText('❌ Trade cancelled.', { ...keyboard });
    } catch {
      await ctx.reply('❌ Trade cancelled.', { ...keyboard });
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
      await ctx.reply('❌ Session expired. Please start again.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'portfolio_open_1')]]),
      });
      return;
    }
    positionTradeState.delete(telegramId);

    try { await ctx.editMessageText(ce(EMOJI.loading, '⏳') + ' Placing sell order...', { parse_mode: 'HTML' }); } catch { await ctx.reply(ce(EMOJI.loading, '⏳') + ' Placing sell order...', { parse_mode: 'HTML' }); }

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply('❌ User not found.'); return; }

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
        [Markup.button.callback('📊 My Positions', 'portfolio_open_1')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]);

      const sellSize  = state.size!;
      const sellPrice = state.price!;
      const buildSellMsg = (txLine: string) =>
        `✅ *Sell Executed!*\n\n` +
        `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
        `📉 Shares: *${sellSize.toFixed(4)}*\n` +
        `💰 Min price: *${(sellPrice * 100).toFixed(2)}¢*\n` +
        `💵 Est. proceeds: *$${(sellSize * sellPrice).toFixed(2)}*\n` +
        txLine +
        `_Market sell executed — your position has been closed or reduced._`;

      let sentMsg: any;
      try {
        sentMsg = await ctx.editMessageText(buildSellMsg('🔗 Transaction Hash: _fetching…_\n'), { parse_mode: 'Markdown', ...doneKeyboard });
      } catch {
        sentMsg = await ctx.reply(buildSellMsg('🔗 Transaction Hash: _fetching…_\n'), { parse_mode: 'Markdown', ...doneKeyboard });
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
                ? `🔗 [Transaction Hash](https://polygonscan.com/tx/${txHash})\n`
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
                { caption: `${cashPnl >= 0 ? '🟢' : '🔴'} <b>Realized P&L: ${cashPnl >= 0 ? '+' : ''}$${cashPnl.toFixed(2)}</b>`, parse_mode: 'HTML' }
              );
            }
          } catch (pnlErr) {
            logger.warn('[positionTrade] PNL card after sell failed (non-fatal):', pnlErr);
          }
        })();
      }
    } catch (err: any) {
      logger.error('[positionTrade] Sell failed:', err);
      const errKeyboard = Markup.inlineKeyboard([[Markup.button.callback('« Back', 'portfolio_open_1')]]);
      const errMsg = '❌ *Sell Failed*\n\nOrder could not be placed. Check your balance and try again.';
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
      await ctx.reply('❌ Session expired. Please start again.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'portfolio_open_1')]]),
      });
      return;
    }
    positionTradeState.delete(telegramId);

    try { await ctx.editMessageText(ce(EMOJI.loading, '⏳') + ' Placing buy order...', { parse_mode: 'HTML' }); } catch { await ctx.reply(ce(EMOJI.loading, '⏳') + ' Placing buy order...', { parse_mode: 'HTML' }); }

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply('❌ User not found.'); return; }

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
        [Markup.button.callback('📊 My Positions', 'portfolio_open_1')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]);

      const buildBuyMsg = (txLine: string) =>
        `✅ *Buy Order Placed!*\n\n` +
        `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
        `📈 Shares: *~${buySize.toFixed(4)}*\n` +
        `💰 Price: *${(buyPrice * 100).toFixed(2)}¢*\n` +
        `💵 USDC: *$${usdAmount.toFixed(2)}*\n` +
        txLine +
        `_Order will be filled when matched._`;

      let sentBuyMsg: any;
      try {
        sentBuyMsg = await ctx.editMessageText(buildBuyMsg('🔗 Transaction Hash: _fetching…_\n'), { parse_mode: 'Markdown', ...buyDoneKeyboard });
      } catch {
        sentBuyMsg = await ctx.reply(buildBuyMsg('🔗 Transaction Hash: _fetching…_\n'), { parse_mode: 'Markdown', ...buyDoneKeyboard });
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
                ? `🔗 [Transaction Hash](https://polygonscan.com/tx/${txHash})\n`
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
      const errKeyboard = Markup.inlineKeyboard([[Markup.button.callback('« Back', 'portfolio_open_1')]]);
      const errMsg = '❌ *Buy Failed*\n\nOrder could not be placed. Check your balance and try again.';
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

  // Normalize precision to avoid floating-point dust (Polymarket uses 2 decimals for size)
  const cleanSize = parseFloat(size.toFixed(2));
  const cleanPrice = parseFloat(price.toFixed(4));

  if (action === 'sell') {
    logger.info(
      `[positionTrade] Predexon market SELL: ${cleanSize} shares assetId=${assetId.substring(0, 16)}... negRisk=${negRisk}`
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
 * Closes all active positions by selling 100% at market price.
 * Called from the "Close All Positions" bulk action.
 */
export async function executeCloseAllPositions(
  user: any,
  slippagePct: number = 1.0,
): Promise<{ closed: number; failed: number; errors: string[] }> {
  const positions = await getActivePositions(user.polymarketProxyAddress);
  let closed = 0;
  let failed = 0;
  const errors: string[] = [];

  // Process sequentially to avoid rate-limit / nonce collisions on Predexon
  for (const pos of positions) {
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

  return { closed, failed, errors };
}
