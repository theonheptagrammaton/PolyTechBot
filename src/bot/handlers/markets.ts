import fs from 'fs';
import path from 'path';
import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import {
  getTrendingEvents,
  getTopEvents,
  getEventsByCategory,
  formatVolume,
  parseOutcomePrices,
  parseOutcomes,
  Event,
} from '../../services/market';
import { getMainMenuStats, MainMenuStats } from '../../services/portfolio';
import { getUserByTelegramId } from '../../services/user';
import { logger } from '../../utils/logger';
import { isBenignTelegramError, sendPage, editOrReply } from '../../utils/telegram';
import { ce, esc, EMOJI } from '../../utils/customEmoji';
import { config } from '../../config';

// ─── Constants ────────────────────────────────────────────────────────────────

const EVENTS_PER_PAGE = 5;

const CATEGORY_META: Record<string, { name: string; emoji: string }> = {
  'trending':    { name: 'Trending',    emoji: '🌎' },
  'politics':    { name: 'Politics',    emoji: '🇺🇸' },
  'crypto':      { name: 'Crypto',      emoji: '🔥' },
  'sports':      { name: 'Sports',      emoji: '🏈' },
  'business':    { name: 'Business',    emoji: '📈' },
  'pop-culture': { name: 'Pop Culture', emoji: '📹' },
  'all':         { name: 'All Markets', emoji: '📊' },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a visual probability bar (8 chars wide). */
function probBar(probability: number): string {
  const n = 8;
  const filled = Math.round(Math.max(0, Math.min(1, probability)) * n);
  return '▓'.repeat(filled) + '░'.repeat(n - filled);
}

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

  // Top market by volume
  const topMarket = [...(event.markets || [])]
    .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0))[0];

  let priceRow = '';
  if (topMarket) {
    const prices = parseOutcomePrices(topMarket);
    const outcomes = parseOutcomes(topMarket);
    if (prices.length >= 2 && outcomes.length >= 2) {
      const p0 = parseFloat(prices[0] || '0');
      const p1 = parseFloat(prices[1] || '0');
      if (!isNaN(p0) && !isNaN(p1)) {
        const bar = probBar(p0);
        const y = (p0 * 100).toFixed(0);
        const n = (p1 * 100).toFixed(0);
        const o0 = outcomes[0].length > 10 ? outcomes[0].slice(0, 10) + '…' : outcomes[0];
        const o1 = outcomes[1].length > 10 ? outcomes[1].slice(0, 10) + '…' : outcomes[1];
        priceRow = `${bar}  ${o0} *${y}¢* · ${o1} ${n}¢\n`;
      }
    }
  }

  const vol = formatVolume(event.volume24hr || 0);
  const liq = formatVolume(event.liquidity || 0);
  const mktCount = event.markets.length > 1 ? ` · ${event.markets.length} mkts` : '';
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
    await ctx.answerCbQuery();

    const t = ce(EMOJI.marketsTitle, '🤑');

    await sendPage(
      ctx,
      `${t} <b>Polymarket — Browse Events</b>\n\n` +
      `Pick a category to explore prediction markets:\n\n`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🌎 Trending',    'category_trending')],
          [
            Markup.button.callback('🇺🇸 Politics', 'category_politics'),
            Markup.button.callback('🔥 Crypto',    'category_crypto_sub'),
          ],
          [
            Markup.button.callback('🏈 Sports',      'category_sports'),
            Markup.button.callback('📈 Business',    'category_business'),
          ],
          [Markup.button.callback('📹 Pop Culture', 'category_pop-culture')],
          [Markup.button.callback('📊 All Markets',  'category_all')],
          [Markup.button.callback('« Back', 'back_to_menu')],
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
          ...Markup.inlineKeyboard([[Markup.button.callback('« Categories', 'show_categories')]]),
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
      // Deep link to event details
      message += `└ [Details](https://polymarket.com/event/${event.slug}) · `;
      message += `[Trade](https://t.me/${botUsername}?start=event_${event.id})\n\n`;
    });

    // ── Numbered quick-trade buttons ──────────────────────────────────────────
    const tradeRow: any[] = pageEvents.map((_, idx) =>
      Markup.button.callback(
        `${startIndex + idx + 1}️⃣`,
        `evp_${category}_${currentPage}_${idx}`
      )
    );

    // ── Nav buttons ───────────────────────────────────────────────────────────
    const navRow: any[] = [];
    if (currentPage > 1) navRow.push(Markup.button.callback('◀️', `page_${category}_${currentPage - 1}`));
    navRow.push(Markup.button.callback(`· ${currentPage} / ${totalPages} ·`, 'noop'));
    if (currentPage < totalPages) navRow.push(Markup.button.callback('▶️', `page_${category}_${currentPage + 1}`));

    const buttons: any[] = [
      tradeRow,
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
          ...Markup.inlineKeyboard([[Markup.button.callback('« Categories', 'show_categories')]]),
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

    await handleEventDetails(ctx, String(event.id));
  } catch (error) {
    logger.error('Error loading event from page button:', error);
    await ctx.reply('❌ Could not load event details. Please try again.');
  }
}

