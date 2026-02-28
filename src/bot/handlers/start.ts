import fs from 'fs';
import path from 'path';
import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { createUserWithWallet, getUserByTelegramId } from '../../services/user';
import { logger } from '../../utils/logger';
import { maskSensitiveData } from '../../utils/encryption';
import { mainMenuKeyboard, buildMainMenuText } from './markets';
import { getMainMenuStats } from '../../services/portfolio';

const MENU_IMAGE = path.join(__dirname, '../img/beattheodds.JPG');

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

    if (startParam?.startsWith('updown_market_')) {
      // User tapped an Up/Down market deep link — show detail page
      const marketId = startParam.replace('updown_market_', '');
      logger.info(`Deep link to updown market ${marketId} from user: ${telegramId}`);

      const { handleUpDownMarketDetail } = await import('./cryptoMarkets');
      await handleUpDownMarketDetail(ctx, marketId, false);
      return;
    }

    if (startParam?.startsWith('copy_')) {
      // Smart Wallet deep link — pre-fill address and start copy add flow
      const address = startParam.slice(5); // strip 'copy_'
      logger.info(`Deep link copy trade for ${address} from user: ${telegramId}`);

      const user = await getUserByTelegramId(telegramId);
      if (user) {
        const { handleSmartCopyStart } = await import('./copyTrade');
        await handleSmartCopyStart(ctx, address);
        return;
      }
      // User not registered yet — fall through to normal registration
    }

    if (startParam?.startsWith('ref_')) {
      // Referral deep link — record referrer; continue to normal registration flow below
      const referralCode = startParam.replace('ref_', '');
      // We store the code temporarily; it's applied after the user is created (see below)
      logger.info(`[referral] User ${telegramId} arrived via referral code: "${referralCode}"`);
      // Fall through — don't return here, let registration proceed
      // The referral application happens after user creation
    }

    if (startParam?.startsWith('pb_') || startParam?.startsWith('ps_') || startParam?.startsWith('pv_')) {
      // Deep link from active positions page: buy/sell/view a position by index
      const parts = startParam.split('_');
      const action = parts[0]; // 'pb', 'ps', or 'pv'
      const idx = parseInt(parts[1], 10);

      logger.info(`Deep link position action ${action} idx ${idx} from user: ${telegramId}`);

      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.reply('❌ User not found. Use /start to create your wallet.');
        return;
      }

      // Ensure position cache is populated
      const { positionListCache, positionTradeState } = await import('./positionTrade');
      let positions = positionListCache.get(telegramId);
      if (!positions || positions.length === 0) {
        const { getActivePositions } = await import('../../services/portfolio');
        positions = await getActivePositions(user.polymarketProxyAddress || '');
        positionListCache.set(telegramId, positions);
      }

      const pos = positions && !isNaN(idx) && idx >= 0 && idx < positions.length ? positions[idx] : null;
      if (!pos) {
        await ctx.reply('❌ Position not found. Please open your Positions page and try again.', {
          ...Markup.inlineKeyboard([[Markup.button.callback('📊 My Positions', 'portfolio_open_1')]]),
        });
        return;
      }

      if (action === 'pv') {
        // ── View position detail ──
        const pnlSign = pos.cashPnl >= 0 ? '+' : '';
        const pnlEmoji = pos.cashPnl >= 0 ? '🟢' : '🔴';
        const endDate = pos.endDate
          ? new Date(pos.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : 'N/A';

        let msg = `📊 *Position Detail*\n\n`;
        msg += `*${pos.outcome}* — ${pos.title}\n\n`;
        msg += `💰 *Position*\n`;
        msg += `├ Shares: ${pos.size.toFixed(4)}\n`;
        msg += `├ Avg Buy Price: ${(pos.avgPrice * 100).toFixed(2)}¢\n`;
        msg += `├ Current Price: ${(pos.curPrice * 100).toFixed(2)}¢\n`;
        msg += `├ Invested: $${pos.initialValue.toFixed(2)}\n`;
        msg += `└ Current Value: $${pos.currentValue.toFixed(2)}\n\n`;
        msg += `📈 *P&L*\n`;
        msg += `├ ${pnlEmoji} Unrealized: ${pnlSign}$${pos.cashPnl.toFixed(2)}\n`;
        msg += `├ ROI: ${pnlSign}${pos.percentPnl.toFixed(1)}%\n`;
        msg += `└ Realized: $${pos.realizedPnl.toFixed(2)}\n\n`;
        msg += `⏰ Market ends: ${endDate}`;
        if (pos.redeemable) msg += `\n✅ _Redeemable_`;

        await ctx.reply(msg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('📈 Buy More', `pos_buy_${idx}`),
              Markup.button.callback('📉 Sell', `pos_sell_${idx}`),
            ],
            [Markup.button.callback('« Back to Positions', 'portfolio_open_1')],
          ]),
        });
      } else {
        // ── Buy or Sell flow ──
        const truncTitle = pos.title.length > 50 ? pos.title.substring(0, 50) + '...' : pos.title;
        const curCents = (pos.curPrice * 100).toFixed(1);

        positionTradeState.set(telegramId, {
          action: action === 'pb' ? 'buy' : 'sell',
          assetId: pos.asset,
          conditionId: pos.conditionId,
          negRisk: pos.negativeRisk,
          title: pos.title,
          outcome: pos.outcome,
          currentSize: pos.size,
          curPrice: pos.curPrice,
          step: 'awaiting_price_size',
          timestamp: Date.now(),
        });

        if (action === 'ps') {
          const msg =
            `📉 *Sell Position*\n\n` +
            `*${pos.outcome}* — ${truncTitle}\n\n` +
            `You hold: *${pos.size.toFixed(4)} shares* @ avg ${(pos.avgPrice * 100).toFixed(1)}¢\n` +
            `Current price: *${curCents}¢*  ·  Value: *$${pos.currentValue.toFixed(2)}*\n\n` +
            `*Enter number of shares to sell:*\n` +
            `Example: \`${pos.size.toFixed(2)}\` (sell all)\n\n` +
            `Or choose a quick amount:`;

          await ctx.reply(msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('25%', `pos_pct_${idx}_25`),
                Markup.button.callback('50%', `pos_pct_${idx}_50`),
                Markup.button.callback('75%', `pos_pct_${idx}_75`),
                Markup.button.callback('100%', `pos_pct_${idx}_100`),
              ],
              [Markup.button.callback('❌ Cancel', 'pos_cancel')],
            ]),
          });
        } else {
          const estimatedShares = (10 / pos.curPrice).toFixed(1);
          const msg =
            `📈 *Buy More*\n\n` +
            `*${pos.outcome}* — ${truncTitle}\n\n` +
            `You already hold: *${pos.size.toFixed(4)} shares*\n` +
            `Current price: *${curCents}¢*\n\n` +
            `*Enter USDC amount to spend:*\n` +
            `Example: \`10\` → buys ~${estimatedShares} shares at ${curCents}¢`;

          await ctx.reply(msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'pos_cancel')]]),
          });
        }
      }
      return;
    }

    logger.info(`Start command received from user: ${telegramId}`);

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

        const stats = await getMainMenuStats(
          existingUser.encryptedPrivateKey,
          existingUser.encryptedApiKey,
          existingUser.encryptedApiSecret,
          existingUser.encryptedPassphrase,
          existingUser.polymarketProxyAddress
        ).catch(() => undefined);

        await ctx.replyWithPhoto(
          { source: fs.createReadStream(MENU_IMAGE) },
          {
            caption: buildMainMenuText(stats),
            parse_mode: 'HTML',
            ...mainMenuKeyboard(),
          }
        );
        return;
      }

      // New user — show loading message only now
      await ctx.reply('🔄 Creating your Polymarket wallet...\n\nPlease wait a moment.');

      // Create new user with wallet
      const result = await createUserWithWallet(
        telegramId,
        username,
        firstName,
        lastName
      );

      logger.info(`User created successfully: ${result.user.id}`);

      // Apply referral code if user arrived via referral link
      if (startParam?.startsWith('ref_')) {
        const referralCode = startParam.replace('ref_', '');
        // R14: Guard against empty code (e.g. user clicked a bare "ref_" link)
        if (referralCode) {
          const { applyReferralCode } = await import('../../services/referral');
          const linked = await applyReferralCode(result.user.id, referralCode);
          if (linked) {
            logger.info(`[referral] New user ${result.user.id} linked to referrer via code "${referralCode}"`);
          }
        }
      }

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

      await ctx.reply(successMessage, { parse_mode: 'Markdown' });

      await ctx.replyWithPhoto(
        { source: fs.createReadStream(MENU_IMAGE) },
        {
          caption: buildMainMenuText(),
          parse_mode: 'HTML',
          ...mainMenuKeyboard(),
        }
      );

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
