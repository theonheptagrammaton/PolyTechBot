import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { logger } from '../../utils/logger';
import { COMMISSION_RATE } from '../../services/commission';

// Trade state management
export const tradeState = new Map<string, {
  marketId: string;
  marketQuestion: string;
  outcome: 'yes' | 'no';
  outcomeIndex: number;
  price: number;
  timestamp: number;
}>();

// Limit order state management
export const limitTradeState = new Map<string, {
  step: 'awaiting_limit_price' | 'awaiting_limit_amount' | 'awaiting_confirmation';
  marketId: string;
  marketQuestion: string;
  outcome: 'yes' | 'no';
  outcomeIndex: number;
  currentPrice: number;
  limitPrice?: number;
  amount?: number;
  timestamp: number;
}>();

// R6: Periodic cleanup of abandoned state entries (every 30 min, remove entries > 10 min old)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, state] of tradeState.entries()) {
    if (state.timestamp < cutoff) tradeState.delete(key);
  }
  for (const [key, state] of limitTradeState.entries()) {
    if (state.timestamp < cutoff) limitTradeState.delete(key);
  }
}, 30 * 60 * 1000);

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

      if (outcome !== 'yes' && outcome !== 'no') {
        await ctx.reply('❌ Invalid outcome.');
        return;
      }

      // 'custom' token: outcome known, ask user for amount
      if (parts[2] === 'custom') {
        const outcomeIdx = outcome === 'yes' ? 0 : 1;
        let pricesArr: string[] = ['0.5', '0.5'];
        try {
          pricesArr = Array.isArray(market.outcomePrices)
            ? market.outcomePrices
            : JSON.parse(market.outcomePrices || '["0.5","0.5"]');
        } catch { /* keep defaults */ }
        const price = parseFloat(pricesArr[outcomeIdx] ?? '0.5');

        tradeState.set(telegramId, {
          marketId,
          marketQuestion: market.question || 'Unknown Market',
          outcome,
          outcomeIndex: outcomeIdx,
          price,
          timestamp: Date.now(),
        });

        const priceDisplay = (price * 100).toFixed(1);
        await ctx.reply(
          `💵 *Enter Trade Amount*\n\n` +
          `Market: ${market.question}\n` +
          `Outcome: ${outcome.toUpperCase()} (${priceDisplay}¢)\n\n` +
          `Please send the amount in USD.\n` +
          `Example: \`50\`\n\n` +
          `⚠️ Min: $1 · Max: $10,000`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'trade_cancel')]]),
          }
        );
        return;
      }

      // 'default' token: fetch user's current defaultTradeAmount from DB
      let amount: number;
      if (!parts[2] || parts[2] === 'default') {
        const { getUserByTelegramId } = await import('../../services/user');
        const user = await getUserByTelegramId(telegramId);
        amount = user?.defaultTradeAmount ?? 25;
      } else {
        amount = parseInt(parts[2], 10);
      }

      if (isNaN(amount) || amount < 1 || amount > 10000) {
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
    const commissionAmt = amount * COMMISSION_RATE;
    const tradeAmount = amount - commissionAmt;
    const estimatedShares = Math.floor(tradeAmount / price);

    const message =
      '⚠️ *Confirm Large Trade*\n\n' +
      `Market: ${market.question}\n` +
      `Outcome: ${outcome.toUpperCase()} (${priceDisplay}¢)\n` +
      `Amount: $${amount.toFixed(2)}\n` +
      `Platform fee (1%): -$${commissionAmt.toFixed(2)}\n` +
      `Trade amount: $${tradeAmount.toFixed(2)}\n` +
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

    // Try multiple RPCs in order — use the first responsive one
    const RPC_LIST = [
      'https://polygon-rpc.com',
      'https://rpc-mainnet.matic.network',
      'https://polygon-bor-rpc.publicnode.com',
    ];
    let provider: any;
    for (const rpcUrl of RPC_LIST) {
      try {
        const p = new ethers.providers.JsonRpcProvider(rpcUrl);
        await Promise.race([
          p.getBlockNumber(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('rpc timeout')), 4000)),
        ]);
        provider = p;
        break;
      } catch { /* try next */ }
    }
    if (!provider) provider = new ethers.providers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');

    // USDC.e contract on Polygon
    const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
    const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, provider);

    const balance = await usdcContract.balanceOf(user.polymarketProxyAddress);
    const balanceUSD = parseFloat(ethers.utils.formatUnits(balance, 6)); // USDC.e has 6 decimals

    if (balanceUSD < amount) {
      if (balanceUSD < 1) {
        // Not enough even for the minimum trade — only deposit option makes sense
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          progressMsg.message_id,
          undefined,
          `❌ *Insufficient Balance*\n\n` +
          `Your balance: *$${balanceUSD.toFixed(2)}*\n` +
          `A minimum of $1 is required to trade.\n\n` +
          `Please deposit funds to continue.`,
          {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('💰 Deposit', 'deposit_menu')],
              [Markup.button.callback('💼 My Wallet', 'wallet_page')],
              [Markup.button.callback('« Back to Markets', 'show_categories')],
            ]).reply_markup,
          }
        );
      } else {
        // Has some balance — save state and let user enter a custom amount
        const outcomeIndex = outcome === 'yes' ? 0 : 1;
        let outcomePricesArr: string[] = ['0.5', '0.5'];
        try {
          outcomePricesArr = Array.isArray(market.outcomePrices)
            ? market.outcomePrices
            : JSON.parse(market.outcomePrices || '["0.5","0.5"]');
        } catch { /* keep defaults */ }
        const price = parseFloat(outcomePricesArr[outcomeIndex] ?? '0.5');

        tradeState.set(telegramId, {
          marketId,
          marketQuestion: market.question || 'Unknown Market',
          outcome,
          outcomeIndex,
          price,
          timestamp: Date.now(),
        });

        const maxAmount = Math.floor(balanceUSD);
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          progressMsg.message_id,
          undefined,
          `⚠️ *Insufficient Balance*\n\n` +
          `Your balance: *$${balanceUSD.toFixed(2)}*\n` +
          `Default amount: $${amount.toFixed(2)}\n\n` +
          `Enter a smaller amount within your balance to continue:\n` +
          `Example: \`${Math.max(1, maxAmount)}\`\n\n` +
          `⚠️ Min: $1 · Max: $${maxAmount}`,
          {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('❌ Cancel', 'trade_cancel')],
            ]).reply_markup,
          }
        );
      }
      return;
    }

    // Step 4: Ensure trading approvals are set (on-chain check, no-op if already approved)
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      '⏳ *Step 3/5:* Checking trading approvals...'
    );

    const { enableTrading } = await import('../../services/deposit');
    const enableResult = await enableTrading(user.encryptedPrivateKey, user.polymarketProxyAddress);

    if (enableResult.success && !enableResult.alreadyEnabled) {
      // Update DB flag so next check is skipped
      const { prisma } = await import('../../database/prisma');
      await prisma.user.update({ where: { id: user.id }, data: { tradingEnabled: true } }).catch(() => {});
      logger.info(`Trading approvals confirmed for user: ${user.id}`);
    }
    if (!enableResult.success) {
      logger.warn(`[trade] Could not verify trading approvals for user ${user.id} — proceeding anyway`);
    }

    // Calculate commission and trade amount (commission collected after successful trade)
    const { config } = await import('../../config');
    const { transferCommission, COMMISSION_RATE } = await import('../../services/commission');
    const commissionAmt = parseFloat((amount * COMMISSION_RATE).toFixed(6));
    const tradeAmount = parseFloat((amount - commissionAmt).toFixed(6));

    // CLOB requires minimum $1.00 for marketable BUY orders — check after commission deduction
    if (tradeAmount < 1.0) {
      const minRequired = Math.ceil((1.0 / (1 - COMMISSION_RATE)) * 100) / 100; // e.g. $1.02
      const oi = outcome === 'yes' ? 0 : 1;
      let pricesArr: string[] = ['0.5', '0.5'];
      try {
        pricesArr = Array.isArray(market.outcomePrices)
          ? market.outcomePrices
          : JSON.parse(market.outcomePrices || '["0.5","0.5"]');
      } catch { /* keep defaults */ }
      tradeState.set(telegramId, {
        marketId,
        marketQuestion: market.question || 'Unknown Market',
        outcome,
        outcomeIndex: oi,
        price: parseFloat(pricesArr[oi] ?? '0.5'),
        timestamp: Date.now(),
      });
      await ctx.telegram.editMessageText(
        ctx.chat!.id, progressMsg.message_id, undefined,
        `⚠️ *Minimum Trade Amount*\n\n` +
        `After the ${(COMMISSION_RATE * 100).toFixed(0)}% fee, CLOB requires a minimum of $1.00.\n\n` +
        `Entered: $${amount.toFixed(2)} → Trade amount: $${tradeAmount.toFixed(2)}\n\n` +
        `Please enter at least *$${minRequired.toFixed(2)}*:`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'trade_cancel')]]).reply_markup,
        }
      );
      return;
    }

    // Step 4: Create CLOB client
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      '⏳ *Step 4/5:* Connecting to exchange...'
    );

    const { ClobClient, Side } = await import('@polymarket/clob-client');
    const { Wallet } = await import('@ethersproject/wallet');

    const wallet = new Wallet(privateKey);
    const clobClient = new ClobClient(
      config.polymarket.host,
      config.polymarket.chainId,
      wallet,
      { key: apiKey, secret: apiSecret, passphrase },
      2, // signatureType=2 GNOSIS_SAFE — proxy wallet
      user.polymarketProxyAddress
    );

    // Step 5: Resolve token ID, tick size, and negRisk from market data
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      '⏳ *Step 5/5:* Preparing order...'
    );

    const outcomeIdx = outcome === 'yes' ? 0 : 1;
    let tokenId: string | undefined;
    let tickSize = '0.01';      // safe default; will be fetched from CLOB
    let isNegRisk = !!(market.negRisk || market.neg_risk);

    // Extract token ID from Gamma API response (clobTokenIds field)
    if (market.tokens && Array.isArray(market.tokens)) {
      tokenId = market.tokens[outcomeIdx]?.token_id;
    } else if (market.clobTokenIds && Array.isArray(market.clobTokenIds)) {
      tokenId = market.clobTokenIds[outcomeIdx];
    }

    // Always fetch from CLOB to get tick size + negRisk; also resolves missing tokenId
    try {
      const conditionId = market.conditionId || market.condition_id;
      const idToTry = conditionId || marketId;
      logger.info(`[trade] Fetching CLOB market: ${idToTry}`);

      const clobResp = await axios.get(`https://clob.polymarket.com/markets/${idToTry}`, { timeout: 10000 });
      const cm = clobResp.data;

      if (!tokenId) tokenId = cm.tokens?.[outcomeIdx]?.token_id;
      if (cm.minimum_tick_size) tickSize = String(cm.minimum_tick_size);
      if (cm.neg_risk !== undefined) isNegRisk = !!cm.neg_risk;

      // Last-resort: try with raw marketId
      if (!tokenId && conditionId && conditionId !== marketId) {
        const fb = await axios.get(`https://clob.polymarket.com/markets/${marketId}`, { timeout: 10000 });
        if (!tokenId) tokenId = fb.data.tokens?.[outcomeIdx]?.token_id;
        if (fb.data.minimum_tick_size) tickSize = String(fb.data.minimum_tick_size);
      }
    } catch (err) {
      logger.error('[trade] Error fetching CLOB market data:', err);
    }

    if (!tokenId) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id, progressMsg.message_id, undefined,
        '❌ *Market Not Available for Trading*\n\nThis market cannot be traded at the moment.',
        { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('« Back to Markets', 'show_categories')], [Markup.button.callback('🏠 Main Menu', 'back_to_menu')]]).reply_markup }
      );
      return;
    }

    if (!market.active || market.closed) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id, progressMsg.message_id, undefined,
        '❌ *Market Closed*\n\nThis market is no longer accepting trades.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Read user's slippage tolerance (default 1%)
    const slippagePct  = user.slippageTolerance ?? 1.0;
    const slippageMult = 1 + slippagePct / 100;

    // Calculate market price and snap worst-case price to tick size
    const marketPriceRaw = parseFloat(
      (Array.isArray(market.outcomePrices) ? market.outcomePrices[outcomeIdx] : null) || '0.5'
    );
    const marketPrice = isNaN(marketPriceRaw) ? 0.5 : marketPriceRaw;

    // Worst-case price = market price + user slippage%, snapped to tick size, capped at 0.99
    const tick = parseFloat(tickSize);
    const decimals = tickSize.includes('.') ? tickSize.split('.')[1].length : 2;
    const worstPrice = parseFloat(
      Math.min(Math.round((marketPrice * slippageMult) / tick) * tick, 0.99).toFixed(decimals)
    );

    // Estimated shares (for display only — FAK fills whatever is available at the price)
    const estimatedSize = parseFloat((tradeAmount / worstPrice).toFixed(4));

    // Build order options
    const orderOptions: any = {};
    if (tickSize)   orderOptions.tickSize = tickSize as any;
    if (isNegRisk)  orderOptions.negRisk  = isNegRisk;

    // FAK market order — executes immediately against best available asks up to worstPrice
    // amount = USD to spend (tradeAmount after commission deduction)
    const { OrderType } = await import('@polymarket/clob-client');

    logger.info(`[trade] Placing FAK BUY: ~${estimatedSize} shares of ${outcome.toUpperCase()} tokenId=${tokenId.substring(0,16)}... maxPrice=${worstPrice} slippage=${slippagePct}% tickSize=${tickSize} negRisk=${isNegRisk}`);

    const orderResponse = await clobClient.createAndPostMarketOrder(
      { tokenID: tokenId, side: Side.BUY, amount: tradeAmount, price: worstPrice } as any,
      Object.keys(orderOptions).length > 0 ? orderOptions : undefined,
      OrderType.FAK
    );

    if (!orderResponse.success || !orderResponse.orderID) {
      const errMsg = orderResponse.errorMsg || (orderResponse as any).error || 'Order placement failed';
      logger.error(`[trade] CLOB rejected order for user ${telegramId}: ${errMsg}`);

      // User-friendly messages for known CLOB errors
      if (errMsg.includes('balance') || errMsg.includes('allowance')) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id, progressMsg.message_id, undefined,
          '❌ *Insufficient Balance*\n\nYou need USDC.e in your Polymarket proxy wallet.\n\nGo to 💼 My Wallet → Deposit to add funds.',
          { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('💰 Deposit Now', 'deposit_menu')], [Markup.button.callback('« Back', 'show_categories')], [Markup.button.callback('🏠 Main Menu', 'back_to_menu')]]).reply_markup }
        );
        return;
      }
      if (errMsg.includes('no orders found') || errMsg.includes('liquidity') || errMsg.includes('FOK') || errMsg.includes('FAK')) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id, progressMsg.message_id, undefined,
          `❌ *No Liquidity*\n\nNo sellers available within the current slippage range (${slippagePct}%).\n\n• Increase slippage in ⚙️ Settings\n• Or try again shortly`,
          { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('⚙️ Settings', 'settings_menu')], [Markup.button.callback('🔄 Try Again', `trade_${marketId}_custom`)], [Markup.button.callback('« Back', 'show_categories')], [Markup.button.callback('🏠 Main Menu', 'back_to_menu')]]).reply_markup }
        );
        return;
      }
      if (errMsg.includes('lower than the minimum') || (errMsg.includes('Size') && errMsg.includes('minimum'))) {
        const minMatch = errMsg.match(/minimum[:\s]+(\d+(?:\.\d+)?)/i);
        const minShares = minMatch ? parseFloat(minMatch[1]) : 5;
        const minUsd = (minShares * worstPrice).toFixed(2);
        logger.warn(`[trade] CLOB minimum size not met for user ${telegramId}: ${errMsg}`);
        await ctx.telegram.editMessageText(
          ctx.chat!.id, progressMsg.message_id, undefined,
          `❌ *Trade Amount Too Small*\n\n` +
          `This market requires a minimum of *${minShares} shares* per order.\n\n` +
          `At the current price (${(worstPrice * 100).toFixed(1)}¢), you need at least *$${minUsd}*.\n\n` +
          `Please increase your trade amount and try again.`,
          { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔄 Try Again', `trade_${marketId}_custom`)], [Markup.button.callback('« Back', 'show_categories')], [Markup.button.callback('🏠 Main Menu', 'back_to_menu')]]).reply_markup }
        );
        return;
      }
      if (errMsg.includes('tick size') || errMsg.includes('minimum_tick')) {
        throw new Error(`Price precision error: ${errMsg}`);
      }

      throw new Error(errMsg);
    }

    // Collect platform commission (1%) after successful trade — fire-and-forget
    if (config.commission?.adminWalletAddress) {
      transferCommission(user.encryptedPrivateKey, user.polymarketProxyAddress!, commissionAmt, user.id)
        .catch((err) => logger.warn(`[trade] Commission transfer failed for user ${telegramId}:`, err?.message || err));
    }

    // Fetch current balance after order (non-blocking on error)
    let newBalance = '';
    try {
      const balanceData = await clobClient.getBalanceAllowance({ asset_type: 'COLLATERAL' as any });
      if (balanceData?.balance) {
        newBalance = (parseFloat(balanceData.balance) / 1_000_000).toFixed(2);
      }
    } catch { /* balance fetch is best-effort */ }

    // Invalidate portfolio caches so next view is fresh
    const { invalidatePortfolioCache } = await import('../../services/portfolio');
    await invalidatePortfolioCache(user.encryptedPrivateKey);

    const balanceLine = newBalance ? `\n💳 *Balance:* $${newBalance}` : '';
    const feeLine = config.commission?.adminWalletAddress
      ? `\n• Platform fee (1%): -$${commissionAmt.toFixed(2)}\n• Trade amount: $${tradeAmount.toFixed(2)}`
      : '';
    const message =
      `✅ *Market Order Submitted*\n\n` +
      `Market: ${market.question}\n` +
      `Outcome: *${outcome.toUpperCase()}*\n\n` +
      `💰 *Order Details:*\n` +
      `• Total: ~$${amount.toFixed(2)}` +
      feeLine + `\n` +
      `• ~Est. Shares: ${estimatedSize}\n` +
      `• Max price: ${(worstPrice * 100).toFixed(2)}¢ (slippage: ${slippagePct}%)\n` +
      `• Order ID: \`${orderResponse.orderID}\`\n` +
      balanceLine + `\n\n` +
      `_FAK market order — fills immediately at best available ask. Unfilled remainder is cancelled._`;

    await ctx.telegram.editMessageText(
      ctx.chat!.id, progressMsg.message_id, undefined, message,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('📊 My Positions', 'portfolio_open_1')],
          [Markup.button.callback('📋 Open Orders',  'portfolio_orders_1')],
          [Markup.button.callback('🔄 Trade Again',  `trade_${marketId}_custom`)],
          [Markup.button.callback('🏠 Main Menu',    'back_to_menu')],
        ]).reply_markup,
      }
    );

    logger.info(`[trade] Order placed: user=${telegramId} market=${marketId} outcome=${outcome.toUpperCase()} amount=$${amount} orderID=${orderResponse.orderID}`);

  } catch (error: any) {
    logger.error('Error executing trade:', error);

    const rawErr = error.message ?? 'Unknown error';
    const safeMd = (s: string) => s.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const errorMessage = `❌ *Trade Failed*\n\n${safeMd(rawErr)}`;

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
              [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
            ]).reply_markup,
          }
        );
      } else {
        await ctx.reply(errorMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Tekrar Dene', `trade_${marketId}_custom`)],
            [Markup.button.callback('« Geri', 'show_categories')],
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

    // R8: Locale-aware amount parsing (handles European "25,50" and US "25.50" formats)
    const normalized = (() => {
      const s = amountText.trim().replace(/[^\d.,]/g, '');
      const lastComma = s.lastIndexOf(',');
      const lastDot = s.lastIndexOf('.');
      if (lastComma > lastDot) {
        // Comma is last separator → European decimal (e.g. "1.234,56")
        return s.replace(/\./g, '').replace(',', '.');
      }
      // Dot is last separator or no comma → remove commas (thousand separators)
      return s.replace(/,/g, '');
    })();
    const amount = parseFloat(normalized);

    if (isNaN(amount) || amount < 1 || amount > 10000) {
      await ctx.reply('❌ Invalid amount. Please enter a value between $1 and $10,000.');
      return;
    }

    // Fetch market for latest data BEFORE clearing state (if fetch fails, state is preserved for retry)
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

    // Clear state only after market fetch succeeds
    tradeState.delete(telegramId);

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
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    });
  } catch (error) {
    logger.error('Error cancelling trade:', error);
  }
}

