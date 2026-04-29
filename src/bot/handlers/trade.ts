import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import axios from 'axios';
import { logger } from '../../utils/logger';
import { COMMISSION_RATE, transferCommission } from '../../services/commission';
import { config } from '../../config';
import { ce, EMOJI } from '../../utils/customEmoji';
import { RedisBackedState } from '../../utils/redisState';
import { generatePositionPnlImage } from '../../services/pnlImage';
import { getActivePositions, getBalance, invalidatePortfolioCache, fetchTxHashForOrder } from '../../services/portfolio';
import { fetchProfilePhoto } from '../../utils/telegram';
import { getUserByTelegramId, ensurePredexonUser } from '../../services/user';
import { enableTrading } from '../../services/deposit';
import { prisma } from '../../database/prisma';
import { placeOrder, getOrder as predexonGetOrder } from '../../services/predexon';
import { t, Locale } from '../../i18n';

function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

/**
 * Returns a "Trade Again" URL button that re-opens the custom trade flow via deep link.
 * URL buttons are used because the full conditionId (66 chars) makes callback data
 * exceed Telegram's 64-byte limit.  Falls back to a "Back" callback if BOT_USERNAME
 * is not configured.
 */
function tradeAgainBtn(label: string, marketId: string) {
  const uname = config.telegram.botUsername;
  if (uname) {
    return Markup.button.url(label, `https://t.me/${uname}?start=trade_${marketId}_custom`);
  }
  return Markup.button.callback('« Back to Markets', 'show_categories');
}

function backToMarketBtn(marketId: string) {
  const uname = config.telegram.botUsername;
  if (uname) {
    return Markup.button.url('« Back to Market', `https://t.me/${uname}?start=mkt_${marketId}`);
  }
  return Markup.button.callback('« Back to Markets', 'show_categories');
}

// Trade state management — Redis-backed to survive bot restarts
export const tradeState = new RedisBackedState<{
  marketId: string;
  marketQuestion: string;
  outcome: 'yes' | 'no';
  outcomeIndex: number;
  price: number;
  amount?: number;  // set during large-trade confirmation flow
  market?: any;     // cached market object — avoids re-fetch in handleTradeConfirm
  timestamp: number;
}>('trade', 600);

// CLOB market data cache: conditionId/marketId → { tokens, tickSize, negRisk }
// Tick size and token IDs never change — safe to cache for 10 minutes.
const clobMarketCache = new Map<string, { data: any; expiresAt: number }>();
const CLOB_CACHE_TTL_MS = 10 * 60 * 1000;

// Limit order state management — Redis-backed to survive bot restarts
export const limitTradeState = new RedisBackedState<{
  step: 'awaiting_limit_price' | 'awaiting_limit_amount' | 'awaiting_confirmation';
  marketId: string;
  marketQuestion: string;
  outcome: 'yes' | 'no';
  outcomeIndex: number;
  currentPrice: number;
  limitPrice?: number;
  amount?: number;
  conditionId?: string;
  tokenId?: string;
  tickSize?: string;
  negRisk?: boolean;
  timestamp: number;
}>('limitTrade', 600);

// F1: Pending outcome selection — holds market data before user picks YES/NO.
// Needed because the full marketId (66 chars) makes trade_outcome_${marketId}_yes_0
// exceed Telegram's 64-byte callback data limit. We store the market here and use
// short callbacks trade_oc_yes / trade_oc_no instead.
const pendingCustomTrade = new RedisBackedState<{
  marketId: string;
  market: any;
  timestamp: number;
}>('pendingTrade', 600);

// R6: Periodic cleanup of abandoned state entries (every 30 min, remove entries > 10 min old)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, state] of tradeState.entries()) {
    if (state.timestamp < cutoff) tradeState.delete(key);
  }
  for (const [key, state] of limitTradeState.entries()) {
    if (state.timestamp < cutoff) limitTradeState.delete(key);
  }
  for (const [key, state] of pendingCustomTrade.entries()) {
    if (state.timestamp < cutoff) pendingCustomTrade.delete(key);
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

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    // Parse trade parameter: trade_marketId_outcome_amount or trade_marketId_custom
    const parts = tradeParam.replace('trade_', '').split('_');

    if (parts.length < 2) {
      await ctx.reply(t(lang, 'trade.invalidLink', {}));
      return;
    }

    const marketId = parts[0];
    const outcomeOrCustom = parts[1];

    // Fetch market details from Gamma API (more reliable)

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
        await ctx.reply(t(lang, 'trade.marketNotFound'));
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
        await ctx.reply(t(lang, 'trade.invalidOutcome'));
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

        // Clear any conflicting limit-order state so the text handler routes correctly
        limitTradeState.delete(telegramId);

        tradeState.set(telegramId, {
          marketId,
          marketQuestion: market.question || 'Unknown Market',
          outcome,
          outcomeIndex: outcomeIdx,
          price,
          market,
          timestamp: Date.now(),
        });

        // Fetch balance for display
        const balanceStr = user
          ? await getBalance(user.encryptedPrivateKey, user.encryptedApiKey, user.encryptedApiSecret, user.encryptedPassphrase, user.predexonUserId ?? undefined).catch(() => '0.00')
          : '0.00';

        const priceDisplay = (price * 100).toFixed(1);
        await ctx.reply(
          t(lang, 'trade.enterAmount') +
          t(lang, 'trade.market', { question: market.question }) +
          t(lang, 'trade.outcome', { outcome: outcome.toUpperCase(), price: priceDisplay }) +
          t(lang, 'trade.balance', { balance: balanceStr }) +
          t(lang, 'trade.sendAmount'),
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.cancel'), 'trade_cancel')]]),
          }
        );
        return;
      }

      // 'default' token: fetch user's current defaultTradeAmount from DB
      let amount: number;
      if (!parts[2] || parts[2] === 'default') {
        amount = user?.defaultTradeAmount ?? 25;
      } else {
        amount = parseInt(parts[2], 10);
      }

      if (isNaN(amount) || amount < 1 || amount > 10000) {
        await ctx.reply(t(lang, 'trade.invalidAmount'));
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
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(t(lang, 'trade.errorProcessing'));
  }
}

