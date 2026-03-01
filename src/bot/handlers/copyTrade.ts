import { Context, Markup } from 'telegraf';
import { prisma } from '../../database/prisma';
import { logger } from '../../utils/logger';
import { parseTraderAddress } from '../../services/copyTrade';
import { getUserByTelegramId } from '../../services/user';
import { sendPage } from '../../utils/telegram';
import { ce, esc, EMOJI } from '../../utils/customEmoji';
import { config } from '../../config';

// ─── State ─────────────────────────────────────────────────────────────────────

interface CopyAddState {
  step: 'awaiting_address' | 'awaiting_nickname' | 'awaiting_mode' | 'awaiting_amount'
      | 'awaiting_tp_sl_choice' | 'awaiting_tp' | 'awaiting_sl';
  address?: string;
  nickname?: string;
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

// ─── Edit State (manage page edit flows) ──────────────────────────────────────

interface CopyEditState {
  step: 'awaiting_mode_choice' | 'awaiting_amount' | 'awaiting_rename'
      | 'awaiting_slippage' | 'awaiting_price_min' | 'awaiting_price_max'
      | 'awaiting_daily_limit' | 'awaiting_single_limit';
  traderAddress: string;
  newMode?: 'fixed' | 'multiplier'; // used during mode-change flow
  priceMinTemp?: number;            // temporary storage during 2-step price range flow
  timestamp: number;
}

export const copyEditState = new Map<string, CopyEditState>();

setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, state] of copyEditState.entries()) {
    if (state.timestamp < cutoff) copyEditState.delete(key);
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

  // /copy add <address> — pre-fill address, jump directly to nickname step
  if (sub.startsWith('add ')) {
    const addr = parseTraderAddress(sub.slice(4).trim());
    if (!addr) {
      await ctx.reply('❌ Invalid address. Please send a <code>0x...</code> address or Polymarket profile link.', { parse_mode: 'HTML' });
      return;
    }
    await handleSmartCopyStart(ctx, addr);
    return;
  }

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

  // Clear any pending edit state when returning to list
  copyEditState.delete(telegramId);

  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    await ctx.reply('❌ User not found. Use /start first.');
    return;
  }

  const subs = await prisma.copySubscription.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });

  if (subs.length === 0) {
    await sendPage(ctx,
      `🎯 <b>Copy Trading</b>\n\nYou have no traders followed yet.\n\nUse /copy add to follow a new trader.`,
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

  const activeSubs = subs.filter(s => s.isActive).length;
  const lines: string[] = [
    `🎯 <b>Copy Trading</b>\n\nYou are currently copying ${activeSubs} trader${activeSubs !== 1 ? 's' : ''}.\n`,
  ];

  for (const s of subs) {
    const short = `${s.traderAddress.slice(0, 6)}...${s.traderAddress.slice(-4)}`;
    const sizeLabel = s.fixedAmount
      ? `$${s.fixedAmount} Fixed`
      : `${(s.multiplier ?? 1).toFixed(0)}% Percentage`;
    const counts = countMap.get(s.traderAddress) ?? { filled: 0, failed: 0, skipped: 0 };
    const statusDot = s.isActive ? '🟢' : '🔴';

    const displayName = s.label
      ? `${statusDot} <b>${esc(s.label)}</b>`
      : `${statusDot} <code>${esc(short)}</code>`;

    const tpSlParts: string[] = [];
    if (s.takeProfitPct != null) tpSlParts.push(`📈 TP: +${s.takeProfitPct}%`);
    if (s.stopLossPct  != null) tpSlParts.push(`🛑 SL: −${s.stopLossPct}%`);
    const tpSlLine = tpSlParts.length > 0 ? `├ ${tpSlParts.join('   ')}\n` : '';

    const manageLink = `https://t.me/${config.telegram.botUsername}?start=copymng_${s.traderAddress}`;
    const shareLink  = `https://t.me/${config.telegram.botUsername}?start=copyshare_${s.traderAddress}`;

    lines.push(
      `• ${displayName}\n` +
      `├ Mode: ${esc(sizeLabel)}\n` +
      tpSlLine +
      `├ <a href="${manageLink}">⚙️ Manage</a> | <a href="${shareLink}">📤 Share</a>\n` +
      `└ ✅ ${counts.filled} | ❌ ${counts.failed} | ⏭ ${counts.skipped}`
    );
  }

  await sendPage(ctx, lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add New Trader', 'copy_start_add')],
      [
        Markup.button.callback('⏹ Stop All',        'copy_stop_all'),
        Markup.button.callback('📜 Recent Trades',   'copy_history_10'),
      ],
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

    // Move to nickname step
    state.step = 'awaiting_nickname';
    state.address = addr;
    state.timestamp = Date.now();
    copyAddState.set(telegramId, state);

    await sendPage(ctx,
      `➕ <b>Add Copytrade</b> | Step 2/7\n\n` +
      `Wallet:\n<code>${esc(addr)}</code>\n\n` +
      `Give this trader a nickname:\n\n` +
      `📝 Example:\n"Smart Whale", "Alpha Caller"`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⏭ Skip', 'copy_nickname_skip')],
          [Markup.button.callback('❌ Cancel', 'copy_cancel')],
        ]),
      }
    );
    return true;
  }

  if (state.step === 'awaiting_nickname') {
    const nickname = text.trim().slice(0, 20);
    state.nickname = nickname || undefined;
    state.step = 'awaiting_mode';
    state.timestamp = Date.now();
    copyAddState.set(telegramId, state);

    const short = `${state.address!.slice(0, 6)}...${state.address!.slice(-4)}`;
    const nickLine = nickname ? `Nickname: <b>${esc(nickname)}</b>\n` : '';
    await sendPage(ctx,
      `${nickLine}Wallet: <code>${esc(short)}</code>\n\nHow should the copy size be set?`,
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
        label: state.nickname ?? null,
        fixedAmount: state.mode === 'fixed' ? value : null,
        multiplier: state.mode === 'multiplier' ? value : null,
        takeProfitPct: state.takeProfitPct ?? null,
        stopLossPct: state.stopLossPct ?? null,
        isActive: true,
      },
      update: {
        label: state.nickname ?? null,
        fixedAmount: state.mode === 'fixed' ? value : null,
        multiplier: state.mode === 'multiplier' ? value : null,
        takeProfitPct: state.takeProfitPct ?? null,
        stopLossPct: state.stopLossPct ?? null,
        isActive: true,
      },
    });

    const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    const modeLabel = state.mode === 'fixed'
      ? `$${value.toFixed(2)} fixed amount`
      : `×${value.toFixed(2)} multiplier`;
    const nickLine = state.nickname ? `Nickname: <b>${esc(state.nickname)}</b>\n` : '';
    const tpLine = state.takeProfitPct != null ? `\n📈 TP: +${state.takeProfitPct}%` : '';
    const slLine = state.stopLossPct  != null ? `\n🛑 SL: −${state.stopLossPct}%`  : '';

    await sendPage(ctx,
      `🎯 <b>Trader Added</b>\n\n` +
      nickLine +
      `Wallet: <code>${esc(short)}</code>\n` +
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

// ─── Nickname Skip Callback ───────────────────────────────────────────────────

export async function handleCopyNicknameSkip(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const state = copyAddState.get(telegramId);
  if (!state || state.step !== 'awaiting_nickname' || isExpired(state.timestamp)) {
    copyAddState.delete(telegramId);
    await sendPage(ctx, '❌ Session expired. Try /copy add again.');
    return;
  }

  state.step = 'awaiting_mode';
  state.timestamp = Date.now();
  copyAddState.set(telegramId, state);

  const short = `${state.address!.slice(0, 6)}...${state.address!.slice(-4)}`;
  await sendPage(ctx,
    `Wallet: <code>${esc(short)}</code>\n\nHow should the copy size be set?`,
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

// Callback action wrapper — handleCopyStopAll already has the answerCbQuery guard
export async function handleCopyStopAllAction(ctx: Context): Promise<void> {
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
  if (telegramId) {
    copyAddState.delete(telegramId);
    copyEditState.delete(telegramId);
  }

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

  // Pre-fill address, go to nickname step
  copyAddState.set(telegramId, {
    step: 'awaiting_nickname',
    address,
    timestamp: Date.now(),
  });

  await sendPage(ctx,
    `➕ <b>Add Copytrade</b> | Step 2/7\n\n` +
    `Wallet:\n<code>${esc(address)}</code>\n\n` +
    `Give this trader a nickname:\n\n` +
    `📝 Example:\n"Smart Whale", "Alpha Caller"`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⏭ Skip', 'copy_nickname_skip')],
        [Markup.button.callback('❌ Cancel', 'copy_cancel')],
      ]),
    }
  );
}

