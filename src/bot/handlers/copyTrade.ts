import { Context, Markup } from 'telegraf';
import { prisma } from '../../database/prisma';
import { logger } from '../../utils/logger';
import { parseTraderAddress } from '../../services/copyTrade';
import { getUserByTelegramId } from '../../services/user';
import { sendPage } from '../../utils/telegram';
import { ce, esc, EMOJI } from '../../utils/customEmoji';

// ─── State ─────────────────────────────────────────────────────────────────────

interface CopyAddState {
  step: 'awaiting_address' | 'awaiting_mode' | 'awaiting_amount'
      | 'awaiting_tp_sl_choice' | 'awaiting_tp' | 'awaiting_sl';
  address?: string;
  mode?: 'fixed' | 'multiplier';
  amount?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  pendingSlAfterTp?: boolean;  // true when 'both' was chosen and TP was just entered
  timestamp: number;
}

export const copyAddState = new Map<string, CopyAddState>();

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isExpired(ts: number): boolean {
  return Date.now() - ts > STATE_TTL_MS;
}

// R6: Periodic cleanup of abandoned state entries (every 30 min, remove entries > 10 min old)
setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, state] of copyAddState.entries()) {
    if (state.timestamp < cutoff) copyAddState.delete(key);
  }
}, 30 * 60 * 1000);

// ─── /copy command ────────────────────────────────────────────────────────────

export async function handleCopyCommand(ctx: Context, arg?: string): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const sub = arg?.trim().toLowerCase();

  if (!sub || sub === 'list') { await handleCopyList(ctx); return; }
  if (sub === 'add')          { await startCopyAdd(ctx);  return; }
  if (sub === 'stopall')      { await handleCopyStopAll(ctx); return; }
  if (sub === 'pause')        { await handleCopyPauseAll(ctx, false); return; }
  if (sub === 'resume')       { await handleCopyPauseAll(ctx, true);  return; }

  if (sub.startsWith('stop ')) {
    const addr = parseTraderAddress(sub.slice(5).trim());
    if (!addr) { await ctx.reply('❌ Invalid address.'); return; }
    await handleCopyStop(ctx, addr);
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

// ─── List ─────────────────────────────────────────────────────────────────────

export async function handleCopyList(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    await ctx.reply('❌ User not found. Use /start first.');
    return;
  }

  const eTitle = ce(EMOJI.refHub, '👥');

  const subs = await prisma.copySubscription.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });

  if (subs.length === 0) {
    await sendPage(ctx,
      `${eTitle} <b>Copy Trading</b>\n\nYou have no traders followed yet.\n\nUse /copy add to follow a new trader.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Add Trader', 'copy_start_add')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      }
    );
    return;
  }

  // Count copied trades per subscription grouped by status
  const tradeCounts = await prisma.copiedTrade.groupBy({
    by: ['traderAddress', 'status'],
    where: { userId: user.id },
    _count: { id: true },
  });

  type StatusMap = { filled: number; failed: number; skipped: number };
  const countMap = new Map<string, StatusMap>();
  for (const row of tradeCounts) {
    const existing = countMap.get(row.traderAddress) ?? { filled: 0, failed: 0, skipped: 0 };
    if (row.status === 'filled') existing.filled += row._count.id;
    else if (row.status === 'failed') existing.failed += row._count.id;
    else existing.skipped += row._count.id;
    countMap.set(row.traderAddress, existing);
  }

  const lines: string[] = [`${eTitle} <b>Active Copy Subscriptions</b>\n`];

  for (const s of subs) {
    const short = `${s.traderAddress.slice(0, 6)}...${s.traderAddress.slice(-4)}`;
    const sizeLabel = s.fixedAmount
      ? `$${s.fixedAmount} fixed`
      : `×${(s.multiplier ?? 1).toFixed(2)}`;
    const counts = countMap.get(s.traderAddress) ?? { filled: 0, failed: 0, skipped: 0 };
    const countLine = `✅ ${counts.filled} | ❌ ${counts.failed} | ⏭ ${counts.skipped}`;
    const status = s.isActive ? '🟢' : '🔴';

    const tpSlParts: string[] = [];
    if (s.takeProfitPct != null) tpSlParts.push(`📈 TP: +${s.takeProfitPct}%`);
    if (s.stopLossPct  != null) tpSlParts.push(`🛑 SL: −${s.stopLossPct}%`);
    const tpSlLine = tpSlParts.length > 0 ? `\n   ${tpSlParts.join('   ')}` : '';

    lines.push(
      `${status} <code>${esc(short)}</code>${s.label ? ` (${esc(s.label)})` : ''}\n` +
      `   Size: ${esc(sizeLabel)} · ${countLine}${tpSlLine}`
    );
  }

  await sendPage(ctx, lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add New Trader', 'copy_start_add')],
      [Markup.button.callback('⏹ Stop All', 'copy_stop_all')],
      [Markup.button.callback('📜 Recent Trades', 'copy_history_10')],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ]),
  });
}

// ─── Add Flow ─────────────────────────────────────────────────────────────────

export async function startCopyAdd(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  // Warn if user already has an active add flow in progress
  const existingState = copyAddState.get(telegramId);
  if (existingState && !isExpired(existingState.timestamp)) {
    await ctx.reply(
      '⚠️ You already have an active add flow in progress.\n\nCancel it with /copy cancel and try again.'
    );
    return;
  }

  copyAddState.set(telegramId, { step: 'awaiting_address', timestamp: Date.now() });

  await sendPage(ctx,
    `➕ <b>Add Trader</b>\n\n` +
    `Send the Polymarket wallet address or profile link you want to follow.\n\n` +
    `Example:\n<code>0xABC...</code>  or  <code>polymarket.com/profile/0xABC...</code>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'copy_cancel')],
      ]),
    }
  );
}