// ─── Limit Order Flow ──────────────────────────────────────────────────────────

/**
 * Shows YES/NO outcome choice for a limit order.
 * Called from deep link: limit_{marketId}_choice
 */
export async function handleLimitChoiceFlow(ctx: Context, marketId: string): Promise<void> {
  const botUsername = ctx.botInfo?.username || process.env.BOT_USERNAME || 'PolymarketBot';
  const axios = (await import('axios')).default;
  let market: any;
  try {
    const r = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, { timeout: 10000 });
    market = r.data;
  } catch {
    try {
      const r = await axios.get(`https://clob.polymarket.com/markets/${marketId}`, { timeout: 10000 });
      market = r.data;
    } catch {
      await ctx.reply('❌ Market not found. It may have been closed or removed.');
      return;
    }
  }

  let outcomePrices: string[] = ['0.5', '0.5'];
  try {
    outcomePrices = Array.isArray(market.outcomePrices)
      ? market.outcomePrices
      : JSON.parse(market.outcomePrices || '["0.5","0.5"]');
  } catch { /* keep defaults */ }

  const yesPrice = (parseFloat(outcomePrices[0] || '0.5') * 100).toFixed(1);
  const noPrice  = (parseFloat(outcomePrices[1] || '0.5') * 100).toFixed(1);
  const q = (market.question || 'Unknown Market').slice(0, 80);

  await ctx.reply(
    `📋 *Limit Order — Select Outcome*\n\n` +
    `Market: ${q}\n\n` +
    `Current YES: *${yesPrice}¢*  •  NO: *${noPrice}¢*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.url(`BUY YES (${yesPrice}¢)`, `https://t.me/${botUsername}?start=limit_${marketId}_yes`),
          Markup.button.url(`BUY NO (${noPrice}¢)`,   `https://t.me/${botUsername}?start=limit_${marketId}_no`),
        ],
        [Markup.button.callback('❌ Cancel', 'limit_cancel')],
      ]),
    }
  );
}

