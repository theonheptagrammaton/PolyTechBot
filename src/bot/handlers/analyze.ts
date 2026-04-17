/**
 * Analyze handler — Market analysis, Wallet analysis, Smart Money scanner.
 * Action prefixes: az_ (menu), azm_ (market), azw_ (wallet), azs_ (smart)
 */

import { Context, Markup } from 'telegraf';
import { RedisBackedState } from '../../utils/redisState';
import { sendPage } from '../../utils/telegram';
import { getUserByTelegramId } from '../../services/user';
import {
  analyzeMarket,
  analyzeWallet,
  scanSmartMoney,
  getMarketVolumeDetail,
  getMarketHolders,
  getWalletPnlHistory,
  getWalletMarketsPage,
  getWalletSimilar,
  MarketAnalysis,
  WalletAnalysis,
  WalletMetricsSummary,
} from '../../services/analyze';
import { detectPolymarketLink } from './search';
import { fetchOpenMarkets } from '../../services/predexonData';
import { t, Locale } from '../../i18n';
import { fmtUsd } from '../../services/smartWallets';
import { logger } from '../../utils/logger';

// ── State ──────────────────────────────────────────────────────────────────

export interface AnalyzeState {
  step: 'market_search' | 'wallet_search' | 'viewing';
  conditionId?: string;
  walletAddress?: string;
  page?: number;
  timestamp: number;
}

export const analyzeState = new RedisBackedState<AnalyzeState>('analyze', 600);

// Cleanup stale states every 30 min
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, state] of analyzeState.entries()) {
    if (state.timestamp < cutoff) analyzeState.delete(key);
  }
}, 30 * 60 * 1000);

// ── Helpers ────────────────────────────────────────────────────────────────

function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

