import { Context, Markup } from 'telegraf';
import { prisma } from '../../database/prisma';
import { getUserByTelegramId } from '../../services/user';
import { sendPage } from '../../utils/telegram';

/**
 * Auto Strategies umbrella page — shows all strategy types with their status.
 * Matches Kreo-style "Your Strategies" overview.
 */
export async function handleAutoStrategies(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await getUserByTelegramId(telegramId);
  if (!user) { await ctx.reply('❌ User not found. Use /start first.'); return; }

  const walletAddr = user.polymarketProxyAddress || user.walletAddress;
  const shortWallet = walletAddr
    ? `${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}`
    : 'Not set';

  // Bond strategy status
  const bondStrategies = await prisma.bondStrategy.findMany({
    where: { userId: user.id },
  });
  const bondRunning = bondStrategies.filter(s => s.isActive && !s.isPaused).length;
  const bondTotal = bondStrategies.length;
  let bondStatus: string;
  if (bondTotal === 0) {
    bondStatus = '⚪ Not configured';
  } else if (bondRunning > 0) {
    bondStatus = `🟢 ${bondRunning}/${bondTotal} running`;
  } else {
    bondStatus = `🔴 ${bondTotal} paused`;
  }

  // Up-Down status
  const updownStrategies = await prisma.upDownStrategy.findMany({
    where: { userId: user.id },
  });
  const updownRunning = updownStrategies.filter(s => s.isActive && !s.isPaused).length;
  const updownTotal = updownStrategies.length;
  let updownStatus: string;
  if (updownTotal === 0) {
    updownStatus = '⚪ Not configured';
  } else if (updownRunning > 0) {
    updownStatus = `🟢 ${updownRunning}/${updownTotal} running`;
  } else {
    updownStatus = `🔴 ${updownTotal} paused`;
  }

  const lines = [
    `🤖 <b>Your Strategies</b>`,
    `💰 Wallet: Main Wallet (${shortWallet})`,
    ``,
    `🎯 <b>Bonding</b> — ${bondStatus}`,
    ``,
    `📈 <b>Up-Down</b> — ${updownStatus}`,
    ``,
    `Select a strategy to manage:`,
  ];

  const buttons = [
    [Markup.button.callback('🎯 Bonding', 'bond_list')],
    [Markup.button.callback('📈 Up-Down', 'updown_list')],
    [Markup.button.callback('← Main Menu', 'back_to_menu')],
  ];

  await sendPage(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
}

