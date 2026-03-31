import { Context, Markup } from 'telegraf';
import path from 'path';
import { sendPage } from '../../utils/telegram';
import { esc } from '../../utils/customEmoji';
import { getUserByTelegramId } from '../../services/user';
import {
  getCashbackStats,
  claimCashback,
  CASHBACK_MIN_CLAIM,
  CASHBACK_RATE,
} from '../../services/cashback';
import { logger } from '../../utils/logger';

const CASHBACK_IMAGE = path.join(__dirname, '..', 'img', 'cashback.jpeg');

export async function handleCashbackPage(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('❌ User not found. Use /start first.');
      return;
    }

    const stats = await getCashbackStats(user.id);
    const cashbackPct = (CASHBACK_RATE * 100).toFixed(0); // "10"

    let msg = `💰 <b>Cashback</b>\n\n`;
    msg += `🎁 <b>Rate:</b> ${cashbackPct}% of every platform fee\n`;
    msg += `<i>(You pay 1% fee per trade → get ${cashbackPct}% of that back)</i>\n\n`;
    msg += `━━━━━━━━━━━━━━━\n`;
    msg += `💵 <b>Claimable:</b> <b>$${esc(stats.claimable.toFixed(2))}</b>\n`;
    msg += `📈 <b>Total Earned:</b> <b>$${esc(stats.earnedTotal.toFixed(2))}</b>\n\n`;
    msg += `<i>Minimum withdrawal: $${CASHBACK_MIN_CLAIM}</i>`;

    const claimLabel = stats.claimable >= CASHBACK_MIN_CLAIM
      ? `💸 Withdraw ($${stats.claimable.toFixed(2)})`
      : `💸 Withdraw (Min $${CASHBACK_MIN_CLAIM})`;

    await sendPage(ctx, msg, {
      parse_mode: 'HTML',
      image_path: CASHBACK_IMAGE,
      ...Markup.inlineKeyboard([
        [Markup.button.callback(claimLabel, 'cashback_claim')],
        [
          Markup.button.callback('🔄 Refresh', 'cashback_page'),
          Markup.button.callback('💼 Wallet',  'wallet_page'),
        ],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    });
  } catch (err) {
    logger.error('[cashback] handleCashbackPage error:', err);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
}

export async function handleCashbackClaim(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.answerCbQuery('❌ User not found.').catch(() => {});
      return;
    }

    if (!user.polymarketProxyAddress) {
      await ctx.answerCbQuery('❌ No wallet found.').catch(() => {});
      return;
    }

    await ctx.answerCbQuery('⏳ Processing...').catch(() => {});

    const result = await claimCashback(user.id, user.polymarketProxyAddress);

    if (result.success) {
      const msg =
        `✅ <b>Withdrawal Successful!</b>\n\n` +
        `💵 Amount: <b>$${result.amount?.toFixed(2)}</b>\n` +
        `📍 Sent to: <code>${esc(user.polymarketProxyAddress)}</code>\n\n` +
        (result.txHash
          ? `🔗 <a href="https://polygonscan.com/tx/${result.txHash}">View on Polygonscan</a>`
          : '');

      await sendPage(ctx, msg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💰 Back to Cashback', 'cashback_page')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      });
    } else if (result.pending) {
      const msg =
        `⏳ <b>Withdrawal Pending</b>\n\n` +
        `Your cashback of <b>$${result.amount?.toFixed(2)}</b> has been queued.\n\n` +
        `${esc(result.error ?? '')}`;

      await sendPage(ctx, msg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💰 Back to Cashback', 'cashback_page')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      });
    } else {
      await sendPage(ctx, `❌ ${esc(result.error ?? 'An error occurred.')}`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💰 Back to Cashback', 'cashback_page')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      });
    }
  } catch (err) {
    logger.error('[cashback] handleCashbackClaim error:', err);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
}