/**
 * Handles text input during the copy add flow.
 * Returns true if it consumed the message, false if the state does not match.
 */
export async function handleCopyAddInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;

  const state = copyAddState.get(telegramId);
  if (!state) return false;

  if (isExpired(state.timestamp)) {
    copyAddState.delete(telegramId);
    return false;
  }

  if (state.step === 'awaiting_address') {
    const addr = parseTraderAddress(text);
    if (!addr) {
      await ctx.reply(
        '❌ Invalid address. Please send a <code>0x...</code> address or a Polymarket profile link.',
        { parse_mode: 'HTML' }
      );
      return true;
    }

    // Check duplicate
    const user = await getUserByTelegramId(telegramId);
    if (user) {
      const existing = await prisma.copySubscription.findUnique({
        where: { userId_traderAddress: { userId: user.id, traderAddress: addr } },
      });
      if (existing) {
        copyAddState.delete(telegramId);
        const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
        await ctx.reply(
          `⚠️ You are already following <code>${esc(short)}</code>.\n\nStatus: ${existing.isActive ? '🟢 Active' : '🔴 Stopped'}`,
          { parse_mode: 'HTML' }
        );
        return true;
      }
    }

    // Move to mode selection
    state.step = 'awaiting_mode';
    state.address = addr;
    state.timestamp = Date.now();
    copyAddState.set(telegramId, state);

    const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    await sendPage(ctx,
      `✅ Address: <code>${esc(short)}</code>\n\nHow should the copy size be set?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💵 Fixed Amount ($)', 'copy_mode_fixed')],
          [Markup.button.callback('✖️ Proportional Multiplier (×)', 'copy_mode_multiplier')],
          [Markup.button.callback('❌ Cancel', 'copy_cancel')],
        ]),
      }
    );
    return true;
  }

  if (state.step === 'awaiting_amount') {
    const raw = text.trim().replace(/[^0-9.]/g, '');
    const value = parseFloat(raw);

    if (isNaN(value) || value <= 0) {
      const label = state.mode === 'fixed' ? 'Amount (e.g. 10)' : 'Multiplier (e.g. 0.5)';
      await ctx.reply(`❌ Invalid value. Please try again.\n${label}`);
      return true;
    }

    if (state.mode === 'fixed' && value < 1) {
      await ctx.reply('❌ Minimum fixed amount is $1.');
      return true;
    }

    if (state.mode === 'multiplier' && (value < 0.01 || value > 10)) {
      await ctx.reply('❌ Multiplier must be between 0.01 and 10.');
      return true;
    }

    // Store amount and move to TP/SL choice step
    state.amount = value;
    state.step = 'awaiting_tp_sl_choice';
    state.timestamp = Date.now();
    copyAddState.set(telegramId, state);

    const addr = state.address!;
    const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    const modeLabel = state.mode === 'fixed'
      ? `$${value.toFixed(2)} fixed`
      : `×${value.toFixed(2)}`;

    await sendPage(ctx,
      `⚙️ <b>Set TP/SL</b> <i>(Optional)</i>\n\n` +
      `Trader: <code>${esc(short)}</code>\n` +
      `Size: ${esc(modeLabel)}\n\n` +
      `Automatic exit for every copied BUY trade:\n` +
      `• 📈 Take Profit: auto-sell when +X% in profit\n` +
      `• 🛑 Stop Loss: auto-sell when −X% in loss`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📈 Add TP', 'copy_tpsl_tp'),
            Markup.button.callback('🛑 Add SL', 'copy_tpsl_sl'),
          ],
          [
            Markup.button.callback('📊 Add Both', 'copy_tpsl_both'),
            Markup.button.callback('⏭ Skip', 'copy_tpsl_none'),
          ],
        ]),
      }
    );
    return true;
  }

  if (state.step === 'awaiting_tp') {
    const pct = parseFloat(text.replace(',', '.'));
    if (isNaN(pct) || pct < 5 || pct > 1000) {
      await ctx.reply('❌ Enter a percentage between 5 and 1000. Example: <code>50</code>', { parse_mode: 'HTML' });
      return true;
    }
    state.takeProfitPct = pct;
    if (state.pendingSlAfterTp) {
      state.step = 'awaiting_sl';
      state.pendingSlAfterTp = false;
      state.timestamp = Date.now();
      copyAddState.set(telegramId, state);
      await ctx.reply('🛑 Enter Stop Loss percentage (e.g. <code>25</code> = 25% loss):', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'copy_cancel')]]),
      });
    } else {
      await saveCopySubscription(ctx, telegramId, state);
    }
    return true;
  }

  if (state.step === 'awaiting_sl') {
    const pct = parseFloat(text.replace(',', '.'));
    if (isNaN(pct) || pct < 5 || pct > 90) {
      await ctx.reply('❌ Enter a percentage between 5 and 90. Example: <code>25</code>', { parse_mode: 'HTML' });
      return true;
    }
    state.stopLossPct = pct;
    await saveCopySubscription(ctx, telegramId, state);
    return true;
  }

  return false;
}

// ─── TP/SL Choice Callback ────────────────────────────────────────────────────

export async function handleCopyTpSlChoice(
  ctx: Context,
  choice: 'tp' | 'sl' | 'both' | 'none'
): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const state = copyAddState.get(telegramId);
  if (!state || state.step !== 'awaiting_tp_sl_choice' || isExpired(state.timestamp)) {
    copyAddState.delete(telegramId);
    await sendPage(ctx, '❌ Session expired. Try /copy add again.');
    return;
  }

  if (choice === 'none') {
    await saveCopySubscription(ctx, telegramId, state);
    return;
  }

  const cancelBtn = Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'copy_cancel')]]);

  if (choice === 'tp') {
    state.step = 'awaiting_tp';
    state.timestamp = Date.now();
    copyAddState.set(telegramId, state);
    await sendPage(ctx,
      '📈 Enter Take Profit percentage (e.g. <code>50</code> = 50% profit):',
      { parse_mode: 'HTML', ...cancelBtn }
    );
    return;
  }

  if (choice === 'sl') {
    state.step = 'awaiting_sl';
    state.timestamp = Date.now();
    copyAddState.set(telegramId, state);
    await sendPage(ctx,
      '🛑 Enter Stop Loss percentage (e.g. <code>25</code> = 25% loss):',
      { parse_mode: 'HTML', ...cancelBtn }
    );
    return;
  }

  if (choice === 'both') {
    state.step = 'awaiting_tp';
    state.pendingSlAfterTp = true;
    state.timestamp = Date.now();
    copyAddState.set(telegramId, state);
    await sendPage(ctx,
      '📈 First enter Take Profit percentage (e.g. <code>50</code> = 50% profit):',
      { parse_mode: 'HTML', ...cancelBtn }
    );
    return;
  }
}

// ─── Save Subscription Helper ─────────────────────────────────────────────────

async function saveCopySubscription(
  ctx: Context,
  telegramId: string,
  state: CopyAddState
): Promise<void> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    copyAddState.delete(telegramId);
    await ctx.reply('❌ User not found.');
    return;
  }

  const addr = state.address!;
  const value = state.amount!;
  copyAddState.delete(telegramId);

  try {
    await prisma.copySubscription.upsert({
      where: { userId_traderAddress: { userId: user.id, traderAddress: addr } },
      create: {
        userId: user.id,
        traderAddress: addr,
        fixedAmount: state.mode === 'fixed' ? value : null,
        multiplier: state.mode === 'multiplier' ? value : null,
        takeProfitPct: state.takeProfitPct ?? null,
        stopLossPct: state.stopLossPct ?? null,
        isActive: true,
      },
      update: {
        fixedAmount: state.mode === 'fixed' ? value : null,
        multiplier: state.mode === 'multiplier' ? value : null,
        takeProfitPct: state.takeProfitPct ?? null,
        stopLossPct: state.stopLossPct ?? null,
        isActive: true,
      },
    });

    const eTitle = ce(EMOJI.refHub, '👥');
    const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    const modeLabel = state.mode === 'fixed'
      ? `$${value.toFixed(2)} fixed amount`
      : `×${value.toFixed(2)} multiplier`;
    const tpLine = state.takeProfitPct != null ? `\n📈 TP: +${state.takeProfitPct}%` : '';
    const slLine = state.stopLossPct  != null ? `\n🛑 SL: −${state.stopLossPct}%`  : '';

    await sendPage(ctx,
      `${eTitle} <b>Trader Added</b>\n\n` +
      `Address: <code>${esc(short)}</code>\n` +
      `Size: ${esc(modeLabel)}${tpLine}${slLine}\n\n` +
      `Trades will be automatically copied now.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 Subscription List', 'copy_list')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      }
    );

    logger.info(`[copy] User ${user.id} subscribed to ${addr} (${modeLabel} TP=${state.takeProfitPct ?? 'off'} SL=${state.stopLossPct ?? 'off'})`);
  } catch (err: any) {
    logger.error('[copy] Failed to save subscription:', err?.message);
    await ctx.reply('❌ Failed to save subscription. Please try again.');
  }
}

