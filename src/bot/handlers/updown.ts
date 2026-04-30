import { Context, Markup } from 'telegraf';
import { prisma } from '../../database/prisma';
import { getUserByTelegramId } from '../../services/user';
import { sendPage } from '../../utils/telegram';
import { esc } from '../../utils/customEmoji';
import { RedisBackedState } from '../../utils/redisState';
import { UPDOWN_COIN_MAP } from '../../services/market';
import { config } from '../../config';
import { logger } from '../../utils/logger';
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

// ─── Coin helpers ───────────────────────────────────────────────────────────

function coinEmoji(sym: string): string {
  for (const info of Object.values(UPDOWN_COIN_MAP)) {
    if (info.symbol === sym) return info.emoji;
  }
  return '';
}

const COIN_LIST = ['BTC', 'ETH', 'SOL', 'XRP'];

const TF_LIST = [
  { key: '5-Minute', label: '5 Min' },
  { key: '15-Minute', label: '15 Min' },
  { key: '1-Hour', label: '1 Hr' },
  { key: '4-Hour', label: '4 Hr' },
];

const TF_SHORT: Record<string, string> = {
  '1-Minute': '1m', '5-Minute': '5m', '15-Minute': '15m',
  '30-Minute': '30m', '1-Hour': '1h', '4-Hour': '4h',
};
function tfShort(tf: string): string {
  return TF_SHORT[tf] || tf;
}

/** Get candle duration in seconds for a timeframe */
function tfDurationSecs(tf: string): number {
  const map: Record<string, number> = {
    '5-Minute': 300, '15-Minute': 900, '1-Hour': 3600, '4-Hour': 14400,
  };
  return map[tf] || 900;
}

// ─── Add Flow State ─────────────────────────────────────────────────────────

interface AutoPilotAddState {
  step: 'category' | 'coins' | 'timeframes' | 'direction' | 'amount' | 'window' | 'range' | 'tpsl';
  coins: string[];
  timeframes: string[];
  direction?: string;
  amount?: number;
  entryWindowSecs?: number | null; // null = anytime
  priceRangeMin?: number; // cents 0-100
  priceRangeMax?: number;
  takeProfitPct?: number | null;
  stopLossPct?: number | null;
  timestamp: number;
}

export const updownAddState = new RedisBackedState<AutoPilotAddState>('updownAdd', 600);

const _updownAddCleanup = setInterval(() => {
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
    | 'awaiting_sl_pct' | 'awaiting_sl_price'
    | 'awaiting_entry_window' | 'awaiting_coins'
    | 'awaiting_timeframes';
  stratId: string;
  timestamp: number;
}

export const updownEditState = new RedisBackedState<UpDownEditState>('updownEdit', 600);

const _updownEditCleanup = setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, state] of updownEditState.entries()) {
    if (state.timestamp < cutoff) updownEditState.delete(key);
  }
}, 30 * 60 * 1000);

