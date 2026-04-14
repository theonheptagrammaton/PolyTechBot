import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { logger } from '../../utils/logger';
import { getUserByTelegramId } from '../../services/user';
import { sendPage } from '../../utils/telegram';
import {
  generateTwoFactorSecret,
  enableTwoFactor,
  disableTwoFactor,
  isTwoFactorEnabled,
  verifyUserTwoFactorToken,
  getRemainingBackupCodes,
} from '../../services/twoFactor';
import { RedisBackedState } from '../../utils/redisState';
import { t, Locale } from '../../i18n';

/** Get locale from user object */
function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

/** Try to resolve locale for the current context user */
async function resolveLocale(ctx: Context): Promise<Locale> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (telegramId) {
      const user = await getUserByTelegramId(telegramId);
      if (user) return getLang(user);
    }
  } catch { /* fallback to 'en' */ }
  return 'en';
}

// 2FA setup temporary state — TTL 10 min (matches setup window)
const twoFactorSetupCache = new RedisBackedState<{ secret: string; backupCodes: string[]; timestamp: number }>('twoFactorSetup', 600);

// User state for text input flows — TTL 10 min
export const userState = new RedisBackedState<{ action: string; timestamp: number }>('userAction', 600);

/**
 * Shows 2FA settings menu
 */
export async function handleTwoFactorMenu(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendPage(ctx, t('en', 'common.userNotFound'), {
        parse_mode: 'Markdown',
      });
      return;
    }

    const lang = getLang(user);

    // Always fetch fresh 2FA status from database (bypass cache)
    const is2FAEnabled = await isTwoFactorEnabled(telegramId);
    const backupCodesCount = await getRemainingBackupCodes(telegramId);

    let message = t(lang, 'twoFA.title');

    if (is2FAEnabled) {
      message += t(lang, 'twoFA.statusEnabled');
      message += t(lang, 'twoFA.backupCodesCount', { count: backupCodesCount });
      message += t(lang, 'twoFA.tipEnabled');
    } else {
      message += t(lang, 'twoFA.statusDisabled');
      message += t(lang, 'twoFA.benefits');
      message += t(lang, 'twoFA.youNeed');
    }

    const buttons = [];

    if (is2FAEnabled) {
      buttons.push([Markup.button.callback(t(lang, 'btn.viewBackupCodes'), '2fa_backup_codes')]);
      buttons.push([Markup.button.callback(t(lang, 'btn.disable2FA'), '2fa_disable')]);
    } else {
      buttons.push([Markup.button.callback(t(lang, 'btn.enable2FA'), '2fa_enable')]);
    }

    buttons.push([Markup.button.callback(t(lang, 'btn.backToWallet'), 'wallet_page')]);

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`2FA menu shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing 2FA menu:', error);
    await ctx.reply(t('en', 'twoFA.errorLoading'));
  }
}

/**
 * Start 2FA enablement process
 */
export async function handleEnableTwoFactor(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    const username = ctx.from?.username;

    if (!telegramId) {
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const lang = await resolveLocale(ctx);

    // Check if already enabled
    const isEnabled = await isTwoFactorEnabled(telegramId);
    if (isEnabled) {
      await ctx.reply(t(lang, 'twoFA.alreadyEnabled'), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.back'), '2fa_menu')]]),
      });
      return;
    }

    // Generate secret and QR code
    const { secret, qrCode, backupCodes } = await generateTwoFactorSecret(telegramId, username);

    // Store in temporary cache (expires in 10 minutes)
    twoFactorSetupCache.set(telegramId, {
      secret,
      backupCodes,
      timestamp: Date.now(),
    });

    // Send QR code as photo
    const message = t(lang, 'twoFA.setupStart', { secret });

    await ctx.deleteMessage();
    await ctx.replyWithPhoto(
      { source: Buffer.from(qrCode.split(',')[1], 'base64') },
      {
        caption: message,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.manualKey'), '2fa_show_key')],
          [Markup.button.callback(t(lang, 'btn.cancel'), '2fa_menu')],
        ]),
      }
    );

    // Set user state to expect 2FA code
    userState.set(telegramId, {
      action: '2fa_setup',
      timestamp: Date.now(),
    });

    logger.info(`2FA setup started for user: ${telegramId}`);
  } catch (error) {
    logger.error('Error starting 2FA setup:', error);
    await ctx.reply(t('en', 'twoFA.errorSetup'));
  }
}

/**
 * Verify 2FA code during setup
 */
export async function handleVerifyTwoFactorSetup(
  ctx: Context,
  code: string
): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const lang = await resolveLocale(ctx);

    // Get from cache
    const setupData = await twoFactorSetupCache.get(telegramId);
    if (!setupData) {
      await ctx.reply(
        t(lang, 'twoFA.setupExpired'),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.backTo2FA'), '2fa_menu')]]),
        }
      );
      return;
    }

    // Check if expired (10 minutes)
    if (Date.now() - setupData.timestamp > 10 * 60 * 1000) {
      twoFactorSetupCache.delete(telegramId);
      await ctx.reply(
        t(lang, 'twoFA.setupExpired'),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.backTo2FA'), '2fa_menu')]]),
        }
      );
      return;
    }

    // Verify code
    const success = await enableTwoFactor(
      telegramId,
      setupData.secret,
      code,
      setupData.backupCodes
    );

    if (!success) {
      await ctx.reply(
        t(lang, 'twoFA.invalidCode'),
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Remove from cache
    twoFactorSetupCache.delete(telegramId);

    // Show backup codes
    let message = t(lang, 'twoFA.enableSuccess');
    message += t(lang, 'twoFA.saveBackupCodes');
    message += t(lang, 'twoFA.backupCodesTitle');
    message += '```\n';
    setupData.backupCodes.forEach((code, index) => {
      message += `${index + 1}. ${code}\n`;
    });
    message += '```\n\n';
    message += t(lang, 'twoFA.keepCodesSafe');

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn.iSavedCodes'), '2fa_menu')],
      ]),
    });

    logger.info(`2FA enabled successfully for user: ${telegramId}`);
  } catch (error) {
    logger.error('Error verifying 2FA setup:', error);
    await ctx.reply(t('en', 'twoFA.errorVerify'));
  }
}

