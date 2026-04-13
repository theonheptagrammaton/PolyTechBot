import { Context, Markup } from 'telegraf';
import { prisma } from '../../database/prisma';
import { getUserByTelegramId } from '../../services/user';
import { sendPage } from '../../utils/telegram';
import { esc } from '../../utils/customEmoji';
import { RedisBackedState } from '../../utils/redisState';
import { UPDOWN_COIN_MAP } from '../../services/market';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** sendPage wrapper that forces HTML parse mode */
function sendHtml(ctx: Context, text: string, markup?: any) {
  return sendPage(ctx, text, { ...(markup ?? {}), parse_mode: 'HTML' });
}

const MAX_STRATEGIES = 20;
const STATE_TTL_MS = 10 * 60 * 1000;

// ─── Coin helpers ───────────────────────────────────────────────────────────

function coinEmoji(sym: string): string {
  for (const info of Object.values(UPDOWN_COIN_MAP)) {
    if (info.symbol === sym) return info.emoji;
  }
  return '';
}

const TF_SHORT: Record<string, string> = {
  '1-Minute': '1m', '5-Minute': '5m', '15-Minute': '15m',
  '30-Minute': '30m', '1-Hour': '1h', '4-Hour': '4h',
};
function tfShort(tf: string): string {
  return TF_SHORT[tf] || tf;
}

/** Validate mm:ss format. Returns total seconds or null if invalid. */
function parseTimeStr(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const mins = parseInt(m[1], 10);
  const secs = parseInt(m[2], 10);
  if (mins < 0 || mins > 59 || secs < 0 || secs > 59) return null;
  return mins * 60 + secs;
}

// ─── Add Flow State ─────────────────────────────────────────────────────────

interface UpDownAddState {
  step:
    | 'name' | 'coin' | 'timeframe' | 'direction' | 'amount'
    | 'triggers_time' | 'triggers_up_price' | 'triggers_price_change'
    | 'review'
    // Advanced
    | 'adv_order_type' | 'adv_limit_price' | 'adv_limit_ttl'
    | 'adv_max_rounds' | 'adv_slippage'
    | 'adv_tp_type' | 'adv_tp_value' | 'adv_sl_type' | 'adv_sl_value';
  name?: string;
  coin?: string;
  timeframe?: string;
  direction?: string;
  amount?: number;
  timeRangeStart?: string;
  timeRangeEnd?: string;
  upPriceMin?: number;
  upPriceMax?: number;
  priceChangeMin?: number;
  priceChangeMax?: number;
  // Advanced
  orderType?: string;
  limitPrice?: number | null;
  limitTtlSeconds?: number;
  maxRounds?: number;
  slippage?: number;
  takeProfitPct?: number | null;
  takeProfitPrice?: number | null;
  stopLossPct?: number | null;
  stopLossPrice?: number | null;
  tpType?: string; // 'pct' | 'price'
  slType?: string; // 'pct' | 'price'
  advStep?: number;
  // Template source
  fromTemplate?: boolean;
  timestamp: number;
}

export const updownAddState = new RedisBackedState<UpDownAddState>('updownAdd', 600);

setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, state] of updownAddState.entries()) {
    if (state.timestamp < cutoff) updownAddState.delete(key);
  }
}, 30 * 60 * 1000);

// ─── Edit State ─────────────────────────────────────────────────────────────

interface UpDownEditState {
  step:
    | 'awaiting_amount' | 'awaiting_slippage'
    | 'awaiting_time_range' | 'awaiting_up_price'
    | 'awaiting_price_change' | 'awaiting_rounds'
    | 'awaiting_rename'
    | 'awaiting_limit_price' | 'awaiting_limit_ttl'
    | 'awaiting_tp_pct' | 'awaiting_tp_price'
    | 'awaiting_sl_pct' | 'awaiting_sl_price';
  stratId: string;
  timestamp: number;
}

export const updownEditState = new RedisBackedState<UpDownEditState>('updownEdit', 600);

setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, state] of updownEditState.entries()) {
    if (state.timestamp < cutoff) updownEditState.delete(key);
  }
}, 30 * 60 * 1000);

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseNumber(text: string): number | null {
  const cleaned = text.replace(/,/g, '.').replace(/\s/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function onOff(v: boolean): string {
  return v ? '🟢' : '🔴';
}

// ─── /afk Command ───────────────────────────────────────────────────────────

export async function handleUpDownCommand(ctx: Context): Promise<void> {
  await handleUpDownList(ctx);
}

// ─── List Page ──────────────────────────────────────────────────────────────

export async function handleUpDownList(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  updownAddState.delete(telegramId);
  updownEditState.delete(telegramId);

  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.reply('❌ User not found. Use /start first.'); return; }

  const strategies = await prisma.upDownStrategy.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
    include: {
      trades: {
        where: { status: 'filled' },
        select: { amount: true, fillPrice: true, triggerPrice: true, createdAt: true, tpSlStatus: true },
      },
    },
  });

  const lines: string[] = [
    `<b>Up/Down Strategies</b>`,
    ``,
  ];

  if (strategies.length === 0) {
    lines.push(`No strategies yet.`);
    lines.push(`Tap <b>Add</b> or use a <b>Template</b> to get started.`);
  } else {
    const running = strategies.filter(s => s.isActive && !s.isPaused).length;
    lines.push(`${running}/${strategies.length} active\n`);

    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      const statusDot = s.isActive && !s.isPaused ? '🟢' : '🔴';
      const name = s.label || `AFK ${i + 1}`;
      const dirStr = s.direction === 'up' ? 'UP' : 'DOWN';
      const orderStr = s.orderType === 'limit' && s.limitPrice
        ? `Limit ${s.limitPrice}` : 'Market';
      const tf = tfShort(s.timeframe);

      const filledTrades = s.trades || [];
      const totalSpent = filledTrades.reduce((sum, t) => sum + t.amount, 0);
      const wins = filledTrades.filter(t => t.tpSlStatus === 'tp_triggered').length;
      const losses = filledTrades.filter(t => t.tpSlStatus === 'sl_triggered').length;

      const trigChange = s.priceChangeMin > -9999 || s.priceChangeMax < 9999
        ? `\n│  ${s.coin} change: $${s.priceChangeMin}–$${s.priceChangeMax}`
        : '';

      lines.push(
        `${statusDot} <b>${esc(name)}</b>\n` +
        `│  ${s.coin} · ${tf} · ${dirStr} · ${orderStr} · $${s.amount.toFixed(2)}\n` +
        `│  ${s.timeRangeStart}–${s.timeRangeEnd} · UP ${s.upPriceMin.toFixed(2)}–${s.upPriceMax.toFixed(2)}${trigChange}\n` +
        `│  ${wins}W/${losses}L · ${s.roundsExecuted}/${s.maxRounds} rounds\n` +
        `└  $${totalSpent.toFixed(2)} spent`
      );
      lines.push(``);
    }
  }

  const buttons: any[][] = [];

  // Per-strategy action buttons
  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    const isRunning = s.isActive && !s.isPaused;
    buttons.push([
      Markup.button.callback(
        isRunning ? `⏹ Stop ${i + 1}` : `▶️ Start ${i + 1}`,
        isRunning ? `udm_pause_${s.id}` : `udm_start_${s.id}`
      ),
      Markup.button.callback(`✏️ Edit ${i + 1}`, `ud_task_${s.id}`),
    ]);
  }

  buttons.push([
    Markup.button.callback('+ Add', 'ud_start_add'),
    Markup.button.callback('Templates', 'udt_list'),
    Markup.button.callback('Remove', 'ud_remove_prompt'),
  ]);

  if (strategies.length > 0) {
    buttons.push([
      Markup.button.callback('▶️ Start All', 'ud_start_all'),
      Markup.button.callback('⏹ Stop All', 'ud_stop_all'),
    ]);
    buttons.push([
      Markup.button.callback('History', 'ud_history_10'),
      Markup.button.callback('Delete All', 'ud_del_all_cfm'),
    ]);
  }

  buttons.push([
    Markup.button.callback('← Back', 'auto_strategies'),
  ]);

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ─── Start / Stop All ───────────────────────────────────────────────────────

