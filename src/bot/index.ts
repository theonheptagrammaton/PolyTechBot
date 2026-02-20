import { Telegraf, Context } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { handleStart } from './handlers/start';
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
  handleMarketDetails,
  handleBackToMenu,
  handleShowWallet,
  handleRefreshCategory,
} from './handlers/markets';
import {
  handleWalletPage,
  handlePortfolio,
  handleWithdraw,
  handleOpenPositions,
  handleClosedPositions,
  handleAllTransactions,
} from './handlers/walletPage';
import {
  handleCryptoCategory,
  handleUpDownCrypto,
} from './handlers/cryptoMarkets';
import {
  handleSearchPrompt,
  handleSearchCommand,
  handleSearch,
} from './handlers/search';
import {
  handleTwoFactorMenu,
  handleEnableTwoFactor,
  handleVerifyTwoFactorSetup,
  handleDisableTwoFactor,
  handleConfirmDisableTwoFactor,
  handleShowBackupCodes,
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
} from './handlers/settings';
import {
  handleOutcomeSelection,
  handleTradeConfirm,
  handleTradeCancel,
  handleTradeAmountInput,
  tradeState,
} from './handlers/trade';

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
    this.bot.command('search', handleSearchCommand);

    // Admin commands
    this.bot.command('stats', handleStats);
    this.bot.command('users', (ctx) => handleUsers(ctx, 1));
    this.bot.command('reset_me', handleResetMe);

    // Callback query handlers for buttons
    this.bot.action('show_categories', handleShowCategories);
    this.bot.action('back_to_menu', handleBackToMenu);
    this.bot.action('show_wallet', handleShowWallet);
    this.bot.action('wallet_page', handleWalletPage);
    this.bot.action('portfolio', handlePortfolio);
    this.bot.action('withdraw', handleWithdraw);
    this.bot.action('search_markets', handleSearchPrompt);
    this.bot.action('noop', (ctx) => ctx.answerCbQuery()); // No-op for page indicator

    // Crypto subcategory handlers
    this.bot.action('category_crypto_sub', handleCryptoCategory);
    this.bot.action('crypto_updown', handleUpDownCrypto);

    // Category selection handlers
    this.bot.action(/^category_(.+)$/, async (ctx) => {
      const category = ctx.match[1];

      // Special handling for crypto - show subcategories
      if (category === 'crypto') {
        await handleCryptoCategory(ctx);
      } else {
        await handleCategorySelection(ctx, category, 1);
      }
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

    // Search pagination handler
    this.bot.action(/^search_page_(.+)_(\d+)$/, async (ctx) => {
      const keyword = ctx.match[1];
      const page = parseInt(ctx.match[2], 10);
      await handleSearch(ctx, keyword, page);
    });

    // Portfolio handlers
    this.bot.action(/^portfolio_open_(\d+)$/, async (ctx) => {
      const page = parseInt(ctx.match[1], 10);
      await handleOpenPositions(ctx, page);
    });

    this.bot.action(/^portfolio_closed_(\d+)$/, async (ctx) => {
      const page = parseInt(ctx.match[1], 10);
      await handleClosedPositions(ctx, page);
    });

    this.bot.action(/^portfolio_all_(\d+)$/, async (ctx) => {
      const page = parseInt(ctx.match[1], 10);
      await handleAllTransactions(ctx, page);
    });

    // Settings handlers
    this.bot.action('settings_menu', handleSettingsMenu);
    this.bot.action('settings_show_key', handleShowSecretKey);
    this.bot.action('settings_delete_key_msg', handleDeleteKeyMessage);
    this.bot.action('settings_change_amount', handleChangeDefaultAmount);
    this.bot.action('settings_amount_10', async (ctx) => await handleSetDefaultAmount(ctx, 10));
    this.bot.action('settings_amount_25', async (ctx) => await handleSetDefaultAmount(ctx, 25));
    this.bot.action('settings_amount_50', async (ctx) => await handleSetDefaultAmount(ctx, 50));
    this.bot.action('settings_amount_100', async (ctx) => await handleSetDefaultAmount(ctx, 100));

    // Trade handlers
    this.bot.action(/^trade_outcome_/, async (ctx) => {
      if ('data' in ctx.callbackQuery) {
        await handleOutcomeSelection(ctx, ctx.callbackQuery.data);
      }
    });
    this.bot.action(/^trade_confirm_/, async (ctx) => {
      if ('data' in ctx.callbackQuery) {
        await handleTradeConfirm(ctx, ctx.callbackQuery.data);
      }
    });
    this.bot.action('trade_cancel', handleTradeCancel);

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

    // Deposit handlers
    this.bot.action('deposit_menu', handleDepositMenu);
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

    // Handle text messages (for 2FA code input, etc.)
    this.bot.on('text', async (ctx: Context) => {
      const text = 'message' in ctx.update && 'text' in ctx.update.message
        ? ctx.update.message.text
        : '';

      const telegramId = ctx.from?.id.toString();
      if (!telegramId) return;

      // Check if user is in a trade flow (waiting for amount input)
      const tradeStateData = tradeState.get(telegramId);
      if (tradeStateData) {
        await handleTradeAmountInput(ctx, text);
        return;
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

      // Start bot
      await this.bot.launch();

      logger.info('Telegram bot started successfully');
    } catch (error) {
      logger.error('Failed to start bot:', error);
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    logger.info('Shutting down Telegram bot...');

    try {
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
