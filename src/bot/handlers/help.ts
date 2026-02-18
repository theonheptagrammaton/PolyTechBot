import { Context } from 'telegraf';
import { getUserByTelegramId, isUserAdmin } from '../../services/user';

export async function handleHelp(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();

  if (!telegramId) {
    await ctx.reply('❌ Could not identify your Telegram account.');
    return;
  }

  const user = await getUserByTelegramId(telegramId);

  let helpMessage = `
📚 *Polymarket Bot - Help*

*Available Commands:*

/start - Create your Polymarket wallet
/help - Show this help message
/wallet - Show your wallet information
/balance - Check your wallet balance (coming soon)
/markets - Browse available markets (coming soon)

`;

  if (user && isUserAdmin(user)) {
    helpMessage += `
*Admin Commands:*
/stats - View bot statistics
/users - List all users
`;
  }

  helpMessage += `
💡 *Need Support?*
Contact the bot administrator if you need assistance.

⚠️ *Security Reminder:*
Never share your private key with anyone!
`;

  await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
}
