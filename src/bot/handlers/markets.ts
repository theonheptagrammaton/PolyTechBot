import path from 'path';
import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import {
  getTrendingEvents,
  getTopEvents,
  getEventsByCategory,
  getLiveSportsEvents,
  formatVolume,
  parseOutcomePrices,
  parseOutcomes,
  Event,
} from '../../services/market';
import { getMainMenuStats, MainMenuStats } from '../../services/portfolio';
import { getUserByTelegramId } from '../../services/user';
import { logger } from '../../utils/logger';
import { isBenignTelegramError, sendPage, getMenuPhotoMedia, cacheMenuPhotoFileId } from '../../utils/telegram';
import { ce, esc, EMOJI } from '../../utils/customEmoji';
import { config } from '../../config';

const IMG_BUSINESS     = path.join(__dirname, '../img/business.jpg');
const IMG_SMARTWALLET  = path.join(__dirname, '../img/smartwallet.jpg');
const IMG_ALLMARKETS   = path.join(__dirname, '../img/allmarkets.jpeg');
const IMG_TRENDS       = path.join(__dirname, '../img/trends.jpeg');
const IMG_POLITICS     = path.join(__dirname, '../img/politics.jpeg');
const IMG_CRYPTO       = path.join(__dirname, '../img/crypto.jpeg');
const IMG_SPORTS       = path.join(__dirname, '../img/sports.jpeg');
const IMG_GEOPOLITICS  = path.join(__dirname, '../img/geopolitics.jpeg');
const IMG_ELECTIONS    = path.join(__dirname, '../img/elections.jpg');
const IMG_POPCULTURE   = path.join(__dirname, '../img/popculture.jpg');
const IMG_SCIENCE      = path.join(__dirname, '../img/science.jpg');
const IMG_TECH         = path.join(__dirname, '../img/techbets.jpg');
const IMG_AI           = path.join(__dirname, '../img/ai.jpg');
export const IMG_COPYTRADE = path.join(__dirname, '../img/copytrade.jpg');

const CATEGORY_IMAGE: Record<string, string> = {
  'trending':    IMG_TRENDS,
  'politics':    IMG_POLITICS,
  'crypto':      IMG_CRYPTO,
  'sports':      IMG_SPORTS,
  'business':    IMG_BUSINESS,
  'all':         IMG_ALLMARKETS,
  'geopolitics': IMG_GEOPOLITICS,
  'elections':   IMG_ELECTIONS,
  'pop-culture': IMG_POPCULTURE,
  'science':     IMG_SCIENCE,
  'tech':        IMG_TECH,
  'ai':          IMG_AI,
};

// ─── OG Image helper ──────────────────────────────────────────────────────────

const _ogImageCache = new Map<string, string | null>();
const OG_IMAGE_CACHE_MAX = 200;

