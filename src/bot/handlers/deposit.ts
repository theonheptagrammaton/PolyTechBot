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
import { t, Locale } from '../../i18n';

function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

/**
 * Shows deposit menu
 */
export async function handleDepositMenu(ctx: Context): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    const telegramId = ctx.from?.id.toString();
    let lang: Locale = 'en';
    if (telegramId) {
      const user = await getUserByTelegramId(telegramId);
      lang = getLang(user);
    }

    const message =
      t(lang, 'deposit.title') +
      t(lang, 'deposit.howItWorks');

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn.polygon'), 'deposit_polygon')],
        [Markup.button.callback(t(lang, 'btn.ethereum'), 'deposit_ethereum')],
        [Markup.button.callback(t(lang, 'btn.solana'), 'deposit_solana')],
        [Markup.button.callback(t(lang, 'btn.checkAllBalances'), 'deposit_check_all')],
        [Markup.button.callback(t(lang, 'btn.backToWallet'), 'wallet_page')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
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
    await ctx.reply(t('en', 'deposit.errorLoading'));
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
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendPage(ctx, t('en', 'common.userNotFound'), {
        parse_mode: 'Markdown',
      });
      return;
    }

    const lang = getLang(user);

    // Polygon and Ethereum/Arbitrum/Base/Optimism deposits use the Bridge API address.
    // Bridge auto-relays to the user's Polymarket proxy — no bot action needed.
    if (chain === 'polygon' || chain === 'ethereum') {
      if (!user.depositAddressEvm) {
        await sendPage(ctx,
          t(lang, 'deposit.addressNotAvailable'),
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.back'), 'deposit_menu')]]),
          }
        );
        return;
      }
      const chainLabel = chain === 'polygon'
        ? t(lang, 'deposit.chainLabel.polygon', {})
        : t(lang, 'deposit.chainLabel.ethereum', {});
      const chainNote = chain === 'polygon'
        ? t(lang, 'deposit.chainNote.polygon', {})
        : t(lang, 'deposit.chainNote.ethereum', {});
      let msg = `${chainLabel}\n\n`;
      msg += t(lang, 'deposit.bridgeAddressLabel') + '\n';
      msg += `\`${user.depositAddressEvm}\`\n\n`;
      msg += t(lang, 'deposit.instructions.title') + '\n';
      msg += t(lang, 'deposit.instructions.sendUsdc') + '\n';
      msg += `${chainNote}\n`;
      msg += t(lang, 'deposit.instructions.bridgeRelay') + '\n';
      msg += t(lang, 'deposit.instructions.waitBridge') + '\n\n';
      msg += t(lang, 'deposit.minimumLabel') + '\n';
      msg += t(lang, 'deposit.noActionRequired');
      await sendPage(ctx, msg, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.back'), 'deposit_menu')],
          [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
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
          t(lang, 'deposit.solanaNotAvailable'),
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.back'), 'deposit_menu')]]),
          }
        );
        return;
      }
      address = user.depositAddressSvm;
    } else {
      // Fallback (should not be reached)
      await sendPage(ctx, t(lang, 'deposit.unsupported'), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.back'), 'deposit_menu')]]),
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

    let message = `${info.icon} *${t(lang, 'deposit.depositTokenOnChain', { token: info.token, chain: info.name })}*\n\n`;
    message += `*${t(lang, 'deposit.yourDepositAddress')}:*\n`;
    message += `\`${address}\`\n\n`;
    message += `📝 *${t(lang, 'deposit.instructionsLabel')}:*\n`;
    message += `1. ${t(lang, 'deposit.sendTokenToAddress', { token: info.token })}\n`;
    message += `2. ${t(lang, 'deposit.waitConfirmation')}\n`;
    message += `3. ${t(lang, 'deposit.clickISentFunds')}\n`;
    message += `4. ${t(lang, 'deposit.botCheckBalance')}\n`;
    message += `5. ${t(lang, 'deposit.approveAndDepositStep')}\n\n`;
    message += `💡 *${t(lang, 'deposit.minimumShort')}:* $10 USDC\n`;
    message += `🔍 [${t(lang, 'deposit.viewOnExplorer', { chain: info.name })}](${info.explorer}/address/${address})`;

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn.iSentFunds'), `deposit_sent_${chain}`)],
        [Markup.button.callback(t(lang, 'btn.checkBalance'), `deposit_balance_${chain}`)],
        [Markup.button.callback(t(lang, 'btn.back'), 'deposit_menu')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
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
    await ctx.reply(t('en', 'common.errorGeneric'));
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
    await ctx.answerCbQuery(t('en', 'deposit.checkingBalance'));

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply(t('en', 'common.userNotFoundShort'));
      return;
    }

    const lang = getLang(user);

    // Polygon and Ethereum deposits use Bridge API — no balance check needed, Bridge auto-relays.
    if (chain === 'polygon' || chain === 'ethereum') {
      const backAction = chain === 'polygon' ? 'deposit_polygon' : 'deposit_ethereum';
      const chainLabel = chain === 'polygon'
        ? '🟣 <b>' + t(lang, 'deposit.polygonDeposit') + '</b>'
        : '🔵 <b>' + t(lang, 'deposit.ethereumDeposit') + '</b>';
      await sendPage(ctx,
        `${chainLabel}\n\n` +
        t(lang, 'deposit.bridgeAutoRelay') + '\n\n' +
        ce(EMOJI.loading, '⏳') + ' ' + t(lang, 'deposit.waitAfterSending') + '\n' +
        t(lang, 'deposit.noFurtherAction'),
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(t(lang, 'btn.backToDeposit'), backAction)],
            [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
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
        await ctx.reply(t(lang, 'deposit.solanaNotConfiguredShort'));
        return;
      }
      address = user.depositAddressSvm;
    } else {
      // Fallback (should not be reached)
      await sendPage(ctx, t(lang, 'deposit.unsupported'), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.back'), 'deposit_menu')]]),
      });
      return;
    }

    // Get balance
    const balance = await getChainBalance(chain, address);

    const balanceNum = parseFloat(balance.balance);

    let message = `💰 *${chain.toUpperCase()} ${t(lang, 'deposit.balanceLabel')}*\n\n`;
    message += `${t(lang, 'deposit.balanceValue', { balance: formatBalance(balance.balance) })}\n\n`;

    if (balanceNum === 0) {
      message += t(lang, 'deposit.noFunds');
    } else if (balanceNum < 10) {
      message += t(lang, 'deposit.minDeposit', { needed: (10 - balanceNum).toFixed(2) });
    } else {
      message += t(lang, 'deposit.ready');
    }

    const buttons = [];

    if (balanceNum >= 10) {
      buttons.push([Markup.button.callback(t(lang, 'btn.approveDeposit'), `deposit_approve_${chain}`)]);
    }

    buttons.push([Markup.button.callback(t(lang, 'btn.refresh'), `deposit_balance_${chain}`)]);
    buttons.push([Markup.button.callback(t(lang, 'btn.back'), `deposit_${chain}`)]);
    buttons.push([Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')]);

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
      t('en', 'deposit.errorBalance'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(t('en', 'btn.back'), 'deposit_menu')]]),
      }
    );
  }
}

