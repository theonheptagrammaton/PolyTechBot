import fs from 'fs';
import path from 'path';
import { Context } from 'telegraf';
import { ExtraEditMessageText } from 'telegraf/typings/telegram-types';
import { logger } from './logger';
import sharp from 'sharp';

const TG_MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB

// Per-message edit lock: prevents concurrent editMessageMedia/editMessageCaption
// calls on the same message. If a second sendPage arrives while the first is
// still in-flight, the second is silently dropped (the first one already delivers
// the latest state). Entries auto-clean when the Promise settles.
const _editLocks = new Map<string, Promise<void>>();
function getEditLockKey(ctx: Context): string | null {
  const chatId = ctx.chat?.id;
  const msgId = ctx.callbackQuery && 'message' in ctx.callbackQuery
    ? (ctx.callbackQuery.message as any)?.message_id : null;
  if (!chatId || !msgId) return null;
  return `${chatId}:${msgId}`;
}

/**
 * Returns a Buffer ready for Telegram. If the file exceeds the 10 MB limit,
 * @public exported for use outside sendPage (e.g. notification senders)
 * it is re-encoded as JPEG at decreasing quality until it fits.
 */
export async function prepareImageBuffer(filePath: string): Promise<Buffer> {
  const raw = await fs.promises.readFile(filePath);
  if (raw.byteLength <= TG_MAX_PHOTO_BYTES) return raw;

  logger.info(`[sendPage] Compressing oversized image (${(raw.byteLength / 1024 / 1024).toFixed(1)} MB): ${path.basename(filePath)}`);
  for (const quality of [85, 70, 55, 40]) {
    const compressed = await sharp(raw).jpeg({ quality }).toBuffer();
    if (compressed.byteLength <= TG_MAX_PHOTO_BYTES) return compressed;
  }
  // Last resort — resize to 1280px wide
  return sharp(raw).resize({ width: 1280 }).jpeg({ quality: 60 }).toBuffer();
}

const MENU_IMAGE = path.join(__dirname, '../bot/img/opening.jpg');
let _cachedPhotoFileId: string | null = null;

/** Per-URL file_id cache — avoids re-uploading the same event image (LRU capped at 200) */
const URL_PHOTO_CACHE_MAX = 200;
const _urlPhotoCache = new Map<string, string>();

function urlPhotoCacheSet(key: string, fileId: string): void {
  if (_urlPhotoCache.size >= URL_PHOTO_CACHE_MAX) {
    const firstKey = _urlPhotoCache.keys().next().value;
    if (firstKey !== undefined) _urlPhotoCache.delete(firstKey);
  }
  _urlPhotoCache.set(key, fileId);
}

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
  // Per-message edit lock: drop concurrent edits on the same message
  const lockKey = getEditLockKey(ctx);
  if (lockKey) {
    if (_editLocks.has(lockKey)) {
      logger.debug?.(`[sendPage] Dropping concurrent edit for ${lockKey}`);
      return;
    }
    // Reserve the lock, release when this invocation finishes
    let releaseLock: () => void;
    const lockPromise = new Promise<void>(resolve => { releaseLock = resolve; });
    _editLocks.set(lockKey, lockPromise);
    lockPromise.finally(() => _editLocks.delete(lockKey));
    try {
      await sendPageInner(ctx, caption, extra);
    } finally {
      releaseLock!();
    }
    return;
  }
  return sendPageInner(ctx, caption, extra);
}