/**
 * Starts a limit order flow for a specific market and outcome.
 * Called from the /start deep link handler: limit_{marketId}_{yes|no}
 */
export async function handleLimitOrderStart(
  ctx: Context,
  marketId: string,
  outcome: 'yes' | 'no',
): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const axios = (await import('axios')).default;
  let market: any;
  try {
    const r = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, { timeout: 10000 });
    market = r.data;
  } catch {
    try {
      const r = await axios.get(`https://clob.polymarket.com/markets/${marketId}`, { timeout: 10000 });
      market = r.data;
    } catch {
      await ctx.reply('❌ Market not found. It may have been closed or removed.');
      return;
    }
  }

  if (!market.active || market.closed) {
    await ctx.reply('❌ This market is closed and no longer accepting orders.');
    return;
  }

  const outcomeIndex = outcome === 'yes' ? 0 : 1;
  let outcomePrices: string[] = ['0.5', '0.5'];
  try {
    outcomePrices = Array.isArray(market.outcomePrices)
      ? market.outcomePrices
      : JSON.parse(market.outcomePrices || '["0.5","0.5"]');
  } catch { /* keep defaults */ }

  const currentPrice = parseFloat(outcomePrices[outcomeIndex] || '0.5');
  const currentCents = (currentPrice * 100).toFixed(1);
  const exampleCents = Math.max(1, Math.round(currentPrice * 100) - 5);

  limitTradeState.set(telegramId, {
    step: 'awaiting_limit_price',
    marketId,
    marketQuestion: market.question || 'Unknown Market',
    outcome,
    outcomeIndex,
    currentPrice,
    timestamp: Date.now(),
  });

  await ctx.reply(
    `📋 *Limit Order — BUY ${outcome.toUpperCase()}*\n\n` +
    `Market: ${market.question}\n\n` +
    `📊 Current price: *${currentCents}¢*\n\n` +
    `Enter your limit price in cents (1–99):\n` +
    `Example: \`${exampleCents}\` (order fills when price ≤ ${exampleCents}¢)`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'limit_cancel')],
      ]),
    }
  );
}

