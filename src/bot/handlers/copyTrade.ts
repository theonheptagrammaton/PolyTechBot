import { Context, Markup } from 'telegraf';
import { prisma } from '../../database/prisma';
import { logger } from '../../utils/logger';
import { parseTraderAddress } from '../../services/copyTrade';
import { getUserByTelegramId } from '../../services/user';
import { sendPage } from '../../utils/telegram';
import { esc } from '../../utils/customEmoji';
import { config } from '../../config';
import { RedisBackedState } from '../../utils/redisState';

// ─── Constants ──────────────────────────────────────────────────────────────────

const MAX_TASKS = 50;
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isExpired(ts: number): boolean {
  return Date.now() - ts > STATE_TTL_MS;
}

// ─── Add State (9-step flow) ────────────────────────────────────────────────────

interface CopyAddState {
  step: 'address' | 'name' | 'buy_method' | 'buy_amount'
      | 'max_per_market' | 'slippage' | 'slippage_custom'
      | 'odds_filter' | 'odds_custom_min' | 'odds_custom_max'
      | 'stop_loss' | 'sl_pct' | 'sl_fixed'
      | 'take_profit' | 'tp_pct' | 'tp_fixed'
      | 'trade_behavior' | 'review';
  address?: string;
  name?: string;
  buyMethod?: 'fixed' | 'exact' | 'percentage' | 'portfolio';
  amount?: number;
  maxPerMarket?: number | null;
  slippage?: number;
  priceMin?: number | null;
  priceMax?: number | null;
  stopLossPct?: number | null;
  stopLossFixed?: number | null;
  takeProfitPct?: number | null;
  takeProfitFixed?: number | null;
  tradeBehavior?: 'buys_only' | 'buys_sells' | 'counter';
  timestamp: number;
}

export const copyAddState = new RedisBackedState<CopyAddState>('copyAdd', 600);

setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, state] of copyAddState.entries()) {
    if (state.timestamp < cutoff) copyAddState.delete(key);
  }
}, 30 * 60 * 1000);

// ─── Edit State (manage page inline edits) ──────────────────────────────────────

interface CopyEditState {
  step: 'awaiting_amount' | 'awaiting_rename' | 'awaiting_slippage'
      | 'awaiting_max_buy' | 'awaiting_min_buy'
      | 'awaiting_max_spend_market' | 'awaiting_max_spend_total'
      | 'awaiting_daily_limit' | 'awaiting_single_limit'
      | 'awaiting_min_trigger' | 'awaiting_max_trigger'
      | 'awaiting_max_days' | 'awaiting_min_liq' | 'awaiting_min_vol'
      | 'awaiting_price_min' | 'awaiting_price_max'
      | 'awaiting_sl_pct' | 'awaiting_sl_fixed'
      | 'awaiting_tp_pct' | 'awaiting_tp_fixed'
      | 'awaiting_categories';
  subId: string;
  timestamp: number;
}

export const copyEditState = new RedisBackedState<CopyEditState>('copyEdit', 600);

setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, state] of copyEditState.entries()) {
    if (state.timestamp < cutoff) copyEditState.delete(key);
  }
}, 30 * 60 * 1000);

// ─── Helpers ────────────────────────────────────────────────────────────────────

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmtVal(v: number | null | undefined, suffix = ''): string {
  if (v == null) return 'No limit';
  return `${v}${suffix}`;
}

function onOff(v: boolean): string {
  return v ? '🟢' : '🔴';
}

function backCancelRow(): any[] {
  return [
    Markup.button.callback('← Back', 'copy_add_back'),
    Markup.button.callback('❌ Cancel', 'copy_cancel'),
  ];
}

// ─── /copy command ──────────────────────────────────────────────────────────────

export async function handleCopyCommand(ctx: Context, arg?: string): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const sub = arg?.trim().toLowerCase();

  if (!sub || sub === 'list') { await handleCopyList(ctx); return; }
  if (sub === 'add')          { await startCopyAdd(ctx);   return; }
  if (sub === 'stopall')      { await handleCopyStopAll(ctx); return; }

  // /copy add <address>
  if (sub.startsWith('add ')) {
    const result = parseTraderAddress(sub.slice(4).trim());
    if ('error' in result) {
      await ctx.reply(result.error, { parse_mode: 'HTML' });
      return;
    }
    await handleSmartCopyStart(ctx, result.address);
    return;
  }

  if (sub.startsWith('stop ')) {
    const result = parseTraderAddress(sub.slice(5).trim());
    if ('error' in result) { await ctx.reply(result.error, { parse_mode: 'HTML' }); return; }
    await handleCopyStopSingle(ctx, result.address);
    return;
  }

  if (sub.startsWith('history')) {
    const parts = sub.split(/\s+/);
    const n = parseInt(parts[1] ?? '10', 10);
    await handleCopyHistory(ctx, isNaN(n) ? 10 : n);
    return;
  }

  await handleCopyList(ctx);
}

// ─── List Page ──────────────────────────────────────────────────────────────────

export async function handleCopyList(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  copyEditState.delete(telegramId);
  copyAddState.delete(telegramId);

  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.reply('❌ User not found. Use /start first.'); return; }

  const subs = await prisma.copySubscription.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });

  const lines: string[] = [
    `⚡ <b>Copy Trade</b>`,
    ``,
    `Automatically copy trades from top Polymarket traders.`,
    ``,
  ];

  if (subs.length === 0) {
    lines.push(`You have no tasks yet. Tap <b>Add Task</b> to get started.`);
  } else {
    const running = subs.filter(s => s.isActive && !s.isPaused).length;
    lines.push(`💡 <b>Your Tasks (${subs.length}/${MAX_TASKS})</b>`);
    lines.push(``);

    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      const statusEmoji = s.isActive && !s.isPaused ? '🟢' : '🔴';
      const displayName = s.label || shortAddr(s.traderAddress);
      const amountLabel = s.buyMethod === 'exact' ? 'Exact Copy'
        : s.buyMethod === 'percentage' ? `${(s.multiplier ?? 1) * 100}%`
        : s.buyMethod === 'portfolio' ? 'Portfolio'
        : `${(s.fixedAmount ?? 25).toFixed(2)} USDC`;
      lines.push(`${i + 1}. ${statusEmoji} ${esc(displayName)} – ${amountLabel}`);
    }

    lines.push(``);
    if (running === 0) {
      lines.push(`⚡ Status: All tasks stopped.`);
    } else {
      lines.push(`⚡ Status: ${running} running`);
    }
  }

  // Build buttons
  const buttons: any[][] = [];

  // Row 1: Add / Remove
  buttons.push([
    Markup.button.callback('➕ Add Task', 'copy_start_add'),
    Markup.button.callback('🗑 Remove Task', 'copy_remove_prompt'),
  ]);

  // Per-task buttons (show first 8 tasks max to avoid button overflow)
  const taskButtons = subs.slice(0, 8).map((s, i) => {
    const label = s.label ? `${i + 1}. ${s.label.slice(0, 12)}` : `${i + 1}. ${shortAddr(s.traderAddress)}`;
    return Markup.button.callback(label, `copy_task_${s.id}`);
  });
  // Group task buttons into rows of 2
  for (let i = 0; i < taskButtons.length; i += 2) {
    buttons.push(taskButtons.slice(i, i + 2));
  }

  // Start All / Stop All
  buttons.push([
    Markup.button.callback('▶️ Start All', 'copy_start_all'),
    Markup.button.callback('⏹ Stop All', 'copy_stop_all'),
  ]);

  // Activity / Delete All
  buttons.push([
    Markup.button.callback('📜 Activity', 'copy_history_10'),
    Markup.button.callback('🗑 Delete All', 'copy_delete_all_confirm'),
  ]);

  // Back / Close
  buttons.push([
    Markup.button.callback('← Back', 'back_to_menu'),
    Markup.button.callback('× Close', 'copy_close'),
  ]);

  await sendPage(ctx, lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
}

