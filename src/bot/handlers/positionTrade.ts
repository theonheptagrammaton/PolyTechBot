import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { getActivePositions, ActivePosition } from '../../services/portfolio';
import { decrypt } from '../../utils/encryption';
import { logger } from '../../utils/logger';
import { transferCommission, COMMISSION_RATE } from '../../services/commission';
import { sendPage } from '../../utils/telegram';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Polymarket CLOB minimum order size in shares/tokens */
const MIN_ORDER_SIZE = 5;

// ─── Caches ────────────────────────────────────────────────────────────────

/** telegramId → fetched positions array (populated when user opens positions page) */
export const positionListCache = new Map<string, ActivePosition[]>();

// ─── State ─────────────────────────────────────────────────────────────────

interface PositionTradeState {
  action: 'buy' | 'sell';
  assetId: string;
  conditionId: string;
  negRisk: boolean;
  title: string;
  outcome: string;
  currentSize: number;
  curPrice: number;       // current market price (used as default for confirmations)
  step: 'awaiting_price_size';
  price?: number;
  size?: number;
  timestamp: number;
}

export const positionTradeState = new Map<string, PositionTradeState>();

// R6: Periodic cleanup of abandoned state entries (every 30 min, remove entries > 10 min old)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, state] of positionTradeState.entries()) {
    if (state.timestamp < cutoff) positionTradeState.delete(key);
  }
}, 30 * 60 * 1000);

// ─── Helpers ───────────────────────────────────────────────────────────────

function getPos(telegramId: string, idx: number): ActivePosition | null {
  const list = positionListCache.get(telegramId);
  if (!list || idx < 0 || idx >= list.length) return null;
  return list[idx];
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.substring(0, n) + '...' : s;
}

// ─── Full list ─────────────────────────────────────────────────────────────

export async function handleOpenPositionsFull(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading...');
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) return;

    const positions = await getActivePositions(user.polymarketProxyAddress || '');
    positionListCache.set(telegramId, positions);

    if (positions.length === 0) {
      await sendPage(ctx, '📊 *Active Positions*\n\n📭 No active positions.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'portfolio_open_1')]]),
      });
      return;
    }

    let message = `📊 *All Active Positions* (${positions.length})\n\n`;
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      const pnlSign = pos.cashPnl >= 0 ? '+' : '';
      const pnlEmoji = pos.cashPnl >= 0 ? '🟢' : '🔴';
      message += `${i + 1}) *${pos.outcome}* — ${truncate(pos.title, 45)}\n`;
      message += `   💵 ${pos.size.toFixed(2)} shares · ${(pos.curPrice * 100).toFixed(1)}¢ · $${pos.currentValue.toFixed(2)}\n`;
      message += `   ${pnlEmoji} P&L: ${pnlSign}$${pos.cashPnl.toFixed(2)} (${pnlSign}${pos.percentPnl.toFixed(1)}%)\n\n`;
      if (message.length > 3800) {
        message += `_... and ${positions.length - i - 1} more_`;
        break;
      }
    }

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('« Back to Positions', 'portfolio_open_1')]]),
    });
  } catch (error) {
    logger.error('Error showing full positions:', error);
  }
}

// ─── View position detail ──────────────────────────────────────────────────

export async function handlePositionView(ctx: Context, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const pos = getPos(telegramId, idx);
    if (!pos) {
      await ctx.answerCbQuery('Position not found. Please refresh.', { show_alert: true });
      return;
    }

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
    msg += `⏰ Market ends: ${endDate}\n`;
    if (pos.redeemable) msg += `✅ _Redeemable_\n`;

    await sendPage(ctx, msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📈 Buy More', `pos_buy_${idx}`),
          Markup.button.callback('📉 Sell', `pos_sell_${idx}`),
        ],
        [Markup.button.callback('« Back to Positions', 'portfolio_open_1')],
      ]),
    });
  } catch (error) {
    logger.error('Error showing position view:', error);
  }
}

// ─── Sell flow ─────────────────────────────────────────────────────────────

