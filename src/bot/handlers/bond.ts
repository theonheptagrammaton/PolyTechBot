import { Context, Markup } from 'telegraf';
import { prisma } from '../../database/prisma';
import { logger } from '../../utils/logger';
import { getUserByTelegramId } from '../../services/user';
import { sendPage } from '../../utils/telegram';
import { esc } from '../../utils/customEmoji';
import { RedisBackedState } from '../../utils/redisState';
import { t, Locale } from '../../i18n';

function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** sendPage wrapper that forces HTML parse mode */
function sendHtml(ctx: Context, text: string, markup?: any) {
  return sendPage(ctx, text, { ...(markup ?? {}), parse_mode: 'HTML' });
}

const MAX_STRATEGIES = 20;
const STATE_TTL_MS = 10 * 60 * 1000;

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

const _bondAddCleanup = setInterval(() => {
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
      | 'awaiting_tp_pct' | 'awaiting_sl_pct'
      | 'awaiting_tp_price' | 'awaiting_sl_price'
      | 'awaiting_rename';
  stratId: string;
  timestamp: number;
}

export const bondEditState = new RedisBackedState<BondEditState>('bondEdit', 600);

const _bondEditCleanup = setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, state] of bondEditState.entries()) {
    if (state.timestamp < cutoff) bondEditState.delete(key);
  }
}, 30 * 60 * 1000);

/** Stop state cleanup intervals (call on bot shutdown) */
export function stopBondCleanup(): void {
  clearInterval(_bondAddCleanup);
  clearInterval(_bondEditCleanup);
}

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
  const lang = user ? getLang(user) : (((ctx as any).userLanguage as Locale) || 'en');
  if (!user) { await ctx.reply(t(lang, 'common.userNotFoundStart')); return; }

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
    `🤖 <b>${t(lang, 'Bond Trading')}</b>`,
    ``,
  ];

  if (strategies.length === 0) {
    lines.push(t(lang, 'No bond strategies yet.'));
    lines.push(t(lang, 'Tap <b>Add</b> to create your first strategy.'));
  } else {
    const running = strategies.filter(s => s.isActive && !s.isPaused).length;

    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      const statusDot = s.isActive && !s.isPaused ? '🟢' : '🔴';
      const name = s.label || `${t(lang, 'Strategy')}-${i + 1}`;

      // Calculate stats from trades
      const filledTrades = s.trades || [];
      const totalSpent = filledTrades.reduce((sum, t) => sum + t.amount, 0);
      const tradeCount = filledTrades.length;
      // Optimistic upper bound: assumes every position resolves in user's favor (shares × $1).
      // Actual realized PnL would require tpSlStatus + redemption tracking.
      const maxPotential = filledTrades.reduce((sum, t) => {
        return sum + (t.price > 0 ? t.amount * (1 / t.price - 1) : 0);
      }, 0);
      const potentialStr = maxPotential >= 0 ? `+$${maxPotential.toFixed(2)}` : `-$${Math.abs(maxPotential).toFixed(2)}`;

      // Today's trades — use UTC date boundary so it matches the daily-budget redis keys
      const todayUtc = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
      const todayTrades = filledTrades.filter(t => new Date(t.createdAt).toISOString().slice(0, 10) === todayUtc).length;

      lines.push(
        `${i + 1}. ${statusDot} 🎯 <b>${esc(name)}</b>\n` +
        `├ ${t(lang, 'Mode')}: 📊 ${s.minProbability.toFixed(1)}%–${s.maxProbability.toFixed(1)}% · <b>$${s.fixedAmount.toFixed(2)}</b>\n` +
        `├ ${t(lang, 'Max Potential')}: <b>${potentialStr}</b> · ${t(lang, 'Trades Filled')}: ${tradeCount}\n` +
        `├ ${t(lang, "Today's Trades")}: <b>${todayTrades}</b>\n` +
        `└ ${t(lang, 'Spent')}: <b>$${totalSpent.toFixed(2)}</b>`
      );
      lines.push(``);
    }

    lines.push(`⚡ ${t(lang, 'Status')}: ${running}/${strategies.length} ${t(lang, 'tasks running.')}`);
  }

  const buttons: any[][] = [];

  // Per-strategy action buttons (Start · Edit · Share style)
  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    const id = s.id;
    const isRunning = s.isActive && !s.isPaused;
    buttons.push([
      Markup.button.callback(
        isRunning ? `⏹ ${t(lang, 'Stop')} ${i + 1}` : `▶️ ${t(lang, 'Start')} ${i + 1}`,
        isRunning ? `bpm_pause_${id}` : `bpm_start_${id}`
      ),
      Markup.button.callback(`✏️ ${t(lang, 'Edit')} ${i + 1}`, `bond_task_${id}`),
    ]);
  }

  // Controls row
  buttons.push([
    Markup.button.callback(`➕ ${t(lang, 'Add')}`, 'bond_start_add'),
    Markup.button.callback(`🗑 ${t(lang, 'Remove')}`, 'bond_remove_prompt'),
  ]);

  if (strategies.length > 0) {
    buttons.push([
      Markup.button.callback(`▶️ ${t(lang, 'Start All')}`, 'bond_start_all'),
      Markup.button.callback(`⏹ ${t(lang, 'Stop All')}`, 'bond_stop_all'),
    ]);
    buttons.push([
      Markup.button.callback(`📜 ${t(lang, 'History')}`, 'bond_history_10'),
      Markup.button.callback(`🗑 ${t(lang, 'Delete All')}`, 'bond_del_all_cfm'),
    ]);
  }

  buttons.push([
    Markup.button.callback(`← ${t(lang, 'Auto Strategies')}`, 'auto_strategies'),
    Markup.button.callback(`× ${t(lang, 'Close')}`, 'bond_close'),
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

  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  const text = `⚠️ <b>${t(lang, 'Delete All Strategies')}</b>\n\n${t(lang, 'This will permanently delete all your bond strategies. Are you sure?')}`;
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`🗑 ${t(lang, 'Yes, Delete All')}`, 'bond_del_all_do'),
      Markup.button.callback(`← ${t(lang, 'Cancel')}`, 'bond_list'),
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

  const lang = getLang(user);

  try {
    // Delete trades first, then strategies (FK constraint)
    const stratIds = await prisma.bondStrategy.findMany({
      where: { userId: user.id },
      select: { id: true },
    });
    if (stratIds.length > 0) {
      await prisma.bondTrade.deleteMany({
        where: { strategyId: { in: stratIds.map(s => s.id) } },
      });
    }
    await prisma.bondStrategy.deleteMany({ where: { userId: user.id } });
  } catch (err: any) {
    logger.error(`[bond] Failed to delete all strategies: ${err?.message}`);
    await sendHtml(ctx, t(lang, 'Failed to delete strategies. Please try again.'));
    return;
  }
  await handleBondList(ctx);
}