/** Stop state cleanup intervals (call on bot shutdown) */
export function stopUpdownCleanup(): void {
  clearInterval(_updownAddCleanup);
  clearInterval(_updownEditCleanup);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseNumber(text: string): number | null {
  const cleaned = text.replace(/,/g, '.').replace(/\s/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function onOff(v: boolean): string {
  return v ? '🟢' : '🔴';
}

/** Get the coins a strategy uses */
function getStratCoins(strat: any): string[] {
  return strat.coins ? strat.coins.split(',') : [strat.coin];
}

/** Get the timeframes a strategy uses */
function getStratTimeframes(strat: any): string[] {
  return strat.timeframes ? strat.timeframes.split(',') : [strat.timeframe];
}

// ─── /afk & /autopilot Command ──────────────────────────────────────────────

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
  const lang = user ? getLang(user) : (((ctx as any).userLanguage as Locale) || 'en');
  if (!user) { await ctx.reply(t(lang, 'common.userNotFoundStart')); return; }

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
    `🤖 <b>AutoPilot Strategies (${strategies.length})</b>`,
    ``,
  ];

  const botUsername = (ctx as any).botInfo?.username ?? config.telegram.botUsername ?? '';

  if (strategies.length === 0) {
    lines.push('No strategies yet.');
    lines.push('Tap <b>+ New</b> to get started.');
  } else {
    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      const statusDot = s.isActive && !s.isPaused ? '🟢' : '🔴';
      const coins = getStratCoins(s);
      const tfs = getStratTimeframes(s);
      const dirStr = s.direction === 'up' ? '📈 Up'
        : s.direction === 'down' ? '📉 Down'
        : s.direction === 'both' ? '🔄 Both'
        : '🔀 Either';

      const filledTrades = s.trades || [];
      const fires = filledTrades.length;

      const estPnl = filledTrades.reduce((sum, t) => {
        if (!t.fillPrice || t.fillPrice <= 0) return sum;
        const shares = t.amount / t.fillPrice;
        if (t.tpSlStatus === 'redeemed') {
          // Market resolved in user's favor: shares worth $1 each
          return sum + (shares - t.amount);
        } else if (t.tpSlStatus === 'tp_triggered' && s.takeProfitPct != null) {
          // TP sell: estimate profit based on TP%
          return sum + (t.amount * s.takeProfitPct / 100);
        } else if (t.tpSlStatus === 'sl_triggered' && s.stopLossPct != null) {
          // SL sell: estimate loss based on SL%
          return sum - (t.amount * s.stopLossPct / 100);
        }
        // Open positions or unknown — don't count
        return sum;
      }, 0);
      const pnlSign = estPnl >= 0 ? '+' : '';
      const pnlStr = `${pnlSign}$${estPnl.toFixed(2)}`;

      const windowStr = s.entryWindowSecs != null ? `${s.entryWindowSecs}s` : 'Anytime';
      const rangeMinCents = Math.round(s.upPriceMin * 100);
      const rangeMaxCents = Math.round(s.upPriceMax * 100);
      const rangeStr = `${rangeMinCents}–${rangeMaxCents}¢`;

      const tpStr = s.takeProfitPct != null ? `+${s.takeProfitPct}%` : '—';
      const slStr = s.stopLossPct != null ? `-${s.stopLossPct}%` : '—';

      const manageLink = botUsername
        ? `<a href="https://t.me/${botUsername}?start=ap_manage_${s.id}">Manage</a>`
        : `Manage`;

      lines.push(
        `${i + 1}. ${statusDot} ${coins.map(c => coinEmoji(c)).join('')} ${coins.join(', ')} · ${tfs.map(tf => tfShort(tf)).join(', ')} · ${dirStr}\n` +
        `├ 💰 Amount: $${s.amount.toFixed(2)}\n` +
        `├ ⏱ Window: ${windowStr}\n` +
        `├ 🎯 Range: ${rangeStr}\n` +
        `├ 📈 TP: ${tpStr}  ·  📉 SL: ${slStr}\n` +
        `├ 🔥 Fires: ${fires}\n` +
        `├ 💵 PnL: ${pnlStr}\n` +
        `└ ${manageLink}`
      );
      lines.push(``);
    }
  }

  const buttons: any[][] = [];

  buttons.push([
    Markup.button.callback(`+ New`, 'ud_start_add'),
    Markup.button.callback(`🗑 Remove`, 'ud_remove_prompt'),
  ]);

  if (strategies.length > 0) {
    buttons.push([
      Markup.button.callback(`▶️ Start All`, 'ud_start_all'),
      Markup.button.callback(`⏹ Stop All`, 'ud_stop_all'),
    ]);
    buttons.push([
      Markup.button.callback(`📋 Activity`, 'ud_history_10'),
      Markup.button.callback(`🗑 Delete All`, 'ud_del_all_cfm'),
    ]);
  }

  buttons.push([
    Markup.button.callback(`🔄 Refresh`, 'updown_list'),
    Markup.button.callback(`← Back`, 'auto_strategies'),
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
    `⚠️ <b>Delete All AutoPilot Strategies</b>\n\nThis will permanently delete all your AutoPilot strategies. Are you sure?`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`🗑 Yes, Delete All`, 'ud_del_all_do'),
        Markup.button.callback(`← Cancel`, 'updown_list'),
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
  try {
    const stratIds = await prisma.upDownStrategy.findMany({
      where: { userId: user.id },
      select: { id: true },
    });
    if (stratIds.length > 0) {
      await prisma.upDownTrade.deleteMany({
        where: { strategyId: { in: stratIds.map(s => s.id) } },
      });
    }
    await prisma.upDownStrategy.deleteMany({ where: { userId: user.id } });
  } catch (err: any) {
    logger.error(`[autopilot] Failed to delete all strategies: ${err?.message}`);
    await sendHtml(ctx, 'Failed to delete strategies. Please try again.');
    return;
  }
  await handleUpDownList(ctx);
}

// ─── Remove Single ──────────────────────────────────────────────────────────

export async function handleRemovePrompt(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) { await ctx.answerCbQuery().catch(() => {}); return; }
  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.answerCbQuery().catch(() => {}); return; }

  const strategies = await prisma.upDownStrategy.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });

  if (strategies.length === 0) {
    await ctx.answerCbQuery('No strategies to remove').catch(() => {});
    return;
  }
  await ctx.answerCbQuery().catch(() => {});

  const buttons = strategies.map((s, i) => [
    Markup.button.callback(
      `🗑 ${s.label || `AutoPilot ${i + 1}`}`,
      `ud_rm_${s.id}`
    ),
  ]);
  buttons.push([Markup.button.callback(`← Back`, 'updown_list')]);

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
  try {
    await prisma.upDownTrade.deleteMany({ where: { strategyId: stratId } });
    await prisma.upDownStrategy.deleteMany({ where: { id: stratId, userId: user.id } });
  } catch (err: any) {
    logger.error(`[autopilot] Failed to delete strategy ${stratId}: ${err?.message}`);
    await sendHtml(ctx, 'Failed to delete strategy. Please try again.');
    return;
  }
  await handleUpDownList(ctx);
}

// ─── History ────────────────────────────────────────────────────────────────