// ─── 9-Step Add Flow ────────────────────────────────────────────────────────────

export async function startCopyAdd(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.reply('❌ User not found.'); return; }

  // Check limit
  const count = await prisma.copySubscription.count({ where: { userId: user.id } });
  if (count >= MAX_TASKS) {
    await ctx.reply(`❌ You've reached the maximum of ${MAX_TASKS} tasks. Remove one first.`);
    return;
  }

  copyAddState.set(telegramId, { step: 'address', timestamp: Date.now() });

  await sendPage(ctx,
    `📋 <b>Step 1/9 — Who to Copy</b>\n\n` +
    `Send the wallet address or Polymarket profile URL of the trader you want to copy.\n\n` +
    `<i>Send /cancel to cancel.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'copy_cancel')],
      ]),
    }
  );
}

// Smart copy: pre-fill address from Discover Traders page
export async function handleSmartCopyStart(ctx: Context, address: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.reply('❌ User not found.'); return; }

  // Check duplicate
  const existing = await prisma.copySubscription.findUnique({
    where: { userId_traderAddress: { userId: user.id, traderAddress: address } },
  });
  if (existing) {
    await ctx.reply('⚠️ You are already copying this trader. Use the manage page to edit settings.');
    return;
  }

  copyAddState.set(telegramId, {
    step: 'name',
    address,
    timestamp: Date.now(),
  });

  await sendAddStepName(ctx, address);
}

async function sendAddStepName(ctx: Context, address: string): Promise<void> {
  await sendPage(ctx,
    `📋 <b>Step 2/9 — Name Your Task</b>\n\n` +
    `Trader: <code>${shortAddr(address)}</code>\n\n` +
    `Give this task a name (1–24 characters).`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([backCancelRow()]),
    }
  );
}

async function sendAddStepBuyMethod(ctx: Context): Promise<void> {
  await sendPage(ctx,
    `📋 <b>Step 3/9 — Buy Method</b>\n\n` +
    `How should the bot determine how much to spend per trade?\n\n` +
    `💵 <b>Fixed</b> — Same $ amount every trade\n` +
    `📋 <b>Exact Copy</b> — Copy the exact $ amount the leader spends\n` +
    `📊 <b>Percentage</b> — A percentage/multiplier of the leader's amount\n` +
    `⚖️ <b>Portfolio</b> — Weighted based on your portfolio`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('💵 Fixed', 'copy_add_method_fixed'),
          Markup.button.callback('📋 Exact', 'copy_add_method_exact'),
        ],
        [
          Markup.button.callback('📊 Percentage', 'copy_add_method_pct'),
          Markup.button.callback('⚖️ Portfolio', 'copy_add_method_portfolio'),
        ],
        backCancelRow(),
      ]),
    }
  );
}

async function sendAddStepBuyAmount(ctx: Context, method: string): Promise<void> {
  const prompt = method === 'fixed'
    ? `Enter the <b>fixed USD amount</b> per trade (e.g. 25):`
    : method === 'percentage'
    ? `Enter the <b>multiplier</b> of the leader's trade size (e.g. 1.0 = 100%, 0.5 = 50%):`
    : `Enter the <b>portfolio weight multiplier</b> (e.g. 1.0):`;

  await sendPage(ctx,
    `📋 <b>Step 3b — Enter Amount</b>\n\n${prompt}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([backCancelRow()]),
    }
  );
}

async function sendAddStepMaxPerMarket(ctx: Context): Promise<void> {
  await sendPage(ctx,
    `📋 <b>Step 4/9 — Max Spend Per Market</b>\n\n` +
    `Set the maximum total USD to spend on a single market condition.\n\n` +
    `Enter an amount (e.g. 100) or tap Skip for no limit.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⏭ Skip', 'copy_add_skip_max_market')],
        backCancelRow(),
      ]),
    }
  );
}

async function sendAddStepSlippage(ctx: Context): Promise<void> {
  await sendPage(ctx,
    `📋 <b>Step 5/9 — Slippage Tolerance</b>\n\n` +
    `How much price slippage should be allowed when placing orders?\n\n` +
    `Higher slippage = more likely to fill, but worse price.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Default 5%', 'copy_add_slip_5'),
          Markup.button.callback('📉 Low 2%', 'copy_add_slip_2'),
        ],
        [
          Markup.button.callback('📈 High 10%', 'copy_add_slip_10'),
          Markup.button.callback('🔧 Custom', 'copy_add_slip_custom'),
        ],
        backCancelRow(),
      ]),
    }
  );
}

async function sendAddStepOddsFilter(ctx: Context): Promise<void> {
  await sendPage(ctx,
    `📋 <b>Step 6/9 — Odds Filter</b>\n\n` +
    `Only copy trades within a certain price range.\n\n` +
    `This helps you avoid copying trades at extreme prices (very cheap or very expensive).`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🎯 10¢–90¢', 'copy_add_odds_10_90'),
          Markup.button.callback('🎯 20¢–80¢', 'copy_add_odds_20_80'),
        ],
        [
          Markup.button.callback('🔧 Custom', 'copy_add_odds_custom'),
          Markup.button.callback('⏭ Skip', 'copy_add_odds_skip'),
        ],
        backCancelRow(),
      ]),
    }
  );
}

async function sendAddStepStopLoss(ctx: Context): Promise<void> {
  await sendPage(ctx,
    `📋 <b>Step 7/9 — Stop Loss</b>\n\n` +
    `Automatically sell if a position drops in value.\n\n` +
    `📉 <b>Percentage</b> — Sell if position drops X% from entry\n` +
    `💲 <b>Fixed Price</b> — Sell if price drops to X¢`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📉 Percentage', 'copy_add_sl_pct'),
          Markup.button.callback('💲 Fixed Price', 'copy_add_sl_fixed'),
        ],
        [Markup.button.callback('⏭ Skip', 'copy_add_sl_skip')],
        backCancelRow(),
      ]),
    }
  );
}

async function sendAddStepTakeProfit(ctx: Context): Promise<void> {
  await sendPage(ctx,
    `📋 <b>Step 8/9 — Take Profit</b>\n\n` +
    `Automatically sell when a position gains value.\n\n` +
    `📈 <b>Percentage</b> — Sell if position gains X% from entry\n` +
    `💲 <b>Fixed Price</b> — Sell if price rises to X¢`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📈 Percentage', 'copy_add_tp_pct'),
          Markup.button.callback('💲 Fixed Price', 'copy_add_tp_fixed'),
        ],
        [Markup.button.callback('⏭ Skip', 'copy_add_tp_skip')],
        backCancelRow(),
      ]),
    }
  );
}

async function sendAddStepTradeBehavior(ctx: Context): Promise<void> {
  await sendPage(ctx,
    `📋 <b>Step 9/9 — Trade Behavior</b>\n\n` +
    `How should the bot handle the leader's trades?\n\n` +
    `🟢 <b>Buys Only</b> — Only copy BUY trades\n` +
    `🔄 <b>Buys + Sells</b> — Copy both BUYs and SELLs\n` +
    `🔀 <b>Counter Trade</b> — Take the opposite side of every trade`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🟢 Buys Only', 'copy_add_behavior_buys')],
        [Markup.button.callback('🔄 Buys + Sells', 'copy_add_behavior_both')],
        [Markup.button.callback('🔀 Counter Trade', 'copy_add_behavior_counter')],
        backCancelRow(),
      ]),
    }
  );
}