// ─── Remove Single ──────────────────────────────────────────────────────────

export async function handleBondRemovePrompt(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) { await ctx.answerCbQuery().catch(() => {}); return; }
  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.answerCbQuery().catch(() => {}); return; }

  const lang = getLang(user);

  const strategies = await prisma.bondStrategy.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });

  if (strategies.length === 0) {
    await ctx.answerCbQuery(t(lang, 'No strategies to remove')).catch(() => {});
    return;
  }
  await ctx.answerCbQuery().catch(() => {});

  const buttons = strategies.map((s, i) => [
    Markup.button.callback(
      `🗑 ${s.label || `${t(lang, 'Strategy')}-${i + 1}`}`,
      `bond_rm_${s.id}`
    ),
  ]);
  buttons.push([Markup.button.callback(`← ${t(lang, 'Back')}`, 'bond_list')]);

  await sendHtml(ctx,
    `🗑 <b>${t(lang, 'Remove Strategy')}</b>\n\n${t(lang, 'Select a strategy to remove:')}`,
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

  const lang = getLang(user);

  const trades = await prisma.bondTrade.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { strategy: { select: { label: true } } },
  });

  if (trades.length === 0) {
    await sendHtml(ctx,
      `📜 <b>${t(lang, 'Bond Trade History')}</b>\n\n${t(lang, 'No trades yet.')}`,
      Markup.inlineKeyboard([[Markup.button.callback(`← ${t(lang, 'Back')}`, 'bond_list')]]),
    );
    return;
  }

  const lines = [`📜 <b>${t(lang, 'Bond Trade History')}</b> (${t(lang, 'last')} ${trades.length})\n`];
  for (const tr of trades) {
    const icon = tr.status === 'filled' ? '✅' : tr.status === 'failed' ? '❌' : '⏳';
    const pct = (tr.probability * 100).toFixed(1);
    const q = tr.question.length > 50 ? tr.question.slice(0, 47) + '...' : tr.question;
    const stratLabel = (tr as any).strategy?.label ? ` [${esc((tr as any).strategy.label)}]` : '';
    lines.push(`${icon} ${esc(q)}\n   ${tr.outcome} @ ${pct}% · $${tr.amount.toFixed(2)}${stratLabel}`);
  }

  await sendHtml(ctx,
    lines.join('\n'),
    Markup.inlineKeyboard([[Markup.button.callback(`← ${t(lang, 'Back')}`, 'bond_list')]]),
  );
}

// ─── Close ──────────────────────────────────────────────────────────────────

export async function handleBondClose(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
}

// ─── Add Flow ───────────────────────────────────────────────────────────────

export async function handleBondStartAdd(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) { await ctx.answerCbQuery().catch(() => {}); return; }
  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.answerCbQuery().catch(() => {}); return; }

  const lang = getLang(user);

  const count = await prisma.bondStrategy.count({ where: { userId: user.id } });
  if (count >= MAX_STRATEGIES) {
    await ctx.answerCbQuery(t(lang, 'Max {{max}} strategies reached', { max: MAX_STRATEGIES })).catch(() => {});
    await sendHtml(ctx, t(lang, 'Maximum {{max}} strategies reached. Delete one first.', { max: MAX_STRATEGIES }));
    return;
  }
  await ctx.answerCbQuery().catch(() => {});

  bondAddState.set(telegramId, {
    step: 'name',
    timestamp: Date.now(),
  });

  await sendHtml(ctx,
    `✏️ <b>${t(lang, 'Step 1/7: Strategy Name')}</b>\n\n` +
    t(lang, 'Give your strategy a name (e.g. "Safe Bonds", "High Prob Scanner"):'),
    Markup.inlineKeyboard([
      [Markup.button.callback(`← ${t(lang, 'Cancel')}`, 'bond_list')],
    ]),
  );
}