export async function handlePositionSell(ctx: Context, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const pos = getPos(telegramId, idx);
    if (!pos) {
      await ctx.answerCbQuery('Position not found. Please refresh.', { show_alert: true });
      return;
    }

    positionTradeState.set(telegramId, {
      action: 'sell',
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

    const curCents = (pos.curPrice * 100).toFixed(1);
    const msg =
      `📉 *Sell Position*\n\n` +
      `*${pos.outcome}* — ${truncate(pos.title, 50)}\n\n` +
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
  } catch (error) {
    logger.error('Error starting sell flow:', error);
  }
}

// ─── Buy flow ──────────────────────────────────────────────────────────────

export async function handlePositionBuy(ctx: Context, idx: number): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const pos = getPos(telegramId, idx);
    if (!pos) {
      await ctx.answerCbQuery('Position not found. Please refresh.', { show_alert: true });
      return;
    }

    positionTradeState.set(telegramId, {
      action: 'buy',
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

    const curCents = (pos.curPrice * 100).toFixed(1);
    const estimatedShares = (10 / pos.curPrice).toFixed(1);
    const msg =
      `📈 *Buy More*\n\n` +
      `*${pos.outcome}* — ${truncate(pos.title, 50)}\n\n` +
      `You already hold: *${pos.size.toFixed(4)} shares*\n` +
      `Current price: *${curCents}¢*\n\n` +
      `*Enter USDC amount to spend:*\n` +
      `Example: \`10\` → buys ~${estimatedShares} shares at ${curCents}¢`;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'pos_cancel')]]),
    });
  } catch (error) {
    logger.error('Error starting buy flow:', error);
  }
}

// ─── Quick % sell ──────────────────────────────────────────────────────────

export async function handlePositionSellPct(ctx: Context, idx: number, pct: number): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;
    const state = positionTradeState.get(telegramId);
    const pos = getPos(telegramId, idx);

    if (!state || !pos) {
      await ctx.answerCbQuery('Session expired. Please try again.', { show_alert: true });
      return;
    }

    const shares = parseFloat(((pos.size * pct) / 100).toFixed(4));
    const price = pos.curPrice;

    if (shares < MIN_ORDER_SIZE) {
      const minPct = Math.ceil((MIN_ORDER_SIZE / pos.size) * 100);
      await ctx.answerCbQuery(
        `❌ Min order: ${MIN_ORDER_SIZE} shares. ${pct}% = ${shares.toFixed(2)} shares. Try ${minPct}%+.`,
        { show_alert: true }
      );
      return;
    }

    // Refresh timestamp so the 10-min cleanup interval doesn't delete state
    // between the % click and the confirm button press
    positionTradeState.set(telegramId, { ...state, timestamp: Date.now() });

    await showSellConfirmation(ctx, telegramId, state, price, shares);
  } catch (error) {
    logger.error('Error in quick pct sell:', error);
  }
}

// ─── Text input handler ────────────────────────────────────────────────────