export async function handleStartAll(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  await prisma.upDownStrategy.updateMany({
    where: { userId: user.id, isActive: true },
    data: { isPaused: false },
  });
  await handleUpDownList(ctx);
}

export async function handleStopAll(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  await prisma.upDownStrategy.updateMany({
    where: { userId: user.id, isActive: true },
    data: { isPaused: true },
  });
  await handleUpDownList(ctx);
}

// ─── Delete All ─────────────────────────────────────────────────────────────

export async function handleDeleteAllConfirm(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendHtml(ctx,
    `⚠️ <b>Delete All Up-Down Strategies</b>\n\nThis will permanently delete all your up-down strategies. Are you sure?`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🗑 Yes, Delete All', 'ud_del_all_do'),
        Markup.button.callback('← Cancel', 'updown_list'),
      ],
    ]),
  );
}

export async function handleDeleteAllExecute(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  await prisma.upDownStrategy.deleteMany({ where: { userId: user.id } });
  await handleUpDownList(ctx);
}

// ─── Remove Single ──────────────────────────────────────────────────────────

export async function handleRemovePrompt(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const strategies = await prisma.upDownStrategy.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });

  if (strategies.length === 0) return;

  const buttons = strategies.map((s, i) => [
    Markup.button.callback(
      `🗑 ${s.label || `AFK ${i + 1}`}`,
      `ud_rm_${s.id}`
    ),
  ]);
  buttons.push([Markup.button.callback('← Back', 'updown_list')]);

  await sendHtml(ctx,
    `🗑 <b>Remove Strategy</b>\n\nSelect a strategy to remove:`,
    Markup.inlineKeyboard(buttons),
  );
}

export async function handleRemoveExecute(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  await prisma.upDownStrategy.deleteMany({ where: { id: stratId, userId: user.id } });
  await handleUpDownList(ctx);
}

// ─── History ────────────────────────────────────────────────────────────────

export async function handleHistory(ctx: Context, limit: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const trades = await prisma.upDownTrade.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  if (trades.length === 0) {
    await sendHtml(ctx,
      `📜 <b>Up-Down Trade History</b>\n\nNo trades yet.`,
      Markup.inlineKeyboard([[Markup.button.callback('← Back', 'updown_list')]]),
    );
    return;
  }

  const lines = [`📜 <b>Up-Down Trade History</b> (last ${trades.length})\n`];
  for (const t of trades) {
    const icon = t.status === 'filled' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'cancelled' ? '⏹' : '⏳';
    const dir = t.direction === 'up' ? '🟢UP' : '🔴DN';
    lines.push(`${icon} ${coinEmoji(t.coin)} ${t.coin} ${dir} · $${t.amount.toFixed(2)} @ ${t.triggerPrice.toFixed(2)}`);
  }

  await sendHtml(ctx,
    lines.join('\n'),
    Markup.inlineKeyboard([[Markup.button.callback('← Back', 'updown_list')]]),
  );
}

// ─── Close ──────────────────────────────────────────────────────────────────

export async function handleClose(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
}

// ─── Templates ──────────────────────────────────────────────────────────────

interface Template {
  id: string;
  name: string;
  emoji: string;
  description: string;
  coin: string;
  timeframe: string;
  direction: string;
  timeRangeStart: string;
  timeRangeEnd: string;
  upPriceMin: number;
  upPriceMax: number;
  priceChangeMin: number;
  priceChangeMax: number;
  amount: number;
  maxRounds: number;
}

const TEMPLATES: Template[] = [
  {
    id: 'momentum_closer',
    name: 'Momentum Closer',
    emoji: '₿',
    description: 'Buy UP late in the round when price is already high (riding momentum)',
    coin: 'BTC',
    timeframe: '15-Minute',
    direction: 'up',
    timeRangeStart: '13:00',
    timeRangeEnd: '14:55',
    upPriceMin: 0.65,
    upPriceMax: 0.95,
    priceChangeMin: -9999,
    priceChangeMax: 9999,
    amount: 25,
    maxRounds: 10,
  },
  {
    id: 'early_scalp',
    name: 'Early Scalp',
    emoji: '₿',
    description: 'Catch early momentum in the first minute',
    coin: 'BTC',
    timeframe: '5-Minute',
    direction: 'up',
    timeRangeStart: '00:15',
    timeRangeEnd: '01:00',
    upPriceMin: 0.40,
    upPriceMax: 0.70,
    priceChangeMin: -9999,
    priceChangeMax: 9999,
    amount: 25,
    maxRounds: 10,
  },
  {
    id: 'dip_buyer',
    name: 'Dip Buyer',
    emoji: '₿',
    description: 'Buy UP when spot drops and price is cheap',
    coin: 'BTC',
    timeframe: '15-Minute',
    direction: 'up',
    timeRangeStart: '02:00',
    timeRangeEnd: '12:00',
    upPriceMin: 0.10,
    upPriceMax: 0.40,
    priceChangeMin: -9999,
    priceChangeMax: -50,
    amount: 25,
    maxRounds: 5,
  },
  {
    id: 'eth_breakout',
    name: 'ETH Breakout',
    emoji: 'Ξ',
    description: 'Buy ETH UP early when price starts moving in your favor',
    coin: 'ETH',
    timeframe: '15-Minute',
    direction: 'up',
    timeRangeStart: '01:00',
    timeRangeEnd: '05:00',
    upPriceMin: 0.50,
    upPriceMax: 0.75,
    priceChangeMin: 10,
    priceChangeMax: 9999,
    amount: 25,
    maxRounds: 10,
  },
];

export async function handleTemplateList(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});

  const lines = [
    `<b>Templates</b>`,
    ``,
    `Quick-start with a preset strategy.`,
    ``,
  ];

  for (const t of TEMPLATES) {
    const pcStr = t.priceChangeMin > -9999 || t.priceChangeMax < 9999
      ? ` · $${t.priceChangeMin > -9999 ? t.priceChangeMin : ''}–$${t.priceChangeMax < 9999 ? t.priceChangeMax : ''}`
      : '';
    const tf = tfShort(t.timeframe);
    lines.push(
      `<b>${t.name}</b>`,
      `├ ${t.coin} · ${tf} · ${t.direction.toUpperCase()} · $${t.amount}`,
      `└ ${t.timeRangeStart}–${t.timeRangeEnd} · UP ${t.upPriceMin}–${t.upPriceMax}${pcStr}`,
      ``,
    );
  }

  const buttons = TEMPLATES.map(t => [
    Markup.button.callback(t.name, `udt_use_${t.id}`),
  ]);
  buttons.push([Markup.button.callback('← Back', 'updown_list')]);

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

