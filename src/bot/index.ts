import { Telegraf, Context } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { handleStart, handleCheckMembership, _pendingWalletCreations } from './handlers/start';
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
  handleUserDetail,
  handleEditRefRate,
  handleRefRateInput,
  handleResetRefRate,
  adminRefRateState,
  handleSearchUser,
  handleSearchUserInput,
  adminSearchUserState,
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
  handleSwTimePeriodFilter,
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
  handlePositionRedeem,
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
  handleReferralEditName,
  handleReferralEditInput,
  referralEditState,
} from './handlers/referral';
import {
  handleCashbackPage,
  handleCashbackClaim,
} from './handlers/cashback';
import { handleAutoStrategies } from './handlers/autoStrategies';
import {
  handleUpDownCommand,
  handleUpDownList,
  handleStartAdd as handleUpDownStartAdd,
  handleStartAll as handleUpDownStartAll,
  handleStopAll as handleUpDownStopAll,
  handleDeleteAllConfirm as handleUpDownDeleteAllConfirm,
  handleDeleteAllExecute as handleUpDownDeleteAllExecute,
  handleRemovePrompt as handleUpDownRemovePrompt,
  handleRemoveExecute as handleUpDownRemoveExecute,
  handleHistory as handleUpDownHistory,
  handleClose as handleUpDownClose,
  handleConfirmAdd as handleUpDownConfirmAdd,
  handleAddCoin as handleUpDownAddCoin,
  handleAddTimeframe as handleUpDownAddTimeframe,
  handleAddDirection as handleUpDownAddDirection,
  handleAddAmountPreset as handleUpDownAddAmountPreset,
  handleAddTimeRangePreset as handleUpDownAddTimeRangePreset,
  handleAddUpPricePreset as handleUpDownAddUpPricePreset,
  handleAddPriceChangePreset as handleUpDownAddPriceChangePreset,
  handleAddAdvanced as handleUpDownAddAdvanced,
  handleAdvOrderType as handleUpDownAdvOrderType,
  handleAdvMaxRounds as handleUpDownAdvMaxRounds,
  handleAdvSlippage as handleUpDownAdvSlippage,
  handleAdvTpType as handleUpDownAdvTpType,
  handleAdvSlType as handleUpDownAdvSlType,
  handleAdvSkip as handleUpDownAdvSkip,
  handleAdvTtlPreset as handleUpDownAdvTtlPreset,
  handleAdvBackReview as handleUpDownAdvBackReview,
  handleAdvEditField as handleUpDownAdvEditField,
  handleAdvTpClear as handleUpDownAdvTpClear,
  handleAdvSlClear as handleUpDownAdvSlClear,
  handleAddInput as handleUpDownAddInput,
  handleEditInput as handleUpDownEditInput,
  handleManage as handleUpDownManage,
  handleManageStart as handleUpDownManageStart,
  handleManagePause as handleUpDownManagePause,
  handleManageToggleDirection as handleUpDownManageDirection,
  handleManageToggleNotify as handleUpDownManageNotify,
  handleManageOrderType as handleUpDownManageOT,
  handleManageEditPrompt as handleUpDownManageEditPrompt,
  handleManageDelete as handleUpDownManageDelete,
  handleManageDeleteExecute as handleUpDownManageDeleteExec,
  handleManageRename as handleUpDownManageRename,
  handleManageTpPrompt as handleUpDownManageTpPrompt,
  handleManageSlPrompt as handleUpDownManageSlPrompt,
  handleManageTpTypePct as handleUpDownManageTpTypePct,
  handleManageTpTypeFix as handleUpDownManageTpTypeFix,
  handleManageSlTypePct as handleUpDownManageSlTypePct,
  handleManageSlTypeFix as handleUpDownManageSlTypeFix,
  handleManageTpClear as handleUpDownManageTpClear,
  handleManageSlClear as handleUpDownManageSlClear,
  handleTemplateList as handleUpDownTemplateList,
  handleTemplateUse as handleUpDownTemplateUse,
  updownAddState,
  updownEditState,
} from './handlers/updown';
import {
  handleBondCommand,
  handleBondList,
  handleBondStartAdd,
  handleBondStartAll,
  handleBondStopAll,
  handleBondDeleteAllConfirm,
  handleBondDeleteAllExecute,
  handleBondRemovePrompt,
  handleBondRemoveExecute,
  handleBondHistory,
  handleBondClose,
  handleBondConfirmAdd,
  handleBondManage,
  handleBondAddInput,
  handleBondEditInput,
  handleAddProbPreset,
  handleAddProbCustom,
  handleAddHoursPreset,
  handleAddHoursCustom,
  handleAddConcPreset,
  handleAddConcCustom,
  handleAddMarketType,
  handleAddAdvanced,
  handleAddAdvSkip,
  handleAddSidePreset,
  handleAdvBackReview,
  handleAdvEdit,
  handleManageStart as handleBondManageStart,
  handleManagePause as handleBondManagePause,
  handleManageToggleSports,
  handleManageToggleCrypto,
  handleManageToggleNotify,
  handleManageCycleSide,
  handleManageEditPrompt as handleBondManageEditPrompt,
  handleManageDelete as handleBondManageDelete,
  handleManageDeleteExecute as handleBondManageDeleteExec,
  handleManageRename as handleBondManageRename,
  bondAddState,
  bondEditState,
} from './handlers/bond';
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
  handleCategoriesPage,
  handleCategoryToggle,
  handleCategoriesClear,
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
import { startCopyTradeMonitor, NotificationExtra } from '../services/copyTrade';
import { startBondMonitor, stopBondMonitor } from '../services/bond';
import { startUpDownMonitor, stopUpDownMonitor } from '../services/updown';
import { prepareImageBuffer } from '../utils/telegram';
import { enqueueNotification, startNotificationWorker, closeNotificationWorker } from '../utils/notificationQueue';

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

    // Onboarding guard — block all interactions for unverified users
    this.bot.use(async (ctx, next) => {
      const telegramId = ctx.from?.id?.toString();
      if (!telegramId) return next();

      // Always allow /start command and membership check
      const isStart = 'message' in ctx.update &&
        'text' in (ctx.update as any).message &&
        (ctx.update as any).message.text?.startsWith('/start');
      const isMembershipCheck = 'callback_query' in ctx.update &&
        (ctx.update as any).callback_query?.data === 'check_membership';

      if (isStart || isMembershipCheck) return next();

      // Block if wallet creation is pending (user hasn't joined the group yet)
      if (_pendingWalletCreations.has(telegramId)) {
        if ('callback_query' in ctx.update) await ctx.answerCbQuery().catch(() => {});
        await ctx.reply(
          "⏳ Please join the community first, then press <b>✅ I've Joined, Check</b> to activate your account.",
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Block if user has no wallet (never completed onboarding)
      // Fail open on DB errors — a transient DB outage must not lock out all users
      const { getUserByTelegramId } = await import('../services/user');
      let user: Awaited<ReturnType<typeof getUserByTelegramId>> | null = null;
      let dbError = false;
      try {
        user = await getUserByTelegramId(telegramId);
      } catch {
        dbError = true;
      }
      if (!dbError && !user) {
        if ('callback_query' in ctx.update) await ctx.answerCbQuery().catch(() => {});
        await ctx.reply('👋 Please use /start to create your account first.');
        return;
      }

      return next();
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

    // Bond trading command
    this.bot.command('bond', handleBondCommand);

    // Up-Down auto trade command
    this.bot.command('afk', handleUpDownCommand);

    // Group membership check callback (used during new user onboarding)
    this.bot.action('check_membership', handleCheckMembership);

    // Callback query handlers for buttons
    this.bot.action('show_categories', handleShowCategories);
    this.bot.action('back_to_menu', handleBackToMenu);
    this.bot.action('show_wallet', async (ctx) => await handleSmartWallets(ctx));

    // Discover Traders paginated list: sw_{page}_{cat}_{sort}_{period}
    this.bot.action(/^sw_(\d+)_([^_]+)_([^_]+)(?:_([^_]*))?$/, async (ctx) => {
      await handleSmartWallets(ctx, ctx.match[2], ctx.match[3], parseInt(ctx.match[1], 10), ctx.match[4] || 'month');
    });
    // Category filter: sw_fc_{cat}_{sort}_{period}
    this.bot.action(/^sw_fc_([^_]+)_([^_]+)_([^_]+)$/, async (ctx) => {
      await handleSwCategoryFilter(ctx, ctx.match[1], ctx.match[2], ctx.match[3]);
    });
    // Sort filter: sw_fs_{cat}_{sort}_{period}
    this.bot.action(/^sw_fs_([^_]+)_([^_]+)_([^_]+)$/, async (ctx) => {
      await handleSwSortFilter(ctx, ctx.match[1], ctx.match[2], ctx.match[3]);
    });
    // Time period filter: sw_ft_{cat}_{sort}_{period}
    this.bot.action(/^sw_ft_([^_]+)_([^_]+)_([^_]+)$/, async (ctx) => {
      await handleSwTimePeriodFilter(ctx, ctx.match[1], ctx.match[2], ctx.match[3]);
    });
    this.bot.action('wallet_page', handleWalletPage);
    this.bot.action('portfolio', handlePortfolio);
    this.bot.action('search_markets', handleSearchPrompt);
    this.bot.action('noop', (ctx) => ctx.answerCbQuery()); // No-op for page indicator
    this.bot.action('close_notif', async (ctx) => {
      await ctx.answerCbQuery().catch(() => {});
      await ctx.deleteMessage().catch(() => {});
    });

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

    // Position actions: view / sell / buy / redeem
    this.bot.action(/^pos_view_(\d+)$/, async (ctx) => {
      await handlePositionView(ctx, parseInt(ctx.match[1], 10));
    });
    this.bot.action(/^pos_sell_(\d+)$/, async (ctx) => {
      await handlePositionSell(ctx, parseInt(ctx.match[1], 10));
    });
    this.bot.action(/^pos_buy_(\d+)$/, async (ctx) => {
      await handlePositionBuy(ctx, parseInt(ctx.match[1], 10));
    });
    this.bot.action(/^pos_redeem_(\d+)$/, async (ctx) => {
      await handlePositionRedeem(ctx, parseInt(ctx.match[1], 10));
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
    this.bot.action('admin_search_user', handleSearchUser);

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

    this.bot.action(/^admin_user_detail_(.+)$/, async (ctx) => {
      const userId = ctx.match[1];
      // Clear ref rate edit state if returning to detail
      const tid = ctx.from?.id.toString();
      if (tid) adminRefRateState.delete(tid);
      await handleUserDetail(ctx, userId);
    });

    this.bot.action(/^admin_edit_ref_rate_(.+)$/, async (ctx) => {
      const userId = ctx.match[1];
      await handleEditRefRate(ctx, userId);
    });

    this.bot.action(/^admin_reset_ref_rate_(.+)$/, async (ctx) => {
      const userId = ctx.match[1];
      await handleResetRefRate(ctx, userId);
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
    this.bot.action('referral_hub', (ctx) => {
      // Cancel edit state if returning to hub
      const tid = ctx.from?.id.toString();
      if (tid) referralEditState.delete(tid);
      return handleReferralHub(ctx);
    });
    this.bot.action('referral_claim', handleReferralClaim);
    this.bot.action('referral_edit_name', handleReferralEditName);
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
      await handleCategoriesPage(ctx, ctx.match[1]);
    });
    this.bot.action(/^cpm_cat_tog_([a-z0-9]+)_(.+)$/, async (ctx) => {
      await handleCategoryToggle(ctx, ctx.match[1], ctx.match[2]);
    });
    this.bot.action(/^cpm_cats_clear_(.+)$/, async (ctx) => {
      await handleCategoriesClear(ctx, ctx.match[1]);
    });

    // Manage page: Rename / Delete
    this.bot.action(/^cpm_rename_(.+)$/, async (ctx) => handleManageRename(ctx, ctx.match[1]));
    this.bot.action(/^cpm_del_(.+)$/, async (ctx) => handleManageDelete(ctx, ctx.match[1]));
    this.bot.action(/^cpm_deldo_(.+)$/, async (ctx) => handleManageDeleteExecute(ctx, ctx.match[1]));

    // Manage page: Clear fields
    this.bot.action(/^cpm_clear_([^_]+)_(.+)$/, async (ctx) => {
      await handleManageClear(ctx, ctx.match[1], ctx.match[2]);
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

    // ── Auto Strategies / Bond Trading ─────────────────────────────────────
    this.bot.action('auto_strategies', handleAutoStrategies);
    this.bot.action('bond_list', handleBondList);
    this.bot.action('bond_start_add', handleBondStartAdd);
    this.bot.action('bond_start_all', handleBondStartAll);
    this.bot.action('bond_stop_all', handleBondStopAll);
    this.bot.action('bond_del_all_cfm', handleBondDeleteAllConfirm);
    this.bot.action('bond_del_all_do', handleBondDeleteAllExecute);
    this.bot.action('bond_remove_prompt', handleBondRemovePrompt);
    this.bot.action('bond_close', handleBondClose);
    this.bot.action('bond_add_confirm', handleBondConfirmAdd);
    this.bot.action('bond_add_advanced', handleAddAdvanced);
    this.bot.action('bond_add_adv_skip', handleAddAdvSkip);

    // Bond remove single
    this.bot.action(/^bond_rm_(.+)$/, async (ctx) => {
      await handleBondRemoveExecute(ctx, ctx.match[1]);
    });

    // Bond history
    this.bot.action(/^bond_history_(\d+)$/, async (ctx) => {
      await handleBondHistory(ctx, parseInt(ctx.match[1], 10));
    });

    // Bond task manage
    this.bot.action(/^bond_task_(.+)$/, async (ctx) => {
      await handleBondManage(ctx, ctx.match[1]);
    });

    // Bond add flow: probability presets
    this.bot.action('bond_add_prob_90', async (ctx) => handleAddProbPreset(ctx, 90));
    this.bot.action('bond_add_prob_93', async (ctx) => handleAddProbPreset(ctx, 93));
    this.bot.action('bond_add_prob_95', async (ctx) => handleAddProbPreset(ctx, 95));
    this.bot.action('bond_add_prob_97', async (ctx) => handleAddProbPreset(ctx, 97));
    this.bot.action('bond_add_prob_custom', handleAddProbCustom);

    // Bond add flow: hours presets
    this.bot.action('bond_add_hours_12', async (ctx) => handleAddHoursPreset(ctx, 12));
    this.bot.action('bond_add_hours_24', async (ctx) => handleAddHoursPreset(ctx, 24));
    this.bot.action('bond_add_hours_48', async (ctx) => handleAddHoursPreset(ctx, 48));
    this.bot.action('bond_add_hours_72', async (ctx) => handleAddHoursPreset(ctx, 72));
    this.bot.action('bond_add_hours_custom', handleAddHoursCustom);

    // Bond add flow: concurrent presets
    this.bot.action('bond_add_conc_2', async (ctx) => handleAddConcPreset(ctx, 2));
    this.bot.action('bond_add_conc_5', async (ctx) => handleAddConcPreset(ctx, 5));
    this.bot.action('bond_add_conc_10', async (ctx) => handleAddConcPreset(ctx, 10));
    this.bot.action('bond_add_conc_custom', handleAddConcCustom);

    // Bond add flow: market type
    this.bot.action('bond_add_mkt_none', async (ctx) => handleAddMarketType(ctx, 'none'));
    this.bot.action('bond_add_mkt_sports', async (ctx) => handleAddMarketType(ctx, 'sports'));
    this.bot.action('bond_add_mkt_crypto', async (ctx) => handleAddMarketType(ctx, 'crypto'));
    this.bot.action('bond_add_mkt_both', async (ctx) => handleAddMarketType(ctx, 'both'));

    // Bond add flow: outcome side
    this.bot.action('bond_add_side_auto', async (ctx) => handleAddSidePreset(ctx, 'auto'));
    this.bot.action('bond_add_side_yes', async (ctx) => handleAddSidePreset(ctx, 'yes'));
    this.bot.action('bond_add_side_no', async (ctx) => handleAddSidePreset(ctx, 'no'));

    // Bond add flow: advanced menu
    this.bot.action('bond_adv_back_review', handleAdvBackReview);
    this.bot.action(/^bond_adv_edit_(.+)$/, async (ctx) => handleAdvEdit(ctx, ctx.match[1]));

    // Bond manage page actions
    this.bot.action(/^bpm_start_(.+)$/, async (ctx) => handleBondManageStart(ctx, ctx.match[1]));
    this.bot.action(/^bpm_pause_(.+)$/, async (ctx) => handleBondManagePause(ctx, ctx.match[1]));
    this.bot.action(/^bpm_sports_(.+)$/, async (ctx) => handleManageToggleSports(ctx, ctx.match[1]));
    this.bot.action(/^bpm_crypto_(.+)$/, async (ctx) => handleManageToggleCrypto(ctx, ctx.match[1]));
    this.bot.action(/^bpm_notify_(.+)$/, async (ctx) => handleManageToggleNotify(ctx, ctx.match[1]));
    this.bot.action(/^bpm_side_(.+)$/, async (ctx) => handleManageCycleSide(ctx, ctx.match[1]));

    // Bond manage: edit field prompts
    this.bot.action(/^bpm_budget_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_budget',
        `💰 <b>Edit Daily Budget</b>\n\nEnter new daily budget in USD:`);
    });
    this.bot.action(/^bpm_amount_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_amount',
        `💵 <b>Edit Amount Per Trade</b>\n\nEnter new amount in USD:`);
    });
    this.bot.action(/^bpm_pmin_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_min_prob',
        `🎯 <b>Edit Min Probability</b>\n\nEnter new min probability (50–99):`);
    });
    this.bot.action(/^bpm_pmax_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_max_prob',
        `🎯 <b>Edit Max Probability</b>\n\nEnter new max probability (50–99):`);
    });
    this.bot.action(/^bpm_window_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_window',
        `⏰ <b>Edit Time Window</b>\n\nEnter hours (1–168):`);
    });
    this.bot.action(/^bpm_maxpos_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_max_pos',
        `📊 <b>Edit Max Positions</b>\n\nEnter number (1–50):`);
    });
    this.bot.action(/^bpm_slip_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_slippage',
        `⚡ <b>Edit Slippage</b>\n\nEnter slippage % (0.1–50):`);
    });
    this.bot.action(/^bpm_interval_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_interval',
        `📡 <b>Edit Scan Interval</b>\n\nEnter minutes (1–10):`);
    });
    this.bot.action(/^bpm_liq_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_min_liq',
        `💧 <b>Edit Min Liquidity</b>\n\nEnter minimum liquidity in USD:`);
    });
    this.bot.action(/^bpm_vol_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_min_vol',
        `📊 <b>Edit Min Volume</b>\n\nEnter minimum volume in USD:`);
    });
    this.bot.action(/^bpm_mktmax_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_mkt_max',
        `💸 <b>Max Spend Per Market</b>\n\nEnter max USD per market:`);
    });
    this.bot.action(/^bpm_totmax_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_total_max',
        `💸 <b>Max Total Spend</b>\n\nEnter lifetime max spend in USD:`);
    });
    this.bot.action(/^bpm_loss_(.+)$/, async (ctx) => {
      await handleBondManageEditPrompt(ctx, ctx.match[1], 'awaiting_loss_limit',
        `📅 <b>Max Daily Loss</b>\n\nEnter max daily loss in USD:`);
    });

    // Bond manage: rename / delete
    // IMPORTANT: Register deldo BEFORE del — /^bpm_del_(.+)$/ would greedily match "bpm_deldo_..."
    this.bot.action(/^bpm_rename_(.+)$/, async (ctx) => handleBondManageRename(ctx, ctx.match[1]));
    this.bot.action(/^bpm_deldo_(.+)$/, async (ctx) => handleBondManageDeleteExec(ctx, ctx.match[1]));
    this.bot.action(/^bpm_del_(.+)$/, async (ctx) => handleBondManageDelete(ctx, ctx.match[1]));

    // ── Up-Down Auto Trade ──────────────────────────────────────────────────
    this.bot.action('updown_list', handleUpDownList);
    this.bot.action('ud_start_add', handleUpDownStartAdd);
    this.bot.action('ud_start_all', handleUpDownStartAll);
    this.bot.action('ud_stop_all', handleUpDownStopAll);
    this.bot.action('ud_del_all_cfm', handleUpDownDeleteAllConfirm);
    this.bot.action('ud_del_all_do', handleUpDownDeleteAllExecute);
    this.bot.action('ud_remove_prompt', handleUpDownRemovePrompt);
    this.bot.action('ud_close', handleUpDownClose);
    this.bot.action('ud_add_confirm', handleUpDownConfirmAdd);
    this.bot.action('ud_add_advanced', handleUpDownAddAdvanced);
    this.bot.action('ud_adv_skip', handleUpDownAdvSkip);
    this.bot.action('ud_adv_back_review', handleUpDownAdvBackReview);
    this.bot.action(/^ud_adv_edit_(.+)$/, async (ctx) => handleUpDownAdvEditField(ctx, ctx.match[1]));
    this.bot.action('ud_adv_tp_clear', handleUpDownAdvTpClear);
    this.bot.action('ud_adv_sl_clear', handleUpDownAdvSlClear);

    // Up-Down: remove single
    this.bot.action(/^ud_rm_(.+)$/, async (ctx) => {
      await handleUpDownRemoveExecute(ctx, ctx.match[1]);
    });

    // Up-Down: history
    this.bot.action(/^ud_history_(\d+)$/, async (ctx) => {
      await handleUpDownHistory(ctx, parseInt(ctx.match[1], 10));
    });

    // Up-Down: task manage
    this.bot.action(/^ud_task_(.+)$/, async (ctx) => {
      await handleUpDownManage(ctx, ctx.match[1]);
    });

    // Up-Down: add flow — coin
    this.bot.action(/^ud_add_coin_(.+)$/, async (ctx) => {
      await handleUpDownAddCoin(ctx, ctx.match[1]);
    });

    // Up-Down: add flow — timeframe
    this.bot.action(/^ud_add_tf_(.+)$/, async (ctx) => {
      await handleUpDownAddTimeframe(ctx, ctx.match[1]);
    });

    // Up-Down: add flow — direction
    this.bot.action('ud_add_dir_up', async (ctx) => handleUpDownAddDirection(ctx, 'up'));
    this.bot.action('ud_add_dir_dn', async (ctx) => handleUpDownAddDirection(ctx, 'down'));

    // Up-Down: add flow — amount presets
    this.bot.action('ud_add_amt_10', async (ctx) => handleUpDownAddAmountPreset(ctx, 10));
    this.bot.action('ud_add_amt_25', async (ctx) => handleUpDownAddAmountPreset(ctx, 25));
    this.bot.action('ud_add_amt_50', async (ctx) => handleUpDownAddAmountPreset(ctx, 50));
    this.bot.action('ud_add_amt_100', async (ctx) => handleUpDownAddAmountPreset(ctx, 100));

    // Up-Down: add flow — time range presets
    this.bot.action('ud_add_tr_full', async (ctx) => handleUpDownAddTimeRangePreset(ctx, 'full'));
    this.bot.action('ud_add_tr_late', async (ctx) => handleUpDownAddTimeRangePreset(ctx, 'late'));
    this.bot.action('ud_add_tr_early', async (ctx) => handleUpDownAddTimeRangePreset(ctx, 'early'));
    this.bot.action('ud_add_tr_mid', async (ctx) => handleUpDownAddTimeRangePreset(ctx, 'mid'));

    // Up-Down: add flow — UP price presets
    this.bot.action('ud_add_up_any', async (ctx) => handleUpDownAddUpPricePreset(ctx, 'any'));
    this.bot.action('ud_add_up_hi', async (ctx) => handleUpDownAddUpPricePreset(ctx, 'hi'));
    this.bot.action('ud_add_up_lo', async (ctx) => handleUpDownAddUpPricePreset(ctx, 'lo'));
    this.bot.action('ud_add_up_mid', async (ctx) => handleUpDownAddUpPricePreset(ctx, 'mid'));

    // Up-Down: add flow — price change presets
    this.bot.action('ud_add_pc_any', async (ctx) => handleUpDownAddPriceChangePreset(ctx, 'any'));
    this.bot.action('ud_add_pc_pump', async (ctx) => handleUpDownAddPriceChangePreset(ctx, 'pump'));
    this.bot.action('ud_add_pc_dump', async (ctx) => handleUpDownAddPriceChangePreset(ctx, 'dump'));

    // Up-Down: advanced — order type
    this.bot.action('ud_adv_ot_market', async (ctx) => handleUpDownAdvOrderType(ctx, 'market'));
    this.bot.action('ud_adv_ot_limit', async (ctx) => handleUpDownAdvOrderType(ctx, 'limit'));

    // Up-Down: advanced — max rounds presets
    this.bot.action('ud_adv_mr_5', async (ctx) => handleUpDownAdvMaxRounds(ctx, 5));
    this.bot.action('ud_adv_mr_10', async (ctx) => handleUpDownAdvMaxRounds(ctx, 10));
    this.bot.action('ud_adv_mr_25', async (ctx) => handleUpDownAdvMaxRounds(ctx, 25));
    this.bot.action('ud_adv_mr_50', async (ctx) => handleUpDownAdvMaxRounds(ctx, 50));

    // Up-Down: advanced — slippage presets
    this.bot.action('ud_adv_sl_2', async (ctx) => handleUpDownAdvSlippage(ctx, 2));
    this.bot.action('ud_adv_sl_5', async (ctx) => handleUpDownAdvSlippage(ctx, 5));
    this.bot.action('ud_adv_sl_10', async (ctx) => handleUpDownAdvSlippage(ctx, 10));

    // Up-Down: advanced — TP/SL type
    this.bot.action('ud_adv_tp_pct', async (ctx) => handleUpDownAdvTpType(ctx, 'pct'));
    this.bot.action('ud_adv_tp_price', async (ctx) => handleUpDownAdvTpType(ctx, 'price'));
    this.bot.action('ud_adv_sl_pct', async (ctx) => handleUpDownAdvSlType(ctx, 'pct'));
    this.bot.action('ud_adv_sl_price', async (ctx) => handleUpDownAdvSlType(ctx, 'price'));

    // Up-Down: advanced — TTL presets
    this.bot.action('ud_adv_ttl_30', async (ctx) => handleUpDownAdvTtlPreset(ctx, 30));
    this.bot.action('ud_adv_ttl_60', async (ctx) => handleUpDownAdvTtlPreset(ctx, 60));
    this.bot.action('ud_adv_ttl_120', async (ctx) => handleUpDownAdvTtlPreset(ctx, 120));

    // Up-Down: manage page actions
    this.bot.action(/^udm_start_(.+)$/, async (ctx) => handleUpDownManageStart(ctx, ctx.match[1]));
    this.bot.action(/^udm_pause_(.+)$/, async (ctx) => handleUpDownManagePause(ctx, ctx.match[1]));
    this.bot.action(/^udm_dir_(.+)$/, async (ctx) => handleUpDownManageDirection(ctx, ctx.match[1]));
    this.bot.action(/^udm_notify_(.+)$/, async (ctx) => handleUpDownManageNotify(ctx, ctx.match[1]));
    this.bot.action(/^udm_ot_(.+)$/, async (ctx) => handleUpDownManageOT(ctx, ctx.match[1]));

    // Up-Down: manage page — edit field prompts
    this.bot.action(/^udm_amt_(.+)$/, async (ctx) => {
      await handleUpDownManageEditPrompt(ctx, ctx.match[1], 'awaiting_amount',
        `💰 <b>Edit Amount</b>\n\nEnter new amount in USD:`);
    });
    this.bot.action(/^udm_slip_(.+)$/, async (ctx) => {
      await handleUpDownManageEditPrompt(ctx, ctx.match[1], 'awaiting_slippage',
        `⚡ <b>Edit Slippage</b>\n\nEnter slippage % (0.1–50):`);
    });
    this.bot.action(/^udm_time_(.+)$/, async (ctx) => {
      await handleUpDownManageEditPrompt(ctx, ctx.match[1], 'awaiting_time_range',
        `⏱ <b>Edit Time Range</b>\n\nEnter as mm:ss, mm:ss (e.g. 00:00, 14:55):`);
    });
    this.bot.action(/^udm_up_(.+)$/, async (ctx) => {
      await handleUpDownManageEditPrompt(ctx, ctx.match[1], 'awaiting_up_price',
        `📈 <b>Edit UP Price Range</b>\n\nEnter as min, max (e.g. 0.70, 0.90):`);
    });
    this.bot.action(/^udm_pc_(.+)$/, async (ctx) => {
      await handleUpDownManageEditPrompt(ctx, ctx.match[1], 'awaiting_price_change',
        `🪙 <b>Edit Spot Price Change</b>\n\nEnter as min, max in USD (e.g. -100, 9999):`);
    });
    this.bot.action(/^udm_rnd_(.+)$/, async (ctx) => {
      await handleUpDownManageEditPrompt(ctx, ctx.match[1], 'awaiting_rounds',
        `🔁 <b>Edit Max Rounds</b>\n\nEnter number (1–100):`);
    });
    this.bot.action(/^udm_ttl_(.+)$/, async (ctx) => {
      await handleUpDownManageEditPrompt(ctx, ctx.match[1], 'awaiting_limit_ttl',
        `⏳ <b>Edit Limit TTL</b>\n\nEnter seconds before auto-cancel (10–300):`);
    });

    // Up-Down: manage page — rename / delete
    // IMPORTANT: Register deldo BEFORE del — /^udm_del_(.+)$/ would greedily match "udm_deldo_..."
    this.bot.action(/^udm_rename_(.+)$/, async (ctx) => handleUpDownManageRename(ctx, ctx.match[1]));
    this.bot.action(/^udm_deldo_(.+)$/, async (ctx) => handleUpDownManageDeleteExec(ctx, ctx.match[1]));
    this.bot.action(/^udm_del_(.+)$/, async (ctx) => handleUpDownManageDelete(ctx, ctx.match[1]));

    // Up-Down: manage page — TP/SL
    this.bot.action(/^udm_tp_(.+)$/, async (ctx) => {
      // Distinguish type selection vs prompt
      const id = ctx.match[1];
      if (id.startsWith('pct_')) {
        await handleUpDownManageTpTypePct(ctx, id.slice(4));
      } else if (id.startsWith('fix_')) {
        await handleUpDownManageTpTypeFix(ctx, id.slice(4));
      } else if (id.startsWith('clr_')) {
        await handleUpDownManageTpClear(ctx, id.slice(4));
      } else {
        await handleUpDownManageTpPrompt(ctx, id);
      }
    });
    this.bot.action(/^udm_sl_(.+)$/, async (ctx) => {
      const id = ctx.match[1];
      if (id.startsWith('pct_')) {
        await handleUpDownManageSlTypePct(ctx, id.slice(4));
      } else if (id.startsWith('fix_')) {
        await handleUpDownManageSlTypeFix(ctx, id.slice(4));
      } else if (id.startsWith('clr_')) {
        await handleUpDownManageSlClear(ctx, id.slice(4));
      } else {
        await handleUpDownManageSlPrompt(ctx, id);
      }
    });

    // Up-Down: templates
    this.bot.action('udt_list', handleUpDownTemplateList);
    this.bot.action(/^udt_use_(.+)$/, async (ctx) => {
      await handleUpDownTemplateUse(ctx, ctx.match[1]);
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

      // Check if user is in a bond add flow
      const bondAdd = await bondAddState.get(telegramId);
      if (bondAdd) {
        const consumed = await handleBondAddInput(ctx, text);
        if (consumed) return;
      }

      // Check if user is in a bond edit flow
      const bondEdit = await bondEditState.get(telegramId);
      if (bondEdit) {
        const consumed = await handleBondEditInput(ctx, text);
        if (consumed) return;
      }

      // Check if user is in an updown add flow
      const udAdd = await updownAddState.get(telegramId);
      if (udAdd) {
        const consumed = await handleUpDownAddInput(ctx, text);
        if (consumed) return;
      }

      // Check if user is in an updown edit flow
      const udEdit = await updownEditState.get(telegramId);
      if (udEdit) {
        const consumed = await handleUpDownEditInput(ctx, text);
        if (consumed) return;
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
      const amountStateData = await settingsAmountState.get(telegramId);
      if (amountStateData) {
        await handleCustomAmountInput(ctx, text);
        return;
      }

      // Check if user is typing a custom slippage tolerance value
      const slippageStateData = await settingsSlippageState.get(telegramId);
      if (slippageStateData) {
        await handleCustomSlippageInput(ctx, text);
        return;
      }

      // Check if admin is searching for a user
      const searchData = await adminSearchUserState.get(telegramId);
      if (searchData) {
        await handleSearchUserInput(ctx, text);
        return;
      }

      // Check if admin is editing a user's referral rate
      const refRateData = await adminRefRateState.get(telegramId);
      if (refRateData) {
        await handleRefRateInput(ctx, text);
        return;
      }

      // Check if user is editing their referral name
      const refEditData = await referralEditState.get(telegramId);
      if (refEditData) {
        await handleReferralEditInput(ctx, text);
        return;
      }

      // Check if user is in a 2FA flow
      const state = await userState.get(telegramId);

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
        await bondAddState.hasAsync(telegramId) ||
        await bondEditState.hasAsync(telegramId) ||
        await updownAddState.hasAsync(telegramId) ||
        await updownEditState.hasAsync(telegramId) ||
        await settingsAmountState.hasAsync(telegramId) ||
        await settingsSlippageState.hasAsync(telegramId) ||
        await userState.hasAsync(telegramId) ||
        await referralEditState.hasAsync(telegramId) ||
        await adminRefRateState.hasAsync(telegramId);
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

      // Register bot commands (shows "/" menu in Telegram UI)
      await this.bot.telegram.setMyCommands([
        { command: 'start',       description: '🏠 Main menu' },
        { command: 'portfolio',   description: '📊 Portfolio overview' },
        { command: 'positions',   description: '📈 Active positions' },
        { command: 'orders',      description: '📋 Open limit orders' },
        { command: 'deposit',     description: '💰 Deposit funds' },
        { command: 'markets',     description: '🌍 Browse markets' },
        { command: 'traders',     description: '🧠 Smart traders leaderboard' },
        { command: 'copytrade',   description: '⚡ Copy trading' },
        { command: 'pnl',         description: '📉 PNL summary' },
        { command: 'price',       description: '💲 Get market price' },
        { command: 'settings',    description: '⚙️ Settings' },
        { command: 'help',        description: '❓ Help' },
      ]).catch((err: any) => logger.warn('setMyCommands failed:', err?.message));

      // Start bot — webhook if WEBHOOK_DOMAIN is set, else long polling (local dev)
      const webhookDomain = config.telegram.webhookDomain;
      if (webhookDomain) {
        const webhookPath = `/webhook/${config.telegram.botToken}`;
        this.bot.launch({
          webhook: {
            domain: webhookDomain,
            port: config.telegram.webhookPort ?? 8443,
            path: webhookPath,
            hookPath: webhookPath,
          },
        }).catch((err: any) => logger.error('Bot webhook error:', err));
        logger.info(`[bot] Webhook mode: ${webhookDomain}${webhookPath}`);
      } else {
        this.bot.launch().catch((err: any) => logger.error('Bot launch error (polling):', err));
        logger.info('[bot] Long polling mode (set WEBHOOK_DOMAIN for webhook)');
      }

      // Wait briefly for bot to initialize
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Start rate-limited notification worker (25 msg/s, retries on failure)
      const directSend = async (telegramId: string, message: string, extra?: NotificationExtra) => {
        try {
          if (extra?.imagePath) {
            const buf = await prepareImageBuffer(extra.imagePath);
            await this.bot.telegram.sendPhoto(
              telegramId,
              { source: buf },
              {
                caption: message,
                parse_mode: 'HTML',
                reply_markup: extra.buttons ? { inline_keyboard: extra.buttons } : undefined,
              } as any,
            );
          } else {
            await this.bot.telegram.sendMessage(telegramId, message, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              reply_markup: extra?.buttons ? { inline_keyboard: extra.buttons } : undefined,
            } as any);
          }
        } catch (err: any) {
          logger.warn(`[copy] Failed to send notification to ${telegramId}: ${err?.message}`);
          throw err; // re-throw so BullMQ can retry
        }
      };
      startNotificationWorker(directSend);

      // Start copy trade monitor — skip if running as separate worker container
      if (process.env.COPY_TRADE_WORKER !== 'external') {
        startCopyTradeMonitor(enqueueNotification);
      } else {
        logger.info('[bot] Copy trade monitor delegated to external worker container');
      }

      // Start bond trading monitor
      startBondMonitor((n) => {
        enqueueNotification(
          n.chatId,
          n.text,
          n.buttons ? { buttons: n.buttons } : undefined,
        );
      });

      // Start up-down auto trade monitor
      startUpDownMonitor((n) => {
        enqueueNotification(
          n.chatId,
          n.text,
          n.buttons ? { buttons: n.buttons } : undefined,
        );
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
      if (process.env.COPY_TRADE_WORKER !== 'external') {
        const { stopCopyTradeMonitor } = await import('../services/copyTrade');
        stopCopyTradeMonitor();
      }
      stopBondMonitor();
      stopUpDownMonitor();
      await closeNotificationWorker();
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
