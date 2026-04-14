import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserByTelegramId } from '../../services/user';
import { t, Locale } from '../../i18n';

export async function handleHelp(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id.toString();
  let lang: Locale = 'en';
  if (telegramId) {
    const user = await getUserByTelegramId(telegramId);
    if (user?.language) lang = user.language as Locale;
  }

  await ctx.reply(t(lang, 'help.title'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.url(t(lang, 'help.joinBtn'), 'https://t.me/tradepolytech')],
    ]),
  });
}