/**
 * Shows event details with all markets and inline trade buttons.
 */
export async function handleEventDetails(ctx: Context, eventId: string): Promise<void> {
  try {
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

    // ── Header ────────────────────────────────────────────────────────────────
    const title = safeTitle(event.title, 80);
    let message = `📊 *${title}*\n\n`;

    if (event.description) {
      const desc = event.description.slice(0, 180);
      message += `${desc}${event.description.length > 180 ? '…' : ''}\n\n`;
    }

    message +=
      `📊 24h Vol: *${formatVolume(event.volume24hr)}* · ` +
      `Total: *${formatVolume(event.volume)}* · ` +
      `Liq: *${formatVolume(event.liquidity)}*\n\n`;

    // ── Markets ───────────────────────────────────────────────────────────────
    const allMarkets = (event.markets || []) as any[];
    const withVolume = allMarkets.filter((m: any) => (m.volume24hr || 0) > 0);
    const sortedMarkets = (withVolume.length > 0 ? withVolume : allMarkets)
      .sort((a: any, b: any) => (b.volume24hr || 0) - (a.volume24hr || 0))
      .slice(0, 8);

    if (sortedMarkets.length > 0) {
      message += `*Markets (${sortedMarkets.length}):*\n\n`;

      sortedMarkets.forEach((market: any, idx: number) => {
        const prices = parseOutcomePrices(market);
        const outcomes = parseOutcomes(market);
        const q = safeTitle(market.question, 70);
        const vol = formatVolume(market.volume24hr);
        const marketId = market.condition_id || market.id;

        message += `${idx + 1}. *${q}*\n`;

        if (prices.length >= 2 && outcomes.length >= 2) {
          const p0 = parseFloat(prices[0] || '0');
          const p1 = parseFloat(prices[1] || '0');
          if (!isNaN(p0) && !isNaN(p1)) {
            const bar = probBar(p0);
            const y = (p0 * 100).toFixed(1);
            const n = (p1 * 100).toFixed(1);
            message += `${bar}  ${outcomes[0]} *${y}¢* · ${outcomes[1]} ${n}¢\n`;
          }
        }

        message += `📊 ${vol}`;
        message += `  [YES $${defaultAmount}](https://t.me/${botUsername}?start=trade_${marketId}_yes_default)`;
        message += ` · [NO $${defaultAmount}](https://t.me/${botUsername}?start=trade_${marketId}_no_default)`;
        message += ` · [Custom](https://t.me/${botUsername}?start=trade_${marketId}_custom)\n\n`;
      });

      if ((event.markets?.length || 0) > 8) {
        message += `_…and ${event.markets.length - 8} more markets_\n\n`;
      }
    }

    message += `🔗 [View on Polymarket](https://polymarket.com/event/${event.slug})`;

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    });

    logger.info(`Event ${eventId} details shown to user: ${ctx.from?.id}`);
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
const MENU_IMAGE = path.join(__dirname, '../img/beattheodds.JPG');
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
    `❓<b>Start To Use:</b>\n` +
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
      Markup.button.callback('📁 Portfolio', 'portfolio'),
      Markup.button.callback('👛 Wallet', 'wallet_page'),
    ],
    [
      Markup.button.callback('🔓 Smart Wallets', 'show_wallet'),
      Markup.button.callback('🔄 Refresh', 'back_to_menu'),
    ],
    [
      Markup.button.callback('💰 Limit Orders', 'portfolio_orders_1'),
      Markup.button.callback('👥 Referral', 'referral_hub'),
    ],
    [
      Markup.button.callback('💼 Active Positions', 'portfolio_open_1'),
      Markup.button.callback('⚙️ Settings', 'settings_menu'),
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
          user.polymarketProxyAddress
        ).catch(() => ZERO_STATS);
      }
    }

    const caption     = buildMainMenuText(stats);
    const keyboard    = mainMenuKeyboard();
    const replyMarkup = (keyboard as any).reply_markup;

    // If current message is already a photo → only update caption + keyboard (no re-download)
    const cbMsg   = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : null;
    const isPhoto = !!(cbMsg && 'photo' in cbMsg);

    if (isPhoto) {
      try {
        await (ctx as any).editMessageCaption(caption, {
          parse_mode: 'HTML',
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        return;
      } catch (err: any) {
        if (isBenignTelegramError(err)) return;
        // fall through to delete+send
      }
    }

    // Coming from a text page — delete it and send a fresh photo
    await ctx.deleteMessage().catch(() => {});
    await ctx.replyWithPhoto(
      { source: fs.createReadStream(MENU_IMAGE) },
      { caption, parse_mode: 'HTML', ...keyboard }
    );
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

// ─── Smart Wallets ─────────────────────────────────────────────────────────────

// Update these URLs to match the exact sites you want to link to
const PREDICTFOLIO_URL    = 'https://predictfolio.com/';
const POLYMARKET_ANALYTICS_URL = 'https://polymarketanalytics.com/traders';


export async function handleSmartWallets(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Loading...').catch(() => {});

    const { getTopSmartWallets, fmtUsd } = await import('../../services/smartWallets');
    const wallets = await getTopSmartWallets(10);

    if (wallets.length === 0) {
      await editOrReply(ctx,
        '🏦 *Smart Wallets*\n\n' +
        '❌ Polymarket leaderboard could not be fetched right now.\n\n' +
        'Try again in a moment or discover top traders via the links below.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.url('📊 PredictFolio', PREDICTFOLIO_URL),
              Markup.button.url('📈 Analytics', POLYMARKET_ANALYTICS_URL),
            ],
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        } as any
      );
      return;
    }

    const botUsername = config.telegram.botUsername;
    const medals = ['🥇', '🥈', '🥉'];

    let msg =
      '🏦 *Smart Wallets — All-Time Top 10*\n' +
      '_Polymarket Official Leaderboard · Refreshes every 5 min_\n\n';

    for (const [i, w] of wallets.entries()) {
      const rank       = i + 1;
      const medal      = medals[i] ?? `${rank}.`;
      const pnlAbs        = w.pnlAbs          ?? 0;
      const pnlPct        = w.pnlPct          ?? 0;
      const vol           = w.volume          ?? 0;
      const tradeCount    = w.tradeCount      ?? 0;
      const avgSize       = w.avgTradeSizeUsd ?? 0;
      const pnlSign       = pnlAbs >= 0 ? '+' : '';
      const pnlEmoji      = pnlAbs >= 0 ? '📈' : '📉';
      const short         = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
      const deepLink      = `https://t.me/${botUsername}?start=copy_${w.address}`;

      msg += `${medal} *${w.displayName.slice(0, 20)}* \`${short}\`\n`;
      msg += `   ${w.specialty ?? '📊 General'}\n`;
      msg += `   ${pnlEmoji} PnL: *${pnlSign}${fmtUsd(pnlAbs)}* (${pnlSign}${pnlPct}%) · 📊 Vol: ${fmtUsd(vol)}\n`;
      msg += `   🔄 ${tradeCount} trades · 💵 Avg: ${fmtUsd(avgSize)}\n`;
      msg += `   [▶ Copy Trade](${deepLink})\n\n`;
    }

    await editOrReply(ctx, msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [
          Markup.button.url('📊 PredictFolio', PREDICTFOLIO_URL),
          Markup.button.url('📈 PolyMarket Analytics', POLYMARKET_ANALYTICS_URL),
        ],
        [Markup.button.callback('🔄 Refresh', 'show_wallet')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    } as any);

    logger.info(`[smartWallets] Detailed page shown, ${wallets.length} wallets`);
  } catch (err) {
    logger.error('[smartWallets] handleSmartWallets error:', err);
    await ctx.reply('❌ An error occurred loading Smart Wallets. Please try again.');
  }
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
