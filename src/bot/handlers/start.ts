import fs from 'fs';
import path from 'path';
import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { createUserWithWallet, getUserByTelegramId, UserWithCredentials } from '../../services/user';
import { logger } from '../../utils/logger';
import { maskSensitiveData } from '../../utils/encryption';
import { mainMenuKeyboard, buildMainMenuText } from './markets';
import { ce, EMOJI } from '../../utils/customEmoji';
import { getMainMenuStats } from '../../services/portfolio';
import { config } from '../../config';

const MENU_IMAGE = path.join(__dirname, '../img/opening.jpg');
const BEAT_THE_ODDS_IMAGE = path.join(__dirname, '../img/beattheodds.JPG');

// Prevent duplicate wallet creation when user spams /start
const _creatingWallet = new Set<string>();

// Pending wallet creations for users going through group-gate flow
export type PendingWallet = {
  promise: Promise<UserWithCredentials>;
  referralCode?: string;
};
export const _pendingWalletCreations = new Map<string, PendingWallet>();

async function checkGroupMembership(userId: number): Promise<boolean> {
  const { groupBotToken, requiredGroupId } = config.telegram;
  if (!groupBotToken || !requiredGroupId) return true; // gate disabled

  const url =
    `https://api.telegram.org/bot${groupBotToken}/getChatMember` +
    `?chat_id=${requiredGroupId}&user_id=${userId}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const data = await resp.json() as any;
    const status: string = data?.result?.status ?? 'left';
    return ['creator', 'administrator', 'member', 'restricted'].includes(status);
  } catch {
    return true; // fail-open
  }
}

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

    if (startParam?.startsWith('mkt_')) {
      // Market trade page deep link: shows full market detail + trade buttons
      const marketId = startParam.slice(4);
      logger.info(`Deep link to market trade page ${marketId} from user: ${telegramId}`);
      const { handleMarketTradePage } = await import('./markets');
      await handleMarketTradePage(ctx, marketId);
      return;
    }

    if (startParam?.startsWith('limit_')) {
      // Limit order deep link: limit_{marketId}_{yes|no}
      // marketId is a 0x hex string (no underscores), so we split on the last underscore
      const rest = startParam.slice(6); // strip 'limit_'
      const lastUnderscore = rest.lastIndexOf('_');
      if (lastUnderscore < 1) {
        await ctx.reply('❌ Invalid limit order link.');
        return;
      }
      const marketId = rest.slice(0, lastUnderscore);
      const outcomeStr = rest.slice(lastUnderscore + 1);
      if (outcomeStr === 'choice') {
        logger.info(`Deep link to limit choice for ${marketId} from user: ${telegramId}`);
        const { handleLimitChoiceFlow } = await import('./trade');
        await handleLimitChoiceFlow(ctx, marketId);
        return;
      }
      if (outcomeStr !== 'yes' && outcomeStr !== 'no') {
        await ctx.reply('❌ Invalid limit order link.');
        return;
      }
      logger.info(`Deep link to limit order for ${marketId}/${outcomeStr} from user: ${telegramId}`);
      const { handleLimitOrderStart } = await import('./trade');
      await handleLimitOrderStart(ctx, marketId, outcomeStr as 'yes' | 'no');
      return;
    }

    if (startParam?.startsWith('copymng_')) {
      // Deep link from copy list "Manage" text link
      const address = startParam.slice(8).toLowerCase(); // strip 'copymng_'
      if (/^0x[a-f0-9]{40}$/i.test(address)) {
        const user = await getUserByTelegramId(telegramId);
        if (user) {
          const { handleCopyManage } = await import('./copyTrade');
          await handleCopyManage(ctx, address);
          return;
        }
      }
      // Not registered — fall through to registration
    }

    if (startParam?.startsWith('copyshare_')) {
      // Deep link from copy list "Share" text link
      const address = startParam.slice(10).toLowerCase(); // strip 'copyshare_'
      if (/^0x[a-f0-9]{40}$/i.test(address)) {
        const user = await getUserByTelegramId(telegramId);
        if (user) {
          const { handleCopyShare } = await import('./copyTrade');
          await handleCopyShare(ctx, address);
          return;
        }
      }
      // Not registered — fall through to registration
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

    if (startParam?.startsWith('pb_') || startParam?.startsWith('ps_') || startParam?.startsWith('pv_') || startParam?.startsWith('pp_')) {
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
        if (!user.polymarketProxyAddress) {
          await ctx.reply('⚠️ No trading wallet found. Go to 💼 My Wallet to set up your account first.', {
            ...Markup.inlineKeyboard([[Markup.button.callback('💼 My Wallet', 'wallet_page')]]),
          });
          return;
        }
        const { getActivePositions } = await import('../../services/portfolio');
        positions = await getActivePositions(user.polymarketProxyAddress);
        positionListCache.set(telegramId, positions);
      }

      const pos = positions && !isNaN(idx) && idx >= 0 && idx < positions.length ? positions[idx] : null;
      if (!pos) {
        await ctx.reply('❌ Position not found. Please open your Positions page and try again.', {
          ...Markup.inlineKeyboard([[Markup.button.callback('📊 My Positions', 'portfolio_open_1')]]),
        });
        return;
      }

      if (action === 'pp') {
        // ── Position PNL image via deep link ──
        const { handlePositionPnl } = await import('./positionTrade');
        await handlePositionPnl(ctx, idx);
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
            [Markup.button.callback('📊 P&L', `pos_pnl_${idx}`)],
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

        try {
          await ctx.replyWithPhoto(
            { source: fs.createReadStream(MENU_IMAGE) },
            {
              caption: buildMainMenuText(stats),
              parse_mode: 'HTML',
              ...mainMenuKeyboard(),
            }
          );
        } catch (photoErr: any) {
          // Fallback to text if image fails (too large, not found, etc.)
          logger.warn(`[start] Photo send failed, falling back to text: ${photoErr?.message}`);
          await ctx.reply(buildMainMenuText(stats), {
            parse_mode: 'HTML',
            ...mainMenuKeyboard(),
          });
        }
        return;
      }

      // Prevent duplicate creation if user spams /start
      if (_creatingWallet.has(telegramId)) {
        await ctx.reply('⏳ Your wallet is already being created. Please wait...');
        return;
      }
      _creatingWallet.add(telegramId);

      const referralCode = startParam?.startsWith('ref_')
        ? startParam.replace('ref_', '') || undefined
        : undefined;

      // Check group membership — if not a member, show gate + start wallet in background
      const inGroup = await checkGroupMembership(ctx.from!.id);

      if (!inGroup) {
        const walletPromise = createUserWithWallet(telegramId, username, firstName, lastName);
        _pendingWalletCreations.set(telegramId, { promise: walletPromise, referralCode });

        const joinCaption =
          `${ce(EMOJI.cherry, '🏆')} <b>Welcome to PolyTech!</b>\n\n` +
          `${ce(EMOJI.loading, '⏳')} <b>Your Polymarket wallet is being created...</b>\n\n` +
          `${ce(EMOJI.star, '🔒')} <b>One Last Step</b>\n` +
          `Join our official community to activate your account.\n` +
          `Get trading signals, market updates & live support.\n\n` +
          `${ce(EMOJI.lightning, '⚡')} Your wallet will be ready by the time you join!`;

        const keyboard: any = { inline_keyboard: [] };
        if (config.telegram.requiredGroupLink) {
          keyboard.inline_keyboard.push([{ text: '📢 Join Community', url: config.telegram.requiredGroupLink }]);
        }
        keyboard.inline_keyboard.push([
          { text: "✅ I've Joined, Check", callback_data: 'check_membership' },
        ]);

        try {
          await ctx.replyWithPhoto(
            { source: fs.createReadStream(BEAT_THE_ODDS_IMAGE) },
            { caption: joinCaption, parse_mode: 'HTML', reply_markup: keyboard }
          );
        } catch {
          await ctx.reply(joinCaption, { parse_mode: 'HTML', reply_markup: keyboard });
        }
        return;
      }

      // Already in group — normal flow
      await ctx.reply('🔄 Creating your Polymarket wallet...\n\nPlease wait a moment.');

      const result = await createUserWithWallet(telegramId, username, firstName, lastName);

      logger.info(`User created successfully: ${result.user.id}`);

      // Apply referral code if user arrived via referral link
      if (referralCode) {
        const { applyReferralCode } = await import('../../services/referral');
        const linked = await applyReferralCode(result.user.id, referralCode);
        if (linked) {
          logger.info(`[referral] New user ${result.user.id} linked to referrer via code "${referralCode}"`);
        }
      }

      await sendWalletSuccess(ctx, result);
      logger.info(
        `Wallet created for user ${telegramId}: ${result.walletInfo.walletAddress} ` +
        `(PK: ${maskSensitiveData(result.walletInfo.privateKey)})`
      );

      _creatingWallet.delete(telegramId);

    } catch (error) {
      _creatingWallet.delete(telegramId);
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

/** Send the private key + main menu after successful wallet creation. */
async function sendWalletSuccess(ctx: Context, result: UserWithCredentials): Promise<void> {
  const successMessage =
    `${ce(EMOJI.cherry, '🎉')} <b>Your Account is Ready!</b>\n\n` +
    `${ce(EMOJI.refCode, '🔑')} <b>Private Key — Save it now:</b>\n` +
    `<code>${result.walletInfo.privateKey}</code>\n\n` +
    `${ce(EMOJI.loading, '⚠️')} <b>This key is shown only once.</b>\n` +
    `Never share it with anyone — losing it means losing access to your funds.\n\n` +
    `Use the menu below to deposit and start trading.`;

  await ctx.reply(successMessage, { parse_mode: 'HTML' });

  try {
    await ctx.replyWithPhoto(
      { source: fs.createReadStream(MENU_IMAGE) },
      { caption: buildMainMenuText(), parse_mode: 'HTML', ...mainMenuKeyboard() }
    );
  } catch {
    await ctx.reply(buildMainMenuText(), { parse_mode: 'HTML', ...mainMenuKeyboard() });
  }
}

/** Handles the "✅ I've Joined, Check" button during new user onboarding. */
export async function handleCheckMembership(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const telegramId = String(userId);

  await ctx.answerCbQuery().catch(() => {});

  if (!userId) return;

  const inGroup = await checkGroupMembership(userId);

  if (!inGroup) {
    await ctx.answerCbQuery("❌ You haven't joined yet. Join the group and try again.", { show_alert: true });
    return;
  }

  // Check for pending wallet creation from onboarding
  const pending = _pendingWalletCreations.get(telegramId);
  if (!pending) {
    // No pending wallet — generic acknowledgment
    await ctx.editMessageCaption(
      '✅ <b>Membership Verified!</b>\n\nType /start to begin.',
      { parse_mode: 'HTML' }
    ).catch(() => ctx.reply('✅ Membership verified! Type /start to begin.').catch(() => {}));
    return;
  }

  // Update message to show finalizing state
  await ctx.editMessageCaption(
    `${ce(EMOJI.loading, '⏳')} <b>Almost there!</b>\n\nFinalizing your wallet...`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
  ).catch(() => {});

  try {
    const result = await pending.promise;
    _pendingWalletCreations.delete(telegramId);

    // Apply referral if any
    if (pending.referralCode) {
      const { applyReferralCode } = await import('../../services/referral');
      const linked = await applyReferralCode(result.user.id, pending.referralCode);
      if (linked) {
        logger.info(`[referral] New user ${result.user.id} linked via code "${pending.referralCode}"`);
      }
    }

    logger.info(`User created successfully: ${result.user.id}`);
    logger.info(
      `Wallet created for user ${telegramId}: ${result.walletInfo.walletAddress} ` +
      `(PK: ${maskSensitiveData(result.walletInfo.privateKey)})`
    );

    await sendWalletSuccess(ctx, result);
  } catch (error: any) {
    _pendingWalletCreations.delete(telegramId);
    logger.error(`[checkMembership] Wallet creation failed for ${telegramId}:`, error);
    await ctx.reply('❌ Wallet creation failed. Please try /start again.');
  } finally {
    _creatingWallet.delete(telegramId);
  }
}
