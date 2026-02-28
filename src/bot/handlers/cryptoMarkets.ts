import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { logger } from '../../utils/logger';
import { getUpDownMarkets, formatVolume, UpDownMarket } from '../../services/market';
import { isBenignTelegramError } from '../../utils/telegram';

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMEFRAME_EMOJI: Record<string, string> = {
  '5-Minute':  '⚡',
  '15-Minute': '⏱️',
  '1-Hour':    '🕐',
  '4-Hour':    '🕓',
  'Daily':     '📅',
  'Weekly':    '📆',
};

/** Liquidity threshold below which the low-liquidity warning is shown. */
const LOW_LIQUIDITY_THRESHOLD = 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build an 8-char probability bar (Up direction). */
function probBar(p: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, p)) * 8);
  return '▓'.repeat(filled) + '░'.repeat(8 - filled);
}

/** Format an ISO date as "Feb 25, 14:35 UTC". */
function fmtDateTime(iso: string): string {
  if (!iso) return '?';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  });
  return `${date}, ${time} UTC`;
}

// ─── Level 1: Main Up/Down list grouped by timeframe ─────────────────────────

/**
 * Shows all active Up/Down crypto markets grouped by timeframe.
 * Each coin appears as an inline deep-link in the message body.
 */
export async function handleUpDownCrypto(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading…');

    const markets    = await getUpDownMarkets();
    const botUsername = ctx.botInfo?.username ?? process.env.BOT_USERNAME ?? 'PolymarketBot';

    if (markets.length === 0) {
      await ctx.editMessageText(
        '📈 *Crypto Up/Down Markets*\n\n' +
        '😔 No active Up/Down markets found right now.\n\n' +
        '_These markets are created daily on Polymarket. Try again shortly._',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh',      'crypto_updown')],
            [Markup.button.callback('« Crypto Menu',   'category_crypto_sub')],
            [Markup.button.callback('🏠 Main Menu',    'back_to_menu')],
          ]),
        }
      ).catch((e: any) => { if (!e.message?.includes('not modified')) throw e; });
      return;
    }

    // Group by timeframe, deduplicated by coin (keep first = soonest active market per coin)
    const byTimeframe = new Map<string, UpDownMarket[]>();
    for (const m of markets) {
      if (!byTimeframe.has(m.timeframe)) byTimeframe.set(m.timeframe, []);
      const existing = byTimeframe.get(m.timeframe)!;
      // Only one entry per coin per timeframe
      if (!existing.some(e => e.coin === m.coin)) existing.push(m);
    }

    let msg = `📈 *Up/Down Crypto Markets*\n\n`;

    for (const [timeframe, tfMarkets] of byTimeframe) {
      const emoji = TIMEFRAME_EMOJI[timeframe] ?? '📊';
      msg += `${emoji} *${timeframe}*\n`;
      for (const m of tfMarkets) {
        const link = `https://t.me/${botUsername}?start=updown_market_${m.marketId}`;
        msg += `└ [${m.coinName} Up or Down](${link})\n`;
      }
      msg += '\n';
    }

    await ctx.editMessageText(msg, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Refresh',    'crypto_updown'),
          Markup.button.callback('« Crypto Menu', 'category_crypto_sub'),
        ],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    }).catch((e: any) => { if (!e.message?.includes('not modified')) throw e; });

    logger.info(`[updown] Main list shown to user: ${ctx.from?.id} (${markets.length} markets)`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing up/down market list:', error);
    await ctx.reply('❌ Could not load markets. Please try again.').catch(() => {});
  }
}

// ─── Market detail view ───────────────────────────────────────────────────────

/**
 * Shows the detail page for a specific up/down market.
 * @param edit  true → editMessageText (callback/refresh), false → reply (deep link)
 */
