import { Context, Markup } from 'telegraf';
import { prisma } from '../../database/prisma';
import { logger } from '../../utils/logger';
import { getUserByTelegramId } from '../../services/user';
import { sendPage } from '../../utils/telegram';
import { esc } from '../../utils/customEmoji';
import { RedisBackedState } from '../../utils/redisState';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** sendPage wrapper that forces HTML parse mode */
function sendHtml(ctx: Context, text: string, markup?: any) {
  return sendPage(ctx, text, { ...(markup ?? {}), parse_mode: 'HTML' });
}

const MAX_STRATEGIES = 20;
const STATE_TTL_MS = 10 * 60 * 1000;

function isExpired(ts: number): boolean {
  return Date.now() - ts > STATE_TTL_MS;
}

// ─── Add Flow State ─────────────────────────────────────────────────────────

interface BondAddState {
  step: 'name' | 'daily_budget' | 'min_prob' | 'min_prob_custom' | 'time_window' | 'time_window_custom'
      | 'max_concurrent' | 'max_concurrent_custom'
      | 'markets_filter' | 'review'
      // Advanced steps
      | 'adv_amount' | 'adv_slippage' | 'adv_min_liq' | 'adv_min_vol'
      | 'adv_max_spend_market' | 'adv_max_spend_total'
      | 'adv_max_daily_loss' | 'adv_max_prob' | 'adv_scan_interval'
      | 'adv_outcome_side';
  name?: string;
  dailyBudget?: number;
  minProbability?: number;
  maxProbability?: number;
  maxHoursOut?: number;
  maxConcurrent?: number;
  includeSports?: boolean;
  includeCryptoUpDown?: boolean;
  // Advanced (optional)
  fixedAmount?: number;
  slippage?: number;
  minLiquidity?: number | null;
  minVolume?: number | null;
  maxSpendPerMarket?: number | null;
  maxSpendTotal?: number | null;
  maxDailyLoss?: number | null;
  scanInterval?: number;
  outcomeSide?: string;
  advStep?: number; // tracks which advanced field we're on
  timestamp: number;
}

export const bondAddState = new RedisBackedState<BondAddState>('bondAdd', 600);

setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, state] of bondAddState.entries()) {
    if (state.timestamp < cutoff) bondAddState.delete(key);
  }
}, 30 * 60 * 1000);

// ─── Edit State ─────────────────────────────────────────────────────────────

interface BondEditState {
  step: 'awaiting_budget' | 'awaiting_amount' | 'awaiting_slippage'
      | 'awaiting_min_prob' | 'awaiting_max_prob'
      | 'awaiting_window' | 'awaiting_max_pos'
      | 'awaiting_interval' | 'awaiting_min_liq'
      | 'awaiting_min_vol' | 'awaiting_mkt_max'
      | 'awaiting_total_max' | 'awaiting_loss_limit'
      | 'awaiting_rename';
  stratId: string;
  timestamp: number;
}

export const bondEditState = new RedisBackedState<BondEditState>('bondEdit', 600);

setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, state] of bondEditState.entries()) {
    if (state.timestamp < cutoff) bondEditState.delete(key);
  }
}, 30 * 60 * 1000);

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtVal(v: number | null | undefined, prefix = '$', suffix = ''): string {
  if (v == null) return '–';
  return `${prefix}${v}${suffix}`;
}

function onOff(v: boolean): string {
  return v ? '🟢' : '🔴';
}

function parseNumber(text: string): number | null {
  const cleaned = text.replace(/,/g, '.').replace(/\s/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// ─── /bond Command ──────────────────────────────────────────────────────────

export async function handleBondCommand(ctx: Context): Promise<void> {
  await handleBondList(ctx);
}

// ─── List Page (Kreo style — detailed cards) ───────────────────────────────

export async function handleBondList(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  bondAddState.delete(telegramId);
  bondEditState.delete(telegramId);

  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.reply('❌ User not found. Use /start first.'); return; }

  const strategies = await prisma.bondStrategy.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
    include: {
      trades: {
        where: { status: 'filled' },
        select: { amount: true, price: true, createdAt: true },
      },
    },
  });

  const lines: string[] = [
    `🤖 <b>Bond Trading</b>`,
    ``,
  ];

  if (strategies.length === 0) {
    lines.push(`No bond strategies yet.`);
    lines.push(`Tap <b>➕ Add</b> to create your first strategy.`);
  } else {
    const running = strategies.filter(s => s.isActive && !s.isPaused).length;

    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      const statusDot = s.isActive && !s.isPaused ? '🟢' : '🔴';
      const name = s.label || `Strategy-${i + 1}`;

      // Calculate stats from trades
      const filledTrades = s.trades || [];
      const totalSpent = filledTrades.reduce((sum, t) => sum + t.amount, 0);
      const tradeCount = filledTrades.length;
      // Estimated PnL assumes all high-prob bonds resolve correctly (not guaranteed)
      const pnlEstimate = filledTrades.reduce((sum, t) => {
        return sum + t.amount * (1 - t.price);
      }, 0);
      const pnlStr = pnlEstimate >= 0 ? `+$${pnlEstimate.toFixed(2)}` : `-$${Math.abs(pnlEstimate).toFixed(2)}`;

      // Today's trades
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayTrades = filledTrades.filter(t => new Date(t.createdAt) >= today).length;

      lines.push(
        `${i + 1}. ${statusDot} 🎯 <b>${esc(name)}</b>\n` +
        `├ Mode: 📊 ${s.minProbability}%–${s.maxProbability}% · <b>$${s.fixedAmount.toFixed(2)}</b>\n` +
        `├ Est. PnL: <b>${pnlStr}</b> · Trades Filled: ${tradeCount}\n` +
        `├ Today's Trades: <b>${todayTrades}</b>\n` +
        `└ Spent: <b>$${totalSpent.toFixed(2)}</b>`
      );
      lines.push(``);
    }

    lines.push(`⚡ Status: ${running}/${strategies.length} tasks running.`);
  }

  const buttons: any[][] = [];

  // Per-strategy action buttons (Start · Edit · Share style)
  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    const id = s.id;
    const isRunning = s.isActive && !s.isPaused;
    buttons.push([
      Markup.button.callback(
        isRunning ? `⏹ Stop ${i + 1}` : `▶️ Start ${i + 1}`,
        isRunning ? `bpm_pause_${id}` : `bpm_start_${id}`
      ),
      Markup.button.callback(`✏️ Edit ${i + 1}`, `bond_task_${id}`),
    ]);
  }

  // Controls row
  buttons.push([
    Markup.button.callback('➕ Add', 'bond_start_add'),
    Markup.button.callback('🗑 Remove', 'bond_remove_prompt'),
  ]);

  if (strategies.length > 0) {
    buttons.push([
      Markup.button.callback('▶️ Start All', 'bond_start_all'),
      Markup.button.callback('⏹ Stop All', 'bond_stop_all'),
    ]);
    buttons.push([
      Markup.button.callback('📜 History', 'bond_history_10'),
      Markup.button.callback('🗑 Delete All', 'bond_del_all_cfm'),
    ]);
  }

  buttons.push([
    Markup.button.callback('← Auto Strategies', 'auto_strategies'),
    Markup.button.callback('× Close', 'bond_close'),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);
  await sendHtml(ctx, lines.join('\n'), keyboard);
}

