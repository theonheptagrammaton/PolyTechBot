import { Context } from 'telegraf';
import { ExtraEditMessageText } from 'telegraf/typings/telegram-types';

/**
 * Safely edits a message text, ignoring "message is not modified" errors
 * This prevents unnecessary error logs when users rapidly click the same button
 */
export async function safeEditMessageText(
  ctx: Context,
  text: string,
  extra?: ExtraEditMessageText
): Promise<void> {
  try {
    await ctx.editMessageText(text, extra);
  } catch (error: any) {
    // Ignore "message is not modified" errors - these are expected
    // when user clicks the same button multiple times
    if (error.message?.includes('message is not modified')) {
      return; // Silently ignore
    }
    // Re-throw other errors
    throw error;
  }
}
