import { Context, Markup } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { detectPolymarketLink, handleLinkInput, handleKeywordSearch, handlePriceCommand } from './search';
import { handleCategorySelection } from './markets';
import { dmDeepLinkUrlSync, isGroupChat } from '../utils/chatType';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { t, Locale } from '../../i18n';

/**
 * Group chat handlers — the bot's read-only surface for Telegram groups.
 *
 * Invariants:
 *   • No state-based text routing (trade/limit/withdraw flows never fire in groups).
 *   • Every exposed action is gated by a per-chat rate limit + a registered-user check.
 *   • No wallet creation ever runs from a group — unregistered users are redirected to DM.
 */

// ── Rate limiting (in-memory, per-chat) ──────────────────────────────────────
const _chatRateMap = new Map<number, { count: number; resetAt: number }>();

// ── Dedup notice to unregistered callers (per chat × user) ───────────────────
const _unregisteredNoticeMap = new Map<string, number>();
const UNREGISTERED_NOTICE_COOLDOWN_MS = 60_000;

function checkChatRateLimit(chatId: number, maxPerMin: number): boolean {
  const now = Date.now();
  const entry = _chatRateMap.get(chatId);
  if (!entry || now > entry.resetAt) {
    _chatRateMap.set(chatId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= maxPerMin) return false;
  entry.count++;
  return true;
}

function evictChatState(chatId: number): void {
  _chatRateMap.delete(chatId);
  for (const key of [..._unregisteredNoticeMap.keys()]) {
    if (key.startsWith(`${chatId}:`)) _unregisteredNoticeMap.delete(key);
  }
}

async function resolveLang(ctx: Context): Promise<Locale> {
  const attached = (ctx as any).userLanguage as Locale | undefined;
  if (attached) return attached;
  try {
    const telegramId = ctx.from?.id?.toString();
    if (telegramId) {
      const user = await getUserByTelegramId(telegramId);
      if (user?.language) {
        (ctx as any).userLanguage = user.language;
        return user.language as Locale;
      }
    }
  } catch { /* fall through */ }
  return 'en';
}

function getBotUsername(ctx: Context): string {
  return ctx.botInfo?.username || config.telegram.botUsername || 'PolyTechBot';
}

/**
 * Allow-listed group commands. The chat-type middleware silently drops any
 * other command so the bot does not spam groups with "unknown command"
 * replies.
 */
export const GROUP_ALLOWED_COMMANDS = new Set<string>([
  'start', 'help', 'markets', 'trending', 'price', 'analyze', 'market',
]);

/**
 * Extract the bare command name from message text ("/foo@BotName bar" → "foo").
 */
export function extractCommandName(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const raw = text.slice(1).split(/\s/)[0] || '';
  return raw.split('@')[0].toLowerCase() || null;
}

export function isAllowedGroupCommand(cmd: string): boolean {
  return GROUP_ALLOWED_COMMANDS.has(cmd.toLowerCase());
}

/**
 * Apply per-chat rate-limit. Returns false + sends a "slow down" reply
 * if the caller exceeded the configured limit.
 */
export async function ensureGroupRateLimit(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return true;
  const maxPerMin = Math.max(1, config.telegram.groupRateLimitPerMin || 10);
  if (checkChatRateLimit(chatId, maxPerMin)) return true;
  const lang = await resolveLang(ctx);
  try {
    await ctx.reply(t(lang, 'group.err.rateLimited'), { parse_mode: 'HTML' });
  } catch { /* ignore */ }
  return false;
}

/**
 * Ensure the caller has a PolyTech account in the DB. If they do, attaches
 * the user + language to the context and returns true. If they don't, sends
 * a single rate-limited "open DM and /start" notice and returns false.
 * On DB errors we fail open so analysis features keep working.
 */
export async function ensureRegisteredCaller(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id?.toString();
  const chatId = ctx.chat?.id;
  if (!telegramId || chatId == null) return false;

  // If the middleware already ran, reuse its result.
  const cached = (ctx as any).registeredUser;
  if (cached && typeof cached === 'object') return true;
  if (cached === null) {
    // Caller known-unregistered — fall through to notice.
  } else {
    try {
      const user = await getUserByTelegramId(telegramId);
      if (user) {
        (ctx as any).registeredUser = user;
        (ctx as any).userLanguage = user.language || 'en';
        return true;
      }
      (ctx as any).registeredUser = null;
    } catch (err) {
      logger.debug(`group: DB lookup failed for ${telegramId}, failing open:`, err);
      return true;
    }
  }

  // Dedup the notice so repeated messages from an unregistered user don't spam.
  const key = `${chatId}:${telegramId}`;
  const now = Date.now();
  const last = _unregisteredNoticeMap.get(key) || 0;
  if (now - last < UNREGISTERED_NOTICE_COOLDOWN_MS) return false;
  _unregisteredNoticeMap.set(key, now);

  const lang = await resolveLang(ctx);
  const botUsername = getBotUsername(ctx);
  try {
    const replyMsgId = (ctx.message as any)?.message_id;
    await ctx.reply(t(lang, 'group.err.notRegistered'), {
      parse_mode: 'HTML',
      ...(replyMsgId ? { reply_parameters: { message_id: replyMsgId } as any } : {}),
      ...Markup.inlineKeyboard([
        [Markup.button.url(t(lang, 'group.cta.openDm'), dmDeepLinkUrlSync(botUsername))],
      ]),
    });
  } catch (err) {
    logger.debug('group: failed to send notRegistered reply:', err);
  }
  return false;
}

/**
 * Handle free-text message in a group. Only reacts to Polymarket links;
 * everything else is silently ignored (no state routing, no keyword search,
 * no "unknown command" replies).
 */
export async function handleGroupText(ctx: Context): Promise<void> {
  if (!config.telegram.enableGroupMode) return;
  const text = ('message' in ctx.update && 'text' in (ctx.update.message as any))
    ? ((ctx.update.message as any).text as string)
    : '';
  const slug = detectPolymarketLink(text);
  if (!slug) return;

  if (!(await ensureGroupRateLimit(ctx))) return;
  if (!(await ensureRegisteredCaller(ctx))) return;

  try {
    await handleLinkInput(ctx, slug);
  } catch (err) {
    logger.error('group: handleGroupText link handler failed:', err);
  }
}

/**
 * Send the "PolyTechBot is live in this group" welcome card. Posted when
 * the bot is added to a group and when someone runs /start@BotName.
 */
export async function handleGroupWelcome(ctx: Context): Promise<void> {
  if (!config.telegram.enableGroupMode) return;
  const lang = await resolveLang(ctx);
  const botUsername = getBotUsername(ctx);
  const title = t(lang, 'group.welcome.title');
  const body = t(lang, 'group.welcome.body');
  try {
    await ctx.reply(`${title}\n\n${body}`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.url(t(lang, 'group.cta.openDm'), dmDeepLinkUrlSync(botUsername))],
      ]),
    });
  } catch (err) {
    logger.debug('group: handleGroupWelcome failed:', err);
  }
}

