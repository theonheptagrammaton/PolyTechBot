import { Context, Markup } from 'telegraf';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import {
  getEventsByCategory,
  parseOutcomePrices,
  parseOutcomes,
  formatVolume,
  Event,
} from '../../services/market';
import { isBenignTelegramError } from '../../utils/telegram';

// Non-sports Polymarket categories to sample from
const NON_SPORTS_CATEGORIES = [
  'politics',
  'business',
  'geopolitics',
  'pop-culture',
  'tech',
  'ai',
  'science',
  'elections',
  'middle-east',
];

// Picked market must have NO side in this price range (ignores near-resolved markets)
const MIN_NO_PRICE = 0.05;
const MAX_NO_PRICE = 0.95;
const MIN_VOLUME   = 1_000;

interface NoCandidate {
  marketId: string;   // numeric Gamma ID (safe for callback/URL data)
  question: string;
  slug: string;
  eventSlug: string;
  noPrice: number;
  endDate: string;
  volume: number;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtExpires(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'UTC',
  }) + ' UTC';
}

function collectNoCandidates(events: Event[]): NoCandidate[] {
  const out: NoCandidate[] = [];
  for (const ev of events) {
    const eventSlug = (ev as any).slug ?? '';
    for (const m of ev.markets ?? []) {
      const outcomes = parseOutcomes(m as any);
      const prices   = parseOutcomePrices(m as any);
      if (outcomes.length !== 2 || prices.length !== 2) continue;

      // Require a literal "No" outcome — skips multi-team markets like "Trump vs Biden"
      const noIdx = outcomes.findIndex(o => o.trim().toLowerCase() === 'no');
      if (noIdx < 0) continue;

      const noPrice = parseFloat(prices[noIdx]);
      if (!isFinite(noPrice) || noPrice < MIN_NO_PRICE || noPrice > MAX_NO_PRICE) continue;

      const volume = (m as any).volumeNum ?? (m as any).volume ?? 0;
      if (volume < MIN_VOLUME) continue;

      const marketId = String((m as any).id ?? '');
      if (!marketId) continue;

      out.push({
        marketId,
        question: (m as any).question ?? ev.title ?? 'Market',
        slug: (m as any).slug ?? eventSlug,
        eventSlug,
        noPrice,
        endDate: (m as any).endDate ?? ev.endDate ?? '',
        volume,
      });
    }
  }
  return out;
}

async function pickRandomNoMarket(): Promise<NoCandidate | null> {
  // Shuffle category order so repeated picks feel diverse
  const shuffled = [...NON_SPORTS_CATEGORIES].sort(() => Math.random() - 0.5);

  // Fetch a few categories in parallel for a larger candidate pool
  const picks = shuffled.slice(0, 4);
  const results = await Promise.allSettled(
    picks.map(cat => getEventsByCategory(cat, 30)),
  );

  const events: Event[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) events.push(...r.value);
  }

  // Dedup events by id (same event may appear under multiple tags)
  const seen = new Set<string>();
  const deduped = events.filter(e => {
    const id = String((e as any).id ?? '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const candidates = collectNoCandidates(deduped);
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function renderCandidate(c: NoCandidate, botUsername: string): { text: string; keyboard: any } {
  const noCents = Math.round(c.noPrice * 100);
  const bet = 10;
  const shares = bet / c.noPrice;
  const payout = shares * 1; // NO share resolves to $1 if market resolves No

  const polymarketUrl = c.eventSlug
    ? `https://polymarket.com/event/${c.eventSlug}`
    : `https://polymarket.com/market/${c.slug}`;

  const text =
    `🙅 <b>Nothing Ever Happens</b>\n\n` +
    `📊  <a href="${polymarketUrl}">${esc(c.question)}</a>\n\n` +
    `💰 NO price: <b>${noCents}¢</b>\n` +
    `📅 Expires: ${fmtExpires(c.endDate)}\n` +
    `📈 Volume: <b>$${formatVolume(c.volume)}</b>\n\n` +
    `🎯 Your bet: $${bet.toFixed(2)} → ~${shares.toFixed(1)} shares\n` +
    `💵 Potential payout: $${payout.toFixed(2)}`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url(`🙅 Buy NO ${noCents}¢`, `https://t.me/${botUsername}?start=trade_${c.marketId}_no_custom`)],
    [
      Markup.button.callback('🎲 Pick Another', 'neh_another'),
      Markup.button.callback('❌ Cancel',        'neh_cancel'),
    ],
  ]);

  return { text, keyboard };
}

async function sendNehMessage(ctx: Context, edit: boolean): Promise<void> {
  const candidate = await pickRandomNoMarket();
  const botUsername = ctx.botInfo?.username ?? config.telegram.botUsername ?? 'PolymarketBot';

  if (!candidate) {
    const msg = `🙅 <b>Nothing Ever Happens</b>\n\n` +
      `Couldn't find a tradeable non-sports market right now. Try again in a moment.`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('🎲 Pick Another', 'neh_another')],
      [Markup.button.callback('❌ Cancel',        'neh_cancel')],
    ]);
    if (edit) {
      await ctx.editMessageText(msg, { parse_mode: 'HTML', ...kb }).catch(async () => {
        await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
      });
    } else {
      await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
    }
    return;
  }

  const { text, keyboard } = renderCandidate(candidate, botUsername);

  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...keyboard,
      });
      return;
    } catch (err: any) {
      if (isBenignTelegramError(err)) return;
      // fall through to fresh reply
    }
  }

  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...keyboard,
  });
}

export async function handleNothingEverHappensCommand(ctx: Context): Promise<void> {
  try {
    await sendNehMessage(ctx, false);
    logger.info(`[neh] Command invoked by user: ${ctx.from?.id}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error in nothingEverHappens command:', error);
    await ctx.reply('Could not load a market. Please try again.').catch(() => {});
  }
}

export async function handleNehPickAnother(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('🎲 Rolling the dice...').catch(() => {});
    await sendNehMessage(ctx, true);
    logger.info(`[neh] Pick another by user: ${ctx.from?.id}`);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error picking another NEH market:', error);
  }
}

export async function handleNehCancel(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.deleteMessage().catch(() => {});
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    logger.error('Error cancelling NEH:', error);
  }
}