// ─── Manage Page ──────────────────────────────────────────────────────────────

export async function handleCopyManage(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  // Clear any pending edit state when returning to manage page
  copyEditState.delete(telegramId);

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const sub = await prisma.copySubscription.findUnique({
    where: { userId_traderAddress: { userId: user.id, traderAddress } },
  });

  if (!sub) {
    await sendPage(ctx, '❌ Subscription not found.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('📋 Copy List', 'copy_list')]]),
    });
    return;
  }

  // Total spent on this subscription (filled trades only)
  const spentAgg = await prisma.copiedTrade.aggregate({
    where: { userId: user.id, traderAddress, status: 'filled' },
    _sum: { copiedSize: true },
  });
  const spentAmt = spentAgg._sum.copiedSize ?? 0;

  const short = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
  const displayName = sub.label || short;

  const statusStr = !sub.isActive
    ? '🔴 Stopped'
    : sub.isPaused
      ? '🟡 Paused'
      : '🟢 Active';
  const notifStr  = sub.notificationsEnabled ? '🔔 Enabled' : '🔕 Disabled';
  const dailyStr  = sub.dailySpendMax != null ? `$${sub.dailySpendMax.toFixed(2)}` : '∞';

  const modeStr = sub.fixedAmount != null
    ? `Fixed — $${sub.fixedAmount.toFixed(2)} per trade`
    : `Multiplier — ×${(sub.multiplier ?? 1).toFixed(2)} of leader's amount`;

  const priceRangeStr = sub.priceMin != null && sub.priceMax != null
    ? `${sub.priceMin.toFixed(0)}¢ – ${sub.priceMax.toFixed(0)}¢`
    : sub.priceMin != null
      ? `≥ ${sub.priceMin.toFixed(0)}¢`
      : sub.priceMax != null
        ? `≤ ${sub.priceMax.toFixed(0)}¢`
        : 'No limit';

  const singleStr = sub.singleTradeMax != null ? `$${sub.singleTradeMax.toFixed(2)}` : 'No limit';

  const tpSlParts: string[] = [];
  if (sub.takeProfitPct != null) tpSlParts.push(`📈 TP: +${sub.takeProfitPct}%`);
  if (sub.stopLossPct  != null) tpSlParts.push(`🛑 SL: −${sub.stopLossPct}%`);

  let message = `📋 <b>Copytrade Details</b>\n\n`;
  message += `👤 Leader: <code>${esc(displayName)}</code>\n`;
  message += `🔗 <a href="https://polymarket.com/profile/${traderAddress}">View on Polymarket</a>\n`;
  message += `Status: ${statusStr}\n`;
  message += `🔔 Notifications: ${notifStr}\n`;
  message += `💰 Spent: $${spentAmt.toFixed(2)} / ${esc(dailyStr)}\n\n`;
  message += `<b>Mode &amp; Trade Size</b>\n`;
  message += `• ${esc(modeStr)}\n`;
  if (tpSlParts.length > 0) message += `• ${esc(tpSlParts.join('   '))}\n`;
  message += `\n<b>Limits</b>\n`;
  message += `• Slippage: ${sub.slippage.toFixed(0)}%\n`;
  message += `• Price Range: ${esc(priceRangeStr)}\n`;
  message += `• Single Trade: ${esc(singleStr)}\n`;

  const pauseBtn = (!sub.isActive || sub.isPaused)
    ? Markup.button.callback('▶️ Resume', `copy_resume_${traderAddress}`)
    : Markup.button.callback('⏸ Pause',  `copy_pause_${traderAddress}`);

  const muteBtn = sub.notificationsEnabled
    ? Markup.button.callback('🔕 Mute',   `copy_mute_${traderAddress}`)
    : Markup.button.callback('🔔 Unmute', `copy_mute_${traderAddress}`);

  await sendPage(ctx, message, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('⚙️ Change Mode', `copy_chmode_${traderAddress}`),
        Markup.button.callback('✏️ Rename',       `copy_rename_${traderAddress}`),
      ],
      [
        Markup.button.callback('📊 Price Range',       `copy_prng_${traderAddress}`),
        Markup.button.callback('🎯 Slippage',          `copy_slippage_${traderAddress}`),
      ],
      [
        Markup.button.callback('📅 Daily Limit',       `copy_dlimit_${traderAddress}`),
        Markup.button.callback('📝 Single Trade Limit', `copy_slim_${traderAddress}`),
      ],
      [pauseBtn, muteBtn, Markup.button.callback('🗑 Delete', `copy_delconf_${traderAddress}`)],
      [
        Markup.button.callback('← Back',     'copy_list'),
        Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
      ],
    ]),
  });
}