async function fetchOgImage(pageUrl: string): Promise<string | null> {
  if (_ogImageCache.has(pageUrl)) return _ogImageCache.get(pageUrl) ?? null;
  try {
    const axios = (await import('axios')).default;
    const r = await axios.get<string>(pageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
      timeout: 5000,
    });
    const html = typeof r.data === 'string' ? r.data : '';
    const match =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const url = match ? match[1] : null;
    if (_ogImageCache.size >= OG_IMAGE_CACHE_MAX) {
      _ogImageCache.delete(_ogImageCache.keys().next().value!);
    }
    _ogImageCache.set(pageUrl, url);
    return url;
  } catch {
    if (_ogImageCache.size >= OG_IMAGE_CACHE_MAX) {
      _ogImageCache.delete(_ogImageCache.keys().next().value!);
    }
    _ogImageCache.set(pageUrl, null);
    return null;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const EVENTS_PER_PAGE = 3;

const CATEGORY_META: Record<string, { name: string; emoji: string }> = {
  'trending':    { name: 'Trending',    emoji: '🌎' },
  'politics':    { name: 'Politics',    emoji: '🇺🇸' },
  'crypto':      { name: 'Crypto',      emoji: '🔥' },
  'sports':      { name: 'Sports',      emoji: '🏈' },
  'business':    { name: 'Finance',     emoji: '📈' },
  'pop-culture': { name: 'Pop Culture', emoji: '📹' },
  'geopolitics': { name: 'Geopolitics', emoji: '🌍' },
  'tech':        { name: 'Tech',        emoji: '💻' },
  'ai':          { name: 'AI',          emoji: '🤖' },
  'science':     { name: 'Science',     emoji: '🔬' },
  'elections':   { name: 'Elections',   emoji: '🗳️' },
  'middle-east': { name: 'Middle East', emoji: '🕌' },
  'all':         { name: 'All Markets', emoji: '📊' },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Sanitize a title so it doesn't break Telegram Markdown v1. */
function safeTitle(s: string, maxLen = 62): string {
  const cleaned = s.replace(/[*_`[\]()~>#+=|{}.!]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + '…' : cleaned;
}

/** Detect a category emoji from an event's tag list. */
function tagEmoji(tags: any[]): string {
  if (!Array.isArray(tags)) return '';
  for (const t of tags) {
    const slug = (t?.slug || '').toLowerCase();
    if (slug === 'politics' || slug === 'government') return '🏛️';
    if (slug === 'crypto') return '₿';
    if (slug === 'sports') return '⚽';
    if (slug === 'business' || slug === 'finance' || slug === 'economy') return '💼';
    if (slug === 'pop-culture' || slug === 'entertainment') return '🎬';
    if (slug === 'tech') return '💻';
    if (slug === 'science') return '🔬';
  }
  return '';
}

/** Format a number with full precision: "$10,667,418.33" */
function fmtRaw(n?: number | string): string {
  const num = typeof n === 'string' ? parseFloat(n) : (n ?? 0);
  if (!num || isNaN(num)) return '0.00';
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a date as "Jul 24, 2025" (always includes year). */
function fmtDateLong(iso?: string): string {
  if (!iso) return 'N/A';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Format end date compactly (e.g. "Jun 12" or "Dec 31, 2026"). */
function fmtEndDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() !== now.getFullYear()
      ? { month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric' };
  return d.toLocaleDateString('en-US', opts);
}

/** Build a single compact event card for the list view. */
function buildEventCard(event: Event, pageIdx: number, category: string): string {
  const num = pageIdx + 1;
  const emoji = tagEmoji((event as any).tags) || CATEGORY_META[category]?.emoji || '📊';
  const title = safeTitle(event.title);

  // First market (original Polymarket order)
  const topMarket = (event.markets || [])[0];

  let priceRow = '';
  if (topMarket) {
    const prices = parseOutcomePrices(topMarket);
    const outcomes = parseOutcomes(topMarket);
    if (prices.length >= 2 && outcomes.length >= 2) {
      const p0 = parseFloat(prices[0] || '0');
      const p1 = parseFloat(prices[1] || '0');
      if (!isNaN(p0) && !isNaN(p1)) {
        const y = (p0 * 100).toFixed(0);
        const n = (p1 * 100).toFixed(0);
        const o0 = outcomes[0].length > 10 ? outcomes[0].slice(0, 10) + '…' : outcomes[0];
        const o1 = outcomes[1].length > 10 ? outcomes[1].slice(0, 10) + '…' : outcomes[1];
        priceRow = `${o0} *${y}¢* · ${o1} ${n}¢\n`;
      }
    }
  }

  const vol = formatVolume(event.volume24hr || 0);
  const liq = formatVolume(event.liquidity || 0);
  const mktCount = event.markets.length > 1 ? ` · ${event.markets.length} markets` : '';
  const endDateStr = fmtEndDate((event as any).endDate);
  const dateStr = endDateStr ? ` · 📅 ${endDateStr}` : '';

  return (
    `*${num}.* ${emoji} ${title}\n` +
    priceRow +
    `📊 ${vol} · 💧 ${liq}${mktCount}${dateStr}\n`
  );
}

/** Fetch events for a given category string (handles 'trending' and 'all'). */
async function fetchCategoryEvents(category: string): Promise<Event[]> {
  if (category === 'trending') return getTrendingEvents(30);
  if (category === 'all')      return getTopEvents(30);
  return getEventsByCategory(category, 30);
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Shows market categories.
 */
export async function handleShowCategories(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const t = ce(EMOJI.marketsTitle, '🤑');

    await sendPage(
      ctx,
      `${t} <b>Polymarket — Browse Events</b>\n\n` +
      `Pick a category to explore prediction markets:\n\n`,
      {
        parse_mode: 'HTML',
        image_path: IMG_ALLMARKETS,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🌎 Trending',    'category_trending')],
          [
            Markup.button.callback('🇺🇸 Politics', 'category_politics'),
            Markup.button.callback('🔥 Crypto',    'category_crypto_sub'),
          ],
          [
            Markup.button.callback('🏈 Sports',      'category_sports_sub'),
            Markup.button.callback('📈 Finance',     'category_business'),
          ],
          [
            Markup.button.callback('🌍 Geopolitics', 'category_geopolitics'),
            Markup.button.callback('📹 Pop Culture', 'category_pop-culture'),
          ],
          [
            Markup.button.callback('💻 Tech',        'category_tech'),
            Markup.button.callback('🤖 AI',          'category_ai'),
          ],
          [
            Markup.button.callback('🔬 Science',     'category_science'),
            Markup.button.callback('🗳️ Elections',   'category_elections'),
          ],
          [Markup.button.callback('📊 All Markets',  'category_all')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      }
    );
  } catch (error) {
    logger.error('Error showing categories:', error);
    await ctx.reply('❌ An error occurred while loading categories. Please try again.');
  }
}

/**
 * Shows events for a category with pagination and visual event cards.
 */
export async function handleCategorySelection(ctx: Context, category: string, page: number = 1): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading...');

    const botUsername = ctx.botInfo?.username || process.env.BOT_USERNAME || 'PolymarketBot';
    const cat = CATEGORY_META[category] ?? { name: category, emoji: '📊' };

    const events = await fetchCategoryEvents(category);

    if (!events || events.length === 0) {
      await sendPage(
        ctx,
        `${cat.emoji} *${cat.name}*\n\n` +
        '😔 No active events found right now.\n\nTry another category or check back later!',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[
            Markup.button.callback('« Categories', 'show_categories'),
            Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
          ]]),
        }
      );
      return;
    }

    const totalPages = Math.ceil(events.length / EVENTS_PER_PAGE);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * EVENTS_PER_PAGE;
    const pageEvents = events.slice(startIndex, startIndex + EVENTS_PER_PAGE);

    // ── Header ────────────────────────────────────────────────────────────────
    const timeStr = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    });
    let message = `${cat.emoji} *${cat.name}* · ${timeStr} UTC\n\n`;

    // ── Event cards ───────────────────────────────────────────────────────────
    pageEvents.forEach((event, idx) => {
      message += buildEventCard(event, idx, category);
      message += `└ [Details](https://polymarket.com/event/${event.slug}) · `;
      message += `[Trade](https://t.me/${botUsername}?start=event_${event.id})\n\n`;
    });



    // ── Nav buttons ───────────────────────────────────────────────────────────
    const navRow: any[] = [];
    if (currentPage > 1) navRow.push(Markup.button.callback('◀️', `page_${category}_${currentPage - 1}`));
    navRow.push(Markup.button.callback(`· ${currentPage} / ${totalPages} ·`, 'noop'));
    if (currentPage < totalPages) navRow.push(Markup.button.callback('▶️', `page_${category}_${currentPage + 1}`));

    const buttons: any[] = [
      navRow,
      [
        Markup.button.callback('🔄 Refresh', `refresh_category_${category}`),
        Markup.button.callback('« Categories', 'show_categories'),
      ],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ];

    try {
      await sendPage(ctx, message, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        ...(CATEGORY_IMAGE[category] ? { image_path: CATEGORY_IMAGE[category] } : {}),
        ...Markup.inlineKeyboard(buttons),
      });
    } catch (editError: any) {
      if (!editError.description?.includes('message is not modified')) throw editError;
    }

    logger.info(`Category ${category} page ${currentPage} shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error(`Error showing category ${category}:`, error);
    try {
      await sendPage(
        ctx,
        '❌ *Error Loading Markets*\n\nCould not fetch markets right now. Please try again.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[
            Markup.button.callback('« Categories', 'show_categories'),
            Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
          ]]),
        }
      );
    } catch { /* ignore */ }
  }
}

/**
 * Called when user taps a numbered event button (evp_{category}_{page}_{idx}).
 * Re-fetches the cached event list and shows details for that event.
 */
export async function handleEventFromPage(
  ctx: Context,
  category: string,
  page: number,
  idx: number
): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading event…');

    const events = await fetchCategoryEvents(category);
    const startIndex = (page - 1) * EVENTS_PER_PAGE;
    const event = events[startIndex + idx];

    if (!event) {
      await ctx.reply('❌ Event not found. Try refreshing the list.');
      return;
    }

    await handleEventDetails(ctx, String(event.id), 1, category, page);
  } catch (error) {
    logger.error('Error loading event from page button:', error);
    await ctx.reply('❌ Could not load event details. Please try again.');
  }
}

/**
 * Shows event details with all markets and inline trade buttons.
 */
/**
 * Shows event details with per-market pagination.
 * Each market gets its own page with full YES/NO/Custom trade links.
 * condition_id URLs are ~120 chars each — only 1 market per page fits within 1024.
 */
export async function handleEventDetails(
  ctx: Context,
  eventId: string,
  marketPage: number = 1,
  backCategory?: string,
  backPage: number = 1,
): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Loading…').catch(() => {});

    const botUsername = ctx.botInfo?.username || process.env.BOT_USERNAME || 'PolymarketBot';
    const telegramId = ctx.from?.id.toString();
    let defaultAmount = 25;

    if (telegramId) {
      const { getUserByTelegramId } = await import('../../services/user');
      const user = await getUserByTelegramId(telegramId);
      if (user?.defaultTradeAmount) defaultAmount = user.defaultTradeAmount;
    }

    const axios = (await import('axios')).default;
    const response = await axios.get(`https://gamma-api.polymarket.com/events/${eventId}`, {
      timeout: 10000,
    });
    const event = response.data;

    if (!event) {
      await ctx.reply('❌ Event not found.');
      return;
    }

    // ── Filter & sort markets ──────────────────────────────────────────────────
    const allMarkets = (event.markets || []) as any[];
    const activeMarkets = allMarkets.filter((m: any) => {
      if (m.closed === true || m.resolved === true) return false;
      const prices = parseOutcomePrices(m);
      return prices.length > 0 && prices.every(p => {
        const v = parseFloat(p || '0');
        return v > 0.01 && v < 0.99;
      });
    });

    // Keep original API order (matches Polymarket website ordering)
    const pool = activeMarkets.length > 0 ? activeMarkets : allMarkets;
    const sortedMarkets = pool;

    const totalMarkets = sortedMarkets.length;

    const backCb     = backCategory ? `page_${backCategory}_${backPage}` : 'show_categories';
    const backSuffix = backCategory ? `_${backCategory}_${backPage}` : '';

    if (totalMarkets === 0) {
      await sendPage(ctx, `${ce(EMOJI.eventTitle, '💰')} <b>${esc(safeTitle(event.title || '', 60))}</b>\n\n<i>No active markets found.</i>`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('« Back', backCb),
          Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
        ]]),
      });
      return;
    }

    const currentPage = Math.min(Math.max(1, marketPage), totalMarkets);
    const market  = sortedMarkets[currentPage - 1];
    const marketId = market.condition_id || market.id;
    if (!marketId) {
      await ctx.reply('❌ Could not load this market.');
      return;
    }
    const q       = safeTitle(market.question || '', 65);
    const vol     = formatVolume(market.volume24hr);
    const prices  = parseOutcomePrices(market);
    const outcomes = parseOutcomes(market);

    // ── Custom emojis (only for high-visibility lines; stat-line uses plain to save caption chars)
    const eTitle     = ce(EMOJI.eventTitle,  '🌸');
    const eUp        = ce(EMOJI.priceUp,     '⬆️');
    const eDown      = ce(EMOJI.priceDown,   '⬇️');
    const eLightning = ce(EMOJI.lightning,   '⚡️');
    const eLink      = ce(EMOJI.marketsTitle,'🤑');

    // ── Market label (short descriptor for this market within a multi-market event) ──
    const mLabel = (() => {
      if (market.groupItemTitle) return market.groupItemTitle as string;
      const o0 = outcomes[0] || '';
      if (o0 && !['yes', 'no', 'true', 'false'].includes(o0.toLowerCase())) return o0;
      return null;
    })();

    // ── Event end date ────────────────────────────────────────────────────────
    const endDateStr = fmtEndDate(event.endDate);

    // ── Prices ────────────────────────────────────────────────────────────────
    let yPrice = '—', nPrice = '—';
    if (prices.length >= 2 && outcomes.length >= 2) {
      const p0 = parseFloat(prices[0] || '0');
      const p1 = parseFloat(prices[1] || '0');
      if (!isNaN(p0) && !isNaN(p1)) {
        yPrice = (p0 * 100).toFixed(1);
        nPrice = (p1 * 100).toFixed(1);
      }
    }

    const title = safeTitle(event.title || '', 60);

    // ── Build message ─────────────────────────────────────────────────────────
    // Note: caption limit is 1024 chars. Plain emojis used for stat line to stay within budget.
    let message = `${eTitle} <b>${esc(title)}</b>\n\n`;
    message += `📊Total Vol: <b>${formatVolume(event.volume24hr)}</b>`;
    message += ` • 💧Total Liq: <b>${formatVolume(event.liquidity)}</b>`;
    if (endDateStr) message += ` | ⏰${esc(endDateStr)}`;
    message += '\n\n';

    if (totalMarkets > 1) {
      const labelPart = mLabel ? ` | ${esc(mLabel)}` : '';
      message += `➡️Market ${currentPage}/${totalMarkets}${labelPart}\n\n`;
    }

    message += `- <b>${esc(q)}</b>\n\n`;
    message += `Vol: <b>${vol}</b> • Liq: <b>${formatVolume(market.liquidity)}</b>\n\n`;
    message += `${eUp}${esc(outcomes[0] || 'Yes')} <b>${yPrice}¢</b>\n`;
    message += `${eDown}${esc(outcomes[1] || 'No')} ${nPrice}¢\n\n`;

    message += `${eLightning}<a href="https://t.me/${botUsername}?start=trade_${marketId}_yes_default">YES $${defaultAmount}</a>`;
    message += ` • <a href="https://t.me/${botUsername}?start=trade_${marketId}_no_default">NO $${defaultAmount}</a>\n\n`;

    if (event.slug) message += `${eLink} <a href="https://polymarket.com/event/${event.slug}">View on Polymarket</a>`;

    // ── Keyboard ──────────────────────────────────────────────────────────────
    const buttons: any[] = [];

    // Row 1 — Navigation (only for multi-market events, arrows only)
    if (totalMarkets > 1) {
      const navRow: any[] = [];
      if (currentPage > 1)
        navRow.push(Markup.button.callback('⬅️', `evd_mkt_${event.id}_${currentPage - 1}${backSuffix}`));
      if (currentPage < totalMarkets)
        navRow.push(Markup.button.callback('➡️', `evd_mkt_${event.id}_${currentPage + 1}${backSuffix}`));
      if (navRow.length > 0) buttons.push(navRow);
    }

    // Row 2 — Buy buttons (custom amount)
    buttons.push([
      Markup.button.url(`✅ Buy YES`, `https://t.me/${botUsername}?start=trade_${marketId}_yes_custom`),
      Markup.button.url(`❌ Buy NO`,  `https://t.me/${botUsername}?start=trade_${marketId}_no_custom`),
    ]);

    // Row 4 — Single limit order button (opens YES/NO choice screen)
    buttons.push([
      Markup.button.url(`🏦 Place Limit Order`, `https://t.me/${botUsername}?start=limit_${marketId}_choice`),
    ]);

    buttons.push([
      Markup.button.callback('« Back', backCb),
      Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
    ]);

    const ogImage = event.slug
      ? await fetchOgImage(`https://polymarket.com/event/${event.slug}`)
      : null;

    await sendPage(ctx, message, {
      parse_mode: 'HTML',
      image_url: ogImage || event.image || undefined,
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Event ${eventId} market ${currentPage}/${totalMarkets} shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error(`Error showing event ${eventId}:`, error);
    await ctx.reply('❌ An error occurred while loading event details.');
  }
}

