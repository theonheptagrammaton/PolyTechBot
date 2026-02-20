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

    // Check for deep link parameter (e.g., /start event_123 or /start trade_...)
    const messageText = 'text' in ctx.message! ? ctx.message.text : '';
    const startParam = messageText.split(' ')[1];

    if (startParam?.startsWith('event_')) {
      // User clicked on a "Trade" link - show event details
      const eventId = startParam.replace('event_', '');
      logger.info(`Deep link to event ${eventId} from user: ${telegramId}`);

      const { handleEventDetails } = await import('./markets');
      await handleEventDetails(ctx, eventId);
      return;
    }

    if (startParam?.startsWith('trade_')) {
      // User clicked on a trade button - start trade flow
      logger.info(`Deep link to trade from user: ${telegramId} - ${startParam}`);

      const { handleTradeFlow } = await import('./trade');
      await handleTradeFlow(ctx, startParam);
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

        let welcomeMessage =
          '✅ *Welcome back!*\n\n' +
          'Your Polymarket account is ready.\n\n';

        // Show deposit addresses from Bridge API
        if (existingUser.depositAddressEvm) {
          welcomeMessage +=
            '*💰 Deposit Addresses:*\n' +
            `• EVM (Ethereum/Arbitrum/Base): \`${existingUser.depositAddressEvm}\`\n` +
            `• Solana: \`${existingUser.depositAddressSvm}\`\n` +
            `• Bitcoin: \`${existingUser.depositAddressBtc}\`\n` +
            `• Tron: \`${existingUser.depositAddressTvm}\`\n\n` +
            '💸 _Send USDC or other assets → Auto-converts to USDC.e on Polygon_\n\n';
        }

        if (existingUser.polymarketProxyAddress) {
          welcomeMessage +=
            '*🏦 Polymarket Trading Wallet:*\n' +
            `📍 \`${existingUser.polymarketProxyAddress}\`\n` +
            `🔗 [View on Polymarket](https://polymarket.com/profile/${existingUser.polymarketProxyAddress})\n\n`;
        }

        welcomeMessage +=
          '*📍 Owner Wallet (EOA):*\n' +
          `\`${existingUser.walletAddress}\`\n\n` +
          '💡 Use the buttons below or /help to see commands.';

        await ctx.reply(welcomeMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📊 Browse Markets', 'show_categories')],
            [Markup.button.callback('🔍 Search Markets', 'search_markets')],
            [Markup.button.callback('💼 My Wallet', 'show_wallet')],
          ]),
        });
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
        '🎉 *Your Polymarket Account is Ready!*\n\n' +
        '✅ Complete setup successful!\n\n' +
        '*💰 Deposit Addresses (Bridge API):*\n' +
        `• EVM (Ethereum/Arbitrum/Base): \`${result.user.depositAddressEvm}\`\n` +
        `• Solana: \`${result.user.depositAddressSvm}\`\n` +
        `• Bitcoin: \`${result.user.depositAddressBtc}\`\n` +
        `• Tron: \`${result.user.depositAddressTvm}\`\n\n` +
        '💸 _Send USDC or other assets → Auto-converts to USDC.e on Polygon_\n\n' +
        '*🏦 Polymarket Trading Wallet:*\n' +
        `📍 \`${result.walletInfo.polymarketProxyAddress}\`\n` +
        `🔗 [View on Polymarket](https://polymarket.com/profile/${result.walletInfo.polymarketProxyAddress})\n\n` +
        '*📍 Owner Wallet (EOA):*\n' +
        `\`${result.walletInfo.walletAddress}\`\n` +
        `🔑 Private Key: \`${result.walletInfo.privateKey}\`\n\n`;

      successMessage +=
        '*✅ What was created:*\n' +
        '• Deposit addresses for multiple chains (EVM, Solana, Bitcoin, Tron)\n' +
        '• Polymarket Trading Wallet (Safe/Proxy for trading)\n' +
        '• EOA wallet (for transaction signing)\n' +
        '• Polymarket account with API credentials\n' +
        '• Trading automatically enabled (approved USDC & CTF)\n\n' +
        '⚠️ *CRITICAL SECURITY:*\n' +
        '• Save your private key NOW\n' +
        '• Never share it with anyone\n' +
        '• This is the ONLY time we show it\n' +
        '• Lost key = Lost funds\n\n' +
        '🚀 *Start Trading:*\n' +
        '1. Send USDC (or other assets) to any deposit address above\n' +
        '2. Assets auto-convert to USDC.e on Polygon\n' +
        '3. Start trading immediately!\n\n' +
        '💡 Use buttons below to continue.';

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