export async function handleTemplateUse(ctx: Context, templateId: string): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const count = await prisma.upDownStrategy.count({ where: { userId: user.id } });
  if (count >= MAX_STRATEGIES) {
    await ctx.answerCbQuery(`Max ${MAX_STRATEGIES} strategies reached`).catch(() => {});
    return;
  }

  const tmpl = TEMPLATES.find(t => t.id === templateId);
  if (!tmpl) return;

  await prisma.upDownStrategy.create({
    data: {
      userId: user.id,
      label: tmpl.name,
      coin: tmpl.coin,
      timeframe: tmpl.timeframe,
      direction: tmpl.direction,
      timeRangeStart: tmpl.timeRangeStart,
      timeRangeEnd: tmpl.timeRangeEnd,
      upPriceMin: tmpl.upPriceMin,
      upPriceMax: tmpl.upPriceMax,
      priceChangeMin: tmpl.priceChangeMin,
      priceChangeMax: tmpl.priceChangeMax,
      amount: tmpl.amount,
      maxRounds: tmpl.maxRounds,
      isPaused: true,
    },
  });

  await ctx.answerCbQuery(`"${tmpl.name}" created (paused)`).catch(() => {});
  await handleUpDownList(ctx);
}

// ─── Add Flow ───────────────────────────────────────────────────────────────

export async function handleStartAdd(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const count = await prisma.upDownStrategy.count({ where: { userId: user.id } });
  if (count >= MAX_STRATEGIES) {
    await ctx.answerCbQuery(`Max ${MAX_STRATEGIES} strategies reached`).catch(() => {});
    return;
  }

  updownAddState.set(telegramId, { step: 'name', timestamp: Date.now() });

  await sendHtml(ctx,
    `✏️ <b>Step 1/5: Strategy Name</b>\n\n` +
    `Give your strategy a name (e.g. "BTC Scalper", "ETH Breakout"):`,
    Markup.inlineKeyboard([
      [Markup.button.callback('← Cancel', 'updown_list')],
    ]),
  );
}

// Step 1: Coin selection
export async function handleAddCoin(ctx: Context, coin: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.coin = coin;
  state.step = 'timeframe';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);

  await sendHtml(ctx,
    `⏱ <b>Step 3/5: Timeframe</b>\n\n` +
    `Select market timeframe:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('⚡ 5-Min', 'ud_add_tf_5'),
        Markup.button.callback('⏱ 15-Min', 'ud_add_tf_15'),
        Markup.button.callback('🕐 1-Hour', 'ud_add_tf_60'),
      ],
      [Markup.button.callback('← Cancel', 'updown_list')],
    ]),
  );
}

// Step 2: Timeframe selection
export async function handleAddTimeframe(ctx: Context, tf: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  const tfMap: Record<string, string> = { '5': '5-Minute', '15': '15-Minute', '60': '1-Hour' };
  state.timeframe = tfMap[tf] || '15-Minute';
  state.step = 'direction';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);

  await sendHtml(ctx,
    `🎯 <b>Step 4/5: Direction & Amount</b>\n\n` +
    `Which direction do you want to bet?`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🟢 Buy UP', 'ud_add_dir_up'),
        Markup.button.callback('🔴 Buy DOWN', 'ud_add_dir_dn'),
      ],
      [Markup.button.callback('← Cancel', 'updown_list')],
    ]),
  );
}

// Step 3a: Direction
export async function handleAddDirection(ctx: Context, dir: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.direction = dir;
  state.step = 'amount';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);

  await sendHtml(ctx,
    `💰 <b>Amount Per Trade</b>\n\n` +
    `Enter USD amount per trade (e.g. 25, 50, 100):`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('$10', 'ud_add_amt_10'),
        Markup.button.callback('$25', 'ud_add_amt_25'),
        Markup.button.callback('$50', 'ud_add_amt_50'),
        Markup.button.callback('$100', 'ud_add_amt_100'),
      ],
      [Markup.button.callback('← Cancel', 'updown_list')],
    ]),
  );
}

// Step 3b: Amount preset
export async function handleAddAmountPreset(ctx: Context, amount: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.amount = amount;
  state.timestamp = Date.now();
  await showTriggersTimeStep(ctx, state, telegramId);
}

// Step 4: Triggers — Time range
async function showTriggersTimeStep(ctx: Context, state: UpDownAddState, telegramId: string): Promise<void> {
  state.step = 'triggers_time';
  updownAddState.set(telegramId, state);

  await sendHtml(ctx,
    `⏱ <b>Step 5/5: Triggers</b>\n\n` +
    `<b>Time Range</b> — When during the round should the bot look for entries?\n` +
    `Enter as <code>mm:ss, mm:ss</code> (start, end)\n\n` +
    `Examples:\n` +
    `• <code>00:00, 14:55</code> — entire round\n` +
    `• <code>13:00, 14:55</code> — last 2 minutes only\n` +
    `• <code>00:30, 01:00</code> — first 30 seconds\n\n` +
    `Or pick a preset:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('Full Round', 'ud_add_tr_full'),
        Markup.button.callback('Last 2min', 'ud_add_tr_late'),
      ],
      [
        Markup.button.callback('First 1min', 'ud_add_tr_early'),
        Markup.button.callback('Mid Round', 'ud_add_tr_mid'),
      ],
      [Markup.button.callback('← Cancel', 'updown_list')],
    ]),
  );
}

// Time range presets
export async function handleAddTimeRangePreset(ctx: Context, preset: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  const presets: Record<string, [string, string]> = {
    full: ['00:00', '14:55'],
    late: ['13:00', '14:55'],
    early: ['00:00', '01:00'],
    mid: ['05:00', '10:00'],
  };
  const [start, end] = presets[preset] || presets.full;
  state.timeRangeStart = start;
  state.timeRangeEnd = end;
  state.timestamp = Date.now();
  await showTriggersUpPriceStep(ctx, state, telegramId);
}

// Step 4b: UP price range
async function showTriggersUpPriceStep(ctx: Context, state: UpDownAddState, telegramId: string): Promise<void> {
  state.step = 'triggers_up_price';
  updownAddState.set(telegramId, state);

  await sendHtml(ctx,
    `📈 <b>UP Price Range</b>\n\n` +
    `Only trigger when UP token price is within this range.\n` +
    `Enter as <code>min, max</code> (e.g. <code>0.70, 0.90</code>)\n\n` +
    `Or pick a preset:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('Any (0.01–0.99)', 'ud_add_up_any'),
        Markup.button.callback('High (0.70–0.90)', 'ud_add_up_hi'),
      ],
      [
        Markup.button.callback('Low (0.01–0.30)', 'ud_add_up_lo'),
        Markup.button.callback('Mid (0.30–0.70)', 'ud_add_up_mid'),
      ],
      [Markup.button.callback('← Cancel', 'updown_list')],
    ]),
  );
}

export async function handleAddUpPricePreset(ctx: Context, preset: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  const presets: Record<string, [number, number]> = {
    any: [0.01, 0.99],
    hi: [0.70, 0.90],
    lo: [0.01, 0.30],
    mid: [0.30, 0.70],
  };
  const [min, max] = presets[preset] || presets.any;
  state.upPriceMin = min;
  state.upPriceMax = max;
  state.timestamp = Date.now();
  await showTriggersPriceChangeStep(ctx, state, telegramId);
}

// Step 4c: Spot price change
async function showTriggersPriceChangeStep(ctx: Context, state: UpDownAddState, telegramId: string): Promise<void> {
  state.step = 'triggers_price_change';
  updownAddState.set(telegramId, state);

  const coin = state.coin || 'BTC';
  await sendHtml(ctx,
    `🪙 <b>${coin} Spot Price Change</b>\n\n` +
    `Only trigger when ${coin} spot price change (vs round open) is within this range.\n` +
    `Enter as <code>min, max</code> in USD (e.g. <code>-100, 9999</code>)\n\n` +
    `Or pick a preset:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('Any', 'ud_add_pc_any'),
        Markup.button.callback('Pump ≥$40', 'ud_add_pc_pump'),
      ],
      [
        Markup.button.callback('Dump ≤-$10', 'ud_add_pc_dump'),
        Markup.button.callback('⏭ Skip', 'ud_add_pc_any'),
      ],
      [Markup.button.callback('← Cancel', 'updown_list')],
    ]),
  );
}

