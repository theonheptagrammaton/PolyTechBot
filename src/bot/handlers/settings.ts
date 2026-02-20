import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { logger } from '../../utils/logger';
import { decrypt } from '../../utils/encryption';

/**
 * Shows settings menu
 */
export async function handleSettingsMenu(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.editMessageText('❌ User not found. Use /start to create your wallet.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    // Check 2FA status
    const twoFAStatus = user.twoFactorEnabled ? '✅ Enabled' : '❌ Disabled';
    const defaultAmount = user.defaultTradeAmount || 25;

    const message =
      '⚙️ *Settings*\n\n' +
      'Manage your account security and preferences.\n\n' +
      `🔐 *2FA Status:* ${twoFAStatus} _(Optional)_\n` +
      `💰 *Default Trade Amount:* $${defaultAmount}\n\n` +
      '💡 *Available Options:*\n' +
      '• View your private key\n' +
      '• Change default trade amount\n' +
      '• Configure Two-Factor Authentication (optional)\n\n' +
      '⚠️ Keep your private key safe and never share it with anyone.';

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Show Secret Key', 'settings_show_key')],
        [Markup.button.callback('💰 Change Default Amount', 'settings_change_amount')],
        [Markup.button.callback('🔐 2FA Settings', '2fa_menu')],
        [Markup.button.callback('« Back to Wallet', 'wallet_page')],
      ]),
    });

    logger.info(`Settings menu shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing settings menu:', error);
    await ctx.reply('❌ An error occurred while loading settings.');
  }
}

/**
 * Shows secret key (private key) with security warning
 */
export async function handleShowSecretKey(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.editMessageText('❌ User not found.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    // Decrypt private key
    const privateKey = decrypt(user.encryptedPrivateKey);

    const message =
      '🔑 *Your Secret Key (Private Key)*\n\n' +
      '⚠️ *CRITICAL SECURITY WARNING:*\n' +
      '• Never share this key with anyone\n' +
      '• Anyone with this key can access your funds\n' +
      '• Delete this message after copying\n' +
      '• Store it securely offline\n\n' +
      `🔐 *Private Key:*\n\`${privateKey}\`\n\n` +
      '💡 *What you can do with this key:*\n' +
      '• Import wallet to MetaMask or other wallets\n' +
      '• Recover your account on any device\n' +
      '• Backup your wallet\n\n' +
      '🚨 *Never enter this key on untrusted websites!*';

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Delete This Message', 'settings_delete_key_msg')],
        [Markup.button.callback('« Back to Settings', 'settings_menu')],
      ]),
    });

    logger.info(`Secret key shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing secret key:', error);
    await ctx.reply('❌ An error occurred while retrieving your secret key.');
  }
}

/**
 * Shows default amount selection
 */
export async function handleChangeDefaultAmount(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const { getUserByTelegramId } = await import('../../services/user');
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.editMessageText('❌ User not found.');
      return;
    }

    const currentAmount = user.defaultTradeAmount || 25;

    const message =
      '💰 *Default Trade Amount*\n\n' +
      `Current: $${currentAmount}\n\n` +
      'Select your default trade amount for quick trades:';

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('$10', 'settings_amount_10'),
          Markup.button.callback('$25', 'settings_amount_25'),
        ],
        [
          Markup.button.callback('$50', 'settings_amount_50'),
          Markup.button.callback('$100', 'settings_amount_100'),
        ],
        [Markup.button.callback('« Back', 'settings_menu')],
      ]),
    });

    logger.info(`Default amount selection shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing default amount selection:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Updates user's default trade amount
 */
export async function handleSetDefaultAmount(ctx: Context, amount: number): Promise<void> {
  try {
    await ctx.answerCbQuery(`Default set to $${amount}`);

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const { prisma } = await import('../../database/prisma');

    await prisma.user.update({
      where: { telegramId },
      data: { defaultTradeAmount: amount },
    });

    logger.info(`Default trade amount updated to $${amount} for user: ${telegramId}`);

    // Go back to settings menu
    await handleSettingsMenu(ctx);
  } catch (error) {
    logger.error('Error updating default amount:', error);
    await ctx.answerCbQuery('❌ Error updating amount');
  }
}

/**
 * Deletes the message containing the secret key
 */
export async function handleDeleteKeyMessage(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Message deleted for security');

    // Delete the message
    await ctx.deleteMessage();

    // Send a new confirmation message
    await ctx.reply(
      '✅ *Secret key message deleted*\n\n' +
      'Your private key has been removed from the chat for security.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ Settings', 'settings_menu')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      }
    );

    logger.info(`Secret key message deleted for user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error('Error deleting key message:', error);
    await ctx.reply('❌ Could not delete message. Please delete it manually.');
  }
}