export async function handlePositionTradeInput(ctx: Context, text: string): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const state = positionTradeState.get(telegramId);
  if (!state) return;

  if (Date.now() - state.timestamp > 5 * 60 * 1000) {
    positionTradeState.delete(telegramId);
    await ctx.reply('❌ Session expired. Please start again.');
    return;
  }

  const val = parseFloat(text.trim().replace(/[^0-9.]/g, ''));

  if (isNaN(val) || val <= 0) {
    await ctx.reply(
      state.action === 'sell'
        ? '❌ Enter the number of shares to sell. Example: `7.5`'
        : '❌ Enter the USDC amount to spend. Example: `10`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (state.action === 'sell') {
    const shares = parseFloat(val.toFixed(4));
    if (shares > state.currentSize * 1.001) {
      await ctx.reply(`❌ You only have ${state.currentSize.toFixed(4)} shares. Cannot sell ${shares}.`);
      return;
    }
    if (shares < MIN_ORDER_SIZE) {
      await ctx.reply(
        `❌ Minimum order size is *${MIN_ORDER_SIZE} shares*. You entered ${shares.toFixed(4)} shares.\n\n` +
        `Your position: ${state.currentSize.toFixed(4)} shares — enter at least ${MIN_ORDER_SIZE}.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    // Use current market price as the FAK floor (same as quick-% buttons)
    const price = state.curPrice;
    await showSellConfirmation(ctx, telegramId, state, price, Math.min(shares, state.currentSize));
  } else {
    // Buy: val is dollar amount; derive worst price from market price + user slippage
    const usdAmount = val;
    const { getUserByTelegramId: getUser } = await import('../../services/user');
    const buyUser = await getUser(telegramId);
    const slippagePct  = buyUser?.slippageTolerance ?? 1.0;
    const slippageMult = 1 + slippagePct / 100;
    const price = Math.min(state.curPrice * slippageMult, 0.99);
    const estimatedShares = usdAmount / price;
    if (estimatedShares < MIN_ORDER_SIZE) {
      const minUsd = (MIN_ORDER_SIZE * price).toFixed(2);
      await ctx.reply(
        `❌ Minimum order size is *${MIN_ORDER_SIZE} shares*. At ${(state.curPrice * 100).toFixed(1)}¢, you need at least *$${minUsd}*.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    await showBuyConfirmation(ctx, telegramId, state, price, usdAmount, slippagePct);
  }
}

// ─── Confirmation messages ─────────────────────────────────────────────────

async function showSellConfirmation(
  ctx: Context,
  telegramId: string,
  state: PositionTradeState,
  price: number,
  shares: number
): Promise<void> {
  positionTradeState.set(telegramId, { ...state, price, size: shares });

  const estProceeds = shares * price;
  const commissionAmt = estProceeds * COMMISSION_RATE;
  const netProceeds = estProceeds - commissionAmt;

  const msg =
    `⚠️ *Confirm SELL Order*\n\n` +
    `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
    `📉 Sell: *${shares.toFixed(4)} shares*\n` +
    `💰 Min price: *${(price * 100).toFixed(2)}¢*\n` +
    `💵 Est. proceeds: *$${estProceeds.toFixed(2)}*\n` +
    `📊 Platform fee (1%): *-$${commissionAmt.toFixed(2)}*\n` +
    `💰 Net to wallet: *$${netProceeds.toFixed(2)}*\n\n` +
    `_Market order — executes immediately at the best available price._`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Confirm Sell', 'pos_execute_sell'),
        Markup.button.callback('❌ Cancel', 'pos_cancel'),
      ],
    ]),
  });
}

async function showBuyConfirmation(
  ctx: Context,
  telegramId: string,
  state: PositionTradeState,
  price: number,
  usdAmount: number,
  slippagePct: number = 1.0
): Promise<void> {
  const commissionAmt = usdAmount * COMMISSION_RATE;
  const tradeAmount = usdAmount - commissionAmt;

  if (tradeAmount < 1.0) {
    await ctx.reply(
      `❌ *Minimum order is $1.00*\n\nAfter the 1% platform fee, your trade amount would be $${tradeAmount.toFixed(2)}. Please enter at least $1.02.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const shares = parseFloat((tradeAmount / price).toFixed(4));
  positionTradeState.set(telegramId, { ...state, price, size: shares });

  const msg =
    `⚠️ *Confirm BUY Order*\n\n` +
    `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
    `📈 Buy: *~${shares.toFixed(4)} shares*\n` +
    `💰 Max price: *${(price * 100).toFixed(2)}¢* (slippage: ${slippagePct}%)\n` +
    `💵 Total: *$${usdAmount.toFixed(2)}*\n` +
    `📊 Platform fee (1%): *-$${commissionAmt.toFixed(2)}*\n` +
    `💰 Trade amount: *$${tradeAmount.toFixed(2)}*\n\n` +
    `_FAK market order — fills immediately at best available ask._`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Confirm Buy', 'pos_execute_buy'),
        Markup.button.callback('❌ Cancel', 'pos_cancel'),
      ],
    ]),
  });
}

// ─── Cancel ────────────────────────────────────────────────────────────────

export async function handlePositionCancel(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Cancelled');
    const telegramId = ctx.from?.id.toString();
    if (telegramId) positionTradeState.delete(telegramId);

    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('« Back to Positions', 'portfolio_open_1')]]);
    try {
      await ctx.editMessageText('❌ Trade cancelled.', { ...keyboard });
    } catch {
      await ctx.reply('❌ Trade cancelled.', { ...keyboard });
    }
  } catch (error) {
    logger.error('Error cancelling position trade:', error);
  }
}

// ─── Execute sell ──────────────────────────────────────────────────────────

export async function handlePositionExecuteSell(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const state = positionTradeState.get(telegramId);
    if (!state || state.price === undefined || state.size === undefined) {
      await ctx.reply('❌ Session expired. Please start again.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'portfolio_open_1')]]),
      });
      return;
    }
    positionTradeState.delete(telegramId);

    try { await ctx.editMessageText('⏳ Placing sell order...'); } catch { await ctx.reply('⏳ Placing sell order...'); }

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply('❌ User not found.'); return; }

    try {
      const result = await executePositionOrder(user, state.assetId, state.conditionId, state.negRisk, 'sell', state.price, state.size);

      // Invalidate caches so next positions view is fresh
      positionListCache.delete(telegramId);
      try {
        const { invalidatePortfolioCache } = await import('../../services/portfolio');
        await invalidatePortfolioCache(user.encryptedPrivateKey);
      } catch {}

      const msg =
        `✅ *Sell Executed!*\n\n` +
        `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
        `📉 Shares: *${state.size.toFixed(4)}*\n` +
        `💰 Min price: *${(state.price * 100).toFixed(2)}¢*\n` +
        `💵 Est. proceeds: *$${(state.size * state.price).toFixed(2)}*\n` +
        `🆔 Order: \`${result.orderID}\`\n\n` +
        `_Market sell executed — your position has been closed or reduced._`;

      const doneKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📊 My Positions', 'portfolio_open_1')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]);
      try {
        await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...doneKeyboard });
      } catch {
        await ctx.reply(msg, { parse_mode: 'Markdown', ...doneKeyboard });
      }
    } catch (err: any) {
      const errKeyboard = Markup.inlineKeyboard([[Markup.button.callback('« Back', 'portfolio_open_1')]]);
      try {
        await ctx.editMessageText(`❌ *Sell Failed*\n\n${err.message || 'Unknown error'}`, { parse_mode: 'Markdown', ...errKeyboard });
      } catch {
        await ctx.reply(`❌ *Sell Failed*\n\n${err.message || 'Unknown error'}`, { parse_mode: 'Markdown', ...errKeyboard });
      }
    }
  } catch (error) {
    logger.error('Error executing sell:', error);
  }
}

