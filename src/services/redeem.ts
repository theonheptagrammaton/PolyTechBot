import { ethers } from 'ethers';
import { decrypt } from '../utils/encryption';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ActivePosition } from './portfolio';
import { redisCache } from '../database/redis';
import { getPositions, redeemPosition as redeemPositionPredexon } from './predexon';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';

// TTL for the "already claimed" dedup key — 30 days so the Data API lag never re-triggers
const CLAIMED_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function claimedKey(proxyAddress: string, conditionId: string): string {
  return `redeem:claimed:${proxyAddress.toLowerCase()}:${conditionId}`;
}

// Polymarket contract addresses (from official docs)
const CTF_ADDRESS         = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E_POLYGON      = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (bridged)
const NATIVE_USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC

const CTF_REDEEM_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

// Polymarket Builder Relayer (gasless proxy transactions)
const POLYGON_RPC  = 'https://polygon-bor-rpc.publicnode.com';
const RELAYER_URL  = 'https://relayer-v2.polymarket.com';
const CHAIN_ID     = 137;

// Polygon RPC provider for verifying tx receipts on-chain
const polygonProvider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);

// Global lock: prevents parallel redeem sessions for the same proxy
const _redeemLocks = new Set<string>();

/**
 * Verifies a transaction was actually mined and succeeded on-chain.
 * Returns true only if the receipt exists and status === 1 (success).
 */
async function verifyTxOnChain(txHash: string): Promise<boolean> {
  try {
    const receipt = await Promise.race([
      polygonProvider.getTransactionReceipt(txHash),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('receipt fetch timeout')), 15_000)
      ),
    ]);
    if (!receipt) {
      logger.warn(`[redeem] No receipt found for tx ${txHash} — tx may be pending or dropped`);
      return false;
    }
    if (receipt.status === 0) {
      logger.warn(`[redeem] Tx ${txHash} was REVERTED on-chain (status=0)`);
      return false;
    }
    logger.info(`[redeem] Tx ${txHash} confirmed on-chain: block=${receipt.blockNumber} status=${receipt.status}`);
    return true;
  } catch (err: any) {
    logger.warn(`[redeem] Failed to verify tx ${txHash}: ${err?.message}`);
    // If we can't verify, don't assume success
    return false;
  }
}

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
  const privateKey  = decrypt(params.encryptedPrivateKey);
  const iface       = new ethers.utils.Interface(CTF_REDEEM_ABI);
  const conditionId = params.position.conditionId as string;

  // Try USDC.e first (legacy positions), then native USDC (post-migration positions)
  for (const collateralToken of [USDC_E_POLYGON, NATIVE_USDC_POLYGON]) {
    const callData = iface.encodeFunctionData('redeemPositions', [
      collateralToken,
      ethers.constants.HashZero,
      conditionId,
      [1, 2],
    ]);
    const txPayload = [{ to: CTF_ADDRESS, data: callData, value: '0' }];
    const tokenLabel = collateralToken === USDC_E_POLYGON ? 'USDC.e' : 'native USDC';

    for (const txType of [RelayerTxType.SAFE, RelayerTxType.PROXY]) {
      try {
        logger.info(
          `[redeem] Trying ${txType}/${tokenLabel}: conditionId=${conditionId.slice(0, 18)}... outcome=${params.position.outcome}`
        );

        const relayClient = createRelayClient(privateKey, txType);

        const response = await Promise.race([
          relayClient.execute(txPayload),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('relay execute timeout')), 30_000)
          ),
        ]);

        if (!response) {
          logger.warn(`[redeem] ${txType}/${tokenLabel}: no response from relayer`);
          continue;
        }

        logger.info(
          `[redeem] ${txType}/${tokenLabel} response: id=${response.transactionID} state=${response.state} hash=${response.transactionHash || 'none'}`
        );

        const result = await Promise.race([
          response.wait(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('confirmation timeout')), 60_000)
          ),
        ]);

        if (!result) {
          try {
            const txInfo = await response.getTransaction();
            logger.warn(`[redeem] ${txType}/${tokenLabel} STATE_FAILED: ${JSON.stringify(txInfo).slice(0, 400)}`);
          } catch { /* ignore */ }
          logger.warn(`[redeem] ${txType}/${tokenLabel}: relay tx failed (STATE_FAILED)`);
          continue;
        }

        const txHash = result.transactionHash;
        if (!txHash) {
          logger.warn(`[redeem] ${txType}/${tokenLabel}: result has no transactionHash, state=${result.state}`);
          continue;
        }

        // Verify the transaction actually succeeded on-chain
        const verified = await verifyTxOnChain(txHash);
        if (!verified) {
          logger.warn(`[redeem] ${txType}/${tokenLabel}: relayer returned tx ${txHash} but on-chain verification FAILED`);
          continue;
        }

        logger.info(`[redeem] Confirmed via ${txType}/${tokenLabel} Relayer: ${txHash}`);
        return { success: true, txHash };
      } catch (error: any) {
        logger.warn(`[redeem] ${txType}/${tokenLabel} attempt failed: ${error?.message?.slice(0, 200)}`);
        continue;
      }
    }
    // Both tx types failed for this collateral token — try next token
    logger.info(`[redeem] All tx types failed with ${tokenLabel}, trying next collateral token...`);
  }

  return { success: false, error: 'Redemption failed with all collateral token variants' };
}

