import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { logger } from '../../utils/logger';

// Trade state management
export const tradeState = new Map<string, {
  marketId: string;
  marketQuestion: string;
  outcome: 'yes' | 'no';
  outcomeIndex: number;
  price: number;
  timestamp: number;
}>();

/**
 * Handles trade deep link flow
 * Format: trade_marketId_yes_25 or trade_marketId_no_25 or trade_marketId_custom
 */
export async function handleTradeFlow(ctx: Context, tradeParam: string): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    // Parse trade parameter: trade_marketId_outcome_amount or trade_marketId_custom
    const parts = tradeParam.replace('trade_', '').split('_');

    if (parts.length < 2) {
      await ctx.reply('❌ Invalid trade link.');
      return;
    }

    const marketId = parts[0];
    const outcomeOrCustom = parts[1];

    // Fetch market details from Gamma API (more reliable)
    const axios = (await import('axios')).default;
    let market;

    try {
      // Try as condition_id first (most common case)
      const response = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, {
        timeout: 10000,
      });
      market = response.data;
    } catch (gammaError) {
      // If Gamma fails, try CLOB API as fallback
      try {
        const clobResponse = await axios.get(`https://clob.polymarket.com/markets/${marketId}`, {
          timeout: 10000,
        });
        market = clobResponse.data;
      } catch (clobError) {
        await ctx.reply('❌ Market not found. This market may have been closed or removed.');
        logger.error(`Error fetching market ${marketId} from both APIs:`, { gammaError, clobError });
        return;
      }
    }

    if (outcomeOrCustom === 'custom') {
      // Custom amount flow - ask for Yes/No first
      await handleCustomTradeFlow(ctx, marketId, market);
    } else {
      // Direct trade with specific amount
      const outcome = parts[1] as 'yes' | 'no';
      const amount = parseInt(parts[2] || '25', 10);

      if (outcome !== 'yes' && outcome !== 'no') {
        await ctx.reply('❌ Invalid outcome.');
        return;
      }

      if (amount < 1 || amount > 10000) {
        await ctx.reply('❌ Invalid amount. Must be between $1 and $10,000.');
        return;
      }

      // Check if amount >= $100, require confirmation
      if (amount >= 100) {
        await handleLargeTradeConfirmation(ctx, marketId, market, outcome, amount);
      } else {
        // Direct trade
        await executeTrade(ctx, marketId, market, outcome, amount);
      }
    }
  } catch (error) {
    logger.error('Error in trade flow:', error);
    await ctx.reply('❌ An error occurred while processing your trade.');
  }
}

/**
 * Handles custom amount trade flow
 */
