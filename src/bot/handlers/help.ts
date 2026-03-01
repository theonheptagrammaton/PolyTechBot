import { Context } from 'telegraf';
import { getUserByTelegramId, isUserAdmin } from '../../services/user';

export async function handleHelp(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();

  if (!telegramId) {
    await ctx.reply('❌ Could not identify your Telegram account.');
    return;
  }

  const user = await getUserByTelegramId(telegramId);

  const helpMessage =
    '📚 <b>PolyTech Sniper Bot — Help</b>\n\n' +

    '─────────────────────────\n' +
    '⚡ <b>SLASH COMMANDS</b>\n' +
    '─────────────────────────\n\n' +

    '<b>/start</b>\n' +
    'Create your Polymarket wallet or open the main menu.\n' +
    'Also works with deep links (market share, copy trade invite, referral links).\n' +
    'You can also <b>paste any Polymarket URL</b> directly into the chat at any time — the bot will detect it and open the market instantly.\n\n' +

    '<b>/wallet</b>\n' +
    'Open the wallet page. View your USDC balance, deposit addresses (Polygon, Ethereum, Solana) and withdraw funds.\n\n' +

    '<b>/portfolio</b>\n' +
    'Full portfolio overview — active positions, closed positions, unrealized and realized P&L totals.\n\n' +

    '<b>/pnl</b>\n' +
    'Quick P&L snapshot — unrealized gain/loss on open positions, realized gain/loss on closed positions, and a combined total.\n\n' +

    '<b>/positions</b>\n' +
    'List all your active open positions with current prices, entry cost, and individual P&L.\n\n' +

    '<b>/orders</b>\n' +
    'List all your open limit orders. Tap any order to cancel it individually, or cancel all at once.\n\n' +

    '<b>/deposit</b>\n' +
    'Deposit funds — shows deposit addresses for Polygon, Ethereum, Solana and lets you check pending balances.\n\n' +

    '<b>/markets</b>\n' +
    'Browse Polymarket categories — Trending, Politics, Crypto, Sports, Business, Pop Culture, All Markets.\n\n' +

    '<b>/price &lt;keyword&gt;</b>\n' +
    'Search active markets by keyword and show live prices.\n' +
    '<i>Example: /price bitcoin</i>\n' +
    'You can also just <b>type any keyword without a command</b> — the bot searches markets automatically.\n\n' +

    '<b>/traders</b>\n' +
    'Discover top Polymarket traders sorted by P&L, Win Rate, or Volume. Tap Copy to instantly follow one.\n\n' +

    '<b>/settings</b>\n' +
    'Account settings — 2FA, default trade amount, slippage tolerance, and your secret key.\n\n' +

    '<b>/referral</b>\n' +
    'Access the referral hub. Generate your referral link, see how many users you\'ve invited, track your pending & total earnings, and claim your commission rewards.\n\n' +

    '<b>/copy</b> — Copy Trading\n' +
    'Mirror the trades of top Polymarket traders automatically.\n\n' +
    '  <b>/copy</b> <i>or</i> <b>/copy list</b>\n' +
    '  → Show all traders you are currently following with status breakdown (✅ executed | ❌ failed | ⏭ skipped)\n\n' +
    '  <b>/copy add</b>\n' +
    '  → Start interactive setup to follow a new trader:\n' +
    '     1. Enter wallet address\n' +
    '     2. Optionally set a nickname\n' +
    '     3. Choose mode:\n' +
    '        • <b>Fixed</b> — spend a fixed USDC amount per trade\n' +
    '        • <b>Multiplier</b> — spend a % of the trader\'s position size\n' +
    '     4. Set take profit % (optional)\n' +
    '     5. Set stop loss % (optional)\n\n' +
    '  <b>/copy add &lt;address&gt;</b>\n' +
    '  → Skip address entry, jump straight to mode selection.\n\n' +
    '  <b>/follow &lt;address&gt;</b>\n' +
    '  → Shorthand alias for <b>/copy add &lt;address&gt;</b>.\n\n' +
    '  <b>/copy stop &lt;address&gt;</b>\n' +
    '  → Stop following a specific trader and deactivate their subscription.\n\n' +
    '  <b>/copy stopall</b>\n' +
    '  → Stop and remove all active copy trading subscriptions.\n\n' +
    '  <b>/copy pause</b>\n' +
    '  → Temporarily pause all subscriptions (no new trades copied until resumed).\n\n' +
    '  <b>/copy resume</b>\n' +
    '  → Resume all paused subscriptions.\n\n' +
    '  <b>/copy history</b> <i>or</i> <b>/copy history &lt;N&gt;</b>\n' +
    '  → View your last N copied trades (default: 10, max recommended: 50).\n\n' +
    '  <b>Advanced management</b> (accessible from the copy list via buttons):\n' +
    '  Rename trader, set price range filter, daily/single trade limits, per-trader slippage, mute notifications, change mode (Fixed ↔ Multiplier), share invite link.\n\n' +

    '<b>/help</b>\n' +
    'Show this help message.\n\n' +

    '─────────────────────────\n' +
    '⚠️ <b>Security Reminder</b>\n' +
    '─────────────────────────\n' +
    'Never share your private key with anyone.\n' +
    'PolyTech staff will never ask for it.';

  const adminSection = user && isUserAdmin(user)
    ? '\n\n─────────────────────────\n' +
      '🔐 <b>ADMIN COMMANDS</b>\n' +
      '─────────────────────────\n\n' +
      '<b>/stats</b>\n' +
      'Display bot-wide statistics: total users, trades executed, active copy subscriptions, and more.\n\n' +
      '<b>/users</b>\n' +
      'Paginated list of all registered users. Tap any user to view details or delete their account.\n\n' +
      '<b>/reset_me</b>\n' +
      'Delete your own admin account (requires confirmation). Blocked if you are the last admin.\n\n' +
      '<b>/emojiid</b>\n' +
      'Send or forward a message containing Telegram Premium custom emojis — the bot replies with each emoji\'s document ID so you can hardcode them in the bot source.'
    : '';

  await ctx.reply(helpMessage + adminSection, { parse_mode: 'HTML' });
}