/**
 * Handles custom amount trade flow
 */
async function handleCustomTradeFlow(ctx: Context, marketId: string, market: any): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    const user = telegramId ? await getUserByTelegramId(telegramId) : null;
    const lang = getLang(user);

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
      t(lang, 'trade.customTrade') +
      t(lang, 'trade.market', { question: market.question }) + '\n' +
      t(lang, 'trade.selectOutcome');

    // F1: Store market in pendingCustomTrade so handleOutcomeSelection can read it
    // without embedding the 66-char conditionId in the callback data.
    if (telegramId) {
      pendingCustomTrade.set(telegramId, { marketId, market, timestamp: Date.now() });
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`${outcomes[0]} (${yesPrice}¢)`, 'trade_oc_yes'),
          Markup.button.callback(`${outcomes[1]} (${noPrice}¢)`, 'trade_oc_no'),
        ],
        [Markup.button.callback(t(lang, 'btn.cancel'), 'trade_cancel')],
      ]),
    });
  } catch (error) {
    logger.error('Error in custom trade flow:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(t(lang, 'common.errorGeneric'));
  }
}

/**
 * Handles outcome selection for custom trade.
 * F1: marketId is read from pendingCustomTrade (not from callback data) because
 * the full conditionId (66 chars) would push the callback over Telegram's 64-byte limit.
 * Callbacks are now the short strings 'trade_oc_yes' / 'trade_oc_no'.
 */
