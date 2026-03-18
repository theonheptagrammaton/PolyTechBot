import path from 'path';
import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { logger } from '../../utils/logger';
import { decrypt } from '../../utils/encryption';
import { sendPage } from '../../utils/telegram';
import { RedisBackedState } from '../../utils/redisState';

const IMG_SETTINGS = path.join(__dirname, '../img/settings.PNG');

// Tracks users who are waiting to type a custom default trade amount (TTL: 10 min)
export const settingsAmountState = new RedisBackedState<{ timestamp: number }>('settingsAmount', 600);

// Tracks users who are waiting to type a custom slippage tolerance value (TTL: 10 min)
export const settingsSlippageState = new RedisBackedState<{ timestamp: number }>('settingsSlippage', 600);

/**
 * Shows settings menu
 */
export async function handleSettingsMenu(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

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

    const twoFAStatus    = user.twoFactorEnabled ? '✅ Enabled' : '❌ Disabled';
    const defaultAmount  = user.defaultTradeAmount || 25;
    const slippagePct    = user.slippageTolerance ?? 1.0;

    const message =
      '⚙️ *Settings*\n\n' +
      'Manage your account security and preferences.\n\n' +
      `🔐 *2FA Status:* ${twoFAStatus} _(Optional)_\n` +
      `💰 *Default Trade Amount:* $${defaultAmount}\n` +
      `⚡ *Slippage Tolerance:* ${slippagePct}%\n\n` +
      '💡 *Available Options:*\n' +
      '• View your private key\n' +
      '• Change default trade amount\n' +
      '• Configure slippage tolerance for market orders\n' +
      '• Configure Two-Factor Authentication (optional)\n\n' +
      '⚠️ Keep your private key safe and never share it with anyone.';

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      image_path: IMG_SETTINGS,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Show Secret Key',       'settings_show_key')],
        [Markup.button.callback('💰 Change Default Amount', 'settings_change_amount')],
        [Markup.button.callback('⚡ Slippage Tolerance',    'settings_change_slippage')],
        [Markup.button.callback('🔐 2FA Settings',          '2fa_menu')],
        [Markup.button.callback('« Back to Wallet',         'wallet_page')],
        [Markup.button.callback('🏠 Main Menu',               'back_to_menu')],
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
      await sendPage(ctx, '❌ User not found.', {
        parse_mode: 'Markdown',
      });
      return;
    }

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

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Delete This Message', 'settings_delete_key_msg')],
        [Markup.button.callback('« Back to Settings', 'settings_menu')],
        [Markup.button.callback('🏠 Main Menu',        'back_to_menu')],
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
      await sendPage(ctx, '❌ User not found.');
      return;
    }

    const currentAmount = user.defaultTradeAmount || 25;

    const message =
      '💰 *Default Trade Amount*\n\n' +
      `Current: *$${currentAmount}*\n\n` +
      'Pick a preset or type any amount:';

    settingsAmountState.set(telegramId, { timestamp: Date.now() });

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('$10',  'settings_amount_10'),
          Markup.button.callback('$25',  'settings_amount_25'),
          Markup.button.callback('$50',  'settings_amount_50'),
          Markup.button.callback('$100', 'settings_amount_100'),
        ],
        [Markup.button.callback('« Back', 'settings_menu')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
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

    settingsAmountState.delete(telegramId);

    const { prisma } = await import('../../database/prisma');
    const { invalidateUserCache } = await import('../../services/user');

    const updatedUser = await prisma.user.update({
      where: { telegramId },
      data: { defaultTradeAmount: amount },
    });

    await invalidateUserCache(updatedUser);

    logger.info(`Default trade amount updated to $${amount} for user: ${telegramId}`);

    await handleSettingsMenu(ctx);
  } catch (error) {
    logger.error('Error updating default amount:', error);
    await ctx.answerCbQuery('❌ Error updating amount');
  }
}

/**
 * Handles a typed custom default trade amount.
 * Called from bot/index.ts text handler when settingsAmountState is active.
 */