// ─── Share Page ───────────────────────────────────────────────────────────────

export async function handleCopyShare(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const sub = await prisma.copySubscription.findUnique({
    where: { userId_traderAddress: { userId: user.id, traderAddress } },
  });

  if (!sub) {
    await sendPage(ctx, '❌ Subscription not found.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('📋 Copy List', 'copy_list')]]),
    });
    return;
  }

  const short = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
  const displayName = sub.label || short;
  const deepLink = `https://t.me/${config.telegram.botUsername}?start=copy_${traderAddress}`;

  const modeStr = sub.fixedAmount != null
    ? `$${sub.fixedAmount.toFixed(2)} Fixed`
    : `${(sub.multiplier ?? 1).toFixed(0)}% Percentage`;

  await sendPage(ctx,
    `📤 <b>Share Copy Trade</b>\n\n` +
    `Share this link so others can start copying <b>${esc(displayName)}</b>:\n\n` +
    `<code>${esc(deepLink)}</code>\n\n` +
    `👤 Trader: <code>${esc(traderAddress)}</code>\n` +
    `📊 Your mode: ${esc(modeStr)} <i>(each user sets their own)</i>\n\n` +
    `🪞 Tap the button below to open the copy setup directly:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.url('🪞 Mirror this Copy Trade', deepLink)],
        [Markup.button.callback('⚙️ Manage', `copy_manage_${traderAddress}`)],
        [
          Markup.button.callback('← Back',      'copy_list'),
          Markup.button.callback('🏠 Main Menu', 'back_to_menu'),
        ],
      ]),
    }
  );
}

// ─── Manage Action Triggers ───────────────────────────────────────────────────

export async function handleCopyChangeMode(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  copyEditState.set(telegramId, { step: 'awaiting_mode_choice', traderAddress, timestamp: Date.now() });

  const short = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
  await sendPage(ctx,
    `⚙️ <b>Change Mode</b>\n\nSelect new copy mode for <code>${esc(short)}</code>:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💵 Fixed Amount ($)',    `copy_editmode_fixed_${traderAddress}`)],
        [Markup.button.callback('✖️ Proportional (%)',   `copy_editmode_mult_${traderAddress}`)],
        [Markup.button.callback('❌ Cancel',              `copy_manage_${traderAddress}`)],
      ]),
    }
  );
}

