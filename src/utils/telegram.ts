import fs from 'fs';
import path from 'path';
import { Context } from 'telegraf';
import { ExtraEditMessageText } from 'telegraf/typings/telegram-types';

const MENU_IMAGE = path.join(__dirname, '../bot/img/beattheodds.JPG');
let _cachedPhotoFileId: string | null = null;

/** Per-URL file_id cache — avoids re-uploading the same event image */
const _urlPhotoCache = new Map<string, string>();

/**
 * Returns the media object for the static menu image.
 * Uses cached file_id if available to avoid re-uploading.
 */
export function getMenuPhotoMedia(): string | { source: ReturnType<typeof fs.createReadStream> } {
  return _cachedPhotoFileId
    ? _cachedPhotoFileId
    : { source: fs.createReadStream(MENU_IMAGE) };
}

/** Saves a menu photo file_id returned by Telegram (call after first replyWithPhoto). */
export function cacheMenuPhotoFileId(result: any): void {
  if (!_cachedPhotoFileId && result?.photo?.length) {
    _cachedPhotoFileId = result.photo[result.photo.length - 1].file_id;
  }
}

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
  // Truncate safely within 1024 chars (Telegram caption limit)
  let safeCaption = caption;
  if (caption.length > 1024) {
    const cut = caption.slice(0, 1024);
    const lastGt = cut.lastIndexOf('>');
    if (lastGt >= 0) {
      // HTML: cut at last closed tag
      safeCaption = cut.slice(0, lastGt + 1);
    } else {
      // Markdown: cut at last paragraph break to avoid splitting *bold* / `code` syntax
      const lastPara = cut.lastIndexOf('\n\n');
      safeCaption = lastPara > 200 ? cut.slice(0, lastPara) : cut;
    }
  }
  const parseMode   = extra?.parse_mode ?? 'Markdown';
  const replyMarkup = extra?.reply_markup;
  const imageUrl    = extra?.image_url  as string | undefined;
  const imagePath   = extra?.image_path as string | undefined;

  const cbMsg = ctx.callbackQuery && 'message' in ctx.callbackQuery
    ? ctx.callbackQuery.message : null;
  const isPhoto = !!(cbMsg && 'photo' in cbMsg);

  // ── Custom image (URL or local file path) ────────────────────────────────
  if (imageUrl || imagePath) {
    const cacheKey = imageUrl || imagePath!;
    const cached   = _urlPhotoCache.get(cacheKey);
    const mediaId: any = cached
      ? cached
      : imageUrl
        ? imageUrl
        : { source: fs.createReadStream(imagePath!) };

    if (isPhoto) {
      // Try to swap photo in-place
      try {
        const result: any = await (ctx as any).editMessageMedia(
          { type: 'photo', media: mediaId, caption: safeCaption, parse_mode: parseMode },
          replyMarkup ? { reply_markup: replyMarkup } : undefined,
        );
        if (!cached && typeof result === 'object' && result?.photo?.length) {
          _urlPhotoCache.set(cacheKey, result.photo[result.photo.length - 1].file_id);
        }
        return;
      } catch (err: any) {
        if (isBenignTelegramError(err)) return;
        // editMessageMedia failed — update caption only, keep whatever photo is there
        try {
          await (ctx as any).editMessageCaption(safeCaption, {
            parse_mode: parseMode,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          });
        } catch { /* ignore */ }
        return;
      }
    }

    // Not a photo message — send a new photo (no deletion)
    try {
      const result: any = await ctx.replyWithPhoto(mediaId, {
        caption: safeCaption,
        parse_mode: parseMode,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      if (!cached && result?.photo?.length) {
        _urlPhotoCache.set(cacheKey, result.photo[result.photo.length - 1].file_id);
      }
    } catch {
      // URL/file failed — fall back to static menu image
      const fallback: any = _cachedPhotoFileId
        ? _cachedPhotoFileId
        : { source: fs.createReadStream(MENU_IMAGE) };
      const result: any = await ctx.replyWithPhoto(fallback, {
        caption: safeCaption,
        parse_mode: parseMode,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      if (!_cachedPhotoFileId && result?.photo?.length) {
        _cachedPhotoFileId = result.photo[result.photo.length - 1].file_id;
      }
    }
    return;
  }

  // ── Default: static menu image ─────────────────────────────────────────────
  // Always swap to menu photo so a previous page's photo is never left behind.
  if (isPhoto) {
    const menuMedia: any = _cachedPhotoFileId
      ? _cachedPhotoFileId
      : { source: fs.createReadStream(MENU_IMAGE) };
    try {
      const result: any = await (ctx as any).editMessageMedia(
        { type: 'photo', media: menuMedia, caption: safeCaption, parse_mode: parseMode },
        replyMarkup ? { reply_markup: replyMarkup } : undefined,
      );
      if (!_cachedPhotoFileId && typeof result === 'object' && result?.photo?.length) {
        _cachedPhotoFileId = result.photo[result.photo.length - 1].file_id;
      }
      return;
    } catch (err: any) {
      if (isBenignTelegramError(err)) return;
      // editMessageMedia failed — update caption only, keep whatever photo is there
      try {
        await (ctx as any).editMessageCaption(safeCaption, {
          parse_mode: parseMode,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      } catch { /* ignore */ }
      return;
    }
  }

  // Not a photo message — send a new photo (no deletion)
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
    // Never delete — send text as a new message alongside the photo
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