async function handleCustomTradeFlow(ctx: Context, marketId: string, market: any): Promise<void> {
  try {
    // Parse outcomes - can be array or JSON string
    let outcomes = ['Yes', 'No'];
    if (market.outcomes) {
      if (Array.isArray(market.outcomes)) {
        outcomes = market.outcomes;
      } else if (typeof market.outcomes === 'string') {
        try {
          outcomes = JSON.parse(market.outcomes);
        } catch (e) {
          logger.error('Failed to parse outcomes:', e);
        }
      }
    }

    // Parse outcome prices - can be array or JSON string
    let outcomePrices = ['0.5', '0.5'];
    if (market.outcomePrices) {
      if (Array.isArray(market.outcomePrices)) {
        outcomePrices = market.outcomePrices;
      } else if (typeof market.outcomePrices === 'string') {
        try {
          outcomePrices = JSON.parse(market.outcomePrices);
        } catch (e) {
          logger.error('Failed to parse outcomePrices:', e);
        }
      }
    }

    const yesPriceNum = parseFloat(outcomePrices[0] || '0.5');
    const noPriceNum = parseFloat(outcomePrices[1] || '0.5');
    const yesPrice = (isNaN(yesPriceNum) ? 50 : yesPriceNum * 100).toFixed(1);
    const noPrice = (isNaN(noPriceNum) ? 50 : noPriceNum * 100).toFixed(1);

    const message =
      '💰 *Custom Trade*\n\n' +
      `Market: ${market.question}\n\n` +
      'Select outcome:';

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`${outcomes[0]} (${yesPrice}¢)`, `trade_outcome_${marketId}_yes_0`),
          Markup.button.callback(`${outcomes[1]} (${noPrice}¢)`, `trade_outcome_${marketId}_no_1`),
        ],
        [Markup.button.callback('❌ Cancel', 'trade_cancel')],
      ]),
    });
  } catch (error) {
    logger.error('Error in custom trade flow:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Handles outcome selection for custom trade
 */
export async function handleOutcomeSelection(ctx: Context, data: string): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    // Parse: trade_outcome_marketId_outcome_outcomeIndex
    const parts = data.replace('trade_outcome_', '').split('_');
    const marketId = parts[0];
    const outcome = parts[1] as 'yes' | 'no';
    const outcomeIndex = parseInt(parts[2], 10);

    // Fetch market to get current price (try Gamma first, then CLOB)
    const axios = (await import('axios')).default;
    let market;

    try {
      // Try Gamma API first (most common case)
      const gammaResponse = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, {
        timeout: 10000,
      });
      market = gammaResponse.data;
    } catch (gammaError) {
      // If Gamma fails, try CLOB API as fallback
      try {
        const clobResponse = await axios.get(`https://clob.polymarket.com/markets/${marketId}`, {
          timeout: 10000,
        });
        market = clobResponse.data;
      } catch (clobError) {
        logger.error(`Error fetching market ${marketId} from both APIs:`, { gammaError, clobError });
        await ctx.editMessageText('❌ Market not found. This market may have been closed or removed.', {
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back to Markets', 'show_categories')],
          ]),
        });
        return;
      }
    }

    const outcomePrices = market.outcomePrices || ['0.5', '0.5'];
    const price = parseFloat(outcomePrices[outcomeIndex] || '0.5');

    // Save state for amount input
    tradeState.set(telegramId, {
      marketId,
      marketQuestion: market.question || 'Unknown Market',
      outcome,
      outcomeIndex,
      price,
      timestamp: Date.now(),
    });

    const priceDisplay = (price * 100).toFixed(1);

    const message =
      '💵 *Enter Trade Amount*\n\n' +
      `Market: ${market.question}\n` +
      `Outcome: ${outcome.toUpperCase()} (${priceDisplay}¢)\n\n` +
      'Please send the amount you want to trade in USD.\n' +
      'Example: `50` or `150`\n\n' +
      '⚠️ Min: $1 · Max: $10,000';

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'trade_cancel')],
      ]),
    });

    logger.info(`Waiting for trade amount from user ${telegramId} for market ${marketId}`);
  } catch (error) {
    logger.error('Error in outcome selection:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Handles large trade confirmation ($100+)
 */
async function handleLargeTradeConfirmation(
  ctx: Context,
  marketId: string,
  market: any,
  outcome: 'yes' | 'no',
  amount: number
): Promise<void> {
  try {
    const outcomeIndex = outcome === 'yes' ? 0 : 1;
    const outcomePrices = market.outcomePrices || ['0.5', '0.5'];
    const priceRaw = parseFloat(outcomePrices[outcomeIndex] || '0.5');
    const price = isNaN(priceRaw) ? 0.5 : priceRaw;
    const priceDisplay = (price * 100).toFixed(1);
    const estimatedShares = Math.floor(amount / price);

    const message =
      '⚠️ *Confirm Large Trade*\n\n' +
      `Market: ${market.question}\n` +
      `Outcome: ${outcome.toUpperCase()} (${priceDisplay}¢)\n` +
      `Amount: $${amount}\n` +
      `Estimated Shares: ~${estimatedShares}\n\n` +
      'This is a large trade. Please confirm:';

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm Trade', `trade_confirm_${marketId}_${outcome}_${amount}`)],
        [Markup.button.callback('❌ Cancel', 'trade_cancel')],
      ]),
    });
  } catch (error) {
    logger.error('Error in large trade confirmation:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Executes the trade with full CLOB API integration
 */
async function executeTrade(
  ctx: Context,
  marketId: string,
  market: any,
  outcome: 'yes' | 'no',
  amount: number
): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('❌ Authentication error.');
    return;
  }

  let progressMsg;
  const axios = (await import('axios')).default;

  try {
    // Step 1: Show initial progress
    progressMsg = await ctx.reply('⏳ *Step 1/5:* Validating account...');

    // Step 2: Get user and decrypt credentials
    const { getUserByTelegramId } = await import('../../services/user');
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        progressMsg.message_id,
        undefined,
        '❌ User not found. Please use /start to create your wallet.'
      );
      return;
    }

    if (!user.polymarketProxyAddress) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        progressMsg.message_id,
        undefined,
        '❌ *Trading Wallet Not Ready*\n\n' +
        'Your Polymarket trading wallet is not set up yet.\n\n' +
        'Please make your first deposit to activate trading:\n' +
        '1. Go to 💼 My Wallet\n' +
        '2. Make a deposit\n' +
        '3. Wait for confirmation\n' +
        '4. Try trading again',
        {
          parse_mode: 'Markdown',
        }
      );
      return;
    }

    // Decrypt credentials
    const { decrypt } = await import('../../utils/encryption');
    const privateKey = decrypt(user.encryptedPrivateKey);
    const apiKey = decrypt(user.encryptedApiKey);
    const apiSecret = decrypt(user.encryptedApiSecret);
    const passphrase = decrypt(user.encryptedPassphrase);

    // Step 3: Check balance
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      '⏳ *Step 2/5:* Checking balance...'
    );

    const { ethers } = await import('ethers');
    const provider = new ethers.providers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');

    // USDC contract on Polygon
    const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const usdcAbi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
    const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, provider);

    const balance = await usdcContract.balanceOf(user.polymarketProxyAddress);
    const decimals = await usdcContract.decimals();
    const balanceUSD = parseFloat(ethers.utils.formatUnits(balance, decimals));

    if (balanceUSD < amount) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        progressMsg.message_id,
        undefined,
        `❌ *Insufficient Balance*\n\n` +
        `Your balance: $${balanceUSD.toFixed(2)}\n` +
        `Required: $${amount.toFixed(2)}\n\n` +
        `Please deposit more funds to continue.`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('💼 Go to Wallet', 'wallet_page')],
            [Markup.button.callback('💰 Deposit Now', 'deposit_menu')],
            [Markup.button.callback('« Back to Markets', 'show_categories')],
          ]).reply_markup,
        }
      );
      return;
    }

    // Step 4: Check and enable trading if needed (for existing users)
    if (!user.tradingEnabled) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        progressMsg.message_id,
        undefined,
        '⏳ *Step 3/5:* Enabling trading (one-time)...'
      );

      const { enableTrading } = await import('../../services/deposit');
      const enableResult = await enableTrading(user.encryptedPrivateKey);

      if (enableResult.success) {
        // Update database
        const { prisma } = await import('../../database/prisma');
        await prisma.user.update({
          where: { id: user.id },
          data: { tradingEnabled: true },
        });
        logger.info(`Trading enabled for existing user: ${user.id}`);

        // Wait for blockchain confirmation before proceeding
        // This ensures Polymarket API recognizes the approval
        logger.info('Waiting 8 seconds for blockchain confirmation...');
        await new Promise(resolve => setTimeout(resolve, 8000));
        logger.info('Blockchain confirmation wait complete, proceeding with order...');
      } else {
        logger.warn(`Could not enable trading for user ${user.id} - will retry next time`);
      }
    }

    // Step 5: Create CLOB client
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      '⏳ *Step 4/5:* Connecting to exchange...'
    );

    const { ClobClient } = await import('@polymarket/clob-client');
    const { Wallet } = await import('@ethersproject/wallet');
    const { config } = await import('../../config');

    const wallet = new Wallet(privateKey);
    const clobClient = new ClobClient(
      config.polymarket.host,
      config.polymarket.chainId,
      wallet,
      {
        key: apiKey,
        secret: apiSecret,
        passphrase: passphrase,
      },
      2, // Signature type 2 for GNOSIS_SAFE (Polymarket proxy wallet)
      user.polymarketProxyAddress // Funder address (proxy wallet, not EOA)
    );

    // Step 6: Fetch latest market data and validate
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      '⏳ *Step 5/6:* Preparing order...'
    );

    // Get token ID for the outcome
    // Try different field names based on API source
    let tokenId;

    logger.info(`Market data for ${marketId}:`, {
      hasTokens: !!market.tokens,
      hasClobTokenIds: !!market.clobTokenIds,
      hasConditionId: !!market.conditionId,
      hasCondition_id: !!market.condition_id,
      conditionIdValue: market.conditionId || market.condition_id
    });

    if (market.tokens && Array.isArray(market.tokens)) {
      tokenId = market.tokens[outcome === 'yes' ? 0 : 1]?.token_id;
    } else if (market.clobTokenIds && Array.isArray(market.clobTokenIds)) {
      tokenId = market.clobTokenIds[outcome === 'yes' ? 0 : 1];
    }

    // If token ID not found yet, try fetching from CLOB API
    if (!tokenId) {
      try {
        // Try with conditionId first (CLOB API uses conditionId, not marketId)
        const conditionId = market.conditionId || market.condition_id;
        const idToTry = conditionId || marketId;

        logger.info(`Fetching token ID from CLOB - marketId: ${marketId}, conditionId: ${conditionId}, using: ${idToTry}`);

        const clobResponse = await axios.get(`https://clob.polymarket.com/markets/${idToTry}`, {
          timeout: 10000,
        });
        const clobMarket = clobResponse.data;
        tokenId = clobMarket.tokens?.[outcome === 'yes' ? 0 : 1]?.token_id;

        // If still not found and we haven't tried marketId yet, try that as fallback
        if (!tokenId && conditionId && conditionId !== marketId) {
          const clobResponse2 = await axios.get(`https://clob.polymarket.com/markets/${marketId}`, {
            timeout: 10000,
          });
          const clobMarket2 = clobResponse2.data;
          tokenId = clobMarket2.tokens?.[outcome === 'yes' ? 0 : 1]?.token_id;
        }
      } catch (err) {
        logger.error('Error fetching CLOB market for token ID:', err);
      }
    }

    if (!tokenId) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        progressMsg.message_id,
        undefined,
        '❌ *Market Not Available for Trading*\n\n' +
        'This market cannot be traded at the moment.\n\n' +
        'Possible reasons:\n' +
        '• Market is not yet active\n' +
        '• Market has been closed\n' +
        '• Trading is temporarily disabled\n\n' +
        'Please try a different market.',
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('« Back to Markets', 'show_categories')],
          ]).reply_markup,
        }
      );
      return;
    }

    // Check if market is active
    if (!market.active || market.closed) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        progressMsg.message_id,
        undefined,
        '❌ *Market Closed*\n\n' +
        'This market is no longer accepting trades.',
        {
          parse_mode: 'Markdown',
        }
      );
      return;
    }

    // Get current order book to determine best price
    const orderBook = await clobClient.getOrderBook(tokenId);

    // For buying, we look at asks (sell orders)
    const asks = orderBook.asks || [];

    if (asks.length === 0) {
      throw new Error('No liquidity available for this outcome');
    }

    // Calculate price from market (in cents)
    const outcomeIndex = outcome === 'yes' ? 0 : 1;
    const marketPriceRaw = parseFloat(market.outcomePrices?.[outcomeIndex] || '0.5');
    const marketPrice = isNaN(marketPriceRaw) ? 0.5 : marketPriceRaw;

    // Add 2% slippage tolerance
    const priceWithSlippage = marketPrice * 1.02;
    const price = Math.min(priceWithSlippage, 0.99); // Cap at 99 cents

    // Calculate size (shares to buy)
    const size = amount / price;

    // Step 7: Create and place order
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      '⏳ *Step 6/6:* Executing trade...'
    );

    // Create market buy order
    const orderArgs = {
      tokenID: tokenId,
      price: price,
      size: size,
      side: 0, // 0 = BUY, 1 = SELL
      feeRateBps: 0,
    } as any;

    const signedOrder = await clobClient.createOrder(orderArgs);
    const orderResponse = await clobClient.postOrder(signedOrder);

    if (!orderResponse.success || !orderResponse.orderID) {
      const errorMsg = orderResponse.errorMsg || 'Order placement failed';

      // Handle specific error cases
      if (errorMsg.includes('balance') || errorMsg.includes('allowance')) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          progressMsg.message_id,
          undefined,
          '❌ *Insufficient Balance*\n\n' +
          'You need to deposit USDC to your Polymarket account first.\n\n' +
          '*How to deposit:*\n' +
          '1. Go to Wallet → Deposit\n' +
          '2. Send USDC to your address\n' +
          '3. Click "I sent funds" to approve\n' +
          '4. Wait for confirmation\n\n' +
          'Then you can trade! 🚀',
          {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('💰 Deposit Now', 'deposit_menu')],
              [Markup.button.callback('💼 Go to Wallet', 'wallet_page')],
              [Markup.button.callback('« Back to Markets', 'show_categories')],
            ]).reply_markup,
          }
        );
        return;
      }

      throw new Error(errorMsg);
    }

    // Wait a moment and check order status
    await new Promise(resolve => setTimeout(resolve, 2000));

    const orderStatus = await clobClient.getOrder(orderResponse.orderID);

    const executedSize = parseFloat((orderStatus as any).size_matched || '0');
    const avgPrice = parseFloat((orderStatus as any).price || price.toString());
    const actualCost = executedSize * avgPrice;
    const executedShares = Math.floor(executedSize);

    // Success message with real order details
    const priceDisplay = (avgPrice * 100).toFixed(2);
    const currentValue = executedShares * marketPrice;
    const pnl = currentValue - actualCost;
    const pnlPercent = ((pnl / actualCost) * 100).toFixed(2);

    const statusEmoji = orderStatus.status === 'MATCHED' ? '🎉' : '⏳';
    const statusText = orderStatus.status === 'MATCHED' ? 'Trade Successful!' : 'Trade Pending...';

    const message =
      `${statusEmoji} *${statusText}*\n\n` +
      `Market: ${market.question}\n` +
      `Outcome: ${outcome.toUpperCase()}\n\n` +
      `💰 *Trade Details:*\n` +
      `• Amount: $${actualCost.toFixed(2)}\n` +
      `• Shares: ${executedShares}\n` +
      `• Avg Price: ${priceDisplay}¢\n` +
      `• Order ID: \`${orderResponse.orderID}\`\n\n` +
      `📊 *Position:*\n` +
      `• Entry: ${priceDisplay}¢\n` +
      `• Current: ${(marketPrice * 100).toFixed(2)}¢\n` +
      `• Value: $${currentValue.toFixed(2)}\n` +
      `• P&L: $${pnl.toFixed(2)} (${pnlPercent}%)\n\n` +
      `🔗 [View on Polymarket](https://polymarket.com/event/${market.slug})`;

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      message,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('📊 View Portfolio', 'wallet_page')],
          [Markup.button.callback('🔄 Trade Again', `trade_${marketId}_custom`)],
          [Markup.button.callback('« Back to Markets', 'show_categories')],
        ]).reply_markup,
      }
    );

    logger.info(`Trade executed successfully: User ${telegramId} - Market ${marketId} - ${outcome.toUpperCase()} - $${actualCost.toFixed(2)} - Order ${orderResponse.orderID}`);

  } catch (error: any) {
    logger.error('Error executing trade:', error);

    let errorMessage = '❌ *Trade Failed*\n\n';

    if (error.message?.includes('insufficient')) {
      errorMessage += 'Insufficient balance or liquidity.\n\n';
    } else if (error.message?.includes('closed') || error.message?.includes('inactive')) {
      errorMessage += 'This market is no longer active.\n\n';
    } else if (error.message?.includes('liquidity')) {
      errorMessage += 'Not enough liquidity available.\n\n';
    } else if (error.message?.includes('timeout')) {
      errorMessage += 'Request timed out. Please try again.\n\n';
    } else {
      errorMessage += 'An unexpected error occurred.\n\n';
    }

    errorMessage += `Error: ${error.message || 'Unknown error'}`;

    try {
      if (progressMsg && ctx.chat) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          progressMsg.message_id,
          undefined,
          errorMessage,
          {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Try Again', `trade_${marketId}_custom`)],
              [Markup.button.callback('« Back', 'show_categories')],
            ]).reply_markup,
          }
        );
      } else {
        await ctx.reply(errorMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Try Again', `trade_${marketId}_custom`)],
            [Markup.button.callback('« Back', 'show_categories')],
          ]),
        });
      }
    } catch (replyError) {
      logger.error('Error sending error message:', replyError);
    }
  }
}