// ─── Start / Stop All ───────────────────────────────────────────────────────

export async function handleBondStartAll(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  await prisma.bondStrategy.updateMany({
    where: { userId: user.id, isActive: true },
    data: { isPaused: false },
  });
  await handleBondList(ctx);
}

export async function handleBondStopAll(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  await prisma.bondStrategy.updateMany({
    where: { userId: user.id, isActive: true },
    data: { isPaused: true },
  });
  await handleBondList(ctx);
}

// ─── Delete All ─────────────────────────────────────────────────────────────

export async function handleBondDeleteAllConfirm(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});

  const text = `⚠️ <b>Delete All Strategies</b>\n\nThis will permanently delete all your bond strategies. Are you sure?`;
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🗑 Yes, Delete All', 'bond_del_all_do'),
      Markup.button.callback('← Cancel', 'bond_list'),
    ],
  ]);
  await sendHtml(ctx, text, keyboard);
}

export async function handleBondDeleteAllExecute(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  await prisma.bondStrategy.deleteMany({ where: { userId: user.id } });
  await handleBondList(ctx);
}

// ─── Remove Single ──────────────────────────────────────────────────────────

export async function handleBondRemovePrompt(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const strategies = await prisma.bondStrategy.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });

  if (strategies.length === 0) {
    await ctx.answerCbQuery('No strategies to remove').catch(() => {});
    return;
  }

  const buttons = strategies.map((s, i) => [
    Markup.button.callback(
      `🗑 ${s.label || `Strategy-${i + 1}`}`,
      `bond_rm_${s.id}`
    ),
  ]);
  buttons.push([Markup.button.callback('← Back', 'bond_list')]);

  await sendHtml(ctx,
    `🗑 <b>Remove Strategy</b>\n\nSelect a strategy to remove:`,
    Markup.inlineKeyboard(buttons),
  );
}

export async function handleBondRemoveExecute(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  await prisma.bondStrategy.deleteMany({ where: { id: stratId, userId: user.id } });
  await handleBondList(ctx);
}

// ─── History ────────────────────────────────────────────────────────────────

export async function handleBondHistory(ctx: Context, limit: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const trades = await prisma.bondTrade.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  if (trades.length === 0) {
    await sendHtml(ctx,
      `📜 <b>Bond Trade History</b>\n\nNo trades yet.`,
      Markup.inlineKeyboard([[Markup.button.callback('← Back', 'bond_list')]]),
    );
    return;
  }

  const lines = [`📜 <b>Bond Trade History</b> (last ${trades.length})\n`];
  for (const t of trades) {
    const icon = t.status === 'filled' ? '✅' : t.status === 'failed' ? '❌' : '⏳';
    const pct = (t.probability * 100).toFixed(1);
    const q = t.question.length > 50 ? t.question.slice(0, 47) + '...' : t.question;
    lines.push(`${icon} ${esc(q)}\n   ${t.outcome} @ ${pct}% · $${t.amount.toFixed(2)}`);
  }

  await sendHtml(ctx,
    lines.join('\n'),
    Markup.inlineKeyboard([[Markup.button.callback('← Back', 'bond_list')]]),
  );
}

// ─── Close ──────────────────────────────────────────────────────────────────

export async function handleBondClose(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
}

// ─── Add Flow ───────────────────────────────────────────────────────────────

export async function handleBondStartAdd(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const count = await prisma.bondStrategy.count({ where: { userId: user.id } });
  if (count >= MAX_STRATEGIES) {
    await ctx.answerCbQuery(`Max ${MAX_STRATEGIES} strategies reached`).catch(() => {});
    return;
  }

  bondAddState.set(telegramId, {
    step: 'name',
    timestamp: Date.now(),
  });

  await sendHtml(ctx,
    `✏️ <b>Step 1/7: Strategy Name</b>\n\n` +
    `Give your strategy a name (e.g. "Safe Bonds", "High Prob Scanner"):`,
    Markup.inlineKeyboard([
      [Markup.button.callback('← Cancel', 'bond_list')],
    ]),
  );
}