// ─── Mode selection callbacks ─────────────────────────────────────────────────

export async function handleCopyModeFixed(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const state = copyAddState.get(telegramId);
  if (!state || state.step !== 'awaiting_mode' || isExpired(state.timestamp)) {
    copyAddState.delete(telegramId);
    await sendPage(ctx, '❌ Session expired. Try /copy add again.');
    return;
  }

  state.step = 'awaiting_amount';
  state.mode = 'fixed';
  state.timestamp = Date.now();
  copyAddState.set(telegramId, state);

  const eMoney = ce(EMOJI.earnings, '💵');
  await sendPage(ctx,
    `${eMoney} <b>Fixed Amount</b>\n\nEnter the USD amount to copy per trade (e.g. <code>10</code>).`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'copy_cancel')],
      ]),
    }
  );
}

export async function handleCopyModeMultiplier(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const state = copyAddState.get(telegramId);
  if (!state || state.step !== 'awaiting_mode' || isExpired(state.timestamp)) {
    copyAddState.delete(telegramId);
    await sendPage(ctx, '❌ Session expired. Try /copy add again.');
    return;
  }

  state.step = 'awaiting_amount';
  state.mode = 'multiplier';
  state.timestamp = Date.now();
  copyAddState.set(telegramId, state);

  await sendPage(ctx,
    `✖️ <b>Proportional Multiplier</b>\n\n` +
    `Enter the multiplier to apply to the trader's position size.\n` +
    `Example: <code>0.5</code> = half the trader's size · <code>2</code> = double.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'copy_cancel')],
      ]),
    }
  );
}

// ─── Stop / Pause / Resume ────────────────────────────────────────────────────

export async function handleCopyStop(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const result = await prisma.copySubscription.updateMany({
    where: { userId: user.id, traderAddress },
    data: { isActive: false },
  });

  const short = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;

  if (result.count > 0) {
    await ctx.reply(`✅ <code>${esc(short)}</code> unfollowed.`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply(`⚠️ No active subscription found for <code>${esc(short)}</code>.`, { parse_mode: 'HTML' });
  }
}

export async function handleCopyStopAll(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const result = await prisma.copySubscription.updateMany({
    where: { userId: user.id, isActive: true },
    data: { isActive: false },
  });

  await sendPage(ctx, `✅ ${result.count} subscription${result.count !== 1 ? 's' : ''} stopped.`, {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📋 Copy List', 'copy_list')],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ]),
  });
}

async function handleCopyPauseAll(ctx: Context, resume: boolean): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const result = await prisma.copySubscription.updateMany({
    where: { userId: user.id },
    data: { isActive: resume },
  });

  const label = resume ? '▶️ resumed' : '⏸ paused';
  await ctx.reply(`${result.count} subscription${result.count !== 1 ? 's' : ''} ${label}.`);
}

// Callback action wrapper
export async function handleCopyStopAllAction(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  await handleCopyStopAll(ctx);
}

// ─── History ─────────────────────────────────────────────────────────────────

export async function handleCopyHistory(ctx: Context, n = 10): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const trades = await prisma.copiedTrade.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: Math.min(n, 30),
  });

  if (trades.length === 0) {
    await ctx.reply('📜 No copied trades yet.');
    return;
  }

  const eBriefcase = ce(EMOJI.briefcase, '💼');
  const lines = [`${eBriefcase} <b>Recent Copied Trades</b>\n`];

  for (const t of trades) {
    const short = `${t.traderAddress.slice(0, 6)}...${t.traderAddress.slice(-4)}`;
    const date = t.createdAt.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const statusIcon = t.status === 'filled' ? '✅' : t.status === 'failed' ? '❌' : '⏭';
    lines.push(
      `${statusIcon} ${esc(t.side)} ${esc(t.outcome)} · $${t.copiedSize.toFixed(2)}\n` +
      `   Trader: <code>${esc(short)}</code> · ${esc(date)}`
    );
  }

  await sendPage(ctx, lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📋 Copy List', 'copy_list')],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ]),
  });
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

export async function handleCopyCancel(ctx: Context): Promise<void> {
  await ctx.answerCbQuery('Cancelled');
  const telegramId = ctx.from?.id.toString();
  if (telegramId) copyAddState.delete(telegramId);

  await sendPage(ctx, '❌ Cancelled.', {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📋 Copy List', 'copy_list')],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ]),
  });
}

// ─── Smart Wallet Quick-Copy ───────────────────────────────────────────────────

/**
 * Pre-fills a trader address from the Smart Wallets page and jumps directly
 * to mode selection (skipping the manual address input step).
 */
export async function handleSmartCopyStart(ctx: Context, address: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    await ctx.reply('❌ User not found. Use /start first.');
    return;
  }

  // Check if already subscribed
  const existing = await prisma.copySubscription.findUnique({
    where: { userId_traderAddress: { userId: user.id, traderAddress: address } },
  });
  if (existing) {
    const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
    await sendPage(ctx,
      `⚠️ You are already following <code>${esc(short)}</code>.\n\nStatus: ${existing.isActive ? '🟢 Active' : '🔴 Stopped'}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🏦 Smart Wallets', 'show_wallet')],
          [Markup.button.callback('📋 Copy List', 'copy_list')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      }
    );
    return;
  }

  // Pre-fill address, jump to mode selection
  copyAddState.set(telegramId, {
    step: 'awaiting_mode',
    address,
    timestamp: Date.now(),
  });

  const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
  await sendPage(ctx,
    `✅ Address: <code>${esc(short)}</code>\n\nHow should the copy size be set?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💵 Fixed Amount ($)', 'copy_mode_fixed')],
        [Markup.button.callback('✖️ Proportional Multiplier (×)', 'copy_mode_multiplier')],
        [Markup.button.callback('❌ Cancel', 'copy_cancel')],
      ]),
    }
  );
}
