import path from 'path';
import { Context, Markup } from 'telegraf';
import { sendPage, notifyAdmins } from '../../utils/telegram';

const IMG_REFERRAL = path.join(__dirname, '../img/referral.PNG');
import { ce, esc, EMOJI } from '../../utils/customEmoji';
import { getUserByTelegramId } from '../../services/user';
import {
  getReferralStats,
  ensureReferralCode,
  claimReferralEarnings,
  updateReferralCode,
  REFERRAL_MIN_CLAIM,
} from '../../services/referral';
import { RedisBackedState } from '../../utils/redisState';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { t, Locale } from '../../i18n';

/** Get locale from user object */
function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

// State for users editing their referral name — TTL 5 min
export const referralEditState = new RedisBackedState<{ timestamp: number }>('referralEdit', 300);

const BOT_USERNAME = config.telegram.botUsername;

export async function handleReferralHub(ctx: Context): Promise<void> {
  try {
    // Answer immediately to clear the loading spinner (Telegram times out after 10s)
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply(t('en', 'common.userNotFoundStart'));
      return;
    }

    const lang = getLang(user);

    // Ensure user has a referral code
    await ensureReferralCode(user.id, ctx.from?.username);

    const stats = await getReferralStats(user.id, BOT_USERNAME);

    const t1Pct = `${stats.tier1Pct}%`;
    const t2Pct = '5%';
    const t3Pct = '3%';

    const eHub      = ce(EMOJI.refHub,   '👥');
    const eCode     = ce(EMOJI.refCode,  '🔑');
    const eLink     = ce(EMOJI.refLink,  '🔗');
    const eTier     = ce(EMOJI.tierUser, '👤');
    const eT1       = ce(EMOJI.tier1,    '🥇');
    const eT2       = ce(EMOJI.tier2,    '🥈');
    const eT3       = ce(EMOJI.tier3,    '🥉');
    const eEarnings = ce(EMOJI.earnings, '💵');
    const eMoney    = ce(EMOJI.money,    '💰');

    let msg = `${eHub} <b>${t(lang, 'Referral Hub')}</b>\n\n`;
    msg += `${eCode} ${t(lang, 'Your Code:')} <code>${esc(stats.code)}</code>\n`;
    msg += `${eLink} ${t(lang, 'Invite Link:')}\n<code>${esc(stats.inviteLink)}</code>\n\n`;
    msg += `━━━━━━━━━━━━━━━\n`;
    msg += `${eTier} <b>${t(lang, 'Tier Metrics')}</b>\n\n`;
    msg += `├ ${eT1} ${t(lang, 'Tier 1 — Direct')} (${t1Pct})\n`;
    msg += `│   ${esc(stats.tier1Count)} ${t(lang, 'people invited')}\n`;
    msg += `├ ${eT2} ${t(lang, 'Tier 2 — Indirect')} (${t2Pct})\n`;
    msg += `│   ${esc(stats.tier2Count)} ${t(lang, 'people')}\n`;
    msg += `└ ${eT3} ${t(lang, 'Tier 3 — Network')} (${t3Pct})\n`;
    msg += `    ${esc(stats.tier3Count)} ${t(lang, 'people')}\n\n`;
    msg += `━━━━━━━━━━━━━━━\n`;
    msg += `${eEarnings} <b>${t(lang, 'Earnings Dashboard')}</b>\n\n`;
    msg += `├ ${eMoney} ${t(lang, 'Claimable:')} <b>$${esc(stats.claimable.toFixed(2))}</b>\n`;
    msg += `└ 💰 ${t(lang, 'Total Earned:')} <b>$${esc(stats.earnedTotal.toFixed(2))}</b>\n\n`;


    await sendPage(ctx, msg, {
      parse_mode: 'HTML',
      image_path: IMG_REFERRAL,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            stats.claimable >= REFERRAL_MIN_CLAIM
              ? t(lang, 'btn.withdrawReferral', { amount: stats.claimable.toFixed(2) })
              : t(lang, 'btn.withdrawReferralMin', { min: REFERRAL_MIN_CLAIM }),
            'referral_claim'
          ),
        ],
        [
          ({ text: t(lang, 'btn.copyLink'), copy_text: { text: stats.inviteLink } } as any),
          Markup.button.callback(t(lang, 'btn.refresh'), 'referral_hub'),
        ],
        [Markup.button.callback(t(lang, 'btn.editRefName'), 'referral_edit_name')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
      ]),
    });
  } catch (err) {
    logger.error('[referral] handleReferralHub error:', err);
    await ctx.reply(t('en', 'referral.errorGeneric'));
  }
}