async function sendAddReview(ctx: Context, state: CopyAddState): Promise<void> {
  const methodLabels: Record<string, string> = {
    fixed: '💵 Fixed',
    exact: '📋 Exact Copy',
    percentage: '📊 Percentage',
    portfolio: '⚖️ Portfolio',
  };
  const behaviorLabels: Record<string, string> = {
    buys_only: '🟢 Buys Only',
    buys_sells: '🔄 Buys + Sells',
    counter: '🔀 Counter Trade',
  };

  const amountLine = state.buyMethod === 'exact'
    ? 'Exact copy of leader'
    : state.buyMethod === 'portfolio'
    ? `Portfolio weighted ×${(state.amount ?? 1).toFixed(2)}`
    : state.buyMethod === 'percentage'
    ? `×${(state.amount ?? 1).toFixed(2)} of leader`
    : `$${(state.amount ?? 25).toFixed(2)} per trade`;

  const priceRange = state.priceMin != null || state.priceMax != null
    ? `${state.priceMin ?? 0}¢ – ${state.priceMax ?? 100}¢`
    : 'No filter';

  const slLine = state.stopLossPct != null
    ? `📉 ${state.stopLossPct}%`
    : state.stopLossFixed != null
    ? `📉 ${state.stopLossFixed}¢`
    : 'Off';

  const tpLine = state.takeProfitPct != null
    ? `📈 ${state.takeProfitPct}%`
    : state.takeProfitFixed != null
    ? `📈 ${state.takeProfitFixed}¢`
    : 'Off';

  const profileUrl = `https://polymarket.com/profile/${state.address}`;

  const text = [
    `📋 <b>Review Your Copy Trade</b>`,
    ``,
    `━━━━━━━━━━━━━━━━━━━`,
    `👤 <b>Task Name:</b> ${esc(state.name || 'Unnamed')}`,
    `📍 <b>Trader:</b> <code>${shortAddr(state.address!)}</code>`,
    `🔗 <a href="${profileUrl}">View Profile</a>`,
    `━━━━━━━━━━━━━━━━━━━`,
    `💰 <b>Method:</b> ${methodLabels[state.buyMethod || 'fixed']}`,
    `💵 <b>Amount:</b> ${amountLine}`,
    `💸 <b>Max/Market:</b> ${fmtVal(state.maxPerMarket)}`,
    `⚡ <b>Slippage:</b> ${state.slippage ?? 5}%`,
    `🎯 <b>Price Range:</b> ${priceRange}`,
    `🔻 <b>Stop Loss:</b> ${slLine}`,
    `🔺 <b>Take Profit:</b> ${tpLine}`,
    `📊 <b>Behavior:</b> ${behaviorLabels[state.tradeBehavior || 'buys_only']}`,
    `━━━━━━━━━━━━━━━━━━━`,
    ``,
    `⏸ <i>Paused — start it from the task settings after creation.</i>`,
  ].join('\n');

  await sendPage(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm & Create', 'copy_confirm_add')],
      [
        Markup.button.callback('← Back', 'copy_add_back'),
        Markup.button.callback('🔄 Start Over', 'copy_start_add'),
        Markup.button.callback('❌ Cancel', 'copy_cancel'),
      ],
    ]),
  });
}

// ─── Add Flow: Button Handlers ──────────────────────────────────────────────────

// Buy Method selections
export async function handleAddMethodFixed(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  state.buyMethod = 'fixed';
  state.step = 'buy_amount';
  state.timestamp = Date.now();
  await sendAddStepBuyAmount(ctx, 'fixed');
}

export async function handleAddMethodExact(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  state.buyMethod = 'exact';
  state.amount = 1; // multiplier = 1.0 for exact copy
  state.step = 'max_per_market';
  state.timestamp = Date.now();
  await sendAddStepMaxPerMarket(ctx);
}

export async function handleAddMethodPct(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  state.buyMethod = 'percentage';
  state.step = 'buy_amount';
  state.timestamp = Date.now();
  await sendAddStepBuyAmount(ctx, 'percentage');
}

export async function handleAddMethodPortfolio(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  state.buyMethod = 'portfolio';
  state.step = 'buy_amount';
  state.timestamp = Date.now();
  await sendAddStepBuyAmount(ctx, 'portfolio');
}

// Slippage presets
export async function handleAddSlippage(ctx: Context, pct: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  state.slippage = pct;
  state.step = 'odds_filter';
  state.timestamp = Date.now();
  await sendAddStepOddsFilter(ctx);
}

export async function handleAddSlippageCustom(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  state.step = 'slippage_custom';
  state.timestamp = Date.now();
  await sendPage(ctx,
    `📋 <b>Custom Slippage</b>\n\nEnter slippage percentage (0.1–50):`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([backCancelRow()]) }
  );
}

// Skip max per market
export async function handleAddSkipMaxMarket(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  state.maxPerMarket = null;
  state.step = 'slippage';
  state.timestamp = Date.now();
  await sendAddStepSlippage(ctx);
}

// Odds filter presets
export async function handleAddOddsPreset(ctx: Context, min: number, max: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  state.priceMin = min;
  state.priceMax = max;
  state.step = 'stop_loss';
  state.timestamp = Date.now();
  await sendAddStepStopLoss(ctx);
}

export async function handleAddOddsSkip(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  state.priceMin = null;
  state.priceMax = null;
  state.step = 'stop_loss';
  state.timestamp = Date.now();
  await sendAddStepStopLoss(ctx);
}

export async function handleAddOddsCustom(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  state.step = 'odds_custom_min';
  state.timestamp = Date.now();
  await sendPage(ctx,
    `📋 <b>Custom Odds Filter</b>\n\nEnter the <b>minimum</b> price in cents (e.g. 15):`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([backCancelRow()]) }
  );
}

// Stop loss type
export async function handleAddSlType(ctx: Context, type: 'pct' | 'fixed' | 'skip'): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  if (type === 'skip') {
    state.stopLossPct = null;
    state.stopLossFixed = null;
    state.step = 'take_profit';
    state.timestamp = Date.now();
    await sendAddStepTakeProfit(ctx);
    return;
  }

  state.step = type === 'pct' ? 'sl_pct' : 'sl_fixed';
  state.timestamp = Date.now();

  const prompt = type === 'pct'
    ? `Enter <b>stop loss percentage</b> (e.g. 30 for −30%):`
    : `Enter <b>stop loss price</b> in cents (e.g. 15 for 15¢):`;

  await sendPage(ctx, `📋 <b>Stop Loss</b>\n\n${prompt}`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([backCancelRow()]) }
  );
}

// Take profit type
export async function handleAddTpType(ctx: Context, type: 'pct' | 'fixed' | 'skip'): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  if (type === 'skip') {
    state.takeProfitPct = null;
    state.takeProfitFixed = null;
    state.step = 'trade_behavior';
    state.timestamp = Date.now();
    await sendAddStepTradeBehavior(ctx);
    return;
  }

  state.step = type === 'pct' ? 'tp_pct' : 'tp_fixed';
  state.timestamp = Date.now();

  const prompt = type === 'pct'
    ? `Enter <b>take profit percentage</b> (e.g. 50 for +50%):`
    : `Enter <b>take profit price</b> in cents (e.g. 85 for 85¢):`;

  await sendPage(ctx, `📋 <b>Take Profit</b>\n\n${prompt}`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([backCancelRow()]) }
  );
}

// Trade behavior
export async function handleAddBehavior(ctx: Context, behavior: 'buys_only' | 'buys_sells' | 'counter'): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  state.tradeBehavior = behavior;
  state.step = 'review';
  state.timestamp = Date.now();
  await sendAddReview(ctx, state);
}

