import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { logger } from '../../utils/logger';
import { getUserByTelegramId } from '../../services/user';
import {
  getAllBalances,
  getChainBalance,
  approveUSDC,
  depositToPolymarket,
  formatBalance,
} from '../../services/deposit';

// User state for deposit flow
export const depositState = new Map<
  string,
  {
    action: string;
    chain?: string;
    amount?: string;
    timestamp: number;
  }
>();

/**
 * Shows deposit menu
 */
export async function handleDepositMenu(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const message =
      '💰 *Deposit Funds*\n\n' +
      'Add USDC to your trading balance.\n\n' +
      '*How it works:*\n' +
      '1️⃣ Select a chain (Polygon, Ethereum, or Solana)\n' +
      '2️⃣ Send USDC to your deposit address\n' +
      '3️⃣ Confirm transfer\n' +
      '4️⃣ Bot automatically deposits to Polymarket\n\n' +
      '💡 *Minimum deposit:* $10\n' +
      '⚡ *Recommended:* Polygon (lowest fees)';

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🟣 Polygon (Recommended)', 'deposit_polygon')],
        [Markup.button.callback('🔵 Ethereum', 'deposit_ethereum')],
        [Markup.button.callback('🟢 Solana', 'deposit_solana')],
        [Markup.button.callback('📊 Check All Balances', 'deposit_check_all')],
        [Markup.button.callback('« Back to Wallet', 'wallet_page')],
      ]),
    });

    logger.info(`Deposit menu shown to user: ${ctx.from?.id}`);
  } catch (error) {
    logger.error('Error showing deposit menu:', error);
    await ctx.reply('❌ An error occurred while loading deposit menu.');
  }
}

/**
 * Show deposit instructions for specific chain
 */
export async function handleDepositChain(
  ctx: Context,
  chain: 'polygon' | 'ethereum' | 'solana'
): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.editMessageText('❌ User not found. Use /start to create your wallet.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    // Get address based on chain
    const address =
      chain === 'solana' ? user.solanaAddress || user.walletAddress : user.walletAddress;

    // Chain info
    const chainInfo = {
      polygon: {
        name: 'Polygon',
        icon: '🟣',
        token: 'USDC (PoS)',
        explorer: 'https://polygonscan.com',
      },
      ethereum: {
        name: 'Ethereum',
        icon: '🔵',
        token: 'USDC',
        explorer: 'https://etherscan.io',
      },
      solana: {
        name: 'Solana',
        icon: '🟢',
        token: 'USDC (SPL)',
        explorer: 'https://solscan.io',
      },
    };

    const info = chainInfo[chain];

    let message = `${info.icon} *Deposit ${info.token} on ${info.name}*\n\n`;
    message += '*Your Deposit Address:*\n';
    message += `\`${address}\`\n\n`;
    message += '📝 *Instructions:*\n';
    message += `1. Send ${info.token} to the address above\n`;
    message += '2. Wait for confirmation (1-5 minutes)\n';
    message += '3. Click "I Sent Funds" below\n';
    message += '4. Bot will check your balance\n';
    message += '5. Approve & deposit to Polymarket\n\n';
    message += `💡 *Minimum:* $10 USDC\n`;
    message += `🔍 [View on ${info.name} Explorer](${info.explorer}/address/${address})`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ I Sent Funds', `deposit_sent_${chain}`)],
        [Markup.button.callback('🔄 Check Balance', `deposit_balance_${chain}`)],
        [Markup.button.callback('« Back', 'deposit_menu')],
      ]),
    });

    logger.info(`Deposit ${chain} instructions shown to user: ${telegramId}`);
  } catch (error) {
    logger.error(`Error showing deposit ${chain} instructions:`, error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Check balance for specific chain
 */
export async function handleCheckBalance(
  ctx: Context,
  chain: 'polygon' | 'ethereum' | 'solana'
): Promise<void> {
  try {
    await ctx.answerCbQuery('Checking balance...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('❌ User not found.');
      return;
    }

    const address =
      chain === 'solana' ? user.solanaAddress || user.walletAddress : user.walletAddress;

    // Get balance
    const balance = await getChainBalance(chain, address);

    const balanceNum = parseFloat(balance.balance);

    let message = `💰 *${chain.toUpperCase()} Balance*\n\n`;
    message += `Balance: *${formatBalance(balance.balance)}*\n\n`;

    if (balanceNum === 0) {
      message += '📭 No USDC found.\n\n';
      message += 'Please send USDC to your deposit address first.';
    } else if (balanceNum < 10) {
      message += `⚠️ *Minimum deposit is $10*\n\n`;
      message += `You need to send at least $${(10 - balanceNum).toFixed(2)} more USDC.`;
    } else {
      message += '✅ *Ready to deposit!*\n\n';
      message += 'Click "Approve & Deposit" to transfer funds to your Polymarket trading account.';
    }

    const buttons = [];

    if (balanceNum >= 10) {
      buttons.push([Markup.button.callback('🚀 Approve & Deposit', `deposit_approve_${chain}`)]);
    }

    buttons.push([Markup.button.callback('🔄 Refresh', `deposit_balance_${chain}`)]);
    buttons.push([Markup.button.callback('« Back', `deposit_${chain}`)]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });

    logger.info(`Balance checked for ${chain}: ${balance.balance}`);
  } catch (error) {
    logger.error(`Error checking ${chain} balance:`, error);
    await ctx.editMessageText(
      '❌ *Error Checking Balance*\n\n' +
      'Could not fetch balance from blockchain.\n\n' +
      'This might be a temporary network issue. Please try again.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'deposit_menu')]]),
      }
    );
  }
}