/**
 * Handles trade amount input (conversation state)
 */
export async function handleTradeAmountInput(ctx: Context, amountText: string): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const state = tradeState.get(telegramId);
    if (!state) {
      await ctx.reply('❌ Trade session expired. Please start again.');
      return;
    }

    // Check if state expired (10 minutes)
    if (Date.now() - state.timestamp > 10 * 60 * 1000) {
      tradeState.delete(telegramId);
      await ctx.reply('❌ Trade session expired. Please start again.');
      return;
    }

    // Parse amount
    const amount = parseFloat(amountText.replace(/[^0-9.]/g, ''));

    if (isNaN(amount) || amount < 1 || amount > 10000) {
      await ctx.reply('❌ Invalid amount. Please enter a value between $1 and $10,000.');
      return;
    }

    // Clear state
    tradeState.delete(telegramId);

    // Fetch market for latest data (try Gamma first, then CLOB)
    const axios = (await import('axios')).default;
    let market;

    try {
      // Try Gamma API first (most common case)
      const gammaResponse = await axios.get(`https://gamma-api.polymarket.com/markets/${state.marketId}`, {
        timeout: 10000,
      });
      market = gammaResponse.data;
    } catch (gammaError) {
      // If Gamma fails, try CLOB API as fallback
      try {
        const clobResponse = await axios.get(`https://clob.polymarket.com/markets/${state.marketId}`, {
          timeout: 10000,
        });
        market = clobResponse.data;
      } catch (clobError) {
        logger.error(`Error fetching market ${state.marketId} from both APIs:`, { gammaError, clobError });
        await ctx.reply('❌ Market not found. This market may have been closed or removed.');
        return;
      }
    }

    // Check if amount >= $100, require confirmation
    if (amount >= 100) {
      await handleLargeTradeConfirmation(ctx, state.marketId, market, state.outcome, amount);
    } else {
      // Direct trade
      await executeTrade(ctx, state.marketId, market, state.outcome, amount);
    }
  } catch (error) {
    logger.error('Error handling trade amount input:', error);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
}