export async function handleOutcomeSelection(ctx: Context, data: string): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    // Read pending market from state (set by handleCustomTradeFlow)
    const pending = await pendingCustomTrade.get(telegramId);
    if (!pending) {
      await ctx.reply(t(lang, 'trade.sessionExpired'), {
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')]]),
      });
      return;
    }
    pendingCustomTrade.delete(telegramId);

    const { marketId, market } = pending;
    // data is 'trade_oc_yes' or 'trade_oc_no'
    const outcome: 'yes' | 'no' = data === 'trade_oc_yes' ? 'yes' : 'no';
    const outcomeIndex = outcome === 'yes' ? 0 : 1;

    const outcomePrices = market.outcomePrices || ['0.5', '0.5'];
    const price = parseFloat(outcomePrices[outcomeIndex] || '0.5');

    // Clear any conflicting limit-order state so the text handler routes correctly
    limitTradeState.delete(telegramId);

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

    // Fetch balance for display
    const balanceStr = user
      ? await getBalance(user.encryptedPrivateKey, user.encryptedApiKey, user.encryptedApiSecret, user.encryptedPassphrase, user.predexonUserId ?? undefined).catch(() => '0.00')
      : '0.00';

    const message =
      t(lang, 'trade.enterAmount') +
      t(lang, 'trade.market', { question: market.question }) +
      t(lang, 'trade.outcome', { outcome: outcome.toUpperCase(), price: priceDisplay }) +
      t(lang, 'trade.balance', { balance: balanceStr }) +
      t(lang, 'trade.sendAmountFull');

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn.cancel'), 'trade_cancel')],
      ]),
    });

    logger.info(`Waiting for trade amount from user ${telegramId} for market ${marketId}`);
  } catch (error) {
    logger.error('Error in outcome selection:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(t(lang, 'common.errorGeneric'));
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
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    const outcomeIndex = outcome === 'yes' ? 0 : 1;
    const outcomePrices = market.outcomePrices || ['0.5', '0.5'];
    const priceRaw = parseFloat(outcomePrices[outcomeIndex] || '0.5');
    const price = isNaN(priceRaw) ? 0.5 : priceRaw;
    const priceDisplay = (price * 100).toFixed(1);
    const commissionAmt = amount * COMMISSION_RATE;
    const tradeAmount = amount - commissionAmt;
    const estimatedShares = Math.floor(tradeAmount / price);

    // Store pending confirmation in state — avoids encoding 66-char conditionId in callback data
    tradeState.set(telegramId, {
      marketId,
      marketQuestion: market.question || 'Unknown Market',
      outcome,
      outcomeIndex,
      price,
      amount,
      market,
      timestamp: Date.now(),
    });

    const message =
      t(lang, 'trade.confirmLarge') + '\n\n' +
      t(lang, 'trade.market', { question: market.question }) +
      t(lang, 'trade.outcome', { outcome: outcome.toUpperCase(), price: priceDisplay }) +
      t(lang, 'trade.confirmAmount', { amount: amount.toFixed(2) }) +
      t(lang, 'trade.confirmFee', { fee: commissionAmt.toFixed(2) }) +
      t(lang, 'trade.confirmTradeAmount', { tradeAmount: tradeAmount.toFixed(2) }) +
      t(lang, 'trade.confirmShares', { shares: String(estimatedShares) }) + '\n\n' +
      t(lang, 'trade.confirmPrompt');

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'trade.confirmBtn'), 'trade_confirm_do')],
        [Markup.button.callback(t(lang, 'btn.cancel'), 'trade_cancel')],
      ]),
    });
  } catch (error) {
    logger.error('Error in large trade confirmation:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(t(lang, 'common.errorGeneric'));
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
    await ctx.reply(t('en', 'trade.authError'));
    return;
  }

  let progressMsg;

  try {
    // Step 1: Show initial progress
    progressMsg = await ctx.reply(ce(EMOJI.loading, '⏳') + ' <b>Step 1/5:</b> Validating account...', { parse_mode: 'HTML' });

    // Step 2: Get user and decrypt credentials

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    if (!user) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        progressMsg.message_id,
        undefined,
        t(lang, 'trade.userNotFound')
      );
      return;
    }

    if (!user.polymarketProxyAddress) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        progressMsg.message_id,
        undefined,
        t(lang, 'trade.walletNotReady'),
        {
          parse_mode: 'Markdown',
        }
      );
      return;
    }

    // Step 2+3: Check balance (and trading approvals if needed) in parallel
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      ce(EMOJI.loading, '⏳') + (!user.tradingEnabled
        ? ' <b>Step 2/5:</b> Checking balance &amp; approvals...'
        : ' <b>Step 2/5:</b> Checking balance...'),
      { parse_mode: 'HTML' }
    );

    // Run balance fetch + enableTrading in parallel (for first-trade users both run concurrently)
    const balancePromise = getBalance(
      user.encryptedPrivateKey,
      user.encryptedApiKey,
      user.encryptedApiSecret,
      user.encryptedPassphrase,
      user.predexonUserId ?? undefined
    ).catch(() => '0');

    const enablePromise = !user.tradingEnabled
      ? enableTrading(user.encryptedPrivateKey, user.polymarketProxyAddress, user.predexonUserId ?? undefined)
      : null;

    const [balanceStr, enableResult] = await Promise.all([
      balancePromise,
      enablePromise ?? Promise.resolve(null),
    ]);
    const balanceUSD = parseFloat(balanceStr);

    if (balanceUSD < amount) {
      if (balanceUSD < 1) {
        // Not enough even for the minimum trade — only deposit option makes sense
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          progressMsg.message_id,
          undefined,
          t(lang, 'trade.insufficientBalance', { balance: balanceUSD.toFixed(2) }),
          {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback(t(lang, 'trade.depositBtn'), 'deposit_menu')],
              [Markup.button.callback(t(lang, 'btn.wallet'), 'wallet_page')],
              [backToMarketBtn(marketId)],
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

        // Clear any conflicting limit-order state so the text handler routes correctly
        limitTradeState.delete(telegramId);

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
          t(lang, 'trade.insufficientBalanceCustom', {
            balance: balanceUSD.toFixed(2),
            defaultAmount: amount.toFixed(2),
            example: String(Math.max(1, maxAmount)),
            max: String(maxAmount),
          }),
          {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback(t(lang, 'btn.cancel'), 'trade_cancel')],
            ]).reply_markup,
          }
        );
      }
      return;
    }

    // Process enableTrading result (ran in parallel with balance check above)
    if (enableResult) {
      if (enableResult.success) {
        await prisma.user.update({ where: { id: user.id }, data: { tradingEnabled: true } }).catch(() => {});
        logger.info(`[trade] Trading approvals confirmed for user: ${user.id}`);
      } else {
        logger.warn(`[trade] Could not verify trading approvals for user ${user.id} — proceeding anyway`);
      }
    }

    // Calculate commission and trade amount (commission collected after successful trade)
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
        t(lang, 'trade.minTradeAmount', {
          feePct: (COMMISSION_RATE * 100).toFixed(0),
          entered: amount.toFixed(2),
          tradeAmount: tradeAmount.toFixed(2),
          minRequired: minRequired.toFixed(2),
        }),
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.cancel'), 'trade_cancel')]]).reply_markup,
        }
      );
      return;
    }

    // Step 4: Create CLOB client
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      ce(EMOJI.loading, '⏳') + ' <b>Step 4/5:</b> Connecting to exchange...',
      { parse_mode: 'HTML' }
    );


    // Ensure user has a Predexon userId (lazy migration for existing users)
    const predexonUserId = await ensurePredexonUser(user);

    // Step 5: Resolve token ID, tick size, and negRisk from market data
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      ce(EMOJI.loading, '⏳') + ' <b>Step 5/5:</b> Preparing order...',
      { parse_mode: 'HTML' }
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

    // Fetch CLOB market for tick size + negRisk; results are cached for 10 min.
    // Tick size and token IDs never change, so cache is safe and eliminates ~300-800ms per trade.
    try {
      const conditionId = market.conditionId || market.condition_id;
      const idToTry = conditionId || marketId;

      const getClobMarket = async (id: string): Promise<any> => {
        const cached = clobMarketCache.get(id);
        if (cached && cached.expiresAt > Date.now()) return cached.data;
        logger.info(`[trade] Fetching CLOB market: ${id}`);
        const resp = await axios.get(`https://clob.polymarket.com/markets/${id}`, { timeout: 10000 });
        clobMarketCache.set(id, { data: resp.data, expiresAt: Date.now() + CLOB_CACHE_TTL_MS });
        return resp.data;
      };

      const cm = await getClobMarket(idToTry);
      if (!tokenId) tokenId = cm.tokens?.[outcomeIdx]?.token_id;
      if (cm.minimum_tick_size) tickSize = String(cm.minimum_tick_size);
      if (cm.neg_risk !== undefined) isNegRisk = !!cm.neg_risk;

      // Last-resort: try with raw marketId
      if (!tokenId && conditionId && conditionId !== marketId) {
        const fb = await getClobMarket(marketId);
        if (!tokenId) tokenId = fb.tokens?.[outcomeIdx]?.token_id;
        if (fb.minimum_tick_size) tickSize = String(fb.minimum_tick_size);
      }
    } catch (err) {
      logger.error('[trade] Error fetching CLOB market data:', err);
    }

    if (!tokenId) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id, progressMsg.message_id, undefined,
        t(lang, 'trade.marketNotAvailable'),
        { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[backToMarketBtn(marketId)], [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')]]).reply_markup }
      );
      return;
    }

    if (!market.active || market.closed) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id, progressMsg.message_id, undefined,
        t(lang, 'trade.marketClosed'),
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Read user's slippage tolerance (default 1%)
    const slippagePct  = user.slippageTolerance ?? 1.0;
    const slippageMult = 1 + slippagePct / 100;

    // Calculate market price and snap worst-case price to tick size
    let outcomePricesArr: string[] = ['0.5', '0.5'];
    try {
      outcomePricesArr = Array.isArray(market.outcomePrices)
        ? market.outcomePrices
        : JSON.parse(market.outcomePrices || '["0.5","0.5"]');
    } catch { /* keep defaults */ }
    const marketPriceRaw = parseFloat(outcomePricesArr[outcomeIdx] ?? '0.5');
    const marketPrice = isNaN(marketPriceRaw) ? 0.5 : marketPriceRaw;

    // Worst-case price = market price + user slippage%, snapped to tick size, capped at 0.99
    const tick = Math.max(parseFloat(tickSize), 0.001);
    const decimals = tickSize.includes('.') ? tickSize.split('.')[1].length : 2;
    // For low-priced outcomes, ensure at least +1 tick above market price so FAK has room to fill
    const rawWorst = marketPrice * slippageMult;
    const snapped = Math.round(rawWorst / tick) * tick;
    const withMinBump = snapped <= marketPrice ? snapped + tick : snapped;
    const worstPrice = parseFloat(
      Math.min(withMinBump, 0.99).toFixed(decimals)
    );

    // Estimated shares (for display only — FAK fills whatever is available at the price)
    const estimatedSize = worstPrice > 0 ? parseFloat((tradeAmount / worstPrice).toFixed(4)) : 0;

    // FAK market order — executes immediately against best available asks up to worstPrice
    // amount = USD to spend (tradeAmount after commission deduction)

    logger.info(`[trade] Placing FAK BUY: ~${estimatedSize} shares of ${outcome.toUpperCase()} tokenId=${tokenId.substring(0,16)}... maxPrice=${worstPrice} slippage=${slippagePct}% tickSize=${tickSize} negRisk=${isNegRisk}`);

    const orderResponse = await placeOrder(predexonUserId, {
      venue: 'polymarket',
      tokenId,
      side: 'buy',
      type: 'market',
      amount: String(tradeAmount),
    });

    if (!orderResponse.orderId) {
      const errMsg = (orderResponse as any).error || (orderResponse as any).message || 'Order placement failed';
      logger.error(`[trade] Predexon rejected order for user ${telegramId}: ${errMsg}`);

      // User-friendly messages for known CLOB errors
      if (errMsg.includes('balance') || errMsg.includes('allowance')) {
        // Reset tradingEnabled so the approval flow re-runs on the next trade attempt

        await prisma.user.update({ where: { id: user.id }, data: { tradingEnabled: false } }).catch(() => {});
        await ctx.telegram.editMessageText(
          ctx.chat!.id, progressMsg.message_id, undefined,
          t(lang, 'trade.insufficientBalanceOrApproval'),
          { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[tradeAgainBtn(t(lang, 'trade.tryAgainBtn'), marketId)], [Markup.button.callback(t(lang, 'btn.wallet'), 'wallet_page')], [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')]]).reply_markup }
        );
        return;
      }
      if (errMsg.includes('no orders found') || errMsg.includes('liquidity') || errMsg.includes('FOK') || errMsg.includes('FAK')) {
        const priceCents = (marketPrice * 100).toFixed(1);
        const worstCents = (worstPrice * 100).toFixed(1);
        await ctx.telegram.editMessageText(
          ctx.chat!.id, progressMsg.message_id, undefined,
          t(lang, 'trade.noLiquidity', {
            outcome: outcome.toUpperCase(),
            priceCents,
            worstCents,
            slippage: String(slippagePct),
          }),
          { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.settings'), 'settings_menu')], [tradeAgainBtn(t(lang, 'trade.tryAgainBtn'), marketId)], [backToMarketBtn(marketId)], [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')]]).reply_markup }
        );
        return;
      }
      if (errMsg.includes('lower than the minimum') || (errMsg.includes('Size') && errMsg.includes('minimum'))) {
        const minMatch = errMsg.match(/minimum[:\s]+(\d+(?:\.\d+)?)/i);
        const minShares = minMatch ? parseFloat(minMatch[1]) : 1;
        const minUsd = (minShares * worstPrice).toFixed(2);
        logger.warn(`[trade] CLOB minimum size not met for user ${telegramId}: ${errMsg}`);
        await ctx.telegram.editMessageText(
          ctx.chat!.id, progressMsg.message_id, undefined,
          t(lang, 'trade.amountTooSmall', {
            minShares: String(minShares),
            priceCents: (worstPrice * 100).toFixed(1),
            minUsd,
          }),
          { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[tradeAgainBtn(t(lang, 'trade.tryAgainBtn'), marketId)], [backToMarketBtn(marketId)], [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')]]).reply_markup }
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
      transferCommission(user.encryptedPrivateKey, user.polymarketProxyAddress!, commissionAmt, user.id, user.predexonUserId ?? undefined)
        .catch((err) => logger.warn(`[trade] Commission transfer failed for user ${telegramId}:`, err?.message || err));
    }

    // Invalidate portfolio caches so next view is fresh (fire-and-forget)
    invalidatePortfolioCache(user.polymarketProxyAddress).catch(() => {});

    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const marketQuestion = escHtml(market.question || 'Unknown Market');
    const entryPriceCents = (worstPrice * 100).toFixed(1);
    const eventSlug = market.event?.slug ?? market.events?.[0]?.slug;
    const polymarketLink = eventSlug
      ? `https://polymarket.com/event/${eventSlug}`
      : `https://polymarket.com`;

    const successKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, 'trade.myPositionsBtn'), 'portfolio_open_1')],
      [Markup.button.callback(t(lang, 'trade.openOrdersBtn'),  'portfolio_orders_1')],
      [tradeAgainBtn(t(lang, 'trade.tradeAgainBtn'), marketId)],
      [Markup.button.callback(t(lang, 'btn.mainMenu'),    'back_to_menu')],
    ]).reply_markup;

    const buildMessage = (txLine: string) =>
      `${ce(EMOJI.cherry, '🌸')} <b>${t(lang, 'trade.txCompleted')}</b>\n\n` +
      `📌 <b>${t(lang, 'trade.txMarketLabel')}</b>\n${marketQuestion}\n` +
      `<b>${t(lang, 'trade.txOrderType')}</b> 📄 Market ${outcome.toUpperCase()}\n` +
      `<b>${t(lang, 'trade.txInvested')}</b> $${amount.toFixed(2)}\n` +
      `<b>${t(lang, 'trade.txShares')}</b> ~${estimatedSize}\n` +
      `<b>${t(lang, 'trade.txEntryPrice')}</b> ${entryPriceCents}¢\n\n` +
      txLine +
      `${ce(EMOJI.marketsTitle, '🤑')} <a href="${polymarketLink}">${t(lang, 'trade.viewOnPolymarket')}</a>`;

    await ctx.telegram.editMessageText(
      ctx.chat!.id, progressMsg.message_id, undefined,
      buildMessage(`🔗 <b>${t(lang, 'trade.txHashLabel')}</b> <i>${t(lang, 'trade.txHashFetching')}</i>\n\n`),
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: successKeyboard }
    );

    logger.info(`[trade] Order placed: user=${telegramId} market=${marketId} outcome=${outcome.toUpperCase()} amount=$${amount} orderID=${orderResponse.orderId}`);

    // ── Fetch on-chain tx hash and update the message (fire-and-forget) ─────
    if (user.polymarketProxyAddress) {
      const chatId    = ctx.chat!.id;
      const msgId     = progressMsg.message_id;
      const proxyAddr = user.polymarketProxyAddress;
      const placedAt  = Date.now() - 5_000; // order was placed seconds ago
      ;(async () => {
        try {
          const txHash = await fetchTxHashForOrder(proxyAddr, tokenId, placedAt);
          const txLine = txHash
            ? `🔗 <b>${t(lang, 'trade.txHashLabel')}</b> <a href="https://polygonscan.com/tx/${txHash}">${txHash.slice(0, 10)}…${txHash.slice(-8)}</a>\n\n`
            : ``;
          await ctx.telegram.editMessageText(
            chatId, msgId, undefined,
            buildMessage(txLine),
            { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: successKeyboard }
          );
        } catch {
          // Non-fatal — user already sees the success message
        }
      })();
    }

    // ── Auto-send PNL image for the just-traded position (fire-and-forget) ────
    (async () => {
      try {
        if (!user.polymarketProxyAddress) return;

        // Small delay for the Data API to reflect the new position
        await new Promise((r) => setTimeout(r, 3000));

        const positions = await getActivePositions(user.polymarketProxyAddress, true);
        // Find the position matching this market + outcome
        const pos = positions.find(
          (p) => p.conditionId === marketId && p.outcome?.toUpperCase() === outcome.toUpperCase()
        );
        if (!pos) return;

        const [profilePhotoBuffer, eventIconBuffer] = await Promise.all([
          fetchProfilePhoto(ctx),
          (async () => {
            if (!pos.icon) return undefined;
            try {
              const res = await fetch(pos.icon);
              if (!res.ok) return undefined;
              return Buffer.from(await res.arrayBuffer());
            } catch { return undefined; }
          })(),
        ]);

        const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');
        const imageBuffer = await generatePositionPnlImage({
          title: pos.title,
          outcome: pos.outcome,
          cashPnl: pos.cashPnl,
          percentPnl: pos.percentPnl,
          avgPrice: pos.avgPrice,
          curPrice: pos.curPrice,
          invested: pos.initialValue,
          currentValue: pos.currentValue,
          username: ctx.from?.username,
          displayName,
          profilePhotoBuffer,
          eventIconBuffer,
        });

        if (imageBuffer && ctx.chat) {
          const pnlSign = pos.cashPnl >= 0 ? '+' : '';
          const pctSign = pos.percentPnl >= 0 ? '+' : '';
          const escTitle = (pos.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

          const caption =
            `📊 <b>${t(lang, 'trade.pnlTitle')}</b>\n\n` +
            `<b>${pos.outcome}</b> — ${escTitle}\n\n` +
            `💰 <b>${t(lang, 'trade.pnlLabel')}</b> ${pnlSign}$${pos.cashPnl.toFixed(2)} (${pctSign}${pos.percentPnl.toFixed(1)}%)\n` +
            `🎯 <b>${t(lang, 'trade.pnlEntry')}</b> ${(pos.avgPrice * 100).toFixed(1)}¢  →  <b>${t(lang, 'trade.pnlCurrent')}</b> ${(pos.curPrice * 100).toFixed(1)}¢`;

          await ctx.telegram.sendPhoto(
            ctx.chat.id,
            { source: imageBuffer },
            { caption, parse_mode: 'HTML' }
          );
        }
      } catch (pnlErr) {
        logger.warn('[trade] Post-trade PNL image failed (non-critical):', pnlErr);
      }
    })();

  } catch (error: any) {
    logger.error('Error executing trade:', error);

    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    const rawErr: string = error.message ?? 'Unknown error';
    // Detect Cloudflare HTML / oversized error pages — show friendly message instead
    const isHtml = rawErr.includes('<!DOCTYPE') || rawErr.includes('Access denied') || rawErr.includes('Cloudflare');
    const safeMd = (s: string) => s.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const friendlyErr = isHtml
      ? t(lang, 'trade.serviceUnavailable')
      : rawErr.slice(0, 200);
    const errorMessage = `❌ *${t(lang, 'trade.tradeFailed')}*\n\n${safeMd(friendlyErr)}`;

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
              [tradeAgainBtn(t(lang, 'trade.tryAgainBtn'), marketId)],
              [backToMarketBtn(marketId)],
              [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
            ]).reply_markup,
          }
        );
      } else {
        await ctx.reply(errorMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [tradeAgainBtn(t(lang, 'trade.tryAgainBtn'), marketId)],
            [backToMarketBtn(marketId)],
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

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    const state = await tradeState.get(telegramId);
    if (!state) {
      await ctx.reply(t(lang, 'trade.sessionExpired'));
      return;
    }

    // Check if state expired (10 minutes)
    if (Date.now() - state.timestamp > 10 * 60 * 1000) {
      tradeState.delete(telegramId);
      await ctx.reply(t(lang, 'trade.sessionExpired'));
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
      await ctx.reply(t(lang, 'trade.invalidAmountRange'));
      return;
    }

    // Fetch market for latest data BEFORE clearing state (if fetch fails, state is preserved for retry)

    // Use cached market from tradeState if available, otherwise re-fetch
    let market = state.market;
    if (!market) {
      try {
        const gammaResponse = await axios.get(`https://gamma-api.polymarket.com/markets/${state.marketId}`, {
          timeout: 10000,
        });
        market = gammaResponse.data;
      } catch (gammaError) {
        try {
          const clobResponse = await axios.get(`https://clob.polymarket.com/markets/${state.marketId}`, {
            timeout: 10000,
          });
          market = clobResponse.data;
        } catch (clobError) {
          logger.error(`Error fetching market ${state.marketId} from both APIs:`, { gammaError, clobError });
          await ctx.reply(t(lang, 'trade.marketNotFound'));
          return;
        }
      }
    }

    // Clear state after market is resolved
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
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(t(lang, 'common.error'));
  }
}

