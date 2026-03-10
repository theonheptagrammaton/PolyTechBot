import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { logger } from '../../utils/logger';
import { getUserByTelegramId } from '../../services/user';
import { sendPage } from '../../utils/telegram';
import {
  getAllBalances,
  getChainBalance,
  formatBalance,
} from '../../services/deposit';
import { ce, EMOJI } from '../../utils/customEmoji';

/**
 * Shows deposit menu
 */
export async function handleDepositMenu(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

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

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🟣 Polygon (Recommended)', 'deposit_polygon')],
        [Markup.button.callback('🔵 Ethereum', 'deposit_ethereum')],
        [Markup.button.callback('🟢 Solana', 'deposit_solana')],
        [Markup.button.callback('📊 Check All Balances', 'deposit_check_all')],
        [Markup.button.callback('« Back to Wallet', 'wallet_page')],
        [Markup.button.callback('🏠 Main Menu',      'back_to_menu')],
      ]),
    }).catch((err: any) => {
      // Ignore "message is not modified" errors
      if (!err.message?.includes('message is not modified')) {
        throw err;
      }
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
      await sendPage(ctx, '❌ User not found. Use /start to create your wallet.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    // Polygon and Ethereum/Arbitrum/Base/Optimism deposits use the Bridge API address.
    // Bridge auto-relays to the user's Polymarket proxy — no bot action needed.
    if (chain === 'polygon' || chain === 'ethereum') {
      if (!user.depositAddressEvm) {
        await sendPage(ctx,
          '❌ *Deposit Address Not Available*\n\n' +
          'Your deposit address is not yet configured. Please contact support.',
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'deposit_menu')]]),
          }
        );
        return;
      }
      const chainLabel = chain === 'polygon'
        ? '🟣 *Deposit USDC — Polygon*'
        : '🔵 *Deposit USDC — Ethereum / Arbitrum / Base / Optimism*';
      const chainNote = chain === 'polygon'
        ? '   _(Polygon USDC or USDC.e)_'
        : '   _(Ethereum, Arbitrum, Base, Optimism)_';
      let msg = `${chainLabel}\n\n`;
      msg += '*Your Bridge Deposit Address:*\n';
      msg += `\`${user.depositAddressEvm}\`\n\n`;
      msg += '📝 *Instructions:*\n';
      msg += '1. Send USDC to the address above\n';
      msg += `${chainNote}\n`;
      msg += '2. Bridge will automatically relay funds to your Polymarket account\n';
      msg += '3. Wait 1–2 minutes for confirmation\n\n';
      msg += '💡 *Minimum:* $10 USDC\n';
      msg += '⚡ No action required after sending — Bridge handles the rest.';
      await sendPage(ctx, msg, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back', 'deposit_menu')],
          [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
        ]),
      }).catch((err: any) => {
        if (!err.message?.includes('message is not modified')) throw err;
      });
      logger.info(`Deposit ${chain} (bridge) instructions shown to user: ${telegramId}`);
      return;
    }

    // Get address based on chain (Solana only reaches here)
    let address: string;
    if (chain === 'solana') {
      if (!user.depositAddressSvm) {
        await sendPage(ctx,
          '❌ *Solana Deposit Not Available*\n\n' +
          'Your Solana deposit address is not yet configured.\n\n' +
          'Please use Polygon or Ethereum for deposits.',
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'deposit_menu')]]),
          }
        );
        return;
      }
      address = user.depositAddressSvm;
    } else {
      // Fallback (should not be reached)
      await sendPage(ctx, '❌ Unsupported chain.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'deposit_menu')]]),
      });
      return;
    }

    // Chain info
    const chainInfo = {
      polygon: {
        name: 'Polygon',
        icon: '🟣',
        token: 'USDC (PoS)',
        explorer: 'https://polygonscan.com',
      },
      solana: {
        name: 'Solana',
        icon: '🟢',
        token: 'USDC (SPL)',
        explorer: 'https://solscan.io',
      },
    } as Record<string, { name: string; icon: string; token: string; explorer: string }>;

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

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ I Sent Funds', `deposit_sent_${chain}`)],
        [Markup.button.callback('🔄 Check Balance', `deposit_balance_${chain}`)],
        [Markup.button.callback('« Back', 'deposit_menu')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    }).catch((err: any) => {
      // Ignore "message is not modified" errors
      if (!err.message?.includes('message is not modified')) {
        throw err;
      }
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

    // Polygon and Ethereum deposits use Bridge API — no balance check needed, Bridge auto-relays.
    if (chain === 'polygon' || chain === 'ethereum') {
      const backAction = chain === 'polygon' ? 'deposit_polygon' : 'deposit_ethereum';
      const chainLabel = chain === 'polygon'
        ? '🟣 <b>Polygon Deposit</b>'
        : '🔵 <b>Ethereum / Arbitrum / Base / Optimism Deposit</b>';
      await sendPage(ctx,
        `${chainLabel}\n\n` +
        'Bridge automatically relays your USDC to Polymarket.\n\n' +
        ce(EMOJI.loading, '⏳') + ' If you already sent funds, please wait 1–2 minutes.\n' +
        'No further action is required.',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back to Deposit', backAction)],
            [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
          ]),
        }
      ).catch((err: any) => {
        if (!err.message?.includes('message is not modified')) throw err;
      });
      return;
    }

    let address: string;
    if (chain === 'solana') {
      if (!user.depositAddressSvm) {
        await ctx.reply('❌ Solana deposit address not configured. Please use Polygon or Ethereum for deposits.');
        return;
      }
      address = user.depositAddressSvm;
    } else {
      // Fallback (should not be reached)
      await sendPage(ctx, '❌ Unsupported chain.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'deposit_menu')]]),
      });
      return;
    }

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
    buttons.push([Markup.button.callback('🏠 Main Menu', 'back_to_menu')]);

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    }).catch((err: any) => {
      // Ignore "message is not modified" errors
      if (!err.message?.includes('message is not modified')) {
        throw err;
      }
    });

    logger.info(`Balance checked for ${chain}: ${balance.balance}`);
  } catch (error) {
    logger.error(`Error checking ${chain} balance:`, error);
    await sendPage(ctx,
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
    const balances = await getAllBalances(user.walletAddress, user.depositAddressSvm || undefined);

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

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🟣 Deposit from Polygon', 'deposit_polygon')],
        [Markup.button.callback('🔵 Deposit from Ethereum', 'deposit_ethereum')],
        [Markup.button.callback('🟢 Deposit from Solana', 'deposit_solana')],
        [Markup.button.callback('🔄 Refresh', 'deposit_check_all')],
        [Markup.button.callback('« Back', 'deposit_menu')],
        [Markup.button.callback('🏠 Main Menu', 'back_to_menu')],
      ]),
    });

    logger.info(`All balances shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error checking all balances:', error);
    await sendPage(ctx,
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
  _chain: 'polygon' | 'ethereum' | 'solana'
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

    // All chains use Bridge API — no manual approve needed
    await sendPage(ctx,
      '⚡ <b>Bridge Handles This Automatically</b>\n\n' +
      'Your USDC is relayed directly to your Polymarket account by Bridge.\n\n' +
      ce(EMOJI.loading, '⏳') + ' Please wait 1–2 minutes after sending.\n' +
      'No further action is required.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'deposit_menu')]]),
      }
    );
    logger.info(`Deposit approve (bridge redirect) for user: ${telegramId}`);
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
  _chain: 'polygon' | 'ethereum' | 'solana'
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

    // All chains use Bridge API — no manual confirm needed
    await sendPage(ctx,
      '⚡ <b>Bridge Handles This Automatically</b>\n\n' +
      'Your USDC is relayed directly to your Polymarket account by Bridge.\n\n' +
      ce(EMOJI.loading, '⏳') + ' Please wait 1–2 minutes after sending.\n' +
      'No further action is required.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'deposit_menu')]]),
      }
    );
    logger.info(`Deposit confirm (bridge redirect) for user: ${telegramId}`);
  } catch (error) {
    logger.error('Error in confirm deposit:', error);
    await ctx.reply('❌ An error occurred.');
  }
}