/**
 * Refresh category — clears cache then reloads.
 */
export async function handleRefreshCategory(ctx: Context, category: string, page: number = 1): Promise<void> {
  try {
    const { redisCache } = await import('../../database/redis');
    const keys = [
      `markets:trending:30`,
      `markets:top_events:30`,
      `events:category:${category}:30`,
      `events:crypto-updown:30`,
    ];
    await Promise.all(keys.map(k => redisCache.del(k)));

    await handleCategorySelection(ctx, category, page);

    try { await ctx.answerCbQuery('✅ Refreshed!'); } catch { /* already answered */ }
  } catch (error: any) {
    logger.error(`Error refreshing category ${category}:`, error);
    if (error.description?.includes('message is not modified')) {
      await ctx.answerCbQuery('✅ Already showing latest data');
    } else {
      await ctx.answerCbQuery('❌ Error refreshing');
    }
  }
}

/**
 * Back to main menu.
 */
const ZERO_STATS: MainMenuStats = { balance: '0.00', positionsValue: '0.00', ordersValue: '0.00', netWorth: '0.00' };

// parse_mode: 'HTML' — uses custom emoji tags
export function buildMainMenuText(stats: MainMenuStats = ZERO_STATS): string {
  const cherry    = ce(EMOJI.cherry,    '🌸');
  const star      = ce(EMOJI.star,      '💙');
  const arrow     = ce(EMOJI.arrow,     '💛');
  const balance   = ce(EMOJI.earnings,  '💵');
  const orders    = ce(EMOJI.money,     '💰');
  const briefcase = ce(EMOJI.briefcase, '💼');

  return (
    `${cherry} <b>PolyTech Sniper Bot</b>\n\n` +
    `${star} Let your prediction journey start with us\n\n` +
    `${arrow}<b>Positions Value:</b> $${esc(stats.positionsValue)}\n` +
    `${balance}<b>Tradable Balance:</b> $${esc(stats.balance)}\n` +
    `${orders}<b>Open Limit Orders:</b> $${esc(stats.ordersValue)}\n` +
    `${briefcase}<b>Net Worth:</b> $${esc(stats.netWorth)}\n\n` +
    `${ce(EMOJI.loading, '❓')}<b>Start To Use:</b>\n` +
    `Paste any Polymarket URL or type name to start trading instantly!`
  );
}

