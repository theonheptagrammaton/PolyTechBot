import { Context } from 'telegraf';

/**
 * Chat-kind helpers used throughout the bot to differentiate private-DM
 * flows (where all trading/wallet/state-based logic lives) from group/supergroup
 * flows (where the bot is read-only and only offers market analysis).
 */
export type ChatKind = 'private' | 'group';

export function getChatKind(ctx: Context): ChatKind {
  const t = ctx.chat?.type;
  return t === 'group' || t === 'supergroup' ? 'group' : 'private';
}

export function isGroupChat(ctx: Context): boolean {
  return getChatKind(ctx) === 'private' ? false : true;
}

export function isPrivateChat(ctx: Context): boolean {
  return !isGroupChat(ctx);
}

/**
 * Build a t.me deep-link that opens a DM with the bot. When `param` is
 * provided it is passed as a /start argument so handlers like
 * `handleStart` can deep-link into a specific event / trade / flow.
 */
export async function dmDeepLinkUrl(ctx: Context, param?: string): Promise<string> {
  const me = await ctx.telegram.getMe();
  return `https://t.me/${me.username}${param ? `?start=${encodeURIComponent(param)}` : ''}`;
}

/**
 * Synchronous variant for callers that already know the bot username
 * (e.g. `config.telegram.botUsername`). Falls back to '' if no username
 * is provided — caller is responsible for using the async variant when
 * needed.
 */
export function dmDeepLinkUrlSync(botUsername: string, param?: string): string {
  if (!botUsername) return '';
  return `https://t.me/${botUsername}${param ? `?start=${encodeURIComponent(param)}` : ''}`;
}
