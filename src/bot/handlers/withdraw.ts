import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { logger } from '../../utils/logger';
import { getUserByTelegramId } from '../../services/user';
import { getTokenBalance, executeWithdraw, executeBridgeWithdraw } from '../../services/withdraw';
import { sendPage } from '../../utils/telegram';
import { ce, EMOJI } from '../../utils/customEmoji';
import { RedisBackedState } from '../../utils/redisState';

// ─── Cross-chain config ──────────────────────────────────────────────────────

const CROSS_CHAIN_CONFIG: Record<string, {
  label: string;
  icon: string;
  addressType: 'evm' | 'svm';
  backAction: string;
}> = {
  solana:   { label: 'Solana',               icon: '🟣', addressType: 'svm', backAction: 'wd_chain_solana' },
  ethereum: { label: 'Ethereum',             icon: '🔵', addressType: 'evm', backAction: 'wd_chain_ethereum' },
  bsc:      { label: 'Binance Smart Chain',  icon: '🟡', addressType: 'evm', backAction: 'wd_chain_bsc' },
};

// USDC.e on Polygon (source token for all cross-chain withdrawals)
const USDC_E = { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6, symbol: 'USDC.e' };

// ─── Token config ───────────────────────────────────────────────────────────

const POLYGON_TOKENS: Record<string, {
  address: string | 'native';
  decimals: number;
  symbol: string;
  amountLabel: string;
}> = {
  'USDC':   { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6,  symbol: 'USDC',   amountLabel: 'USD' },
  'POL':    { address: 'native',                                       decimals: 18, symbol: 'POL',    amountLabel: 'POL' },
  'USDC.e': { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6,  symbol: 'USDC.e', amountLabel: 'USD' },
  'USDT':   { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6,  symbol: 'USDT',   amountLabel: 'USD' },
};

/** Format a token balance for display (POL is not USD-denominated). */
function formatBalance(balance: string | undefined, symbol: string | undefined): string {
  const bal = balance ?? '0';
  return symbol === 'POL' ? `${bal} POL` : `$${bal}`;
}

const TOKEN_CONTRACT_DISPLAY: Record<string, string> = {
  'USDC':   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  'POL':    'Native POL (gas token)',
  'USDC.e': '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  'USDT':   '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
};

// ─── State ───────────────────────────────────────────────────────────────────

interface WithdrawState {
  chain: 'polygon' | 'solana' | 'ethereum' | 'bsc';
  token?: string;
  tokenAddress?: string | 'native';
  tokenDecimals?: number;
  tokenSymbol?: string;
  tokenAmountLabel?: string;
  destinationAddress?: string;
  balance?: string;
  chatId?: number;
  msgId?: number;
  step: 'enter_address' | 'enter_amount';
  timestamp: number;
}

export const withdrawState = new RedisBackedState<WithdrawState>('withdraw', 600);

// R6: Periodic cleanup of abandoned state entries (every 30 min, remove entries > 10 min old)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, state] of withdrawState.entries()) {
    if (state.timestamp < cutoff) withdrawState.delete(key);
  }
}, 30 * 60 * 1000);

// ─── Chain selection ─────────────────────────────────────────────────────────

export async function handleWithdrawMenu(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();
    await sendPage(ctx,
      '🏦 *Select Withdrawal Destination*\n\nChoose where you want to receive your funds:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🟢 Polygon',             'wd_chain_polygon')],
          [Markup.button.callback('🟣 Solana',              'wd_chain_solana')],
          [Markup.button.callback('🔵 Ethereum',            'wd_chain_ethereum')],
          [Markup.button.callback('🟡 Binance Smart Chain', 'wd_chain_bsc')],
          [Markup.button.callback('🏠 Main Menu',           'back_to_menu')],
        ]),
      }
    );
    logger.info('[withdraw] Chain selection shown');
  } catch (error) {
    logger.error('[withdraw] handleWithdrawMenu error:', error);
  }
}

// ─── Chain handler ───────────────────────────────────────────────────────────

