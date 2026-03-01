import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getEventBySlug, searchEventsByKeyword, formatVolume, Event } from '../../services/market';
import { logger } from '../../utils/logger';
import { sendPage } from '../../utils/telegram';

// Matches polymarket.com/event/<slug> anywhere in a message
const POLYMARKET_EVENT_RE = /polymarket\.com\/event\/([a-zA-Z0-9_-]+)/i;

/**
 * Shows a short hint when user taps "🔍 Search Markets".
 * No state required — links work at any time.
 */
export async function handleSearchPrompt(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    await sendPage(ctx,
      '🔗 *Paste Event Link*\n\n' +
      'Send a Polymarket event link anytime and I\'ll show the markets ready to trade.\n\n' +
      '*Example:*\n' +
      '`https://polymarket.com/event/will-trump-be-impeached`',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back', 'back_to_menu')],
        ]),
      }
    );
  } catch (error) {
    logger.error('Error showing link prompt:', error);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
}

/**
 * Detects a Polymarket event URL in a message.
 * Returns the slug string, or null if no match.
 */
export function detectPolymarketLink(text: string): string | null {
  const match = text.match(POLYMARKET_EVENT_RE);
  return match ? match[1] : null;
}

/**
 * Fetches the event for a given slug and shows its details with trade buttons.
 * Called whenever any message contains a polymarket.com/event link.
 */
export async function handleLinkInput(ctx: Context, slug: string): Promise<void> {
  const loadingMsg = await ctx.reply('🔍 Loading event...');

  try {
    const event = await getEventBySlug(slug);

    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
    } catch { /* non-critical */ }

    if (!event) {
      await ctx.reply(
        '❌ *Event Not Found*\n\n' +
        'No active event found for this link. It may have ended or the link may be incorrect.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    const { handleEventDetails } = await import('./markets');
    await handleEventDetails(ctx, String(event.id));

  } catch (error) {
    logger.error(`Error loading event for slug "${slug}":`, error);
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
    } catch { /* non-critical */ }
    await ctx.reply('❌ Failed to load the event. Please try again.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Sanitize a user query string for display in Markdown v1 messages. */
function safeQuery(q: string): string {
  return q.replace(/[*_`[\]()~>#+=|{}.!]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** Build a compact event card for search results (Markdown v1). */
function buildSearchCard(event: Event, num: number, botUsername: string): string {
  const title = event.title
    .replace(/[*_`[\]()~>#+=|{}.!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

  const vol = formatVolume(event.volume24hr || 0);
  const liq = formatVolume(event.liquidity || 0);
  const mktCount = event.markets.length > 1 ? ` · ${event.markets.length} mkts` : '';

  // Top market price row
  let priceRow = '';
  const topMarket = [...(event.markets || [])]
    .sort((a: any, b: any) => (b.volume24hr || 0) - (a.volume24hr || 0))[0] as any;

  if (topMarket) {
    try {
      const prices = Array.isArray(topMarket.outcomePrices)
        ? topMarket.outcomePrices
        : JSON.parse(topMarket.outcomePrices || '[]');
      const outcomes = Array.isArray(topMarket.outcomes)
        ? topMarket.outcomes
        : JSON.parse(topMarket.outcomes || '[]');
      const p0 = parseFloat(prices[0]);
      const p1 = parseFloat(prices[1]);
      if (!isNaN(p0) && !isNaN(p1) && outcomes.length >= 2) {
        const filled = Math.round(Math.max(0, Math.min(1, p0)) * 8);
        const bar = '▓'.repeat(filled) + '░'.repeat(8 - filled);
        const o0 = String(outcomes[0]).slice(0, 10);
        const o1 = String(outcomes[1]).slice(0, 10);
        priceRow = `${bar}  ${o0} *${(p0 * 100).toFixed(0)}¢* · ${o1} ${(p1 * 100).toFixed(0)}¢\n`;
      }
    } catch { /* skip price row */ }
  }

  return (
    `*${num}.* 📊 ${title}\n` +
    priceRow +
    `📊 ${vol} · 💧 ${liq}${mktCount}\n` +
    `└ [Details](https://polymarket.com/event/${event.slug}) · [Trade](https://t.me/${botUsername}?start=event_${event.id})\n\n`
  );
}

// ─── Global Keyword Search ────────────────────────────────────────────────────

/**
 * Called when user types free text (not a command, not in an input-awaiting state).
 * Searches Polymarket events by keyword and shows results.
 */
export async function handleKeywordSearch(ctx: Context, query: string): Promise<void> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return; // too short — silently ignore

  const loadingMsg = await ctx.reply('🔍 Searching...');

  try {
    const events = await searchEventsByKeyword(trimmed, 5);

    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
    } catch { /* non-critical */ }

    const botUsername = (ctx.botInfo?.username) || process.env.BOT_USERNAME || 'PolymarketBot';

    if (events.length === 0) {
      await ctx.reply(
        `🔍 *No results for "${safeQuery(trimmed)}"*\n\n` +
        'No active events matched your search.\n\n' +
        '💡 Try a different keyword or browse by category.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📂 Browse Categories', 'show_categories')],
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    let message = `🔍 *Results for "${safeQuery(trimmed)}"* (${events.length})\n\n`;
    events.forEach((event, idx) => {
      message += buildSearchCard(event, idx + 1, botUsername);
    });

    // Numbered quick-open buttons
    const tradeRow = events.map((e, idx) =>
      Markup.button.callback(`${idx + 1}️⃣`, `sev_${e.id}`)
    );

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([
        tradeRow,
        [
          Markup.button.callback('📂 Categories', 'show_categories'),
          Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
        ],
      ]),
    });

  } catch (error) {
    logger.error(`[search] handleKeywordSearch error for "${trimmed}":`, error);
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
    } catch { /* non-critical */ }
    await ctx.reply('❌ Search failed. Please try again.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'back_to_menu')]]),
    });
  }
}

/**
 * /price <keyword> — Show market prices for a keyword search.
 * Delegates to handleKeywordSearch with a usage hint if no keyword given.
 */
export async function handlePriceCommand(ctx: Context, keyword: string): Promise<void> {
  const trimmed = (keyword || '').trim();
  if (trimmed.length < 2) {
    await ctx.reply(
      '📈 *Usage:* `/price <keyword>`\n\n*Example:* `/price bitcoin`',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  await handleKeywordSearch(ctx, trimmed);
}