// Step 2: Daily Budget
async function showDailyBudgetStep(ctx: Context): Promise<void> {
  await sendHtml(ctx,
    `💰 <b>Step 2/7: Daily Budget</b>\n\n` +
    `How much USDC per day should this strategy spend?\n\n` +
    `Enter an amount (e.g. 50, 100, 200):`,
    Markup.inlineKeyboard([
      [Markup.button.callback('← Cancel', 'bond_list')],
    ]),
  );
}

// Step 3: Min probability
async function showMinProbStep(ctx: Context): Promise<void> {
  await sendHtml(ctx,
    `🎯 <b>Step 3/7: Min Probability</b>\n\n` +
    `Only buy markets where the winning side is at least this likely.\n\n` +
    `Choose a preset or enter custom:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('90%', 'bond_add_prob_90'),
        Markup.button.callback('93%', 'bond_add_prob_93'),
        Markup.button.callback('95%', 'bond_add_prob_95'),
        Markup.button.callback('97%', 'bond_add_prob_97'),
      ],
      [Markup.button.callback('✏️ Custom', 'bond_add_prob_custom')],
      [Markup.button.callback('← Cancel', 'bond_list')],
    ]),
  );
}

// Step 3: Time window
async function showTimeWindowStep(ctx: Context): Promise<void> {
  await sendHtml(ctx,
    `⏰ <b>Step 4/7: Time Window</b>\n\n` +
    `Only buy markets that expire within this many hours.\n\n` +
    `Choose a preset or enter custom:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('12h', 'bond_add_hours_12'),
        Markup.button.callback('24h', 'bond_add_hours_24'),
        Markup.button.callback('48h', 'bond_add_hours_48'),
        Markup.button.callback('72h', 'bond_add_hours_72'),
      ],
      [Markup.button.callback('✏️ Custom', 'bond_add_hours_custom')],
      [Markup.button.callback('← Cancel', 'bond_list')],
    ]),
  );
}

// Step 4: Max concurrent
async function showMaxConcurrentStep(ctx: Context): Promise<void> {
  await sendHtml(ctx,
    `📊 <b>Step 5/7: Max Concurrent Positions</b>\n\n` +
    `Maximum number of open bond positions at once.`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('2', 'bond_add_conc_2'),
        Markup.button.callback('5', 'bond_add_conc_5'),
        Markup.button.callback('10', 'bond_add_conc_10'),
      ],
      [Markup.button.callback('✏️ Custom', 'bond_add_conc_custom')],
      [Markup.button.callback('← Cancel', 'bond_list')],
    ]),
  );
}

