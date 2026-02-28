import fs from 'fs';
import path from 'path';
import { Context } from 'telegraf';
import { ExtraEditMessageText } from 'telegraf/typings/telegram-types';

const MENU_IMAGE = path.join(__dirname, '../bot/img/beattheodds.JPG');
let _cachedPhotoFileId: string | null = null;

/**
 * Sends a photo page.
 *
 * - If the current message is already a photo → editMessageCaption (caption + keyboard only,
 *   photo is never re-fetched or re-downloaded by the client).
 * - Otherwise → delete old message (if any) and send a fresh replyWithPhoto.
 *
 * Captions are capped at 1024 chars (Telegram limit).
 */
export async function sendPage(
  ctx: Context,
  caption: string,
  extra?: Record<string, any>
): Promise<void> {
  // Truncate at last complete HTML tag boundary to avoid "Unclosed start tag" errors
  let safeCaption = caption;
  if (caption.length > 1024) {
    const cut = caption.slice(0, 1024);
    const lastGt = cut.lastIndexOf('>');
    safeCaption = lastGt >= 0 ? cut.slice(0, lastGt + 1) : cut;
  }
  const parseMode   = extra?.parse_mode ?? 'Markdown';
  const replyMarkup = extra?.reply_markup;

  const cbMsg = ctx.callbackQuery && 'message' in ctx.callbackQuery
    ? ctx.callbackQuery.message : null;
  const isPhoto = !!(cbMsg && 'photo' in cbMsg);

  if (isPhoto) {
    try {
      // editMessageCaption only updates caption + keyboard — photo stays untouched
      await (ctx as any).editMessageCaption(safeCaption, {
        parse_mode: parseMode,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      return;
    } catch (err: any) {
      if (isBenignTelegramError(err)) return;
      // fall through to delete+send
    }
  }

  if (cbMsg) await ctx.deleteMessage().catch(() => {});

  const media = _cachedPhotoFileId
    ? _cachedPhotoFileId
    : { source: fs.createReadStream(MENU_IMAGE) };

  const result: any = await ctx.replyWithPhoto(media, {
    caption: safeCaption,
    parse_mode: parseMode,
    reply_markup: replyMarkup,
  });

  if (!_cachedPhotoFileId && result?.photo?.length) {
    _cachedPhotoFileId = result.photo[result.photo.length - 1].file_id;
  }
}

/**
 * Returns true for known benign Telegram API errors that should be silently ignored:
 * - "message is not modified": user clicked same button twice
 * - "query is too old" / "query ID is invalid": expired callback query (>1 min old)
 */
export function isBenignTelegramError(err: any): boolean {
  const msg: string = err?.message || err?.description || '';
  return (
    msg.includes('message is not modified') ||
    msg.includes('query is too old') ||
    msg.includes('query ID is invalid')
  );
}

/**
 * Safely edits a message text, ignoring "message is not modified" errors.
 */
export async function safeEditMessageText(
  ctx: Context,
  text: string,
  extra?: ExtraEditMessageText
): Promise<void> {
  try {
    await ctx.editMessageText(text, extra);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    throw error;
  }
}

/**
 * Smart edit: if the triggering message is a photo (e.g. main menu), deletes it and
 * sends a fresh text reply. Otherwise falls back to the standard editMessageText.
 * Benign Telegram errors are silently ignored in both paths.
 */
export async function editOrReply(
  ctx: Context,
  text: string,
  extra?: ExtraEditMessageText
): Promise<void> {
  const msg = ctx.callbackQuery && 'message' in ctx.callbackQuery
    ? ctx.callbackQuery.message
    : null;
  const isPhoto = msg && 'photo' in msg && Array.isArray((msg as any).photo);

  if (isPhoto) {
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(text, extra as any);
  } else {
    try {
      await ctx.editMessageText(text, extra);
    } catch (error: any) {
      if (isBenignTelegramError(error)) return;
      throw error;
    }
  }
}

/**
 * Safely answers a callback query, ignoring "query is too old" errors.
 */
export async function safeAnswerCbQuery(ctx: Context, text?: string): Promise<void> {
  try {
    await ctx.answerCbQuery(text);
  } catch (error: any) {
    if (isBenignTelegramError(error)) return;
    throw error;
  }
}
