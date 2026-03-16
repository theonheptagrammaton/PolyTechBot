import path from 'path';
import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { logger } from '../../utils/logger';
import { getUpDownMarkets, formatVolume, UpDownMarket } from '../../services/market';
import { isBenignTelegramError, sendPage } from '../../utils/telegram';
import { config } from '../../config';

// ─── Constants ────────────────────────────────────────────────────────────────

const IMG_CRYPTO = path.join(__dirname, '../img/crypto.jpeg');

const TIMEFRAME_EMOJI: Record<string, string> = {
  '5-Minute':  '⚡',
  '15-Minute': '⏱️',
  '1-Hour':    '🕐',
  '4-Hour':    '🕓',
  'Daily':     '📅',
  'Weekly':    '📆',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtEndDate(iso: string): string {
  if (!iso) return '?';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Level 1: Main Up/Down list grouped by timeframe ─────────────────────────

export async function handleUpDownCrypto(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading…');

    const markets     = await getUpDownMarkets();
    const botUsername = ctx.botInfo?.username ?? config.telegram.botUsername ?? 'PolymarketBot';

    if (markets.length === 0) {
      await sendPage(ctx,
        '<b>📈 Crypto Up/Down Markets</b>\n\n' +
        '😔 No active Up/Down markets right now.\n\n' +
        '<i>These markets are created daily on Polymarket. Try again shortly.</i>',
        {
          parse_mode: 'HTML',
          image_path: IMG_CRYPTO,
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh',      'crypto_updown')],
            [Markup.button.callback('« Crypto Menu',   'category_crypto_sub')],
            [Markup.button.callback('🏠 Main Menu',    'back_to_menu')],
          ]),
        }
      );
      return;
    }

    // Group by timeframe, deduplicated by coin
    const byTimeframe = new Map<string, UpDownMarket[]>();
    for (const m of markets) {
      if (!byTimeframe.has(m.timeframe)) byTimeframe.set(m.timeframe, []);
      const existing = byTimeframe.get(m.timeframe)!;
      if (!existing.some(e => e.coin === m.coin)) existing.push(m);
    }

    let msg = `<b>📈 Up/Down Crypto Markets</b>\n\n`;

    for (const [timeframe, tfMarkets] of byTimeframe) {
      const emoji = TIMEFRAME_EMOJI[timeframe] ?? '📊';
      msg += `${emoji} <b>${timeframe}</b>\n`;
      for (const m of tfMarkets) {
        const link = `https://t.me/${botUsername}?start=updown_market_${m.marketId}`;
        const upPct   = (m.upPrice   * 100).toFixed(0);
        const downPct = (m.downPrice * 100).toFixed(0);
        msg += `└ <a href="${link}">${m.coinEmoji ?? '🪙'} ${esc(m.coinName)}</a>  ⬆️${upPct}¢ · ⬇️${downPct}¢\n`;
      }
      msg += '\n';
    }

    await sendPage(ctx, msg, {
      parse_mode: 'HTML',
      image_path: IMG_CRYPTO,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Refresh',    'crypto_updown'),
          Markup.button.callback('« Crypto Menu', 'category_crypto_sub'),
        ],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    });

    logger.info(`[updown] Main list shown to user: ${ctx.from?.id} (${markets.length} markets)`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing up/down market list:', error);
    await ctx.reply('❌ Could not load markets. Please try again.').catch(() => {});
  }
}

// ─── Market detail view ───────────────────────────────────────────────────────

export async function handleUpDownMarketDetail(
  ctx: Context,
  marketId: string,
  _edit: boolean = true,
): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Loading…').catch(() => {});

    const markets = await getUpDownMarkets();
    const m       = markets.find(x => x.marketId === marketId);

    if (!m) {
      const errMsg = '❌ Market not found. Tap below for the current list.';
      const errKb  = Markup.inlineKeyboard([
        [Markup.button.callback('📈 Up/Down Markets', 'crypto_updown')],
        [Markup.button.callback('🏠 Main Menu',       'back_to_menu')],
      ]);
      await ctx.reply(errMsg, { parse_mode: 'HTML', ...errKb });
      return;
    }

    const botUsername = ctx.botInfo?.username ?? config.telegram.botUsername ?? 'PolymarketBot';
    const upPct       = (m.upPrice   * 100).toFixed(1);
    const downPct     = (m.downPrice * 100).toFixed(0);
    const vol         = formatVolume(m.volume24hr);
    const liq         = formatVolume(m.liquidity);
    const timeEmoji   = TIMEFRAME_EMOJI[m.timeframe] ?? '📊';
    const endStr      = fmtEndDate(m.endDate);
    const defaultAmount = 25;

    let msg = `${m.coinEmoji ?? '🪙'} <b>${esc(m.coinName)} — Up or Down?</b>\n\n`;
    msg += `📊 Vol (24h): <b>${vol}</b> • 💧 Liq: <b>${liq}</b>`;
    if (endStr) msg += ` | ⏰ ${endStr}`;
    msg += '\n\n';

    msg += `- <b>Will ${esc(m.coinName)} go ⬆️ UP or ⬇️ DOWN by end of ${timeEmoji} ${esc(m.timeframe)} window?</b>\n\n`;
    msg += `Vol: <b>${vol}</b> • Liq: <b>${liq}</b>\n\n`;
    msg += `⬆️ Up  <b>${upPct}¢</b>\n`;
    msg += `⬇️ Down  ${downPct}¢\n\n`;

    msg += `⚡ <a href="https://t.me/${botUsername}?start=trade_${m.marketId}_yes_default">UP $${defaultAmount}</a>`;
    msg += ` • <a href="https://t.me/${botUsername}?start=trade_${m.marketId}_no_default">DOWN $${defaultAmount}</a>\n\n`;

    if (m.slug) msg += `🤑 <a href="https://polymarket.com/event/${m.slug}">View on Polymarket</a>`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.url(`✅ Buy UP ${upPct}¢`,    `https://t.me/${botUsername}?start=trade_${m.marketId}_yes_custom`),
        Markup.button.url(`❌ Buy DOWN ${downPct}¢`, `https://t.me/${botUsername}?start=trade_${m.marketId}_no_custom`),
      ],
      [
        Markup.button.url(`🏦 Place Limit Order`, `https://t.me/${botUsername}?start=limit_${m.marketId}_choice`),
      ],
      [
        Markup.button.callback('🔄 Refresh',  `updown_refresh_${m.marketId}`),
        Markup.button.callback('« Back',       'crypto_updown'),
        Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
      ],
    ]);

    await sendPage(ctx, msg, { parse_mode: 'HTML', image_path: IMG_CRYPTO, ...keyboard });

    logger.info(`[updown] Detail shown to ${ctx.from?.id}: ${m.coinName} ${m.timeframe}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error(`Error showing up/down detail for ${marketId}:`, error);
    await ctx.reply('❌ Could not load market. Please try again.').catch(() => {});
  }
}

// ─── Crypto subcategory menu ──────────────────────────────────────────────────

export async function handleCryptoCategory(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();
    await sendPage(ctx,
      '₿ <b>Crypto — Select Category</b>\n\n' +
      'Which crypto markets would you like to see?',
      {
        parse_mode: 'HTML',
        image_path: IMG_CRYPTO,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📈 Up/Down Crypto',    'crypto_updown')],
          [Markup.button.callback('₿ All Crypto Markets', 'category_crypto')],
          [Markup.button.callback('« Back',              'show_categories')],
        ]),
      }
    );
    logger.info(`Crypto subcategories shown to user: ${ctx.from?.id}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing crypto subcategories:', error);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
}
