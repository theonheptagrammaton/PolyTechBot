import path from 'path';
import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { logger } from '../../utils/logger';
import { decrypt } from '../../utils/encryption';
import { sendPage } from '../../utils/telegram';
import { RedisBackedState } from '../../utils/redisState';
import { t, Locale, LOCALE_LABELS, SUPPORTED_LOCALES } from '../../i18n';

const IMG_SETTINGS = path.join(__dirname, '../img/settings.PNG');

// Tracks users who are waiting to type a custom default trade amount (TTL: 10 min)
export const settingsAmountState = new RedisBackedState<{ timestamp: number }>('settingsAmount', 600);

// Tracks users who are waiting to type a custom slippage tolerance value (TTL: 10 min)
export const settingsSlippageState = new RedisBackedState<{ timestamp: number }>('settingsSlippage', 600);

/** Get locale from user object */
function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

/**
 * Shows settings menu
 */
export async function handleSettingsMenu(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

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
    const twoFAStatus    = user.twoFactorEnabled ? t(lang, 'settings.twoFAEnabled') : t(lang, 'settings.twoFADisabled');
    const defaultAmount  = user.defaultTradeAmount || 25;
    const slippagePct    = user.slippageTolerance ?? 1.0;

    const message =
      t(lang, 'settings.title') +
      t(lang, 'settings.subtitle') +
      t(lang, 'settings.twoFAStatus', { status: twoFAStatus }) +
      t(lang, 'settings.defaultAmount', { amount: defaultAmount }) +
      t(lang, 'settings.slippage', { pct: slippagePct }) +
      t(lang, 'settings.options') +
      t(lang, 'settings.keyWarning');

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      image_path: IMG_SETTINGS,
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn.showSecretKey'),       'settings_show_key')],
        [Markup.button.callback(t(lang, 'btn.changeDefaultAmount'), 'settings_change_amount')],
        [Markup.button.callback(t(lang, 'btn.slippageTolerance'),    'settings_change_slippage')],
        [Markup.button.callback(t(lang, 'btn.twoFASettings'),          '2fa_menu')],
        [Markup.button.callback(t(lang, 'btn.language'),             'settings_language')],
        [Markup.button.callback(t(lang, 'btn.backToWallet'),         'wallet_page')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'),               'back_to_menu')],
      ]),
    });

    logger.info(`Settings menu shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing settings menu:', error);
    await ctx.reply(t('en', 'settings.errorLoading'));
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
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendPage(ctx, t('en', 'common.userNotFoundShort'), {
        parse_mode: 'Markdown',
      });
      return;
    }

    const lang = getLang(user);
    const privateKey = decrypt(user.encryptedPrivateKey);

    const message =
      t(lang, 'settings.secretKey.title') +
      t(lang, 'settings.secretKey.warning') +
      t(lang, 'settings.secretKey.key', { key: privateKey }) +
      t(lang, 'settings.secretKey.uses') +
      t(lang, 'settings.secretKey.neverShare');

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn.deleteMessage'), 'settings_delete_key_msg')],
        [Markup.button.callback(t(lang, 'btn.backToSettings'), 'settings_menu')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'),        'back_to_menu')],
      ]),
    });

    logger.info(`Secret key shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing secret key:', error);
    await ctx.reply(t('en', 'settings.secretKey.errorLoading'));
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
      await sendPage(ctx, t('en', 'common.userNotFoundShort'));
      return;
    }

    const lang = getLang(user);
    const currentAmount = user.defaultTradeAmount || 25;

    const message =
      t(lang, 'settings.amount.title') +
      t(lang, 'settings.amount.current', { amount: currentAmount }) +
      t(lang, 'settings.amount.prompt');

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
        [Markup.button.callback(t(lang, 'btn.back'), 'settings_menu')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
      ]),
    });

    logger.info(`Default amount selection shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing default amount selection:', error);
    await ctx.reply(t('en', 'common.errorGeneric'));
  }
}

/**
 * Updates user's default trade amount
 */
export async function handleSetDefaultAmount(ctx: Context, amount: number): Promise<void> {
  try {
    await ctx.answerCbQuery(t('en', 'settings.amount.setCb', { amount }));

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
    await ctx.answerCbQuery(t('en', 'settings.amount.errorCb'));
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

  const user = await getUserByTelegramId(telegramId);
  const lang = getLang(user);

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
      t(lang, 'settings.amount.invalid'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.tryAgainAmount'), 'settings_change_amount')],
          [Markup.button.callback(t(lang, 'btn.back'), 'settings_menu')],
        ]),
      }
    );
    return;
  }

  if (amount > 100_000) {
    await sendPage(ctx,
      t(lang, 'settings.amount.tooLarge'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.tryAgainAmount'), 'settings_change_amount')],
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
    t(lang, 'settings.amount.success', { amount: rounded }),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn.settings'), 'settings_menu')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
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
      await sendPage(ctx, t('en', 'common.userNotFoundShort'));
      return;
    }

    const lang = getLang(user);
    const current = user.slippageTolerance ?? 1.0;

    const message =
      t(lang, 'settings.slippageTitle') +
      t(lang, 'settings.slippageCurrent', { pct: current }) +
      t(lang, 'settings.slippageDesc') +
      t(lang, 'settings.slippagePrompt');

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
        [Markup.button.callback(t(lang, 'btn.back'), 'settings_menu')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
      ]),
    });

    logger.info(`Slippage selection shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error showing slippage selection:', error);
    await ctx.reply(t('en', 'common.errorGeneric'));
  }
}