export async function handleAddPriceChangePreset(ctx: Context, preset: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  const presets: Record<string, [number, number]> = {
    any: [-9999, 9999],
    pump: [40, 9999],
    dump: [-9999, -10],
  };
  const [min, max] = presets[preset] || presets.any;
  state.priceChangeMin = min;
  state.priceChangeMax = max;
  state.timestamp = Date.now();
  state.step = 'review';
  updownAddState.set(telegramId, state);
  await showReviewStep(ctx, state);
}

// Step 5: Review
async function showReviewStep(ctx: Context, state: UpDownAddState): Promise<void> {
  const ce = coinEmoji(state.coin || 'BTC');
  const dirStr = state.direction === 'up' ? '🟢 Buy UP' : '🔴 Buy DOWN';
  const orderStr = state.orderType === 'limit' && state.limitPrice
    ? `Limit @ ${state.limitPrice}` : 'Market';
  const pcStr = (state.priceChangeMin ?? -9999) > -9999 || (state.priceChangeMax ?? 9999) < 9999
    ? `$${state.priceChangeMin ?? -9999} – $${state.priceChangeMax ?? 9999}`
    : 'Any';

  const lines = [
    `📋 <b>Review</b>\n`,
    `✏️ Name: <b>${esc(state.name || 'Strategy')}</b>`,
    `${ce} <b>${state.coin}</b> · ${state.timeframe}`,
    `🎯 Direction: ${dirStr}`,
    `💰 Amount: $${state.amount ?? 25}`,
    `📋 Order: ${orderStr}`,
    `⏱ Time: ${state.timeRangeStart ?? '00:00'} – ${state.timeRangeEnd ?? '14:55'}`,
    `📈 UP Price: ${(state.upPriceMin ?? 0.01).toFixed(2)} – ${(state.upPriceMax ?? 0.99).toFixed(2)}`,
    `🪙 ${state.coin} Change: ${pcStr}`,
    `🔁 Rounds: ${state.maxRounds ?? 10}`,
    `⚡ Slippage: ${state.slippage ?? 5}%`,
  ];

  if (state.takeProfitPct != null) lines.push(`🏆 TP: ${state.takeProfitPct}%`);
  if (state.takeProfitPrice != null) lines.push(`🏆 TP: @${state.takeProfitPrice}`);
  if (state.stopLossPct != null) lines.push(`🛑 SL: ${state.stopLossPct}%`);
  if (state.stopLossPrice != null) lines.push(`🛑 SL: @${state.stopLossPrice}`);

  lines.push(`\nStrategy starts <b>paused</b>. Start it from the manage page.`);

  await sendHtml(ctx,
    lines.join('\n'),
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Confirm', 'ud_add_confirm'),
        Markup.button.callback('⚙️ Advanced', 'ud_add_advanced'),
      ],
      [Markup.button.callback('← Cancel', 'updown_list')],
    ]),
  );
}

// ─── Confirm Add ────────────────────────────────────────────────────────────

export async function handleConfirmAdd(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const state = await updownAddState.get(telegramId);
  if (!state) {
    await ctx.answerCbQuery('Session expired. Please start again.').catch(() => {});
    return;
  }

  // Use transaction to prevent race condition on MAX_STRATEGIES
  const created = await prisma.$transaction(async (tx) => {
    const count = await tx.upDownStrategy.count({ where: { userId: user.id } });
    if (count >= MAX_STRATEGIES) return null;
    return tx.upDownStrategy.create({
      data: {
        userId: user.id,
        label: state.name || 'Strategy',
        coin: state.coin || 'BTC',
        timeframe: state.timeframe || '15-Minute',
        direction: state.direction || 'up',
        amount: state.amount || 25,
        timeRangeStart: state.timeRangeStart || '00:00',
        timeRangeEnd: state.timeRangeEnd || '14:55',
        upPriceMin: state.upPriceMin ?? 0.01,
        upPriceMax: state.upPriceMax ?? 0.99,
        priceChangeMin: state.priceChangeMin ?? -9999,
        priceChangeMax: state.priceChangeMax ?? 9999,
        orderType: state.orderType || 'market',
        limitPrice: state.limitPrice,
        limitTtlSeconds: state.limitTtlSeconds ?? 60,
        maxRounds: state.maxRounds ?? 10,
        slippage: state.slippage ?? 5,
        takeProfitPct: state.takeProfitPct,
        takeProfitPrice: state.takeProfitPrice,
        stopLossPct: state.stopLossPct,
        stopLossPrice: state.stopLossPrice,
        isPaused: true,
      },
    });
  });

  if (!created) {
    await ctx.answerCbQuery(`Max ${MAX_STRATEGIES} strategies reached`).catch(() => {});
    return;
  }

  updownAddState.delete(telegramId);
  await handleUpDownList(ctx);
}

// ─── Advanced Settings ──────────────────────────────────────────────────────

export async function handleAddAdvanced(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  await showAdvMenu(ctx, state, telegramId);
}

async function showAdvMenu(ctx: Context, state: UpDownAddState, telegramId: string): Promise<void> {
  const orderStr = state.orderType === 'limit' && state.limitPrice
    ? `Limit @ ${state.limitPrice}` : (state.orderType || 'Market');
  const ttlStr = state.limitTtlSeconds ? `${state.limitTtlSeconds}s` : '60s';

  const lines = [
    `⚙️ <b>Advanced Settings</b>\n`,
    `📋 Order Type: ${orderStr}`,
    ...(state.orderType === 'limit' ? [`⏱ Limit TTL: ${ttlStr}`] : []),
    `🔁 Max Rounds: ${state.maxRounds ?? 10}`,
    `⚡ Slippage: ${state.slippage ?? 5}%`,
    `🏆 Take Profit: ${state.takeProfitPct != null ? state.takeProfitPct + '%' : state.takeProfitPrice != null ? '@' + state.takeProfitPrice : '–'}`,
    `🛑 Stop Loss: ${state.stopLossPct != null ? state.stopLossPct + '%' : state.stopLossPrice != null ? '@' + state.stopLossPrice : '–'}`,
    `\nTap a setting to change it:`,
  ];

  const buttons = [
    [
      Markup.button.callback('📋 Order Type', 'ud_adv_edit_order'),
      Markup.button.callback('🔁 Rounds', 'ud_adv_edit_rounds'),
    ],
    [
      Markup.button.callback('⚡ Slippage', 'ud_adv_edit_slippage'),
    ],
    [
      Markup.button.callback('🏆 Take Profit', 'ud_adv_edit_tp'),
      Markup.button.callback('🛑 Stop Loss', 'ud_adv_edit_sl'),
    ],
    [Markup.button.callback('← Back to Review', 'ud_adv_back_review')],
  ];

  if (state.orderType === 'limit') {
    buttons.splice(1, 0, [Markup.button.callback('⏱ Limit TTL', 'ud_adv_edit_ttl')]);
  }

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}