export async function handleWithdrawChain(ctx: Context, chain: string): Promise<void> {
  try {
    await ctx.answerCbQuery();

    // ── Cross-chain: fetch USDC.e balance, go straight to address input ──────
    if (chain !== 'polygon') {
      const crossChain = CROSS_CHAIN_CONFIG[chain];
      if (!crossChain) return;

      const telegramId = ctx.from?.id.toString();
      if (!telegramId) return;

      const user = await getUserByTelegramId(telegramId);
      if (!user?.polymarketProxyAddress) {
        await sendPage(ctx, '❌ Wallet not set up. Use /start first.', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('← Back', 'withdraw_menu')]]),
        });
        return;
      }

      let balance = '0.0000';
      try {
        const { formatted } = await getTokenBalance(
          user.polymarketProxyAddress,
          USDC_E.address,
          USDC_E.decimals,
        );
        balance = formatted;
      } catch (e) {
        logger.warn('[withdraw] USDC.e balance fetch failed:', e);
      }

      const text =
        `${crossChain.icon} *Withdraw USDC → ${crossChain.label}*\n\n` +
        `💵 *Available:* $${balance} USDC.e\n\n` +
        `📍 Please enter your ${crossChain.label} destination address:`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('← Back', 'withdraw_menu')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]);

      const cbMsg = ctx.callbackQuery && 'message' in ctx.callbackQuery
        ? ctx.callbackQuery.message : null;
      const chatId = ctx.chat?.id;
      let msgId: number | undefined;

      if (cbMsg && 'photo' in cbMsg) {
        const sent = await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
        msgId = sent.message_id;
      } else if (cbMsg) {
        try {
          await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
          msgId = cbMsg.message_id;
        } catch {
          const sent = await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
          msgId = sent.message_id;
        }
      } else {
        const sent = await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
        msgId = sent.message_id;
      }

      withdrawState.set(telegramId, {
        chain: chain as 'solana' | 'ethereum' | 'bsc',
        token: 'USDC.e',
        tokenAddress: USDC_E.address,
        tokenDecimals: USDC_E.decimals,
        tokenSymbol: USDC_E.symbol,
        tokenAmountLabel: 'USD',
        balance,
        chatId,
        msgId,
        step: 'enter_address',
        timestamp: Date.now(),
      });
      return;
    }

    // ── Polygon: direct USDC.e withdrawal (same UX as cross-chain) ──────────
    const telegramIdPoly = ctx.from?.id.toString();
    if (!telegramIdPoly) return;

    const userPoly = await getUserByTelegramId(telegramIdPoly);
    if (!userPoly?.polymarketProxyAddress) {
      await sendPage(ctx, '❌ Wallet not set up. Use /start first.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('← Back', 'withdraw_menu')]]),
      });
      return;
    }

    let balancePoly = '0.0000';
    try {
      const { formatted } = await getTokenBalance(
        userPoly.polymarketProxyAddress,
        USDC_E.address,
        USDC_E.decimals,
      );
      balancePoly = formatted;
    } catch (e) {
      logger.warn('[withdraw] Polygon USDC.e balance fetch failed:', e);
    }

    const polyText =
      `🟢 *Withdraw USDC.e — Polygon*\n\n` +
      `💵 *Available:* $${balancePoly} USDC.e\n` +
      `🌐 *Token:*\n\`${USDC_E.address}\`\n\n` +
      `📍 Please enter your Polygon wallet address:`;

    const polyKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('← Back', 'withdraw_menu')],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ]);

    const cbMsgPoly = ctx.callbackQuery && 'message' in ctx.callbackQuery
      ? ctx.callbackQuery.message : null;
    const chatIdPoly = ctx.chat?.id;
    let msgIdPoly: number | undefined;

    if (cbMsgPoly && 'photo' in cbMsgPoly) {
      const sent = await ctx.reply(polyText, { parse_mode: 'Markdown', ...polyKeyboard });
      msgIdPoly = sent.message_id;
    } else if (cbMsgPoly) {
      try {
        await ctx.editMessageText(polyText, { parse_mode: 'Markdown', ...polyKeyboard });
        msgIdPoly = cbMsgPoly.message_id;
      } catch {
        const sent = await ctx.reply(polyText, { parse_mode: 'Markdown', ...polyKeyboard });
        msgIdPoly = sent.message_id;
      }
    } else {
      const sent = await ctx.reply(polyText, { parse_mode: 'Markdown', ...polyKeyboard });
      msgIdPoly = sent.message_id;
    }

    withdrawState.set(telegramIdPoly, {
      chain: 'polygon',
      token: 'USDC.e',
      tokenAddress: USDC_E.address,
      tokenDecimals: USDC_E.decimals,
      tokenSymbol: USDC_E.symbol,
      tokenAmountLabel: 'USD',
      balance: balancePoly,
      chatId: chatIdPoly,
      msgId: msgIdPoly,
      step: 'enter_address',
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error('[withdraw] handleWithdrawChain error:', error);
  }
}

// ─── Token handler ───────────────────────────────────────────────────────────