// Back button
export async function handleAddBack(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const tid = ctx.from?.id.toString();
  if (!tid) return;
  const state = await copyAddState.get(tid);
  if (!state || isExpired(state.timestamp)) { copyAddState.delete(tid!); return; }

  state.timestamp = Date.now();

  // Navigate backward through the flow
  switch (state.step) {
    case 'name':
      state.step = 'address';
      await sendPage(ctx,
        `📋 <b>Step 1/9 — Who to Copy</b>\n\nSend the wallet address or Polymarket profile URL.\n\n<i>Send /cancel to cancel.</i>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'copy_cancel')]]) }
      );
      break;
    case 'buy_method':
      state.step = 'name';
      await sendAddStepName(ctx, state.address!);
      break;
    case 'buy_amount':
      state.step = 'buy_method';
      await sendAddStepBuyMethod(ctx);
      break;
    case 'max_per_market':
      if (state.buyMethod === 'exact') {
        state.step = 'buy_method';
        await sendAddStepBuyMethod(ctx);
      } else {
        state.step = 'buy_amount';
        await sendAddStepBuyAmount(ctx, state.buyMethod || 'fixed');
      }
      break;
    case 'slippage':
    case 'slippage_custom':
      state.step = 'max_per_market';
      await sendAddStepMaxPerMarket(ctx);
      break;
    case 'odds_filter':
    case 'odds_custom_min':
    case 'odds_custom_max':
      state.step = 'slippage';
      await sendAddStepSlippage(ctx);
      break;
    case 'stop_loss':
    case 'sl_pct':
    case 'sl_fixed':
      state.step = 'odds_filter';
      await sendAddStepOddsFilter(ctx);
      break;
    case 'take_profit':
    case 'tp_pct':
    case 'tp_fixed':
      state.step = 'stop_loss';
      await sendAddStepStopLoss(ctx);
      break;
    case 'trade_behavior':
      state.step = 'take_profit';
      await sendAddStepTakeProfit(ctx);
      break;
    case 'review':
      state.step = 'trade_behavior';
      await sendAddStepTradeBehavior(ctx);
      break;
    default:
      await handleCopyList(ctx);
  }
}

// ─── Add Flow: Text Input Handler ───────────────────────────────────────────────

export async function handleCopyAddInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;

  const state = await copyAddState.get(telegramId);
  if (!state) return false;
  if (isExpired(state.timestamp)) { copyAddState.delete(telegramId); return false; }

  // /cancel shortcut
  if (text.trim().toLowerCase() === '/cancel') {
    copyAddState.delete(telegramId);
    await ctx.reply('❌ Copy trade setup cancelled.');
    return true;
  }

  state.timestamp = Date.now();

  switch (state.step) {
    case 'address': {
      const result = parseTraderAddress(text);
      if ('error' in result) {
        await ctx.reply(result.error, { parse_mode: 'HTML' });
        return true;
      }
      const addr = result.address;
      // Check duplicate
      const user = await getUserByTelegramId(telegramId);
      if (user) {
        const existing = await prisma.copySubscription.findUnique({
          where: { userId_traderAddress: { userId: user.id, traderAddress: addr } },
        });
        if (existing) {
          await ctx.reply('⚠️ You are already copying this trader.');
          return true;
        }
      }
      state.address = addr;
      state.step = 'name';
      await sendAddStepName(ctx, addr);
      return true;
    }

    case 'name': {
      const name = text.trim();
      if (name.length < 1 || name.length > 24) {
        await ctx.reply('❌ Name must be 1–24 characters.');
        return true;
      }
      state.name = name;
      state.step = 'buy_method';
      await sendAddStepBuyMethod(ctx);
      return true;
    }

    case 'buy_amount': {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val <= 0) {
        await ctx.reply('❌ Please enter a valid positive number.');
        return true;
      }
      if (state.buyMethod === 'fixed' && val > 10000) {
        await ctx.reply('❌ Maximum fixed amount is $10,000.');
        return true;
      }
      if ((state.buyMethod === 'percentage' || state.buyMethod === 'portfolio') && val > 10) {
        await ctx.reply('❌ Maximum multiplier is 10.0.');
        return true;
      }
      state.amount = val;
      state.step = 'max_per_market';
      await sendAddStepMaxPerMarket(ctx);
      return true;
    }

    case 'max_per_market': {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val <= 0) {
        await ctx.reply('❌ Please enter a valid positive amount, or tap Skip.');
        return true;
      }
      state.maxPerMarket = val;
      state.step = 'slippage';
      await sendAddStepSlippage(ctx);
      return true;
    }

    case 'slippage_custom': {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val < 0.1 || val > 50) {
        await ctx.reply('❌ Slippage must be between 0.1% and 50%.');
        return true;
      }
      state.slippage = val;
      state.step = 'odds_filter';
      await sendAddStepOddsFilter(ctx);
      return true;
    }

    case 'odds_custom_min': {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val < 0 || val > 100) {
        await ctx.reply('❌ Enter a price between 0 and 100 cents.');
        return true;
      }
      state.priceMin = val;
      state.step = 'odds_custom_max';
      await sendPage(ctx,
        `📋 <b>Custom Odds Filter</b>\n\nMin: ${val}¢\n\nNow enter the <b>maximum</b> price in cents (e.g. 90):`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([backCancelRow()]) }
      );
      return true;
    }

    case 'odds_custom_max': {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val < 0 || val > 100) {
        await ctx.reply('❌ Enter a price between 0 and 100 cents.');
        return true;
      }
      if (state.priceMin != null && val <= state.priceMin) {
        await ctx.reply('❌ Max must be greater than min.');
        return true;
      }
      state.priceMax = val;
      state.step = 'stop_loss';
      await sendAddStepStopLoss(ctx);
      return true;
    }

    case 'sl_pct': {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val <= 0 || val > 100) {
        await ctx.reply('❌ Enter a percentage between 1 and 100.');
        return true;
      }
      state.stopLossPct = val;
      state.stopLossFixed = null;
      state.step = 'take_profit';
      await sendAddStepTakeProfit(ctx);
      return true;
    }

    case 'sl_fixed': {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val <= 0 || val > 99) {
        await ctx.reply('❌ Enter a price between 1 and 99 cents.');
        return true;
      }
      state.stopLossFixed = val;
      state.stopLossPct = null;
      state.step = 'take_profit';
      await sendAddStepTakeProfit(ctx);
      return true;
    }

    case 'tp_pct': {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val <= 0 || val > 1000) {
        await ctx.reply('❌ Enter a percentage between 1 and 1000.');
        return true;
      }
      state.takeProfitPct = val;
      state.takeProfitFixed = null;
      state.step = 'trade_behavior';
      await sendAddStepTradeBehavior(ctx);
      return true;
    }

    case 'tp_fixed': {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val <= 0 || val > 99) {
        await ctx.reply('❌ Enter a price between 1 and 99 cents.');
        return true;
      }
      state.takeProfitFixed = val;
      state.takeProfitPct = null;
      state.step = 'trade_behavior';
      await sendAddStepTradeBehavior(ctx);
      return true;
    }

    default:
      // Button-only steps: consume the text so it doesn't leak to keyword search
      await ctx.reply('⬆️ Please use the buttons above to continue.');
      return true;
  }
}

// ─── Confirm Add ────────────────────────────────────────────────────────────────

export async function handleCopyConfirmAdd(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const state = await copyAddState.get(telegramId);
  if (!state || state.step !== 'review' || !state.address) {
    await ctx.reply('❌ No pending copy trade to confirm.');
    return;
  }

  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.reply('❌ User not found.'); return; }

  // Check duplicate
  const existing = await prisma.copySubscription.findUnique({
    where: { userId_traderAddress: { userId: user.id, traderAddress: state.address } },
  });
  if (existing) {
    copyAddState.delete(telegramId);
    await ctx.reply('⚠️ You are already copying this trader.');
    return;
  }

  try {
    // Map state to DB fields
    const isFixed = state.buyMethod === 'fixed';

    const followBuys = state.tradeBehavior !== 'counter';
    const copySells = state.tradeBehavior === 'buys_sells';
    const counterTrade = state.tradeBehavior === 'counter';

    await prisma.copySubscription.create({
      data: {
        userId: user.id,
        traderAddress: state.address,
        label: state.name || null,
        buyMethod: state.buyMethod || 'fixed',
        fixedAmount: isFixed ? (state.amount ?? 25) : null,
        multiplier: (!isFixed) ? (state.amount ?? 1) : null,
        slippage: state.slippage ?? 5,
        priceMin: state.priceMin ?? null,
        priceMax: state.priceMax ?? null,
        maxSpendPerMarket: state.maxPerMarket ?? null,
        stopLossPct: state.stopLossPct ?? null,
        stopLossFixed: state.stopLossFixed ?? null,
        takeProfitPct: state.takeProfitPct ?? null,
        takeProfitFixed: state.takeProfitFixed ?? null,
        followBuys,
        copySells,
        counterTrade,
        isPaused: true,  // Start paused
        isActive: true,
      },
    });

    copyAddState.delete(telegramId);

    await sendPage(ctx,
      `✅ <b>Task Created!</b>\n\n` +
      `📝 ${esc(state.name || shortAddr(state.address))}\n` +
      `📍 <code>${shortAddr(state.address)}</code>\n\n` +
      `⏸ The task is <b>paused</b>. Go to task settings to start it.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ Task Settings', `copy_task_byaddr_${state.address}`)],
          [Markup.button.callback('← Back to List', 'copy_list')],
        ]),
      }
    );
  } catch (err: any) {
    logger.error(`[copy] Failed to create subscription: ${err?.message}`);
    await ctx.reply('❌ Failed to create copy trade. Please try again.');
  }
}