// ─── Execute buy ───────────────────────────────────────────────────────────

export async function handlePositionExecuteBuy(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const state = positionTradeState.get(telegramId);
    if (!state || state.price === undefined || state.size === undefined) {
      await ctx.reply('❌ Session expired. Please start again.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'portfolio_open_1')]]),
      });
      return;
    }
    positionTradeState.delete(telegramId);

    try { await ctx.editMessageText('⏳ Placing buy order...'); } catch { await ctx.reply('⏳ Placing buy order...'); }

    const user = await getUserByTelegramId(telegramId);
    if (!user) { await ctx.reply('❌ User not found.'); return; }

    try {
      const result = await executePositionOrder(user, state.assetId, state.conditionId, state.negRisk, 'buy', state.price, state.size);

      // Invalidate caches so next positions view is fresh
      positionListCache.delete(telegramId);
      try {
        const { invalidatePortfolioCache } = await import('../../services/portfolio');
        await invalidatePortfolioCache(user.encryptedPrivateKey);
      } catch {}

      const usdAmount = state.size * state.price;
      const msg =
        `✅ *Buy Order Placed!*\n\n` +
        `*${state.outcome}* — ${truncate(state.title, 50)}\n\n` +
        `📈 Shares: *~${state.size.toFixed(4)}*\n` +
        `💰 Price: *${(state.price * 100).toFixed(2)}¢*\n` +
        `💵 USDC: *$${usdAmount.toFixed(2)}*\n` +
        `🆔 Order: \`${result.orderID}\`\n\n` +
        `_Order will be filled when matched._`;

      const doneKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📊 My Positions', 'portfolio_open_1')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]);
      try {
        await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...doneKeyboard });
      } catch {
        await ctx.reply(msg, { parse_mode: 'Markdown', ...doneKeyboard });
      }
    } catch (err: any) {
      const errKeyboard = Markup.inlineKeyboard([[Markup.button.callback('« Back', 'portfolio_open_1')]]);
      try {
        await ctx.editMessageText(`❌ *Buy Failed*\n\n${err.message || 'Unknown error'}`, { parse_mode: 'Markdown', ...errKeyboard });
      } catch {
        await ctx.reply(`❌ *Buy Failed*\n\n${err.message || 'Unknown error'}`, { parse_mode: 'Markdown', ...errKeyboard });
      }
    }
  } catch (error) {
    logger.error('Error executing buy:', error);
  }
}