export async function handleGroupHelp(ctx: Context): Promise<void> {
  if (!config.telegram.enableGroupMode) return;
  if (!(await ensureGroupRateLimit(ctx))) return;
  const lang = await resolveLang(ctx);
  const botUsername = getBotUsername(ctx);
  try {
    await ctx.reply(`${t(lang, 'group.help.title')}\n\n${t(lang, 'group.help.body')}`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.url(t(lang, 'group.cta.openDm'), dmDeepLinkUrlSync(botUsername))],
      ]),
    });
  } catch (err) {
    logger.debug('group: handleGroupHelp failed:', err);
  }
}

/**
 * /markets in a group — we don't expose full category browsing (it requires
 * callback navigation that doesn't make sense in a shared chat). Instead
 * show the help card which lists the read-only commands and an Open-in-DM
 * deep-link for full browsing.
 */
export async function handleGroupMarkets(ctx: Context): Promise<void> {
  await handleGroupHelp(ctx);
}

export async function handleGroupTrending(ctx: Context): Promise<void> {
  if (!config.telegram.enableGroupMode) return;
  if (!(await ensureGroupRateLimit(ctx))) return;
  if (!(await ensureRegisteredCaller(ctx))) return;
  try {
    await handleCategorySelection(ctx, 'trending', 1);
  } catch (err) {
    logger.error('group: handleGroupTrending failed:', err);
  }
}

export async function handleGroupPrice(ctx: Context, keyword: string): Promise<void> {
  if (!config.telegram.enableGroupMode) return;
  if (!(await ensureGroupRateLimit(ctx))) return;
  if (!(await ensureRegisteredCaller(ctx))) return;
  try {
    await handlePriceCommand(ctx, keyword);
  } catch (err) {
    logger.error('group: handleGroupPrice failed:', err);
  }
}

/**
 * /analyze <polymarket-link-or-keyword> — explicit entry point for group
 * analysis. Useful when privacy mode is ON (no auto link detection).
 */
export async function handleGroupAnalyze(ctx: Context, arg: string): Promise<void> {
  if (!config.telegram.enableGroupMode) return;
  const input = (arg || '').trim();
  if (!input) {
    try {
      await ctx.reply(
        'Usage: <code>/analyze &lt;polymarket-link-or-keyword&gt;</code>',
        { parse_mode: 'HTML' }
      );
    } catch { /* ignore */ }
    return;
  }
  if (!(await ensureGroupRateLimit(ctx))) return;
  if (!(await ensureRegisteredCaller(ctx))) return;
  const slug = detectPolymarketLink(input);
  try {
    if (slug) {
      await handleLinkInput(ctx, slug);
    } else {
      await handleKeywordSearch(ctx, input);
    }
  } catch (err) {
    logger.error('group: handleGroupAnalyze failed:', err);
  }
}

/**
 * my_chat_member update — fires when the bot is added to / removed from a
 * group. Posts a welcome card on add; evicts per-chat state on remove.
 */
export async function handleMyChatMember(ctx: Context): Promise<void> {
  try {
    if (!('my_chat_member' in (ctx.update as any))) return;
    const update: any = (ctx.update as any).my_chat_member;
    const chat = update?.chat;
    if (!chat) return;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;

    const newStatus: string = update?.new_chat_member?.status || '';
    const oldStatus: string = update?.old_chat_member?.status || '';

    const memberStatuses = new Set(['member', 'administrator', 'creator']);
    const becameMember = memberStatuses.has(newStatus) && !memberStatuses.has(oldStatus);
    const wasRemoved = newStatus === 'left' || newStatus === 'kicked';

    if (becameMember) {
      logger.info(`group: bot added to ${chat.type} ${chat.id} (${chat.title || 'untitled'})`);
      if (config.telegram.enableGroupMode) {
        await handleGroupWelcome(ctx);
      }
    } else if (wasRemoved) {
      logger.info(`group: bot removed from ${chat.type} ${chat.id}`);
      evictChatState(chat.id);
    }
  } catch (err) {
    logger.error('group: handleMyChatMember failed:', err);
  }
}

/** Export for tests / external introspection. */
export const __internals = {
  isGroupChat,
  evictChatState,
};
