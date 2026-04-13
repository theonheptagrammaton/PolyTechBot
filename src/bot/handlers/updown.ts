import { Context, Markup } from 'telegraf';
import { prisma } from '../../database/prisma';
import { getUserByTelegramId } from '../../services/user';
import { sendPage } from '../../utils/telegram';
import { esc } from '../../utils/customEmoji';
import { RedisBackedState } from '../../utils/redisState';
import { UPDOWN_COIN_MAP } from '../../services/market';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_STRATEGIES = 20;
const STATE_TTL_MS = 10 * 60 * 1000;

// ─── Coin helpers ───────────────────────────────────────────────────────────

function coinEmoji(sym: string): string {
  for (const info of Object.values(UPDOWN_COIN_MAP)) {
    if (info.symbol === sym) return info.emoji;
  }
  return '';
}

// ─── Add Flow State ─────────────────────────────────────────────────────────

interface UpDownAddState {
  step:
    | 'coin' | 'timeframe' | 'direction' | 'amount'
    | 'triggers_time' | 'triggers_up_price' | 'triggers_price_change'
    | 'review'
    // Advanced
    | 'adv_order_type' | 'adv_limit_price' | 'adv_limit_ttl'
    | 'adv_max_rounds' | 'adv_slippage'
    | 'adv_tp_type' | 'adv_tp_value' | 'adv_sl_type' | 'adv_sl_value';
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
    `🤖 <b>Auto Trade — Up/Down</b>`,
    ``,
  ];

  if (strategies.length === 0) {
    lines.push(`No up-down strategies yet.`);
    lines.push(`Tap <b>➕ Add</b> to create your first strategy, or use a <b>📋 Template</b>.`);
  } else {
    const running = strategies.filter(s => s.isActive && !s.isPaused).length;

    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      const statusDot = s.isActive && !s.isPaused ? '🟢' : '🔴';
      const name = s.label || `AFK ${i + 1}`;
      const ce = coinEmoji(s.coin);
      const dirStr = s.direction === 'up' ? '🟢 Buy UP' : '🔴 Buy DOWN';
      const orderStr = s.orderType === 'limit' && s.limitPrice
        ? `Limit ${s.limitPrice}` : 'Market';

      // Calculate PnL from trades
      const filledTrades = s.trades || [];
      const totalSpent = filledTrades.reduce((sum, t) => sum + t.amount, 0);
      const wins = filledTrades.filter(t => t.tpSlStatus === 'tp_triggered').length;
      const losses = filledTrades.filter(t => t.tpSlStatus === 'sl_triggered').length;

      // Triggers line
      const trigTime = `⏱ ${s.timeRangeStart}–${s.timeRangeEnd}`;
      const trigUp = `📈 UP ${s.upPriceMin.toFixed(2)}–${s.upPriceMax.toFixed(2)}`;
      const trigChange = s.priceChangeMin > -9999 || s.priceChangeMax < 9999
        ? ` | 🪙 ${s.coin} $${s.priceChangeMin}–$${s.priceChangeMax}`
        : '';

      lines.push(
        `${i + 1}. ${statusDot} ${ce} <b>${esc(name)}</b>\n` +
        `├ Mode: ${dirStr} · ${orderStr} · <b>$${s.amount.toFixed(2)}</b>\n` +
        `├ Triggers: ${trigTime} | ${trigUp}${trigChange}\n` +
        `├ PnL: ${wins}W/${losses}L\n` +
        `├ Rounds: ${s.roundsExecuted}/${s.maxRounds}\n` +
        `└ Spent: <b>$${totalSpent.toFixed(2)}</b>`
      );
      lines.push(``);
    }

    lines.push(`⚡ Status: ${running}/${strategies.length} tasks running.`);
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
    Markup.button.callback('➕ Add', 'ud_start_add'),
    Markup.button.callback('📋 Templates', 'udt_list'),
    Markup.button.callback('🗑 Remove', 'ud_remove_prompt'),
  ]);

  if (strategies.length > 0) {
    buttons.push([
      Markup.button.callback('▶️ Start All', 'ud_start_all'),
      Markup.button.callback('⏹ Stop All', 'ud_stop_all'),
    ]);
    buttons.push([
      Markup.button.callback('📜 History', 'ud_history_10'),
      Markup.button.callback('🗑 Delete All', 'ud_del_all_cfm'),
    ]);
  }

  buttons.push([
    Markup.button.callback('← Auto Strategies', 'auto_strategies'),
    Markup.button.callback('× Close', 'ud_close'),
  ]);

  await sendPage(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
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
  await sendPage(ctx,
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

  await sendPage(ctx,
    `🗑 <b>Remove Strategy</b>\n\nSelect a strategy to remove:`,
    Markup.inlineKeyboard(buttons),
  );
}

export async function handleRemoveExecute(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await prisma.upDownStrategy.delete({ where: { id: stratId } }).catch(() => {});
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
    await sendPage(ctx,
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

  await sendPage(ctx,
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
    id: 'theta',
    name: 'Theta Harvester',
    emoji: '🎯',
    description: 'Late-stage arbitrage — high win rate',
    coin: 'BTC',
    timeframe: '15-Minute',
    direction: 'up',
    timeRangeStart: '13:00',
    timeRangeEnd: '14:55',
    upPriceMin: 0.70,
    upPriceMax: 0.90,
    priceChangeMin: 40,
    priceChangeMax: 9999,
    amount: 50,
    maxRounds: 10,
  },
  {
    id: 'breakout',
    name: 'Breakout Scalper',
    emoji: '🚀',
    description: 'Opening momentum capture',
    coin: 'BTC',
    timeframe: '15-Minute',
    direction: 'up',
    timeRangeStart: '00:30',
    timeRangeEnd: '01:00',
    upPriceMin: 0.01,
    upPriceMax: 0.89,
    priceChangeMin: 50,
    priceChangeMax: 9999,
    amount: 25,
    maxRounds: 5,
  },
  {
    id: 'crash',
    name: 'Flash Crash Rebound',
    emoji: '💣',
    description: 'Extreme panic buy — small lottery play',
    coin: 'BTC',
    timeframe: '15-Minute',
    direction: 'up',
    timeRangeStart: '04:00',
    timeRangeEnd: '11:00',
    upPriceMin: 0.01,
    upPriceMax: 0.15,
    priceChangeMin: -200,
    priceChangeMax: -10,
    amount: 10,
    maxRounds: 3,
  },
];

export async function handleTemplateList(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});

  const lines = [
    `📋 <b>Strategy Templates</b>`,
    ``,
    `Choose a battle-tested template:`,
    ``,
  ];

  for (const t of TEMPLATES) {
    lines.push(
      `${t.emoji} <b>${t.name}</b>`,
      `${t.description}`,
      `⏱ ${t.timeRangeStart}–${t.timeRangeEnd} | 📈 UP ${t.upPriceMin}–${t.upPriceMax} | 🪙 BTC $${t.priceChangeMin}–$${t.priceChangeMax}`,
      ``,
    );
  }

  const buttons = TEMPLATES.map(t => [
    Markup.button.callback(`${t.emoji} ${t.name}`, `udt_use_${t.id}`),
  ]);
  buttons.push([Markup.button.callback('← Back', 'updown_list')]);

  await sendPage(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

export async function handleTemplateUse(ctx: Context, templateId: string): Promise<void> {
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

  updownAddState.set(telegramId, { step: 'coin', timestamp: Date.now() });

  await sendPage(ctx,
    `₿ <b>Step 1/5: Select Coin</b>\n\n` +
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

  await sendPage(ctx,
    `⏱ <b>Step 2/5: Timeframe</b>\n\n` +
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

  await sendPage(ctx,
    `🎯 <b>Step 3/5: Direction & Amount</b>\n\n` +
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

  await sendPage(ctx,
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

  await sendPage(ctx,
    `⏱ <b>Step 4/5: Triggers</b>\n\n` +
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

  await sendPage(ctx,
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
  await sendPage(ctx,
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
    `📋 <b>Step 5/5: Review</b>\n`,
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

  await sendPage(ctx,
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

  await prisma.upDownStrategy.create({
    data: {
      userId: user.id,
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

  state.step = 'adv_order_type';
  state.advStep = 0;
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);

  await showAdvancedStep(ctx, state, telegramId);
}

async function showAdvancedStep(ctx: Context, state: UpDownAddState, telegramId: string): Promise<void> {
  const step = state.advStep ?? 0;

  switch (step) {
    case 0: // Order type
      state.step = 'adv_order_type';
      updownAddState.set(telegramId, state);
      await sendPage(ctx,
        `📋 <b>Order Type</b>\n\nSelect order execution type:`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('📈 Market', 'ud_adv_ot_market'),
            Markup.button.callback('📊 Limit', 'ud_adv_ot_limit'),
          ],
          [Markup.button.callback('⏭ Skip (Market)', 'ud_adv_skip')],
          [Markup.button.callback('← Cancel', 'updown_list')],
        ]),
      );
      break;

    case 1: // Max rounds
      state.step = 'adv_max_rounds';
      updownAddState.set(telegramId, state);
      await sendPage(ctx,
        `🔁 <b>Max Rounds</b>\n\nHow many rounds should this strategy run?\n\nEnter a number (1–100):`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('5', 'ud_adv_mr_5'),
            Markup.button.callback('10', 'ud_adv_mr_10'),
            Markup.button.callback('25', 'ud_adv_mr_25'),
            Markup.button.callback('50', 'ud_adv_mr_50'),
          ],
          [Markup.button.callback('⏭ Skip (10)', 'ud_adv_skip')],
          [Markup.button.callback('← Cancel', 'updown_list')],
        ]),
      );
      break;

    case 2: // Slippage
      state.step = 'adv_slippage';
      updownAddState.set(telegramId, state);
      await sendPage(ctx,
        `⚡ <b>Slippage</b>\n\nMax slippage tolerance (%).\n\nEnter a value (0.1–50):`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('2%', 'ud_adv_sl_2'),
            Markup.button.callback('5%', 'ud_adv_sl_5'),
            Markup.button.callback('10%', 'ud_adv_sl_10'),
          ],
          [Markup.button.callback('⏭ Skip (5%)', 'ud_adv_skip')],
          [Markup.button.callback('← Cancel', 'updown_list')],
        ]),
      );
      break;

    case 3: // TP
      state.step = 'adv_tp_type';
      updownAddState.set(telegramId, state);
      await sendPage(ctx,
        `🏆 <b>Take Profit</b>\n\nSet TP condition:`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('📊 % from entry', 'ud_adv_tp_pct'),
            Markup.button.callback('💲 Fixed price', 'ud_adv_tp_price'),
          ],
          [Markup.button.callback('⏭ Skip (No TP)', 'ud_adv_skip')],
          [Markup.button.callback('← Cancel', 'updown_list')],
        ]),
      );
      break;

    case 4: // SL
      state.step = 'adv_sl_type';
      updownAddState.set(telegramId, state);
      await sendPage(ctx,
        `🛑 <b>Stop Loss</b>\n\nSet SL condition:`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('📊 % from entry', 'ud_adv_sl_pct'),
            Markup.button.callback('💲 Fixed price', 'ud_adv_sl_price'),
          ],
          [Markup.button.callback('⏭ Skip (No SL)', 'ud_adv_skip')],
          [Markup.button.callback('← Cancel', 'updown_list')],
        ]),
      );
      break;

    default:
      // Done with advanced, back to review
      state.step = 'review';
      updownAddState.set(telegramId, state);
      await showReviewStep(ctx, state);
      break;
  }
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
    await sendPage(ctx,
      `💲 <b>Limit Price</b>\n\nEnter limit order price (0.01–0.99):`,
      Markup.inlineKeyboard([[Markup.button.callback('← Cancel', 'updown_list')]]),
    );
    return;
  }

  state.advStep = (state.advStep ?? 0) + 1;
  updownAddState.set(telegramId, state);
  await showAdvancedStep(ctx, state, telegramId);
}