/**
 * Handles text input during limit order flow (price → amount → shows confirmation).
 * Returns true if the input was consumed.
 */
export async function handleLimitTradeInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;

  const state = limitTradeState.get(telegramId);
  if (!state) return false;

  if (Date.now() - state.timestamp > 10 * 60 * 1000) {
    limitTradeState.delete(telegramId);
    return false;
  }

  // In awaiting_confirmation step the user should click a button, not type
  if (state.step === 'awaiting_confirmation') {
    await ctx.reply('👆 Please tap ✅ Place Limit Order or ❌ Cancel above.');
    return true;
  }

  if (state.step === 'awaiting_limit_price') {
    const raw = text.trim().replace(/[^\d.]/g, '');
    const cents = parseFloat(raw);

    if (isNaN(cents) || cents < 1 || cents > 99) {
      await ctx.reply('❌ Enter a price between 1 and 99 cents. Example: `45`', { parse_mode: 'Markdown' });
      return true;
    }

    const limitPrice = parseFloat((cents / 100).toFixed(4));
    const currentCents = (state.currentPrice * 100).toFixed(1);

    // Warn if limit is above current price (order would fill immediately)
    const aboveMarketNote = cents > state.currentPrice * 100
      ? `\n⚠️ _Your limit (${cents}¢) is above current price (${currentCents}¢) — order may fill immediately._\n`
      : '';

    state.limitPrice = limitPrice;
    state.step = 'awaiting_limit_amount';
    state.timestamp = Date.now();
    limitTradeState.set(telegramId, state);

    await ctx.reply(
      `📋 *Limit Order — BUY ${state.outcome.toUpperCase()} @ ${cents}¢*\n\n` +
      `Market: ${state.marketQuestion}\n\n` +
      `📊 Current price: *${currentCents}¢*\n` +
      `🎯 Your limit: *${cents}¢*\n` +
      aboveMarketNote + `\n` +
      `Enter USD amount to spend:\n` +
      `⚠️ Min: $1 · Max: $10,000`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Cancel', 'limit_cancel')],
        ]),
      }
    );
    return true;
  }

  if (state.step === 'awaiting_limit_amount') {
    // Locale-aware parse (same as market order handler)
    const normalized = (() => {
      const s = text.trim().replace(/[^\d.,]/g, '');
      const lastComma = s.lastIndexOf(',');
      const lastDot = s.lastIndexOf('.');
      if (lastComma > lastDot) return s.replace(/\./g, '').replace(',', '.');
      return s.replace(/,/g, '');
    })();
    const amount = parseFloat(normalized);

    if (isNaN(amount) || amount < 1 || amount > 10000) {
      await ctx.reply('❌ Invalid amount. Enter a value between $1 and $10,000.');
      return true;
    }

    const commissionAmt = parseFloat((amount * COMMISSION_RATE).toFixed(2));
    const tradeAmount   = parseFloat((amount - commissionAmt).toFixed(2));
    const limitPrice    = state.limitPrice!;
    const limitCents    = (limitPrice * 100).toFixed(1);
    const estShares     = parseFloat((tradeAmount / limitPrice).toFixed(2));
    const currentCents  = (state.currentPrice * 100).toFixed(1);

    if (tradeAmount < 1.0) {
      const minRequired = Math.ceil((1.0 / (1 - COMMISSION_RATE)) * 100) / 100;
      await ctx.reply(
        `❌ After the ${(COMMISSION_RATE * 100).toFixed(0)}% fee the trade amount is less than $1.\n` +
        `Please enter at least *$${minRequired.toFixed(2)}*:`,
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    state.amount = amount;
    state.step = 'awaiting_confirmation';
    state.timestamp = Date.now();
    limitTradeState.set(telegramId, state);

    await ctx.reply(
      `📋 *Confirm Limit Order*\n\n` +
      `Market: ${state.marketQuestion}\n` +
      `Side: BUY *${state.outcome.toUpperCase()}*\n\n` +
      `📊 Current price: ${currentCents}¢\n` +
      `🎯 Limit price: *${limitCents}¢*\n` +
      `💰 Amount: $${amount.toFixed(2)}\n` +
      `├ Platform fee (1%): -$${commissionAmt.toFixed(2)}\n` +
      `└ Trade amount: $${tradeAmount.toFixed(2)}\n` +
      `📦 Est. shares: ~${estShares}\n\n` +
      `_Order type: GTC — stays on the book until filled or cancelled._`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Place Limit Order', 'limit_confirm'),
            Markup.button.callback('❌ Cancel', 'limit_cancel'),
          ],
        ]),
      }
    );
    return true;
  }

  return false;
}