export async function handleWithdrawToken(ctx: Context, tokenKey: string): Promise<void> {
  try {
    await ctx.answerCbQuery('Loading balance...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user?.polymarketProxyAddress) {
      await ctx.answerCbQuery('Wallet not set up');
      return;
    }

    const token = POLYGON_TOKENS[tokenKey];
    if (!token) return;

    // Fetch balance
    let balance = '0.0000';
    try {
      const { formatted } = await getTokenBalance(
        user.polymarketProxyAddress,
        token.address,
        token.decimals
      );
      balance = formatted;
    } catch (e) {
      logger.warn('[withdraw] Balance fetch failed:', e);
    }

    const contractDisplay = TOKEN_CONTRACT_DISPLAY[tokenKey];

    const text =
      `🏦 *Withdraw ${token.symbol} (Polygon)*\n\n` +
      `💵 *Available Balance:* ${formatBalance(balance, token.symbol)}\n` +
      `🌐 *Token Address:*\n\`${contractDisplay}\`\n\n` +
      `📍 Please enter your Polygon wallet address:`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('← Back', 'wd_chain_polygon')],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ]);

    // Send the state message and capture its message_id for future in-place edits.
    // Cannot use sendPage() here because it returns void and the withdraw flow
    // must track the exact message to edit it when the user types their address/amount.
    const cbMsg = ctx.callbackQuery && 'message' in ctx.callbackQuery
      ? ctx.callbackQuery.message : null;
    const chatId = ctx.chat?.id;
    let msgId: number | undefined;

    if (cbMsg && 'photo' in cbMsg) {
      // Photo message — send a new text reply without deleting the photo
      const sent = await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
      msgId = sent.message_id;
    } else if (cbMsg) {
      // Edit the existing text message in place
      try {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
        msgId = cbMsg.message_id;
      } catch {
        const sent = await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
        msgId = sent.message_id;
      }
    } else {
      const sent = await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
      msgId = sent.message_id;
    }

    // Save state
    withdrawState.set(telegramId, {
      chain: 'polygon',
      token: tokenKey,
      tokenAddress: token.address,
      tokenDecimals: token.decimals,
      tokenSymbol: token.symbol,
      tokenAmountLabel: token.amountLabel,
      balance,
      chatId,
      msgId,
      step: 'enter_address',
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error('[withdraw] handleWithdrawToken error:', error);
  }
}

// ─── Text input handler ───────────────────────────────────────────────────────

export async function handleWithdrawTextInput(ctx: Context, text: string): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const state = await withdrawState.get(telegramId);
  if (!state) return;

  // Expire stale state (10 min)
  if (Date.now() - state.timestamp > 10 * 60 * 1000) {
    withdrawState.delete(telegramId);
    return;
  }

  // Try to delete user's text message to keep chat clean
  try {
    await ctx.deleteMessage();
  } catch {}

  if (state.step === 'enter_address') {
    await handleAddressInput(ctx, telegramId, state, text);
  } else if (state.step === 'enter_amount') {
    await handleAmountInput(ctx, telegramId, state, text);
  }
}

// ─── Address input ───────────────────────────────────────────────────────────

function isValidSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