export async function handleCopyEditModeChoice(
  ctx: Context,
  traderAddress: string,
  mode: 'fixed' | 'multiplier'
): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  copyEditState.set(telegramId, { step: 'awaiting_amount', traderAddress, newMode: mode, timestamp: Date.now() });

  const label = mode === 'fixed'
    ? 'fixed USD amount per trade (e.g. <code>50</code>):'
    : 'multiplier for leader\'s trade size (e.g. <code>0.5</code> = 50% · <code>2</code> = 200%):';

  await sendPage(ctx,
    `⚙️ Enter new ${label}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `copy_manage_${traderAddress}`)]]),
    }
  );
}

export async function handleCopyRename(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  copyEditState.set(telegramId, { step: 'awaiting_rename', traderAddress, timestamp: Date.now() });

  const short = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
  await sendPage(ctx,
    `✏️ <b>Rename Trader</b>\n\nEnter a new label for <code>${esc(short)}</code> (max 20 chars).\n\nSend <code>-</code> to remove the label.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `copy_manage_${traderAddress}`)]]),
    }
  );
}

export async function handleCopySetSlippage(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  copyEditState.set(telegramId, { step: 'awaiting_slippage', traderAddress, timestamp: Date.now() });

  await sendPage(ctx,
    `🎯 <b>Slippage</b>\n\nEnter max slippage % for copied orders (0.1–50).\n\nExample: <code>10</code> = 10% slippage tolerance`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `copy_manage_${traderAddress}`)]]),
    }
  );
}

