/**
 * Backtest handler — strategy simulation against historical data.
 * Action prefixes: bt_ (menu), btb_ (bond), btc_ (copy), btu_ (updown)
 */

import { Context, Markup } from 'telegraf';
import { RedisBackedState } from '../../utils/redisState';
import { sendPage } from '../../utils/telegram';
import { getUserByTelegramId } from '../../services/user';
import { prisma } from '../../database/prisma';
import {
  backtestBond,
  backtestCopy,
  backtestUpDown,
  getBacktestHistory,
  getBacktestById,
} from '../../services/backtest';
import { t, Locale } from '../../i18n';
import { fmtUsd } from '../../services/smartWallets';
import { logger } from '../../utils/logger';

// ── State ──────────────────────────────────────────────────────────────────

export interface BacktestState {
  step: 'select_type' | 'select_strategy' | 'select_period' | 'running' | 'results';
  type?: 'bond' | 'copy' | 'updown';
  strategyId?: string;
  strategyLabel?: string;
  lookbackDays?: number;
  resultId?: string;
  timestamp: number;
}

export const backtestState = new RedisBackedState<BacktestState>('backtest', 600);

// Cleanup stale states every 30 min
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, state] of backtestState.entries()) {
    if (state.timestamp < cutoff) backtestState.delete(key);
  }
}, 30 * 60 * 1000);

// ── Helpers ────────────────────────────────────────────────────────────────

function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

function sendHtml(ctx: Context, text: string, markup?: any) {
  return sendPage(ctx, text, { ...(markup ?? {}), parse_mode: 'HTML' });
}

function signPnl(n: number): string {
  return n >= 0 ? `+${fmtUsd(n)}` : `-${fmtUsd(Math.abs(n))}`;
}

function pctStr(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

// ── Menu ───────────────────────────────────────────────────────────────────

export async function handleBacktestCommand(ctx: Context): Promise<void> {
  await handleBacktestMenu(ctx);
}

export async function handleBacktestMenu(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  backtestState.delete(telegramId);

  const lines = [
    `🧪 <b>${t(lang, 'bt.menu.title')}</b>`,
    ``,
    t(lang, 'bt.menu.subtitle'),
    ``,
    `${t(lang, 'bt.selectType')}`,
  ];

  const buttons = [
    [Markup.button.callback(`🎯 ${t(lang, 'bt.btn.bond')}`, 'bt_bond')],
    [Markup.button.callback(`⚡ ${t(lang, 'bt.btn.copy')}`, 'bt_copy')],
    [Markup.button.callback(`📊 ${t(lang, 'bt.btn.updown')}`, 'bt_updown')],
    [Markup.button.callback(`📜 ${t(lang, 'bt.btn.history')}`, 'bt_hist')],
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'auto_strategies')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ── Strategy Selection ─────────────────────────────────────────────────────

export async function handleBacktestBond(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  const strategies = await prisma.bondStrategy.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });

  if (strategies.length === 0) {
    await sendHtml(ctx, `❌ ${t(lang, 'bt.noStrategies')}`);
    return;
  }

  await backtestState.set(telegramId, {
    step: 'select_strategy',
    type: 'bond',
    timestamp: Date.now(),
  });

  const lines = [
    `🧪 <b>${t(lang, 'bt.btn.bond')}</b>`,
    ``,
    t(lang, 'bt.selectStrategy'),
  ];

  const buttons = strategies.map(s => [
    Markup.button.callback(
      `${s.isPaused ? '⏸' : '🟢'} ${s.label ?? `Bond #${s.id.slice(-4)}`}`,
      `btb_sel_${s.id.slice(-8)}`,
    ),
  ]);
  buttons.push([Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'bt_menu')]);

  // Store mapping: shortId → fullId in state
  await backtestState.set(telegramId, {
    step: 'select_strategy',
    type: 'bond',
    timestamp: Date.now(),
  });

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

export async function handleBacktestCopy(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  const subs = await prisma.copySubscription.findMany({
    where: { userId: user.id, isActive: true },
    orderBy: { createdAt: 'desc' },
  });

  if (subs.length === 0) {
    await sendHtml(ctx, `❌ ${t(lang, 'bt.noStrategies')}`);
    return;
  }

  await backtestState.set(telegramId, {
    step: 'select_strategy',
    type: 'copy',
    timestamp: Date.now(),
  });

  const lines = [
    `🧪 <b>${t(lang, 'bt.btn.copy')}</b>`,
    ``,
    t(lang, 'bt.selectStrategy'),
  ];

  const buttons = subs.map(s => [
    Markup.button.callback(
      `${s.isPaused ? '⏸' : '🟢'} ${s.label ?? s.traderAddress.slice(0, 10) + '...'}`,
      `btc_sel_${s.id.slice(-8)}`,
    ),
  ]);
  buttons.push([Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'bt_menu')]);

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