/**
 * Handles trade confirmation
 */
export async function handleTradeConfirm(ctx: Context, data: string): Promise<void> {
  try {
    await ctx.answerCbQuery();

    // Parse: trade_confirm_marketId_outcome_amount
    const parts = data.replace('trade_confirm_', '').split('_');
    const marketId = parts[0];
    const outcome = parts[1] as 'yes' | 'no';
    const amount = parseInt(parts[2], 10);

    // Fetch market (try Gamma first, then CLOB)
    const axios = (await import('axios')).default;
    let market;

    try {
      // Try Gamma API first (most common case)
      const gammaResponse = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, {
        timeout: 10000,
      });
      market = gammaResponse.data;
    } catch (gammaError) {
      // If Gamma fails, try CLOB API as fallback
      try {
        const clobResponse = await axios.get(`https://clob.polymarket.com/markets/${marketId}`, {
          timeout: 10000,
        });
        market = clobResponse.data;
      } catch (clobError) {
        logger.error(`Error fetching market ${marketId} from both APIs:`, { gammaError, clobError });
        await ctx.reply('❌ Market not found. This market may have been closed or removed.');
        return;
      }
    }

    await executeTrade(ctx, marketId, market, outcome, amount);
  } catch (error) {
    logger.error('Error confirming trade:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Handles trade cancellation
 */
export async function handleTradeCancel(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Trade cancelled');

    const telegramId = ctx.from?.id.toString();
    if (telegramId) {
      tradeState.delete(telegramId);
    }

    await ctx.editMessageText('❌ Trade cancelled.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Back to Markets', 'show_categories')],
      ]),
    });
  } catch (error) {
    logger.error('Error cancelling trade:', error);
  }
}
