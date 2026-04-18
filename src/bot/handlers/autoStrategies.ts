import { Context, Markup } from 'telegraf';
import { prisma } from '../../database/prisma';
import { getUserByTelegramId } from '../../services/user';
import { sendPage } from '../../utils/telegram';
import { t, Locale } from '../../i18n';

function getLang(user: any): Locale {
  return (user?.language as Locale) || 'en';
}

/**
 * Auto Strategies umbrella page — shows all strategy types with their status.
 * Matches Kreo-style "Your Strategies" overview.
 */
export async function handleAutoStrategies(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.reply(t(((ctx as any).userLanguage as Locale) || 'en', 'common.userNotFoundStart')); return; }

  const lang = getLang(user);

  const walletAddr = user.polymarketProxyAddress || user.walletAddress;
  const shortWallet = walletAddr
    ? `${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}`
    : t(lang, 'Not set');

  // Fetch bond + updown strategies in parallel
  const [bondStrategies, updownStrategies] = await Promise.all([
    prisma.bondStrategy.findMany({ where: { userId: user.id } }),
    prisma.upDownStrategy.findMany({ where: { userId: user.id } }),
  ]);

  const bondRunning = bondStrategies.filter(s => s.isActive && !s.isPaused).length;
  const bondTotal = bondStrategies.length;
  let bondStatus: string;
  if (bondTotal === 0) {
    bondStatus = t(lang, 'No strategies yet', { count: '0' });
  } else if (bondRunning > 0) {
    bondStatus = `${bondRunning}/${bondTotal} ${t(lang, 'running')}`;
  } else {
    bondStatus = `${bondTotal} ${t(lang, 'paused')}`;
  }

  const updownRunning = updownStrategies.filter(s => s.isActive && !s.isPaused).length;
  const updownTotal = updownStrategies.length;
  let updownStatus: string;
  if (updownTotal === 0) {
    updownStatus = t(lang, 'No strategies yet', { count: '0' });
  } else if (updownRunning > 0) {
    updownStatus = `${updownRunning}/${updownTotal} ${t(lang, 'running')}`;
  } else {
    updownStatus = `${updownTotal} ${t(lang, 'paused')}`;
  }

  const totalStrats = bondTotal + updownTotal;
  const totalRunning = bondRunning + updownRunning;

  const lines = [
    `🧠 <b>${t(lang, 'Auto Strategies')}</b>`,
    ``,
    `👛 <code>${shortWallet}</code>`,
    `⚡ ${totalRunning}/${totalStrats} ${t(lang, 'active strategies')}`,
    ``,
    `🎯 <b>${t(lang, 'Bonding')}</b>`,
    `└ ${bondTotal === 0 ? '💤' : bondRunning > 0 ? '🟢' : '🔴'} ${bondStatus}`,
    ``,
    `🤖 <b>${t(lang, 'AutoPilot')}</b>`,
    `└ ${updownTotal === 0 ? '💤' : updownRunning > 0 ? '🟢' : '🔴'} ${updownStatus}`,
  ];

  const buttons = [
    [
      Markup.button.callback(`🎯 ${t(lang, 'Bonding')}`, 'bond_list'),
      Markup.button.callback(`🤖 ${t(lang, 'AutoPilot')}`, 'updown_list'),
    ],
    [
      Markup.button.callback(`🧪 ${t(lang, 'bt.menu.title')}`, 'bt_menu'),
      Markup.button.callback(`🔬 ${t(lang, 'az.menu.title')}`, 'az_menu'),
    ],
    [Markup.button.callback(`🔙 ${t(lang, 'Main Menu')}`, 'back_to_menu')],
  ];

  await sendPage(ctx, lines.join('\n'), { ...Markup.inlineKeyboard(buttons), parse_mode: 'HTML' });
}
