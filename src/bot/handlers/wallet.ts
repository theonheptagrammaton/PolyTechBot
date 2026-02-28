import { Context } from 'telegraf';
import { handleWalletPage } from './walletPage';

export async function handleWallet(ctx: Context): Promise<void> {
  await handleWalletPage(ctx);
}
