import { Context } from 'telegraf';
import { Markup } from 'telegraf';

export async function handleHelp(ctx: Context): Promise<void> {
  const helpMessage =
    '📚 <b>PolyTech Sniper Bot — Help</b>\n\n' +
    'Need help or have questions?\n' +
    'Join our community group for support!';

  await ctx.reply(helpMessage, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.url('💬 Join @tradepolytech', 'https://t.me/tradepolytech')],
    ]),
  });
}