/**
 * Attempts redemption via Predexon API first (no relayer quota), falls back to Builder Relayer.
 */
async function redeemSingle(params: {
  encryptedPrivateKey: string;
  proxyAddress: string;
  position: ActivePosition;
  predexonUserId?: string;
}): Promise<{ success: boolean; txHash?: string; error?: string }> {
  if (params.predexonUserId) {
    try {
      const predexonPositions = await getPositions(params.predexonUserId, 'polymarket');
      logger.info(
        `[redeem] Predexon positions (${predexonPositions.length}): ${JSON.stringify(
          predexonPositions.map(p => ({
            positionId: p.positionId,
            tokenId: p.tokenId,
            status: p.status,
            outcome: p.outcome,
            size: p.size,
          }))
        ).slice(0, 800)}`
      );
      logger.info(
        `[redeem] Looking for asset=${params.position.asset} or conditionId=${params.position.conditionId}`
      );
      const match = predexonPositions.find(
        p => p.status === 'redeemable' &&
             (p.tokenId === params.position.asset || p.positionId === params.position.conditionId)
      );
      if (match?.positionId) {
        logger.info(`[redeem] Using Predexon API for positionId=${match.positionId} (matched by ${match.tokenId === params.position.asset ? 'tokenId' : 'positionId'})`);
        const result = await redeemPositionPredexon(params.predexonUserId, match.positionId);
        logger.info(`[redeem] Predexon redeem response: ${JSON.stringify(result).slice(0, 400)}`);

        if (result.transactionHash) {
          // Verify the transaction actually succeeded on-chain
          const verified = await verifyTxOnChain(result.transactionHash);
          if (verified) {
            return { success: true, txHash: result.transactionHash };
          }
          logger.warn(`[redeem] Predexon returned tx ${result.transactionHash} but on-chain verification FAILED`);
        } else if (result.status === 'success') {
          // Predexon says success but no tx hash — this is suspicious, don't trust it
          logger.warn(`[redeem] Predexon returned status=success but NO transactionHash — treating as failed`);
        } else {
          logger.warn(`[redeem] Predexon redeem returned unexpected status: ${result.status}`);
        }
      } else {
        logger.info(`[redeem] No matching redeemable position found in Predexon (checked ${predexonPositions.length} positions), falling back to relayer`);
      }
    } catch (err: any) {
      logger.warn(`[redeem] Predexon redeem failed, falling back to relayer: ${err?.message}`);
    }
  }
  return redeemPosition(params);
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
  predexonUserId?: string,
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
    return await _doRedeem(encryptedPrivateKey, proxyAddress, redeemable, notifyFn, predexonUserId);
  } finally {
    _redeemLocks.delete(lockKey);
  }
}

/**
 * Returns the subset of conditionIds that have already been claimed (Redis key present).
 * Used to filter redeemed positions out of the Active Positions display.
 */
export async function getClaimedConditionIds(
  proxyAddress: string,
  conditionIds: string[],
): Promise<Set<string>> {
  const claimed = new Set<string>();
  await Promise.all(
    conditionIds.map(async (id) => {
      const key = claimedKey(proxyAddress, id);
      const hit = await redisCache.get<boolean>(key).catch(() => null);
      if (hit) claimed.add(id);
    }),
  );
  return claimed;
}

/**
 * Manually redeems a single resolved position. Called when user presses "Redeem It" button.
 * Returns { success, txHash?, error? }
 */
export async function manualRedeem(
  encryptedPrivateKey: string,
  proxyAddress: string,
  position: ActivePosition,
  predexonUserId?: string,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const result = await redeemSingle({ encryptedPrivateKey, proxyAddress, position, predexonUserId });
  if (result.success) {
    const key = claimedKey(proxyAddress, position.conditionId);
    await redisCache.set(key, true, CLAIMED_TTL_SECONDS).catch(() => {});
    logger.info(`[redeem] Manual claim success: ${position.outcome} / ${position.title.slice(0, 40)}`);
  }
  return result;
}

async function _doRedeem(
  encryptedPrivateKey: string,
  proxyAddress: string,
  redeemable: ActivePosition[],
  notifyFn?: (msg: string) => Promise<void>,
  predexonUserId?: string,
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

      const result = await redeemSingle({ encryptedPrivateKey, proxyAddress, position: pos, predexonUserId });
      if (result.success) {
        // Set dedup key ONLY after successful claim — prevents lost funds on failed attempts
        await redisCache.set(key, true, CLAIMED_TTL_SECONDS).catch(() => {});
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
        logger.warn(`[redeem] Failed to claim ${pos.outcome}: ${result.error}`);
      }
    } catch (err: any) {
      logger.error(`[redeem] Unexpected error for ${pos.conditionId}:`, err?.message);
    }
  }

  return claimed;
}