/**
 * Show manual setup key (alternative to QR code)
 */
export async function handleShowManualKey(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const lang = await resolveLocale(ctx);

    const setupData = await twoFactorSetupCache.get(telegramId);
    if (!setupData || Date.now() - setupData.timestamp > 10 * 60 * 1000) {
      twoFactorSetupCache.delete(telegramId!);
      await ctx.reply(
        t(lang, 'twoFA.setupExpired'),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.backTo2FA'), '2fa_menu')]]),
        }
      );
      return;
    }

    // Format secret in groups of 4 for easier manual entry
    const formattedSecret = setupData.secret.match(/.{1,4}/g)?.join(' ') || setupData.secret;

    const message = t(lang, 'twoFA.manualSetup', { secret: formattedSecret });

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.cancel'), '2fa_menu')]]),
    });
  } catch (error) {
    logger.error('Error showing manual key:', error);
    await ctx.reply(t('en', 'common.errorGeneric'));
  }
}

/**
 * Disable 2FA
 */
export async function handleDisableTwoFactor(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const lang = await resolveLocale(ctx);

    await sendPage(ctx,
      t(lang, 'twoFA.disableConfirm'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.cancel'), '2fa_menu')]]),
      }
    );

    // Set user state to expect 2FA code
    userState.set(telegramId, {
      action: '2fa_disable',
      timestamp: Date.now(),
    });

    logger.info(`2FA disable requested for user: ${telegramId}`);
  } catch (error) {
    logger.error('Error starting 2FA disable:', error);
    await ctx.reply(t('en', 'common.errorGeneric'));
  }
}

/**
 * Confirm disable 2FA with code
 */
export async function handleConfirmDisableTwoFactor(
  ctx: Context,
  code: string
): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const lang = await resolveLocale(ctx);

    // Verify code
    const isValid = await verifyUserTwoFactorToken(telegramId, code);
    if (!isValid) {
      await ctx.reply(
        t(lang, 'twoFA.disableInvalidCode'),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.back2FA'), '2fa_menu')]]),
        }
      );
      return;
    }

    // Disable 2FA
    await disableTwoFactor(telegramId);

    await ctx.reply(
      t(lang, 'twoFA.disabled'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.backToWallet'), 'wallet_page')]]),
      }
    );

    logger.info(`2FA disabled for user: ${telegramId}`);
  } catch (error) {
    logger.error('Error confirming 2FA disable:', error);
    await ctx.reply(t('en', 'twoFA.errorDisable'));
  }
}

/**
 * Show backup codes
 */
export async function handleShowBackupCodes(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const lang = await resolveLocale(ctx);

    await sendPage(ctx,
      t(lang, 'twoFA.viewBackupCodes'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.back'), '2fa_menu')]]),
      }
    );
  } catch (error) {
    logger.error('Error showing backup codes info:', error);
    await ctx.reply(t('en', 'common.errorGeneric'));
  }
}

/**
 * Prompt for 2FA code (used in trading/withdraw flows)
 */
export async function prompt2FACode(ctx: Context, action: string): Promise<void> {
  try {
    const lang = await resolveLocale(ctx);

    const message = t(lang, 'twoFA.required', { action });

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.cancel'), 'back_to_menu')]]),
    });
  } catch (error) {
    logger.error('Error prompting 2FA code:', error);
    await ctx.reply(t('en', 'common.errorGeneric'));
  }
}
