import { Context } from 'telegraf';
import { getUserByTelegramId, isUserAdmin } from '../../services/user';

export async function handleHelp(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();

  if (!telegramId) {
    await ctx.reply('❌ Could not identify your Telegram account.');
    return;
  }

  const user = await getUserByTelegramId(telegramId);

  let helpMessage =
    '📚 *PolyTech Sniper Bot — Help*\n\n' +

    '*Commands:*\n' +
    '/start — Create wallet or open main menu\n' +
    '/wallet — Open wallet, portfolio & deposit\n' +
    '/referral — Referral program & earnings\n' +
    '/copy — Copy trading\n' +
    '  • `/copy list` — Active subscriptions\n' +
    '  • `/copy add <address>` — Follow a trader\n' +
    '  • `/copy stop <address>` — Stop following\n' +
    '  • `/copy history` — Trade history\n' +
    '/help — Show this message\n\n' +

    '*Main Menu Buttons:*\n' +
    '📈 *Markets* — Browse & trade prediction markets\n' +
    '🤝 *Copy Trade* — Mirror top traders automatically\n' +
    '📁 *Portfolio* — Positions, orders & P&L\n' +
    '👛 *Wallet* — Deposit addresses & balance\n' +
    '💼 *Active Positions* — Your open positions\n' +
    '💰 *Limit Orders* — Open limit orders\n' +
    '👥 *Referral* — Invite friends & earn commission\n' +
    '⚙️ *Settings* — Trade amount, slippage, 2FA\n\n' +

    '*Quick Search:*\n' +
    'Paste any Polymarket URL or type a keyword — the bot finds the market instantly.\n\n' +

    '⚠️ *Security:* Never share your private key with anyone!';

  if (user && isUserAdmin(user)) {
    helpMessage +=
      '\n\n*Admin Commands:*\n' +
      '/stats — Bot statistics\n' +
      '/users — User list & management\n' +
      '/reset\\_me — Reset your account\n' +
      '/emojiid — Extract custom emoji IDs from a message';
  }

  await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
}
