import { ethers } from 'ethers';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { config } from '../config';

// Tier percentages — applied to the commission amount collected from the trade
export const REFERRAL_TIER1_PCT = 0.25; // 25% of commission → direct referrer
export const REFERRAL_TIER2_PCT = 0.05; // 5%  of commission → referrer's referrer
export const REFERRAL_TIER3_PCT = 0.03; // 3%  of commission → tier-3

// Minimum claimable amount (USD)
export const REFERRAL_MIN_CLAIM = 4.0;

// RPC URLs for payout transactions
const RPC_URLS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://1rpc.io/matic',
];
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

export interface ReferralStats {
  code: string;
  inviteLink: string;
  tier1Count: number;   // direct referrals
  tier2Count: number;   // referrals of referrals
  tier3Count: number;   // tier-3
  claimable: number;    // USD
  earnedTotal: number;  // USD
}

/**
 * Returns an active provider by trying RPCs in order.
 */
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

/**
 * Generates (or returns existing) referral code for a user.
 * Uses Telegram username if available, otherwise a random 6-char code.
 */
export async function ensureReferralCode(userId: string, username?: string | null): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralCode: true },
  });

  if (user?.referralCode) return user.referralCode;

  // Try username first (lowercase, max 20 chars)
  const base = username?.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);

  let code = base || '';
  let attempts = 0;

  while (true) {
    if (!code) {
      if (base && attempts < 3) {
        // Try base + random suffix before falling back to pure random
        code = base + Math.random().toString(36).slice(2, 6).toUpperCase();
      } else {
        code = Math.random().toString(36).slice(2, 8).toUpperCase();
      }
    }

    const exists = await prisma.user.findUnique({ where: { referralCode: code } });
    if (!exists) break;

    attempts++;
    code = '';
  }

  await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
  return code;
}

/**
 * Links a new user to their referrer using a referral code.
 * Returns true if successfully linked, false otherwise.
 */
export async function applyReferralCode(newUserId: string, code: string): Promise<boolean> {
  try {
    const referrer = await prisma.user.findUnique({ where: { referralCode: code } });
    if (!referrer) return false;
    if (referrer.id === newUserId) return false; // can't refer yourself

    const newUser = await prisma.user.findUnique({ where: { id: newUserId } });
    if (!newUser) return false;
    if (newUser.referredById) return false; // already has a referrer

    await prisma.user.update({
      where: { id: newUserId },
      data: { referredById: referrer.id },
    });

    logger.info(`[referral] User ${newUserId} linked to referrer ${referrer.id} via code "${code}"`);
    return true;
  } catch (err) {
    logger.error('[referral] applyReferralCode error:', err);
    return false;
  }
}

/**
 * Returns referral stats for the given user.
 */
export async function getReferralStats(userId: string, botUsername: string): Promise<ReferralStats> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      username: true,
      referralCode: true,
      referralClaimable: true,
      referralEarnedTotal: true,
      referrals: {
        select: {
          id: true,
          referrals: {
            select: {
              id: true,
              referrals: {
                select: { id: true },
              },
            },
          },
        },
      },
    },
  });

  if (!user) {
    return { code: '', inviteLink: '', tier1Count: 0, tier2Count: 0, tier3Count: 0, claimable: 0, earnedTotal: 0 };
  }

  const code = user.referralCode || await ensureReferralCode(userId, user.username);

  if (!botUsername) {
    logger.warn('[referral] BOT_USERNAME env var is not set — invite links will be malformed');
  }

  const inviteLink = `https://t.me/${botUsername}?start=ref_${code}`;

  // Count tiers
  const tier1 = user.referrals;
  const tier2 = tier1.flatMap((u: typeof tier1[0]) => u.referrals);
  const tier3 = tier2.flatMap((u: typeof tier2[0]) => u.referrals);

  return {
    code,
    inviteLink,
    tier1Count: tier1.length,
    tier2Count: tier2.length,
    tier3Count: tier3.length,
    claimable: user.referralClaimable,
    earnedTotal: user.referralEarnedTotal,
  };
}

/**
 * Credits referral commissions to the referral chain when a trade occurs.
 * Tier 1 = direct referrer, Tier 2 = their referrer, Tier 3 = etc.
 */
export async function creditReferralCommission(traderId: string, commissionUsd: number): Promise<void> {
  if (commissionUsd <= 0) return;

  try {
    // Load the trader and up to 3 levels of referral chain
    const trader = await prisma.user.findUnique({
      where: { id: traderId },
      select: {
        referredBy: {
          select: {
            id: true,
            referredBy: {
              select: {
                id: true,
                referredBy: {
                  select: { id: true },
                },
              },
            },
          },
        },
      },
    });

    if (!trader?.referredBy) return; // no referrer chain

    const tier1 = trader.referredBy;
    const tier2 = tier1.referredBy ?? null;
    const tier3 = tier2?.referredBy ?? null;

    const updates: Array<{ id: string; amount: number }> = [];

    const t1Amt = commissionUsd * REFERRAL_TIER1_PCT;
    updates.push({ id: tier1.id, amount: t1Amt });

    if (tier2) {
      const t2Amt = commissionUsd * REFERRAL_TIER2_PCT;
      updates.push({ id: tier2.id, amount: t2Amt });
    }

    if (tier3) {
      const t3Amt = commissionUsd * REFERRAL_TIER3_PCT;
      updates.push({ id: tier3.id, amount: t3Amt });
    }

    // Write all updates in a transaction
    await prisma.$transaction(
      updates.map(({ id, amount }) =>
        prisma.user.update({
          where: { id },
          data: {
            referralClaimable: { increment: amount },
            referralEarnedTotal: { increment: amount },
          },
        })
      )
    );

    logger.info(
      `[referral] Credited ${updates.map((u) => `$${u.amount.toFixed(4)}`).join(', ')} ` +
      `to ${updates.length} referrers for trader ${traderId}`
    );
  } catch (err) {
    logger.error('[referral] creditReferralCommission error:', err);
  }
}