/**
 * Handles trade confirmation (reads pending trade from tradeState — no data in callback)
 */
export async function handleTradeConfirm(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    const state = await tradeState.get(telegramId);
    if (!state || state.amount == null) {
      await ctx.reply(t(lang, 'trade.sessionExpired'), {
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')]]),
      });
      return;
    }

    const { marketId, outcome, amount } = state;

    // Use market cached in state (stored by handleLargeTradeConfirmation).
    // Only falls back to a network fetch if state.market is somehow missing.
    let market = state.market;

    if (!market) {

      try {
        const gammaResponse = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, {
          timeout: 10000,
        });
        market = gammaResponse.data;
      } catch (gammaError) {
        try {
          const clobResponse = await axios.get(`https://clob.polymarket.com/markets/${marketId}`, {
            timeout: 10000,
          });
          market = clobResponse.data;
        } catch (clobError) {
          logger.error(`Error fetching market ${marketId} from both APIs:`, { gammaError, clobError });
          await ctx.reply(t(lang, 'trade.marketNotFound'));
          return;
        }
      }
    }

    tradeState.delete(telegramId);

    await executeTrade(ctx, marketId, market, outcome, amount);
  } catch (error) {
    logger.error('Error confirming trade:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    await ctx.reply(t(lang, 'common.errorGeneric'));
  }
}