export async function handleCopySetPriceRange(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  copyEditState.set(telegramId, { step: 'awaiting_price_min', traderAddress, timestamp: Date.now() });

  await sendPage(ctx,
    `📊 <b>Price Range</b>\n\nOnly copy trades within a specific price range.\n\nEnter the <b>minimum</b> price in cents (e.g. <code>30</code> for 30¢):\n\n<i>Trades below this price will be skipped.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🚫 Remove Range Filter', `copy_prng_clear_${traderAddress}`)],
        [Markup.button.callback('❌ Cancel',               `copy_manage_${traderAddress}`)],
      ]),
    }
  );
}

export async function handleCopyPriceRangeClear(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  copyEditState.delete(telegramId);

  await prisma.copySubscription.updateMany({
    where: { userId: user.id, traderAddress },
    data: { priceMin: null, priceMax: null },
  });

  await ctx.reply('✅ Price range filter removed.');
  await handleCopyManage(ctx, traderAddress);
}

export async function handleCopySetDailyLimit(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  copyEditState.set(telegramId, { step: 'awaiting_daily_limit', traderAddress, timestamp: Date.now() });

  await sendPage(ctx,
    `📅 <b>Daily Limit</b>\n\nMax USD to spend copying this trader per day.\n\nExample: <code>100</code> = $100/day max\nEnter <code>0</code> to remove the limit.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `copy_manage_${traderAddress}`)]]),
    }
  );
}

export async function handleCopySetSingleLimit(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  copyEditState.set(telegramId, { step: 'awaiting_single_limit', traderAddress, timestamp: Date.now() });

  await sendPage(ctx,
    `📝 <b>Single Trade Limit</b>\n\nMax USD to spend on a single copied trade.\n\nExample: <code>50</code> = max $50 per trade\nEnter <code>0</code> to remove the limit.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `copy_manage_${traderAddress}`)]]),
    }
  );
}

export async function handleCopyPause(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  await prisma.copySubscription.updateMany({
    where: { userId: user.id, traderAddress, isActive: true },
    data: { isPaused: true },
  });

  await handleCopyManage(ctx, traderAddress);
}

export async function handleCopyResume(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  await prisma.copySubscription.updateMany({
    where: { userId: user.id, traderAddress },
    data: { isPaused: false, isActive: true },
  });

  await handleCopyManage(ctx, traderAddress);
}

export async function handleCopyToggleMute(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  const sub = await prisma.copySubscription.findUnique({
    where: { userId_traderAddress: { userId: user.id, traderAddress } },
  });
  if (!sub) return;

  await prisma.copySubscription.update({
    where: { userId_traderAddress: { userId: user.id, traderAddress } },
    data: { notificationsEnabled: !sub.notificationsEnabled },
  });

  await handleCopyManage(ctx, traderAddress);
}

export async function handleCopyDeleteConfirm(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const short = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
  await sendPage(ctx,
    `🗑 <b>Delete Copy Trade</b>\n\nAre you sure you want to permanently delete the subscription for <code>${esc(short)}</code>?\n\n⚠️ This cannot be undone.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Yes, Delete', `copy_del_${traderAddress}`),
          Markup.button.callback('❌ Cancel',       `copy_manage_${traderAddress}`),
        ],
      ]),
    }
  );
}