export async function handleUpDownMarketDetail(
  ctx: Context,
  marketId: string,
  edit: boolean = true,
): Promise<void> {
  try {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('Loading…').catch(() => {});
    }

    const markets = await getUpDownMarkets();
    const m       = markets.find(x => x.marketId === marketId);

    if (!m) {
      const errMsg = '❌ Market not found. Tap below for the current list.';
      const errKb  = Markup.inlineKeyboard([
        [Markup.button.callback('📈 Up/Down Markets', 'crypto_updown')],
        [Markup.button.callback('🏠 Main Menu',       'back_to_menu')],
      ]);
      if (edit) {
        await ctx.editMessageText(errMsg, { parse_mode: 'Markdown', ...errKb })
          .catch((e: any) => { if (!e.message?.includes('not modified')) throw e; });
      } else {
        await ctx.reply(errMsg, { parse_mode: 'Markdown', ...errKb });
      }
      return;
    }

    const botUsername = ctx.botInfo?.username ?? process.env.BOT_USERNAME ?? 'PolymarketBot';
    const upPct       = (m.upPrice   * 100).toFixed(0);
    const downPct     = (m.downPrice * 100).toFixed(0);
    const bar         = probBar(m.upPrice);
    const vol         = formatVolume(m.volume24hr);
    const liq         = formatVolume(m.liquidity);
    const timeEmoji   = TIMEFRAME_EMOJI[m.timeframe] ?? '📊';

    // Build message
    let msg = `${m.coinEmoji} *${m.coinName} Up or Down*  ·  ${timeEmoji} ${m.timeframe}\n\n`;

    msg += `📊 *Current Prices*\n`;
    msg += `${bar}\n`;
    msg += `⬆️ Up:   *${upPct}¢*\n`;
    msg += `⬇️ Down: *${downPct}¢*\n\n`;

    msg += `📈 *Market Stats*\n`;
    msg += `📊 Volume (24h): ${vol}\n`;
    msg += `💧 Liquidity: ${liq}\n\n`;

    msg += `📅 *Timeline*\n`;
    if (m.startDate) msg += `▶️ Start: ${fmtDateTime(m.startDate)}\n`;
    msg += `⏹ End: ${fmtDateTime(m.endDate)}\n`;

    if (m.liquidity < LOW_LIQUIDITY_THRESHOLD) {
      msg += `\n⚠️ *Low Liquidity Warning*\n`;
      msg += `_Low liquidity — trades may significantly move the price._\n`;
    }

    if (m.slug) {
      msg += `\n🔗 [View on Polymarket](https://polymarket.com/event/${m.slug})`;
    }

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.url(`✅ Buy Up ${upPct}¢`,    `https://t.me/${botUsername}?start=trade_${m.marketId}_yes_default`),
        Markup.button.url(`❌ Buy Down ${downPct}¢`, `https://t.me/${botUsername}?start=trade_${m.marketId}_no_default`),
      ],
      [
        Markup.button.url('📝 Limit Up',   `https://t.me/${botUsername}?start=trade_${m.marketId}_yes_custom`),
        Markup.button.url('📝 Limit Down', `https://t.me/${botUsername}?start=trade_${m.marketId}_no_custom`),
      ],
      [
        Markup.button.callback('🔄 Refresh', `updown_refresh_${m.marketId}`),
        Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
      ],
    ]);

    const msgOptions = {
      parse_mode: 'Markdown' as const,
      link_preview_options: { is_disabled: true },
      ...keyboard,
    };

    if (edit) {
      await ctx.editMessageText(msg, msgOptions)
        .catch((e: any) => { if (!e.message?.includes('not modified')) throw e; });
    } else {
      await ctx.reply(msg, msgOptions);
    }

    logger.info(`[updown] Detail shown to ${ctx.from?.id}: ${m.coinName} ${m.timeframe}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error(`Error showing up/down detail for ${marketId}:`, error);
    const errMsg = '❌ Could not load market. Please try again.';
    if (edit) {
      await ctx.reply(errMsg).catch(() => {});
    } else {
      await ctx.reply(errMsg).catch(() => {});
    }
  }
}

// ─── Crypto subcategory menu ──────────────────────────────────────────────────

/**
 * Shows crypto subcategory selection.
 */
export async function handleCryptoCategory(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    await ctx.editMessageText(
      '₿ *Crypto — Select Category*\n\n' +
      'Which crypto markets would you like to see?',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📈 Up/Down Crypto',    'crypto_updown')],
          [Markup.button.callback('₿ All Crypto Markets', 'category_crypto')],
          [Markup.button.callback('« Back',              'show_categories')],
        ]),
      }
    ).catch((e: any) => { if (!e.message?.includes('not modified')) throw e; });

    logger.info(`Crypto subcategories shown to user: ${ctx.from?.id}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing crypto subcategories:', error);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
}