/**
 * Executes the confirmed limit (GTC) order via CLOB API.
 */
export async function handleLimitConfirm(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const state = limitTradeState.get(telegramId);
  if (!state || state.step !== 'awaiting_confirmation' || !state.limitPrice || !state.amount) {
    await ctx.editMessageText('❌ Session expired. Please start again.').catch(() => {});
    return;
  }

  if (Date.now() - state.timestamp > 10 * 60 * 1000) {
    limitTradeState.delete(telegramId);
    await ctx.editMessageText('❌ Session expired. Please start again.').catch(() => {});
    return;
  }

  limitTradeState.delete(telegramId);

  // Show progress immediately
  await ctx.editMessageText('⏳ Placing limit order...').catch(() => {});

  await executeLimitTrade(ctx, state.marketId, state.marketQuestion, state.outcome, state.limitPrice, state.amount);
}

/**
 * Cancels the limit order flow.
 */
export async function handleLimitCancel(ctx: Context): Promise<void> {
  await ctx.answerCbQuery('Cancelled');

  const telegramId = ctx.from?.id.toString();
  if (telegramId) limitTradeState.delete(telegramId);

  await ctx.editMessageText('❌ Limit order cancelled.', {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Markets', 'show_categories')],
    ]),
  }).catch(() => {});
}