// Advanced: order type
export async function handleAdvOrderType(ctx: Context, type: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.orderType = type;
  state.timestamp = Date.now();

  if (type === 'limit') {
    state.step = 'adv_limit_price';
    updownAddState.set(telegramId, state);
    await sendHtml(ctx,
      `💲 <b>Limit Price</b>\n\nEnter limit order price (0.01–0.99):`,
      Markup.inlineKeyboard([[Markup.button.callback('← Back', 'ud_add_advanced')]]),
    );
    return;
  }

  state.limitPrice = null;
  updownAddState.set(telegramId, state);
  await showAdvMenu(ctx, state, telegramId);
}

// Advanced: max rounds preset
export async function handleAdvMaxRounds(ctx: Context, n: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.maxRounds = n;
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showAdvMenu(ctx, state, telegramId);
}

// Advanced: slippage preset
export async function handleAdvSlippage(ctx: Context, pct: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.slippage = pct;
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showAdvMenu(ctx, state, telegramId);
}

// Advanced: TP type selection
export async function handleAdvTpType(ctx: Context, type: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.tpType = type;
  state.step = 'adv_tp_value';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);

  const prompt = type === 'pct'
    ? `🏆 <b>TP Percentage</b>\n\nEnter TP % from entry (e.g. 50 for +50%):`
    : `🏆 <b>TP Price</b>\n\nEnter target price (0.01–0.99):`;

  await sendHtml(ctx,
    prompt,
    Markup.inlineKeyboard([[Markup.button.callback('← Back', 'ud_add_advanced')]]),
  );
}

// Advanced: SL type selection
export async function handleAdvSlType(ctx: Context, type: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.slType = type;
  state.step = 'adv_sl_value';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);

  const prompt = type === 'pct'
    ? `🛑 <b>SL Percentage</b>\n\nEnter SL % from entry (e.g. 25 for -25%):`
    : `🛑 <b>SL Price</b>\n\nEnter stop-loss price (0.01–0.99):`;

  await sendHtml(ctx,
    prompt,
    Markup.inlineKeyboard([[Markup.button.callback('← Back', 'ud_add_advanced')]]),
  );
}

// Advanced: Skip — return to menu
export async function handleAdvSkip(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showAdvMenu(ctx, state, telegramId);
}

// Advanced: back to review
export async function handleAdvBackReview(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.step = 'review';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showReviewStep(ctx, state);
}

// Advanced: edit a specific field from the menu
export async function handleAdvEditField(ctx: Context, field: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.timestamp = Date.now();

  switch (field) {
    case 'order':
      state.step = 'adv_order_type';
      updownAddState.set(telegramId, state);
      await sendHtml(ctx,
        `📋 <b>Order Type</b>\n\nSelect order execution type:`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('📈 Market', 'ud_adv_ot_market'),
            Markup.button.callback('📊 Limit', 'ud_adv_ot_limit'),
          ],
          [Markup.button.callback('← Back', 'ud_add_advanced')],
        ]),
      );
      break;

    case 'rounds':
      state.step = 'adv_max_rounds';
      updownAddState.set(telegramId, state);
      await sendHtml(ctx,
        `🔁 <b>Max Rounds</b>\n\nHow many rounds should this strategy run?\n\nEnter a number (1–100):`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('5', 'ud_adv_mr_5'),
            Markup.button.callback('10', 'ud_adv_mr_10'),
            Markup.button.callback('25', 'ud_adv_mr_25'),
            Markup.button.callback('50', 'ud_adv_mr_50'),
          ],
          [Markup.button.callback('← Back', 'ud_add_advanced')],
        ]),
      );
      break;

    case 'slippage':
      state.step = 'adv_slippage';
      updownAddState.set(telegramId, state);
      await sendHtml(ctx,
        `⚡ <b>Slippage</b>\n\nMax slippage tolerance (%).\n\nEnter a value (0.1–50):`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('2%', 'ud_adv_sl_2'),
            Markup.button.callback('5%', 'ud_adv_sl_5'),
            Markup.button.callback('10%', 'ud_adv_sl_10'),
          ],
          [Markup.button.callback('← Back', 'ud_add_advanced')],
        ]),
      );
      break;

    case 'tp':
      state.step = 'adv_tp_type';
      updownAddState.set(telegramId, state);
      await sendHtml(ctx,
        `🏆 <b>Take Profit</b>\n\nSet TP condition:`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('📊 % from entry', 'ud_adv_tp_pct'),
            Markup.button.callback('💲 Fixed price', 'ud_adv_tp_price'),
          ],
          [Markup.button.callback('❌ Clear TP', 'ud_adv_tp_clear')],
          [Markup.button.callback('← Back', 'ud_add_advanced')],
        ]),
      );
      break;

    case 'sl':
      state.step = 'adv_sl_type';
      updownAddState.set(telegramId, state);
      await sendHtml(ctx,
        `🛑 <b>Stop Loss</b>\n\nSet SL condition:`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('📊 % from entry', 'ud_adv_sl_pct'),
            Markup.button.callback('💲 Fixed price', 'ud_adv_sl_price'),
          ],
          [Markup.button.callback('❌ Clear SL', 'ud_adv_sl_clear')],
          [Markup.button.callback('← Back', 'ud_add_advanced')],
        ]),
      );
      break;

    case 'ttl':
      state.step = 'adv_limit_ttl';
      updownAddState.set(telegramId, state);
      await sendHtml(ctx,
        `⏱ <b>Limit Order TTL</b>\n\nHow long should limit orders stay active (seconds)?`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('30s', 'ud_adv_ttl_30'),
            Markup.button.callback('60s', 'ud_adv_ttl_60'),
            Markup.button.callback('120s', 'ud_adv_ttl_120'),
          ],
          [Markup.button.callback('← Back', 'ud_add_advanced')],
        ]),
      );
      break;

    default:
      await showAdvMenu(ctx, state, telegramId);
  }
}

// Advanced: clear TP
export async function handleAdvTpClear(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;
  state.takeProfitPct = null;
  state.takeProfitPrice = null;
  state.tpType = undefined;
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showAdvMenu(ctx, state, telegramId);
}

// Advanced: clear SL
export async function handleAdvSlClear(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;
  state.stopLossPct = null;
  state.stopLossPrice = null;
  state.slType = undefined;
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showAdvMenu(ctx, state, telegramId);
}

// ─── Add Flow Text Input Handler ────────────────────────────────────────────

