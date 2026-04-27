import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { logger } from '../../utils/logger';
import { getUserByTelegramId } from '../../services/user';
import { getTokenBalance, executeWithdraw, executeBridgeWithdraw, executePredexonWithdraw } from '../../services/withdraw';
import { getBalance as predexonGetBalance } from '../../services/predexon';
import { sendPage } from '../../utils/telegram';
import { ce, EMOJI } from '../../utils/customEmoji';
import { RedisBackedState } from '../../utils/redisState';
import { t, Locale } from '../../i18n';

/** Get locale from user object */
function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

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

// Native USDC on Polygon (source token for all withdrawals — Predexon-managed wallets hold native USDC)
const NATIVE_USDC = { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, symbol: 'USDC' };

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

    const telegramId = ctx.from?.id.toString();
    const user = telegramId ? await getUserByTelegramId(telegramId) : null;
    const lang = getLang(user);

    await sendPage(ctx,
      t(lang, 'withdraw.selectDestination'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'withdraw.chainPolygon'), 'wd_chain_polygon')],
          [Markup.button.callback(t(lang, 'common.mainMenu'), 'back_to_menu')],
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

    // ── Cross-chain: fetch USDC balance, go straight to address input ──────
    if (chain !== 'polygon') {
      const crossChain = CROSS_CHAIN_CONFIG[chain];
      if (!crossChain) return;

      const telegramId = ctx.from?.id.toString();
      if (!telegramId) return;

      const user = await getUserByTelegramId(telegramId);
      const lang = getLang(user);

      if (!user?.polymarketProxyAddress) {
        await sendPage(ctx, t(lang, 'withdraw.walletNotSetUp'), {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'common.back'), 'withdraw_menu')]]),
        });
        return;
      }

      let balance = '0.0000';
      try {
        if (user.predexonUserId) {
          const balances = await predexonGetBalance(user.predexonUserId, 'polymarket');
          balance = parseFloat(balances[0]?.available ?? '0').toFixed(4);
        } else {
          const { formatted } = await getTokenBalance(
            user.polymarketProxyAddress,
            NATIVE_USDC.address,
            NATIVE_USDC.decimals,
          );
          balance = formatted;
        }
      } catch (e) {
        logger.warn('[withdraw] USDC balance fetch failed:', e);
      }

      const text =
        `${crossChain.icon} *${t(lang, 'withdraw.crossChainTitle', { chain: crossChain.label })}*\n\n` +
        `💵 *${t(lang, 'withdraw.available')}:* $${balance} USDC\n\n` +
        `📍 ${t(lang, 'withdraw.enterDestinationAddress', { chain: crossChain.label })}`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'common.back'), 'withdraw_menu')],
        [Markup.button.callback(t(lang, 'common.mainMenu'), 'back_to_menu')],
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
        token: 'USDC',
        tokenAddress: NATIVE_USDC.address,
        tokenDecimals: NATIVE_USDC.decimals,
        tokenSymbol: NATIVE_USDC.symbol,
        tokenAmountLabel: 'USD',
        balance,
        chatId,
        msgId,
        step: 'enter_address',
        timestamp: Date.now(),
      });
      return;
    }

    // ── Polygon: direct USDC withdrawal (same UX as cross-chain) ──────────
    const telegramIdPoly = ctx.from?.id.toString();
    if (!telegramIdPoly) return;

    const userPoly = await getUserByTelegramId(telegramIdPoly);
    const lang = getLang(userPoly);

    if (!userPoly?.polymarketProxyAddress) {
      await sendPage(ctx, t(lang, 'withdraw.walletNotSetUp'), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'common.back'), 'withdraw_menu')]]),
      });
      return;
    }

    let balancePoly = '0.0000';
    try {
      if (userPoly.predexonUserId) {
        const balances = await predexonGetBalance(userPoly.predexonUserId, 'polymarket');
        balancePoly = parseFloat(balances[0]?.available ?? '0').toFixed(4);
      } else {
        const { formatted } = await getTokenBalance(
          userPoly.polymarketProxyAddress,
          NATIVE_USDC.address,
          NATIVE_USDC.decimals,
        );
        balancePoly = formatted;
      }
    } catch (e) {
      logger.warn('[withdraw] Polygon USDC balance fetch failed:', e);
    }

    const polyText =
      `🟢 *${t(lang, 'withdraw.polygonTitle')}*\n\n` +
      `💵 *${t(lang, 'withdraw.available')}:* $${balancePoly} USDC\n` +
      `🌐 *${t(lang, 'withdraw.token')}:*\n\`${NATIVE_USDC.address}\`\n\n` +
      `⚠️ _Your balance is currently in USDC.e (Bridged USDC). USDC.e cannot be deposited directly to centralized exchanges (Binance, Coinbase, etc.). You must bridge/swap to native USDC first._\n\n` +
      `📍 ${t(lang, 'withdraw.enterPolygonAddress')}`;

    const polyKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, 'common.back'), 'withdraw_menu')],
      [Markup.button.callback(t(lang, 'common.mainMenu'), 'back_to_menu')],
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
      token: 'USDC',
      tokenAddress: NATIVE_USDC.address,
      tokenDecimals: NATIVE_USDC.decimals,
      tokenSymbol: NATIVE_USDC.symbol,
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
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    const lang = getLang(user);

    await ctx.answerCbQuery(t(lang, 'withdraw.loadingBalance'));

    if (!user?.polymarketProxyAddress) {
      await ctx.answerCbQuery(t(lang, 'withdraw.walletNotSetUpShort'));
      return;
    }

    const token = POLYGON_TOKENS[tokenKey];
    if (!token) return;

    // Fetch balance
    let balance = '0.0000';
    try {
      if (user.predexonUserId && tokenKey === 'USDC') {
        const balances = await predexonGetBalance(user.predexonUserId, 'polymarket');
        balance = parseFloat(balances[0]?.available ?? '0').toFixed(4);
      } else {
        const { formatted } = await getTokenBalance(
          user.polymarketProxyAddress,
          token.address,
          token.decimals
        );
        balance = formatted;
      }
    } catch (e) {
      logger.warn('[withdraw] Balance fetch failed:', e);
    }

    const contractDisplay = TOKEN_CONTRACT_DISPLAY[tokenKey];

    const text =
      `🏦 *${t(lang, 'withdraw.tokenTitle', { symbol: token.symbol })}*\n\n` +
      `💵 *${t(lang, 'withdraw.availableBalance')}:* ${formatBalance(balance, token.symbol)}\n` +
      `🌐 *${t(lang, 'withdraw.tokenAddress')}:*\n\`${contractDisplay}\`\n\n` +
      `📍 ${t(lang, 'withdraw.enterPolygonAddress')}`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, 'common.back'), 'wd_chain_polygon')],
      [Markup.button.callback(t(lang, 'common.mainMenu'), 'back_to_menu')],
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
  const user = await getUserByTelegramId(telegramId).catch(() => null);
  const lang = getLang(user);

  const isCrossChain = state.chain !== 'polygon';
  const crossChain = isCrossChain ? CROSS_CHAIN_CONFIG[state.chain] : null;

  // Validate address format
  let checksummed: string;
  if (isCrossChain && crossChain?.addressType === 'svm') {
    // Solana address validation
    if (!isValidSolanaAddress(address)) {
      await editWithdrawMessage(ctx, state,
        `${crossChain.icon} <b>${t(lang, 'withdraw.crossChainTitle', { chain: crossChain.label })}</b>\n\n` +
        `💵 <b>${t(lang, 'withdraw.available')}:</b> $${state.balance} USDC\n\n` +
        `❌ <b>${t(lang, 'withdraw.invalidSolanaAddress')}</b>`,
        [[Markup.button.callback(t(lang, 'common.back'), 'withdraw_menu')]]
      );
      return;
    }
    checksummed = address.trim();
  } else {
    // EVM address validation (Polygon, Ethereum, BSC)
    if (!ethers.utils.isAddress(address)) {
      const backBtn = Markup.button.callback(t(lang, 'common.back'), 'withdraw_menu');
      const label = isCrossChain
        ? `${crossChain!.icon} <b>${t(lang, 'withdraw.crossChainTitle', { chain: crossChain!.label })}</b>`
        : `🟢 <b>${t(lang, 'withdraw.polygonTitle')}</b>`;
      const balanceLine = `💵 <b>${t(lang, 'withdraw.available')}:</b> $${state.balance} USDC`;
      await editWithdrawMessage(ctx, state,
        `${label}\n\n${balanceLine}\n\n❌ <b>${t(lang, 'withdraw.invalidEVMAddress')}</b>`,
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
    ? `${crossChainAddrDone.icon} <b>${t(lang, 'withdraw.crossChainTitle', { chain: crossChainAddrDone.label })}</b>`
    : `🟢 <b>${t(lang, 'withdraw.polygonTitle')}</b>`;
  const balanceLine = `💵 <b>${t(lang, 'withdraw.available')}:</b> $${state.balance} USDC`;

  await editWithdrawMessage(ctx, state,
    `${headerLine}\n\n` +
    `${balanceLine}\n` +
    `📍 <b>${t(lang, 'withdraw.destination')}:</b>\n<code>${checksummed}</code>\n\n` +
    `💰 ${t(lang, 'withdraw.enterAmount', { label: amountLabel })}`,
    [[Markup.button.callback(t(lang, 'withdraw.cancel'), 'wd_cancel')]]
  );
}

// ─── Amount input ─────────────────────────────────────────────────────────────

async function handleAmountInput(
  ctx: Context,
  telegramId: string,
  state: WithdrawState,
  amountText: string
): Promise<void> {
  const user = await getUserByTelegramId(telegramId).catch(() => null);
  const lang = getLang(user);

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
    ? `${crossChainAmt.icon} <b>${t(lang, 'withdraw.crossChainTitle', { chain: crossChainAmt.label })}</b>`
    : `🟢 <b>${t(lang, 'withdraw.polygonTitle')}</b>`;
  const balanceAmt = `💵 <b>${t(lang, 'withdraw.available')}:</b> $${state.balance} USDC`;

  if (isNaN(amount) || amount <= 0) {
    await editWithdrawMessage(ctx, state,
      `${headerAmt}\n\n${balanceAmt}\n` +
      `📍 <b>${t(lang, 'withdraw.destination')}:</b>\n<code>${state.destinationAddress}</code>\n\n` +
      `❌ <b>${t(lang, 'withdraw.invalidAmount')}</b>`,
      [[Markup.button.callback(t(lang, 'withdraw.cancel'), 'wd_cancel')]]
    );
    return;
  }

  const available = parseFloat(state.balance || '0');
  if (amount > available) {
    await editWithdrawMessage(ctx, state,
      `${headerAmt}\n\n${balanceAmt}\n` +
      `📍 <b>${t(lang, 'withdraw.destination')}:</b>\n<code>${state.destinationAddress}</code>\n\n` +
      `❌ <b>${t(lang, 'withdraw.insufficientBalance', { max: state.balance || '0', symbol: state.tokenSymbol || 'USDC' })}</b>`,
      [[Markup.button.callback(t(lang, 'withdraw.cancel'), 'wd_cancel')]]
    );
    return;
  }

  // Show processing state
  await editWithdrawMessage(ctx, state,
    `${headerAmt}\n\n` +
    `${ce(EMOJI.loading, '⏳')} ${t(lang, 'withdraw.processing', { amount: String(amount), symbol: state.tokenSymbol || 'USDC' })}\n` +
    `📍 ${t(lang, 'withdraw.to')}: <code>${state.destinationAddress}</code>`,
    []
  );

  // Fetch user BEFORE deleting state so a DB lookup failure allows a clean retry
  const userForExec = await getUserByTelegramId(telegramId).catch(() => null);
  if (!userForExec?.encryptedPrivateKey || !userForExec?.polymarketProxyAddress) {
    await editWithdrawMessage(ctx, state, `❌ ${t(lang, 'withdraw.walletNotFound')}`, [
      [Markup.button.callback(t(lang, 'withdraw.tryAgain'), 'withdraw_menu')],
      [Markup.button.callback(t(lang, 'common.mainMenu'), 'back_to_menu')],
    ]);
    return;
  }

  // State deleted here — prevents double-submission on re-click
  withdrawState.delete(telegramId);

  try {
    const isCrossChainExec = state.chain !== 'polygon';
    const crossChainExec = isCrossChainExec ? CROSS_CHAIN_CONFIG[state.chain] : null;

    // Use Predexon API for withdrawals when predexonUserId is available (managed, no gas needed)
    let result: { success: boolean; txHash?: string; pending?: boolean; error?: string };
    if (userForExec.predexonUserId) {
      result = await executePredexonWithdraw({
        predexonUserId: userForExec.predexonUserId,
        venue: 'polymarket',
        amount,
        destinationAddress: state.destinationAddress!,
        chain: state.chain,
      });
    } else {
      // Legacy fallback for users without Predexon userId
      result = isCrossChainExec
        ? await executeBridgeWithdraw({
            encryptedPrivateKey: userForExec.encryptedPrivateKey,
            proxyAddress: userForExec.polymarketProxyAddress,
            chain: state.chain,
            recipientAddr: state.destinationAddress!,
            amount,
          })
        : await executeWithdraw({
            encryptedPrivateKey: userForExec.encryptedPrivateKey,
            proxyAddress: userForExec.polymarketProxyAddress,
            tokenAddress: state.tokenAddress!,
            tokenDecimals: state.tokenDecimals!,
            destinationAddress: state.destinationAddress!,
            amount,
          });
    }

    if (result.success) {
      const statusLine = result.pending
        ? ce(EMOJI.loading, '⏳') + ` <b>${t(lang, 'withdraw.status')}:</b> ${t(lang, 'withdraw.pendingConfirmation')}`
        : `✅ <b>${t(lang, 'withdraw.status')}:</b> ${t(lang, 'withdraw.confirmed')}`;
      const chainNote = crossChainExec
        ? `\n<i>${t(lang, 'withdraw.bridgeDelivering', { chain: crossChainExec.label })}</i>`
        : `\n<i>${t(lang, 'withdraw.trackOnPolygonscan')}</i>`;

      await editWithdrawMessage(ctx, state,
        `✅ <b>${t(lang, 'withdraw.submitted')}</b>\n\n` +
        `💸 <b>${t(lang, 'withdraw.amount')}:</b> ${amount} ${state.tokenSymbol}\n` +
        `📍 <b>${t(lang, 'withdraw.to')}:</b> <code>${state.destinationAddress}</code>\n` +
        `🔗 <b>${t(lang, 'withdraw.tx')}:</b> <code>${result.txHash}</code>\n` +
        `${statusLine}${chainNote}`,
        [
          [Markup.button.callback(t(lang, 'withdraw.myWallet'), 'wallet_page')],
          [Markup.button.callback(t(lang, 'common.mainMenu'), 'back_to_menu')],
        ]
      );
    } else {
      logger.warn(`[withdraw] Withdrawal failed for user ${telegramId}: ${result.error}`);

      // Build user-friendly reason from the error
      let reason = '';
      const err = result.error || '';
      if (err.includes('invalid recipient address')) {
        reason = `❗ ${t(lang, 'withdraw.errInvalidRecipient')}`;
      } else if (err.includes('insufficient') || err.includes('balance')) {
        reason = `❗ ${t(lang, 'withdraw.errInsufficientBalance')}`;
      } else if (err.includes('Platform executor not configured')) {
        reason = `❗ ${t(lang, 'withdraw.errNotConfigured')}`;
      } else if (err.includes('All RPCs unresponsive')) {
        reason = `❗ ${t(lang, 'withdraw.errNetworkUnavailable')}`;
      } else if (err) {
        reason = `❗ ${err.length > 120 ? err.slice(0, 120) + '…' : err}`;
      } else {
        reason = `❗ ${t(lang, 'withdraw.errGeneric')}`;
      }

      await editWithdrawMessage(ctx, state,
        `❌ <b>${t(lang, 'withdraw.failed')}</b>\n\n${reason}`,
        [
          [Markup.button.callback(t(lang, 'withdraw.tryAgain'), 'withdraw_menu')],
          [Markup.button.callback(t(lang, 'common.mainMenu'), 'back_to_menu')],
        ]
      );
    }
  } catch (error: any) {
    logger.error('[withdraw] executeWithdraw error:', error);
    await editWithdrawMessage(ctx, state,
      `❌ <b>${t(lang, 'withdraw.failed')}</b>\n\n❗ ${t(lang, 'withdraw.errUnexpected')}`,
      [
        [Markup.button.callback(t(lang, 'withdraw.tryAgain'), 'withdraw_menu')],
        [Markup.button.callback(t(lang, 'common.mainMenu'), 'back_to_menu')],
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

    const user = telegramId ? await getUserByTelegramId(telegramId) : null;
    const lang = getLang(user);

    await sendPage(ctx,
      `❌ ${t(lang, 'withdraw.cancelled')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'withdraw.myWallet'), 'wallet_page')],
          [Markup.button.callback(t(lang, 'common.mainMenu'), 'back_to_menu')],
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
