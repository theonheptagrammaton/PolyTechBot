import { ethers } from 'ethers';
import { decrypt } from '../utils/encryption';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ActivePosition } from './portfolio';
import { redisCache } from '../database/redis';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';

// TTL for the "already claimed" dedup key — long enough to outlive the 45s portfolio cache
const CLAIMED_TTL_SECONDS = 600; // 10 minutes

function claimedKey(proxyAddress: string, conditionId: string): string {
  return `redeem:claimed:${proxyAddress.toLowerCase()}:${conditionId}`;
}

// Polymarket contract addresses (from official docs)
const CTF_ADDRESS    = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const CTF_REDEEM_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

// Polymarket Builder Relayer (gasless proxy transactions)
const POLYGON_RPC  = 'https://polygon-bor-rpc.publicnode.com';
const RELAYER_URL  = 'https://relayer-v2.polymarket.com';
const CHAIN_ID     = 137;

// Global lock: prevents parallel redeem sessions for the same proxy
const _redeemLocks = new Set<string>();

/**
 * Creates a RelayClient for the user's proxy wallet.
 * The relayer handles Safe signatures internally and pays gas.
 * Uses SAFE type — per Polymarket docs, proxy wallets are Gnosis Safe 1-of-1 multisigs.
 */
function createRelayClient(privateKey: string, txType: RelayerTxType): RelayClient {
  const viemAccount = privateKeyToAccount(privateKey as `0x${string}`);
  const viemWallet = createWalletClient({
    account: viemAccount,
    chain: polygon,
    transport: http(POLYGON_RPC),
  });

  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: config.polymarket.builder.apiKey,
      secret: config.polymarket.builder.secret,
      passphrase: config.polymarket.builder.passphrase,
    },
  });

  return new RelayClient(
    RELAYER_URL,
    CHAIN_ID,
    viemWallet as any,
    builderConfig,
    txType,
  );
}

/**
 * Redeems a single resolved position via Polymarket's Builder Relayer (gasless).
 * Tries SAFE type first (Polymarket docs recommended), falls back to PROXY type.
 */
async function redeemPosition(params: {
  encryptedPrivateKey: string;
  proxyAddress: string;
  position: ActivePosition;
}): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const privateKey = decrypt(params.encryptedPrivateKey);
  const iface       = new ethers.utils.Interface(CTF_REDEEM_ABI);
  const conditionId = params.position.conditionId as string;

  const callData = iface.encodeFunctionData('redeemPositions', [
    USDC_E_POLYGON,
    ethers.constants.HashZero,
    conditionId,
    [1, 2],
  ]);

  const txPayload = [{ to: CTF_ADDRESS, data: callData, value: '0' }];

  // Try SAFE type first, then PROXY type
  for (const txType of [RelayerTxType.SAFE, RelayerTxType.PROXY]) {
    try {
      logger.info(
        `[redeem] Trying ${txType} relay: conditionId=${conditionId.slice(0, 18)}... outcome=${params.position.outcome}`
      );

      const relayClient = createRelayClient(privateKey, txType);

      const response = await Promise.race([
        relayClient.execute(txPayload),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('relay execute timeout')), 30_000)
        ),
      ]);

      if (!response) {
        logger.warn(`[redeem] ${txType}: no response from relayer`);
        continue;
      }

      logger.info(
        `[redeem] ${txType} response: id=${response.transactionID} state=${response.state} hash=${response.transactionHash || 'none'}`
      );

      const result = await Promise.race([
        response.wait(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('confirmation timeout')), 60_000)
        ),
      ]);

      if (!result) {
        // wait() returns undefined when STATE_FAILED — try fetching full tx info
        try {
          const txInfo = await response.getTransaction();
          logger.warn(`[redeem] ${txType} STATE_FAILED: ${JSON.stringify(txInfo).slice(0, 400)}`);
        } catch { /* ignore */ }
        logger.warn(`[redeem] ${txType}: relay tx failed (STATE_FAILED)`);
        continue; // try next type
      }

      const txHash = result.transactionHash;
      if (!txHash) {
        logger.warn(`[redeem] ${txType}: result has no transactionHash, state=${result.state}`);
        continue;
      }

      logger.info(`[redeem] Confirmed via ${txType} Relayer: ${txHash}`);
      return { success: true, txHash };
    } catch (error: any) {
      logger.warn(`[redeem] ${txType} attempt failed: ${error?.message?.slice(0, 200)}`);
      continue;
    }
  }

  return { success: false, error: 'Both SAFE and PROXY relay types failed' };
}

/**
 * Auto-claims all redeemable positions for a user (fire-and-forget).
 * Uses a global in-memory lock per proxy to prevent parallel sessions, and
 * Redis dedup keys to prevent re-claiming across page reloads.
 * Returns the number of new redemptions completed.
 */
export async function autoRedeemPositions(
  encryptedPrivateKey: string,
  proxyAddress: string,
  positions: ActivePosition[],
  notifyFn?: (msg: string) => Promise<void>,
): Promise<number> {
  const redeemable = positions.filter(p => p.redeemable);
  if (redeemable.length === 0) return 0;

  // Global lock per proxy — prevents parallel redeem sessions from different page opens
  const lockKey = proxyAddress.toLowerCase();
  if (_redeemLocks.has(lockKey)) {
    logger.debug(`[redeem] Skipping — redeem already in progress for ${proxyAddress.slice(0, 10)}...`);
    return 0;
  }

  _redeemLocks.add(lockKey);
  try {
    return await _doRedeem(encryptedPrivateKey, proxyAddress, redeemable, notifyFn);
  } finally {
    _redeemLocks.delete(lockKey);
  }
}

async function _doRedeem(
  encryptedPrivateKey: string,
  proxyAddress: string,
  redeemable: ActivePosition[],
  notifyFn?: (msg: string) => Promise<void>,
): Promise<number> {
  const pending: ActivePosition[] = [];
  for (const pos of redeemable) {
    const key = claimedKey(proxyAddress, pos.conditionId);
    const already = await redisCache.get<boolean>(key).catch(() => null);
    if (already) {
      logger.debug(`[redeem] Skipping already-claimed: ${pos.outcome} / ${pos.conditionId.slice(0, 18)}...`);
    } else {
      pending.push(pos);
    }
  }

  if (pending.length === 0) return 0;

  logger.info(`[redeem] Auto-redeeming ${pending.length} new position(s) for ${proxyAddress.slice(0, 10)}... (${redeemable.length - pending.length} already claimed)`);

  let claimed = 0;
  for (const pos of pending) {
    try {
      const key = claimedKey(proxyAddress, pos.conditionId);
      await redisCache.set(key, true, CLAIMED_TTL_SECONDS).catch(() => {});

      const result = await redeemPosition({ encryptedPrivateKey, proxyAddress, position: pos });
      if (result.success) {
        claimed++;
        logger.info(`[redeem] Claimed: ${pos.outcome} / ${pos.title.slice(0, 40)}`);
        if (notifyFn) {
          const truncTitle = pos.title.length > 50 ? pos.title.slice(0, 50) + '…' : pos.title;
          await notifyFn(
            `✅ *Resolved Position Claimed*\n\n` +
            `*${pos.outcome}* — ${truncTitle}\n\n` +
            `💵 USDC.e has been returned to your wallet.`
          ).catch(() => {});
        }
      } else {
        await redisCache.del(key).catch(() => {});
        logger.warn(`[redeem] Failed to claim ${pos.outcome}: ${result.error}`);
      }
    } catch (err: any) {
      logger.error(`[redeem] Unexpected error for ${pos.conditionId}:`, err?.message);
    }
  }

  return claimed;
}