export async function handleReferralClaim(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.answerCbQuery?.(t('en', 'common.userNotFoundShort')).catch(() => {});
      return;
    }

    const lang = getLang(user);

    if (!user.polymarketProxyAddress) {
      await ctx.answerCbQuery?.(t(lang, '❌ No wallet found.')).catch(() => {});
      return;
    }

    await ctx.answerCbQuery?.(t(lang, 'common.processing')).catch(() => {});

    const result = await claimReferralEarnings(user.id, user.polymarketProxyAddress);

    if (result.success) {
      const msg =
        t(lang, 'referral.withdrawSuccess', {
          amount: result.amount?.toFixed(2) ?? '0.00',
          address: user.polymarketProxyAddress,
        }) +
        (result.txHash
          ? `🔗 [View on Polygonscan](https://polygonscan.com/tx/${result.txHash})`
          : '');

      await sendPage(ctx, msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.backToReferrals'), 'referral_hub')],
          [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
        ]),
      });
    } else if (result.insufficientTreasury) {
      await notifyAdmins(ctx.telegram, `⚠️ <b>Treasury Yetersiz — Referral Claim</b>\nKullanıcı: ${telegramId}\nTutar: $${result.amount?.toFixed(2)}`);
      await sendPage(ctx, `❌ ${result.error}`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.backToReferrals'), 'referral_hub')],
          [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
        ]),
      });
    } else {
      await sendPage(ctx, `❌ ${result.error}`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.backToReferrals'), 'referral_hub')],
          [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
        ]),
      });
    }
  } catch (err) {
    logger.error('[referral] handleReferralClaim error:', err);
    await ctx.reply(t('en', 'referral.errorGeneric'));
  }
}

/**
 * Prompts the user to enter a new referral name.
 */
export async function handleReferralEditName(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    referralEditState.set(telegramId, { timestamp: Date.now() });

    await sendPage(ctx,
      t(lang, 'referral.editTitle') +
      t(lang, 'referral.editInstructions'),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.cancel'), 'referral_hub')],
        ]),
      }
    );
  } catch (err) {
    logger.error('[referral] handleReferralEditName error:', err);
    await ctx.reply(t('en', 'referral.errorGeneric'));
  }
}

/**
 * Handles the text input when user is editing their referral name.
 */
export async function handleReferralEditInput(ctx: Context, text: string): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    // Clear the edit state
    referralEditState.delete(telegramId);

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply(t('en', 'common.userNotFoundStart'));
      return;
    }

    const lang = getLang(user);

    const result = await updateReferralCode(user.id, text);

    if (!result.success) {
      // Show error and keep them in edit mode
      referralEditState.set(telegramId, { timestamp: Date.now() });
      await sendPage(ctx,
        `⚠️ ${result.error}\n\n<i>${t(lang, 'Please enter a different name or press Cancel:')}</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'btn.cancel'), 'referral_hub')],
          ]),
        }
      );
      return;
    }

    // Success — show updated hub
    await handleReferralHub(ctx);
  } catch (err) {
    logger.error('[referral] handleReferralEditInput error:', err);
    await ctx.reply(t('en', 'referral.errorGeneric'));
  }
}