/**
 * Handles trade cancellation
 */
export async function handleTradeCancel(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id.toString();
    const user = telegramId ? await getUserByTelegramId(telegramId) : null;
    const lang = getLang(user);

    await ctx.answerCbQuery(t(lang, 'trade.cancelledCb'));

    const savedMarketId = telegramId ? (await tradeState.get(telegramId))?.marketId : undefined;
    if (telegramId) {
      tradeState.delete(telegramId);
    }

    await ctx.editMessageText(t(lang, 'trade.cancelled'), {
      ...Markup.inlineKeyboard([
        [savedMarketId ? backToMarketBtn(savedMarketId) : Markup.button.callback(t(lang, 'btn.backToMarkets'), 'show_categories')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
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
  const telegramId = ctx.from?.id.toString();
  const user = telegramId ? await getUserByTelegramId(telegramId) : null;
  const lang = getLang(user);

  const botUsername = ctx.botInfo?.username || process.env.BOT_USERNAME || 'PolymarketBot';
  let market: any;
  try {
    const r = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, { timeout: 10000 });
    market = r.data;
  } catch {
    try {
      const r = await axios.get(`https://clob.polymarket.com/markets/${marketId}`, { timeout: 10000 });
      market = r.data;
    } catch {
      await ctx.reply(t(lang, 'trade.marketNotFound'));
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
    t(lang, 'limit.selectOutcome') + '\n\n' +
    t(lang, 'trade.market', { question: q }) + '\n' +
    t(lang, 'limit.currentPrices', { yesPrice, noPrice }),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.url(`BUY YES (${yesPrice}¢)`, `https://t.me/${botUsername}?start=limit_${marketId}_yes`),
          Markup.button.url(`BUY NO (${noPrice}¢)`,   `https://t.me/${botUsername}?start=limit_${marketId}_no`),
        ],
        [Markup.button.callback(t(lang, 'btn.cancel'), 'limit_cancel')],
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

  const user = await getUserByTelegramId(telegramId);
  const lang = getLang(user);

  let market: any;
  try {
    const r = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, { timeout: 10000 });
    market = r.data;
  } catch {
    try {
      const r = await axios.get(`https://clob.polymarket.com/markets/${marketId}`, { timeout: 10000 });
      market = r.data;
    } catch {
      await ctx.reply(t(lang, 'trade.marketNotFound'));
      return;
    }
  }

  if (!market.active || market.closed) {
    await ctx.reply(t(lang, 'limit.marketClosed'));
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

  // Extract token info from Gamma response
  let tokenId: string | undefined;
  if (market.tokens && Array.isArray(market.tokens)) {
    tokenId = market.tokens[outcomeIndex]?.token_id;
  } else if (market.clobTokenIds && Array.isArray(market.clobTokenIds)) {
    tokenId = market.clobTokenIds[outcomeIndex];
  }

  const conditionId = market.conditionId || market.condition_id;
  let tickSize = '0.01';
  let isNegRisk = false;

  // Fetch CLOB market for tick size + negRisk (use conditionId, not marketId)
  try {
    const idToTry = conditionId || marketId;
    const cached = clobMarketCache.get(idToTry);
    let cm: any;
    if (cached && cached.expiresAt > Date.now()) {
      cm = cached.data;
    } else {
      const clobResp = await axios.get(`https://clob.polymarket.com/markets/${idToTry}`, { timeout: 10000 });
      cm = clobResp.data;
      clobMarketCache.set(idToTry, { data: cm, expiresAt: Date.now() + CLOB_CACHE_TTL_MS });
    }
    if (!tokenId) tokenId = cm.tokens?.[outcomeIndex]?.token_id;
    if (cm.minimum_tick_size) tickSize = String(cm.minimum_tick_size);
    if (cm.neg_risk !== undefined) isNegRisk = !!cm.neg_risk;
  } catch (err) {
    logger.warn('[limit] Could not fetch CLOB market data in start:', err);
  }

  if (!tokenId) {
    await ctx.reply(t(lang, 'limit.marketNotAvailable'), {
      ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')]]),
    });
    return;
  }

  // Clear any conflicting market-order state so the text handler routes correctly
  tradeState.delete(telegramId);

  limitTradeState.set(telegramId, {
    step: 'awaiting_limit_price',
    marketId,
    marketQuestion: market.question || 'Unknown Market',
    outcome,
    outcomeIndex,
    currentPrice,
    conditionId,
    tokenId,
    tickSize,
    negRisk: isNegRisk,
    timestamp: Date.now(),
  });

  await ctx.reply(
    t(lang, 'limit.buyTitle', { outcome: outcome.toUpperCase() }) + '\n\n' +
    t(lang, 'trade.market', { question: market.question }) + '\n' +
    t(lang, 'limit.currentPrice', { price: currentCents }) + '\n\n' +
    t(lang, 'limit.enterPrice', { example: String(exampleCents) }),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn.cancel'), 'limit_cancel')],
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

  const user = await getUserByTelegramId(telegramId);
  const lang = getLang(user);

  const state = await limitTradeState.get(telegramId);
  if (!state) return false;

  if (Date.now() - state.timestamp > 10 * 60 * 1000) {
    limitTradeState.delete(telegramId);
    return false;
  }

  // In awaiting_confirmation step the user should click a button, not type
  if (state.step === 'awaiting_confirmation') {
    await ctx.reply(t(lang, 'limit.tapButton'));
    return true;
  }

  if (state.step === 'awaiting_limit_price') {
    const raw = text.trim().replace(/[^\d.]/g, '');
    const cents = parseFloat(raw);

    if (isNaN(cents) || cents < 1 || cents > 99) {
      await ctx.reply(t(lang, 'limit.invalidPrice'), { parse_mode: 'Markdown' });
      return true;
    }

    const limitPrice = parseFloat((cents / 100).toFixed(4));
    const currentCents = (state.currentPrice * 100).toFixed(1);

    // Warn if limit is above current price (order would fill immediately)
    const aboveMarketNote = cents > state.currentPrice * 100
      ? `\n${t(lang, 'limit.aboveMarketWarning', { limitCents: String(cents), currentCents })}\n`
      : '';

    state.limitPrice = limitPrice;
    state.step = 'awaiting_limit_amount';
    state.timestamp = Date.now();
    limitTradeState.set(telegramId, state);

    // Fetch balance for display
    const balanceStr = user
      ? await getBalance(user.encryptedPrivateKey, user.encryptedApiKey, user.encryptedApiSecret, user.encryptedPassphrase, user.predexonUserId ?? undefined).catch(() => '0.00')
      : '0.00';

    await ctx.reply(
      t(lang, 'limit.buyAtPrice', { outcome: state.outcome.toUpperCase(), cents: String(cents) }) + '\n\n' +
      t(lang, 'trade.market', { question: state.marketQuestion }) + '\n' +
      t(lang, 'limit.currentPrice', { price: currentCents }) + '\n' +
      t(lang, 'limit.yourLimit', { cents: String(cents) }) + '\n' +
      t(lang, 'trade.balance', { balance: balanceStr }) +
      aboveMarketNote + '\n' +
      t(lang, 'limit.enterAmount'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.cancel'), 'limit_cancel')],
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
      await ctx.reply(t(lang, 'limit.invalidAmount'));
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
        t(lang, 'limit.minAfterFee', {
          feePct: (COMMISSION_RATE * 100).toFixed(0),
          minRequired: minRequired.toFixed(2),
        }),
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    state.amount = amount;
    state.step = 'awaiting_confirmation';
    state.timestamp = Date.now();
    limitTradeState.set(telegramId, state);

    await ctx.reply(
      t(lang, 'limit.confirmTitle') + '\n\n' +
      t(lang, 'trade.market', { question: state.marketQuestion }) +
      t(lang, 'limit.confirmSide', { outcome: state.outcome.toUpperCase() }) + '\n\n' +
      t(lang, 'limit.confirmCurrentPrice', { price: currentCents }) + '\n' +
      t(lang, 'limit.confirmLimitPrice', { price: limitCents }) + '\n' +
      t(lang, 'limit.confirmAmount', { amount: amount.toFixed(2) }) + '\n' +
      t(lang, 'limit.confirmFee', { fee: commissionAmt.toFixed(2) }) + '\n' +
      t(lang, 'limit.confirmTradeAmount', { tradeAmount: tradeAmount.toFixed(2) }) + '\n' +
      t(lang, 'limit.confirmShares', { shares: String(estShares) }) + '\n\n' +
      t(lang, 'limit.confirmGtcNote'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(t(lang, 'limit.placeBtn'), 'limit_confirm'),
            Markup.button.callback(t(lang, 'btn.cancel'), 'limit_cancel'),
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

  const user = await getUserByTelegramId(telegramId);
  const lang = getLang(user);

  const state = await limitTradeState.get(telegramId);
  if (!state || state.step !== 'awaiting_confirmation' || !state.limitPrice || !state.amount) {
    await ctx.editMessageText(t(lang, 'limit.sessionExpired')).catch(() => {});
    return;
  }

  if (Date.now() - state.timestamp > 10 * 60 * 1000) {
    limitTradeState.delete(telegramId);
    await ctx.editMessageText(t(lang, 'limit.sessionExpired')).catch(() => {});
    return;
  }

  limitTradeState.delete(telegramId);

  // Show progress immediately
  await ctx.editMessageText(ce(EMOJI.loading, '⏳') + ` ${t(lang, 'limit.placing')}`, { parse_mode: 'HTML' }).catch(() => {});

  await executeLimitTrade(ctx, state.marketId, state.marketQuestion, state.outcome, state.limitPrice, state.amount, state.tokenId, state.tickSize, state.negRisk);
}

/**
 * Cancels the limit order flow.
 */
export async function handleLimitCancel(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  const user = telegramId ? await getUserByTelegramId(telegramId) : null;
  const lang = getLang(user);

  await ctx.answerCbQuery(t(lang, 'limit.cancelledCb'));

  const savedMarketId = telegramId ? (await limitTradeState.get(telegramId))?.marketId : undefined;
  if (telegramId) limitTradeState.delete(telegramId);

  await ctx.editMessageText(t(lang, 'limit.cancelled'), {
    ...Markup.inlineKeyboard([
      [savedMarketId ? backToMarketBtn(savedMarketId) : Markup.button.callback(t(lang, 'btn.backToMarkets'), 'show_categories')],
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
  stateTokenId?: string,
  stateTickSize?: string,
  stateNegRisk?: boolean,
): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  try {

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    if (!user) {
      await ctx.editMessageText(t(lang, 'trade.userNotFound')).catch(() => {});
      return;
    }

    if (!user.polymarketProxyAddress) {
      await ctx.editMessageText(
        t(lang, 'limit.walletNotSetup'),
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'trade.depositBtn'), 'deposit_menu')],
          ]).reply_markup,
        }
      ).catch(() => {});
      return;
    }


    const tokenId = stateTokenId;
    const tickSize = stateTickSize || '0.01';
    const isNegRisk = stateNegRisk || false;

    if (!tokenId) {
      await ctx.editMessageText(t(lang, 'limit.marketNotAvailable')).catch(() => {});
      return;
    }

    const commissionAmt = parseFloat((amount * COMMISSION_RATE).toFixed(6));
    const tradeAmount   = parseFloat((amount - commissionAmt).toFixed(6));

    // Snap limit price to tick size (price must land exactly on a tick — venues reject off-tick prices silently)
    const tick     = Math.max(parseFloat(tickSize), 0.001);
    const decimals = tickSize.includes('.') ? tickSize.split('.')[1].length : 2;
    const snappedPrice = parseFloat(
      Math.min(Math.round(limitPrice / tick) * tick, 0.99).toFixed(decimals)
    );

    // Shares: floor to 2 decimals (Polymarket convention; 4dp can be silently truncated/rejected)
    const sharesToBuy = Math.floor((tradeAmount / snappedPrice) * 100) / 100;

    if (sharesToBuy < 0.01) {
      await ctx.editMessageText(t(lang, 'limit.amountTooSmall')).catch(() => {});
      return;
    }


    // Ensure user has Predexon userId
    const predexonUserId = await ensurePredexonUser(user);

    logger.info(
      `[limit] Placing GTC BUY: ${sharesToBuy} shares of ${outcome.toUpperCase()} ` +
      `tokenId=${tokenId.substring(0, 16)}... price=${snappedPrice} tickSize=${tickSize} negRisk=${isNegRisk}`
    );

    const orderResp = await placeOrder(predexonUserId, {
      venue: 'polymarket',
      tokenId,
      side: 'buy',
      type: 'limit',
      size: String(sharesToBuy),
      price: String(snappedPrice),
    });

    if (!orderResp.orderId) {
      const errMsg = (orderResp as any).error || (orderResp as any).message || 'Order rejected by exchange';
      throw new Error(errMsg);
    }

    // ── Verify the order actually landed on the venue (Predexon may return an orderId
    //    even when the order failed to post to Polymarket's CLOB — silent ghost orders) ──
    const acceptedStatuses = new Set(['open', 'live', 'pending', 'filled', 'partially_filled']);
    let confirmedStatus: string = String(orderResp.status ?? 'unknown').toLowerCase();
    if (!acceptedStatuses.has(confirmedStatus)) {
      // Re-check after a brief delay — some venues report pending → open within 1–2s
      await new Promise(r => setTimeout(r, 1500));
      try {
        const recheck = await predexonGetOrder(predexonUserId, orderResp.orderId);
        confirmedStatus = String(recheck.status ?? 'unknown').toLowerCase();
        logger.info(`[limit] Recheck status for ${orderResp.orderId}: ${confirmedStatus}`);
      } catch (rcErr: any) {
        logger.warn(`[limit] Recheck failed for ${orderResp.orderId}: ${rcErr?.message}`);
      }
      if (!acceptedStatuses.has(confirmedStatus)) {
        throw new Error(
          `Order did not reach the order book (Predexon status: ${confirmedStatus}). ` +
          `This usually means the venue rejected the price/size or the builder credentials are misconfigured.`
        );
      }
    }

    // Commission transfer (fire-and-forget) — same pattern as market orders
    if (config.commission?.adminWalletAddress) {
      transferCommission(user.encryptedPrivateKey, user.polymarketProxyAddress!, commissionAmt, user.id, user.predexonUserId ?? undefined)
        .catch((err) => logger.warn(`[limit] Commission transfer failed for user ${telegramId}: ${err?.message}`));
    }

    const limitCents = (snappedPrice * 100).toFixed(1);
    const message =
      t(lang, 'limit.placed') + '\n\n' +
      t(lang, 'trade.market', { question: marketQuestion }) +
      t(lang, 'limit.confirmSide', { outcome: outcome.toUpperCase() }) + '\n\n' +
      t(lang, 'limit.confirmLimitPrice', { price: limitCents }) + '\n' +
      t(lang, 'limit.confirmAmount', { amount: amount.toFixed(2) }) + '\n' +
      t(lang, 'limit.placedFee', { fee: commissionAmt.toFixed(2) }) + '\n' +
      t(lang, 'limit.placedTradeAmount', { tradeAmount: tradeAmount.toFixed(2) }) + '\n' +
      t(lang, 'limit.placedShares', { shares: String(sharesToBuy) }) + '\n\n' +
      t(lang, 'limit.placedGtcNote');

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'limit.openOrdersBtn'),   'portfolio_orders_1')],
        [Markup.button.callback(t(lang, 'trade.myPositionsBtn'),  'portfolio_open_1')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'),     'back_to_menu')],
      ]).reply_markup,
    }).catch(() => {});

    logger.info(
      `[limit] Order placed: user=${telegramId} market=${marketId} ` +
      `outcome=${outcome.toUpperCase()} price=${snappedPrice} shares=${sharesToBuy} orderID=${orderResp.orderId}`
    );

  } catch (error: any) {
    logger.error('[limit] Error executing limit trade:', error);
    const lang = ((ctx as any).userLanguage as Locale) || 'en';
    const safeMd = (s: string) => s.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    const rawErr = error?.message ?? 'Unknown error';
    await ctx.editMessageText(
      `❌ *${t(lang, 'limit.failed')}*\n\n${safeMd(rawErr)}`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [backToMarketBtn(marketId)],
          [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
        ]).reply_markup,
      }
    ).catch(() => {});
  }
}