// Step 2: Daily Budget
async function showDailyBudgetStep(ctx: Context): Promise<void> {
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  await sendHtml(ctx,
    `💰 <b>${t(lang, 'Step 2/7: Daily Budget')}</b>\n\n` +
    t(lang, 'How much USDC per day should this strategy spend?') + `\n\n` +
    t(lang, 'Enter an amount (e.g. 50, 100, 200):'),
    Markup.inlineKeyboard([
      [Markup.button.callback(`← ${t(lang, 'Cancel')}`, 'bond_list')],
    ]),
  );
}

// Step 3: Min probability
async function showMinProbStep(ctx: Context): Promise<void> {
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  await sendHtml(ctx,
    `🎯 <b>${t(lang, 'Step 3/7: Min Probability')}</b>\n\n` +
    t(lang, 'Only buy markets where the winning side is at least this likely.') + `\n\n` +
    t(lang, 'Choose a preset or enter custom:'),
    Markup.inlineKeyboard([
      [
        Markup.button.callback('90%', 'bond_add_prob_90'),
        Markup.button.callback('93%', 'bond_add_prob_93'),
        Markup.button.callback('95%', 'bond_add_prob_95'),
        Markup.button.callback('97%', 'bond_add_prob_97'),
      ],
      [Markup.button.callback(`✏️ ${t(lang, 'Custom')}`, 'bond_add_prob_custom')],
      [Markup.button.callback(`← ${t(lang, 'Cancel')}`, 'bond_list')],
    ]),
  );
}

// Step 3: Time window
async function showTimeWindowStep(ctx: Context): Promise<void> {
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  await sendHtml(ctx,
    `⏰ <b>${t(lang, 'Step 4/7: Time Window')}</b>\n\n` +
    t(lang, 'Only buy markets that expire within this many hours.') + `\n\n` +
    t(lang, 'Choose a preset or enter custom:'),
    Markup.inlineKeyboard([
      [
        Markup.button.callback('12h', 'bond_add_hours_12'),
        Markup.button.callback('24h', 'bond_add_hours_24'),
        Markup.button.callback('48h', 'bond_add_hours_48'),
        Markup.button.callback('72h', 'bond_add_hours_72'),
      ],
      [Markup.button.callback(`✏️ ${t(lang, 'Custom')}`, 'bond_add_hours_custom')],
      [Markup.button.callback(`← ${t(lang, 'Cancel')}`, 'bond_list')],
    ]),
  );
}

// Step 4: Max concurrent
async function showMaxConcurrentStep(ctx: Context): Promise<void> {
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  await sendHtml(ctx,
    `📊 <b>${t(lang, 'Step 5/7: Max Concurrent Positions')}</b>\n\n` +
    t(lang, 'Maximum number of open bond positions at once.'),
    Markup.inlineKeyboard([
      [
        Markup.button.callback('2', 'bond_add_conc_2'),
        Markup.button.callback('5', 'bond_add_conc_5'),
        Markup.button.callback('10', 'bond_add_conc_10'),
      ],
      [Markup.button.callback(`✏️ ${t(lang, 'Custom')}`, 'bond_add_conc_custom')],
      [Markup.button.callback(`← ${t(lang, 'Cancel')}`, 'bond_list')],
    ]),
  );
}

// Step 5: Market types
async function showMarketsFilterStep(ctx: Context): Promise<void> {
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  await sendHtml(ctx,
    `🏈 <b>${t(lang, 'Step 6/7: Market Types')}</b>\n\n` +
    t(lang, 'Include sports and/or short-term crypto up/down markets?'),
    Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, 'Neither'), 'bond_add_mkt_none')],
      [Markup.button.callback(`🏈 ${t(lang, 'Sports Only')}`, 'bond_add_mkt_sports')],
      [Markup.button.callback(`₿ ${t(lang, 'Crypto Only')}`, 'bond_add_mkt_crypto')],
      [Markup.button.callback(t(lang, 'Both'), 'bond_add_mkt_both')],
      [Markup.button.callback(`← ${t(lang, 'Cancel')}`, 'bond_list')],
    ]),
  );
}