// Step 5: Market types
async function showMarketsFilterStep(ctx: Context): Promise<void> {
  await sendHtml(ctx,
    `🏈 <b>Step 6/7: Market Types</b>\n\n` +
    `Include sports and/or short-term crypto up/down markets?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Neither', 'bond_add_mkt_none')],
      [Markup.button.callback('🏈 Sports Only', 'bond_add_mkt_sports')],
      [Markup.button.callback('₿ Crypto Only', 'bond_add_mkt_crypto')],
      [Markup.button.callback('Both', 'bond_add_mkt_both')],
      [Markup.button.callback('← Cancel', 'bond_list')],
    ]),
  );
}

// Step 6: Review
async function showReviewStep(ctx: Context, state: BondAddState): Promise<void> {
  const lines = [
    `📋 <b>Step 7/7: Review</b>\n`,
    `✏️ Name: <b>${esc(state.name || 'Strategy')}</b>`,
    `💰 Daily Budget: $${state.dailyBudget ?? 100}`,
    `💵 Amount/Trade: $${state.fixedAmount ?? 25}`,
    `🎯 Min Probability: ${state.minProbability ?? 95}%`,
    `🎯 Max Probability: ${state.maxProbability ?? 99}%`,
    `⏰ Time Window: ${state.maxHoursOut ?? 48}h`,
    `📊 Max Positions: ${state.maxConcurrent ?? 5}`,
    `🏈 Sports: ${state.includeSports ? '✅' : '❌'}  |  ₿ Crypto: ${state.includeCryptoUpDown ? '✅' : '❌'}`,
    `⚡ Slippage: ${state.slippage ?? 5}%`,
    `📡 Scan: ${state.scanInterval ?? 5}min`,
    `🎲 Side: ${state.outcomeSide ?? 'auto'}`,
  ];

  if (state.minLiquidity != null) lines.push(`💧 Min Liquidity: $${state.minLiquidity}`);
  if (state.minVolume != null) lines.push(`📊 Min Volume: $${state.minVolume}`);
  if (state.maxSpendPerMarket != null) lines.push(`💸 Per Market Max: $${state.maxSpendPerMarket}`);
  if (state.maxSpendTotal != null) lines.push(`💸 Total Max: $${state.maxSpendTotal}`);
  if (state.maxDailyLoss != null) lines.push(`📅 Max Daily Loss: $${state.maxDailyLoss}`);

  lines.push(`🔔 Notifications: On`);

  // Consistency warnings
  const fa = state.fixedAmount ?? 25;
  const db = state.dailyBudget ?? 100;
  if (fa > db) {
    lines.push(`\n⚠️ Amount/trade ($${fa}) exceeds daily budget ($${db}).`);
  }
  const mspm = state.maxSpendPerMarket;
  if (mspm != null && mspm < fa) {
    lines.push(`⚠️ Per-market max ($${mspm}) is less than amount/trade ($${fa}).`);
  }

  lines.push(`\nStrategy starts <b>paused</b>. Start it from the manage page.`);

  await sendHtml(ctx,
    lines.join('\n'),
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Confirm', 'bond_add_confirm'),
        Markup.button.callback('⚙️ Advanced', 'bond_add_advanced'),
      ],
      [Markup.button.callback('← Cancel', 'bond_list')],
    ]),
  );
}

// ─── Add Flow Button Handlers ───────────────────────────────────────────────

// Probability presets
export async function handleAddProbPreset(ctx: Context, pct: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await bondAddState.get(telegramId);
  if (!state) return;
  state.minProbability = pct;
  state.timestamp = Date.now();
  state.step = 'time_window';
  bondAddState.set(telegramId, state);
  await showTimeWindowStep(ctx);
}

export async function handleAddProbCustom(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await bondAddState.get(telegramId);
  if (!state) return;
  state.step = 'min_prob_custom';
  state.timestamp = Date.now();
  bondAddState.set(telegramId, state);
  await sendHtml(ctx,
    `🎯 <b>Custom Min Probability</b>\n\nEnter a value between 50 and 99:`,
    Markup.inlineKeyboard([[Markup.button.callback('← Cancel', 'bond_list')]]),
  );
}

// Hours presets
export async function handleAddHoursPreset(ctx: Context, hours: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await bondAddState.get(telegramId);
  if (!state) return;
  state.maxHoursOut = hours;
  state.timestamp = Date.now();
  state.step = 'max_concurrent';
  bondAddState.set(telegramId, state);
  await showMaxConcurrentStep(ctx);
}

export async function handleAddHoursCustom(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await bondAddState.get(telegramId);
  if (!state) return;
  state.step = 'time_window_custom';
  state.timestamp = Date.now();
  bondAddState.set(telegramId, state);
  await sendHtml(ctx,
    `⏰ <b>Custom Time Window</b>\n\nEnter hours (1–168):`,
    Markup.inlineKeyboard([[Markup.button.callback('← Cancel', 'bond_list')]]),
  );
}

// Concurrent presets
export async function handleAddConcPreset(ctx: Context, n: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await bondAddState.get(telegramId);
  if (!state) return;
  state.maxConcurrent = n;
  state.timestamp = Date.now();
  state.step = 'markets_filter';
  bondAddState.set(telegramId, state);
  await showMarketsFilterStep(ctx);
}

export async function handleAddConcCustom(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await bondAddState.get(telegramId);
  if (!state) return;
  state.step = 'max_concurrent_custom';
  state.timestamp = Date.now();
  bondAddState.set(telegramId, state);
  await sendHtml(ctx,
    `📊 <b>Custom Max Positions</b>\n\nEnter a number (1–50):`,
    Markup.inlineKeyboard([[Markup.button.callback('← Cancel', 'bond_list')]]),
  );
}

// Market type presets
export async function handleAddMarketType(ctx: Context, type: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await bondAddState.get(telegramId);
  if (!state) return;

  state.includeSports = type === 'sports' || type === 'both';
  state.includeCryptoUpDown = type === 'crypto' || type === 'both';
  state.step = 'review';
  state.timestamp = Date.now();
  bondAddState.set(telegramId, state);
  await showReviewStep(ctx, state);
}

// ─── Advanced Settings ──────────────────────────────────────────────────────

const ADV_STEPS = [
  'adv_amount', 'adv_slippage', 'adv_min_liq', 'adv_min_vol',
  'adv_max_spend_market', 'adv_max_spend_total', 'adv_max_daily_loss',
  'adv_max_prob', 'adv_scan_interval', 'adv_outcome_side',
] as const;

const ADV_PROMPTS: Record<string, string> = {
  adv_amount: '💵 <b>Amount Per Trade</b>\n\nUSDC to spend per trade (default: $25).\nEnter amount or ⏭ Skip:',
  adv_slippage: '⚡ <b>Slippage %</b>\n\nMax slippage tolerance (default: 5%).\nEnter % or ⏭ Skip:',
  adv_min_liq: '💧 <b>Min Liquidity</b>\n\nMinimum liquidity in USD (default: none).\nEnter amount or ⏭ Skip:',
  adv_min_vol: '📊 <b>Min Volume</b>\n\nMinimum 24h volume in USD (default: none).\nEnter amount or ⏭ Skip:',
  adv_max_spend_market: '💸 <b>Max Spend Per Market</b>\n\nMax USD per single market (default: none).\nEnter amount or ⏭ Skip:',
  adv_max_spend_total: '💸 <b>Max Total Spend</b>\n\nLifetime max spend in USD (default: none).\nEnter amount or ⏭ Skip:',
  adv_max_daily_loss: '📅 <b>Max Daily Loss</b>\n\nPause strategy if daily loss exceeds this (default: none).\nEnter amount or ⏭ Skip:',
  adv_max_prob: '🎯 <b>Max Probability</b>\n\nUpper probability cap (default: 99%).\nEnter % or ⏭ Skip:',
  adv_scan_interval: '📡 <b>Scan Interval</b>\n\nMinutes between scans, 1–10 (default: 5).\nEnter number or ⏭ Skip:',
  adv_outcome_side: '🎲 <b>Outcome Side</b>\n\nWhich side to buy?',
};

export async function handleAddAdvanced(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await bondAddState.get(telegramId);
  if (!state) return;

  await showAdvMenu(ctx, state);
}

async function showAdvMenu(ctx: Context, state: BondAddState): Promise<void> {
  const lines = [
    `⚙️ <b>Advanced Settings</b>\n`,
    `💵 Amount/Trade: $${state.fixedAmount ?? 25}`,
    `⚡ Slippage: ${state.slippage ?? 5}%`,
    `💧 Min Liquidity: ${state.minLiquidity != null ? '$' + state.minLiquidity : '–'}`,
    `📊 Min Volume: ${state.minVolume != null ? '$' + state.minVolume : '–'}`,
    `💸 Per Market Max: ${state.maxSpendPerMarket != null ? '$' + state.maxSpendPerMarket : '–'}`,
    `💸 Total Max: ${state.maxSpendTotal != null ? '$' + state.maxSpendTotal : '–'}`,
    `📅 Max Daily Loss: ${state.maxDailyLoss != null ? '$' + state.maxDailyLoss : '–'}`,
    `🎯 Max Probability: ${state.maxProbability ?? 99}%`,
    `📡 Scan Interval: ${state.scanInterval ?? 5}min`,
    `🎲 Outcome Side: ${state.outcomeSide ?? 'auto'}`,
    `\nTap a setting to change it:`,
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard([
    [
      Markup.button.callback('💵 Amount', 'bond_adv_edit_amount'),
      Markup.button.callback('⚡ Slippage', 'bond_adv_edit_slippage'),
    ],
    [
      Markup.button.callback('💧 Min Liq', 'bond_adv_edit_min_liq'),
      Markup.button.callback('📊 Min Vol', 'bond_adv_edit_min_vol'),
    ],
    [
      Markup.button.callback('💸 Mkt Max', 'bond_adv_edit_mkt_max'),
      Markup.button.callback('💸 Total Max', 'bond_adv_edit_total_max'),
    ],
    [
      Markup.button.callback('📅 Loss Limit', 'bond_adv_edit_loss'),
      Markup.button.callback('🎯 Max Prob', 'bond_adv_edit_max_prob'),
    ],
    [
      Markup.button.callback('📡 Scan Int.', 'bond_adv_edit_scan'),
      Markup.button.callback('🎲 Side', 'bond_adv_edit_side'),
    ],
    [Markup.button.callback('← Back to Review', 'bond_adv_back_review')],
  ]));
}

// Legacy: kept for backwards compatibility with old inline keyboards
export async function handleAddAdvSkip(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await handleAddAdvanced(ctx);
}

export async function handleAddSidePreset(ctx: Context, side: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await bondAddState.get(telegramId);
  if (!state) return;

  state.outcomeSide = side;
  state.timestamp = Date.now();
  bondAddState.set(telegramId, state);
  await showAdvMenu(ctx, state);
}

export async function handleAdvBackReview(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await bondAddState.get(telegramId);
  if (!state) return;

  state.step = 'review';
  state.timestamp = Date.now();
  bondAddState.set(telegramId, state);
  await showReviewStep(ctx, state);
}

export async function handleAdvEdit(ctx: Context, field: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await bondAddState.get(telegramId);
  if (!state) return;

  const stepMap: Record<string, BondAddState['step']> = {
    amount: 'adv_amount',
    slippage: 'adv_slippage',
    min_liq: 'adv_min_liq',
    min_vol: 'adv_min_vol',
    mkt_max: 'adv_max_spend_market',
    total_max: 'adv_max_spend_total',
    loss: 'adv_max_daily_loss',
    max_prob: 'adv_max_prob',
    scan: 'adv_scan_interval',
  };

  if (field === 'side') {
    state.step = 'adv_outcome_side';
    state.timestamp = Date.now();
    bondAddState.set(telegramId, state);
    await sendHtml(ctx, ADV_PROMPTS['adv_outcome_side'], Markup.inlineKeyboard([
      [
        Markup.button.callback('Auto', 'bond_add_side_auto'),
        Markup.button.callback('YES', 'bond_add_side_yes'),
        Markup.button.callback('NO', 'bond_add_side_no'),
      ],
      [Markup.button.callback('← Back', 'bond_add_advanced')],
    ]));
    return;
  }

  const step = stepMap[field];
  if (!step) return;

  state.step = step;
  state.timestamp = Date.now();
  bondAddState.set(telegramId, state);

  const prompt = ADV_PROMPTS[step] || 'Enter value:';
  await sendHtml(ctx, prompt, Markup.inlineKeyboard([
    [Markup.button.callback('← Back', 'bond_add_advanced')],
  ]));
}

// ─── Confirm Add ────────────────────────────────────────────────────────────

export async function handleBondConfirmAdd(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const state = await bondAddState.get(telegramId);
  if (!state) { await ctx.reply('Session expired. Try again.'); return; }

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  // Use transaction to prevent race condition on MAX_STRATEGIES
  const created = await prisma.$transaction(async (tx) => {
    const count = await tx.bondStrategy.count({ where: { userId: user.id } });
    if (count >= MAX_STRATEGIES) return null;
    return tx.bondStrategy.create({
      data: {
        userId: user.id,
        label: state.name || 'Strategy',
        fixedAmount: state.fixedAmount ?? 25,
        dailyBudget: state.dailyBudget ?? 100,
        maxDailyLoss: state.maxDailyLoss ?? null,
        minProbability: state.minProbability ?? 95,
        maxProbability: state.maxProbability ?? 99,
        maxHoursOut: state.maxHoursOut ?? 48,
        maxConcurrent: state.maxConcurrent ?? 5,
        includeSports: state.includeSports ?? false,
        includeCryptoUpDown: state.includeCryptoUpDown ?? false,
        slippage: state.slippage ?? 5,
        minLiquidity: state.minLiquidity ?? null,
        minVolume: state.minVolume ?? null,
        maxSpendPerMarket: state.maxSpendPerMarket ?? null,
        maxSpendTotal: state.maxSpendTotal ?? null,
        scanInterval: state.scanInterval ?? 5,
        outcomeSide: state.outcomeSide ?? 'auto',
        isPaused: true,
      },
    });
  });

  if (!created) {
    await ctx.answerCbQuery(`Max ${MAX_STRATEGIES} strategies reached`).catch(() => {});
    return;
  }

  bondAddState.delete(telegramId);
  await handleBondList(ctx);
}

// ─── Text Input Handler ─────────────────────────────────────────────────────

export async function handleBondAddInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;

  const state = await bondAddState.get(telegramId);
  if (!state) return false;

  const num = parseNumber(text);

  switch (state.step) {
    case 'name': {
      const name = text.trim();
      if (!name || name.length < 1 || name.length > 32) {
        await ctx.reply('Enter a name (1–32 characters).');
        return true;
      }
      state.name = name;
      state.step = 'daily_budget';
      state.timestamp = Date.now();
      bondAddState.set(telegramId, state);
      await showDailyBudgetStep(ctx);
      return true;
    }

    case 'daily_budget': {
      if (num == null || num < 1 || num > 100_000) {
        await ctx.reply('❌ Enter a valid amount ($1–$100,000).');
        return true;
      }
      state.dailyBudget = num;
      state.step = 'min_prob';
      state.timestamp = Date.now();
      bondAddState.set(telegramId, state);
      await showMinProbStep(ctx);
      return true;
    }

    case 'min_prob_custom': {
      if (num == null || num < 50 || num > 99) {
        await ctx.reply('❌ Enter a value between 50 and 99.');
        return true;
      }
      state.minProbability = num;
      state.step = 'time_window';
      state.timestamp = Date.now();
      bondAddState.set(telegramId, state);
      await showTimeWindowStep(ctx);
      return true;
    }

    case 'time_window_custom': {
      if (num == null || num < 1 || num > 168) {
        await ctx.reply('❌ Enter hours between 1 and 168.');
        return true;
      }
      state.maxHoursOut = Math.round(num);
      state.step = 'max_concurrent';
      state.timestamp = Date.now();
      bondAddState.set(telegramId, state);
      await showMaxConcurrentStep(ctx);
      return true;
    }

    case 'max_concurrent_custom': {
      if (num == null || num < 1 || num > 50) {
        await ctx.reply('❌ Enter a number between 1 and 50.');
        return true;
      }
      state.maxConcurrent = Math.round(num);
      state.step = 'markets_filter';
      state.timestamp = Date.now();
      bondAddState.set(telegramId, state);
      await showMarketsFilterStep(ctx);
      return true;
    }

    // Advanced steps text input
    case 'adv_amount': {
      if (num == null || num < 1 || num > 10_000) {
        await ctx.reply('❌ Enter a valid amount ($1–$10,000).');
        return true;
      }
      state.fixedAmount = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_slippage': {
      if (num == null || num < 0.1 || num > 50) {
        await ctx.reply('❌ Enter slippage between 0.1% and 50%.');
        return true;
      }
      state.slippage = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_min_liq': {
      if (num == null || num < 0) {
        await ctx.reply('❌ Enter a valid amount.');
        return true;
      }
      state.minLiquidity = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_min_vol': {
      if (num == null || num < 0) {
        await ctx.reply('❌ Enter a valid amount.');
        return true;
      }
      state.minVolume = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_max_spend_market': {
      if (num == null || num < 1) {
        await ctx.reply('❌ Enter a valid amount (min $1).');
        return true;
      }
      state.maxSpendPerMarket = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_max_spend_total': {
      if (num == null || num < 1) {
        await ctx.reply('❌ Enter a valid amount (min $1).');
        return true;
      }
      state.maxSpendTotal = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_max_daily_loss': {
      if (num == null || num < 1) {
        await ctx.reply('❌ Enter a valid amount (min $1).');
        return true;
      }
      state.maxDailyLoss = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_max_prob': {
      if (num == null || num < 90 || num > 100) {
        await ctx.reply('❌ Enter a value between 90 and 100.');
        return true;
      }
      state.maxProbability = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_scan_interval': {
      if (num == null || num < 1 || num > 10) {
        await ctx.reply('❌ Enter minutes between 1 and 10.');
        return true;
      }
      state.scanInterval = Math.round(num);
      return advanceAdvStep(telegramId, state, ctx);
    }

    default:
      return false;
  }
}

async function advanceAdvStep(telegramId: string, state: BondAddState, ctx: Context): Promise<true> {
  state.timestamp = Date.now();
  bondAddState.set(telegramId, state);
  await showAdvMenu(ctx, state);
  return true;
}

// ─── Ownership Helper ────────────────────────────────────────────────────────

/** Verify the current user owns the bond strategy. Returns the strategy or null. */
async function verifyBondOwnership(ctx: Context, stratId: string) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return null;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return null;
  return prisma.bondStrategy.findFirst({ where: { id: stratId, userId: user.id } });
}

// ─── Manage Page ────────────────────────────────────────────────────────────

export async function handleBondManage(ctx: Context, stratId: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const strat = await verifyBondOwnership(ctx, stratId);
  if (!strat) {
    await ctx.reply('❌ Strategy not found.');
    return;
  }

  const statusStr = strat.isActive && !strat.isPaused ? '🟢 Running' : '🔴 Paused';
  const name = strat.label || strat.id.slice(0, 8);

  const lines = [
    `⚙️ <b>Strategy: ${esc(name)}</b>\n`,
    `📊 Status: ${statusStr}`,
    `💰 Daily Budget: $${strat.dailyBudget}`,
    `💵 Amount/Trade: $${strat.fixedAmount}`,
    `🎯 Min Probability: ${strat.minProbability}%`,
    `🎯 Max Probability: ${strat.maxProbability}%`,
    `⏰ Time Window: ${strat.maxHoursOut}h`,
    `📊 Max Positions: ${strat.maxConcurrent}`,
    `🏈 Sports: ${strat.includeSports ? '✅' : '❌'}  |  ₿ Crypto: ${strat.includeCryptoUpDown ? '✅' : '❌'}`,
    `⚡ Slippage: ${strat.slippage}%`,
    `📡 Scan: ${strat.scanInterval}min`,
    `🎲 Side: ${strat.outcomeSide}`,
    `💧 Min Liquidity: ${fmtVal(strat.minLiquidity)}`,
    `📊 Min Volume: ${fmtVal(strat.minVolume)}`,
    `💸 Per Market Max: ${fmtVal(strat.maxSpendPerMarket)}`,
    `💸 Total Max: ${fmtVal(strat.maxSpendTotal)}`,
    `📅 Max Daily Loss: ${fmtVal(strat.maxDailyLoss)}`,
    `🔔 Notifications: ${onOff(strat.notificationsEnabled)}`,
  ];

  const id = strat.id;
  const toggleBtn = strat.isPaused
    ? Markup.button.callback('▶️ Start', `bpm_start_${id}`)
    : Markup.button.callback('⏹ Pause', `bpm_pause_${id}`);

  const buttons = [
    [toggleBtn],
    [
      Markup.button.callback('💰 Budget', `bpm_budget_${id}`),
      Markup.button.callback('💵 Amount', `bpm_amount_${id}`),
      Markup.button.callback('🎯 Probability', `bpm_prob_${id}`),
    ],
    [
      Markup.button.callback('⏰ Window', `bpm_window_${id}`),
      Markup.button.callback('📊 Max Pos', `bpm_maxpos_${id}`),
      Markup.button.callback('⚡ Slippage', `bpm_slip_${id}`),
    ],
    [
      Markup.button.callback('📡 Interval', `bpm_interval_${id}`),
      Markup.button.callback('🎲 Side', `bpm_side_${id}`),
    ],
    [
      Markup.button.callback('🏈 Sports', `bpm_sports_${id}`),
      Markup.button.callback('₿ Crypto', `bpm_crypto_${id}`),
    ],
    [
      Markup.button.callback('💧 Liquidity', `bpm_liq_${id}`),
      Markup.button.callback('📊 Volume', `bpm_vol_${id}`),
    ],
    [
      Markup.button.callback('💸 Mkt Max', `bpm_mktmax_${id}`),
      Markup.button.callback('💸 Total Max', `bpm_totmax_${id}`),
    ],
    [
      Markup.button.callback('📅 Loss Limit', `bpm_loss_${id}`),
      Markup.button.callback('🔔 Notify', `bpm_notify_${id}`),
    ],
    [
      Markup.button.callback('✏️ Rename', `bpm_rename_${id}`),
      Markup.button.callback('🗑 Delete', `bpm_del_${id}`),
    ],
    [Markup.button.callback('← Back to List', 'bond_list')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ─── Manage Page Actions ────────────────────────────────────────────────────

export async function handleManageStart(ctx: Context, id: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyBondOwnership(ctx, id);
  if (!strat) return;
  await prisma.bondStrategy.update({ where: { id }, data: { isPaused: false } });
  await handleBondManage(ctx, id);
}

export async function handleManagePause(ctx: Context, id: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyBondOwnership(ctx, id);
  if (!strat) return;
  await prisma.bondStrategy.update({ where: { id }, data: { isPaused: true } });
  await handleBondManage(ctx, id);
}

export async function handleManageToggleSports(ctx: Context, id: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyBondOwnership(ctx, id);
  if (!strat) return;
  await prisma.bondStrategy.update({ where: { id }, data: { includeSports: !strat.includeSports } });
  await handleBondManage(ctx, id);
}

export async function handleManageToggleCrypto(ctx: Context, id: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyBondOwnership(ctx, id);
  if (!strat) return;
  await prisma.bondStrategy.update({ where: { id }, data: { includeCryptoUpDown: !strat.includeCryptoUpDown } });
  await handleBondManage(ctx, id);
}

export async function handleManageToggleNotify(ctx: Context, id: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyBondOwnership(ctx, id);
  if (!strat) return;
  await prisma.bondStrategy.update({ where: { id }, data: { notificationsEnabled: !strat.notificationsEnabled } });
  await handleBondManage(ctx, id);
}

export async function handleManageCycleSide(ctx: Context, id: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyBondOwnership(ctx, id);
  if (!strat) return;
  const sides = ['auto', 'yes', 'no'];
  const idx = sides.indexOf(strat.outcomeSide);
  const next = sides[(idx + 1) % sides.length];
  await prisma.bondStrategy.update({ where: { id }, data: { outcomeSide: next } });
  await handleBondManage(ctx, id);
}

// Edit field prompts
export async function handleManageEditPrompt(
  ctx: Context,
  id: string,
  step: BondEditState['step'],
  prompt: string,
): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  bondEditState.set(telegramId, { step, stratId: id, timestamp: Date.now() });

  await sendHtml(ctx, prompt, Markup.inlineKeyboard([
    [Markup.button.callback('← Cancel', `bond_task_${id}`)],
  ]));
}

// Delete
export async function handleManageDelete(ctx: Context, id: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendHtml(ctx,
    `⚠️ <b>Delete Strategy</b>\n\nAre you sure? This cannot be undone.`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🗑 Yes, Delete', `bpm_deldo_${id}`),
        Markup.button.callback('← Cancel', `bond_task_${id}`),
      ],
    ]),
  );
}

export async function handleManageDeleteExecute(ctx: Context, id: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyBondOwnership(ctx, id);
  if (!strat) return;
  await prisma.bondStrategy.delete({ where: { id } }).catch(() => {});
  await handleBondList(ctx);
}

// Rename prompt
export async function handleManageRename(ctx: Context, id: string): Promise<void> {
  await handleManageEditPrompt(ctx, id, 'awaiting_rename',
    `✏️ <b>Rename Strategy</b>\n\nEnter a new name:`);
}

// ─── Edit Text Input Handler ────────────────────────────────────────────────

export async function handleBondEditInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;

  const state = await bondEditState.get(telegramId);
  if (!state) return false;

  // Verify ownership before any update
  const owned = await verifyBondOwnership(ctx, state.stratId);
  if (!owned) {
    bondEditState.delete(telegramId);
    await ctx.reply('❌ Strategy not found.');
    return true;
  }

  const num = parseNumber(text);
  const id = state.stratId;

  try {
    switch (state.step) {
      case 'awaiting_budget': {
        if (num == null || num < 1 || num > 100_000) {
          await ctx.reply('❌ Enter $1–$100,000.');
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { dailyBudget: num } });
        break;
      }
      case 'awaiting_amount': {
        if (num == null || num < 1 || num > 10_000) {
          await ctx.reply('❌ Enter $1–$10,000.');
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { fixedAmount: num } });
        break;
      }
      case 'awaiting_slippage': {
        if (num == null || num < 0.1 || num > 50) {
          await ctx.reply('❌ Enter 0.1%–50%.');
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { slippage: num } });
        break;
      }
      case 'awaiting_min_prob': {
        if (num == null || num < 50 || num > 99) {
          await ctx.reply('❌ Enter 50–99.');
          return true;
        }
        const stratForMin = await prisma.bondStrategy.findUnique({ where: { id }, select: { maxProbability: true } });
        if (stratForMin && num > stratForMin.maxProbability) {
          await ctx.reply(`❌ Min probability must be <= max probability (${stratForMin.maxProbability}%).`);
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { minProbability: num } });
        break;
      }
      case 'awaiting_max_prob': {
        if (num == null || num < 50 || num > 100) {
          await ctx.reply('❌ Enter 50–100.');
          return true;
        }
        const stratForMax = await prisma.bondStrategy.findUnique({ where: { id }, select: { minProbability: true } });
        if (stratForMax && num < stratForMax.minProbability) {
          await ctx.reply(`❌ Max probability must be >= min probability (${stratForMax.minProbability}%).`);
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { maxProbability: num } });
        break;
      }
      case 'awaiting_window': {
        if (num == null || num < 1 || num > 168) {
          await ctx.reply('❌ Enter 1–168 hours.');
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { maxHoursOut: Math.round(num) } });
        break;
      }
      case 'awaiting_max_pos': {
        if (num == null || num < 1 || num > 50) {
          await ctx.reply('❌ Enter 1–50.');
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { maxConcurrent: Math.round(num) } });
        break;
      }
      case 'awaiting_interval': {
        if (num == null || num < 1 || num > 10) {
          await ctx.reply('❌ Enter 1–10 minutes.');
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { scanInterval: Math.round(num) } });
        break;
      }
      case 'awaiting_min_liq': {
        if (num == null || num < 0) {
          await ctx.reply('❌ Enter a valid amount.');
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { minLiquidity: num || null } });
        break;
      }
      case 'awaiting_min_vol': {
        if (num == null || num < 0) {
          await ctx.reply('❌ Enter a valid amount.');
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { minVolume: num || null } });
        break;
      }
      case 'awaiting_mkt_max': {
        if (num == null || num < 1) {
          await ctx.reply('❌ Enter min $1.');
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { maxSpendPerMarket: num } });
        break;
      }
      case 'awaiting_total_max': {
        if (num == null || num < 1) {
          await ctx.reply('❌ Enter min $1.');
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { maxSpendTotal: num } });
        break;
      }
      case 'awaiting_loss_limit': {
        if (num == null || num < 1) {
          await ctx.reply('❌ Enter min $1.');
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { maxDailyLoss: num } });
        break;
      }
      case 'awaiting_rename': {
        const name = text.trim().slice(0, 30);
        if (!name) {
          await ctx.reply('❌ Enter a name (max 30 chars).');
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { label: name } });
        break;
      }
      default:
        return false;
    }

    bondEditState.delete(telegramId);
    await handleBondManage(ctx, id);
    return true;
  } catch (err: any) {
    logger.error(`[bond] Edit error: ${err?.message}`);
    await ctx.reply('❌ Failed to update. Please try again.');
    return true;
  }
}