export async function handleHistory(ctx: Context, limit: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const totalCount = await prisma.upDownTrade.count({ where: { userId: user.id } });

  const trades = await prisma.upDownTrade.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  if (trades.length === 0) {
    await sendHtml(ctx,
      `📊 <b>AutoPilot Activity</b>\n\nNo trades yet.`,
      Markup.inlineKeyboard([[Markup.button.callback(`← Back`, 'updown_list')]]),
    );
    return;
  }

  const lines = [`📊 <b>AutoPilot Activity</b>  ·  ${totalCount} total\n`];

  for (let i = 0; i < trades.length; i++) {
    const tr = trades[i];

    // Status icon & label
    let icon: string;
    let statusLabel: string;
    if (tr.status === 'filled') {
      if (tr.tpSlStatus === 'tp_triggered') { icon = '🏆'; statusLabel = 'TP Triggered'; }
      else if (tr.tpSlStatus === 'sl_triggered') { icon = '🛑'; statusLabel = 'SL Triggered'; }
      else if (tr.tpSlStatus === 'redeemed') { icon = '💰'; statusLabel = 'Redeemed'; }
      else { icon = '✅'; statusLabel = 'Filled'; }
    } else if (tr.status === 'failed' || tr.status === 'skipped') {
      icon = '⚠️'; statusLabel = 'Skipped';
    } else if (tr.status === 'cancelled') {
      icon = '⏹'; statusLabel = 'Cancelled';
    } else {
      icon = '⏳'; statusLabel = 'Pending';
    }

    // Direction
    const dirEmoji = tr.direction === 'up' ? '📈' : '📉';
    const dirLabel = tr.direction === 'up' ? 'Up (YES)' : 'Down (NO)';

    // Parse timeframe from question field (format: "BTC 5-Minute up")
    const qParts = tr.question.split(' ');
    const tfRaw = qParts.length >= 2 ? qParts[1] : '';
    const tfLabel = TF_SHORT[tfRaw] ? tfShort(tfRaw) : tfRaw.replace('-', ' ');

    // Trigger price in cents
    const triggerCents = Math.round(tr.triggerPrice * 100);

    // Timestamp
    const ts = tr.createdAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    // Header line
    lines.push(`${i + 1}. ${icon} ${tr.coin} · ${tfLabel} · ${dirEmoji} ${dirLabel}`);
    lines.push(`├ 📊 Status: ${statusLabel}`);
    lines.push(`├ 🎯 Trigger: ${triggerCents}¢`);

    if (tr.status === 'filled' && tr.fillPrice != null) {
      const fillCents = Math.round(tr.fillPrice * 100);
      const slipCents = fillCents - triggerCents;
      const slipStr = slipCents >= 0 ? `+${slipCents}¢ slip` : `${slipCents}¢ slip`;
      const shares = tr.fillPrice > 0 ? (tr.amount / tr.fillPrice).toFixed(2) : '—';

      lines.push(`├ 💰 Spent: $${tr.amount.toFixed(2)}`);
      lines.push(`├ 📦 Shares: ${shares}`);
      lines.push(`├ 💵 Fill: ${fillCents}¢  (${slipStr})`);
    } else if (tr.status === 'filled') {
      lines.push(`├ 💰 Spent: $${tr.amount.toFixed(2)}`);
    }

    if (tr.errorMsg) {
      lines.push(`├ ⚠️ Error: ${tr.errorMsg.slice(0, 80)}`);
    }

    lines.push(`├ 🕐 ${ts}`);

    // Order ID link (shortened)
    if (tr.orderId) {
      const shortId = tr.orderId.length > 10
        ? tr.orderId.slice(0, 10) + '…' + tr.orderId.slice(-6)
        : tr.orderId;
      lines.push(`└ 🔗 Order: <code>${shortId}</code>`);
    } else {
      lines.push(`└ 🔗 (no order)`);
    }

    lines.push('');
  }

  const buttons = [];
  if (limit <= 10 && totalCount > 10) {
    buttons.push([Markup.button.callback(`Show 50`, 'ud_history_50')]);
  }
  if (limit <= 50 && totalCount > 50) {
    buttons.push([Markup.button.callback(`Show 200`, 'ud_history_200')]);
  }
  buttons.push([Markup.button.callback(`← Back`, 'updown_list')]);

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ─── Close ──────────────────────────────────────────────────────────────────

export async function handleClose(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
}

// ─── 8-Step AutoPilot Add Flow ──────────────────────────────────────────────

// Step 1: Category
export async function handleStartAdd(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) { await ctx.answerCbQuery().catch(() => {}); return; }
  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.answerCbQuery().catch(() => {}); return; }

  const count = await prisma.upDownStrategy.count({ where: { userId: user.id } });
  if (count >= MAX_STRATEGIES) {
    await ctx.answerCbQuery(`Max ${MAX_STRATEGIES} strategies reached`).catch(() => {});
    return;
  }
  await ctx.answerCbQuery().catch(() => {});

  updownAddState.set(telegramId, {
    step: 'category',
    coins: [],
    timeframes: [],
    timestamp: Date.now(),
  });

  await showCategoryStep(ctx);
}