export function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📈 Markets', 'show_categories'),
      Markup.button.callback('🤝 Copy Trade', 'copy_list'),
    ],
    [
      Markup.button.callback('💼 Portfolio', 'portfolio'),
      Markup.button.callback('🏦 Wallet', 'wallet_page'),
    ],
    [
      Markup.button.callback('🧠 Smart Traders', 'show_wallet'),
    ],
    [
      Markup.button.callback('📊 Limit Orders', 'portfolio_orders_1'),
      Markup.button.callback('👥 Referral', 'referral_hub'),
    ],
    [
      Markup.button.callback('📁 Positions', 'portfolio_open_1'),
      Markup.button.callback('⚙️ Settings', 'settings_menu'),
    ],
    [
      Markup.button.callback('💵 PnL', 'pnl_alltime'),
      Markup.button.callback('💰 Deposit', 'wallet_page'),
    ],
    [
      Markup.button.callback('🔄 Refresh', 'back_to_menu'),
    ],
  ]);
}

export async function handleBackToMenu(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    let stats = ZERO_STATS;

    if (telegramId) {
      const user = await getUserByTelegramId(telegramId);
      if (user) {
        stats = await getMainMenuStats(
          user.encryptedPrivateKey,
          user.encryptedApiKey,
          user.encryptedApiSecret,
          user.encryptedPassphrase,
          user.polymarketProxyAddress,
          user.predexonUserId ?? undefined
        ).catch(() => ZERO_STATS);
      }
    }

    const caption     = buildMainMenuText(stats);
    const keyboard    = mainMenuKeyboard();
    const replyMarkup = (keyboard as any).reply_markup;

    const cbMsg   = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : null;
    const isPhoto = !!(cbMsg && 'photo' in cbMsg);

    if (isPhoto) {
      // Swap back to menu photo in-place — no delete, no flicker
      try {
        const result: any = await (ctx as any).editMessageMedia(
          { type: 'photo', media: getMenuPhotoMedia(), caption, parse_mode: 'HTML' },
          replyMarkup ? { reply_markup: replyMarkup } : undefined,
        );
        cacheMenuPhotoFileId(result);
        return;
      } catch (err: any) {
        if (isBenignTelegramError(err)) return;
        // editMessageMedia failed — update caption only, keep current photo
        try {
          await (ctx as any).editMessageCaption(caption, {
            parse_mode: 'HTML',
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          });
        } catch { /* ignore */ }
        return;
      }
    }

    // Not a photo message — send fresh photo (no deletion)
    const result = await ctx.replyWithPhoto(
      getMenuPhotoMedia() as any,
      { caption, parse_mode: 'HTML', ...keyboard }
    );
    cacheMenuPhotoFileId(result);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error going back to menu:', error);
  }
}