/**
 * Saves a preset slippage value.
 */
export async function handleSetSlippage(ctx: Context, pct: number): Promise<void> {
  try {
    await ctx.answerCbQuery(t('en', 'settings.slippageCb', { pct }));

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
    await ctx.answerCbQuery(t('en', 'settings.slippageErrorCb'));
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

  const user = await getUserByTelegramId(telegramId);
  const lang = getLang(user);

  const raw = text.trim().replace(/[^\d.,]/g, '');
  const lastComma = raw.lastIndexOf(',');
  const lastDot   = raw.lastIndexOf('.');
  const normalized = lastComma > lastDot
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(/,/g, '');
  const value = parseFloat(normalized);

  if (isNaN(value) || value < 0.1) {
    await sendPage(ctx,
      t(lang, 'settings.slippageInvalid'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.tryAgainSlippage'), 'settings_change_slippage')],
          [Markup.button.callback(t(lang, 'btn.back'), 'settings_menu')],
        ]),
      }
    );
    return;
  }

  if (value > 25) {
    await sendPage(ctx,
      t(lang, 'settings.slippageTooHigh'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.tryAgainSlippage'), 'settings_change_slippage')],
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
    t(lang, 'settings.slippageSuccess', { pct: rounded }),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn.settings'), 'settings_menu')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
      ]),
    }
  );
}

/**
 * Deletes the message containing the secret key
 */
export async function handleDeleteKeyMessage(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    const user = telegramId ? await getUserByTelegramId(telegramId) : null;
    const lang = getLang(user);

    await ctx.answerCbQuery(t(lang, 'settings.secretKey.deletedCb'));

    await ctx.deleteMessage();

    await sendPage(ctx,
      t(lang, 'settings.secretKey.deleted'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.settings'), 'settings_menu')],
          [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
        ]),
      }
    );

    logger.info(`Secret key message deleted for user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error('Error deleting key message:', error);
    await ctx.reply(t('en', 'settings.secretKey.deleteFailed'));
  }
}

// ─── Language Selection ──────────────────────────────────────────────────────

/**
 * Shows language selection menu
 */
export async function handleLanguageMenu(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);
    const currentLabel = LOCALE_LABELS[lang];

    const message =
      t(lang, 'settings.language.title') +
      t(lang, 'settings.language.current', { lang: currentLabel }) +
      t(lang, 'settings.language.prompt');

    const buttons = SUPPORTED_LOCALES.map(locale => {
      const label = locale === lang
        ? `✅ ${LOCALE_LABELS[locale]}`
        : LOCALE_LABELS[locale];
      return [Markup.button.callback(label, `settings_lang_${locale}`)];
    });
    buttons.push([Markup.button.callback(t(lang, 'btn.backToSettings'), 'settings_menu')]);

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (error) {
    logger.error('Error showing language menu:', error);
    await ctx.reply(t('en', 'common.errorGeneric'));
  }
}

/**
 * Updates user's language preference
 */
export async function handleSetLanguage(ctx: Context, locale: Locale): Promise<void> {
  try {
    await ctx.answerCbQuery(t(locale, 'settings.language.changed', { lang: LOCALE_LABELS[locale] }));

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const { prisma } = await import('../../database/prisma');
    const { invalidateUserCache } = await import('../../services/user');

    const updatedUser = await prisma.user.update({
      where: { telegramId },
      data: { language: locale },
    });

    await invalidateUserCache(updatedUser);

    // Update context language for this request
    (ctx as any).userLanguage = locale;

    logger.info(`Language updated to ${locale} for user: ${telegramId}`);

    await handleSettingsMenu(ctx);
  } catch (error) {
    logger.error('Error updating language:', error);
    await ctx.answerCbQuery(t('en', 'common.errorGeneric'));
  }
}
