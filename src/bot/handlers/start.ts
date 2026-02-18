import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { createUserWithWallet, getUserByTelegramId } from '../../services/user';
import { logger } from '../../utils/logger';
import { maskSensitiveData } from '../../utils/encryption';

export async function handleStart(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    const username = ctx.from?.username;
    const firstName = ctx.from?.first_name;
    const lastName = ctx.from?.last_name;

    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    logger.info(`Start command received from user: ${telegramId}`);

    // Send initial message
    await ctx.reply('🔄 Creating your Polymarket wallet...\n\nPlease wait a moment.');

    try {
      // Check if user already exists
      const existingUser = await getUserByTelegramId(telegramId);

      if (existingUser) {
        logger.info(`User already exists: ${telegramId}`);

        await ctx.reply(
          '✅ Welcome back!\n\n' +
          'Your wallet is already set up and ready to use.\n\n' +
          `📍 Wallet Address: \`${existingUser.walletAddress}\`\n\n` +
          '💡 Use /help to see available commands.',
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📊 Browse Markets', 'show_categories')],
              [Markup.button.callback('🔍 Search Markets', 'search_markets')],
              [Markup.button.callback('💼 My Wallet', 'show_wallet')],
            ]),
          }
        );
        return;
      }

      // Create new user with wallet
      const result = await createUserWithWallet(
        telegramId,
        username,
        firstName,
        lastName
      );

      logger.info(`User created successfully: ${result.user.id}`);

      // Prepare success message
      let successMessage =
        '🎉 *Your Multi-Chain Wallet is Ready!*\n\n' +
        '✅ Your wallets have been created successfully.\n\n' +
        '*EVM Wallet (Polygon, Ethereum, BNB):*\n' +
        `📍 Address: \`${result.walletInfo.walletAddress}\`\n` +
        `🔐 Private Key: \`${result.walletInfo.privateKey}\`\n\n`;

      if (result.walletInfo.solanaAddress && result.walletInfo.solanaPrivateKey) {
        successMessage +=
          '*Solana Wallet:*\n' +
          `📍 Address: \`${result.walletInfo.solanaAddress}\`\n` +
          `🔐 Private Key: \`${result.walletInfo.solanaPrivateKey}\`\n\n`;
      }

      successMessage +=
        '⚠️ *IMPORTANT SECURITY NOTICE:*\n' +
        '• Save your private keys in a secure location\n' +
        '• Never share them with anyone\n' +
        '• This is the ONLY time we will show your full private keys\n' +
        '• If you lose them, you will lose access to your wallets\n\n' +
        '📊 Your wallets are now ready for trading on Polymarket!\n\n' +
        '💡 Use the buttons below to manage your wallets.';

      await ctx.reply(successMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Browse Markets', 'show_categories')],
          [Markup.button.callback('🔍 Search Markets', 'search_markets')],
          [Markup.button.callback('💼 My Wallet', 'show_wallet')],
        ]),
      });

      // Log success with masked private key
      logger.info(
        `Wallet created for user ${telegramId}: ${result.walletInfo.walletAddress} ` +
        `(PK: ${maskSensitiveData(result.walletInfo.privateKey)})`
      );

    } catch (error) {
      logger.error('Error in start command:', error);

      await ctx.reply(
        '❌ *Error Creating Wallet*\n\n' +
        'We encountered an error while creating your wallet. ' +
        'This might be a temporary issue.\n\n' +
        'Please try again in a few moments. If the problem persists, ' +
        'contact support.',
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    logger.error('Unexpected error in start handler:', error);

    try {
      await ctx.reply(
        '❌ An unexpected error occurred. Please try again later.'
      );
    } catch (replyError) {
      logger.error('Error sending error message:', replyError);
    }
  }
}
