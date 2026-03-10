import { ethers } from 'ethers';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { config } from '../config';

/** 10% of the platform commission is returned to the trader as cashback. */
export const CASHBACK_RATE = 0.10;

/** Minimum claimable amount before withdrawal is allowed (USD). */
export const CASHBACK_MIN_CLAIM = 10.0;

const RPC_URLS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://1rpc.io/matic',
];
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

async function getProvider(): Promise<ethers.providers.JsonRpcProvider> {
  for (const url of RPC_URLS) {
    try {
      const p = new ethers.providers.JsonRpcProvider(url);
      await Promise.race([
        p.getBlockNumber(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      return p;
    } catch {
      /* try next */
    }
  }
  throw new Error('All RPCs unresponsive');
}

export interface CashbackStats {
  claimable: number;
  earnedTotal: number;
}

export interface CashbackClaimResult {
  success: boolean;
  amount?: number;
  txHash?: string;
  pending?: boolean;
  error?: string;
}

/**
 * Credits 10% of the paid commission back to the trader as cashback.
 * Pure off-chain ledger update — fast, no gas cost.
 */
export async function creditCashback(userId: string, commissionUsd: number): Promise<void> {
  if (commissionUsd <= 0) return;

  const cashbackAmount = commissionUsd * CASHBACK_RATE;
  if (cashbackAmount < 0.0001) return; // dust

  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        cashbackClaimable: { increment: cashbackAmount },
        cashbackEarnedTotal: { increment: cashbackAmount },
      },
    });
    logger.info(`[cashback] Credited $${cashbackAmount.toFixed(4)} cashback to user ${userId}`);
  } catch (err) {
    logger.error('[cashback] creditCashback error:', err);
  }
}

/**
 * Returns cashback stats for a user.
 */
export async function getCashbackStats(userId: string): Promise<CashbackStats> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { cashbackClaimable: true, cashbackEarnedTotal: true },
  });
  return {
    claimable: user?.cashbackClaimable ?? 0,
    earnedTotal: user?.cashbackEarnedTotal ?? 0,
  };
}

/**
 * Pays out accumulated cashback to the user's Polymarket proxy wallet (USDC.e).
 * Uses the same treasury key as the referral system.
 * Atomic deduction prevents double-claim race conditions.
 */
export async function claimCashback(userId: string, proxyAddress: string): Promise<CashbackClaimResult> {
  const treasuryKey = config.referral.treasuryKey || null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { cashbackClaimable: true },
  });

  if (!user) return { success: false, error: 'User not found.' };

  const claimable = user.cashbackClaimable;
  if (claimable < CASHBACK_MIN_CLAIM) {
    return {
      success: false,
      error: `Minimum withdrawal is $${CASHBACK_MIN_CLAIM}. You have $${claimable.toFixed(2)}.`,
    };
  }

  if (!treasuryKey) {
    logger.warn(`[cashback] REFERRAL_TREASURY_KEY not set. Manual payout needed for user ${userId}: $${claimable.toFixed(2)}`);
    return {
      success: false,
      pending: true,
      amount: claimable,
      error: 'Automatic payout is currently unavailable. Your cashback will be processed manually within 24 hours.',
    };
  }

  try {
    // Atomic deduction — prevents double-claim
    const updated = await prisma.user.updateMany({
      where: { id: userId, cashbackClaimable: { gte: CASHBACK_MIN_CLAIM } },
      data: { cashbackClaimable: 0 },
    });

    if (updated.count === 0) {
      return {
        success: false,
        error: `Minimum withdrawal is $${CASHBACK_MIN_CLAIM}. You have $${claimable.toFixed(2)}.`,
      };
    }

    const provider = await getProvider();
    const treasury = new ethers.Wallet(treasuryKey, provider);
    const usdcContract = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, treasury);

    const amountRaw = Math.floor(claimable * 1e6); // 6 decimals

    logger.info(`[cashback] Sending $${claimable.toFixed(2)} USDC.e to ${proxyAddress}`);

    const tx = await Promise.race([
      usdcContract.transfer(proxyAddress, amountRaw, {
        gasLimit: 80_000,
        maxPriorityFeePerGas: ethers.utils.parseUnits('30', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('100', 'gwei'),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('send timeout after 20s')), 20_000)
      ),
    ]);

    logger.info(`[cashback] Payout tx submitted: ${tx.hash}`);

    tx.wait(1)
      .then((receipt: ethers.providers.TransactionReceipt) => {
        logger.info(`[cashback] Payout confirmed: ${receipt.transactionHash}`);
      })
      .catch((err: Error) => {
        logger.warn(`[cashback] Payout tx wait failed (may still confirm): ${err.message}`);
      });

    return { success: true, amount: claimable, txHash: tx.hash };
  } catch (err: any) {
    // Rollback on failure
    await prisma.user.update({
      where: { id: userId },
      data: { cashbackClaimable: { increment: claimable } },
    }).catch((rollbackErr) => {
      logger.error(
        `[cashback] CRITICAL: Payout failed AND rollback failed for user ${userId} ($${claimable.toFixed(2)})`,
        rollbackErr
      );
    });

    logger.error('[cashback] Payout failed:', err?.message || err);
    return { success: false, error: 'Payout failed. Please try again later.' };
  }
}