export async function handleCopyDeleteExecute(ctx: Context, traderAddress: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  await prisma.copySubscription.deleteMany({
    where: { userId: user.id, traderAddress },
  });

  const short = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
  logger.info(`[copy] User ${user.id} deleted subscription to ${traderAddress}`);

  await sendPage(ctx,
    `✅ <b>Deleted</b>\n\nSubscription for <code>${esc(short)}</code> has been removed.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 Copy List',  'copy_list')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    }
  );
}

// ─── Edit Input Handler ───────────────────────────────────────────────────────

/**
 * Handles text input for manage-page edit flows.
 * Returns true if the message was consumed, false otherwise.
 */
export async function handleCopyEditInput(ctx: Context, text: string): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return false;

  const state = copyEditState.get(telegramId);
  if (!state) return false;

  if (isExpired(state.timestamp)) {
    copyEditState.delete(telegramId);
    return false;
  }

  const addr = state.traderAddress;

  const user = await getUserByTelegramId(telegramId);
  if (!user) { copyEditState.delete(telegramId); return false; }

  const sub = await prisma.copySubscription.findUnique({
    where: { userId_traderAddress: { userId: user.id, traderAddress: addr } },
  });
  if (!sub) { copyEditState.delete(telegramId); return false; }

  // ── Mode choice (button-only step — absorb stray text) ─────────────────────
  if (state.step === 'awaiting_mode_choice') {
    await ctx.reply('⬆️ Please tap <b>Fixed Amount</b> or <b>Proportional</b> to continue.', { parse_mode: 'HTML' });
    return true;
  }

  // ── Rename ──────────────────────────────────────────────────────────────────
  if (state.step === 'awaiting_rename') {
    const raw   = text.trim();
    const label = raw === '-' ? null : raw.slice(0, 20) || null;
    copyEditState.delete(telegramId);
    await prisma.copySubscription.update({
      where: { userId_traderAddress: { userId: user.id, traderAddress: addr } },
      data: { label },
    });
    const msg = label ? `✅ Label updated: <b>${esc(label)}</b>` : `✅ Label removed.`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
    await handleCopyManage(ctx, addr);
    return true;
  }

  // ── Amount (mode change) ────────────────────────────────────────────────────
  if (state.step === 'awaiting_amount') {
    const raw   = text.trim().replace(/[^0-9.]/g, '');
    const value = parseFloat(raw);

    if (isNaN(value) || value <= 0) {
      await ctx.reply('❌ Invalid value. Please enter a positive number.');
      return true;
    }
    if (state.newMode === 'fixed' && value < 1) {
      await ctx.reply('❌ Minimum fixed amount is $1.');
      return true;
    }
    if (state.newMode === 'multiplier' && (value < 0.01 || value > 10)) {
      await ctx.reply('❌ Multiplier must be between 0.01 and 10. Example: 0.5 = copy 50% of leader\'s size.');
      return true;
    }

    copyEditState.delete(telegramId);
    await prisma.copySubscription.update({
      where: { userId_traderAddress: { userId: user.id, traderAddress: addr } },
      data: {
        fixedAmount: state.newMode === 'fixed'       ? value : null,
        multiplier:  state.newMode === 'multiplier'  ? value : null,
      },
    });
    const modeLabel = state.newMode === 'fixed'
      ? `$${value.toFixed(2)} fixed`
      : `×${value.toFixed(2)} multiplier`;
    await ctx.reply(`✅ Mode updated: ${esc(modeLabel)}`, { parse_mode: 'HTML' });
    await handleCopyManage(ctx, addr);
    return true;
  }

  // ── Slippage ────────────────────────────────────────────────────────────────
  if (state.step === 'awaiting_slippage') {
    const pct = parseFloat(text.replace(',', '.'));
    if (isNaN(pct) || pct < 0.1 || pct > 50) {
      await ctx.reply('❌ Slippage must be between 0.1 and 50. Example: <code>10</code>', { parse_mode: 'HTML' });
      return true;
    }
    copyEditState.delete(telegramId);
    await prisma.copySubscription.update({
      where: { userId_traderAddress: { userId: user.id, traderAddress: addr } },
      data: { slippage: pct },
    });
    await ctx.reply(`✅ Slippage updated to ${pct}%`);
    await handleCopyManage(ctx, addr);
    return true;
  }

  // ── Price range min (step 1) ────────────────────────────────────────────────
  if (state.step === 'awaiting_price_min') {
    const val = parseFloat(text.replace(',', '.'));
    if (isNaN(val) || val < 0 || val >= 100) {
      await ctx.reply('❌ Price must be between 0 and 99. Example: <code>30</code> for 30¢', { parse_mode: 'HTML' });
      return true;
    }
    state.step       = 'awaiting_price_max';
    state.priceMinTemp = val;
    state.timestamp  = Date.now();
    copyEditState.set(telegramId, state);
    await sendPage(ctx,
      `📊 Now enter the <b>maximum</b> price in cents (e.g. <code>70</code> for 70¢):\n\nMust be greater than ${val}¢`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `copy_manage_${addr}`)]]),
      }
    );
    return true;
  }

  // ── Price range max (step 2) ────────────────────────────────────────────────
  if (state.step === 'awaiting_price_max') {
    const minVal = state.priceMinTemp ?? 0;
    const val    = parseFloat(text.replace(',', '.'));
    if (isNaN(val) || val <= minVal || val > 100) {
      await ctx.reply(`❌ Max price must be > ${minVal}¢ and ≤ 100¢. Example: <code>70</code>`, { parse_mode: 'HTML' });
      return true;
    }
    copyEditState.delete(telegramId);
    await prisma.copySubscription.update({
      where: { userId_traderAddress: { userId: user.id, traderAddress: addr } },
      data: { priceMin: minVal, priceMax: val },
    });
    await ctx.reply(`✅ Price range updated: ${minVal}¢ – ${val}¢`);
    await handleCopyManage(ctx, addr);
    return true;
  }

  // ── Daily limit ─────────────────────────────────────────────────────────────
  if (state.step === 'awaiting_daily_limit') {
    const raw = text.trim().replace(/[^0-9.]/g, '');
    const val = parseFloat(raw);
    if (isNaN(val) || val < 0) {
      await ctx.reply('❌ Enter a positive number or <code>0</code> to remove the limit.', { parse_mode: 'HTML' });
      return true;
    }
    copyEditState.delete(telegramId);
    const limitVal = val === 0 ? null : val;
    await prisma.copySubscription.update({
      where: { userId_traderAddress: { userId: user.id, traderAddress: addr } },
      data: { dailySpendMax: limitVal },
    });
    await ctx.reply(limitVal ? `✅ Daily limit: $${limitVal.toFixed(2)}` : `✅ Daily limit removed.`);
    await handleCopyManage(ctx, addr);
    return true;
  }

  // ── Single trade limit ──────────────────────────────────────────────────────
  if (state.step === 'awaiting_single_limit') {
    const raw = text.trim().replace(/[^0-9.]/g, '');
    const val = parseFloat(raw);
    if (isNaN(val) || val < 0) {
      await ctx.reply('❌ Enter a positive number or <code>0</code> to remove the limit.', { parse_mode: 'HTML' });
      return true;
    }
    copyEditState.delete(telegramId);
    const limitVal = val === 0 ? null : val;
    await prisma.copySubscription.update({
      where: { userId_traderAddress: { userId: user.id, traderAddress: addr } },
      data: { singleTradeMax: limitVal },
    });
    await ctx.reply(limitVal ? `✅ Single trade limit: $${limitVal.toFixed(2)}` : `✅ Single trade limit removed.`);
    await handleCopyManage(ctx, addr);
    return true;
  }

  return false;
}