// ─── Cancel ─────────────────────────────────────────────────────────────────────

export async function handleCopyCancel(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  copyAddState.delete(telegramId);
  copyEditState.delete(telegramId);
  await handleCopyList(ctx);
}

// ─── Close (delete message) ─────────────────────────────────────────────────────

export async function handleCopyClose(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  try {
    await ctx.deleteMessage();
  } catch { /* ignore */ }
}

// ─── Start All / Stop All ───────────────────────────────────────────────────────

export async function handleCopyStartAll(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  await prisma.copySubscription.updateMany({
    where: { userId: user.id },
    data: { isActive: true, isPaused: false },
  });

  await ctx.answerCbQuery('▶️ All tasks started!').catch(() => {});
  await handleCopyList(ctx);
}

export async function handleCopyStopAllAction(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await handleCopyStopAll(ctx);
}

async function handleCopyStopAll(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  await prisma.copySubscription.updateMany({
    where: { userId: user.id },
    data: { isPaused: true },
  });

  await handleCopyList(ctx);
}

// ─── Stop Single ────────────────────────────────────────────────────────────────

async function handleCopyStopSingle(ctx: Context, traderAddress: string): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  await prisma.copySubscription.updateMany({
    where: { userId: user.id, traderAddress },
    data: { isPaused: true },
  });

  await handleCopyList(ctx);
}

// ─── Delete All ─────────────────────────────────────────────────────────────────

export async function handleCopyDeleteAllConfirm(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendPage(ctx,
    `🗑 <b>Delete All Tasks?</b>\n\nThis will permanently remove all your copy trade tasks. This cannot be undone.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Yes, Delete All', 'copy_delete_all_do')],
        [Markup.button.callback('← Cancel', 'copy_list')],
      ]),
    }
  );
}

export async function handleCopyDeleteAllExecute(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  await prisma.copySubscription.deleteMany({ where: { userId: user.id } });
  await handleCopyList(ctx);
}

// ─── Remove Task (choose which to remove) ───────────────────────────────────────

export async function handleCopyRemovePrompt(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const subs = await prisma.copySubscription.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });

  if (subs.length === 0) {
    await ctx.reply('No tasks to remove.');
    return;
  }

  const buttons = subs.map((s, i) => {
    const label = `${i + 1}. ${s.label || shortAddr(s.traderAddress)}`;
    return [Markup.button.callback(`🗑 ${label}`, `copy_remove_${s.id}`)];
  });
  buttons.push([Markup.button.callback('← Back', 'copy_list')]);

  await sendPage(ctx,
    `🗑 <b>Remove Task</b>\n\nSelect a task to remove:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
}

export async function handleCopyRemoveExecute(ctx: Context, subId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});

  try {
    await prisma.copySubscription.delete({ where: { id: subId } });
  } catch { /* ignore not found */ }

  await handleCopyList(ctx);
}

// ─── Task Settings / Manage Page ────────────────────────────────────────────────

export async function handleCopyTaskById(ctx: Context, subId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});

  const sub = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (!sub) { await ctx.reply('❌ Task not found.'); return; }

  await renderManagePage(ctx, sub);
}

export async function handleCopyTaskByAddr(ctx: Context, traderAddress: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const sub = await prisma.copySubscription.findUnique({
    where: { userId_traderAddress: { userId: user.id, traderAddress } },
  });
  if (!sub) { await ctx.reply('❌ Task not found.'); return; }

  await renderManagePage(ctx, sub);
}