// ─── Core CLOB order ───────────────────────────────────────────────────────

async function executePositionOrder(
  user: any,
  assetId: string,
  conditionId: string,
  negRisk: boolean,
  action: 'buy' | 'sell',
  price: number,
  size: number
): Promise<{ orderID: string }> {
  // Ensure CTF approvals are set on proxy wallet before placing any order
  const { enableTrading } = await import('../../services/deposit');
  const enableResult = await enableTrading(user.encryptedPrivateKey, user.polymarketProxyAddress);
  if (!enableResult.success) {
    throw new Error('Failed to set trading approvals on proxy wallet');
  }
  logger.info(`[positionTrade] Approvals ready (${enableResult.alreadyEnabled ? 'already set' : 'just set'})`);

  const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client');
  const { Wallet } = await import('@ethersproject/wallet');
  const { config } = await import('../../config');

  const privateKey = decrypt(user.encryptedPrivateKey);
  const apiKey = decrypt(user.encryptedApiKey);
  const apiSecret = decrypt(user.encryptedApiSecret);
  const passphrase = decrypt(user.encryptedPassphrase);

  const wallet = new Wallet(privateKey);

  const clobClient = new ClobClient(
    config.polymarket.host,
    config.polymarket.chainId,
    wallet,
    { key: apiKey, secret: apiSecret, passphrase: passphrase },
    2,
    user.polymarketProxyAddress
  );

  // Fetch tick size from CLOB for accurate order signing
  let tickSize: string | undefined;
  try {
    const market = await clobClient.getMarket(conditionId);
    if (market && (market as any).minimum_tick_size) {
      tickSize = String((market as any).minimum_tick_size);
    }
  } catch (e) {
    logger.warn('[positionTrade] Could not fetch tick size, using SDK default');
  }

  const orderOptions: any = {};
  if (tickSize) orderOptions.tickSize = tickSize;
  if (negRisk) orderOptions.negRisk = true;

  // For SELL orders: verify on-chain that the proxy actually holds the tokens,
  // then refresh the CLOB's cached view. The previous approach using
  // updateBalanceAllowance(CONDITIONAL) may refresh the EOA balance (0) instead
  // of the proxy's balance when the API key has not been explicitly linked to the
  // proxy via a prior GNOSIS_SAFE order. We call it AFTER verifying on-chain so
  // we know the tokens really exist before asking the CLOB to re-read.
  if (action === 'sell') {
    const { Contract, providers: ethersProviders } = await import('ethers');
    const CTF_CONTRACT_ADDR = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
    const NEG_RISK_EXCHANGE_ADDR = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
    const CTF_ABI_MIN = [
      'function balanceOf(address account, uint256 id) view returns (uint256)',
      'function isApprovedForAll(address owner, address operator) view returns (bool)',
    ];
    const rpcProvider = new ethersProviders.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
    const ctfOnChain = new Contract(CTF_CONTRACT_ADDR, CTF_ABI_MIN, rpcProvider);

    // Check on-chain token balance
    const onChainBalance = await ctfOnChain.balanceOf(user.polymarketProxyAddress, assetId);
    const requiredUnits = Math.round(size * 1e6);
    logger.info(`[positionTrade] On-chain token balance: ${onChainBalance.toString()} units (need ${requiredUnits})`);

    if (onChainBalance.lt(requiredUnits)) {
      throw new Error(
        `Proxy wallet has insufficient conditional tokens on-chain: ` +
        `holds ${onChainBalance.toString()} units, order needs ${requiredUnits} units (${size} shares).`
      );
    }

    // Check NegRisk CTF Exchange approval on-chain
    const isNegRiskApproved = await ctfOnChain.isApprovedForAll(user.polymarketProxyAddress, NEG_RISK_EXCHANGE_ADDR);
    logger.info(`[positionTrade] On-chain NegRisk approval: ${isNegRiskApproved}`);

    if (!isNegRiskApproved) {
      logger.warn('[positionTrade] NegRisk approval missing on-chain — setting now...');
      const { enableTrading } = await import('../../services/deposit');
      const approvalResult = await enableTrading(user.encryptedPrivateKey, user.polymarketProxyAddress);
      if (!approvalResult.success) {
        throw new Error('Failed to set NegRisk CTF Exchange approval on proxy wallet');
      }
      logger.info('[positionTrade] NegRisk approval set successfully');
    }

    // Refresh CLOB's cached view of the proxy's conditional token balance.
    // With signature_type=2 in the query, the CLOB server uses the proxy as funder.
    try {
      await clobClient.updateBalanceAllowance({
        asset_type: 'CONDITIONAL' as any,
        token_id: assetId,
      });
      logger.info(`[positionTrade] CLOB balance cache refreshed for token ${assetId.substring(0, 16)}...`);
    } catch (e) {
      logger.warn('[positionTrade] Could not refresh CLOB balance cache (non-fatal):', e);
    }

    const tick = tickSize ? parseFloat(tickSize) : 0.01;
    const decimals = tickSize?.includes('.') ? tickSize.split('.')[1].length : 2;

    // Step 1: Fetch order book — find the lowest bid level needed to fill the full order.
    // This avoids blind slippage and sets an accurate floor based on real liquidity.
    let smartFloor = tick; // fallback: accept any price

    try {
      const book = await clobClient.getOrderBook(assetId);
      if (book.bids && book.bids.length > 0) {
        // bids are sorted best (highest) to worst (lowest)
        let remaining = size;
        let lastBidPrice = parseFloat(book.bids[0].price);

        for (const bid of book.bids) {
          const bidPrice = parseFloat(bid.price);
          const bidSize  = parseFloat(bid.size);
          remaining    -= bidSize;
          lastBidPrice  = bidPrice;
          if (remaining <= 0) break; // enough liquidity found at this level
        }

        // Snap to tick
        const snapped = parseFloat((Math.floor(lastBidPrice / tick) * tick).toFixed(decimals));
        smartFloor = Math.max(snapped, tick);

        logger.info(
          `[positionTrade] Order book — best_bid: ${(parseFloat(book.bids[0].price) * 100).toFixed(2)}¢` +
          `, smart_floor: ${(smartFloor * 100).toFixed(2)}¢` +
          ` (${book.bids.length} bid levels, need ${size} shares)`
        );
      } else {
        logger.warn('[positionTrade] No bids in order book — using 1-tick floor');
      }
    } catch (bookErr: any) {
      logger.warn('[positionTrade] Could not fetch order book (using 1-tick floor):', bookErr?.message || bookErr);
    }

    // Step 2: Place FAK with smart floor. If market moved between fetch and placement,
    // retry once with 1-tick floor (accept any available price).
    const floorsToTry = smartFloor > tick ? [smartFloor, tick] : [tick];

    let sellOrderResponse: any;
    let lastErrMsg = '';

    for (const floorPrice of floorsToTry) {
      logger.info(
        `[positionTrade] FAK sell: ${size} shares floor=${(floorPrice * 100).toFixed(2)}¢ negRisk=${negRisk}`
      );

      sellOrderResponse = await clobClient.createAndPostMarketOrder(
        { tokenID: assetId, side: Side.SELL, amount: size, price: floorPrice, feeRateBps: 0 },
        Object.keys(orderOptions).length > 0 ? orderOptions : undefined,
        OrderType.FAK
      );

      if (sellOrderResponse.success && sellOrderResponse.orderID) {
        price = floorPrice; // update for commission calculation below
        break;
      }

      lastErrMsg = sellOrderResponse.errorMsg || (sellOrderResponse as any).error || 'Sell order not filled';
      logger.warn(`[positionTrade] FAK sell rejected at ${(floorPrice * 100).toFixed(2)}¢: ${lastErrMsg}`);

      // Only retry on liquidity errors
      if (!lastErrMsg.includes('no orders found') && !lastErrMsg.includes('FAK') && !lastErrMsg.includes('FOK')) break;
    }

    if (!sellOrderResponse.success || !sellOrderResponse.orderID) {
      if (lastErrMsg.includes('no orders found') || lastErrMsg.includes('FAK') || lastErrMsg.includes('FOK')) {
        throw new Error('No buy orders in the order book. The market is currently illiquid — try again later.');
      }
      if (lastErrMsg.includes('balance') || lastErrMsg.includes('allowance')) {
        throw new Error('Insufficient token balance or allowance. Your on-chain balance may have changed.');
      }
      throw new Error(lastErrMsg);
    }

    // Transfer 1% commission from estimated sell proceeds (fire-and-forget on failure)
    try {
      const commissionUsdc = price * size * COMMISSION_RATE;
      await transferCommission(user.encryptedPrivateKey, user.polymarketProxyAddress!, commissionUsdc, user.id);
    } catch (feeErr) {
      logger.warn('[positionTrade] Commission transfer after sell failed (non-fatal):', feeErr);
    }

    return { orderID: sellOrderResponse.orderID };
  }

  // BUY: FAK market order — fills immediately up to worstPrice
  // Snap price to tick size first (same as GTC, needed for valid price)
  if (tickSize) {
    const tick = parseFloat(tickSize);
    const decimals = tickSize.includes('.') ? tickSize.split('.')[1].length : 2;
    price = parseFloat((Math.round(price / tick) * tick).toFixed(decimals));
    price = Math.min(Math.max(price, tick), 0.99);
  }

  // amount = USD to spend = tradeAmount (size * price, after commission deduction)
  const buyAmount = parseFloat((size * price).toFixed(6));

  logger.info(`[positionTrade] Creating FAK buy order: ~${size} shares at max ${(price * 100).toFixed(2)}¢ amount=$${buyAmount} negRisk=${negRisk} tickSize=${tickSize || 'default'}`);

  const buyOrderResponse = await clobClient.createAndPostMarketOrder(
    { tokenID: assetId, side: Side.BUY, amount: buyAmount, price, feeRateBps: 0 } as any,
    Object.keys(orderOptions).length > 0 ? orderOptions : undefined,
    OrderType.FAK
  );

  if (!buyOrderResponse.success || !buyOrderResponse.orderID) {
    const errMsg = buyOrderResponse.errorMsg || (buyOrderResponse as any).error || 'Buy order placement failed';
    logger.error(`[positionTrade] GTC buy rejected: ${errMsg}`);
    throw new Error(errMsg);
  }

  // Transfer 1% commission after successful order (fire-and-forget)
  const buyCommissionUsdc = price * size * COMMISSION_RATE;
  transferCommission(user.encryptedPrivateKey, user.polymarketProxyAddress!, buyCommissionUsdc, user.id)
    .catch((feeErr) => {
      logger.warn('[positionTrade] Commission transfer after buy failed (non-fatal):', feeErr);
    });

  return { orderID: buyOrderResponse.orderID };
}