/**
 * Redirect to wallet page.
 */
export async function handleShowWallet(ctx: Context): Promise<void> {
  try {
    const { handleWalletPage } = await import('./walletPage');
    await handleWalletPage(ctx);
  } catch (error) {
    logger.error('Error showing wallet:', error);
    await ctx.reply('❌ An error occurred while fetching your wallet information.');
  }
}

// ─── Sports Subcategory ──────────────────────────────────────────────────────

/**
 * Shows sports subcategory selection: Live / All Sports.
 */
export async function handleSportsCategory(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    await sendPage(ctx,
      '🏈 <b>Sports — Select Category</b>\n\n' +
      'Which sports markets would you like to see?',
      {
        parse_mode: 'HTML',
        ...(CATEGORY_IMAGE['sports'] ? { image_path: CATEGORY_IMAGE['sports'] } : {}),
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔴 Live Sports', 'sports_live')],
          [Markup.button.callback('🏈 All Sports Markets', 'category_sports')],
          [Markup.button.callback('« Back', 'show_categories')],
        ]),
      }
    );

    logger.info(`Sports subcategories shown to user: ${ctx.from?.id}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing sports subcategories:', error);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
}

/**
 * Shows live sports events (matches happening now or within 24h).
 * Same layout as handleCategorySelection — event cards with inline deep-link text.
 */
export async function handleLiveSports(ctx: Context, page: number = 1): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Loading…').catch(() => {});

    const botUsername = ctx.botInfo?.username || process.env.BOT_USERNAME || 'PolymarketBot';
    const events = await getLiveSportsEvents(30);
    const totalPages = Math.max(1, Math.ceil(events.length / EVENTS_PER_PAGE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * EVENTS_PER_PAGE;
    const pageEvents = events.slice(startIndex, startIndex + EVENTS_PER_PAGE);

    if (events.length === 0) {
      await sendPage(ctx,
        '🔴 *Live Sports*\n\n😔 No live sports events right now\\. Check back later\\!',
        {
          parse_mode: 'MarkdownV2',
          ...(CATEGORY_IMAGE['sports'] ? { image_path: CATEGORY_IMAGE['sports'] } : {}),
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh', 'sports_live'), Markup.button.callback('« Sports', 'category_sports_sub')],
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    const timeStr = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    });
    let message = `🔴 *Live Sports* · ${timeStr} UTC\n\n`;

    pageEvents.forEach((event, idx) => {
      message += buildEventCard(event, startIndex + idx, 'sports');
      message += `└ [Details](https://polymarket.com/event/${event.slug}) · `;
      message += `[Trade](https://t.me/${botUsername}?start=event_${event.id})\n\n`;
    });

    const navRow: any[] = [];
    if (currentPage > 1) navRow.push(Markup.button.callback('◀️', `sports_live_${currentPage - 1}`));
    navRow.push(Markup.button.callback(`· ${currentPage} / ${totalPages} ·`, 'noop'));
    if (currentPage < totalPages) navRow.push(Markup.button.callback('▶️', `sports_live_${currentPage + 1}`));

    const buttons: any[] = [
      navRow,
      [
        Markup.button.callback('🔄 Refresh', 'sports_live'),
        Markup.button.callback('« Sports', 'category_sports_sub'),
      ],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ];

    try {
      await sendPage(ctx, message, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        ...(CATEGORY_IMAGE['sports'] ? { image_path: CATEGORY_IMAGE['sports'] } : {}),
        ...Markup.inlineKeyboard(buttons),
      });
    } catch (editError: any) {
      if (!editError.description?.includes('message is not modified')) throw editError;
    }

    logger.info(`[liveSports] Page ${currentPage}/${totalPages} shown to user: ${ctx.from?.id} (${events.length} events)`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error showing live sports:', error);
    await ctx.reply('❌ Could not load live sports. Please try again.').catch(() => {});
  }
}