// Step 6: Review
async function showReviewStep(ctx: Context, state: BondAddState): Promise<void> {
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  const lines = [
    `📋 <b>${t(lang, 'Step 7/7: Review')}</b>\n`,
    `✏️ ${t(lang, 'Name')}: <b>${esc(state.name || t(lang, 'Strategy'))}</b>`,
    `💰 ${t(lang, 'Daily Budget')}: $${state.dailyBudget ?? 100}`,
    `💵 ${t(lang, 'Amount/Trade')}: $${state.fixedAmount ?? 25}`,
    `🎯 ${t(lang, 'Min Probability')}: ${(state.minProbability ?? 95).toFixed(1)}%`,
    `🎯 ${t(lang, 'Max Probability')}: ${(state.maxProbability ?? 99).toFixed(1)}%`,
    `⏰ ${t(lang, 'Time Window')}: ${state.maxHoursOut ?? 48}h`,
    `📊 ${t(lang, 'Max Positions')}: ${state.maxConcurrent ?? 5}`,
    `🏈 ${t(lang, 'Sports')}: ${state.includeSports ? '✅' : '❌'}  |  ₿ ${t(lang, 'Crypto')}: ${state.includeCryptoUpDown ? '✅' : '❌'}`,
    `⚡ ${t(lang, 'Slippage')}: ${state.slippage ?? 5}%`,
    `📡 ${t(lang, 'Scan')}: ${state.scanInterval ?? 5}min`,
    `🎲 ${t(lang, 'Side')}: ${state.outcomeSide ?? 'auto'}`,
  ];

  if (state.minLiquidity != null) lines.push(`💧 ${t(lang, 'Min Liquidity')}: $${state.minLiquidity}`);
  if (state.minVolume != null) lines.push(`📊 ${t(lang, 'Min Volume')}: $${state.minVolume}`);
  if (state.maxSpendPerMarket != null) lines.push(`💸 ${t(lang, 'Per Market Max')}: $${state.maxSpendPerMarket}`);
  if (state.maxSpendTotal != null) lines.push(`💸 ${t(lang, 'Total Max')}: $${state.maxSpendTotal}`);
  if (state.maxDailyLoss != null) lines.push(`📅 ${t(lang, 'Max Daily Loss')}: $${state.maxDailyLoss}`);

  lines.push(`🔔 ${t(lang, 'Notifications')}: ${t(lang, 'On')}`);

  // Consistency warnings
  const fa = state.fixedAmount ?? 25;
  const db = state.dailyBudget ?? 100;
  if (fa > db) {
    lines.push(`\n⚠️ ${t(lang, 'Amount/trade (${{fa}}) exceeds daily budget (${{db}}).', { fa: String(fa), db: String(db) })}`);
  }
  const mspm = state.maxSpendPerMarket;
  if (mspm != null && mspm < fa) {
    lines.push(`⚠️ ${t(lang, 'Per-market max (${{mspm}}) is less than amount/trade (${{fa}}).', { mspm: String(mspm), fa: String(fa) })}`);
  }

  lines.push(`\n${t(lang, 'Strategy starts <b>paused</b>. Start it from the manage page.')}`);

  await sendHtml(ctx,
    lines.join('\n'),
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`✅ ${t(lang, 'Confirm')}`, 'bond_add_confirm'),
        Markup.button.callback(`⚙️ ${t(lang, 'Advanced')}`, 'bond_add_advanced'),
      ],
      [Markup.button.callback(`← ${t(lang, 'Cancel')}`, 'bond_list')],
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
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  await sendHtml(ctx,
    `🎯 <b>${t(lang, 'Custom Min Probability')}</b>\n\n${t(lang, 'Enter a value between 50 and 99:')}`,
    Markup.inlineKeyboard([[Markup.button.callback(`← ${t(lang, 'Cancel')}`, 'bond_list')]]),
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
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  await sendHtml(ctx,
    `⏰ <b>${t(lang, 'Custom Time Window')}</b>\n\n${t(lang, 'Enter hours (1–168):')}`,
    Markup.inlineKeyboard([[Markup.button.callback(`← ${t(lang, 'Cancel')}`, 'bond_list')]]),
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
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  await sendHtml(ctx,
    `📊 <b>${t(lang, 'Custom Max Positions')}</b>\n\n${t(lang, 'Enter a number (1–50):')}`,
    Markup.inlineKeyboard([[Markup.button.callback(`← ${t(lang, 'Cancel')}`, 'bond_list')]]),
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
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  const lines = [
    `⚙️ <b>${t(lang, 'Advanced Settings')}</b>\n`,
    `💵 ${t(lang, 'Amount/Trade')}: $${state.fixedAmount ?? 25}`,
    `⚡ ${t(lang, 'Slippage')}: ${state.slippage ?? 5}%`,
    `💧 ${t(lang, 'Min Liquidity')}: ${state.minLiquidity != null ? '$' + state.minLiquidity : '–'}`,
    `📊 ${t(lang, 'Min Volume')}: ${state.minVolume != null ? '$' + state.minVolume : '–'}`,
    `💸 ${t(lang, 'Per Market Max')}: ${state.maxSpendPerMarket != null ? '$' + state.maxSpendPerMarket : '–'}`,
    `💸 ${t(lang, 'Total Max')}: ${state.maxSpendTotal != null ? '$' + state.maxSpendTotal : '–'}`,
    `📅 ${t(lang, 'Max Daily Loss')}: ${state.maxDailyLoss != null ? '$' + state.maxDailyLoss : '–'}`,
    `🎯 ${t(lang, 'Max Probability')}: ${(state.maxProbability ?? 99).toFixed(1)}%`,
    `📡 ${t(lang, 'Scan Interval')}: ${state.scanInterval ?? 5}min`,
    `🎲 ${t(lang, 'Outcome Side')}: ${state.outcomeSide ?? 'auto'}`,
    `\n${t(lang, 'Tap a setting to change it:')}`,
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard([
    [
      Markup.button.callback(`💵 ${t(lang, 'Amount')}`, 'bond_adv_edit_amount'),
      Markup.button.callback(`⚡ ${t(lang, 'Slippage')}`, 'bond_adv_edit_slippage'),
    ],
    [
      Markup.button.callback(`💧 ${t(lang, 'Min Liq')}`, 'bond_adv_edit_min_liq'),
      Markup.button.callback(`📊 ${t(lang, 'Min Vol')}`, 'bond_adv_edit_min_vol'),
    ],
    [
      Markup.button.callback(`💸 ${t(lang, 'Mkt Max')}`, 'bond_adv_edit_mkt_max'),
      Markup.button.callback(`💸 ${t(lang, 'Total Max')}`, 'bond_adv_edit_total_max'),
    ],
    [
      Markup.button.callback(`📅 ${t(lang, 'Loss Limit')}`, 'bond_adv_edit_loss'),
      Markup.button.callback(`🎯 ${t(lang, 'Max Prob')}`, 'bond_adv_edit_max_prob'),
    ],
    [
      Markup.button.callback(`📡 ${t(lang, 'Scan Int.')}`, 'bond_adv_edit_scan'),
      Markup.button.callback(`🎲 ${t(lang, 'Side')}`, 'bond_adv_edit_side'),
    ],
    [Markup.button.callback(`← ${t(lang, 'Back to Review')}`, 'bond_adv_back_review')],
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

  const lang = ((ctx as any).userLanguage as Locale) || 'en';

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
      [Markup.button.callback(`← ${t(lang, 'Back')}`, 'bond_add_advanced')],
    ]));
    return;
  }

  const step = stepMap[field];
  if (!step) return;

  state.step = step;
  state.timestamp = Date.now();
  bondAddState.set(telegramId, state);

  const prompt = ADV_PROMPTS[step] || `${t(lang, 'Enter value:')}`;
  await sendHtml(ctx, prompt, Markup.inlineKeyboard([
    [Markup.button.callback(`← ${t(lang, 'Back')}`, 'bond_add_advanced')],
  ]));
}

// ─── Confirm Add ────────────────────────────────────────────────────────────

export async function handleBondConfirmAdd(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) { await ctx.answerCbQuery().catch(() => {}); return; }

  const lang = ((ctx as any).userLanguage as Locale) || 'en';

  const state = await bondAddState.get(telegramId);
  if (!state) {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(t(lang, 'Session expired. Try again.'));
    return;
  }

  // Cross-validate probability range
  const minProb = state.minProbability ?? 95;
  const maxProb = state.maxProbability ?? 99;
  if (maxProb < minProb) {
    await ctx.answerCbQuery(t(lang, 'Invalid probability range')).catch(() => {});
    await sendHtml(ctx,
      `⚠️ <b>${t(lang, 'Invalid Settings')}</b>\n\n` +
      t(lang, 'Max Probability ({{max}}%) cannot be less than Min Probability ({{min}}%).', { max: String(maxProb), min: String(minProb) }) + `\n` +
      t(lang, 'Please adjust in Advanced Settings.'),
      Markup.inlineKeyboard([
        [Markup.button.callback(`⚙️ ${t(lang, 'Advanced')}`, 'bond_add_advanced')],
        [Markup.button.callback(`← ${t(lang, 'Cancel')}`, 'bond_list')],
      ]),
    );
    return;
  }

  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.answerCbQuery().catch(() => {}); return; }

  // Use transaction to prevent race condition on MAX_STRATEGIES
  let created: any;
  try {
    created = await prisma.$transaction(async (tx) => {
      const count = await tx.bondStrategy.count({ where: { userId: user.id } });
      if (count >= MAX_STRATEGIES) return null;
      return tx.bondStrategy.create({
        data: {
          userId: user.id,
          label: state.name || t(lang, 'Strategy'),
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
  } catch (err: any) {
    logger.error(`[bond] Failed to create strategy: ${err?.message}`);
    await sendHtml(ctx, t(lang, 'Failed to create strategy. Please try again.'));
    return;
  }

  if (!created) {
    await sendHtml(ctx, t(lang, 'Maximum {{max}} strategies reached. Delete one first.', { max: MAX_STRATEGIES }));
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

  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  const num = parseNumber(text);

  switch (state.step) {
    case 'name': {
      const name = text.trim();
      if (!name || name.length < 1 || name.length > 32) {
        await ctx.reply(t(lang, 'Enter a name (1–32 characters).'));
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
        await ctx.reply(t(lang, 'Enter a valid amount ($1–$100,000).'));
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
        await ctx.reply(t(lang, 'Enter a value between 50 and 99.'));
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
        await ctx.reply(t(lang, 'Enter hours between 1 and 168.'));
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
        await ctx.reply(t(lang, 'Enter a number between 1 and 50.'));
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
        await ctx.reply(t(lang, 'Enter a valid amount ($1–$10,000).'));
        return true;
      }
      state.fixedAmount = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_slippage': {
      if (num == null || num < 0.1 || num > 50) {
        await ctx.reply(t(lang, 'Enter slippage between 0.1% and 50%.'));
        return true;
      }
      state.slippage = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_min_liq': {
      if (num == null || num < 0) {
        await ctx.reply(t(lang, 'Enter a valid amount.'));
        return true;
      }
      state.minLiquidity = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_min_vol': {
      if (num == null || num < 0) {
        await ctx.reply(t(lang, 'Enter a valid amount.'));
        return true;
      }
      state.minVolume = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_max_spend_market': {
      if (num == null || num < 1) {
        await ctx.reply(t(lang, 'Enter a valid amount (min $1).'));
        return true;
      }
      state.maxSpendPerMarket = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_max_spend_total': {
      if (num == null || num < 1) {
        await ctx.reply(t(lang, 'Enter a valid amount (min $1).'));
        return true;
      }
      state.maxSpendTotal = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_max_daily_loss': {
      if (num == null || num < 1) {
        await ctx.reply(t(lang, 'Enter a valid amount (min $1).'));
        return true;
      }
      state.maxDailyLoss = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_max_prob': {
      if (num == null || num < 50 || num > 100) {
        await ctx.reply(t(lang, 'Enter a value between 50 and 100.'));
        return true;
      }
      const minP = state.minProbability ?? 95;
      if (num < minP) {
        await ctx.reply(t(lang, 'Max probability must be >= min probability ({{min}}%).', { min: String(minP) }));
        return true;
      }
      state.maxProbability = num;
      return advanceAdvStep(telegramId, state, ctx);
    }

    case 'adv_scan_interval': {
      if (num == null || num < 1 || num > 10) {
        await ctx.reply(t(lang, 'Enter minutes between 1 and 10.'));
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

  const lang = ((ctx as any).userLanguage as Locale) || 'en';

  const strat = await verifyBondOwnership(ctx, stratId);
  if (!strat) {
    await ctx.reply(t(lang, 'Strategy not found.'));
    return;
  }

  const statusStr = strat.isActive && !strat.isPaused ? `🟢 ${t(lang, 'Running')}` : `🔴 ${t(lang, 'Paused')}`;
  const name = strat.label || strat.id.slice(0, 8);

  const lines = [
    `⚙️ <b>${t(lang, 'Strategy')}: ${esc(name)}</b>\n`,
    `📊 ${t(lang, 'Status')}: ${statusStr}`,
    `💰 ${t(lang, 'Daily Budget')}: $${strat.dailyBudget}`,
    `💵 ${t(lang, 'Amount/Trade')}: $${strat.fixedAmount}`,
    `🎯 ${t(lang, 'Min Probability')}: ${strat.minProbability.toFixed(1)}%`,
    `🎯 ${t(lang, 'Max Probability')}: ${strat.maxProbability.toFixed(1)}%`,
    `⏰ ${t(lang, 'Time Window')}: ${strat.maxHoursOut}h`,
    `📊 ${t(lang, 'Max Positions')}: ${strat.maxConcurrent}`,
    `🏈 ${t(lang, 'Sports')}: ${strat.includeSports ? '✅' : '❌'}  |  ₿ ${t(lang, 'Crypto')}: ${strat.includeCryptoUpDown ? '✅' : '❌'}`,
    `⚡ ${t(lang, 'Slippage')}: ${strat.slippage}%`,
    `📡 ${t(lang, 'Scan')}: ${strat.scanInterval}min`,
    `🎲 ${t(lang, 'Side')}: ${strat.outcomeSide}`,
    `💧 ${t(lang, 'Min Liquidity')}: ${fmtVal(strat.minLiquidity)}`,
    `📊 ${t(lang, 'Min Volume')}: ${fmtVal(strat.minVolume)}`,
    `💸 ${t(lang, 'Per Market Max')}: ${fmtVal(strat.maxSpendPerMarket)}`,
    `💸 ${t(lang, 'Total Max')}: ${fmtVal(strat.maxSpendTotal)}`,
    `📅 ${t(lang, 'Max Daily Loss')}: ${fmtVal(strat.maxDailyLoss)}`,
    `🏆 ${t(lang, 'Take Profit')}: ${strat.takeProfitPct != null ? `+${strat.takeProfitPct}%` : (strat.takeProfitPrice != null ? `${strat.takeProfitPrice}¢` : '–')}`,
    `🛑 ${t(lang, 'Stop Loss')}: ${strat.stopLossPct != null ? `−${strat.stopLossPct}%` : (strat.stopLossPrice != null ? `${strat.stopLossPrice}¢` : '–')}`,
    `🔔 ${t(lang, 'Notifications')}: ${onOff(strat.notificationsEnabled)}`,
  ];

  const id = strat.id;
  const toggleBtn = strat.isPaused
    ? Markup.button.callback(`▶️ ${t(lang, 'Start')}`, `bpm_start_${id}`)
    : Markup.button.callback(`⏹ ${t(lang, 'Pause')}`, `bpm_pause_${id}`);

  const buttons = [
    [toggleBtn],
    [
      Markup.button.callback(`💰 ${t(lang, 'Budget')}`, `bpm_budget_${id}`),
      Markup.button.callback(`💵 ${t(lang, 'Amount')}`, `bpm_amount_${id}`),
    ],
    [
      Markup.button.callback(`🎯 ${t(lang, 'Min Prob')}`, `bpm_pmin_${id}`),
      Markup.button.callback(`🎯 ${t(lang, 'Max Prob')}`, `bpm_pmax_${id}`),
    ],
    [
      Markup.button.callback(`⏰ ${t(lang, 'Window')}`, `bpm_window_${id}`),
      Markup.button.callback(`📊 ${t(lang, 'Max Pos')}`, `bpm_maxpos_${id}`),
      Markup.button.callback(`⚡ ${t(lang, 'Slippage')}`, `bpm_slip_${id}`),
    ],
    [
      Markup.button.callback(`📡 ${t(lang, 'Interval')}`, `bpm_interval_${id}`),
      Markup.button.callback(`🎲 ${t(lang, 'Side')}`, `bpm_side_${id}`),
    ],
    [
      Markup.button.callback(`🏈 ${t(lang, 'Sports')}`, `bpm_sports_${id}`),
      Markup.button.callback(`₿ ${t(lang, 'Crypto')}`, `bpm_crypto_${id}`),
    ],
    [
      Markup.button.callback(`💧 ${t(lang, 'Liquidity')}`, `bpm_liq_${id}`),
      Markup.button.callback(`📊 ${t(lang, 'Volume')}`, `bpm_vol_${id}`),
    ],
    [
      Markup.button.callback(`💸 ${t(lang, 'Mkt Max')}`, `bpm_mktmax_${id}`),
      Markup.button.callback(`💸 ${t(lang, 'Total Max')}`, `bpm_totmax_${id}`),
    ],
    [
      Markup.button.callback(`📅 ${t(lang, 'Loss Limit')}`, `bpm_loss_${id}`),
      Markup.button.callback(`🔔 ${t(lang, 'Notify')}`, `bpm_notify_${id}`),
    ],
    [
      Markup.button.callback(`🏆 ${t(lang, 'TP %')}`, `bpm_tppct_${id}`),
      Markup.button.callback(`🏆 ${t(lang, 'TP ¢')}`, `bpm_tpprice_${id}`),
      Markup.button.callback(`✕`, `bpm_tpclear_${id}`),
    ],
    [
      Markup.button.callback(`🛑 ${t(lang, 'SL %')}`, `bpm_slpct_${id}`),
      Markup.button.callback(`🛑 ${t(lang, 'SL ¢')}`, `bpm_slprice_${id}`),
      Markup.button.callback(`✕`, `bpm_slclear_${id}`),
    ],
    [
      Markup.button.callback(`✏️ ${t(lang, 'Rename')}`, `bpm_rename_${id}`),
      Markup.button.callback(`🗑 ${t(lang, 'Delete')}`, `bpm_del_${id}`),
    ],
    [Markup.button.callback(`← ${t(lang, 'Back to List')}`, 'bond_list')],
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

  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  bondEditState.set(telegramId, { step, stratId: id, timestamp: Date.now() });

  await sendHtml(ctx, prompt, Markup.inlineKeyboard([
    [Markup.button.callback(`← ${t(lang, 'Cancel')}`, `bond_task_${id}`)],
  ]));
}

// TP/SL clear handlers
export async function handleManageClearTp(ctx: Context, id: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyBondOwnership(ctx, id);
  if (!strat) return;
  await prisma.bondStrategy.update({
    where: { id },
    data: { takeProfitPct: null, takeProfitPrice: null },
  });
  await handleBondManage(ctx, id);
}

export async function handleManageClearSl(ctx: Context, id: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyBondOwnership(ctx, id);
  if (!strat) return;
  await prisma.bondStrategy.update({
    where: { id },
    data: { stopLossPct: null, stopLossPrice: null },
  });
  await handleBondManage(ctx, id);
}

// Delete
export async function handleManageDelete(ctx: Context, id: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  await sendHtml(ctx,
    `⚠️ <b>${t(lang, 'Delete Strategy')}</b>\n\n${t(lang, 'Are you sure? This cannot be undone.')}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`🗑 ${t(lang, 'Yes, Delete')}`, `bpm_deldo_${id}`),
        Markup.button.callback(`← ${t(lang, 'Cancel')}`, `bond_task_${id}`),
      ],
    ]),
  );
}

export async function handleManageDeleteExecute(ctx: Context, id: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyBondOwnership(ctx, id);
  if (!strat) return;
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  try {
    await prisma.bondTrade.deleteMany({ where: { strategyId: id } });
    await prisma.bondStrategy.delete({ where: { id } });
  } catch (err: any) {
    logger.error(`[bond] Failed to delete strategy ${id}: ${err?.message}`);
    await sendHtml(ctx, t(lang, 'Failed to delete strategy. Please try again.'));
    return;
  }
  await handleBondList(ctx);
}

// Rename prompt
export async function handleManageRename(ctx: Context, id: string): Promise<void> {
  const lang = ((ctx as any).userLanguage as Locale) || 'en';
  await handleManageEditPrompt(ctx, id, 'awaiting_rename',
    `✏️ <b>${t(lang, 'Rename Strategy')}</b>\n\n${t(lang, 'Enter a new name:')}`);
}

// ─── Edit Text Input Handler ────────────────────────────────────────────────

export async function handleBondEditInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;

  const state = await bondEditState.get(telegramId);
  if (!state) return false;

  const lang = ((ctx as any).userLanguage as Locale) || 'en';

  // Verify ownership before any update
  const owned = await verifyBondOwnership(ctx, state.stratId);
  if (!owned) {
    bondEditState.delete(telegramId);
    await ctx.reply(t(lang, 'Strategy not found.'));
    return true;
  }

  const num = parseNumber(text);
  const id = state.stratId;

  try {
    switch (state.step) {
      case 'awaiting_budget': {
        if (num == null || num < 1 || num > 100_000) {
          await ctx.reply(t(lang, 'Enter $1–$100,000.'));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { dailyBudget: num } });
        break;
      }
      case 'awaiting_amount': {
        if (num == null || num < 1 || num > 10_000) {
          await ctx.reply(t(lang, 'Enter $1–$10,000.'));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { fixedAmount: num } });
        break;
      }
      case 'awaiting_slippage': {
        if (num == null || num < 0.1 || num > 50) {
          await ctx.reply(t(lang, 'Enter 0.1%–50%.'));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { slippage: num } });
        break;
      }
      case 'awaiting_min_prob': {
        if (num == null || num < 50 || num > 99) {
          await ctx.reply(t(lang, 'Enter 50–99.'));
          return true;
        }
        const stratForMin = await prisma.bondStrategy.findUnique({ where: { id }, select: { maxProbability: true } });
        if (stratForMin && num > stratForMin.maxProbability) {
          await ctx.reply(t(lang, 'Min probability must be <= max probability ({{max}}%).', { max: String(stratForMin.maxProbability) }));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { minProbability: num } });
        break;
      }
      case 'awaiting_max_prob': {
        if (num == null || num < 50 || num > 100) {
          await ctx.reply(t(lang, 'Enter 50–100.'));
          return true;
        }
        const stratForMax = await prisma.bondStrategy.findUnique({ where: { id }, select: { minProbability: true } });
        if (stratForMax && num < stratForMax.minProbability) {
          await ctx.reply(t(lang, 'Max probability must be >= min probability ({{min}}%).', { min: String(stratForMax.minProbability) }));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { maxProbability: num } });
        break;
      }
      case 'awaiting_window': {
        if (num == null || num < 1 || num > 168) {
          await ctx.reply(t(lang, 'Enter 1–168 hours.'));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { maxHoursOut: Math.round(num) } });
        break;
      }
      case 'awaiting_max_pos': {
        if (num == null || num < 1 || num > 50) {
          await ctx.reply(t(lang, 'Enter 1–50.'));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { maxConcurrent: Math.round(num) } });
        break;
      }
      case 'awaiting_interval': {
        if (num == null || num < 1 || num > 10) {
          await ctx.reply(t(lang, 'Enter 1–10 minutes.'));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { scanInterval: Math.round(num) } });
        break;
      }
      case 'awaiting_min_liq': {
        if (num == null || num < 0) {
          await ctx.reply(t(lang, 'Enter a valid amount.'));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { minLiquidity: num ?? null } });
        break;
      }
      case 'awaiting_min_vol': {
        if (num == null || num < 0) {
          await ctx.reply(t(lang, 'Enter a valid amount.'));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { minVolume: num ?? null } });
        break;
      }
      case 'awaiting_mkt_max': {
        if (num == null || num < 1) {
          await ctx.reply(t(lang, 'Enter min $1.'));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { maxSpendPerMarket: num } });
        break;
      }
      case 'awaiting_total_max': {
        if (num == null || num < 1) {
          await ctx.reply(t(lang, 'Enter min $1.'));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { maxSpendTotal: num } });
        break;
      }
      case 'awaiting_loss_limit': {
        if (num == null || num < 1) {
          await ctx.reply(t(lang, 'Enter min $1.'));
          return true;
        }
        await prisma.bondStrategy.update({ where: { id }, data: { maxDailyLoss: num } });
        break;
      }
      case 'awaiting_tp_pct': {
        if (num == null || num <= 0 || num > 1000) {
          await ctx.reply(t(lang, 'Enter a percentage between 0 and 1000.'));
          return true;
        }
        await prisma.bondStrategy.update({
          where: { id },
          data: { takeProfitPct: num, takeProfitPrice: null },
        });
        break;
      }
      case 'awaiting_sl_pct': {
        if (num == null || num <= 0 || num > 100) {
          await ctx.reply(t(lang, 'Enter a percentage between 0 and 100.'));
          return true;
        }
        await prisma.bondStrategy.update({
          where: { id },
          data: { stopLossPct: num, stopLossPrice: null },
        });
        break;
      }
      case 'awaiting_tp_price': {
        if (num == null || num < 1 || num > 99) {
          await ctx.reply(t(lang, 'Enter cents 1–99 (e.g. 95).'));
          return true;
        }
        await prisma.bondStrategy.update({
          where: { id },
          data: { takeProfitPrice: num, takeProfitPct: null },
        });
        break;
      }
      case 'awaiting_sl_price': {
        if (num == null || num < 1 || num > 99) {
          await ctx.reply(t(lang, 'Enter cents 1–99 (e.g. 80).'));
          return true;
        }
        await prisma.bondStrategy.update({
          where: { id },
          data: { stopLossPrice: num, stopLossPct: null },
        });
        break;
      }
      case 'awaiting_rename': {
        const name = text.trim().slice(0, 30);
        if (!name) {
          await ctx.reply(t(lang, 'Enter a name (max 30 chars).'));
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
    await ctx.reply(t(lang, 'Failed to update. Please try again.'));
    return true;
  }
}