async function sendPageInner(
  ctx: Context,
  caption: string,
  extra?: Record<string, any>
): Promise<void> {
  // Truncate safely within 1024 chars (Telegram caption limit)
  let safeCaption = caption;
  if (caption.length > 1024) {
    const cut = caption.slice(0, 1024);
    // Always prefer paragraph boundary — safe for both HTML and Markdown,
    // and never splits inside an HTML tag or bold/italic span.
    const lastPara = cut.lastIndexOf('\n\n');
    if (lastPara > 200) {
      safeCaption = cut.slice(0, lastPara);
    } else {
      // No paragraph break: for HTML find last complete closing tag; for Markdown use raw cut
      const lastCloseA = cut.lastIndexOf('</a>');
      const lastCloseB = cut.lastIndexOf('</b>');
      const lastClose  = Math.max(lastCloseA, lastCloseB);
      if (lastClose > 200) {
        // Include the full closing tag (</a> = 4 chars, </b> = 4 chars)
        safeCaption = cut.slice(0, lastClose + 4);
      } else {
        safeCaption = cut;
      }
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
    const localBuf: Buffer | null = (!cached && imagePath) ? await prepareImageBuffer(imagePath) : null;
    const mediaId: any = cached
      ? cached
      : imageUrl
        ? imageUrl
        : { source: localBuf! };

    if (isPhoto) {
      // Try to swap photo in-place
      try {
        const result: any = await (ctx as any).editMessageMedia(
          { type: 'photo', media: mediaId, caption: safeCaption, parse_mode: parseMode },
          replyMarkup ? { reply_markup: replyMarkup } : undefined,
        );
        if (!cached && typeof result === 'object' && result?.photo?.length) {
          urlPhotoCacheSet(cacheKey, result.photo[result.photo.length - 1].file_id);
        }
        return;
      } catch (err: any) {
        if (isBenignTelegramError(err)) return;
        logger.warn(`[sendPage] editMessageMedia failed for ${cacheKey}: ${err?.message}`);
        // editMessageMedia failed — delete old message and send fresh photo
        try { await ctx.deleteMessage(); } catch { /* ignore */ }
        try {
          const freshMedia: any = imageUrl ? imageUrl : { source: localBuf! };
          const result: any = await ctx.replyWithPhoto(freshMedia, {
            caption: safeCaption,
            parse_mode: parseMode,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          });
          if (!cached && result?.photo?.length) {
            urlPhotoCacheSet(cacheKey, result.photo[result.photo.length - 1].file_id);
          }
        } catch (err2: any) {
          logger.warn(`[sendPage] replyWithPhoto fallback also failed for ${cacheKey}: ${err2?.message}`);
          // Final fallback: send opening image with caption
          const fallback: any = _cachedPhotoFileId ? _cachedPhotoFileId : { source: fs.createReadStream(MENU_IMAGE) };
          try {
            await ctx.replyWithPhoto(fallback, { caption: safeCaption, parse_mode: parseMode, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
          } catch { /* ignore */ }
        }
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
        urlPhotoCacheSet(cacheKey, result.photo[result.photo.length - 1].file_id);
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
 * Sends a dynamically generated image (Buffer) with caption and keyboard.
 * If the current message is a photo, swaps it in-place via editMessageMedia.
 * Falls back to text-only reply if image send fails.
 */
export async function sendImageBufferPage(
  ctx: Context,
  imageBuffer: Buffer,
  caption: string,
  extra?: Record<string, any>
): Promise<void> {
  let safeCaption = caption;
  if (caption.length > 1024) {
    const cut = caption.slice(0, 1024);
    const lastPara = cut.lastIndexOf('\n\n');
    safeCaption = lastPara > 200 ? cut.slice(0, lastPara) : cut;
  }
  const parseMode   = extra?.parse_mode ?? 'Markdown';
  const replyMarkup = extra?.reply_markup;

  const cbMsg = ctx.callbackQuery && 'message' in ctx.callbackQuery
    ? ctx.callbackQuery.message : null;
  const isPhoto = !!(cbMsg && 'photo' in cbMsg);

  if (isPhoto) {
    try {
      await (ctx as any).editMessageMedia(
        { type: 'photo', media: { source: imageBuffer }, caption: safeCaption, parse_mode: parseMode },
        replyMarkup ? { reply_markup: replyMarkup } : undefined,
      );
      return;
    } catch (err: any) {
      if (isBenignTelegramError(err)) return;
      // editMessageMedia failed — delete old message and send fresh photo
      try {
        await ctx.deleteMessage();
      } catch { /* old message already gone or not deletable */ }
    }
  }

  try {
    await ctx.replyWithPhoto(
      { source: imageBuffer },
      {
        caption: safeCaption,
        parse_mode: parseMode,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
    );
  } catch {
    // Image send failed — fall back to text-only
    await ctx.reply(safeCaption, {
      parse_mode: parseMode,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    } as any);
  }
}

/**
 * Sends a message to all configured admin users.
 * Silently ignores delivery failures for individual admins.
 */
export async function notifyAdmins(
  telegram: { sendMessage: (chatId: string | number, text: string, extra?: any) => Promise<any> },
  message: string,
): Promise<void> {
  const { config } = await import('../config');
  for (const adminId of config.telegram.adminUserIds) {
    await telegram.sendMessage(adminId, message, { parse_mode: 'HTML' }).catch(() => {});
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

/**
 * Fetches the user's Telegram profile photo as a Buffer.
 * Returns undefined if no photo is set or fetching fails.
 */
export async function fetchProfilePhoto(ctx: Context): Promise<Buffer | undefined> {
  try {
    const userId = ctx.from?.id;
    if (!userId) return undefined;

    const photos = await ctx.telegram.getUserProfilePhotos(userId, 0, 1);
    if (!photos || photos.total_count === 0 || photos.photos.length === 0) return undefined;

    // Pick the largest size from the first photo
    const sizes = photos.photos[0];
    const fileId = sizes[sizes.length - 1].file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);

    const response = await fetch(fileLink.href);
    if (!response.ok) return undefined;

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return undefined;
  }
}