/**
 * Check all balances
 */
export async function handleCheckAllBalances(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery('Checking all balances...');

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('❌ User not found.');
      return;
    }

    // Get all balances
    const balances = await getAllBalances(user.walletAddress, user.solanaAddress || undefined);

    let message = '💰 *All Balances*\n\n';
    message += `🟣 *Polygon:* ${formatBalance(balances.polygon.balance)}\n`;
    message += `🔵 *Ethereum:* ${formatBalance(balances.ethereum.balance)}\n`;
    message += `🟢 *Solana:* ${formatBalance(balances.solana.balance)}\n\n`;
    message += `📊 *Total:* ${formatBalance(balances.total)}\n\n`;

    const totalNum = parseFloat(balances.total);

    if (totalNum === 0) {
      message += '📭 *No funds found*\n\n';
      message += 'Send USDC to any of your deposit addresses to get started.';
    } else if (totalNum < 10) {
      message += `⚠️ *Minimum deposit is $10*\n\n`;
      message += `You need $${(10 - totalNum).toFixed(2)} more to start trading.`;
    } else {
      message += '✅ *Ready to trade!*\n\n';
      message += 'Select a chain above to deposit funds to Polymarket.';
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🟣 Deposit from Polygon', 'deposit_polygon')],
        [Markup.button.callback('🔵 Deposit from Ethereum', 'deposit_ethereum')],
        [Markup.button.callback('🟢 Deposit from Solana', 'deposit_solana')],
        [Markup.button.callback('🔄 Refresh', 'deposit_check_all')],
        [Markup.button.callback('« Back', 'deposit_menu')],
      ]),
    });

    logger.info(`All balances shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error checking all balances:', error);
    await ctx.editMessageText(
      '❌ *Error Checking Balances*\n\n' +
      'Could not fetch balances from blockchains.\n\n' +
      'Please try again in a moment.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'deposit_menu')]]),
      }
    );
  }
}

/**
 * Handle approve & deposit flow
 */
export async function handleApproveDeposit(
  ctx: Context,
  chain: 'polygon' | 'ethereum' | 'solana'
): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('❌ User not found.');
      return;
    }

    // Only Polygon supported for Polymarket deposit
    if (chain !== 'polygon') {
      await ctx.editMessageText(
        '⚠️ *Polymarket Only Supports Polygon*\n\n' +
        'To deposit to Polymarket, you need USDC on Polygon.\n\n' +
        'Please:\n' +
        '1. Bridge your USDC to Polygon, or\n' +
        '2. Send Polygon USDC directly',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'deposit_menu')]]),
        }
      );
      return;
    }

    const address = user.walletAddress;

    // Get balance
    const balance = await getChainBalance(chain, address);
    const balanceNum = parseFloat(balance.balance);

    if (balanceNum < 10) {
      await ctx.editMessageText(
        '⚠️ *Insufficient Balance*\n\n' +
        `Minimum deposit is $10.\n` +
        `You have: ${formatBalance(balance.balance)}\n\n` +
        'Please send more USDC first.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Back', `deposit_${chain}`)]]),
        }
      );
      return;
    }

    // Show confirmation
    let message = '🚀 *Confirm Deposit*\n\n';
    message += `Chain: *Polygon*\n`;
    message += `Amount: *${formatBalance(balance.balance)}*\n\n`;
    message += '⚠️ *This will:*\n';
    message += '1. Approve USDC for Polymarket\n';
    message += '2. Transfer funds to your Polymarket account\n\n';
    message += '💰 *Gas fees:* ~$0.01-0.05 (paid from your wallet)\n\n';
    message += '✅ Are you sure you want to proceed?';

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Deposit Now', `deposit_confirm_${chain}`)],
        [Markup.button.callback('❌ Cancel', `deposit_${chain}`)],
      ]),
    });

    logger.info(`Deposit confirmation shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error in approve deposit:', error);
    await ctx.reply('❌ An error occurred.');
  }
}