// Advanced: max rounds preset
export async function handleAdvMaxRounds(ctx: Context, n: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.maxRounds = n;
  state.advStep = (state.advStep ?? 0) + 1;
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showAdvancedStep(ctx, state, telegramId);
}

// Advanced: slippage preset
export async function handleAdvSlippage(ctx: Context, pct: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.slippage = pct;
  state.advStep = (state.advStep ?? 0) + 1;
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showAdvancedStep(ctx, state, telegramId);
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

  await sendPage(ctx,
    prompt,
    Markup.inlineKeyboard([[Markup.button.callback('← Cancel', 'updown_list')]]),
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

  await sendPage(ctx,
    prompt,
    Markup.inlineKeyboard([[Markup.button.callback('← Cancel', 'updown_list')]]),
  );
}

// Advanced: Skip (use defaults and move to next)
export async function handleAdvSkip(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.advStep = (state.advStep ?? 0) + 1;
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showAdvancedStep(ctx, state, telegramId);
}

// ─── Add Flow Text Input Handler ────────────────────────────────────────────

export async function handleAddInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;
  const state = await updownAddState.get(telegramId);
  if (!state) return false;

  switch (state.step) {
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
      if (parts.length !== 2 || !parts[0].includes(':') || !parts[1].includes(':')) {
        await ctx.reply('❌ Enter as mm:ss, mm:ss (e.g. 00:00, 14:55)');
        return true;
      }
      state.timeRangeStart = parts[0];
      state.timeRangeEnd = parts[1];
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
      await sendPage(ctx,
        `⏰ <b>Limit Order TTL</b>\n\nHow long to wait for fill (seconds)?\n\nEnter a value (10–300):`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('30s', 'ud_adv_ttl_30'),
            Markup.button.callback('60s', 'ud_adv_ttl_60'),
            Markup.button.callback('120s', 'ud_adv_ttl_120'),
          ],
          [Markup.button.callback('← Cancel', 'updown_list')],
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
      state.advStep = (state.advStep ?? 0) + 1;
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showAdvancedStep(ctx, state, telegramId);
      return true;
    }

    case 'adv_max_rounds': {
      const n = parseNumber(text);
      if (n == null || n < 1 || n > 100) {
        await ctx.reply('❌ Enter a number between 1 and 100.');
        return true;
      }
      state.maxRounds = Math.round(n);
      state.advStep = (state.advStep ?? 0) + 1;
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showAdvancedStep(ctx, state, telegramId);
      return true;
    }

    case 'adv_slippage': {
      const n = parseNumber(text);
      if (n == null || n < 0.1 || n > 50) {
        await ctx.reply('❌ Enter slippage between 0.1 and 50.');
        return true;
      }
      state.slippage = n;
      state.advStep = (state.advStep ?? 0) + 1;
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showAdvancedStep(ctx, state, telegramId);
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
      state.advStep = (state.advStep ?? 0) + 1;
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showAdvancedStep(ctx, state, telegramId);
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
      state.advStep = (state.advStep ?? 0) + 1;
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showAdvancedStep(ctx, state, telegramId);
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
  state.advStep = (state.advStep ?? 0) + 1;
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showAdvancedStep(ctx, state, telegramId);
}

// ─── Manage Page ────────────────────────────────────────────────────────────

export async function handleManage(ctx: Context, stratId: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  updownEditState.delete(telegramId);

  const strat = await prisma.upDownStrategy.findUnique({ where: { id: stratId } });
  if (!strat) {
    await ctx.answerCbQuery('Strategy not found').catch(() => {});
    return;
  }

  const ce = coinEmoji(strat.coin);
  const statusStr = strat.isActive && !strat.isPaused ? '🟢 Running' : '🔴 Paused';
  const dirStr = strat.direction === 'up' ? '🟢 Buy UP' : '🔴 Buy DOWN';
  const orderStr = strat.orderType === 'limit' && strat.limitPrice
    ? `Limit @ ${strat.limitPrice} (TTL: ${strat.limitTtlSeconds}s)` : 'Market';
  const pcStr = strat.priceChangeMin > -9999 || strat.priceChangeMax < 9999
    ? `$${strat.priceChangeMin} – $${strat.priceChangeMax}` : 'Any';
  const tpStr = strat.takeProfitPct != null ? `${strat.takeProfitPct}%`
    : strat.takeProfitPrice != null ? `@${strat.takeProfitPrice}` : '–';
  const slStr = strat.stopLossPct != null ? `${strat.stopLossPct}%`
    : strat.stopLossPrice != null ? `@${strat.stopLossPrice}` : '–';

  const lines = [
    `⚙️ <b>${esc(strat.label || 'AFK')} — ${ce} ${strat.coin} ${strat.timeframe}</b>`,
    ``,
    `📊 Status: ${statusStr}`,
    `🎯 Direction: ${dirStr}`,
    `💰 Amount: $${strat.amount.toFixed(2)}`,
    `📋 Order: ${orderStr}`,
    `⏱ Time: ${strat.timeRangeStart} – ${strat.timeRangeEnd}`,
    `📈 UP Price: ${strat.upPriceMin.toFixed(2)} – ${strat.upPriceMax.toFixed(2)}`,
    `🪙 ${strat.coin} Change: ${pcStr}`,
    `🔁 Rounds: ${strat.roundsExecuted}/${strat.maxRounds}`,
    `🏆 TP: ${tpStr} | 🛑 SL: ${slStr}`,
    `⚡ Slippage: ${strat.slippage}%`,
    `🔔 Notifications: ${onOff(strat.notificationsEnabled)}`,
  ];

  const id = strat.id;
  const isRunning = strat.isActive && !strat.isPaused;

  const buttons: any[][] = [
    [Markup.button.callback(isRunning ? '⏹ Pause' : '▶️ Start', isRunning ? `udm_pause_${id}` : `udm_start_${id}`)],
    [
      Markup.button.callback('🎯 Direction', `udm_dir_${id}`),
      Markup.button.callback('💰 Amount', `udm_amt_${id}`),
      Markup.button.callback('📋 Order Type', `udm_ot_${id}`),
    ],
    [
      Markup.button.callback('⏱ Time Range', `udm_time_${id}`),
      Markup.button.callback('📈 UP Price', `udm_up_${id}`),
      Markup.button.callback(`🪙 ${strat.coin} Change`, `udm_pc_${id}`),
    ],
    [
      Markup.button.callback('🔁 Rounds', `udm_rnd_${id}`),
      Markup.button.callback('⚡ Slippage', `udm_slip_${id}`),
    ],
    [
      Markup.button.callback('🏆 TP', `udm_tp_${id}`),
      Markup.button.callback('🛑 SL', `udm_sl_${id}`),
    ],
    [
      Markup.button.callback('🔔 Notify', `udm_notify_${id}`),
      Markup.button.callback('✏️ Rename', `udm_rename_${id}`),
      Markup.button.callback('🗑 Delete', `udm_del_${id}`),
    ],
    [Markup.button.callback('← Back to List', 'updown_list')],
  ];

  await sendPage(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ─── Manage Actions ─────────────────────────────────────────────────────────

export async function handleManageStart(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await prisma.upDownStrategy.update({ where: { id: stratId }, data: { isPaused: false } });
  await handleManage(ctx, stratId);
}

export async function handleManagePause(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await prisma.upDownStrategy.update({ where: { id: stratId }, data: { isPaused: true } });
  await handleManage(ctx, stratId);
}

export async function handleManageToggleDirection(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await prisma.upDownStrategy.findUnique({ where: { id: stratId } });
  if (!strat) return;
  await prisma.upDownStrategy.update({
    where: { id: stratId },
    data: { direction: strat.direction === 'up' ? 'down' : 'up' },
  });
  await handleManage(ctx, stratId);
}

export async function handleManageToggleNotify(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await prisma.upDownStrategy.findUnique({ where: { id: stratId } });
  if (!strat) return;
  await prisma.upDownStrategy.update({
    where: { id: stratId },
    data: { notificationsEnabled: !strat.notificationsEnabled },
  });
  await handleManage(ctx, stratId);
}

export async function handleManageOrderType(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await prisma.upDownStrategy.findUnique({ where: { id: stratId } });
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
    await sendPage(ctx,
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
  await sendPage(ctx, prompt,
    Markup.inlineKeyboard([[Markup.button.callback('← Cancel', `ud_task_${stratId}`)]]),
  );
}

export async function handleManageDelete(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendPage(ctx,
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
  await sendPage(ctx,
    `✏️ <b>Rename Strategy</b>\n\nEnter a new name:`,
    Markup.inlineKeyboard([[Markup.button.callback('← Cancel', `ud_task_${stratId}`)]]),
  );
}

// TP/SL manage prompts
export async function handleManageTpPrompt(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendPage(ctx,
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
  await sendPage(ctx,
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
  await prisma.upDownStrategy.update({
    where: { id: stratId },
    data: { takeProfitPct: null, takeProfitPrice: null },
  });
  await handleManage(ctx, stratId);
}

export async function handleManageSlClear(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
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
      if (parts.length !== 2 || !parts[0].includes(':') || !parts[1].includes(':')) {
        await ctx.reply('❌ Enter as mm:ss, mm:ss (e.g. 00:00, 14:55)');
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