export async function handleCustomAmountInput(ctx: Context, text: string): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  settingsAmountState.delete(telegramId);

  // Locale-aware parse: handles "1,5" (EU) → 1.5 and "1,000" (US) → 1000
  const raw = text.trim().replace(/[^\d.,]/g, '');
  const lastComma = raw.lastIndexOf(',');
  const lastDot   = raw.lastIndexOf('.');
  const normalized = lastComma > lastDot
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(/,/g, '');
  const amount = parseFloat(normalized);

  if (isNaN(amount) || amount < 1) {
    await sendPage(ctx,
      '❌ *Invalid amount*\n\nPlease enter a number of at least $1.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💰 Try Again', 'settings_change_amount')],
          [Markup.button.callback('« Back', 'settings_menu')],
        ]),
      }
    );
    return;
  }

  if (amount > 100_000) {
    await sendPage(ctx,
      '❌ *Amount too large*\n\nMaximum default amount is $100,000.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💰 Try Again', 'settings_change_amount')],
        ]),
      }
    );
    return;
  }

  const rounded = Math.round(amount * 100) / 100;

  const { prisma } = await import('../../database/prisma');
  const { invalidateUserCache } = await import('../../services/user');

  const updatedUser = await prisma.user.update({
    where: { telegramId },
    data: { defaultTradeAmount: rounded },
  });

  await invalidateUserCache(updatedUser);

  logger.info(`Default trade amount updated to $${rounded} for user: ${telegramId}`);

  await sendPage(ctx,
    `✅ *Default trade amount set to $${rounded}*\n\nAll your quick trades will now default to this amount.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⚙️ Settings', 'settings_menu')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    }
  );
}

// ─── Slippage Tolerance ──────────────────────────────────────────────────────

/**
 * Shows slippage tolerance selection with presets and custom text input.
 */
export async function handleChangeSlippage(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendPage(ctx, '❌ User not found.');
      return;
    }

    const current = user.slippageTolerance ?? 1.0;

    const message =
      '⚡ *Slippage Tolerance*\n\n' +
      `Current: *${current}%*\n\n` +
      'Slippage is the maximum price increase you accept for a market buy order.\n' +
      '_Higher slippage → better fill chance. Lower slippage → price protection._\n\n' +
      'Pick a preset or type a value (e.g. `2.5`):';

    settingsSlippageState.set(telegramId, { timestamp: Date.now() });

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('0.5%', 'settings_slippage_05'),
          Markup.button.callback('1%',   'settings_slippage_1'),
          Markup.button.callback('2%',   'settings_slippage_2'),
          Markup.button.callback('5%',   'settings_slippage_5'),
        ],
        [Markup.button.callback('« Back', 'settings_menu')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    });

    logger.info(`Slippage selection shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing slippage selection:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Saves a preset slippage value.
 */
export async function handleSetSlippage(ctx: Context, pct: number): Promise<void> {
  try {
    await ctx.answerCbQuery(`Slippage set to ${pct}%`);

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    settingsSlippageState.delete(telegramId);

    const { prisma } = await import('../../database/prisma');
    const { invalidateUserCache } = await import('../../services/user');

    const updatedUser = await prisma.user.update({
      where: { telegramId },
      data: { slippageTolerance: pct },
    });

    await invalidateUserCache(updatedUser);

    logger.info(`Slippage tolerance updated to ${pct}% for user: ${telegramId}`);

    await handleSettingsMenu(ctx);
  } catch (error) {
    logger.error('Error updating slippage:', error);
    await ctx.answerCbQuery('❌ Error updating slippage');
  }
}

/**
 * Handles a typed custom slippage value (0.1–25%).
 * Called from bot/index.ts text handler when settingsSlippageState is active.
 */
export async function handleCustomSlippageInput(ctx: Context, text: string): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  settingsSlippageState.delete(telegramId);

  const raw = text.trim().replace(/[^\d.,]/g, '');
  const lastComma = raw.lastIndexOf(',');
  const lastDot   = raw.lastIndexOf('.');
  const normalized = lastComma > lastDot
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(/,/g, '');
  const value = parseFloat(normalized);

  if (isNaN(value) || value < 0.1) {
    await sendPage(ctx,
      '❌ *Invalid slippage*\n\nMinimum slippage is 0.1%.\n\nExample: `1` or `2.5`',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚡ Try Again', 'settings_change_slippage')],
          [Markup.button.callback('« Back', 'settings_menu')],
        ]),
      }
    );
    return;
  }

  if (value > 25) {
    await sendPage(ctx,
      '❌ *Slippage too high*\n\nMaximum slippage is 25%.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚡ Try Again', 'settings_change_slippage')],
        ]),
      }
    );
    return;
  }

  const rounded = Math.round(value * 10) / 10; // 1 decimal place

  const { prisma } = await import('../../database/prisma');
  const { invalidateUserCache } = await import('../../services/user');

  const updatedUser = await prisma.user.update({
    where: { telegramId },
    data: { slippageTolerance: rounded },
  });

  await invalidateUserCache(updatedUser);

  logger.info(`Slippage tolerance updated to ${rounded}% for user: ${telegramId}`);

  await sendPage(ctx,
    `✅ *Slippage tolerance set to ${rounded}%*\n\nAll market buy orders will now use at most ${rounded}% above the current price.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⚙️ Settings', 'settings_menu')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    }
  );
}

/**
 * Deletes the message containing the secret key
 */
export async function handleDeleteKeyMessage(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Message deleted for security');

    await ctx.deleteMessage();

    await sendPage(ctx,
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