/**
 * Confirm and execute deposit
 */
export async function handleConfirmDeposit(
  ctx: Context,
  chain: 'polygon' | 'ethereum' | 'solana'
): Promise<void> {
  try {
    await ctx.answerCbQuery();

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply('❌ Could not identify your Telegram account.');
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('❌ User not found.');
      return;
    }

    // Send processing message
    await ctx.editMessageText(
      '⏳ *Processing Deposit*\n\n' +
      '1️⃣ Approving USDC...\n' +
      '⏳ Please wait, this may take 1-2 minutes.',
      { parse_mode: 'Markdown' }
    );

    const address = user.walletAddress;
    const balance = await getChainBalance(chain, address);
    const amount = balance.balance;

    try {
      // Step 1: Approve USDC
      await approveUSDC(user.encryptedPrivateKey, amount);

      await ctx.editMessageText(
        '⏳ *Processing Deposit*\n\n' +
        '✅ USDC Approved\n' +
        '2️⃣ Depositing to Polymarket...\n' +
        '⏳ Please wait...',
        { parse_mode: 'Markdown' }
      );

      // Step 2: Deposit to Polymarket
      const depositTx = await depositToPolymarket(user.encryptedPrivateKey, amount);

      // Success!
      let message = '✅ *Deposit Successful!*\n\n';
      message += `Amount: *${formatBalance(amount)}*\n`;
      message += `Chain: *Polygon*\n\n`;
      message += '🎉 Your funds are now available for trading on Polymarket!\n\n';
      message += `🔍 [View Transaction](https://polygonscan.com/tx/${depositTx})`;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💼 View Wallet', 'wallet_page')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      });

      logger.info(`Deposit successful for user ${telegramId}: ${amount} USDC`);
    } catch (error: any) {
      logger.error('Error executing deposit:', error);

      await ctx.editMessageText(
        '❌ *Deposit Failed*\n\n' +
        'An error occurred while processing your deposit.\n\n' +
        `Error: ${error.message}\n\n` +
        'Your funds are still in your wallet. Please try again or contact support.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'deposit_menu')]]),
        }
      );
    }
  } catch (error) {
    logger.error('Error in confirm deposit:', error);
    await ctx.reply('❌ An error occurred.');
  }
}