export interface ClaimResult {
  success: boolean;
  amount?: number;
  txHash?: string;
  insufficientTreasury?: boolean;
  error?: string;
}

/**
 * Pays out claimable referral earnings to the user's Polymarket proxy wallet.
 * Requires REFERRAL_TREASURY_KEY env var (EOA wallet with USDC.e).
 */
export async function claimReferralEarnings(userId: string, proxyAddress: string): Promise<ClaimResult> {
  const treasuryKey = config.referral.treasuryKey || null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralClaimable: true },
  });

  if (!user) return { success: false, error: 'User not found' };

  const claimable = user.referralClaimable;
  if (claimable < REFERRAL_MIN_CLAIM) {
    return {
      success: false,
      error: `Minimum claim amount is $${REFERRAL_MIN_CLAIM}. You have $${claimable.toFixed(2)}.`,
    };
  }

  if (!treasuryKey) {
    logger.warn(`[referral] REFERRAL_TREASURY_KEY not set. Payout blocked for user ${userId}: $${claimable.toFixed(2)}`);
    return {
      success: false,
      error: 'Ödeme sistemi henüz yapılandırılmadı. Lütfen destek ile iletişime geçin.',
    };
  }

  try {
    // Atomic deduction — prevents double-claim race condition.
    // Only deducts if the balance is still sufficient at the moment of update.
    const updated = await prisma.user.updateMany({
      where: { id: userId, referralClaimable: { gte: REFERRAL_MIN_CLAIM } },
      data: { referralClaimable: 0 },
    });

    if (updated.count === 0) {
      // Another concurrent request already claimed, or balance dropped below minimum
      return {
        success: false,
        error: `Minimum claim amount is $${REFERRAL_MIN_CLAIM}. You have $${claimable.toFixed(2)}.`,
      };
    }

    const provider = await getProvider();
    const treasury = new ethers.Wallet(treasuryKey, provider);
    const usdcContract = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, treasury);

    const amountRaw = Math.floor(claimable * 1e6); // 6 decimals
    const treasuryBalance: ethers.BigNumber = await usdcContract.balanceOf(treasury.address);
    if (treasuryBalance.lt(amountRaw)) {
      // Rollback the deducted amount before returning
      await prisma.user.update({
        where: { id: userId },
        data: { referralClaimable: { increment: claimable } },
      }).catch((rollbackErr) => {
        logger.error(`[referral] CRITICAL: Balance check rollback failed for user ${userId}`, rollbackErr);
      });
      logger.warn(`[referral] Treasury balance insufficient: have ${treasuryBalance.toString()}, need ${amountRaw}`);
      return {
        success: false,
        insufficientTreasury: true,
        amount: claimable,
        error: 'Şu anda ödeme yapılamıyor. Lütfen daha sonra tekrar deneyin.',
      };
    }

    logger.info(`[referral] Sending $${claimable.toFixed(2)} USDC.e to ${proxyAddress}`);

    const feeData = await provider.getFeeData();
    const priorityFee = feeData.maxPriorityFeePerGas ?? ethers.utils.parseUnits('30', 'gwei');
    const baseFee = feeData.lastBaseFeePerGas ?? ethers.utils.parseUnits('50', 'gwei');
    // maxFeePerGas = 2× baseFee + tip (EIP-1559 standard headroom)
    const maxFee = baseFee.mul(2).add(priorityFee);

    const tx = await Promise.race([
      usdcContract.transfer(proxyAddress, amountRaw, {
        gasLimit: 80_000,
        maxPriorityFeePerGas: priorityFee,
        maxFeePerGas: maxFee,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('send timeout after 20s')), 20_000)
      ),
    ]);

    logger.info(`[referral] Payout tx submitted: ${tx.hash}`);

    // Fire-and-forget confirmation log
    tx.wait(1).then((receipt: ethers.providers.TransactionReceipt) => {
      logger.info(`[referral] Payout confirmed: ${receipt.transactionHash}`);
    }).catch((err: Error) => {
      logger.warn(`[referral] Payout tx wait failed (may still confirm): ${err.message}`);
    });

    return { success: true, amount: claimable, txHash: tx.hash };
  } catch (err: any) {
    // Restore claimable on failure — log if rollback itself fails (funds at risk)
    await prisma.user.update({
      where: { id: userId },
      data: { referralClaimable: { increment: claimable } },
    }).catch((rollbackErr) => {
      logger.error(
        `[referral] CRITICAL: Payout failed AND rollback failed for user ${userId} ($${claimable.toFixed(2)})`,
        rollbackErr
      );
    });

    logger.error('[referral] Payout failed:', err?.message || err);
    return { success: false, error: 'Payout failed. Please try again later.' };
  }
}
