import { Context, Markup } from 'telegraf';
import path from 'path';
import { sendPage, notifyAdmins } from '../../utils/telegram';
import { esc } from '../../utils/customEmoji';
import { getUserByTelegramId } from '../../services/user';
import {
  getCashbackStats,
  claimCashback,
  CASHBACK_MIN_CLAIM,
  CASHBACK_RATE,
} from '../../services/cashback';
import { logger } from '../../utils/logger';
import { t, Locale } from '../../i18n';

/** Get locale from user object */
function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

const CASHBACK_IMAGE = path.join(__dirname, '..', 'img', 'cashback.jpeg');

export async function handleCashbackPage(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply(t('en', 'common.userNotFoundStart'));
      return;
    }

    const lang = getLang(user);
    const stats = await getCashbackStats(user.id);
    const cashbackPct = (CASHBACK_RATE * 100).toFixed(0); // "10"

    let msg = `💰 <b>${t(lang, 'Cashback')}</b>\n\n`;
    msg += `🎁 <b>${t(lang, 'Rate:')}</b> ${cashbackPct}% ${t(lang, 'of every platform fee')}\n`;
    msg += `<i>(${t(lang, 'You pay 1% fee per trade → get {{pct}}% of that back', { pct: cashbackPct })})</i>\n\n`;
    msg += `━━━━━━━━━━━━━━━\n`;
    msg += `💵 <b>${t(lang, 'Claimable:')}</b> <b>$${esc(stats.claimable.toFixed(2))}</b>\n`;
    msg += `📈 <b>${t(lang, 'Total Earned:')}</b> <b>$${esc(stats.earnedTotal.toFixed(2))}</b>\n\n`;
    msg += `<i>${t(lang, 'Minimum withdrawal: ${{min}}', { min: CASHBACK_MIN_CLAIM })}</i>`;

    const claimLabel = stats.claimable >= CASHBACK_MIN_CLAIM
      ? t(lang, 'btn.withdrawCashback', { amount: stats.claimable.toFixed(2) })
      : t(lang, 'btn.withdrawCashbackMin', { min: CASHBACK_MIN_CLAIM });

    await sendPage(ctx, msg, {
      parse_mode: 'HTML',
      image_path: CASHBACK_IMAGE,
      ...Markup.inlineKeyboard([
        [Markup.button.callback(claimLabel, 'cashback_claim')],
        [
          Markup.button.callback(t(lang, 'btn.refresh'), 'cashback_page'),
          Markup.button.callback(t(lang, 'btn.wallet'),  'wallet_page'),
        ],
        [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
      ]),
    });
  } catch (err) {
    logger.error('[cashback] handleCashbackPage error:', err);
    await ctx.reply(t('en', 'cashback.errorGeneric'));
  }
}

export async function handleCashbackClaim(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.answerCbQuery(t('en', 'common.userNotFoundShort')).catch(() => {});
      return;
    }

    const lang = getLang(user);

    if (!user.polymarketProxyAddress) {
      await ctx.answerCbQuery(t(lang, '❌ No wallet found.')).catch(() => {});
      return;
    }

    await ctx.answerCbQuery(t(lang, 'common.processing')).catch(() => {});

    const result = await claimCashback(user.id, user.polymarketProxyAddress);

    if (result.success) {
      const msg =
        t(lang, 'cashback.withdrawSuccess', {
          amount: result.amount?.toFixed(2) ?? '0.00',
          address: esc(user.polymarketProxyAddress),
        }) +
        (result.txHash
          ? `🔗 <a href="https://polygonscan.com/tx/${result.txHash}">View on Polygonscan</a>`
          : '');

      await sendPage(ctx, msg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.backToCashback'), 'cashback_page')],
          [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
        ]),
      });
    } else if (result.insufficientTreasury) {
      await notifyAdmins(ctx.telegram, `⚠️ <b>Treasury Yetersiz — Cashback Claim</b>\nKullanıcı: ${telegramId}\nTutar: $${result.amount?.toFixed(2)}`);
      await sendPage(ctx, `❌ ${esc(result.error ?? '')}`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.backToCashback'), 'cashback_page')],
          [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
        ]),
      });
    } else {
      await sendPage(ctx, `❌ ${esc(result.error ?? t(lang, 'common.errorGeneric'))}`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.backToCashback'), 'cashback_page')],
          [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
        ]),
      });
    }
  } catch (err) {
    logger.error('[cashback] handleCashbackClaim error:', err);
    await ctx.reply(t('en', 'cashback.errorGeneric'));
  }
}