function sendHtml(ctx: Context, text: string, markup?: any) {
  return sendPage(ctx, text, { ...(markup ?? {}), parse_mode: 'HTML' });
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function signPnl(n: number): string {
  return n >= 0 ? `+${fmtUsd(n)}` : `-${fmtUsd(Math.abs(n))}`;
}

function pctStr(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function signalEmoji(signal: string): string {
  if (signal === 'Bullish') return '🟢';
  if (signal === 'Bearish') return '🔴';
  return '⚪';
}

// ── Menu ───────────────────────────────────────────────────────────────────

export async function handleAnalyzeMenu(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  analyzeState.delete(telegramId);

  const lines = [
    `🔬 <b>${t(lang, 'az.menu.title')}</b>`,
    ``,
    t(lang, 'az.menu.subtitle'),
    ``,
    `📊 ${t(lang, 'az.btn.market')} — ${t(lang, 'az.market.desc')}`,
    `👛 ${t(lang, 'az.btn.wallet')} — ${t(lang, 'az.wallet.desc')}`,
    `🧠 ${t(lang, 'az.btn.smart')} — ${t(lang, 'az.smart.desc')}`,
  ];

  const buttons = [
    [Markup.button.callback(`📊 ${t(lang, 'az.btn.market')}`, 'az_market')],
    [Markup.button.callback(`👛 ${t(lang, 'az.btn.wallet')}`, 'az_wallet')],
    [Markup.button.callback(`🧠 ${t(lang, 'az.btn.smart')}`, 'az_smart')],
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'auto_strategies')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ── Market Search Prompt ───────────────────────────────────────────────────

export async function handleAnalyzeMarketPrompt(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  await analyzeState.set(telegramId, { step: 'market_search', timestamp: Date.now() });

  const lines = [
    `🔬 <b>${t(lang, 'az.btn.market')}</b>`,
    ``,
    t(lang, 'az.market.prompt'),
  ];

  const buttons = [
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'az_menu')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ── Market Detail ──────────────────────────────────────────────────────────

export async function handleAnalyzeMarketDetail(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  const state = await analyzeState.get(telegramId);
  const conditionId = state?.conditionId;
  if (!conditionId) {
    await sendHtml(ctx, `❌ ${t(lang, 'common.error')}`);
    return;
  }

  await sendHtml(ctx, `⏳ ${t(lang, 'az.loading')}`);

  const analysis = await analyzeMarket(conditionId);
  if (!analysis) {
    await sendHtml(ctx, `❌ ${t(lang, 'az.market.notFound')}`);
    return;
  }

  const pt = analysis.priceTrend;
  const va = analysis.volumeAnalysis;
  const sm = analysis.smartMoney;

  const lines = [
    `🔬 <b>${t(lang, 'az.market.title')}</b>`,
    ``,
    `📊 <b>${analysis.title}</b>`,
    `💰 Vol: ${fmtUsd(analysis.volume)} | OI: ${fmtUsd(analysis.openInterest)}`,
    `📈 YES ${(analysis.yesPrice * 100).toFixed(0)}¢ / NO ${(analysis.noPrice * 100).toFixed(0)}¢`,
    ``,
    `📉 <b>7d Trend</b>`,
    `├ ${(pt.open7d * 100).toFixed(0)}¢ → ${(pt.current * 100).toFixed(0)}¢ (${pctStr(pt.changePct)})`,
    `├ High: ${(pt.high7d * 100).toFixed(0)}¢ | Low: ${(pt.low7d * 100).toFixed(0)}¢`,
    `└ Volatility: ${pt.volatility}`,
    ``,
    `📊 <b>Volume (7d)</b>`,
    `├ Daily Avg: ${fmtUsd(va.dailyAvg)}`,
    `├ Buy/Sell: ${va.buySellRatio.toFixed(1)}:1`,
    `└ OI Δ: ${signPnl(va.oiChange7d)}`,
    ``,
    `🧠 <b>Smart Money</b>`,
    `├ ${signalEmoji(sm.signal)} ${sm.netBuyers} buy / ${sm.netSellers} sell`,
    `├ Vol: ${fmtUsd(sm.smartVolume)}`,
    `└ Signal: ${sm.signal}`,
  ];

  const buttons = [
    [
      Markup.button.callback(`📊 ${t(lang, 'az.btn.volumeDetail')}`, 'azm_vol'),
      Markup.button.callback(`🧠 ${t(lang, 'az.btn.smartDetail')}`, 'azm_smart'),
    ],
    [
      Markup.button.callback(`👥 Holders YES`, 'azm_hold_y'),
      Markup.button.callback(`👥 Holders NO`, 'azm_hold_n'),
    ],
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'az_menu')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ── Market Sub-pages ───────────────────────────────────────────────────────

export async function handleAnalyzeMarketVolume(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);
  const state = await analyzeState.get(telegramId);
  if (!state?.conditionId) return;

  const volume = await getMarketVolumeDetail(state.conditionId);
  if (!volume || volume.length === 0) {
    await sendHtml(ctx, `❌ ${t(lang, 'az.noData')}`);
    return;
  }

  const lines = [
    `📊 <b>Volume Detail (30d)</b>`,
    ``,
    ...volume.slice(-14).map(v => {
      const d = new Date(v.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `${d}: ${fmtUsd(v.total_volume)} (B:${fmtUsd(v.buy_volume)} S:${fmtUsd(v.sell_volume)})`;
    }),
  ];

  const buttons = [
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'azm_detail')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

export async function handleAnalyzeMarketHolders(ctx: Context, side: 'yes' | 'no'): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);
  const state = await analyzeState.get(telegramId);
  if (!state?.conditionId) return;

  const holders = await getMarketHolders(state.conditionId, side);
  if (!holders || holders.length === 0) {
    await sendHtml(ctx, `❌ ${t(lang, 'az.noData')}`);
    return;
  }

  const lines = [
    `👥 <b>Top Holders (${side.toUpperCase()})</b>`,
    ``,
    ...holders.slice(0, 10).map((h, i) => {
      const addr = shortAddr(h.wallet);
      return `${i + 1}. <code>${addr}</code> — ${h.shares.toFixed(0)} shares ${h.value ? `(${fmtUsd(h.value)})` : ''}`;
    }),
  ];

  const buttons = [
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'azm_detail')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

export async function handleAnalyzeMarketSmart(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);
  const state = await analyzeState.get(telegramId);
  if (!state?.conditionId) return;

  const analysis = await analyzeMarket(state.conditionId);
  if (!analysis) {
    await sendHtml(ctx, `❌ ${t(lang, 'az.noData')}`);
    return;
  }

  const sm = analysis.smartMoney;
  const lines = [
    `🧠 <b>Smart Money Detail</b>`,
    ``,
    `${signalEmoji(sm.signal)} Signal: <b>${sm.signal}</b>`,
    ``,
    `Buyers: ${sm.netBuyers}`,
    `Sellers: ${sm.netSellers}`,
    `Smart Volume: ${fmtUsd(sm.smartVolume)}`,
    `Dominant Side: ${sm.dominantSide}`,
    ``,
    `ℹ️ Smart = wallets with $1K+ realized PnL`,
  ];

  const buttons = [
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'azm_detail')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ── Wallet Search Prompt ───────────────────────────────────────────────────

export async function handleAnalyzeWalletPrompt(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  await analyzeState.set(telegramId, { step: 'wallet_search', timestamp: Date.now() });

  const lines = [
    `👛 <b>${t(lang, 'az.btn.wallet')}</b>`,
    ``,
    t(lang, 'az.wallet.prompt'),
  ];

  const buttons = [
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'az_menu')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ── Wallet Detail ──────────────────────────────────────────────────────────

export async function handleAnalyzeWalletDetail(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  const state = await analyzeState.get(telegramId);
  const addr = state?.walletAddress;
  if (!addr) {
    await sendHtml(ctx, `❌ ${t(lang, 'common.error')}`);
    return;
  }

  await sendHtml(ctx, `⏳ ${t(lang, 'az.loading')}`);

  const wa = await analyzeWallet(addr);
  if (!wa) {
    await sendHtml(ctx, `❌ ${t(lang, 'az.wallet.notFound')}`);
    return;
  }

  const fmtMetrics = (label: string, m: WalletMetricsSummary) => [
    `<b>${label}</b>`,
    `├ PnL: ${signPnl(m.totalPnl)} | ROI: ${pctStr(m.roi * 100)}`,
    `├ Vol: ${fmtUsd(m.volume)} | Win: ${(m.winRate * 100).toFixed(0)}%`,
    `└ Trades: ${m.trades} | Avg: ${fmtUsd(m.avgTradeSize)}`,
  ];

  const lines = [
    `🔬 <b>${t(lang, 'az.wallet.title')}</b>`,
    ``,
    `👛 <code>${shortAddr(addr)}</code>`,
    wa.styles.length > 0 ? `🏷 ${wa.styles.join(', ')}` : '',
    ``,
    ...fmtMetrics('📊 All-Time', wa.allTime),
    ``,
    ...fmtMetrics('📅 30 Days', wa.thirtyDay),
    ``,
    ...(wa.topMarkets.length > 0 ? [
      `🏆 <b>Top Markets</b>`,
      ...wa.topMarkets.slice(0, 3).map(m =>
        `├ ${m.title?.slice(0, 30) ?? 'Unknown'}... → ${signPnl(m.total_pnl)}`
      ),
    ] : []),
  ].filter(Boolean);

  const buttons = [
    [
      Markup.button.callback(`📈 PnL History`, 'azw_pnl'),
      Markup.button.callback(`📊 Markets`, 'azw_mkts'),
    ],
    [
      Markup.button.callback(`🔍 Similar`, 'azw_sim'),
      Markup.button.callback(`⚡ Copy This`, 'azw_copy'),
    ],
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'az_menu')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ── Wallet Sub-pages ───────────────────────────────────────────────────────

export async function handleAnalyzeWalletPnl(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);
  const state = await analyzeState.get(telegramId);
  if (!state?.walletAddress) return;

  const pnl = await getWalletPnlHistory(state.walletAddress);
  const history = pnl?.pnl_over_time ?? [];

  if (history.length === 0) {
    await sendHtml(ctx, `❌ ${t(lang, 'az.noData')}`);
    return;
  }

  const lines = [
    `📈 <b>PnL History</b>`,
    `👛 <code>${shortAddr(state.walletAddress)}</code>`,
    ``,
    ...history.slice(-14).map(p => {
      const d = new Date(p.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `${d}: ${signPnl(p.cumulative_pnl)}`;
    }),
  ];

  const buttons = [
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'azw_detail')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

export async function handleAnalyzeWalletMarkets(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);
  const state = await analyzeState.get(telegramId);
  if (!state?.walletAddress) return;

  const markets = await getWalletMarketsPage(state.walletAddress);

  if (!markets || markets.length === 0) {
    await sendHtml(ctx, `❌ ${t(lang, 'az.noData')}`);
    return;
  }

  const lines = [
    `📊 <b>Markets Breakdown</b>`,
    `👛 <code>${shortAddr(state.walletAddress)}</code>`,
    ``,
    ...markets.slice(0, 10).map((m, i) => {
      const title = (m.title ?? 'Unknown').slice(0, 35);
      return `${i + 1}. ${title}\n   PnL: ${signPnl(m.total_pnl)} | Vol: ${fmtUsd(m.volume ?? 0)} | ${m.trades ?? 0} trades`;
    }),
  ];

  const buttons = [
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'azw_detail')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

export async function handleAnalyzeWalletSimilar(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);
  const state = await analyzeState.get(telegramId);
  if (!state?.walletAddress) return;

  const similar = await getWalletSimilar(state.walletAddress);

  if (!similar || similar.length === 0) {
    await sendHtml(ctx, `❌ ${t(lang, 'az.noData')}`);
    return;
  }

  const lines = [
    `🔍 <b>Similar Wallets</b>`,
    `👛 <code>${shortAddr(state.walletAddress)}</code>`,
    ``,
    ...similar.slice(0, 10).map((w, i) =>
      `${i + 1}. <code>${shortAddr(w.wallet)}</code> — ${w.overlap_markets} shared | ${pctStr((w.overlap_pct ?? 0) * 100)} overlap`
    ),
  ];

  const buttons = [
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'azw_detail')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

export async function handleAnalyzeWalletCopy(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const state = await analyzeState.get(telegramId);
  if (!state?.walletAddress) return;

  // Bridge to copy-trade add flow by simulating /copy_add with the address
  // This triggers the first step of copy add flow
  analyzeState.delete(telegramId);
  await ctx.reply(`Starting copy trade setup for <code>${shortAddr(state.walletAddress)}</code>...\n\nUse /copy to set up a new copy trade subscription for this wallet.`, { parse_mode: 'HTML' });
}

// ── Smart Money Scanner ────────────────────────────────────────────────────

export async function handleAnalyzeSmartScan(ctx: Context, page: number = 1): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  const lang = getLang(user);

  await sendHtml(ctx, `⏳ ${t(lang, 'az.loading')}`);

  const scan = await scanSmartMoney(page);

  if (scan.markets.length === 0) {
    await sendHtml(ctx, `❌ ${t(lang, 'az.noData')}`);
    return;
  }

  const lines = [
    `🧠 <b>${t(lang, 'az.smart.title')}</b>`,
    ``,
    ...scan.markets.map((m, i) => {
      const idx = (page - 1) * 10 + i + 1;
      const dir = m.direction === 'YES' ? '🟢 YES' : m.direction === 'NO' ? '🔴 NO' : '⚪ MIXED';
      return [
        `${idx}. <b>${m.title.slice(0, 40)}</b>`,
        `   Smart: ${m.smartWalletCount} wallets | Vol: ${fmtUsd(m.smartVolume)}`,
        `   ${dir} (${m.buyCount}B / ${m.sellCount}S) | ROI: ${pctStr((m.avgSmartRoi ?? 0) * 100)}`,
      ].join('\n');
    }),
  ];

  const navButtons: any[] = [];
  if (page > 1) navButtons.push(Markup.button.callback('« Prev', `azs_p_${page - 1}`));
  navButtons.push(Markup.button.callback(`Page ${page}`, 'noop'));
  if (scan.hasMore) navButtons.push(Markup.button.callback('Next »', `azs_p_${page + 1}`));

  const buttons = [
    navButtons,
    [Markup.button.callback(`🔙 ${t(lang, 'common.back')}`, 'az_menu')],
  ];

  await sendHtml(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

// ── Text Input Handler ─────────────────────────────────────────────────────

export async function handleAnalyzeInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;

  const state = await analyzeState.get(telegramId);
  if (!state) return false;

  if (state.step === 'market_search') {
    // Try to detect a Polymarket link
    const slug = detectPolymarketLink(text);
    if (slug) {
      // Resolve slug to condition_id
      try {
        const markets = await fetchOpenMarkets({ search: slug, limit: 1 });
        if (markets.length > 0) {
          await analyzeState.set(telegramId, {
            ...state,
            step: 'viewing',
            conditionId: markets[0].condition_id,
            timestamp: Date.now(),
          });
          await handleAnalyzeMarketDetail(ctx);
          return true;
        }
      } catch { /* fall through to keyword search */ }
    }

    // Keyword search
    try {
      const markets = await fetchOpenMarkets({ search: text.trim(), limit: 1 });
      if (markets.length > 0) {
        await analyzeState.set(telegramId, {
          ...state,
          step: 'viewing',
          conditionId: markets[0].condition_id,
          timestamp: Date.now(),
        });
        await handleAnalyzeMarketDetail(ctx);
        return true;
      } else {
        await ctx.reply('❌ No markets found. Try a different keyword.');
        return true;
      }
    } catch (err: any) {
      logger.error(`[analyze] Market search failed: ${err?.message}`);
      await ctx.reply('❌ Search failed. Please try again.');
      return true;
    }
  }

  if (state.step === 'wallet_search') {
    const addr = text.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/i.test(addr)) {
      await ctx.reply('❌ Invalid wallet address. Please enter a valid 0x address.');
      return true;
    }

    await analyzeState.set(telegramId, {
      ...state,
      step: 'viewing',
      walletAddress: addr,
      timestamp: Date.now(),
    });
    await handleAnalyzeWalletDetail(ctx);
    return true;
  }

  return false;
}