export async function handleBacktestUpDown(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  const strategies = await prisma.upDownStrategy.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });

  if (strategies.length === 0) {
    await sendHtml(ctx, `❌ ${t(lang, 'bt.noStrategies')}`);
    return;
  }

  await backtestState.set(telegramId, {
    step: 'select_strategy',
    type: 'updown',
    timestamp: Date.now(),
  });

  const lines = [
    `🧪 <b>${t(lang, 'bt.btn.updown')}</b>`,
    ``,
    t(lang, 'bt.selectStrategy'),
  ];

  const buttons = strategies.map(s => [
    Markup.button.callback(
      `${s.isPaused ? '⏸' : '🟢'} ${s.label ?? `${s.coin} ${s.timeframe}`}`,
      `btu_sel_${s.id.slice(-8)}`,
    ),
  ]);
  buttons.push([Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'bt_menu')]);

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ── Strategy Selection Handler ─────────────────────────────────────────────

export async function handleBacktestSelectStrategy(
  ctx: Context,
  type: 'bond' | 'copy' | 'updown',
  shortId: string,
): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  // Find strategy by short ID suffix
  let strategyId: string | undefined;
  let label: string | undefined;

  if (type === 'bond') {
    const strats = await prisma.bondStrategy.findMany({ where: { userId: user.id } });
    const found = strats.find(s => s.id.endsWith(shortId));
    strategyId = found?.id;
    label = found?.label ?? `Bond #${shortId}`;
  } else if (type === 'copy') {
    const subs = await prisma.copySubscription.findMany({ where: { userId: user.id, isActive: true } });
    const found = subs.find(s => s.id.endsWith(shortId));
    strategyId = found?.id;
    label = found?.label ?? `Copy ${found?.traderAddress?.slice(0, 10) ?? shortId}`;
  } else {
    const strats = await prisma.upDownStrategy.findMany({ where: { userId: user.id } });
    const found = strats.find(s => s.id.endsWith(shortId));
    strategyId = found?.id;
    label = found?.label ?? `${found?.coin ?? ''} ${found?.timeframe ?? ''}`;
  }

  if (!strategyId) {
    await sendHtml(ctx, `❌ ${t(lang, 'common.error')}`);
    return;
  }

  await backtestState.set(telegramId, {
    step: 'select_period',
    type,
    strategyId,
    strategyLabel: label,
    timestamp: Date.now(),
  });

  const lines = [
    `🧪 <b>Backtest: ${label}</b>`,
    ``,
    t(lang, 'bt.selectPeriod'),
  ];

  const buttons = [
    [
      Markup.button.callback(t(lang, 'bt.btn.7d'), 'bt_p_7'),
      Markup.button.callback(t(lang, 'bt.btn.14d'), 'bt_p_14'),
    ],
    [
      Markup.button.callback(t(lang, 'bt.btn.30d'), 'bt_p_30'),
    ],
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'bt_menu')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ── Period Selection & Run ─────────────────────────────────────────────────

export async function handleBacktestPeriod(ctx: Context, days: number): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  const state = await backtestState.get(telegramId);
  if (!state?.strategyId || !state.type) {
    await sendHtml(ctx, `❌ ${t(lang, 'common.error')}`);
    return;
  }

  await backtestState.set(telegramId, {
    ...state,
    step: 'running',
    lookbackDays: days,
    timestamp: Date.now(),
  });

  await sendHtml(ctx, `⏳ ${t(lang, 'bt.running')}`);

  try {
    let resultId: string;

    if (state.type === 'bond') {
      const strategy = await prisma.bondStrategy.findUnique({ where: { id: state.strategyId } });
      if (!strategy) throw new Error('Strategy not found');
      resultId = await backtestBond(strategy, { lookbackDays: days }, user.id);
    } else if (state.type === 'copy') {
      const sub = await prisma.copySubscription.findUnique({ where: { id: state.strategyId } });
      if (!sub) throw new Error('Subscription not found');
      resultId = await backtestCopy(sub, { lookbackDays: days }, user.id);
    } else {
      const strategy = await prisma.upDownStrategy.findUnique({ where: { id: state.strategyId } });
      if (!strategy) throw new Error('Strategy not found');
      resultId = await backtestUpDown(strategy, { lookbackDays: days }, user.id);
    }

    await backtestState.set(telegramId, {
      ...state,
      step: 'results',
      lookbackDays: days,
      resultId,
      timestamp: Date.now(),
    });

    await showBacktestResult(ctx, resultId, lang);
  } catch (err: any) {
    logger.error(`[backtest] Run failed: ${err?.message}`);
    await sendHtml(ctx, `❌ ${t(lang, 'bt.error')}\n\n${err?.message?.slice(0, 100) ?? 'Unknown error'}`);
  }
}