async function handleAddressInput(
  ctx: Context,
  telegramId: string,
  state: WithdrawState,
  address: string
): Promise<void> {
  const isCrossChain = state.chain !== 'polygon';
  const crossChain = isCrossChain ? CROSS_CHAIN_CONFIG[state.chain] : null;

  // Validate address format
  let checksummed: string;
  if (isCrossChain && crossChain?.addressType === 'svm') {
    // Solana address validation
    if (!isValidSolanaAddress(address)) {
      await editWithdrawMessage(ctx, state,
        `${crossChain.icon} <b>Withdraw USDC → ${crossChain.label}</b>\n\n` +
        `💵 <b>Available:</b> $${state.balance} USDC.e\n\n` +
        `❌ <b>Invalid Solana address.</b> Please enter a valid Solana wallet address:`,
        [[Markup.button.callback('← Back', 'withdraw_menu')]]
      );
      return;
    }
    checksummed = address.trim();
  } else {
    // EVM address validation (Polygon, Ethereum, BSC)
    if (!ethers.utils.isAddress(address)) {
      const backBtn = Markup.button.callback('← Back', 'withdraw_menu');
      const label = isCrossChain
        ? `${crossChain!.icon} <b>Withdraw USDC → ${crossChain!.label}</b>`
        : `🟢 <b>Withdraw USDC.e — Polygon</b>`;
      const balanceLine = `💵 <b>Available:</b> $${state.balance} USDC.e`;
      await editWithdrawMessage(ctx, state,
        `${label}\n\n${balanceLine}\n\n❌ <b>Invalid address.</b> Please enter a valid EVM wallet address:`,
        [[backBtn]]
      );
      return;
    }
    checksummed = ethers.utils.getAddress(address);
  }

  // Update state
  state.destinationAddress = checksummed;
  state.step = 'enter_amount';
  state.timestamp = Date.now();
  withdrawState.set(telegramId, state);

  const amountLabel = state.tokenAmountLabel || 'USD';
  const isCrossChainAddrDone = state.chain !== 'polygon';
  const crossChainAddrDone = isCrossChainAddrDone ? CROSS_CHAIN_CONFIG[state.chain] : null;

  const headerLine = crossChainAddrDone
    ? `${crossChainAddrDone.icon} <b>Withdraw USDC → ${crossChainAddrDone.label}</b>`
    : `🟢 <b>Withdraw USDC.e — Polygon</b>`;
  const balanceLine = `💵 <b>Available:</b> $${state.balance} USDC.e`;

  await editWithdrawMessage(ctx, state,
    `${headerLine}\n\n` +
    `${balanceLine}\n` +
    `📍 <b>Destination:</b>\n<code>${checksummed}</code>\n\n` +
    `💰 Please enter the amount to withdraw (in ${amountLabel}):`,
    [[Markup.button.callback('← Cancel', 'wd_cancel')]]
  );
}

// ─── Amount input ─────────────────────────────────────────────────────────────