/**
 * Submits a GTC limit order to the Polymarket CLOB.
 */
async function executeLimitTrade(
  ctx: Context,
  marketId: string,
  marketQuestion: string,
  outcome: 'yes' | 'no',
  limitPrice: number,
  amount: number,
): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const axios = (await import('axios')).default;

  try {
    const { getUserByTelegramId } = await import('../../services/user');
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.editMessageText('❌ User not found. Use /start to create your wallet.').catch(() => {});
      return;
    }

    if (!user.polymarketProxyAddress) {
      await ctx.editMessageText(
        '❌ *Trading wallet not set up.*\n\nDeposit funds first to activate trading.',
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('💰 Deposit', 'deposit_menu')],
          ]).reply_markup,
        }
      ).catch(() => {});
      return;
    }

    const { decrypt } = await import('../../utils/encryption');
    const privateKey  = decrypt(user.encryptedPrivateKey);
    const apiKey      = decrypt(user.encryptedApiKey);
    const apiSecret   = decrypt(user.encryptedApiSecret);
    const passphrase  = decrypt(user.encryptedPassphrase);

    // Fetch CLOB market data for tokenId, tickSize, negRisk
    const outcomeIdx = outcome === 'yes' ? 0 : 1;
    let tokenId: string | undefined;
    let tickSize = '0.01';
    let isNegRisk = false;

    try {
      const clobResp = await axios.get(`https://clob.polymarket.com/markets/${marketId}`, { timeout: 10000 });
      const cm = clobResp.data;
      tokenId = cm.tokens?.[outcomeIdx]?.token_id;
      if (cm.minimum_tick_size) tickSize = String(cm.minimum_tick_size);
      if (cm.neg_risk !== undefined) isNegRisk = !!cm.neg_risk;
    } catch (err) {
      logger.warn('[limit] Could not fetch CLOB market data:', err);
    }

    if (!tokenId) {
      await ctx.editMessageText('❌ Market not available for trading at the moment.').catch(() => {});
      return;
    }

    const { config } = await import('../../config');
    const { transferCommission } = await import('../../services/commission');
    const commissionAmt = parseFloat((amount * COMMISSION_RATE).toFixed(6));
    const tradeAmount   = parseFloat((amount - commissionAmt).toFixed(6));

    // Snap limit price to tick size
    const tick     = parseFloat(tickSize);
    const decimals = tickSize.includes('.') ? tickSize.split('.')[1].length : 2;
    const snappedPrice = parseFloat(
      Math.min(Math.round(limitPrice / tick) * tick, 0.99).toFixed(decimals)
    );

    // Shares = tradeAmount / snappedPrice
    const sharesToBuy = parseFloat((tradeAmount / snappedPrice).toFixed(4));

    if (sharesToBuy < 0.01) {
      await ctx.editMessageText('❌ Trade amount too small after fee deduction.').catch(() => {});
      return;
    }

    const { ClobClient, Side } = await import('@polymarket/clob-client');
    const { Wallet } = await import('@ethersproject/wallet');

    const wallet = new Wallet(privateKey);
    const clobClient = new ClobClient(
      config.polymarket.host,
      config.polymarket.chainId,
      wallet,
      { key: apiKey, secret: apiSecret, passphrase },
      2, // GNOSIS_SAFE signature type
      user.polymarketProxyAddress
    );

    const orderOptions: any = {};
    if (tickSize) orderOptions.tickSize = tickSize as any;
    if (isNegRisk) orderOptions.negRisk = isNegRisk;

    logger.info(
      `[limit] Placing GTC BUY: ${sharesToBuy} shares of ${outcome.toUpperCase()} ` +
      `tokenId=${tokenId.substring(0, 16)}... price=${snappedPrice} tickSize=${tickSize} negRisk=${isNegRisk}`
    );

    const orderResp = await clobClient.createAndPostOrder(
      { tokenID: tokenId, side: Side.BUY, price: snappedPrice, size: sharesToBuy, feeRateBps: 0 },
      Object.keys(orderOptions).length > 0 ? orderOptions : undefined
    );

    if (!orderResp.success || !orderResp.orderID) {
      const errMsg = orderResp.errorMsg || (orderResp as any).error || 'Order rejected by exchange';
      throw new Error(errMsg);
    }

    // Commission transfer (fire-and-forget) — same pattern as market orders
    if (config.commission?.adminWalletAddress) {
      transferCommission(user.encryptedPrivateKey, user.polymarketProxyAddress!, commissionAmt, user.id)
        .catch((err) => logger.warn(`[limit] Commission transfer failed for user ${telegramId}: ${err?.message}`));
    }

    const limitCents = (snappedPrice * 100).toFixed(1);
    const message =
      `✅ *Limit Order Placed*\n\n` +
      `Market: ${marketQuestion}\n` +
      `Side: BUY *${outcome.toUpperCase()}*\n\n` +
      `🎯 Limit price: *${limitCents}¢*\n` +
      `💰 Amount: $${amount.toFixed(2)}\n` +
      `├ Platform fee: -$${commissionAmt.toFixed(2)}\n` +
      `└ Trade amount: $${tradeAmount.toFixed(2)}\n` +
      `📦 Shares: ~${sharesToBuy}\n` +
      `🆔 Order ID: \`${orderResp.orderID}\`\n\n` +
      `_GTC order — rests on the book until filled or cancelled._`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('📋 Open Orders',   'portfolio_orders_1')],
        [Markup.button.callback('📊 My Positions',  'portfolio_open_1')],
        [Markup.button.callback('🏠 Main Menu',     'back_to_menu')],
      ]).reply_markup,
    }).catch(() => {});

    logger.info(
      `[limit] Order placed: user=${telegramId} market=${marketId} ` +
      `outcome=${outcome.toUpperCase()} price=${snappedPrice} shares=${sharesToBuy} orderID=${orderResp.orderID}`
    );

  } catch (error: any) {
    logger.error('[limit] Error executing limit trade:', error);
    const safeMd = (s: string) => s.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const rawErr = error?.message ?? 'Unknown error';
    await ctx.editMessageText(
      `❌ *Limit Order Failed*\n\n${safeMd(rawErr)}`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Markets', 'show_categories')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]).reply_markup,
      }
    ).catch(() => {});
  }
}