async function showCategoryStep(ctx: Context): Promise<void> {
  await sendHtml(ctx,
    `🤖 <b>AutoPilot · Step 1 / 8</b>\n\nSelect a category:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`⚽ Crypto`, 'ap_cat_crypto'),
        Markup.button.callback(`⚽ Sport (Coming Soon)`, 'ap_cat_sport'),
      ],
      [Markup.button.callback(`↩️ Back`, 'updown_list')],
    ]),
  );
}

export async function handleCategorySelect(ctx: Context, cat: string): Promise<void> {
  await ctx.answerCbQuery(cat === 'sport' ? '🚧 Coming Soon!' : undefined).catch(() => {});
  if (cat === 'sport') return;

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.step = 'timeframes';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showTimeframesStep(ctx, state);
}

// Step 2: Timeframes (multi-select) — moved before coins
// (showTimeframesStep is defined below)

// Step 3: Assets (multi-select)
async function showCoinsStep(ctx: Context, state: AutoPilotAddState): Promise<void> {
  const selectedStr = state.coins.length === 0 ? 'none' : state.coins.join(', ');
  const coinButtons = COIN_LIST.map(c => {
    const sel = state.coins.includes(c) ? '✅ ' : '';
    return Markup.button.callback(`${sel}${c}`, `ap_coin_${c}`);
  });

  await sendHtml(ctx,
    `🤖 <b>AutoPilot · Step 3 / 8</b>\n\n` +
    `Which assets should the bot autonomously trade? Pick one or more.\n\n` +
    `Selected: <b>${selectedStr}</b>`,
    Markup.inlineKeyboard([
      coinButtons,
      [
        Markup.button.callback(`↩️ Back`, 'ap_back'),
        Markup.button.callback(`Next Step ▶️`, 'ap_coin_next'),
      ],
    ]),
  );
}

export async function handleCoinToggle(ctx: Context, coin: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  const idx = state.coins.indexOf(coin);
  if (idx >= 0) state.coins.splice(idx, 1);
  else state.coins.push(coin);
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showCoinsStep(ctx, state);
}

export async function handleCoinNext(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) { await ctx.answerCbQuery().catch(() => {}); return; }
  const state = await updownAddState.get(telegramId);
  if (!state) { await ctx.answerCbQuery().catch(() => {}); return; }

  if (state.coins.length === 0) {
    await ctx.answerCbQuery('Select at least one asset').catch(() => {});
    return;
  }
  await ctx.answerCbQuery().catch(() => {});

  state.step = 'direction';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showDirectionStep(ctx);
}

// Step 2: Timeframes (multi-select)
async function showTimeframesStep(ctx: Context, state: AutoPilotAddState): Promise<void> {
  const selectedStr = state.timeframes.length === 0 ? 'none' : state.timeframes.map(tf => tfShort(tf)).join(', ');
  const tfButtons = TF_LIST.map(tf => {
    const sel = state.timeframes.includes(tf.key) ? '✅ ' : '';
    return Markup.button.callback(`${sel}${tf.label}`, `ap_tf_${tf.key}`);
  });

  await sendHtml(ctx,
    `🤖 <b>AutoPilot · Step 2 / 8</b>\n\n` +
    `Which timeframes should the bot scan? Pick one or more.\n\n` +
    `Selected: <b>${selectedStr}</b>`,
    Markup.inlineKeyboard([
      tfButtons,
      [
        Markup.button.callback(`↩️ Back`, 'ap_back'),
        Markup.button.callback(`Next Step ▶️`, 'ap_tf_next'),
      ],
    ]),
  );
}

export async function handleTfToggle(ctx: Context, tf: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  const idx = state.timeframes.indexOf(tf);
  if (idx >= 0) state.timeframes.splice(idx, 1);
  else state.timeframes.push(tf);
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showTimeframesStep(ctx, state);
}

export async function handleTfNext(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) { await ctx.answerCbQuery().catch(() => {}); return; }
  const state = await updownAddState.get(telegramId);
  if (!state) { await ctx.answerCbQuery().catch(() => {}); return; }

  if (state.timeframes.length === 0) {
    await ctx.answerCbQuery('Select at least one timeframe').catch(() => {});
    return;
  }
  await ctx.answerCbQuery().catch(() => {});

  state.step = 'coins';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showCoinsStep(ctx, state);
}

// Step 4: Direction
async function showDirectionStep(ctx: Context): Promise<void> {
  await sendHtml(ctx,
    `🤖 <b>AutoPilot · Step 4 / 8</b>\n\n` +
    `Pick how the bot should trade:\n\n` +
    `📈 <b>Up</b> — Buy UP tokens only\n` +
    `📉 <b>Down</b> — Buy DOWN tokens only\n` +
    `🔄 <b>Both</b> — Buy UP <i>and</i> DOWN (2 trades per candle)\n` +
    `🔀 <b>Either</b> — Buy whichever side is in range`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`📈 Up`, 'ap_dir_up'),
        Markup.button.callback(`📉 Down`, 'ap_dir_down'),
      ],
      [
        Markup.button.callback(`🔄 Both`, 'ap_dir_both'),
        Markup.button.callback(`🔀 Either`, 'ap_dir_either'),
      ],
      [Markup.button.callback(`↩️ Back`, 'ap_back')],
    ]),
  );
}

export async function handleDirectionSelect(ctx: Context, dir: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.direction = dir;
  state.step = 'amount';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showAmountStep(ctx);
}

// Step 5: Amount
async function showAmountStep(ctx: Context): Promise<void> {
  await sendHtml(ctx,
    `🤖 <b>AutoPilot · Step 5 / 8</b>\n\n` +
    `How much USD per trade?`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`$5`, 'ap_amt_5'),
        Markup.button.callback(`$20`, 'ap_amt_20'),
        Markup.button.callback(`$50`, 'ap_amt_50'),
      ],
      [Markup.button.callback(`✏️ Custom amount`, 'ap_amt_custom')],
      [Markup.button.callback(`↩️ Back`, 'ap_back')],
    ]),
  );
}

export async function handleAmountPreset(ctx: Context, amount: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.amount = amount;
  state.step = 'window';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showWindowStep(ctx, state);
}

export async function handleAmountCustom(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  // Keep step as 'amount' — text handler will pick it up
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await sendHtml(ctx,
    `🤖 <b>AutoPilot · Step 5 / 8</b>\n\nEnter a custom amount in USD (1–10000):`,
    Markup.inlineKeyboard([[Markup.button.callback(`↩️ Back`, 'ap_back')]]),
  );
}

// Step 6: Entry Window
async function showWindowStep(ctx: Context, state: AutoPilotAddState): Promise<void> {
  // Find shortest selected timeframe for dynamic text
  const shortestTf = state.timeframes.reduce((min, tf) => {
    const d = tfDurationSecs(tf);
    return d < tfDurationSecs(min) ? tf : min;
  }, state.timeframes[0]);
  const duration = tfDurationSecs(shortestTf);

  await sendHtml(ctx,
    `🤖 <b>AutoPilot · Step 6 / 8</b>\n\n` +
    `A <b>${tfShort(shortestTf)}</b> candle holds <b>${duration}s</b>.\n` +
    `How many seconds before candle end should the bot start looking?\n\n` +
    `Allowed custom range: 5–${duration}s`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`60 sec`, 'ap_win_60'),
        Markup.button.callback(`150 sec`, 'ap_win_150'),
      ],
      [Markup.button.callback(`Anytime`, 'ap_win_any')],
      [Markup.button.callback(`✏️ Custom seconds`, 'ap_win_custom')],
      [Markup.button.callback(`↩️ Back`, 'ap_back')],
    ]),
  );
}

export async function handleWindowPreset(ctx: Context, secs: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.entryWindowSecs = secs;
  state.step = 'range';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showRangeStep(ctx);
}

export async function handleWindowAnytime(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.entryWindowSecs = null;
  state.step = 'range';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showRangeStep(ctx);
}

export async function handleWindowCustom(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);

  const shortestTf = state.timeframes.reduce((min, tf) => {
    return tfDurationSecs(tf) < tfDurationSecs(min) ? tf : min;
  }, state.timeframes[0]);
  const maxSecs = tfDurationSecs(shortestTf);

  await sendHtml(ctx,
    `🤖 <b>AutoPilot · Step 6 / 8</b>\n\nEnter seconds (5–${maxSecs}):`,
    Markup.inlineKeyboard([[Markup.button.callback(`↩️ Back`, 'ap_back')]]),
  );
}

// Step 7: Price Range (in cents)
async function showRangeStep(ctx: Context): Promise<void> {
  await sendHtml(ctx,
    `🤖 <b>AutoPilot · Step 7 / 8</b>\n\n` +
    `Price in cents (0–100). The bot fires when the chosen side trades inside this range.`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`40–45¢`, 'ap_rng_40_45'),
        Markup.button.callback(`46–48¢`, 'ap_rng_46_48'),
      ],
      [
        Markup.button.callback(`90–98¢`, 'ap_rng_90_98'),
        Markup.button.callback(`95–98¢`, 'ap_rng_95_98'),
      ],
      [Markup.button.callback(`✏️ Custom range`, 'ap_rng_custom')],
      [
        Markup.button.callback(`⚡ Scalp preset`, 'ap_rng_scalp'),
        Markup.button.callback(`🎯 Arb preset`, 'ap_rng_arb'),
      ],
      [Markup.button.callback(`↩️ Back`, 'ap_back')],
    ]),
  );
}

export async function handleRangePreset(ctx: Context, min: number, max: number): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.priceRangeMin = min;
  state.priceRangeMax = max;
  state.step = 'tpsl';
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showTpSlStep(ctx, state);
}

export async function handleRangeCustom(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await sendHtml(ctx,
    `🤖 <b>AutoPilot · Step 7 / 8</b>\n\nEnter price range in cents as <code>min, max</code> (e.g. <code>40, 60</code>):`,
    Markup.inlineKeyboard([[Markup.button.callback(`↩️ Back`, 'ap_back')]]),
  );
}

// Step 8: TP/SL
async function showTpSlStep(ctx: Context, state: AutoPilotAddState): Promise<void> {
  const tpStr = state.takeProfitPct != null ? `+${state.takeProfitPct}%` : '—';
  const slStr = state.stopLossPct != null ? `-${state.stopLossPct}%` : '—';

  await sendHtml(ctx,
    `🤖 <b>AutoPilot · Step 8 / 8</b>\n\n` +
    `Take Profit: <b>${tpStr}</b>\n` +
    `Stop Loss: <b>${slStr}</b>\n\n` +
    `Set exit conditions or complete the strategy.`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`📈 Set TP %`, 'ap_tp_set'),
        Markup.button.callback(`📉 Set SL %`, 'ap_sl_set'),
      ],
      [Markup.button.callback(`🗑 Clear exits`, 'ap_tpsl_clear')],
      [
        Markup.button.callback(`↩️ Back`, 'ap_back'),
        Markup.button.callback(`✅ Complete & Save`, 'ap_save'),
      ],
    ]),
  );
}

export async function handleTpSet(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.timestamp = Date.now();
  // Stay on tpsl step — text handler checks for awaiting_tp
  (state as any)._awaitTp = true;
  updownAddState.set(telegramId, state);
  await sendHtml(ctx,
    `📈 <b>Take Profit</b>\n\nEnter TP % from entry (e.g. 50 for +50%):`,
    Markup.inlineKeyboard([[Markup.button.callback(`↩️ Back`, 'ap_tpsl_back')]]),
  );
}

export async function handleSlSet(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.timestamp = Date.now();
  (state as any)._awaitSl = true;
  updownAddState.set(telegramId, state);
  await sendHtml(ctx,
    `📉 <b>Stop Loss</b>\n\nEnter SL % from entry (e.g. 25 for -25%):`,
    Markup.inlineKeyboard([[Markup.button.callback(`↩️ Back`, 'ap_tpsl_back')]]),
  );
}

export async function handleTpSlClear(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  state.takeProfitPct = null;
  state.stopLossPct = null;
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showTpSlStep(ctx, state);
}

export async function handleTpSlBack(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) return;

  delete (state as any)._awaitTp;
  delete (state as any)._awaitSl;
  state.timestamp = Date.now();
  updownAddState.set(telegramId, state);
  await showTpSlStep(ctx, state);
}

// ─── Save (Complete) ────────────────────────────────────────────────────────

export async function handleSave(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const state = await updownAddState.get(telegramId);
  if (!state) {
    await sendHtml(ctx, 'Session expired. Please start again.');
    return;
  }

  // Validate required fields
  if (state.coins.length === 0 || state.timeframes.length === 0 || !state.direction || !state.amount) {
    await sendHtml(ctx, 'Incomplete setup. Please start again.');
    return;
  }

  // Convert cents to decimal for storage (upPriceMin/Max)
  const upPriceMin = (state.priceRangeMin ?? 1) / 100;
  const upPriceMax = (state.priceRangeMax ?? 99) / 100;

  const created = await prisma.$transaction(async (tx) => {
    const count = await tx.upDownStrategy.count({ where: { userId: user.id } });
    if (count >= MAX_STRATEGIES) return null;
    return tx.upDownStrategy.create({
      data: {
        userId: user.id,
        label: `AutoPilot`,
        coin: state.coins[0],
        coins: state.coins.length > 1 ? state.coins.join(',') : null,
        timeframe: state.timeframes[0],
        timeframes: state.timeframes.length > 1 ? state.timeframes.join(',') : null,
        direction: state.direction!,
        amount: state.amount!,
        entryWindowSecs: state.entryWindowSecs,
        upPriceMin,
        upPriceMax,
        // Set defaults for legacy fields
        timeRangeStart: '00:00',
        timeRangeEnd: '59:59',
        priceChangeMin: -9999,
        priceChangeMax: 9999,
        orderType: 'market',
        maxRounds: 9999,
        slippage: 5,
        takeProfitPct: state.takeProfitPct,
        stopLossPct: state.stopLossPct,
        isPaused: false, // Start active immediately
      },
    });
  });

  if (!created) {
    await sendHtml(ctx, `Maximum ${MAX_STRATEGIES} strategies reached. Delete one first.`);
    return;
  }

  updownAddState.delete(telegramId);

  const shortId = created.id.slice(-6);
  await sendHtml(ctx,
    `✅ <b>AutoPilot Strategy Created</b>\n\n` +
    `ID: <code>${shortId}</code>\n` +
    `The watcher will start scanning for entries on the next tick.`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`↩️ Back to list`, 'updown_list'),
        Markup.button.callback(`+ New`, 'ud_start_add'),
      ],
    ]),
  );
}

// ─── Back Handler ───────────────────────────────────────────────────────────

export async function handleBack(ctx: Context): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;
  const state = await updownAddState.get(telegramId);
  if (!state) { await handleUpDownList(ctx); return; }

  state.timestamp = Date.now();

  switch (state.step) {
    case 'category':
      updownAddState.delete(telegramId);
      await handleUpDownList(ctx);
      return;
    case 'timeframes':
      state.step = 'category';
      updownAddState.set(telegramId, state);
      await showCategoryStep(ctx);
      return;
    case 'coins':
      state.step = 'timeframes';
      updownAddState.set(telegramId, state);
      await showTimeframesStep(ctx, state);
      return;
    case 'direction':
      state.step = 'coins';
      updownAddState.set(telegramId, state);
      await showCoinsStep(ctx, state);
      return;
    case 'amount':
      state.step = 'direction';
      updownAddState.set(telegramId, state);
      await showDirectionStep(ctx);
      return;
    case 'window':
      state.step = 'amount';
      updownAddState.set(telegramId, state);
      await showAmountStep(ctx);
      return;
    case 'range':
      state.step = 'window';
      updownAddState.set(telegramId, state);
      await showWindowStep(ctx, state);
      return;
    case 'tpsl':
      state.step = 'range';
      updownAddState.set(telegramId, state);
      await showRangeStep(ctx);
      return;
    default:
      updownAddState.delete(telegramId);
      await handleUpDownList(ctx);
  }
}

// ─── Add Flow Text Input Handler ────────────────────────────────────────────

export async function handleAddInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;
  const state = await updownAddState.get(telegramId);
  if (!state) return false;

  // TP input
  if ((state as any)._awaitTp) {
    const n = parseNumber(text);
    if (n == null || n <= 0 || n > 1000) {
      await ctx.reply('Enter a percentage between 1 and 1000.');
      return true;
    }
    state.takeProfitPct = n;
    delete (state as any)._awaitTp;
    state.timestamp = Date.now();
    updownAddState.set(telegramId, state);
    await showTpSlStep(ctx, state);
    return true;
  }

  // SL input
  if ((state as any)._awaitSl) {
    const n = parseNumber(text);
    if (n == null || n <= 0 || n > 100) {
      await ctx.reply('Enter a percentage between 1 and 100.');
      return true;
    }
    state.stopLossPct = n;
    delete (state as any)._awaitSl;
    state.timestamp = Date.now();
    updownAddState.set(telegramId, state);
    await showTpSlStep(ctx, state);
    return true;
  }

  switch (state.step) {
    case 'amount': {
      const n = parseNumber(text);
      if (n == null || n < 1 || n > 10000) {
        await ctx.reply('Enter a valid amount (1–10000).');
        return true;
      }
      state.amount = n;
      state.step = 'window';
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showWindowStep(ctx, state);
      return true;
    }

    case 'window': {
      const n = parseNumber(text);
      const shortestTf = state.timeframes.reduce((min, tf) => {
        return tfDurationSecs(tf) < tfDurationSecs(min) ? tf : min;
      }, state.timeframes[0]);
      const maxSecs = tfDurationSecs(shortestTf);

      if (n == null || n < 5 || n > maxSecs) {
        await ctx.reply(`Enter seconds between 5 and ${maxSecs}.`);
        return true;
      }
      state.entryWindowSecs = Math.round(n);
      state.step = 'range';
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showRangeStep(ctx);
      return true;
    }

    case 'range': {
      const parts = text.split(',').map(s => s.trim());
      if (parts.length !== 2) {
        await ctx.reply('Enter as min, max in cents (e.g. 40, 60)');
        return true;
      }
      const min = parseNumber(parts[0]);
      const max = parseNumber(parts[1]);
      if (min == null || max == null || min < 0 || max > 100 || min > max) {
        await ctx.reply('Invalid range. Use 0–100, min ≤ max.');
        return true;
      }
      state.priceRangeMin = Math.round(min);
      state.priceRangeMax = Math.round(max);
      state.step = 'tpsl';
      state.timestamp = Date.now();
      updownAddState.set(telegramId, state);
      await showTpSlStep(ctx, state);
      return true;
    }
  }

  return false;
}

// ─── Ownership Helper ────────────────────────────────────────────────────────

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
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) { if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {}); return; }
  updownEditState.delete(telegramId);

  const strat = await verifyUdOwnership(ctx, stratId);
  if (!strat) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Strategy not found').catch(() => {});
    return;
  }
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const statusStr = strat.isActive && !strat.isPaused ? `🟢 Running` : `🔴 Paused`;
  const coins = getStratCoins(strat);
  const tfs = getStratTimeframes(strat);
  const dirStr = strat.direction === 'up' ? 'UP'
    : strat.direction === 'down' ? 'DOWN'
    : strat.direction === 'both' ? 'Both'
    : 'Either';
  const orderStr = strat.orderType === 'limit' && strat.limitPrice
    ? `Limit @ ${strat.limitPrice} (TTL: ${strat.limitTtlSeconds}s)` : 'Market';

  const windowStr = strat.entryWindowSecs != null ? `${strat.entryWindowSecs}s` : 'Anytime';
  const rangeMinCents = Math.round(strat.upPriceMin * 100);
  const rangeMaxCents = Math.round(strat.upPriceMax * 100);

  const tpStr = strat.takeProfitPct != null ? `${strat.takeProfitPct}%`
    : strat.takeProfitPrice != null ? `@${strat.takeProfitPrice}` : '–';
  const slStr = strat.stopLossPct != null ? `${strat.stopLossPct}%`
    : strat.stopLossPrice != null ? `@${strat.stopLossPrice}` : '–';

  const lines = [
    `<b>${esc(strat.label || 'AutoPilot')}</b>`,
    `${statusStr}`,
    ``,
    `Assets: ${coins.join(', ')}`,
    `Timeframes: ${tfs.map(tf => tfShort(tf)).join(', ')}`,
    `Direction: ${dirStr}`,
    `Amount: $${strat.amount.toFixed(2)}`,
    `Order: ${orderStr}`,
    `Entry Window: ${windowStr}`,
    `Price Range: ${rangeMinCents}–${rangeMaxCents}¢`,
    `Rounds: ${strat.roundsExecuted}/${strat.maxRounds}`,
    `TP: ${tpStr} · SL: ${slStr}`,
    `Slippage: ${strat.slippage}%`,
    `Notifications: ${onOff(strat.notificationsEnabled)}`,
  ];

  const id = strat.id;
  const isRunning = strat.isActive && !strat.isPaused;

  const buttons: any[][] = [
    [Markup.button.callback(isRunning ? `⏹ Pause` : `▶️ Start`, isRunning ? `udm_pause_${id}` : `udm_start_${id}`)],
    [
      Markup.button.callback('Coins', `udm_coins_${id}`),
      Markup.button.callback('Timeframes', `udm_tfs_${id}`),
      Markup.button.callback('Direction', `udm_dir_${id}`),
    ],
    [
      Markup.button.callback('Amount', `udm_amt_${id}`),
      Markup.button.callback('Window', `udm_win_${id}`),
      Markup.button.callback('Range', `udm_up_${id}`),
    ],
    [
      Markup.button.callback('Order Type', `udm_ot_${id}`),
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
    [Markup.button.callback(`← Back`, 'updown_list')],
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
  // Cycle: up → down → both → either → up
  const cycle: Record<string, string> = { up: 'down', down: 'both', both: 'either', either: 'up' };
  const next = cycle[strat.direction] || 'up';
  await prisma.upDownStrategy.update({
    where: { id: stratId },
    data: { direction: next },
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
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;
    updownEditState.set(telegramId, {
      step: 'awaiting_limit_price',
      stratId,
      timestamp: Date.now(),
    });
    await sendHtml(ctx,
      `💲 <b>Set Limit Price</b>\n\nEnter limit order price (0.01–0.99):`,
      Markup.inlineKeyboard([[Markup.button.callback(`← Cancel`, `ud_task_${stratId}`)]]),
    );
  } else {
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
    Markup.inlineKeyboard([[Markup.button.callback(`← Cancel`, `ud_task_${stratId}`)]]),
  );
}

export async function handleManageDelete(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendHtml(ctx,
    `⚠️ <b>Delete Strategy</b>\n\nAre you sure?`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`🗑 Yes, Delete`, `udm_deldo_${stratId}`),
        Markup.button.callback(`← Cancel`, `ud_task_${stratId}`),
      ],
    ]),
  );
}

export async function handleManageDeleteExecute(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  const strat = await verifyUdOwnership(ctx, stratId);
  if (!strat) return;
  try {
    await prisma.upDownTrade.deleteMany({ where: { strategyId: stratId } });
    await prisma.upDownStrategy.deleteMany({ where: { id: stratId } });
  } catch (err: any) {
    logger.error(`[autopilot] Failed to delete strategy ${stratId}: ${err?.message}`);
    await sendHtml(ctx, 'Failed to delete strategy. Please try again.');
    return;
  }
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
    Markup.inlineKeyboard([[Markup.button.callback(`← Cancel`, `ud_task_${stratId}`)]]),
  );
}

// TP/SL manage prompts
export async function handleManageTpPrompt(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendHtml(ctx,
    `🏆 <b>Take Profit</b>\n\nSelect TP type:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`📊 % from entry`, `udm_tp_pct_${stratId}`),
        Markup.button.callback(`💲 Fixed price`, `udm_tp_fix_${stratId}`),
      ],
      [Markup.button.callback(`🗑 Clear TP`, `udm_tp_clr_${stratId}`)],
      [Markup.button.callback(`← Cancel`, `ud_task_${stratId}`)],
    ]),
  );
}

