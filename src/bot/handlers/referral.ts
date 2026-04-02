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
  REFERRAL_MIN_CLAIM,
} from '../../services/referral';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const BOT_USERNAME = config.telegram.botUsername;

export async function handleReferralHub(ctx: Context): Promise<void> {
  try {
    // Answer immediately to clear the loading spinner (Telegram times out after 10s)
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('❌ User not found. Use /start first.');
      return;
    }

    // Ensure user has a referral code
    await ensureReferralCode(user.id, ctx.from?.username);

    const stats = await getReferralStats(user.id, BOT_USERNAME);

    const t1Pct = '25%';
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

    let msg = `${eHub} <b>Referral Hub</b>\n\n`;
    msg += `${eCode} Your Code: <code>${esc(stats.code)}</code>\n`;
    msg += `${eLink} Invite Link:\n<code>${esc(stats.inviteLink)}</code>\n\n`;
    msg += `━━━━━━━━━━━━━━━\n`;
    msg += `${eTier} <b>Tier Metrics</b>\n\n`;
    msg += `├ ${eT1} Tier 1 — Direct (${t1Pct})\n`;
    msg += `│   ${esc(stats.tier1Count)} people invited\n`;
    msg += `├ ${eT2} Tier 2 — Indirect (${t2Pct})\n`;
    msg += `│   ${esc(stats.tier2Count)} people\n`;
    msg += `└ ${eT3} Tier 3 — Network (${t3Pct})\n`;
    msg += `    ${esc(stats.tier3Count)} people\n\n`;
    msg += `━━━━━━━━━━━━━━━\n`;
    msg += `${eEarnings} <b>Earnings Dashboard</b>\n\n`;
    msg += `├ ${eMoney} Claimable: <b>$${esc(stats.claimable.toFixed(2))}</b>\n`;
    msg += `└ 💰 Total Earned: <b>$${esc(stats.earnedTotal.toFixed(2))}</b>\n\n`;


    await sendPage(ctx, msg, {
      parse_mode: 'HTML',
      image_path: IMG_REFERRAL,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            stats.claimable >= REFERRAL_MIN_CLAIM
              ? `💸 Withdraw ($${stats.claimable.toFixed(2)})`
              : `💸 Withdraw (Min $${REFERRAL_MIN_CLAIM})`,
            'referral_claim'
          ),
        ],
        [
          ({ text: '📋 Copy Link', copy_text: { text: stats.inviteLink } } as any),
          Markup.button.callback('🔄 Refresh', 'referral_hub'),
        ],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    });
  } catch (err) {
    logger.error('[referral] handleReferralHub error:', err);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
}

export async function handleReferralClaim(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.answerCbQuery?.('❌ User not found.').catch(() => {});
      return;
    }

    if (!user.polymarketProxyAddress) {
      await ctx.answerCbQuery?.('❌ No wallet found.').catch(() => {});
      return;
    }

    await ctx.answerCbQuery?.('⏳ Processing...').catch(() => {});

    const result = await claimReferralEarnings(user.id, user.polymarketProxyAddress);

    if (result.success) {
      const msg =
        `✅ *Withdrawal Successful!*\n\n` +
        `💵 Amount: *$${result.amount?.toFixed(2)}*\n` +
        `📍 Sent to: \`${user.polymarketProxyAddress}\`\n\n` +
        (result.txHash
          ? `🔗 [View on Polygonscan](https://polygonscan.com/tx/${result.txHash})`
          : '');

      await sendPage(ctx, msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👥 Back to Referrals', 'referral_hub')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      });
    } else if (result.insufficientTreasury) {
      await notifyAdmins(ctx.telegram, `⚠️ <b>Treasury Yetersiz — Referral Claim</b>\nKullanıcı: ${telegramId}\nTutar: $${result.amount?.toFixed(2)}`);
      await sendPage(ctx, `❌ ${result.error}`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👥 Back to Referrals', 'referral_hub')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      });
    } else {
      await sendPage(ctx, `❌ ${result.error}`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👥 Back to Referrals', 'referral_hub')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      });
    }
  } catch (err) {
    logger.error('[referral] handleReferralClaim error:', err);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
}