async function renderManagePage(ctx: Context, sub: any): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (telegramId) copyEditState.delete(telegramId);

  const methodLabels: Record<string, string> = {
    fixed: 'Fixed', exact: 'Exact Copy', percentage: 'Percentage', portfolio: 'Portfolio Weighted',
  };

  const behaviorParts: string[] = [];
  if (sub.followBuys) behaviorParts.push('Follow Buys');
  if (sub.copySells) behaviorParts.push('Copy Sells');
  if (sub.buyOnSells) behaviorParts.push('Buy on Sells');
  if (sub.counterTrade) behaviorParts.push('Counter Trade');

  const amountStr = sub.buyMethod === 'exact' ? 'Exact copy'
    : sub.buyMethod === 'fixed' ? `$${(sub.fixedAmount ?? 25).toFixed(2)}`
    : `×${(sub.multiplier ?? 1).toFixed(2)}`;

  const copySideLabel = sub.copySide === 'yes' ? 'YES Only' : sub.copySide === 'no' ? 'NO Only' : 'Both Sides';

  const statusStr = sub.isPaused ? '⏸ Paused' : sub.isActive ? '▶️ Running' : '⏹ Stopped';

  const lines = [
    `⚙️ <b>Task Settings: ${esc(sub.label || shortAddr(sub.traderAddress))}</b>`,
    ``,
    `📍 <code>${sub.traderAddress}</code>`,
    `Status: ${statusStr}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━`,
    `💰 Copy Method: ${methodLabels[sub.buyMethod] || sub.buyMethod}`,
    `💵 Amount: ${amountStr}`,
    `📈 Max Buy: ${fmtVal(sub.singleTradeMax, ' USDC')}`,
    `📉 Min Buy: ${fmtVal(sub.minBuyAmount, ' USDC')}`,
    `💸 Max Spend/Market: ${fmtVal(sub.maxSpendPerMarket, ' USDC')}`,
    `💸 Max Spend Total: ${fmtVal(sub.maxSpendTotal, ' USDC')}`,
    `📅 Daily Spend: ${fmtVal(sub.dailySpendMax, ' USDC')}`,
    `⚡ Slippage: ${sub.slippage}%`,
    `⬇️ Min Trigger: ${sub.minTriggerPrice != null ? sub.minTriggerPrice + '¢' : 'Off'}`,
    `⬆️ Max Trigger: ${sub.maxTriggerPrice != null ? sub.maxTriggerPrice + '¢' : 'Off'}`,
    `📅 Max Days Out: ${sub.maxDaysOut != null ? sub.maxDaysOut + ' days' : 'Off'}`,
    `💧 Min Liq: ${sub.minLiquidity != null ? '$' + sub.minLiquidity : 'Off'}`,
    `📊 Min Vol: ${sub.minVolume != null ? '$' + sub.minVolume : 'Off'}`,
    `⬇️ Min Price: ${sub.priceMin != null ? sub.priceMin + '¢' : 'Off'}`,
    `⬆️ Max Price: ${sub.priceMax != null ? sub.priceMax + '¢' : 'Off'}`,
    `📁 Categories: ${sub.categories || 'All'}`,
    `🎯 Copy Side: ${copySideLabel}`,
    `🔻 Stop Loss: ${sub.stopLossPct != null ? sub.stopLossPct + '%' : sub.stopLossFixed != null ? sub.stopLossFixed + '¢' : 'Off'}`,
    `🔺 Take Profit: ${sub.takeProfitPct != null ? sub.takeProfitPct + '%' : sub.takeProfitFixed != null ? sub.takeProfitFixed + '¢' : 'Off'}`,
    `🔔 Notifications: ${sub.notificationsEnabled ? 'On' : 'Muted'}`,
    `━━━━━━━━━━━━━━━━━━━`,
  ];

  const id = sub.id;

  // Build toggle/edit buttons
  const buttons: any[][] = [];

  // Start/Stop toggle
  if (sub.isPaused) {
    buttons.push([Markup.button.callback('▶️ Start Task', `cpm_start_${id}`)]);
  } else {
    buttons.push([Markup.button.callback('⏸ Pause Task', `cpm_pause_${id}`)]);
  }

  // Buy method row
  buttons.push([
    Markup.button.callback(`${sub.buyMethod === 'fixed' ? '🟢' : '🔴'} Fixed`, `cpm_bm_fixed_${id}`),
    Markup.button.callback(`${sub.buyMethod === 'exact' ? '🟢' : '🔴'} Exact`, `cpm_bm_exact_${id}`),
  ]);
  buttons.push([
    Markup.button.callback(`${sub.buyMethod === 'percentage' ? '🟢' : '🔴'} %`, `cpm_bm_pct_${id}`),
    Markup.button.callback(`${sub.buyMethod === 'portfolio' ? '🟢' : '🔴'} Portfolio`, `cpm_bm_port_${id}`),
  ]);

  // Amount
  buttons.push([Markup.button.callback(`💰 Amount: ${amountStr}`, `cpm_amount_${id}`)]);

  // Max/Min buy
  buttons.push([
    Markup.button.callback(`📈 Max Buy: ${fmtVal(sub.singleTradeMax)}`, `cpm_maxbuy_${id}`),
    Markup.button.callback(`📉 Min Buy: ${fmtVal(sub.minBuyAmount)}`, `cpm_minbuy_${id}`),
  ]);

  // Max spend per market / total
  buttons.push([Markup.button.callback(`💸 Max Spend/Market: ${fmtVal(sub.maxSpendPerMarket)}`, `cpm_maxspm_${id}`)]);
  buttons.push([Markup.button.callback(`💸 Max Spend: ${fmtVal(sub.maxSpendTotal)}`, `cpm_maxspt_${id}`)]);

  // Daily spend
  buttons.push([Markup.button.callback(`📅 Daily Spend: ${fmtVal(sub.dailySpendMax)}`, `cpm_daily_${id}`)]);

  // Slippage
  buttons.push([Markup.button.callback(`⚡ Slippage: ${sub.slippage}%`, `cpm_slip_${id}`)]);

  // Trigger prices
  buttons.push([
    Markup.button.callback(`⬇️ Min Trigger: ${sub.minTriggerPrice != null ? sub.minTriggerPrice + '¢' : 'Off'}`, `cpm_mintrig_${id}`),
    Markup.button.callback(`⬆️ Max Trigger: ${sub.maxTriggerPrice != null ? sub.maxTriggerPrice + '¢' : 'Off'}`, `cpm_maxtrig_${id}`),
  ]);

  // Max days out
  buttons.push([Markup.button.callback(`📅 Max Days Out: ${sub.maxDaysOut != null ? sub.maxDaysOut : 'Off'}`, `cpm_maxdays_${id}`)]);

  // Min liquidity / volume
  buttons.push([
    Markup.button.callback(`💧 Min Liq: ${sub.minLiquidity != null ? '$' + sub.minLiquidity : 'Off'}`, `cpm_minliq_${id}`),
    Markup.button.callback(`📊 Min Vol: ${sub.minVolume != null ? '$' + sub.minVolume : 'Off'}`, `cpm_minvol_${id}`),
  ]);

  // Price range
  buttons.push([
    Markup.button.callback(`⬇️ Min Price: ${sub.priceMin != null ? sub.priceMin + '¢' : 'Off'}`, `cpm_prmin_${id}`),
    Markup.button.callback(`⬆️ Max Price: ${sub.priceMax != null ? sub.priceMax + '¢' : 'Off'}`, `cpm_prmax_${id}`),
  ]);

  // Categories
  buttons.push([Markup.button.callback(`📁 Categories: ${sub.categories || 'All'}`, `cpm_cats_${id}`)]);

  // Trade behavior toggles
  buttons.push([
    Markup.button.callback(`${onOff(sub.followBuys)} Follow Buys`, `cpm_tgl_buys_${id}`),
    Markup.button.callback(`${onOff(sub.copySells)} Copy Sells`, `cpm_tgl_sells_${id}`),
  ]);
  buttons.push([
    Markup.button.callback(`${onOff(sub.buyOnSells)} Buy on Sells`, `cpm_tgl_bos_${id}`),
    Markup.button.callback(`${onOff(sub.counterTrade)} Counter Trade`, `cpm_tgl_ct_${id}`),
  ]);

  // Limit mode
  buttons.push([Markup.button.callback(`${onOff(sub.limitMode)} Limit Mode`, `cpm_tgl_limit_${id}`)]);

  // Copy side
  buttons.push([Markup.button.callback(`🎯 Copy Side: ${copySideLabel}`, `cpm_copyside_${id}`)]);

  // TP/SL
  const slLabel = sub.stopLossPct != null ? `${sub.stopLossPct}%` : sub.stopLossFixed != null ? `${sub.stopLossFixed}¢` : 'Off';
  const tpLabel = sub.takeProfitPct != null ? `${sub.takeProfitPct}%` : sub.takeProfitFixed != null ? `${sub.takeProfitFixed}¢` : 'Off';
  buttons.push([
    Markup.button.callback(`🔻 Stop Loss: ${slLabel}`, `cpm_sl_${id}`),
    Markup.button.callback(`🔺 Take Profit: ${tpLabel}`, `cpm_tp_${id}`),
  ]);

  // Notifications
  buttons.push([Markup.button.callback(
    sub.notificationsEnabled ? '🔔 Mute Notifications' : '🔕 Unmute Notifications',
    `cpm_mute_${id}`
  )]);

  // Rename / Delete
  buttons.push([
    Markup.button.callback('✏️ Rename', `cpm_rename_${id}`),
    Markup.button.callback('🗑 Delete', `cpm_del_${id}`),
  ]);

  // Back / Close
  buttons.push([
    Markup.button.callback('← Back', 'copy_list'),
    Markup.button.callback('× Close', 'copy_close'),
  ]);

  await sendPage(ctx, lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
}

// ─── Manage Page: Toggle Actions ────────────────────────────────────────────────

