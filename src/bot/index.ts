import { Telegraf, Context } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { handleStart, handleCheckMembership } from './handlers/start';
import { handleHelp } from './handlers/help';
import { handleWallet } from './handlers/wallet';
import {
  handleStats,
  handleUsers,
  handleRefreshStats,
  handleViewUsersButton,
  handleUsersPage,
  handleDeleteUserConfirm,
  handleDeleteUserConfirmed,
  handleBackToStats,
  handleResetMe,
  handleResetMeConfirmed,
  handleResetMeCancel,
} from './handlers/admin';
import {
  handleShowCategories,
  handleCategorySelection,
  handleEventFromPage,
  handleMarketDetails,
  handleBackToMenu,
  handleSmartWallets,
  handleSwCategoryFilter,
  handleSwSortFilter,
  handleRefreshCategory,
  handleSportsCategory,
  handleLiveSports,
} from './handlers/markets';
import {
  handleWalletPage,
  handlePortfolio,
  handleOpenPositions,
  handleOpenOrders,
  handleClosedPositions,
  handleAllTransactions,
  handleCancelOrderConfirm,
  handleCancelOrderExecute,
  handleCancelAllConfirm,
  handleCancelAllExecute,
  handleCloseAllConfirm,
  handleCloseAllExecute,
  handlePnl,
  handlePortfolioPnl,
  handlePnlShare,
} from './handlers/walletPage';
import {
  handleCryptoCategory,
  handleUpDownCrypto,
  handleUpDownMarketDetail,
} from './handlers/cryptoMarkets';
import {
  handleSearchPrompt,
  handleLinkInput,
  detectPolymarketLink,
  handleKeywordSearch,
  handlePriceCommand,
} from './handlers/search';
import {
  handleTwoFactorMenu,
  handleEnableTwoFactor,
  handleVerifyTwoFactorSetup,
  handleDisableTwoFactor,
  handleConfirmDisableTwoFactor,
  handleShowBackupCodes,
  handleShowManualKey,
  userState,
} from './handlers/twoFactor';
import {
  handleDepositMenu,
  handleDepositChain,
  handleCheckBalance,
  handleCheckAllBalances,
  handleApproveDeposit,
  handleConfirmDeposit,
} from './handlers/deposit';
import {
  handleSettingsMenu,
  handleShowSecretKey,
  handleDeleteKeyMessage,
  handleChangeDefaultAmount,
  handleSetDefaultAmount,
  handleCustomAmountInput,
  settingsAmountState,
  settingsSlippageState,
  handleChangeSlippage,
  handleSetSlippage,
  handleCustomSlippageInput,
} from './handlers/settings';
import {
  handleOutcomeSelection,
  handleTradeConfirm,
  handleTradeCancel,
  handleTradeAmountInput,
  tradeState,
  handleLimitTradeInput,
  handleLimitConfirm,
  handleLimitCancel,
  limitTradeState,
} from './handlers/trade';
import {
  handleOpenPositionsFull,
  handlePositionView,
  handlePositionSell,
  handlePositionBuy,
  handlePositionSellPct,
  handlePositionTradeInput,
  handlePositionCancel,
  handlePositionExecuteSell,
  handlePositionExecuteBuy,
  handlePositionStopLoss,
  handlePositionExecuteStopLoss,
  handlePositionPnl,
  handlePositionPnlShare,
  positionTradeState,
} from './handlers/positionTrade';
import {
  handleWithdrawMenu,
  handleWithdrawChain,
  handleWithdrawToken,
  handleWithdrawCancel,
  handleWithdrawTextInput,
  withdrawState,
} from './handlers/withdraw';
import {
  handleReferralHub,
  handleReferralClaim,
} from './handlers/referral';
import {
  handleCashbackPage,
  handleCashbackClaim,
} from './handlers/cashback';
import {
  handleCopyCommand,
  handleCopyList,
  startCopyAdd,
  handleCopyAddInput,
  handleCopyCancel,
  handleCopyClose,
  handleCopyConfirmAdd,
  handleSmartCopyStart,
  handleCopyStopAllAction,
  handleCopyStartAll,
  handleCopyHistory,
  copyAddState,
  copyEditState,
  handleCopyEditInput,
  handleCopyManage,
  handleCopyShare,
  // 9-step add flow handlers
  handleAddMethodFixed,
  handleAddMethodExact,
  handleAddMethodPct,
  handleAddMethodPortfolio,
  handleAddSlippage,
  handleAddSlippageCustom,
  handleAddSkipMaxMarket,
  handleAddOddsPreset,
  handleAddOddsSkip,
  handleAddOddsCustom,
  handleAddSlType,
  handleAddTpType,
  handleAddBehavior,
  handleAddBack,
  // Manage page handlers
  handleCopyTaskById,
  handleCopyTaskByAddr,
  handleManageToggle,
  handleManageStart,
  handleManagePause,
  handleManageMute,
  handleManageBuyMethod,
  handleManageCopySide,
  handleManageEditPrompt,
  handleManageClear,
  handleManageDelete,
  handleManageDeleteExecute,
  handleManageRename,
  handleManageSlPrompt,
  handleManageSlTypePct,
  handleManageSlTypeFix,
  handleManageTpPrompt,
  handleManageTpTypePct,
  handleManageTpTypeFix,
  // List page extras
  handleCopyRemovePrompt,
  handleCopyRemoveExecute,
  handleCopyDeleteAllConfirm,
  handleCopyDeleteAllExecute,
} from './handlers/copyTrade';
import { startCopyTradeMonitor } from '../services/copyTrade';