export async function handleAddInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;
  const state = await updownAddState.get(telegramId);
  if (!state) return false;

  switch (state.step) {
    case 'name': {
      const name = text.trim();
      if (!name || name.length < 1 || name.length > 32) {
        await ctx.reply('Enter a name (1–32 characters).');
        return true;
      }
      state.name = name;
      state.step = 'coin';
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await sendHtml(ctx,
        `₿ <b>Step 2/5: Select Coin</b>\n\n` +
        `Which cryptocurrency do you want to trade?`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('₿ BTC', 'ud_add_coin_BTC'),
            Markup.button.callback('Ξ ETH', 'ud_add_coin_ETH'),
            Markup.button.callback('◎ SOL', 'ud_add_coin_SOL'),
          ],
          [Markup.button.callback('← Cancel', 'updown_list')],
        ]),
      );
      return true;
    }

    case 'amount': {
      const n = parseNumber(text);
      if (n == null || n < 1 || n > 10000) {
        await ctx.reply('❌ Enter a valid amount (1–10000).');
        return true;
      }
      state.amount = n;
      state.timestamp = Date.now();
      await showTriggersTimeStep(ctx, state, telegramId);
      return true;
    }

    case 'triggers_time': {
      const parts = text.split(',').map(s => s.trim());
      if (parts.length !== 2) {
        await ctx.reply('❌ Enter as mm:ss, mm:ss (e.g. 00:00, 14:55)');
        return true;
      }
      const startSec = parseTimeStr(parts[0]);
      const endSec = parseTimeStr(parts[1]);
      if (startSec == null || endSec == null) {
        await ctx.reply('❌ Invalid time format. Use mm:ss (e.g. 00:00, 14:55)');
        return true;
      }
      if (startSec >= endSec) {
        await ctx.reply('❌ Start time must be before end time.');
        return true;
      }
      state.timeRangeStart = parts[0].trim();
      state.timeRangeEnd = parts[1].trim();
      state.timestamp = Date.now();
      await showTriggersUpPriceStep(ctx, state, telegramId);
      return true;
    }

    case 'triggers_up_price': {
      const parts = text.split(',').map(s => s.trim());
      if (parts.length !== 2) {
        await ctx.reply('❌ Enter as min, max (e.g. 0.70, 0.90)');
        return true;
      }
      const min = parseNumber(parts[0]);
      const max = parseNumber(parts[1]);
      if (min == null || max == null || min < 0.01 || max > 0.99 || min > max) {
        await ctx.reply('❌ Invalid range. Use 0.01–0.99, min ≤ max.');
        return true;
      }
      state.upPriceMin = min;
      state.upPriceMax = max;
      state.timestamp = Date.now();
      await showTriggersPriceChangeStep(ctx, state, telegramId);
      return true;
    }

    case 'triggers_price_change': {
      const parts = text.split(',').map(s => s.trim());
      if (parts.length !== 2) {
        await ctx.reply('❌ Enter as min, max in USD (e.g. -100, 9999)');
        return true;
      }
      const min = parseNumber(parts[0]);
      const max = parseNumber(parts[1]);
      if (min == null || max == null) {
        await ctx.reply('❌ Invalid numbers.');
        return true;
      }
      if (min > max) {
        await ctx.reply('❌ Min must be ≤ max.');
        return true;
      }
      state.priceChangeMin = min;
      state.priceChangeMax = max;
      state.step = 'review';
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showReviewStep(ctx, state);
      return true;
    }

    case 'adv_limit_price': {
      const n = parseNumber(text);
      if (n == null || n < 0.01 || n > 0.99) {
        await ctx.reply('❌ Enter a price between 0.01 and 0.99.');
        return true;
      }
      state.limitPrice = n;
      state.step = 'adv_limit_ttl';
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await sendHtml(ctx,
        `⏰ <b>Limit Order TTL</b>\n\nHow long to wait for fill (seconds)?\n\nEnter a value (10–300):`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('30s', 'ud_adv_ttl_30'),
            Markup.button.callback('60s', 'ud_adv_ttl_60'),
            Markup.button.callback('120s', 'ud_adv_ttl_120'),
          ],
          [Markup.button.callback('← Back', 'ud_add_advanced')],
        ]),
      );
      return true;
    }

    case 'adv_limit_ttl': {
      const n = parseNumber(text);
      if (n == null || n < 10 || n > 300) {
        await ctx.reply('❌ Enter seconds between 10 and 300.');
        return true;
      }
      state.limitTtlSeconds = Math.round(n);
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showAdvMenu(ctx, state, telegramId);
      return true;
    }

    case 'adv_max_rounds': {
      const n = parseNumber(text);
      if (n == null || n < 1 || n > 100) {
        await ctx.reply('❌ Enter a number between 1 and 100.');
        return true;
      }
      state.maxRounds = Math.round(n);
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showAdvMenu(ctx, state, telegramId);
      return true;
    }

    case 'adv_slippage': {
      const n = parseNumber(text);
      if (n == null || n < 0.1 || n > 50) {
        await ctx.reply('❌ Enter slippage between 0.1 and 50.');
        return true;
      }
      state.slippage = n;
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showAdvMenu(ctx, state, telegramId);
      return true;
    }

    case 'adv_tp_value': {
      const n = parseNumber(text);
      if (n == null || n <= 0) {
        await ctx.reply('❌ Enter a positive number.');
        return true;
      }
      if (state.tpType === 'pct') {
        state.takeProfitPct = n;
      } else {
        if (n < 0.01 || n > 0.99) {
          await ctx.reply('❌ Price must be 0.01–0.99.');
          return true;
        }
        state.takeProfitPrice = n;
      }
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showAdvMenu(ctx, state, telegramId);
      return true;
    }

    case 'adv_sl_value': {
      const n = parseNumber(text);
      if (n == null || n <= 0) {
        await ctx.reply('❌ Enter a positive number.');
        return true;
      }
      if (state.slType === 'pct') {
        state.stopLossPct = n;
      } else {
        if (n < 0.01 || n > 0.99) {
          await ctx.reply('❌ Price must be 0.01–0.99.');
          return true;
        }
        state.stopLossPrice = n;
      }
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showAdvMenu(ctx, state, telegramId);
      return true;
    }
  }

  return false;
}

// Advanced: TTL preset
export async function handleAdvTtlPreset(ctx: Context, seconds: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.limitTtlSeconds = seconds;
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showAdvMenu(ctx, state, telegramId);
}

// ─── Ownership Helper ────────────────────────────────────────────────────────

/** Verify the current user owns the strategy. Returns the strategy or null. */
async function verifyUdOwnership(ctx: Context, stratId: string) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return null;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return null;
  const strat = await prisma.upDownStrategy.findFirst({ where: { id: stratId, userId: user.id } });
  return strat;
}

// ─── Manage Page ────────────────────────────────────────────────────────────