export async function handleManageSlPrompt(ctx: Context, stratId: string): Promise<void> {
  await ctx.answerCbQuery().catch(() => {});
  await sendHtml(ctx,
    `🛑 <b>Stop Loss</b>\n\nSelect SL type:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`📊 % from entry`, `udm_sl_pct_${stratId}`),
        Markup.button.callback(`💲 Fixed price`, `udm_sl_fix_${stratId}`),
      ],
      [Markup.button.callback(`🗑 Clear SL`, `udm_sl_clr_${stratId}`)],
      [Markup.button.callback(`← Cancel`, `ud_task_${stratId}`)],
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

// Manage: Edit entry window
export async function handleManageWindow(ctx: Context, stratId: string): Promise<void> {
  await handleManageEditPrompt(ctx, stratId, 'awaiting_entry_window',
    `⏱ <b>Edit Entry Window</b>\n\nEnter seconds before candle end (5–14400), or "0" for Anytime:`);
}

// Manage: Edit coins
export async function handleManageCoins(ctx: Context, stratId: string): Promise<void> {
  await handleManageEditPrompt(ctx, stratId, 'awaiting_coins',
    `🪙 <b>Edit Assets</b>\n\nEnter comma-separated assets (e.g. <code>BTC,ETH,SOL</code>):`);
}

// Manage: Edit timeframes
export async function handleManageTimeframes(ctx: Context, stratId: string): Promise<void> {
  await handleManageEditPrompt(ctx, stratId, 'awaiting_timeframes',
    `⏱ <b>Edit Timeframes</b>\n\nEnter comma-separated (e.g. <code>5-Minute,1-Hour,4-Hour</code>)\n\nValid: 5-Minute, 15-Minute, 1-Hour, 4-Hour`);
}

// ─── Edit Text Input Handler ────────────────────────────────────────────────

export async function handleEditInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;
  const state = await updownEditState.get(telegramId);
  if (!state) return false;

  const { step, stratId } = state;

  const owned = await verifyUdOwnership(ctx, stratId);
  if (!owned) {
    updownEditState.delete(telegramId);
    await ctx.reply('Strategy not found.');
    return true;
  }

  switch (step) {
    case 'awaiting_amount': {
      const n = parseNumber(text);
      if (n == null || n < 1 || n > 10000) {
        await ctx.reply('Enter a valid amount (1–10000).');
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
        await ctx.reply('Enter slippage between 0.1 and 50.');
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
        await ctx.reply('Enter as mm:ss, mm:ss (e.g. 00:00, 14:55)');
        return true;
      }
      const m1 = /^(\d{1,2}):(\d{2})$/.exec(parts[0]);
      const m2 = /^(\d{1,2}):(\d{2})$/.exec(parts[1]);
      if (!m1 || !m2) {
        await ctx.reply('Invalid time format. Use mm:ss');
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
        await ctx.reply('Enter as min, max in cents (e.g. 40, 60)');
        return true;
      }
      const min = parseNumber(parts[0]);
      const max = parseNumber(parts[1]);
      if (min == null || max == null || min < 0 || max > 100 || min > max) {
        await ctx.reply('Invalid range. Use 0–100, min ≤ max.');
        return true;
      }
      await prisma.upDownStrategy.update({
        where: { id: stratId },
        data: { upPriceMin: min / 100, upPriceMax: max / 100 },
      });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_price_change': {
      const parts = text.split(',').map(s => s.trim());
      if (parts.length !== 2) {
        await ctx.reply('Enter as min, max in USD (e.g. -100, 9999)');
        return true;
      }
      const min = parseNumber(parts[0]);
      const max = parseNumber(parts[1]);
      if (min == null || max == null || min > max) {
        await ctx.reply('Invalid. Min must be ≤ max.');
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
      if (n == null || n < 1 || n > 99999) {
        await ctx.reply('Enter a number between 1 and 99999.');
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
        await ctx.reply('Name cannot be empty.');
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
        await ctx.reply('Enter a price between 0.01 and 0.99.');
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
        await ctx.reply('Enter seconds between 10 and 300.');
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
        await ctx.reply('Enter a percentage (1–1000).');
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
        await ctx.reply('Enter a price between 0.01 and 0.99.');
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
        await ctx.reply('Enter a percentage (1–100).');
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
        await ctx.reply('Enter a price between 0.01 and 0.99.');
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

    case 'awaiting_entry_window': {
      const n = parseNumber(text);
      if (n != null && n === 0) {
        // Anytime
        await prisma.upDownStrategy.update({ where: { id: stratId }, data: { entryWindowSecs: null } });
        updownEditState.delete(telegramId);
        await handleManage(ctx, stratId);
        return true;
      }
      if (n == null || n < 5 || n > 14400) {
        await ctx.reply('Enter seconds between 5 and 14400, or 0 for Anytime.');
        return true;
      }
      await prisma.upDownStrategy.update({ where: { id: stratId }, data: { entryWindowSecs: Math.round(n) } });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_coins': {
      const raw = text.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      const valid = raw.filter(c => COIN_LIST.includes(c));
      if (valid.length === 0) {
        await ctx.reply(`Enter valid coins: ${COIN_LIST.join(', ')}`);
        return true;
      }
      await prisma.upDownStrategy.update({
        where: { id: stratId },
        data: {
          coin: valid[0],
          coins: valid.length > 1 ? valid.join(',') : null,
        },
      });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }

    case 'awaiting_timeframes': {
      const validTfs = TF_LIST.map(t => t.key);
      const raw = text.split(',').map(s => s.trim()).filter(Boolean);
      const valid = raw.filter(t => validTfs.includes(t));
      if (valid.length === 0) {
        await ctx.reply(`Enter valid timeframes: ${validTfs.join(', ')}`);
        return true;
      }
      await prisma.upDownStrategy.update({
        where: { id: stratId },
        data: {
          timeframe: valid[0],
          timeframes: valid.length > 1 ? valid.join(',') : null,
        },
      });
      updownEditState.delete(telegramId);
      await handleManage(ctx, stratId);
      return true;
    }
  }

  return false;
}