// ─── Discover Traders / Smart Wallets ─────────────────────────────────────────

const WALLETS_PER_PAGE = 5;

const SW_CAT_META: Record<string, { label: string; emoji: string }> = {
  'all':           { label: 'All Markets',   emoji: '🌍' },
  'politics':      { label: 'Politics',      emoji: '🏛' },
  'sports':        { label: 'Sports',        emoji: '🥇' },
  'crypto':        { label: 'Crypto',        emoji: '🌙' },
  'culture':       { label: 'Entertainment', emoji: '🎬' },
  'tech':          { label: 'Tech',          emoji: '💻' },
  'ai':            { label: 'AI',            emoji: '🤖' },
  'finance':       { label: 'Finance',       emoji: '💵' },
  'geopolitics':   { label: 'Geopolitics',   emoji: '🌍' },
};

/**
 * Maps category key → specialty labels produced by deriveSpecialties() in smartWallets service.
 * A trader is included if ANY of their specialties is in this list.
 */
const SW_CAT_SPECIALTIES: Record<string, string[]> = {
  'politics':    ['🏛️ Politics'],
  'sports':      ['⚽ Sports', '🎮 E-Sports'],
  'crypto':      ['₿ Crypto'],
  'culture':     ['🎬 Entertainment'],
  'tech':        ['💻 Tech', '🤖 AI'],
  'ai':          ['🤖 AI', '💻 Tech'],
  'finance':     ['💵 Finance'],
  'geopolitics': ['🌍 Geopolitics'],
};

const SW_SORT_META: Record<string, { label: string; api: 'PNL' | 'VOL' }> = {
  'pnl': { label: 'by P&L',    api: 'PNL' },
  'vol': { label: 'by Volume', api: 'VOL' },
};

const SW_PERIOD_META: Record<string, { label: string; api: 'DAY' | 'WEEK' | 'MONTH' | 'ALL' }> = {
  'month': { label: 'Last Month', api: 'MONTH' },
  'week':  { label: 'Last Week',  api: 'WEEK'  },
  'all':   { label: 'All Time',   api: 'ALL'   },
};

export async function handleSmartWallets(
  ctx: Context,
  category = 'all',
  sort = 'pnl',
  page = 1,
  period = 'month',
): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const { getTopSmartWallets, fmtUsd } = await import('../../services/smartWallets');
    const sortMeta   = SW_SORT_META[sort]     ?? SW_SORT_META['pnl'];
    const catMeta    = SW_CAT_META[category]  ?? SW_CAT_META['all'];
    const periodMeta = SW_PERIOD_META[period] ?? SW_PERIOD_META['month'];

    const allWallets = await getTopSmartWallets(50, periodMeta.api, sortMeta.api);

    // Post-filter by specialties for specific categories
    let filtered = allWallets;
    if (category !== 'all' && SW_CAT_SPECIALTIES[category]) {
      const targetSpecs = SW_CAT_SPECIALTIES[category];
      const bySpec = allWallets.filter(w =>
        (w.specialties ?? [w.specialty]).some(s => targetSpecs.includes(s))
      );
      // Only fall back to all wallets if we got zero matches
      filtered = bySpec.length > 0 ? bySpec : allWallets;
    }

    const totalPages  = Math.max(1, Math.ceil(filtered.length / WALLETS_PER_PAGE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIdx    = (currentPage - 1) * WALLETS_PER_PAGE;
    const pageWallets = filtered.slice(startIdx, startIdx + WALLETS_PER_PAGE);

    const botUsername = config.telegram.botUsername;

    let msg = `🏆 <b>Discover Traders</b>\n\n`;
    msg += `${catMeta.emoji} ${esc(catMeta.label)} · ${sortMeta.label} · ${periodMeta.label}\n\n`;

    if (pageWallets.length === 0) {
      msg += 'No traders found for this filter.';
    } else {
      for (const [i, w] of pageWallets.entries()) {
        const rank    = startIdx + i + 1;
        const pnlSign = w.pnlAbs >= 0 ? '+' : '';
        const copyUrl = `https://t.me/${botUsername}?start=copy_${w.address}`;
        const viewUrl = `https://polymarket.com/profile/${w.address}`;
        const name    = esc(w.displayName.slice(0, 25));

        msg += `${rank}. ${name}\n`;
        msg += `   ├ P&L: ${pnlSign}${fmtUsd(w.pnlAbs)} · Vol: ${fmtUsd(w.volume)}\n`;
        msg += `   └ <a href="${copyUrl}">Copy</a> · <a href="${viewUrl}">View</a>\n\n`;
      }
    }

    const prevCb = currentPage > 1        ? `sw_${currentPage - 1}_${category}_${sort}_${period}` : 'noop';
    const nextCb = currentPage < totalPages ? `sw_${currentPage + 1}_${category}_${sort}_${period}` : 'noop';

    await sendPage(ctx, msg, {
      parse_mode: 'HTML',
      image_path: IMG_SMARTWALLET,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('◀️ Prev', prevCb),
          Markup.button.callback(`${currentPage}/${totalPages}`, 'noop'),
          Markup.button.callback('Next ▶️', nextCb),
        ],
        [
          Markup.button.callback('📁 Category', `sw_fc_${category}_${sort}_${period}`),
          Markup.button.callback('📊 Sort',      `sw_fs_${category}_${sort}_${period}`),
          Markup.button.callback('🕐 Period',    `sw_ft_${category}_${sort}_${period}`),
        ],
        [
          Markup.button.url('📈 Polymarket Analytics', 'https://polymarketanalytics.com/traders'),
          Markup.button.url('📂 Predictfolio',         'https://predictfolio.com'),
        ],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    });

    logger.info(`[smartWallets] Page ${currentPage}/${totalPages} cat=${category} sort=${sort} period=${period}`);
  } catch (err) {
    logger.error('[smartWallets] handleSmartWallets error:', err);
    await ctx.reply('❌ An error occurred loading Smart Wallets. Please try again.');
  }
}

