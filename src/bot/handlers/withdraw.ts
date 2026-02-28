import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { logger } from '../../utils/logger';
import { getUserByTelegramId } from '../../services/user';
import { getTokenBalance, executeWithdraw } from '../../services/withdraw';
import { sendPage } from '../../utils/telegram';

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

export const withdrawState = new Map<string, WithdrawState>();

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

    if (chain !== 'polygon') {
      await sendPage(ctx,
        `⚠️ *${chainLabel(chain)} — Coming Soon*\n\n` +
        'Cross-chain withdrawals are not yet available.\n\n' +
        'To withdraw to other chains:\n' +
        '1. Withdraw to your Polygon wallet first\n' +
        '2. Use a bridge service (e.g. Stargate, Across)',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('← Back', 'withdraw_menu')],
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        }
      );
      return;
    }

    await sendPage(ctx,
      '🟢 *Polygon — Select Token*\n\nChoose which token you want to receive:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('USDC',   'wd_token_USDC')],
          [Markup.button.callback('POL',    'wd_token_POL')],
          [Markup.button.callback('USDC.e', 'wd_token_USDC.e')],
          [Markup.button.callback('USDT',   'wd_token_USDT')],
          [Markup.button.callback('← Back', 'withdraw_menu')],
        ]),
      }
    );
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

  const state = withdrawState.get(telegramId);
  if (!state) return;

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

async function handleAddressInput(
  ctx: Context,
  telegramId: string,
  state: WithdrawState,
  address: string
): Promise<void> {
  // Validate Ethereum/Polygon address
  if (!ethers.utils.isAddress(address)) {
    await editWithdrawMessage(ctx, state,
      `🏦 *Withdraw ${state.tokenSymbol} (Polygon)*\n\n` +
      `💵 *Available Balance:* ${formatBalance(state.balance, state.tokenSymbol)}\n` +
      `🌐 *Token Address:*\n\`${TOKEN_CONTRACT_DISPLAY[state.token!]}\`\n\n` +
      `❌ *Invalid address.* Please enter a valid Polygon wallet address:`,
      [[Markup.button.callback('← Back', `wd_token_${state.token}`)]]
    );
    return;
  }

  const checksummed = ethers.utils.getAddress(address);

  // Update state
  state.destinationAddress = checksummed;
  state.step = 'enter_amount';
  state.timestamp = Date.now();
  withdrawState.set(telegramId, state);

  const amountLabel = state.tokenAmountLabel || 'USD';

  await editWithdrawMessage(ctx, state,
    `🏦 *Withdraw ${state.tokenSymbol} (Polygon)*\n\n` +
    `💵 *Available Balance:* ${formatBalance(state.balance, state.tokenSymbol)}\n` +
    `🌐 *Token Address:*\n\`${TOKEN_CONTRACT_DISPLAY[state.token!]}\`\n` +
    `📍 *Destination:*\n\`${checksummed}\`\n\n` +
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

  if (isNaN(amount) || amount <= 0) {
    await editWithdrawMessage(ctx, state,
      `🏦 *Withdraw ${state.tokenSymbol} (Polygon)*\n\n` +
      `💵 *Available Balance:* ${formatBalance(state.balance, state.tokenSymbol)}\n` +
      `📍 *Destination:*\n\`${state.destinationAddress}\`\n\n` +
      `❌ *Invalid amount.* Please enter a positive number:`,
      [[Markup.button.callback('← Cancel', 'wd_cancel')]]
    );
    return;
  }

  const available = parseFloat(state.balance || '0');
  if (amount > available) {
    await editWithdrawMessage(ctx, state,
      `🏦 *Withdraw ${state.tokenSymbol} (Polygon)*\n\n` +
      `💵 *Available Balance:* ${formatBalance(state.balance, state.tokenSymbol)}\n` +
      `📍 *Destination:*\n\`${state.destinationAddress}\`\n\n` +
      `❌ *Insufficient balance.* Max: ${state.balance} ${state.tokenSymbol}\n\nPlease enter a smaller amount:`,
      [[Markup.button.callback('← Cancel', 'wd_cancel')]]
    );
    return;
  }

  // Show processing state
  await editWithdrawMessage(ctx, state,
    `🏦 *Withdraw ${state.tokenSymbol} (Polygon)*\n\n` +
    `⏳ Processing withdrawal of *${amount} ${state.tokenSymbol}*...\n` +
    `📍 To: \`${state.destinationAddress}\``,
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

    const result = await executeWithdraw({
      encryptedPrivateKey: user.encryptedPrivateKey,
      proxyAddress: user.polymarketProxyAddress,
      tokenAddress: state.tokenAddress!,
      tokenDecimals: state.tokenDecimals!,
      destinationAddress: state.destinationAddress!,
      amount,
    });

    if (result.success) {
      const statusLine = result.pending
        ? '⏳ *Status:* Pending confirmation...'
        : '✅ *Status:* Confirmed';

      await editWithdrawMessage(ctx, state,
        `✅ *Withdrawal Submitted*\n\n` +
        `💸 *Amount:* ${amount} ${state.tokenSymbol}\n` +
        `📍 *To:* \`${state.destinationAddress}\`\n` +
        `🔗 *Tx:* \`${result.txHash}\`\n` +
        `${statusLine}\n\n` +
        `_You can track your transaction on Polygonscan_`,
        [
          [Markup.button.callback('💼 My Wallet', 'wallet_page')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]
      );
    } else {
      logger.warn(`[withdraw] Withdrawal failed for user ${telegramId}: ${result.error}`);
      await editWithdrawMessage(ctx, state,
        `❌ *Withdrawal Failed*\n\n` +
        `Please try again or contact support.`,
        [
          [Markup.button.callback('🔄 Try Again', 'withdraw_menu')],
          [Markup.button.callback('🏠 Main Menu',  'back_to_menu')],
        ]
      );
    }
  } catch (error: any) {
    logger.error('[withdraw] executeWithdraw error:', error);
    await editWithdrawMessage(ctx, state,
      `❌ *Withdrawal Failed*\n\nAn unexpected error occurred. Please try again.`,
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
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(buttons),
        }
      );
    } else {
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      });
    }
  } catch (e: any) {
    if (!e.message?.includes('message is not modified')) {
      logger.warn('[withdraw] editWithdrawMessage failed:', e.message);
    }
  }
}

function chainLabel(chain: string): string {
  const labels: Record<string, string> = {
    polygon: 'Polygon',
    solana: 'Solana',
    ethereum: 'Ethereum',
    bsc: 'Binance Smart Chain',
  };
  return labels[chain] || chain;
}