export async function handleManageToggle(ctx: Context, subId: string, field: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});

  const sub = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (!sub) { await ctx.reply('❌ Task not found.'); return; }

  const data: any = {};

  switch (field) {
    case 'buys': data.followBuys = !sub.followBuys; break;
    case 'sells': data.copySells = !sub.copySells; break;
    case 'bos': data.buyOnSells = !sub.buyOnSells; break;
    case 'ct': data.counterTrade = !sub.counterTrade; break;
    case 'limit': data.limitMode = !sub.limitMode; break;
    default: return;
  }

  await prisma.copySubscription.update({ where: { id: subId }, data });
  const updated = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (updated) await renderManagePage(ctx, updated);
}

// Start / Pause
export async function handleManageStart(ctx: Context, subId: string): Promise<void> {
  await ctx.answerCbQuery('▶️ Started!').catch(() => {});
  await prisma.copySubscription.update({ where: { id: subId }, data: { isPaused: false, isActive: true } });
  const sub = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (sub) await renderManagePage(ctx, sub);
}

export async function handleManagePause(ctx: Context, subId: string): Promise<void> {
  await ctx.answerCbQuery('⏸ Paused!').catch(() => {});
  await prisma.copySubscription.update({ where: { id: subId }, data: { isPaused: true } });
  const sub = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (sub) await renderManagePage(ctx, sub);
}

// Mute toggle
export async function handleManageMute(ctx: Context, subId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const sub = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (!sub) return;
  await prisma.copySubscription.update({ where: { id: subId }, data: { notificationsEnabled: !sub.notificationsEnabled } });
  const updated = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (updated) await renderManagePage(ctx, updated);
}

// Buy method switch
export async function handleManageBuyMethod(ctx: Context, subId: string, method: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const sub = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (!sub) return;

  if (method === 'exact') {
    await prisma.copySubscription.update({
      where: { id: subId },
      data: { buyMethod: 'exact', multiplier: 1.0, fixedAmount: null },
    });
  } else if (method === 'fixed') {
    // Switch to fixed — keep existing fixedAmount or prompt
    await prisma.copySubscription.update({
      where: { id: subId },
      data: { buyMethod: 'fixed', fixedAmount: sub.fixedAmount ?? 25 },
    });
  } else if (method === 'pct') {
    await prisma.copySubscription.update({
      where: { id: subId },
      data: { buyMethod: 'percentage', multiplier: sub.multiplier ?? 1.0 },
    });
  } else if (method === 'port') {
    await prisma.copySubscription.update({
      where: { id: subId },
      data: { buyMethod: 'portfolio', multiplier: sub.multiplier ?? 1.0 },
    });
  }

  const updated = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (updated) await renderManagePage(ctx, updated);
}

// Copy side cycle
export async function handleManageCopySide(ctx: Context, subId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const sub = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (!sub) return;

  const next = sub.copySide === 'both' ? 'yes' : sub.copySide === 'yes' ? 'no' : 'both';
  await prisma.copySubscription.update({ where: { id: subId }, data: { copySide: next } });
  const updated = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (updated) await renderManagePage(ctx, updated);
}

// ─── Manage Page: Edit Actions (enter text input mode) ──────────────────────────

export async function handleManageEditPrompt(ctx: Context, subId: string, editStep: CopyEditState['step'], prompt: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  copyEditState.set(telegramId, { step: editStep, subId, timestamp: Date.now() });

  await sendPage(ctx, prompt, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('⏭ Clear / Off', `cpm_clear_${editStep}_${subId}`),
      ],
      [
        Markup.button.callback('← Cancel', `copy_task_${subId}`),
      ],
    ]),
  });
}

// Clear a numeric field
export async function handleManageClear(ctx: Context, subId: string, editStep: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (telegramId) copyEditState.delete(telegramId);

  const fieldMap: Record<string, string> = {
    awaiting_max_buy: 'singleTradeMax',
    awaiting_min_buy: 'minBuyAmount',
    awaiting_max_spend_market: 'maxSpendPerMarket',
    awaiting_max_spend_total: 'maxSpendTotal',
    awaiting_daily_limit: 'dailySpendMax',
    awaiting_min_trigger: 'minTriggerPrice',
    awaiting_max_trigger: 'maxTriggerPrice',
    awaiting_max_days: 'maxDaysOut',
    awaiting_min_liq: 'minLiquidity',
    awaiting_min_vol: 'minVolume',
    awaiting_price_min: 'priceMin',
    awaiting_price_max: 'priceMax',
    awaiting_sl_pct: 'stopLossPct',
    awaiting_sl_fixed: 'stopLossFixed',
    awaiting_tp_pct: 'takeProfitPct',
    awaiting_tp_fixed: 'takeProfitFixed',
    awaiting_categories: 'categories',
  };

  const dbField = fieldMap[editStep];
  if (dbField) {
    await prisma.copySubscription.update({ where: { id: subId }, data: { [dbField]: null } });
  }

  const sub = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (sub) await renderManagePage(ctx, sub);
}

// Delete task from manage page
export async function handleManageDelete(ctx: Context, subId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendPage(ctx,
    `🗑 <b>Delete this task?</b>\n\nThis cannot be undone.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Yes, Delete', `cpm_deldo_${subId}`)],
        [Markup.button.callback('← Cancel', `copy_task_${subId}`)],
      ]),
    }
  );
}

export async function handleManageDeleteExecute(ctx: Context, subId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  try {
    await prisma.copySubscription.delete({ where: { id: subId } });
  } catch { /* ignore */ }
  await handleCopyList(ctx);
}

// Rename
export async function handleManageRename(ctx: Context, subId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  copyEditState.set(telegramId, { step: 'awaiting_rename', subId, timestamp: Date.now() });
  await sendPage(ctx,
    `✏️ <b>Rename Task</b>\n\nEnter a new name (1–24 characters):`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('← Cancel', `copy_task_${subId}`)]]),
    }
  );
}

// SL prompt (choose pct or fixed)
export async function handleManageSlPrompt(ctx: Context, subId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendPage(ctx,
    `🔻 <b>Stop Loss</b>\n\nChoose stop loss type:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📉 Percentage', `cpm_sltype_pct_${subId}`),
          Markup.button.callback('💲 Fixed Price', `cpm_sltype_fix_${subId}`),
        ],
        [Markup.button.callback('⏭ Turn Off', `cpm_clear_awaiting_sl_pct_${subId}`)],
        [Markup.button.callback('← Cancel', `copy_task_${subId}`)],
      ]),
    }
  );
}

export async function handleManageSlTypePct(ctx: Context, subId: string): Promise<void> {
  await handleManageEditPrompt(ctx, subId, 'awaiting_sl_pct',
    `🔻 <b>Stop Loss — Percentage</b>\n\nEnter the stop loss percentage (e.g. 30 for −30%):`,
  );
}

export async function handleManageSlTypeFix(ctx: Context, subId: string): Promise<void> {
  await handleManageEditPrompt(ctx, subId, 'awaiting_sl_fixed',
    `🔻 <b>Stop Loss — Fixed Price</b>\n\nEnter the stop loss price in cents (e.g. 15):`,
  );
}