export async function handleSwCategoryFilter(
  ctx: Context,
  cat: string,
  sort: string,
  period = 'month',
): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});

  const catRows = [
    ['all', 'politics'],
    ['sports', 'crypto'],
    ['culture', 'tech'],
    ['ai', 'finance'],
    ['geopolitics'],
  ];

  const buttons: any[] = catRows.map(row =>
    row.map(c => {
      const meta  = SW_CAT_META[c] ?? { label: c, emoji: '' };
      const label = c === cat ? `✓ ${meta.emoji} ${meta.label}` : `${meta.emoji} ${meta.label}`;
      const cb    = c === cat ? 'noop' : `sw_1_${c}_${sort}_${period}`;
      return Markup.button.callback(label, cb);
    })
  );
  buttons.push([
    Markup.button.callback('⬅️ Back', `sw_1_${cat}_${sort}_${period}`),
    Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
  ]);

  await sendPage(ctx,
    `📁 <b>Category</b>\n\nFilter traders by market category:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
}

export async function handleSwSortFilter(
  ctx: Context,
  cat: string,
  sort: string,
  period = 'month',
): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});

  const sortRow = (['pnl', 'vol'] as const).map(s => {
    const meta  = SW_SORT_META[s];
    const label = s === sort ? `✓ ${meta.label}` : meta.label;
    const cb    = s === sort ? 'noop' : `sw_1_${cat}_${s}_${period}`;
    return Markup.button.callback(label, cb);
  });

  await sendPage(ctx,
    `📊 <b>Sort By</b>\n\nSelect how to rank traders:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        sortRow,
        [
          Markup.button.callback('⬅️ Back', `sw_1_${cat}_${sort}_${period}`),
          Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
        ],
      ]),
    }
  );
}