export async function handleManage(ctx: Context, stratId: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  updownEditState.delete(telegramId);

  const strat = await verifyUdOwnership(ctx, stratId);
  if (!strat) {
    await ctx.answerCbQuery('Strategy not found').catch(() => {});
    return;
  }

  const statusStr = strat.isActive && !strat.isPaused ? '🟢 Running' : '🔴 Paused';
  const dirStr = strat.direction === 'up' ? 'UP' : 'DOWN';
  const orderStr = strat.orderType === 'limit' && strat.limitPrice
    ? `Limit @ ${strat.limitPrice} (TTL: ${strat.limitTtlSeconds}s)` : 'Market';
  const tf = tfShort(strat.timeframe);
  const pcStr = strat.priceChangeMin > -9999 || strat.priceChangeMax < 9999
    ? `$${strat.priceChangeMin} – $${strat.priceChangeMax}` : 'Any';
  const tpStr = strat.takeProfitPct != null ? `${strat.takeProfitPct}%`
    : strat.takeProfitPrice != null ? `@${strat.takeProfitPrice}` : '–';
  const slStr = strat.stopLossPct != null ? `${strat.stopLossPct}%`
    : strat.stopLossPrice != null ? `@${strat.stopLossPrice}` : '–';

  const lines = [
    `<b>${esc(strat.label || 'AFK')}</b> · ${strat.coin} ${tf}`,
    `${statusStr}`,
    ``,
    `Direction: ${dirStr}`,
    `Amount: $${strat.amount.toFixed(2)}`,
    `Order: ${orderStr}`,
    `Time: ${strat.timeRangeStart} – ${strat.timeRangeEnd}`,
    `UP Price: ${strat.upPriceMin.toFixed(2)} – ${strat.upPriceMax.toFixed(2)}`,
    `${strat.coin} Change: ${pcStr}`,
    `Rounds: ${strat.roundsExecuted}/${strat.maxRounds}`,
    `TP: ${tpStr} · SL: ${slStr}`,
    `Slippage: ${strat.slippage}%`,
    `Notifications: ${onOff(strat.notificationsEnabled)}`,
  ];

  const id = strat.id;
  const isRunning = strat.isActive && !strat.isPaused;

  const buttons: any[][] = [
    [Markup.button.callback(isRunning ? '⏹ Pause' : '▶️ Start', isRunning ? `udm_pause_${id}` : `udm_start_${id}`)],
    [
      Markup.button.callback('Direction', `udm_dir_${id}`),
      Markup.button.callback('Amount', `udm_amt_${id}`),
      Markup.button.callback('Order Type', `udm_ot_${id}`),
    ],
    [
      Markup.button.callback('Time Range', `udm_time_${id}`),
      Markup.button.callback('UP Price', `udm_up_${id}`),
      Markup.button.callback(`${strat.coin} Change`, `udm_pc_${id}`),
    ],
    [
      Markup.button.callback('Rounds', `udm_rnd_${id}`),
      Markup.button.callback('Slippage', `udm_slip_${id}`),
    ],
    [
      Markup.button.callback('TP', `udm_tp_${id}`),
      Markup.button.callback('SL', `udm_sl_${id}`),
    ],
    [
      Markup.button.callback('Notify', `udm_notify_${id}`),
      Markup.button.callback('Rename', `udm_rename_${id}`),
      Markup.button.callback('Delete', `udm_del_${id}`),
    ],
    [Markup.button.callback('← Back', 'updown_list')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ─── Manage Actions ─────────────────────────────────────────────────────────

export async function handleManageStart(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyUdOwnership(ctx, stratId);
  if (!strat) return;
  await prisma.upDownStrategy.update({ where: { id: stratId }, data: { isPaused: false } });
  await handleManage(ctx, stratId);
}

export async function handleManagePause(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyUdOwnership(ctx, stratId);
  if (!strat) return;
  await prisma.upDownStrategy.update({ where: { id: stratId }, data: { isPaused: true } });
  await handleManage(ctx, stratId);
}

export async function handleManageToggleDirection(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyUdOwnership(ctx, stratId);
  if (!strat) return;
  await prisma.upDownStrategy.update({
    where: { id: stratId },
    data: { direction: strat.direction === 'up' ? 'down' : 'up' },
  });
  await handleManage(ctx, stratId);
}

export async function handleManageToggleNotify(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyUdOwnership(ctx, stratId);
  if (!strat) return;
  await prisma.upDownStrategy.update({
    where: { id: stratId },
    data: { notificationsEnabled: !strat.notificationsEnabled },
  });
  await handleManage(ctx, stratId);
}

export async function handleManageOrderType(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyUdOwnership(ctx, stratId);
  if (!strat) return;

  if (strat.orderType === 'market') {
    // Switch to limit — prompt for price
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;
    updownEditState.set(telegramId, {
      step: 'awaiting_limit_price',
      stratId,
      timestamp: Date.now(),
    });
    await sendHtml(ctx,
      `💲 <b>Set Limit Price</b>\n\nEnter limit order price (0.01–0.99):`,
      Markup.inlineKeyboard([[Markup.button.callback('← Cancel', `ud_task_${stratId}`)]]),
    );
  } else {
    // Switch back to market
    await prisma.upDownStrategy.update({
      where: { id: stratId },
      data: { orderType: 'market', limitPrice: null },
    });
    await handleManage(ctx, stratId);
  }
}

export async function handleManageEditPrompt(
  ctx: Context,
  stratId: string,
  step: UpDownEditState['step'],
  prompt: string,
): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  updownEditState.set(telegramId, { step, stratId, timestamp: Date.now() });
  await sendHtml(ctx, prompt,
    Markup.inlineKeyboard([[Markup.button.callback('← Cancel', `ud_task_${stratId}`)]]),
  );
}

export async function handleManageDelete(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendHtml(ctx,
    `⚠️ <b>Delete Strategy</b>\n\nAre you sure?`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🗑 Yes, Delete', `udm_deldo_${stratId}`),
        Markup.button.callback('← Cancel', `ud_task_${stratId}`),
      ],
    ]),
  );
}

export async function handleManageDeleteExecute(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyUdOwnership(ctx, stratId);
  if (!strat) return;
  await prisma.upDownStrategy.delete({ where: { id: stratId } }).catch(() => {});
  await handleUpDownList(ctx);
}

export async function handleManageRename(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  updownEditState.set(telegramId, {
    step: 'awaiting_rename',
    stratId,
    timestamp: Date.now(),
  });
  await sendHtml(ctx,
    `✏️ <b>Rename Strategy</b>\n\nEnter a new name:`,
    Markup.inlineKeyboard([[Markup.button.callback('← Cancel', `ud_task_${stratId}`)]]),
  );
}

// TP/SL manage prompts
export async function handleManageTpPrompt(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendHtml(ctx,
    `🏆 <b>Take Profit</b>\n\nSelect TP type:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('📊 % from entry', `udm_tp_pct_${stratId}`),
        Markup.button.callback('💲 Fixed price', `udm_tp_fix_${stratId}`),
      ],
      [Markup.button.callback('🗑 Clear TP', `udm_tp_clr_${stratId}`)],
      [Markup.button.callback('← Cancel', `ud_task_${stratId}`)],
    ]),
  );
}

export async function handleManageSlPrompt(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendHtml(ctx,
    `🛑 <b>Stop Loss</b>\n\nSelect SL type:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('📊 % from entry', `udm_sl_pct_${stratId}`),
        Markup.button.callback('💲 Fixed price', `udm_sl_fix_${stratId}`),
      ],
      [Markup.button.callback('🗑 Clear SL', `udm_sl_clr_${stratId}`)],
      [Markup.button.callback('← Cancel', `ud_task_${stratId}`)],
    ]),
  );
}