// ── Results Display ────────────────────────────────────────────────────────

async function showBacktestResult(ctx: Context, resultId: string, lang: Locale): Promise<void> {
  const result = await getBacktestById(resultId);
  if (!result) {
    await sendHtml(ctx, `❌ ${t(lang, 'common.error')}`);
    return;
  }

  const start = result.periodStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const end = result.periodEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const lines = [
    `🧪 <b>${t(lang, 'bt.result.title')}</b>`,
    ``,
    `📋 <b>${result.strategyLabel}</b>`,
    `📅 ${start} – ${end} (${result.lookbackDays}d)`,
    ``,
    `📊 <b>Summary</b>`,
    `├ Trades: ${result.totalTrades} (${result.wins}W / ${result.losses}L)`,
    `├ Win Rate: ${result.winRate.toFixed(1)}%`,
    `├ PnL: ${signPnl(result.totalPnl)}`,
    `├ ROI: ${pctStr(result.roi)}`,
    `├ Avg: ${signPnl(result.avgProfit)}/trade`,
    `└ Max DD: ${fmtUsd(result.maxDrawdown)}`,
    ``,
    `⚠️ ${t(lang, 'bt.disclaimer')}`,
  ];

  const buttons = [
    [
      Markup.button.callback(`🔄 ${t(lang, 'bt.btn.rerun')}`, `bt_p_${result.lookbackDays}`),
      Markup.button.callback(`📜 ${t(lang, 'bt.btn.history')}`, 'bt_hist'),
    ],
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'bt_menu')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ── View Single Result ─────────────────────────────────────────────────────

export async function handleBacktestView(ctx: Context, resultId: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  await showBacktestResult(ctx, resultId, lang);
}

// ── History ────────────────────────────────────────────────────────────────

export async function handleBacktestHistory(ctx: Context, page: number = 1): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  const { results, total, totalPages } = await getBacktestHistory(user.id, page);

  if (results.length === 0) {
    const lines = [
      `📜 <b>${t(lang, 'bt.history.title')}</b>`,
      ``,
      t(lang, 'bt.history.empty'),
    ];
    const buttons = [
      [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'bt_menu')],
    ];
    await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
    return;
  }

  const typeEmoji: Record<string, string> = { bond: '🎯', copy: '⚡', updown: '📊' };

  const lines = [
    `📜 <b>${t(lang, 'bt.history.title')}</b> (${total} total)`,
    ``,
    ...results.map((r, i) => {
      const idx = (page - 1) * 5 + i + 1;
      const date = r.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const emoji = typeEmoji[r.strategyType] ?? '🧪';
      return `${idx}. ${emoji} ${r.strategyLabel}\n   ${date} | ${r.lookbackDays}d | ${signPnl(r.totalPnl)} | ${r.winRate.toFixed(0)}% WR`;
    }),
  ];

  const buttons: any[][] = results.map(r => [
    Markup.button.callback(`📊 View`, `bt_view_${r.id.slice(-8)}`),
  ]);

  const navButtons: any[] = [];
  if (page > 1) navButtons.push(Markup.button.callback('« Prev', `bt_hist_${page - 1}`));
  if (page < totalPages) navButtons.push(Markup.button.callback('Next »', `bt_hist_${page + 1}`));
  if (navButtons.length > 0) buttons.push(navButtons);

  buttons.push([Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'bt_menu')]);

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ── View by Short ID ───────────────────────────────────────────────────────

export async function handleBacktestViewByShortId(ctx: Context, shortId: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  // Find by short suffix
  const results = await prisma.backtestResult.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const found = results.find(r => r.id.endsWith(shortId));

  if (!found) {
    await sendHtml(ctx, `❌ ${t(lang, 'common.error')}`);
    return;
  }

  await showBacktestResult(ctx, found.id, lang);
}
