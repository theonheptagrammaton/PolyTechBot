import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getEventBySlug, searchEventsByKeyword, formatVolume, Event } from '../../services/market';
import { logger } from '../../utils/logger';
import { sendPage } from '../../utils/telegram';
import { getUserByTelegramId } from '../../services/user';
import { t, Locale } from '../../i18n';
import { isGroupChat, dmDeepLinkUrlSync } from '../utils/chatType';
import { config } from '../../config';

/** Get locale from user object */
function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

/** Try to resolve locale for the current context user */
async function resolveLocale(ctx: Context): Promise<Locale> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (telegramId) {
      const user = await getUserByTelegramId(telegramId);
      if (user) return getLang(user);
    }
  } catch { /* fallback to 'en' */ }
  return 'en';
}

// Matches polymarket.com/event/<slug> anywhere in a message
const POLYMARKET_EVENT_RE = /polymarket\.com\/event\/([a-zA-Z0-9_-]+)/i;

/**
 * Shows a short hint when user taps "🔍 Search Markets".
 * No state required — links work at any time.
 */
export async function handleSearchPrompt(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const lang = await resolveLocale(ctx);

    await sendPage(ctx,
      t(lang, 'search.prompt'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.back'), 'back_to_menu')],
        ]),
      }
    );
  } catch (error) {
    logger.error('Error showing link prompt:', error);
    await ctx.reply(t('en', 'common.error'));
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
  const lang = await resolveLocale(ctx);
  const loadingMsg = await ctx.reply(t(lang, 'search.loading'));

  try {
    const event = await getEventBySlug(slug);

    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
    } catch { /* non-critical */ }

    if (!event) {
      const inGroup = isGroupChat(ctx);
      const botUsername = ctx.botInfo?.username || config.telegram.botUsername || 'PolyTechBot';
      const kb = inGroup
        ? Markup.inlineKeyboard([[
            Markup.button.url(t(lang, 'group.cta.openDm'), dmDeepLinkUrlSync(botUsername)),
          ]])
        : Markup.inlineKeyboard([[
            Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu'),
          ]]);
      await ctx.reply(t(lang, 'search.eventNotFound'), { parse_mode: 'Markdown', ...kb });
      return;
    }

    const { handleEventDetails } = await import('./markets');
    await handleEventDetails(ctx, String(event.id));

  } catch (error) {
    logger.error(`Error loading event for slug "${slug}":`, error);
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
    } catch { /* non-critical */ }
    await ctx.reply(t(lang, 'search.failed'), {
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
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

  const lang = await resolveLocale(ctx);
  const loadingMsg = await ctx.reply(t(lang, 'search.searching'));

  try {
    const events = await searchEventsByKeyword(trimmed, 5);

    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
    } catch { /* non-critical */ }

    const botUsername = (ctx.botInfo?.username) || process.env.BOT_USERNAME || 'PolymarketBot';

    const inGroup = isGroupChat(ctx);

    if (events.length === 0) {
      const emptyKb = inGroup
        ? Markup.inlineKeyboard([[
            Markup.button.url(t(lang, 'group.cta.openDm'), dmDeepLinkUrlSync(botUsername)),
          ]])
        : Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'btn.categories'), 'show_categories')],
            [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
          ]);
      await ctx.reply(
        t(lang, 'search.noResults', { query: safeQuery(trimmed) }),
        { parse_mode: 'Markdown', ...emptyKb }
      );
      return;
    }

    let message = `🔍 *${t(lang, 'Results for "{{query}}"', { query: safeQuery(trimmed) })}* (${events.length})\n\n`;
    events.forEach((event, idx) => {
      message += buildSearchCard(event, idx + 1, botUsername);
    });

    // In private chats we use callback buttons (open event inline).
    // In group chats we use URL deep-links so the full event opens in DM
    // for the user who taps — no shared-chat callback surface.
    const tradeRow = inGroup
      ? events.map((e, idx) =>
          Markup.button.url(`${idx + 1}️⃣`, `https://t.me/${botUsername}?start=event_${e.id}`)
        )
      : events.map((e, idx) => Markup.button.callback(`${idx + 1}️⃣`, `sev_${e.id}`));

    const footerRow = inGroup
      ? [Markup.button.url(t(lang, 'group.cta.openDm'), dmDeepLinkUrlSync(botUsername))]
      : [
          Markup.button.callback(t(lang, '📂 Categories'), 'show_categories'),
          Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu'),
        ];

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([tradeRow, footerRow]),
    });

  } catch (error) {
    logger.error(`[search] handleKeywordSearch error for "${trimmed}":`, error);
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
    } catch { /* non-critical */ }
    await ctx.reply(t('en', 'search.searchFailed'), {
      ...Markup.inlineKeyboard([[Markup.button.callback(t('en', 'btn.mainMenu'), 'back_to_menu')]]),
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
    const lang = await resolveLocale(ctx);
    await ctx.reply(
      t(lang, 'search.priceUsage'),
      { parse_mode: 'Markdown' }
    );
    return;
  }
  await handleKeywordSearch(ctx, trimmed);
}