// TP prompt
export async function handleManageTpPrompt(ctx: Context, subId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendPage(ctx,
    `🔺 <b>Take Profit</b>\n\nChoose take profit type:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📈 Percentage', `cpm_tptype_pct_${subId}`),
          Markup.button.callback('💲 Fixed Price', `cpm_tptype_fix_${subId}`),
        ],
        [Markup.button.callback('⏭ Turn Off', `cpm_clear_awaiting_tp_pct_${subId}`)],
        [Markup.button.callback('← Cancel', `copy_task_${subId}`)],
      ]),
    }
  );
}

export async function handleManageTpTypePct(ctx: Context, subId: string): Promise<void> {
  await handleManageEditPrompt(ctx, subId, 'awaiting_tp_pct',
    `🔺 <b>Take Profit — Percentage</b>\n\nEnter the take profit percentage (e.g. 50 for +50%):`,
  );
}

export async function handleManageTpTypeFix(ctx: Context, subId: string): Promise<void> {
  await handleManageEditPrompt(ctx, subId, 'awaiting_tp_fixed',
    `🔺 <b>Take Profit — Fixed Price</b>\n\nEnter the take profit price in cents (e.g. 85):`,
  );
}

// ─── Edit Input Handler (manage page text inputs) ───────────────────────────────

export async function handleCopyEditInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;

  const state = await copyEditState.get(telegramId);
  if (!state) return false;
  if (isExpired(state.timestamp)) { copyEditState.delete(telegramId); return false; }

  const val = parseFloat(text.replace(',', '.'));
  const subId = state.subId;

  switch (state.step) {
    case 'awaiting_rename': {
      const name = text.trim();
      if (name.length < 1 || name.length > 24) {
        await ctx.reply('❌ Name must be 1–24 characters.');
        return true;
      }
      await prisma.copySubscription.update({ where: { id: subId }, data: { label: name } });
      break;
    }

    case 'awaiting_amount': {
      if (isNaN(val) || val <= 0) { await ctx.reply('❌ Enter a valid positive number.'); return true; }
      const sub = await prisma.copySubscription.findUnique({ where: { id: subId } });
      if (!sub) break;
      if (sub.buyMethod === 'fixed') {
        await prisma.copySubscription.update({ where: { id: subId }, data: { fixedAmount: val } });
      } else {
        await prisma.copySubscription.update({ where: { id: subId }, data: { multiplier: val } });
      }
      break;
    }

    case 'awaiting_slippage': {
      if (isNaN(val) || val < 0.1 || val > 50) { await ctx.reply('❌ Slippage: 0.1–50%.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { slippage: val } });
      break;
    }

    case 'awaiting_max_buy': {
      if (isNaN(val) || val <= 0) { await ctx.reply('❌ Enter a valid amount.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { singleTradeMax: val } });
      break;
    }

    case 'awaiting_min_buy': {
      if (isNaN(val) || val <= 0) { await ctx.reply('❌ Enter a valid amount.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { minBuyAmount: val } });
      break;
    }

    case 'awaiting_max_spend_market': {
      if (isNaN(val) || val <= 0) { await ctx.reply('❌ Enter a valid amount.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { maxSpendPerMarket: val } });
      break;
    }

    case 'awaiting_max_spend_total': {
      if (isNaN(val) || val <= 0) { await ctx.reply('❌ Enter a valid amount.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { maxSpendTotal: val } });
      break;
    }

    case 'awaiting_daily_limit': {
      if (isNaN(val) || val <= 0) { await ctx.reply('❌ Enter a valid amount.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { dailySpendMax: val } });
      break;
    }

    case 'awaiting_min_trigger': {
      if (isNaN(val) || val < 0 || val > 100) { await ctx.reply('❌ Enter 0–100.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { minTriggerPrice: val } });
      break;
    }

    case 'awaiting_max_trigger': {
      if (isNaN(val) || val < 0 || val > 100) { await ctx.reply('❌ Enter 0–100.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { maxTriggerPrice: val } });
      break;
    }

    case 'awaiting_max_days': {
      const intVal = parseInt(text.trim(), 10);
      if (isNaN(intVal) || intVal < 1) { await ctx.reply('❌ Enter a positive integer.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { maxDaysOut: intVal } });
      break;
    }

    case 'awaiting_min_liq': {
      if (isNaN(val) || val <= 0) { await ctx.reply('❌ Enter a valid amount.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { minLiquidity: val } });
      break;
    }

    case 'awaiting_min_vol': {
      if (isNaN(val) || val <= 0) { await ctx.reply('❌ Enter a valid amount.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { minVolume: val } });
      break;
    }

    case 'awaiting_price_min': {
      if (isNaN(val) || val < 0 || val > 100) { await ctx.reply('❌ Enter 0–100.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { priceMin: val } });
      break;
    }

    case 'awaiting_price_max': {
      if (isNaN(val) || val < 0 || val > 100) { await ctx.reply('❌ Enter 0–100.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { priceMax: val } });
      break;
    }

    case 'awaiting_sl_pct': {
      if (isNaN(val) || val <= 0 || val > 100) { await ctx.reply('❌ Enter 1–100.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { stopLossPct: val, stopLossFixed: null } });
      break;
    }

    case 'awaiting_sl_fixed': {
      if (isNaN(val) || val <= 0 || val > 99) { await ctx.reply('❌ Enter 1–99.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { stopLossFixed: val, stopLossPct: null } });
      break;
    }

    case 'awaiting_tp_pct': {
      if (isNaN(val) || val <= 0 || val > 1000) { await ctx.reply('❌ Enter 1–1000.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { takeProfitPct: val, takeProfitFixed: null } });
      break;
    }

    case 'awaiting_tp_fixed': {
      if (isNaN(val) || val <= 0 || val > 99) { await ctx.reply('❌ Enter 1–99.'); return true; }
      await prisma.copySubscription.update({ where: { id: subId }, data: { takeProfitFixed: val, takeProfitPct: null } });
      break;
    }

    case 'awaiting_categories': {
      const cats = text.trim();
      await prisma.copySubscription.update({ where: { id: subId }, data: { categories: cats || null } });
      break;
    }

    default:
      // Consume text so it doesn't leak to keyword search
      return true;
  }

  copyEditState.delete(telegramId);
  const sub = await prisma.copySubscription.findUnique({ where: { id: subId } });
  if (sub) await renderManagePage(ctx, sub);
  return true;
}

// ─── Activity / History ─────────────────────────────────────────────────────────

export async function handleCopyHistory(ctx: Context, limit: number): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.reply('❌ User not found.'); return; }

  const trades = await prisma.copiedTrade.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 50),
  });

  if (trades.length === 0) {
    await sendPage(ctx,
      `📜 <b>Copy Trade Activity</b>\n\nNo copied trades yet.`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('← Back', 'copy_list')]]) }
    );
    return;
  }

  const lines = [`📜 <b>Copy Trade Activity</b> (last ${trades.length})\n`];

  for (const t of trades) {
    const icon = t.status === 'filled' ? '✅' : t.status === 'failed' ? '❌' : '⏭';
    const short = shortAddr(t.traderAddress);
    const date = t.createdAt.toISOString().slice(0, 10);
    lines.push(
      `${icon} ${t.side} ${t.outcome} — $${t.copiedSize.toFixed(2)} (from ${short}) — ${date}`
    );
  }

  await sendPage(ctx, lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('← Back', 'copy_list')]]),
  });
}

// ─── Deep Link Handlers (from start.ts) ─────────────────────────────────────────

export async function handleCopyManageDeepLink(ctx: Context, traderAddress: string): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const sub = await prisma.copySubscription.findUnique({
    where: { userId_traderAddress: { userId: user.id, traderAddress } },
  });

  if (!sub) {
    await ctx.reply('❌ No copy task found for this trader.');
    return;
  }

  await renderManagePage(ctx, sub);
}

export async function handleCopyShareDeepLink(ctx: Context, traderAddress: string): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const shareLink = `https://t.me/${config.telegram.botUsername}?start=copyadd_${traderAddress}`;

  await sendPage(ctx,
    `📤 <b>Share Copy Trade</b>\n\n` +
    `Share this link so others can copy the same trader:\n\n` +
    `<code>${shareLink}</code>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('← Back', 'copy_list')]]),
    }
  );
}

// Legacy export aliases for backward compat with index.ts imports
export const handleCopyStop = handleCopyStopSingle;
export const handleCopyManage = handleCopyTaskByAddr;
export const handleCopyShare = handleCopyShareDeepLink;