export async function handleManageTpTypePct(ctx: Context, stratId: string): Promise<void> {
  await handleManageEditPrompt(ctx, stratId, 'awaiting_tp_pct',
    `🏆 <b>TP Percentage</b>\n\nEnter TP % from entry (e.g. 50 for +50%):`);
}

export async function handleManageTpTypeFix(ctx: Context, stratId: string): Promise<void> {
  await handleManageEditPrompt(ctx, stratId, 'awaiting_tp_price',
    `🏆 <b>TP Price</b>\n\nEnter target price (0.01–0.99):`);
}

export async function handleManageSlTypePct(ctx: Context, stratId: string): Promise<void> {
  await handleManageEditPrompt(ctx, stratId, 'awaiting_sl_pct',
    `🛑 <b>SL Percentage</b>\n\nEnter SL % from entry (e.g. 25 for -25%):`);
}

export async function handleManageSlTypeFix(ctx: Context, stratId: string): Promise<void> {
  await handleManageEditPrompt(ctx, stratId, 'awaiting_sl_price',
    `🛑 <b>SL Price</b>\n\nEnter stop-loss price (0.01–0.99):`);
}

export async function handleManageTpClear(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyUdOwnership(ctx, stratId);
  if (!strat) return;
  await prisma.upDownStrategy.update({
    where: { id: stratId },
    data: { takeProfitPct: null, takeProfitPrice: null },
  });
  await handleManage(ctx, stratId);
}

export async function handleManageSlClear(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyUdOwnership(ctx, stratId);
  if (!strat) return;
  await prisma.upDownStrategy.update({
    where: { id: stratId },
    data: { stopLossPct: null, stopLossPrice: null },
  });
  await handleManage(ctx, stratId);
}

// ─── Edit Text Input Handler ────────────────────────────────────────────────

export async function handleEditInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;
  const state = await updownEditState.get(telegramId);
  if (!state) return false;

  const { step, stratId } = state;

  // Verify ownership before any update
  const owned = await verifyUdOwnership(ctx, stratId);
  if (!owned) {
    updownEditState.delete(telegramId);
    await ctx.reply('❌ Strategy not found.');
    return true;
  }

  switch (step) {
    case 'awaiting_amount': {
      const n = parseNumber(text);
      if (n == null || n < 1 || n > 10000) {
        await ctx.reply('❌ Enter a valid amount (1–10000).');
        return true;
      }
      await prisma.upDownStrategy.update({ where: { id: stratId }, data: { amount: n } });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_slippage': {
      const n = parseNumber(text);
      if (n == null || n < 0.1 || n > 50) {
        await ctx.reply('❌ Enter slippage between 0.1 and 50.');
        return true;
      }
      await prisma.upDownStrategy.update({ where: { id: stratId }, data: { slippage: n } });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_time_range': {
      const parts = text.split(',').map(s => s.trim());
      if (parts.length !== 2) {
        await ctx.reply('❌ Enter as mm:ss, mm:ss (e.g. 00:00, 14:55)');
        return true;
      }
      const startSec = parseTimeStr(parts[0]);
      const endSec = parseTimeStr(parts[1]);
      if (startSec == null || endSec == null) {
        await ctx.reply('❌ Invalid time format. Use mm:ss (e.g. 00:00, 14:55)');
        return true;
      }
      if (startSec >= endSec) {
        await ctx.reply('❌ Start time must be before end time.');
        return true;
      }
      await prisma.upDownStrategy.update({
        where: { id: stratId },
        data: { timeRangeStart: parts[0], timeRangeEnd: parts[1] },
      });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_up_price': {
      const parts = text.split(',').map(s => s.trim());
      if (parts.length !== 2) {
        await ctx.reply('❌ Enter as min, max (e.g. 0.70, 0.90)');
        return true;
      }
      const min = parseNumber(parts[0]);
      const max = parseNumber(parts[1]);
      if (min == null || max == null || min < 0.01 || max > 0.99 || min > max) {
        await ctx.reply('❌ Invalid range. Use 0.01–0.99, min ≤ max.');
        return true;
      }
      await prisma.upDownStrategy.update({
        where: { id: stratId },
        data: { upPriceMin: min, upPriceMax: max },
      });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_price_change': {
      const parts = text.split(',').map(s => s.trim());
      if (parts.length !== 2) {
        await ctx.reply('❌ Enter as min, max in USD (e.g. -100, 9999)');
        return true;
      }
      const min = parseNumber(parts[0]);
      const max = parseNumber(parts[1]);
      if (min == null || max == null) {
        await ctx.reply('❌ Invalid numbers.');
        return true;
      }
      if (min > max) {
        await ctx.reply('❌ Min must be ≤ max.');
        return true;
      }
      await prisma.upDownStrategy.update({
        where: { id: stratId },
        data: { priceChangeMin: min, priceChangeMax: max },
      });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_rounds': {
      const n = parseNumber(text);
      if (n == null || n < 1 || n > 100) {
        await ctx.reply('❌ Enter a number between 1 and 100.');
        return true;
      }
      await prisma.upDownStrategy.update({ where: { id: stratId }, data: { maxRounds: Math.round(n) } });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_rename': {
      const name = text.trim().slice(0, 32);
      if (!name) {
        await ctx.reply('❌ Name cannot be empty.');
        return true;
      }
      await prisma.upDownStrategy.update({ where: { id: stratId }, data: { label: name } });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_limit_price': {
      const n = parseNumber(text);
      if (n == null || n < 0.01 || n > 0.99) {
        await ctx.reply('❌ Enter a price between 0.01 and 0.99.');
        return true;
      }
      await prisma.upDownStrategy.update({
        where: { id: stratId },
        data: { orderType: 'limit', limitPrice: n },
      });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_limit_ttl': {
      const n = parseNumber(text);
      if (n == null || n < 10 || n > 300) {
        await ctx.reply('❌ Enter seconds between 10 and 300.');
        return true;
      }
      await prisma.upDownStrategy.update({
        where: { id: stratId },
        data: { limitTtlSeconds: Math.round(n) },
      });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_tp_pct': {
      const n = parseNumber(text);
      if (n == null || n <= 0 || n > 1000) {
        await ctx.reply('❌ Enter a percentage (1–1000).');
        return true;
      }
      await prisma.upDownStrategy.update({
        where: { id: stratId },
        data: { takeProfitPct: n, takeProfitPrice: null },
      });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_tp_price': {
      const n = parseNumber(text);
      if (n == null || n < 0.01 || n > 0.99) {
        await ctx.reply('❌ Enter a price between 0.01 and 0.99.');
        return true;
      }
      await prisma.upDownStrategy.update({
        where: { id: stratId },
        data: { takeProfitPrice: n, takeProfitPct: null },
      });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_sl_pct': {
      const n = parseNumber(text);
      if (n == null || n <= 0 || n > 100) {
        await ctx.reply('❌ Enter a percentage (1–100).');
        return true;
      }
      await prisma.upDownStrategy.update({
        where: { id: stratId },
        data: { stopLossPct: n, stopLossPrice: null },
      });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_sl_price': {
      const n = parseNumber(text);
      if (n == null || n < 0.01 || n > 0.99) {
        await ctx.reply('❌ Enter a price between 0.01 and 0.99.');
        return true;
      }
      await prisma.upDownStrategy.update({
        where: { id: stratId },
        data: { stopLossPrice: n, stopLossPct: null },
      });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }
  }

  return false;
}