export class TelegramBot {
  private bot: Telegraf;

  constructor() {
    this.bot = new Telegraf(config.telegram.botToken);
    this.setupMiddleware();
    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupMiddleware(): void {
    // Logging middleware
    this.bot.use(async (ctx, next) => {
      const start = Date.now();
      const userId = ctx.from?.id;
      const username = ctx.from?.username || 'unknown';

      try {
        await next();
        const duration = Date.now() - start;
        logger.info(`Request from @${username} (${userId}) processed in ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - start;
        logger.error(`Error processing request from @${username} (${userId}) after ${duration}ms:`, error);
        throw error;
      }
    });

    // Rate limiting could be added here in the future
  }

  private setupHandlers(): void {
    // Command handlers
    this.bot.command('start', handleStart);
    this.bot.command('help', handleHelp);
    this.bot.command('wallet', handleWallet);

    // Quick-access slash commands
    this.bot.command('portfolio', handlePortfolio);
    this.bot.command('positions', (ctx) => handleOpenPositions(ctx, 1));
    this.bot.command('orders', (ctx) => handleOpenOrders(ctx, 1));
    this.bot.command('deposit', handleDepositMenu);
    this.bot.command('settings', handleSettingsMenu);
    this.bot.command('markets', handleShowCategories);
    this.bot.command('traders', (ctx) => handleSmartWallets(ctx));

    // Alias / shortcut commands
    this.bot.command('home',         handleBackToMenu);
    this.bot.command('trade',        handleShowCategories);
    this.bot.command('trending',     (ctx) => handleCategorySelection(ctx, 'trending'));
    this.bot.command('smartwallet',  (ctx) => handleSmartWallets(ctx));
    this.bot.command('copytrade',    async (ctx) => handleCopyCommand(ctx, undefined));
    this.bot.command('limitorders',  (ctx) => handleOpenOrders(ctx, 1));
    this.bot.command('history',      (ctx) => handleClosedPositions(ctx, 1));

    // Instant info commands
    this.bot.command('pnl', handlePnl);
    this.bot.command('price', async (ctx) => {
      const text = 'message' in ctx.update && 'text' in ctx.update.message
        ? ctx.update.message.text as string : '';
      const keyword = text.replace(/^\/price\s*/i, '').trim();
      await handlePriceCommand(ctx, keyword);
    });

    // /follow <address> → alias for /copy add <address>
    this.bot.command('follow', async (ctx) => {
      const text = 'message' in ctx.update && 'text' in ctx.update.message
        ? ctx.update.message.text as string : '';
      const addr = text.replace(/^\/follow\s*/i, '').trim();
      await handleCopyCommand(ctx, addr ? `add ${addr}` : 'add');
    });


    // ── Dev tool: extract custom emoji IDs from any forwarded/typed message ──
    // Usage: forward a message containing custom emojis, or send one directly.
    // Bot replies with each emoji's document ID so you can hardcode them.
    this.bot.command('emojiid', async (ctx) => {
      const msg = ctx.message;
      // Check the message itself OR the forwarded source
      const entities: any[] =
        (msg as any).entities ??
        (msg as any).caption_entities ??
        [];

      const found = entities
        .filter((e: any) => e.type === 'custom_emoji')
        .map((e: any) => {
          const text: string = (msg as any).text ?? (msg as any).caption ?? '';
          // Extract the fallback char at the entity's offset
          const chars = [...text]; // split on codepoints
          const offset = e.offset ?? 0;
          const fallback = chars.slice(offset, offset + e.length).join('');
          return `\`${e.custom_emoji_id}\`  →  ${fallback}`;
        });

      if (found.length === 0) {
        await ctx.reply(
          '❌ *No custom emojis found.*\n\n' +
          'Forward or send a message that contains Telegram Premium custom emojis, ' +
          'then reply to it with `/emojiid`.\n\n' +
          '_Tip: open the emoji panel → Premium tab → tap any animated emoji to insert it._',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await ctx.reply(
        `✅ <b>Found ${found.length} custom emoji(s):</b>\n\n` +
        found.map((line: string) => line.replace(/\*/g, '').replace(/`/g, '')).join('\n') +
        '\n\n<i>Copy the IDs above and share them to have them baked into the bot.</i>',
        { parse_mode: 'HTML' }
      );
    });

    // Admin commands
    this.bot.command('stats', handleStats);
    this.bot.command('users', (ctx) => handleUsers(ctx, 1));
    this.bot.command('reset_me', handleResetMe);
    this.bot.command('referral', handleReferralHub);
    this.bot.command('copy', async (ctx) => {
      // Extract argument after /copy
      const text = 'message' in ctx.update && 'text' in ctx.update.message
        ? ctx.update.message.text as string
        : '';
      const arg = text.replace(/^\/copy\s*/, '').trim() || undefined;
      await handleCopyCommand(ctx, arg);
    });

    // Group membership check callback (used during new user onboarding)
    this.bot.action('check_membership', handleCheckMembership);

    // Callback query handlers for buttons
    this.bot.action('show_categories', handleShowCategories);
    this.bot.action('back_to_menu', handleBackToMenu);
    this.bot.action('show_wallet', async (ctx) => await handleSmartWallets(ctx));

    // Discover Traders paginated list: sw_{page}_{cat}_{sort}
    this.bot.action(/^sw_(\d+)_(\w+)_(\w+)$/, async (ctx) => {
      await handleSmartWallets(ctx, ctx.match[2], ctx.match[3], parseInt(ctx.match[1], 10));
    });
    // Category filter: sw_fc_{cat}_{sort}
    this.bot.action(/^sw_fc_(\w+)_(\w+)$/, async (ctx) => {
      await handleSwCategoryFilter(ctx, ctx.match[1], ctx.match[2]);
    });
    // Sort filter: sw_fs_{cat}_{sort}
    this.bot.action(/^sw_fs_(\w+)_(\w+)$/, async (ctx) => {
      await handleSwSortFilter(ctx, ctx.match[1], ctx.match[2]);
    });
    this.bot.action('wallet_page', handleWalletPage);
    this.bot.action('portfolio', handlePortfolio);
    this.bot.action('search_markets', handleSearchPrompt);
    this.bot.action('noop', (ctx) => ctx.answerCbQuery()); // No-op for page indicator

    // Crypto subcategory handlers
    this.bot.action('category_crypto_sub', handleCryptoCategory);
    this.bot.action('crypto_updown', handleUpDownCrypto);
    this.bot.action(/^updown_refresh_(.+)$/, async (ctx) => {
      await handleUpDownMarketDetail(ctx, ctx.match[1], true);
    });

    // Sports subcategory handlers
    this.bot.action('category_sports_sub', handleSportsCategory);
    this.bot.action('sports_live', (ctx) => handleLiveSports(ctx, 1));
    this.bot.action(/^sports_live_(\d+)$/, async (ctx) => {
      await handleLiveSports(ctx, parseInt(ctx.match[1]));
    });
    // Category selection handlers
    this.bot.action(/^category_(.+)$/, async (ctx) => {
      const category = ctx.match[1];
      await handleCategorySelection(ctx, category, 1);
    });

    // Numbered event buttons inside a category page: evp_{category}_{page}_{idx}
    this.bot.action(/^evp_(.+)_(\d+)_(\d+)$/, async (ctx) => {
      const category = ctx.match[1];
      const page = parseInt(ctx.match[2], 10);
      const idx  = parseInt(ctx.match[3], 10);
      await handleEventFromPage(ctx, category, page, idx);
    });

    // Pagination handler
    this.bot.action(/^page_(.+)_(\d+)$/, async (ctx) => {
      const category = ctx.match[1];
      const page = parseInt(ctx.match[2], 10);
      await handleCategorySelection(ctx, category, page);
    });

    // Refresh category handler - clears cache and reloads
    this.bot.action(/^refresh_category_(.+)$/, async (ctx) => {
      const category = ctx.match[1];
      await handleRefreshCategory(ctx, category, 1);
    });

    // Market details handler
    this.bot.action(/^market_(.+)$/, async (ctx) => {
      const marketId = ctx.match[1];
      await handleMarketDetails(ctx, marketId);
    });

    // Search result event button: sev_<eventId>
    this.bot.action(/^sev_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery('Loading...');
      const { handleEventDetails } = await import('./handlers/markets');
      await handleEventDetails(ctx, ctx.match[1]);
    });

    // Event detail market pagination: evd_mkt_{eventId}_{page}[_{backCat}_{backPage}]
    this.bot.action(/^evd_mkt_(\d+)_(\d+)(?:_([a-z0-9-]+)_(\d+))?$/, async (ctx) => {
      await ctx.answerCbQuery();
      const { handleEventDetails } = await import('./handlers/markets');
      const backCategory = ctx.match[3] || undefined;
      const backPage     = ctx.match[4] ? parseInt(ctx.match[4], 10) : 1;
      await handleEventDetails(ctx, ctx.match[1], parseInt(ctx.match[2], 10), backCategory, backPage);
    });

    // Portfolio handlers
    this.bot.action(/^portfolio_open_(\d+)$/, async (ctx) => {
      const page = parseInt(ctx.match[1], 10);
      await handleOpenPositions(ctx, page);
    });

    this.bot.action(/^portfolio_orders_(\d+)$/, async (ctx) => {
      const page = parseInt(ctx.match[1], 10);
      await handleOpenOrders(ctx, page);
    });

    // Cancel single order: confirm → execute
    this.bot.action(/^cancel_ord_confirm_(\d+)_(\d+)$/, async (ctx) => {
      await handleCancelOrderConfirm(ctx, parseInt(ctx.match[1], 10), parseInt(ctx.match[2], 10));
    });
    this.bot.action(/^cancel_ord_do_(\d+)_(\d+)$/, async (ctx) => {
      await handleCancelOrderExecute(ctx, parseInt(ctx.match[1], 10), parseInt(ctx.match[2], 10));
    });

    // Cancel all orders: confirm → execute
    this.bot.action('cancel_all_confirm',    handleCancelAllConfirm);
    this.bot.action('cancel_all_do',         handleCancelAllExecute);
    this.bot.action('close_all_pos_confirm', handleCloseAllConfirm);
    this.bot.action('close_all_pos_do',      handleCloseAllExecute);

    this.bot.action(/^portfolio_closed_(\d+)$/, async (ctx) => {
      const page = parseInt(ctx.match[1], 10);
      await handleClosedPositions(ctx, page);
    });

    this.bot.action(/^portfolio_all_(\d+)$/, async (ctx) => {
      const page = parseInt(ctx.match[1], 10);
      await handleAllTransactions(ctx, page);
    });

    // Position full list
    this.bot.action('portfolio_open_full', handleOpenPositionsFull);

    // Position actions: view / sell / buy
    this.bot.action(/^pos_view_(\d+)$/, async (ctx) => {
      await handlePositionView(ctx, parseInt(ctx.match[1], 10));
    });
    this.bot.action(/^pos_sell_(\d+)$/, async (ctx) => {
      await handlePositionSell(ctx, parseInt(ctx.match[1], 10));
    });
    this.bot.action(/^pos_buy_(\d+)$/, async (ctx) => {
      await handlePositionBuy(ctx, parseInt(ctx.match[1], 10));
    });

    // Quick % sell (pos_pct_idx_pct)
    this.bot.action(/^pos_pct_(\d+)_(\d+)$/, async (ctx) => {
      await handlePositionSellPct(ctx, parseInt(ctx.match[1], 10), parseInt(ctx.match[2], 10));
    });

    // Position PNL
    this.bot.action(/^pos_pnl_(\d+)$/, async (ctx) => {
      await handlePositionPnl(ctx, parseInt(ctx.match[1], 10));
    });
    this.bot.action(/^pos_pnl_share_(\d+)$/, async (ctx) => {
      await handlePositionPnlShare(ctx, parseInt(ctx.match[1], 10));
    });

    // Execute / cancel
    this.bot.action('pos_execute_sell', handlePositionExecuteSell);
    this.bot.action('pos_execute_buy', handlePositionExecuteBuy);
    this.bot.action('pos_execute_sl', handlePositionExecuteStopLoss);
    this.bot.action('pos_cancel', handlePositionCancel);

    // Stop loss trigger
    this.bot.action(/^pos_sl_(\d+)$/, async (ctx) => {
      await handlePositionStopLoss(ctx, parseInt(ctx.match[1], 10));
    });

    // PNL handlers
    this.bot.action('pnl_alltime', handlePnl);
    this.bot.action('portfolio_pnl', handlePortfolioPnl);
    this.bot.action('pnl_share_alltime', async (ctx) => await handlePnlShare(ctx, 'alltime'));
    this.bot.action('pnl_share_portfolio', async (ctx) => await handlePnlShare(ctx, 'portfolio'));

    // Settings handlers
    this.bot.action('settings_menu', handleSettingsMenu);
    this.bot.action('settings_show_key', handleShowSecretKey);
    this.bot.action('settings_delete_key_msg', handleDeleteKeyMessage);
    this.bot.action('settings_change_amount', handleChangeDefaultAmount);
    this.bot.action('settings_amount_10',  async (ctx) => await handleSetDefaultAmount(ctx, 10));
    this.bot.action('settings_amount_25',  async (ctx) => await handleSetDefaultAmount(ctx, 25));
    this.bot.action('settings_amount_50',  async (ctx) => await handleSetDefaultAmount(ctx, 50));
    this.bot.action('settings_amount_100', async (ctx) => await handleSetDefaultAmount(ctx, 100));
    this.bot.action('settings_change_slippage', handleChangeSlippage);
    this.bot.action('settings_slippage_05', async (ctx) => await handleSetSlippage(ctx, 0.5));
    this.bot.action('settings_slippage_1',  async (ctx) => await handleSetSlippage(ctx, 1.0));
    this.bot.action('settings_slippage_2',  async (ctx) => await handleSetSlippage(ctx, 2.0));
    this.bot.action('settings_slippage_5',  async (ctx) => await handleSetSlippage(ctx, 5.0));


    // Trade handlers
    // F1: Short callbacks trade_oc_yes/trade_oc_no (full conditionId in callback exceeded 64 bytes)
    this.bot.action(/^trade_oc_/, async (ctx) => {
      if ('data' in ctx.callbackQuery) {
        await handleOutcomeSelection(ctx, ctx.callbackQuery.data);
      }
    });
    this.bot.action('trade_confirm_do', async (ctx) => {
      await handleTradeConfirm(ctx);
    });
    this.bot.action('trade_cancel', handleTradeCancel);

    // Limit order handlers
    this.bot.action('limit_confirm', handleLimitConfirm);
    this.bot.action('limit_cancel',  handleLimitCancel);

    // Admin handlers
    this.bot.action('admin_refresh_stats', handleRefreshStats);
    this.bot.action('admin_view_users', handleViewUsersButton);
    this.bot.action('admin_back_to_stats', handleBackToStats);
    this.bot.action('admin_reset_me_confirmed', handleResetMeConfirmed);
    this.bot.action('admin_reset_me_cancel', handleResetMeCancel);

    // Admin user management
    this.bot.action(/^admin_users_page_(\d+)$/, async (ctx) => {
      const page = parseInt(ctx.match[1], 10);
      await handleUsersPage(ctx, page);
    });

    this.bot.action(/^admin_delete_user_(.+)$/, async (ctx) => {
      const userId = ctx.match[1];
      await handleDeleteUserConfirm(ctx, userId);
    });

    this.bot.action(/^admin_delete_confirmed_(.+)$/, async (ctx) => {
      const userId = ctx.match[1];
      await handleDeleteUserConfirmed(ctx, userId);
    });

    // 2FA handlers
    this.bot.action('2fa_menu', handleTwoFactorMenu);
    this.bot.action('2fa_enable', handleEnableTwoFactor);
    this.bot.action('2fa_disable', handleDisableTwoFactor);
    this.bot.action('2fa_backup_codes', handleShowBackupCodes);
    this.bot.action('2fa_show_key', handleShowManualKey);

    // Deposit button opens the wallet page directly (Bridge API addresses are shown there)
    this.bot.action('deposit_menu', handleWalletPage);
    this.bot.action('deposit_polygon', (ctx) => handleDepositChain(ctx, 'polygon'));
    this.bot.action('deposit_ethereum', (ctx) => handleDepositChain(ctx, 'ethereum'));
    this.bot.action('deposit_solana', (ctx) => handleDepositChain(ctx, 'solana'));
    this.bot.action('deposit_check_all', handleCheckAllBalances);

    // Deposit balance check handlers
    this.bot.action(/^deposit_balance_(.+)$/, async (ctx) => {
      const chain = ctx.match[1] as 'polygon' | 'ethereum' | 'solana';
      await handleCheckBalance(ctx, chain);
    });

    // Deposit "I sent funds" handler
    this.bot.action(/^deposit_sent_(.+)$/, async (ctx) => {
      const chain = ctx.match[1] as 'polygon' | 'ethereum' | 'solana';
      await handleCheckBalance(ctx, chain);
    });

    // Deposit approve handler
    this.bot.action(/^deposit_approve_(.+)$/, async (ctx) => {
      const chain = ctx.match[1] as 'polygon' | 'ethereum' | 'solana';
      await handleApproveDeposit(ctx, chain);
    });

    // Deposit confirm handler
    this.bot.action(/^deposit_confirm_(.+)$/, async (ctx) => {
      const chain = ctx.match[1] as 'polygon' | 'ethereum' | 'solana';
      await handleConfirmDeposit(ctx, chain);
    });

    // Referral handlers
    this.bot.action('referral_hub', handleReferralHub);
    this.bot.action('referral_claim', handleReferralClaim);
    this.bot.action('cashback_page', handleCashbackPage);
    this.bot.action('cashback_claim', handleCashbackClaim);

    // ── Copy Trading ───────────────────────────────────────────────────────
    this.bot.action('copy_list', handleCopyList);
    this.bot.action('copy_start_add', startCopyAdd);
    this.bot.action('copy_cancel', handleCopyCancel);
    this.bot.action('copy_close', handleCopyClose);
    this.bot.action('copy_confirm_add', handleCopyConfirmAdd);
    this.bot.action('copy_stop_all', handleCopyStopAllAction);
    this.bot.action('copy_start_all', handleCopyStartAll);

    // List page: Remove / Delete All
    this.bot.action('copy_remove_prompt', handleCopyRemovePrompt);
    this.bot.action(/^copy_remove_(?!prompt)(.+)$/, async (ctx) => {
      await handleCopyRemoveExecute(ctx, ctx.match[1]);
    });
    this.bot.action('copy_delete_all_confirm', handleCopyDeleteAllConfirm);
    this.bot.action('copy_delete_all_do', handleCopyDeleteAllExecute);

    // Activity
    this.bot.action(/^copy_history_(\d+)$/, async (ctx) => {
      await handleCopyHistory(ctx, parseInt(ctx.match[1], 10));
    });

    // Smart Wallet quick-copy
    this.bot.action(/^smart_copy_(0x[a-f0-9]{40})$/i, async (ctx) => {
      await handleSmartCopyStart(ctx, ctx.match[1].toLowerCase());
    });

    // ── 9-Step Add Flow ─────────────────────────────────────────────────────
    this.bot.action('copy_add_back', handleAddBack);

    // Step 3: Buy method
    this.bot.action('copy_add_method_fixed', handleAddMethodFixed);
    this.bot.action('copy_add_method_exact', handleAddMethodExact);
    this.bot.action('copy_add_method_pct', handleAddMethodPct);
    this.bot.action('copy_add_method_portfolio', handleAddMethodPortfolio);

    // Step 4: Max per market skip
    this.bot.action('copy_add_skip_max_market', handleAddSkipMaxMarket);

    // Step 5: Slippage presets
    this.bot.action('copy_add_slip_2', async (ctx) => handleAddSlippage(ctx, 2));
    this.bot.action('copy_add_slip_5', async (ctx) => handleAddSlippage(ctx, 5));
    this.bot.action('copy_add_slip_10', async (ctx) => handleAddSlippage(ctx, 10));
    this.bot.action('copy_add_slip_custom', handleAddSlippageCustom);

    // Step 6: Odds filter
    this.bot.action('copy_add_odds_10_90', async (ctx) => handleAddOddsPreset(ctx, 10, 90));
    this.bot.action('copy_add_odds_20_80', async (ctx) => handleAddOddsPreset(ctx, 20, 80));
    this.bot.action('copy_add_odds_custom', handleAddOddsCustom);
    this.bot.action('copy_add_odds_skip', handleAddOddsSkip);

    // Step 7: Stop Loss
    this.bot.action('copy_add_sl_pct', async (ctx) => handleAddSlType(ctx, 'pct'));
    this.bot.action('copy_add_sl_fixed', async (ctx) => handleAddSlType(ctx, 'fixed'));
    this.bot.action('copy_add_sl_skip', async (ctx) => handleAddSlType(ctx, 'skip'));

    // Step 8: Take Profit
    this.bot.action('copy_add_tp_pct', async (ctx) => handleAddTpType(ctx, 'pct'));
    this.bot.action('copy_add_tp_fixed', async (ctx) => handleAddTpType(ctx, 'fixed'));
    this.bot.action('copy_add_tp_skip', async (ctx) => handleAddTpType(ctx, 'skip'));

    // Step 9: Trade Behavior
    this.bot.action('copy_add_behavior_buys', async (ctx) => handleAddBehavior(ctx, 'buys_only'));
    this.bot.action('copy_add_behavior_both', async (ctx) => handleAddBehavior(ctx, 'buys_sells'));
    this.bot.action('copy_add_behavior_counter', async (ctx) => handleAddBehavior(ctx, 'counter'));

    // ── Per-task manage page ────────────────────────────────────────────────
    this.bot.action(/^copy_task_(.+)$/, async (ctx) => {
      const id = ctx.match[1];
      // Check if it's a byaddr_ prefix
      if (id.startsWith('byaddr_')) {
        await handleCopyTaskByAddr(ctx, id.slice(7));
      } else {
        await handleCopyTaskById(ctx, id);
      }
    });

    // Manage page: Start / Pause
    this.bot.action(/^cpm_start_(.+)$/, async (ctx) => handleManageStart(ctx, ctx.match[1]));
    this.bot.action(/^cpm_pause_(.+)$/, async (ctx) => handleManagePause(ctx, ctx.match[1]));

    // Manage page: Buy method switches
    this.bot.action(/^cpm_bm_fixed_(.+)$/, async (ctx) => handleManageBuyMethod(ctx, ctx.match[1], 'fixed'));
    this.bot.action(/^cpm_bm_exact_(.+)$/, async (ctx) => handleManageBuyMethod(ctx, ctx.match[1], 'exact'));
    this.bot.action(/^cpm_bm_pct_(.+)$/, async (ctx) => handleManageBuyMethod(ctx, ctx.match[1], 'pct'));
    this.bot.action(/^cpm_bm_port_(.+)$/, async (ctx) => handleManageBuyMethod(ctx, ctx.match[1], 'port'));

    // Manage page: Toggle booleans
    this.bot.action(/^cpm_tgl_buys_(.+)$/, async (ctx) => handleManageToggle(ctx, ctx.match[1], 'buys'));
    this.bot.action(/^cpm_tgl_sells_(.+)$/, async (ctx) => handleManageToggle(ctx, ctx.match[1], 'sells'));
    this.bot.action(/^cpm_tgl_bos_(.+)$/, async (ctx) => handleManageToggle(ctx, ctx.match[1], 'bos'));
    this.bot.action(/^cpm_tgl_ct_(.+)$/, async (ctx) => handleManageToggle(ctx, ctx.match[1], 'ct'));
    this.bot.action(/^cpm_tgl_limit_(.+)$/, async (ctx) => handleManageToggle(ctx, ctx.match[1], 'limit'));

    // Manage page: Copy side cycle
    this.bot.action(/^cpm_copyside_(.+)$/, async (ctx) => handleManageCopySide(ctx, ctx.match[1]));

    // Manage page: Mute toggle
    this.bot.action(/^cpm_mute_(.+)$/, async (ctx) => handleManageMute(ctx, ctx.match[1]));

    // Manage page: Edit fields (prompt for text input)
    this.bot.action(/^cpm_amount_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_amount',
        `💰 <b>Edit Amount</b>\n\nEnter the new amount:`);
    });
    this.bot.action(/^cpm_slip_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_slippage',
        `⚡ <b>Edit Slippage</b>\n\nEnter slippage % (0.1–50):`);
    });
    this.bot.action(/^cpm_maxbuy_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_max_buy',
        `📈 <b>Max Buy Amount</b>\n\nEnter max USD per single BUY:`);
    });
    this.bot.action(/^cpm_minbuy_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_min_buy',
        `📉 <b>Min Buy Amount</b>\n\nEnter min USD per single BUY:`);
    });
    this.bot.action(/^cpm_maxspm_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_max_spend_market',
        `💸 <b>Max Spend Per Market</b>\n\nEnter max USD per market:`);
    });
    this.bot.action(/^cpm_maxspt_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_max_spend_total',
        `💸 <b>Max Spend Total</b>\n\nEnter lifetime max spend in USD:`);
    });
    this.bot.action(/^cpm_daily_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_daily_limit',
        `📅 <b>Daily Spend Limit</b>\n\nEnter max USD per day:`);
    });
    this.bot.action(/^cpm_mintrig_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_min_trigger',
        `⬇️ <b>Min Trigger Price</b>\n\nOnly copy if price ≥ X¢. Enter cents (0–100):`);
    });
    this.bot.action(/^cpm_maxtrig_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_max_trigger',
        `⬆️ <b>Max Trigger Price</b>\n\nOnly copy if price ≤ X¢. Enter cents (0–100):`);
    });
    this.bot.action(/^cpm_maxdays_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_max_days',
        `📅 <b>Max Days Out</b>\n\nSkip markets expiring in more than N days. Enter number:`);
    });
    this.bot.action(/^cpm_minliq_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_min_liq',
        `💧 <b>Min Liquidity</b>\n\nEnter minimum liquidity in USD:`);
    });
    this.bot.action(/^cpm_minvol_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_min_vol',
        `📊 <b>Min Volume</b>\n\nEnter minimum volume in USD:`);
    });
    this.bot.action(/^cpm_prmin_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_price_min',
        `⬇️ <b>Min Price Filter</b>\n\nSkip trades priced below X¢. Enter cents (0–100):`);
    });
    this.bot.action(/^cpm_prmax_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_price_max',
        `⬆️ <b>Max Price Filter</b>\n\nSkip trades priced above X¢. Enter cents (0–100):`);
    });
    this.bot.action(/^cpm_cats_(.+)$/, async (ctx) => {
      await handleManageEditPrompt(ctx, ctx.match[1], 'awaiting_categories',
        `📁 <b>Categories</b>\n\nEnter comma-separated category names, or type "all" for all:`);
    });

    // Manage page: Rename / Delete
    this.bot.action(/^cpm_rename_(.+)$/, async (ctx) => handleManageRename(ctx, ctx.match[1]));
    this.bot.action(/^cpm_del_(.+)$/, async (ctx) => handleManageDelete(ctx, ctx.match[1]));
    this.bot.action(/^cpm_deldo_(.+)$/, async (ctx) => handleManageDeleteExecute(ctx, ctx.match[1]));

    // Manage page: Clear fields
    this.bot.action(/^cpm_clear_(.+?)_(.+)$/, async (ctx) => {
      await handleManageClear(ctx, ctx.match[2], ctx.match[1]);
    });

    // Manage page: SL / TP prompts
    this.bot.action(/^cpm_sl_(.+)$/, async (ctx) => handleManageSlPrompt(ctx, ctx.match[1]));
    this.bot.action(/^cpm_tp_(.+)$/, async (ctx) => handleManageTpPrompt(ctx, ctx.match[1]));
    this.bot.action(/^cpm_sltype_pct_(.+)$/, async (ctx) => handleManageSlTypePct(ctx, ctx.match[1]));
    this.bot.action(/^cpm_sltype_fix_(.+)$/, async (ctx) => handleManageSlTypeFix(ctx, ctx.match[1]));
    this.bot.action(/^cpm_tptype_pct_(.+)$/, async (ctx) => handleManageTpTypePct(ctx, ctx.match[1]));
    this.bot.action(/^cpm_tptype_fix_(.+)$/, async (ctx) => handleManageTpTypeFix(ctx, ctx.match[1]));

    // Legacy deep-link manage/share via address
    this.bot.action(/^copy_manage_(0x[a-f0-9]{40})$/i, async (ctx) => {
      await handleCopyManage(ctx, ctx.match[1].toLowerCase());
    });
    this.bot.action(/^copy_share_(0x[a-f0-9]{40})$/i, async (ctx) => {
      await handleCopyShare(ctx, ctx.match[1].toLowerCase());
    });

    // Withdraw handlers
    this.bot.action('withdraw_menu', handleWithdrawMenu);
    this.bot.action(/^wd_chain_(.+)$/, async (ctx) => {
      await handleWithdrawChain(ctx, ctx.match[1]);
    });
    this.bot.action(/^wd_token_(.+)$/, async (ctx) => {
      await handleWithdrawToken(ctx, ctx.match[1]);
    });
    this.bot.action('wd_cancel', handleWithdrawCancel);

    // Handle text messages (for 2FA code input, etc.)
    this.bot.on('text', async (ctx: Context) => {
      const text = 'message' in ctx.update && 'text' in ctx.update.message
        ? ctx.update.message.text
        : '';

      const telegramId = ctx.from?.id.toString();
      if (!telegramId) return;

      // Detect Polymarket event link in any message — handle immediately regardless of state
      const polySlug = detectPolymarketLink(text);
      if (polySlug) {
        await handleLinkInput(ctx, polySlug);
        return;
      }


      // Active trade flows always take priority over settings amount input
      // Check if user is in a trade flow (waiting for amount input)
      // Uses async Redis-backed state to survive bot restarts
      const tradeStateData = await tradeState.get(telegramId);
      if (tradeStateData) {
        settingsAmountState.delete(telegramId); // discard stale settings state
        await handleTradeAmountInput(ctx, text);
        return;
      }

      // Check if user is in a limit order flow (price or amount input)
      const ltState = await limitTradeState.get(telegramId);
      if (ltState) {
        settingsAmountState.delete(telegramId);
        const consumed = await handleLimitTradeInput(ctx, text);
        if (consumed) return;
      }

      // Check if user is in a position trade flow (sell/buy from positions)
      const posStateData = await positionTradeState.get(telegramId);
      if (posStateData) {
        settingsAmountState.delete(telegramId);
        await handlePositionTradeInput(ctx, text);
        return;
      }

      // Check if user is in a copy-add flow (entering address or amount)
      // Copy trade flows checked BEFORE withdraw — withdraw deletes user messages,
      // and a stale withdraw state must never intercept copy trade text input.
      const copyState = await copyAddState.get(telegramId);
      if (copyState) {
        withdrawState.delete(telegramId); // clear stale withdraw state
        const consumed = await handleCopyAddInput(ctx, text);
        if (consumed) return;
      }

      // Check if user is in a copy-edit flow (manage page edits)
      const copyEdit = await copyEditState.get(telegramId);
      if (copyEdit) {
        withdrawState.delete(telegramId);
        const consumed = await handleCopyEditInput(ctx, text);
        if (consumed) return;
      }

      // Check if user is in a withdraw flow (entering address or amount)
      const wdStateData = await withdrawState.get(telegramId);
      if (wdStateData) {
        settingsAmountState.delete(telegramId);
        await handleWithdrawTextInput(ctx, text);
        return;
      }

      // Check if user is typing a custom default trade amount (lower priority than active flows)
      const amountStateData = settingsAmountState.get(telegramId);
      if (amountStateData) {
        if (Date.now() - amountStateData.timestamp > 10 * 60 * 1000) {
          settingsAmountState.delete(telegramId);
        } else {
          await handleCustomAmountInput(ctx, text);
          return;
        }
      }

      // Check if user is typing a custom slippage tolerance value
      const slippageStateData = settingsSlippageState.get(telegramId);
      if (slippageStateData) {
        if (Date.now() - slippageStateData.timestamp > 10 * 60 * 1000) {
          settingsSlippageState.delete(telegramId);
        } else {
          await handleCustomSlippageInput(ctx, text);
          return;
        }
      }

      // Check if user is in a 2FA flow
      const state = userState.get(telegramId);

      if (state) {
        // Check if state expired (10 minutes)
        if (Date.now() - state.timestamp > 10 * 60 * 1000) {
          userState.delete(telegramId);
        } else {
          // Handle based on action
          if (state.action === '2fa_setup' && /^\d{6}$/.test(text)) {
            // 6-digit code for 2FA setup
            await handleVerifyTwoFactorSetup(ctx, text);
            userState.delete(telegramId);
            return;
          } else if (state.action === '2fa_disable' && /^\d{6}$/.test(text)) {
            // 6-digit code for 2FA disable
            await handleConfirmDisableTwoFactor(ctx, text);
            userState.delete(telegramId);
            return;
          } else if (state.action === '2fa_disable' && /^[A-F0-9]{8}$/.test(text.toUpperCase())) {
            // Backup code for 2FA disable
            await handleConfirmDisableTwoFactor(ctx, text);
            userState.delete(telegramId);
            return;
          }
        }
      }

      // Global keyword search — runs only when no active user flow consumed the text
      const hasActiveFlow =
        tradeState.has(telegramId) ||
        limitTradeState.has(telegramId) ||
        positionTradeState.has(telegramId) ||
        withdrawState.has(telegramId) ||
        copyAddState.has(telegramId) ||
        copyEditState.has(telegramId) ||
        settingsAmountState.has(telegramId) ||
        settingsSlippageState.has(telegramId) ||
        userState.has(telegramId);
      if (!text.startsWith('/') && !hasActiveFlow) {
        await handleKeywordSearch(ctx, text);
        return;
      }

      // Handle unknown commands
      if (text.startsWith('/')) {
        await ctx.reply(
          '❌ Unknown command.\n\n' +
          'Use /help to see available commands.',
          { parse_mode: 'Markdown' }
        );
      }
    });
  }

  private setupErrorHandling(): void {
    // Handle bot errors
    this.bot.catch((error: any, ctx: Context) => {
      // Ignore "message is not modified" errors - these are expected
      // when users click the same button multiple times
      if (error.message?.includes('message is not modified')) {
        logger.debug('Ignored: message is not modified (user clicked same button)');
        return;
      }

      logger.error('Bot error:', error);

      try {
        ctx.reply(
          '❌ An unexpected error occurred. Please try again later.\n\n' +
          'If the problem persists, please contact support.'
        );
      } catch (replyError) {
        logger.error('Error sending error message to user:', replyError);
      }
    });

    // Handle process errors
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      this.shutdown();
    });
  }

  public async start(): Promise<void> {
    try {
      logger.info('Starting Telegram bot...');

      // Enable graceful stop
      process.once('SIGINT', () => this.shutdown());
      process.once('SIGTERM', () => this.shutdown());

      // Start bot (launch() resolves only when bot stops — do NOT await)
      this.bot.launch().catch((err: any) => {
        logger.error('Bot launch error:', err);
      });

      // Wait briefly for Telegraf to initialize its polling loop
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Start copy trade monitor (polls every 30s)
      startCopyTradeMonitor(async (telegramId: string, message: string) => {
        try {
          await this.bot.telegram.sendMessage(telegramId, message, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        } catch (err: any) {
          logger.warn(`[copy] Failed to send notification to ${telegramId}: ${err?.message}`);
        }
      });

      logger.info('Telegram bot started successfully');
    } catch (error) {
      logger.error('Failed to start bot:', error);
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    logger.info('Shutting down Telegram bot...');

    try {
      const { stopCopyTradeMonitor } = await import('../services/copyTrade');
      stopCopyTradeMonitor();
      this.bot.stop('SIGINT');
      logger.info('Telegram bot stopped');
    } catch (error) {
      logger.error('Error stopping bot:', error);
    }
  }

  public getBot(): Telegraf {
    return this.bot;
  }
}