export async function handleSwTimePeriodFilter(
  ctx: Context,
  cat: string,
  sort: string,
  period: string,
): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});

  const periodRows = Object.entries(SW_PERIOD_META).map(([key, meta]) => [
    Markup.button.callback(
      key === period ? `✓ ${meta.label}` : meta.label,
      key === period ? 'noop' : `sw_1_${cat}_${sort}_${key}`,
    ),
  ]);
  periodRows.push([
    Markup.button.callback('⬅️ Back', `sw_1_${cat}_${sort}_${period}`),
    Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
  ]);

  await sendPage(ctx,
    `🕐 <b>Time Period</b>\n\nSelect the leaderboard time window:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(periodRows) }
  );
}

/**
 * @deprecated Use handleEventDetails instead.
 */
export async function handleMarketDetails(ctx: Context, marketId: string): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading...');
    const { getMarketDetails, formatPrice } = await import('../../services/market');
    const market = await getMarketDetails(marketId);

    if (!market) {
      await ctx.reply('❌ Market not found.');
      return;
    }

    let message = `📊 *Market Details*\n\n*${safeTitle(market.question, 80)}*\n\n`;
    message += `📊 24h Vol: *${formatVolume(market.volume24hr)}* · Liq: *${formatVolume(market.liquidity)}*\n`;
    message += `📅 Ends: ${fmtEndDate(market.endDate)}\n\n`;

    const prices = parseOutcomePrices(market);
    const outcomes = parseOutcomes(market);
    if (prices.length > 0 && outcomes.length > 0) {
      message += `*Odds:*\n`;
      outcomes.forEach((o, i) => {
        if (prices[i]) message += `• ${o}: ${formatPrice(prices[i])}\n`;
      });
    }

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'show_categories')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    });
  } catch (error) {
    logger.error(`Error showing market ${marketId}:`, error);
    await ctx.reply('❌ An error occurred while loading market details.');
  }
}

/**
 * Full market detail + trade page.
 * Opened via deep link: /start mkt_<conditionId>
 * Shows prices, stats, timeline with custom emojis and event photo.
 */
export async function handleMarketTradePage(ctx: Context, marketId: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Loading…').catch(() => {});

    const botUsername = ctx.botInfo?.username || process.env.BOT_USERNAME || 'PolymarketBot';
    const telegramId  = ctx.from?.id.toString();
    let defaultAmount = 25;

    if (telegramId) {
      const user = await getUserByTelegramId(telegramId);
      if (user?.defaultTradeAmount) defaultAmount = user.defaultTradeAmount;
    }

    const axios = (await import('axios')).default;
    let market: any = null;
    try {
      const r = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, { timeout: 10000 });
      market = r.data;
    } catch {
      try {
        const r = await axios.get('https://gamma-api.polymarket.com/markets', {
          params: { conditionId: marketId, limit: 1 },
          timeout: 10000,
        });
        const data = r.data;
        market = Array.isArray(data) ? data[0] : data;
      } catch {
        // both attempts failed
      }
    }

    if (!market) {
      await ctx.reply('❌ Market not found.');
      return;
    }

    // ── Custom emojis ────────────────────────────────────────────────────────
    const eTitle = ce(EMOJI.eventTitle, '💰');
    const eUp    = ce(EMOJI.priceUp,    '⬆️');
    const eDown  = ce(EMOJI.priceDown,  '⬇️');
    const eStats = ce(EMOJI.eventStats, '📈');

    // ── Prices ───────────────────────────────────────────────────────────────
    const prices   = parseOutcomePrices(market);
    const outcomes = parseOutcomes(market);
    const p0 = parseFloat(prices[0] || '0');
    const p1 = parseFloat(prices[1] || '0');
    const yPrice = !isNaN(p0) ? (p0 * 100).toFixed(1) : '—';
    const nPrice = !isNaN(p1) ? (p1 * 100).toFixed(1) : '—';
    const o0 = esc(outcomes[0] || 'YES');
    const o1 = esc(outcomes[1] || 'NO');

    // ── Stats ────────────────────────────────────────────────────────────────
    const volAll = fmtRaw(market.volume ?? market.volumeNum);
    const vol24h = fmtRaw(market.volume24hr);
    const liq    = fmtRaw(market.liquidity);

    // ── Timeline ─────────────────────────────────────────────────────────────
    const createdIso = market.startDate || market.createdAt;
    const createdStr = fmtDateLong(createdIso);
    const ageDays    = createdIso
      ? Math.floor((Date.now() - new Date(createdIso).getTime()) / 86_400_000)
      : null;
    const expiresStr = fmtDateLong(market.endDate);

    // ── Image (OG preview from Polymarket link share) ─────────────────────────
    const eventSlug: string | undefined = market.event?.slug ?? market.events?.[0]?.slug;
    const ogImage = eventSlug
      ? await fetchOgImage(`https://polymarket.com/event/${eventSlug}`)
      : null;
    const eventImage: string | undefined =
      ogImage || market.event?.image || market.events?.[0]?.image || market.image || undefined;

    // ── Message ──────────────────────────────────────────────────────────────
    const title = safeTitle(market.question, 80);

    let message = `${eTitle} <b>${esc(title)}</b>\n\n`;

    message += `📊 <b>Current Prices</b>\n`;
    message += `├ ${eUp}${o0}: <b>${yPrice}¢</b>\n`;
    message += `└ ${eDown}${o1}: <b>${nPrice}¢</b>\n\n`;

    message += `${eStats} <b>Market Stats</b>\n`;
    message += `├ Volume (All): <b>$${volAll}</b>\n`;
    message += `├ Volume (24h): <b>$${vol24h}</b>\n`;
    message += `└ Liquidity: <b>$${liq}</b>\n\n`;

    message += `📅 <b>Timeline</b>\n`;
    if (createdStr !== 'N/A') {
      message += `├ Created: ${createdStr}${ageDays !== null ? ` (${ageDays} days)` : ''}\n`;
    }
    message += `└ Expires: ${expiresStr}`;

    // ── Keyboard ─────────────────────────────────────────────────────────────
    const eventId = market.event?.id ?? market.events?.[0]?.id;
    const backBtn = eventId && /^\d+$/.test(String(eventId))
      ? Markup.button.callback('← Back to Event', `evd_mkt_${eventId}_1`)
      : Markup.button.callback('« Markets', 'show_categories');

    const isClosed = market.closed === true || market.resolved === true;
    if (isClosed) {
      message += `\n\n⚠️ <i>This market is closed/resolved. Trading is no longer available.</i>`;
    }

    const tradeRows = isClosed ? [] : [
      [
        Markup.button.url(`✅ YES $${defaultAmount}`, `https://t.me/${botUsername}?start=trade_${marketId}_yes_default`),
        Markup.button.url(`❌ NO $${defaultAmount}`,  `https://t.me/${botUsername}?start=trade_${marketId}_no_default`),
      ],
      [
        Markup.button.url(`📋 Limit YES`, `https://t.me/${botUsername}?start=limit_${marketId}_yes`),
        Markup.button.url(`📋 Limit NO`,  `https://t.me/${botUsername}?start=limit_${marketId}_no`),
      ],
      [Markup.button.url('💬 Custom Trade', `https://t.me/${botUsername}?start=trade_${marketId}_custom`)],
    ];

    await sendPage(ctx, message, {
      parse_mode: 'HTML',
      image_url: eventImage,
      ...Markup.inlineKeyboard([
        ...tradeRows,
        [backBtn, Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    });

    logger.info(`Market trade page for ${marketId} shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error(`Error showing market trade page ${marketId}:`, error);
    await ctx.reply('❌ An error occurred while loading market details.');
  }
}