async function handleAmountInput(
  ctx: Context,
  telegramId: string,
  state: WithdrawState,
  amountText: string
): Promise<void> {
  // Normalize locale-specific decimal formats before parsing.
  // Handles: "1.234,56" (European) → 1234.56, "1,234.56" (US) → 1234.56, "10,5" → 10.5
  const normalized = (() => {
    const s = amountText.trim().replace(/[^\d.,]/g, '');
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      // Comma is last separator → European decimal (e.g. "1.234,56")
      return s.replace(/\./g, '').replace(',', '.');
    }
    // Dot is last separator or no comma → remove commas (thousand separators)
    return s.replace(/,/g, '');
  })();
  const amount = parseFloat(normalized);

  const isCrossChainAmt = state.chain !== 'polygon';
  const crossChainAmt = isCrossChainAmt ? CROSS_CHAIN_CONFIG[state.chain] : null;
  const headerAmt = crossChainAmt
    ? `${crossChainAmt.icon} <b>Withdraw USDC → ${crossChainAmt.label}</b>`
    : `🟢 <b>Withdraw USDC.e — Polygon</b>`;
  const balanceAmt = `💵 <b>Available:</b> $${state.balance} USDC.e`;

  if (isNaN(amount) || amount <= 0) {
    await editWithdrawMessage(ctx, state,
      `${headerAmt}\n\n${balanceAmt}\n` +
      `📍 <b>Destination:</b>\n<code>${state.destinationAddress}</code>\n\n` +
      `❌ <b>Invalid amount.</b> Please enter a positive number:`,
      [[Markup.button.callback('← Cancel', 'wd_cancel')]]
    );
    return;
  }

  const available = parseFloat(state.balance || '0');
  if (amount > available) {
    await editWithdrawMessage(ctx, state,
      `${headerAmt}\n\n${balanceAmt}\n` +
      `📍 <b>Destination:</b>\n<code>${state.destinationAddress}</code>\n\n` +
      `❌ <b>Insufficient balance.</b> Max: ${state.balance} ${state.tokenSymbol}\n\nPlease enter a smaller amount:`,
      [[Markup.button.callback('← Cancel', 'wd_cancel')]]
    );
    return;
  }

  // Show processing state
  await editWithdrawMessage(ctx, state,
    `${headerAmt}\n\n` +
    `${ce(EMOJI.loading, '⏳')} Processing withdrawal of <b>${amount} ${state.tokenSymbol}</b>...\n` +
    `📍 To: <code>${state.destinationAddress}</code>`,
    []
  );

  // Fetch user BEFORE deleting state so a DB lookup failure allows a clean retry
  const user = await getUserByTelegramId(telegramId).catch(() => null);
  if (!user?.encryptedPrivateKey || !user?.polymarketProxyAddress) {
    await editWithdrawMessage(ctx, state, '❌ Wallet not found. Please contact support.', [
      [Markup.button.callback('🔄 Try Again', 'withdraw_menu')],
      [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
    ]);
    return;
  }

  // State deleted here — prevents double-submission on re-click
  withdrawState.delete(telegramId);

  try {
    const isCrossChainExec = state.chain !== 'polygon';
    const crossChainExec = isCrossChainExec ? CROSS_CHAIN_CONFIG[state.chain] : null;

    const result = isCrossChainExec
      ? await executeBridgeWithdraw({
          encryptedPrivateKey: user.encryptedPrivateKey,
          proxyAddress: user.polymarketProxyAddress,
          chain: state.chain,
          recipientAddr: state.destinationAddress!,
          amount,
        })
      : await executeWithdraw({
          encryptedPrivateKey: user.encryptedPrivateKey,
          proxyAddress: user.polymarketProxyAddress,
          tokenAddress: state.tokenAddress!,
          tokenDecimals: state.tokenDecimals!,
          destinationAddress: state.destinationAddress!,
          amount,
        });

    if (result.success) {
      const statusLine = result.pending
        ? ce(EMOJI.loading, '⏳') + ' <b>Status:</b> Pending confirmation...'
        : '✅ <b>Status:</b> Confirmed';
      const chainNote = crossChainExec
        ? `\n<i>Bridge is delivering USDC to your ${crossChainExec.label} address (1–2 min)</i>`
        : `\n<i>You can track your transaction on Polygonscan</i>`;

      await editWithdrawMessage(ctx, state,
        `✅ <b>Withdrawal Submitted</b>\n\n` +
        `💸 <b>Amount:</b> ${amount} ${state.tokenSymbol}\n` +
        `📍 <b>To:</b> <code>${state.destinationAddress}</code>\n` +
        `🔗 <b>Tx:</b> <code>${result.txHash}</code>\n` +
        `${statusLine}${chainNote}`,
        [
          [Markup.button.callback('💼 My Wallet', 'wallet_page')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]
      );
    } else {
      logger.warn(`[withdraw] Withdrawal failed for user ${telegramId}: ${result.error}`);

      // Build user-friendly reason from the error
      let reason = '';
      const err = result.error || '';
      if (err.includes('invalid recipient address')) {
        reason = '❗ The destination address format is invalid for this chain.\nPlease check the address and try again.';
      } else if (err.includes('insufficient') || err.includes('balance')) {
        reason = '❗ Insufficient balance to complete the withdrawal.';
      } else if (err.includes('Platform executor not configured')) {
        reason = '❗ Withdrawal service is not configured. Please try again later.';
      } else if (err.includes('All RPCs unresponsive')) {
        reason = '❗ Network is temporarily unavailable. Please try again in a moment.';
      } else if (err) {
        reason = `❗ ${err.length > 120 ? err.slice(0, 120) + '…' : err}`;
      } else {
        reason = '❗ Please check your balance and destination address, then try again.';
      }

      await editWithdrawMessage(ctx, state,
        `❌ <b>Withdrawal Failed</b>\n\n${reason}`,
        [
          [Markup.button.callback('🔄 Try Again', 'withdraw_menu')],
          [Markup.button.callback('🏠 Main Menu',  'back_to_menu')],
        ]
      );
    }
  } catch (error: any) {
    logger.error('[withdraw] executeWithdraw error:', error);
    await editWithdrawMessage(ctx, state,
      `❌ <b>Withdrawal Failed</b>\n\n❗ An unexpected error occurred. Please try again.`,
      [
        [Markup.button.callback('🔄 Try Again', 'withdraw_menu')],
        [Markup.button.callback('🏠 Main Menu',  'back_to_menu')],
      ]
    );
  }
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

export async function handleWithdrawCancel(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();
    const telegramId = ctx.from?.id.toString();
    if (telegramId) withdrawState.delete(telegramId);

    await sendPage(ctx,
      '❌ Withdrawal cancelled.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💼 My Wallet', 'wallet_page')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      }
    );
  } catch (error) {
    logger.error('[withdraw] handleWithdrawCancel error:', error);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function editWithdrawMessage(
  ctx: Context,
  state: WithdrawState,
  text: string,
  buttons: ReturnType<typeof Markup.button.callback>[][]
): Promise<void> {
  try {
    if (state.chatId && state.msgId) {
      await ctx.telegram.editMessageText(
        state.chatId,
        state.msgId,
        undefined,
        text,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(buttons),
        }
      );
    } else {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(buttons),
      });
    }
  } catch (e: any) {
    if (!e.message?.includes('message is not modified')) {
      logger.warn('[withdraw] editWithdrawMessage failed:', e.message);
    }
  }
}

