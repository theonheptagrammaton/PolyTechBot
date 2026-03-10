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

// Temporary storage for 2FA setup (in production, use Redis)
const twoFactorSetupCache = new Map<
  string,
  { secret: string; backupCodes: string[]; timestamp: number }
>();

// User state for text input flows (shared with bot/index.ts)
// In production, this should be in Redis
export const userState = new Map<string, { action: string; timestamp: number }>();

/**
 * Shows 2FA settings menu
 */
export async function handleTwoFactorMenu(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendPage(ctx, '❌ User not found. Use /start to create your wallet.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    // Always fetch fresh 2FA status from database (bypass cache)
    const is2FAEnabled = await isTwoFactorEnabled(telegramId);
    const backupCodesCount = await getRemainingBackupCodes(telegramId);

    let message = '🔐 *Two-Factor Authentication (2FA)*\n\n';

    if (is2FAEnabled) {
      message += '✅ *Status:* Enabled\n\n';
      message += '🔒 2FA is currently protecting your account.\n\n';
      message += `🔑 *Backup Codes:* ${backupCodesCount} remaining\n\n`;
      message += '💡 *Tip:* Keep your backup codes safe. They can be used if you lose access to your authenticator app.';
    } else {
      message += '❌ *Status:* Disabled\n\n';
      message += '🔓 *2FA is completely optional.*\n\n';
      message += '💡 *Benefits if you enable it:*\n';
      message += '• Extra layer of security for your account\n';
      message += '• Additional protection for your funds\n';
      message += '• Peace of mind with two-factor authentication\n\n';
      message += '📱 *You will need:*\n';
      message += '• Google Authenticator or similar app\n';
      message += '• Your phone to scan a QR code';
    }

    const buttons = [];

    if (is2FAEnabled) {
      buttons.push([Markup.button.callback('🔑 View Backup Codes', '2fa_backup_codes')]);
      buttons.push([Markup.button.callback('❌ Disable 2FA', '2fa_disable')]);
    } else {
      buttons.push([Markup.button.callback('✅ Enable 2FA', '2fa_enable')]);
    }

    buttons.push([Markup.button.callback('« Back to Wallet', 'wallet_page')]);

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`2FA menu shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing 2FA menu:', error);
    await ctx.reply('❌ An error occurred while loading 2FA settings.');
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
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    // Check if already enabled
    const isEnabled = await isTwoFactorEnabled(telegramId);
    if (isEnabled) {
      await ctx.reply('✅ 2FA is already enabled for your account.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', '2fa_menu')]]),
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
    const message =
      '🔐 *Enable Two-Factor Authentication*\n\n' +
      '*Step 1:* Scan the QR code, or enter this key manually:\n' +
      `\`${secret}\`\n\n` +
      '*Step 2:* After adding, enter the 6-digit code shown in your app\n\n' +
      '*Step 3:* Send me the 6-digit code to verify\n\n' +
      '💡 *Tip:* The code changes every 30 seconds';

    await ctx.deleteMessage();
    await ctx.replyWithPhoto(
      { source: Buffer.from(qrCode.split(',')[1], 'base64') },
      {
        caption: message,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔑 Manual Key', '2fa_show_key')],
          [Markup.button.callback('❌ Cancel', '2fa_menu')],
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
    await ctx.reply('❌ An error occurred while starting 2FA setup.');
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
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    // Get from cache
    const setupData = twoFactorSetupCache.get(telegramId);
    if (!setupData) {
      await ctx.reply(
        '❌ *Setup Expired*\n\n' +
        'Your 2FA setup session has expired. Please start again.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔐 2FA Settings', '2fa_menu')]]),
        }
      );
      return;
    }

    // Check if expired (10 minutes)
    if (Date.now() - setupData.timestamp > 10 * 60 * 1000) {
      twoFactorSetupCache.delete(telegramId);
      await ctx.reply(
        '❌ *Setup Expired*\n\n' +
        'Your 2FA setup session has expired. Please start again.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔐 2FA Settings', '2fa_menu')]]),
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
        '❌ *Invalid Code*\n\n' +
        'The code you entered is incorrect. Please try again.\n\n' +
        '💡 Make sure you\'re entering the 6-digit code from your authenticator app.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Remove from cache
    twoFactorSetupCache.delete(telegramId);

    // Show backup codes
    let message = '✅ *2FA Enabled Successfully!*\n\n';
    message += '🔑 *IMPORTANT: Save Your Backup Codes*\n\n';
    message += 'These codes can be used if you lose access to your authenticator app.\n\n';
    message += '*Your Backup Codes:*\n';
    message += '```\n';
    setupData.backupCodes.forEach((code, index) => {
      message += `${index + 1}. ${code}\n`;
    });
    message += '```\n\n';
    message += '⚠️ *Keep these codes safe and secure!*\n';
    message += '• Write them down\n';
    message += '• Store in a password manager\n';
    message += '• Never share them with anyone\n\n';
    message += 'Each backup code can only be used once.';

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ I Saved My Codes', '2fa_menu')],
      ]),
    });

    logger.info(`2FA enabled successfully for user: ${telegramId}`);
  } catch (error) {
    logger.error('Error verifying 2FA setup:', error);
    await ctx.reply('❌ An error occurred while verifying your code.');
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
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const setupData = twoFactorSetupCache.get(telegramId);
    if (!setupData || Date.now() - setupData.timestamp > 10 * 60 * 1000) {
      twoFactorSetupCache.delete(telegramId!);
      await ctx.reply(
        '❌ *Setup Expired*\n\nYour 2FA setup session has expired. Please start again.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔐 2FA Settings', '2fa_menu')]]),
        }
      );
      return;
    }

    // Format secret in groups of 4 for easier manual entry
    const formattedSecret = setupData.secret.match(/.{1,4}/g)?.join(' ') || setupData.secret;

    const message =
      '🔑 *Manual 2FA Setup*\n\n' +
      'In Google Authenticator or any TOTP app:\n\n' +
      '1️⃣ Open the app → tap *"+"* or *"Add account"*\n' +
      '2️⃣ Select *"Enter a setup key"*\n' +
      '3️⃣ Enter any name for the account\n' +
      '4️⃣ Copy and paste the key below:\n\n' +
      `\`${formattedSecret}\`\n\n` +
      '5️⃣ After adding, send me the *6-digit code* shown in your app\n\n' +
      '💡 Key type: *Time-based (TOTP)*';

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', '2fa_menu')]]),
    });
  } catch (error) {
    logger.error('Error showing manual key:', error);
    await ctx.reply('❌ An error occurred.');
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
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    await sendPage(ctx,
      '⚠️ *Disable Two-Factor Authentication*\n\n' +
      'Are you sure you want to disable 2FA?\n\n' +
      'This will reduce the security of your account.\n\n' +
      'To confirm, please enter your 6-digit code from your authenticator app:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Cancel', '2fa_menu')]]),
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
    await ctx.reply('❌ An error occurred.');
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
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    // Verify code
    const isValid = await verifyUserTwoFactorToken(telegramId, code);
    if (!isValid) {
      await ctx.reply(
        '❌ *Invalid Code*\n\n' +
        'The code you entered is incorrect. 2FA was not disabled.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔐 Back to 2FA', '2fa_menu')]]),
        }
      );
      return;
    }

    // Disable 2FA
    await disableTwoFactor(telegramId);

    await ctx.reply(
      '✅ *2FA Disabled*\n\n' +
      'Two-factor authentication has been disabled for your account.\n\n' +
      '💡 You can enable it again at any time from your wallet settings.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back to Wallet', 'wallet_page')]]),
      }
    );

    logger.info(`2FA disabled for user: ${telegramId}`);
  } catch (error) {
    logger.error('Error confirming 2FA disable:', error);
    await ctx.reply('❌ An error occurred while disabling 2FA.');
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
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    await sendPage(ctx,
      '🔑 *View Backup Codes*\n\n' +
      '⚠️ For security reasons, backup codes cannot be displayed again.\n\n' +
      'If you lost your backup codes, you can:\n' +
      '• Disable 2FA (requires current authenticator code)\n' +
      '• Re-enable 2FA to get new backup codes\n\n' +
      '💡 *Tip:* Keep your backup codes in a secure password manager.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', '2fa_menu')]]),
      }
    );
  } catch (error) {
    logger.error('Error showing backup codes info:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Prompt for 2FA code (used in trading/withdraw flows)
 */
export async function prompt2FACode(ctx: Context, action: string): Promise<void> {
  try {
    const message =
      '🔐 *Two-Factor Authentication Required*\n\n' +
      `To complete this ${action}, please enter your 6-digit code from your authenticator app:\n\n` +
      '💡 You can also use a backup code if you don\'t have access to your authenticator.';

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'back_to_menu')]]),
    });
  } catch (error) {
    logger.error('Error prompting 2FA code:', error);
    await ctx.reply('❌ An error occurred.');
  }
}