/**
 * Check all balances
 */
export async function handleCheckAllBalances(ctx: Context): Promise<void> {
  try {
    await ctx.answerCbQuery(t('en', 'deposit.checkingAll'));

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply(t('en', 'common.userNotFoundShort'));
      return;
    }

    const lang = getLang(user);

    // Get all balances
    const balances = await getAllBalances(user.walletAddress, user.depositAddressSvm || undefined);

    let message = `💰 *${t(lang, 'deposit.allBalancesTitle')}*\n\n`;
    message += `🟣 *Polygon:* ${formatBalance(balances.polygon.balance)}\n`;
    message += `🔵 *Ethereum:* ${formatBalance(balances.ethereum.balance)}\n`;
    message += `🟢 *Solana:* ${formatBalance(balances.solana.balance)}\n\n`;
    message += `📊 *${t(lang, 'deposit.totalLabel')}:* ${formatBalance(balances.total)}\n\n`;

    const totalNum = parseFloat(balances.total);

    if (totalNum === 0) {
      message += t(lang, 'deposit.allNoFunds');
    } else if (totalNum < 10) {
      message += t(lang, 'deposit.allMinDeposit', { needed: (10 - totalNum).toFixed(2) });
    } else {
      message += t(lang, 'deposit.allReady');
    }

    await sendPage(ctx, message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn.depositFromPolygon'), 'deposit_polygon')],
        [Markup.button.callback(t(lang, 'btn.depositFromEthereum'), 'deposit_ethereum')],
        [Markup.button.callback(t(lang, 'btn.depositFromSolana'), 'deposit_solana')],
        [Markup.button.callback(t(lang, 'btn.refresh'), 'deposit_check_all')],
        [Markup.button.callback(t(lang, 'btn.back'), 'deposit_menu')],
        [Markup.button.callback(t(lang, 'btn.mainMenu'), 'back_to_menu')],
      ]),
    });

    logger.info(`All balances shown to user: ${telegramId}`);
  } catch (error) {
    logger.error('Error checking all balances:', error);
    await sendPage(ctx,
      t('en', 'deposit.errorAllBalance'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(t('en', 'btn.back'), 'deposit_menu')]]),
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
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply(t('en', 'common.userNotFoundShort'));
      return;
    }

    const lang = getLang(user);

    // All chains use Bridge API — no manual approve needed
    await sendPage(ctx,
      '⚡ <b>' + t(lang, 'deposit.bridgeHandlesTitle') + '</b>\n\n' +
      t(lang, 'deposit.bridgeHandlesBody') + '\n\n' +
      ce(EMOJI.loading, '⏳') + ' ' + t(lang, 'deposit.waitAfterSending') + '\n' +
      t(lang, 'deposit.noFurtherAction'),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.back'), 'deposit_menu')]]),
      }
    );
    logger.info(`Deposit approve (bridge redirect) for user: ${telegramId}`);
  } catch (error) {
    logger.error('Error in approve deposit:', error);
    await ctx.reply(t('en', 'common.errorGeneric'));
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
      await ctx.reply(t('en', 'common.cannotIdentify'));
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply(t('en', 'common.userNotFoundShort'));
      return;
    }

    const lang = getLang(user);

    // All chains use Bridge API — no manual confirm needed
    await sendPage(ctx,
      '⚡ <b>' + t(lang, 'deposit.bridgeHandlesTitle') + '</b>\n\n' +
      t(lang, 'deposit.bridgeHandlesBody') + '\n\n' +
      ce(EMOJI.loading, '⏳') + ' ' + t(lang, 'deposit.waitAfterSending') + '\n' +
      t(lang, 'deposit.noFurtherAction'),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn.back'), 'deposit_menu')]]),
      }
    );
    logger.info(`Deposit confirm (bridge redirect) for user: ${telegramId}`);
  } catch (error) {
    logger.error('Error in confirm deposit:', error);
    await ctx.reply(t('en', 'common.errorGeneric'));
  }
}
