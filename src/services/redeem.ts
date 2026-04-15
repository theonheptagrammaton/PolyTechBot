import { ethers } from 'ethers';
import { decrypt } from '../utils/encryption';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ActivePosition } from './portfolio';
import { redisCache } from '../database/redis';
import { getPositions, redeemPosition as redeemPositionPredexon, PredexonPosition } from './predexon';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import {
  isRelayerBackedOff,
  setRelayerBackoff,
  isRateLimitError,
  incrementRelayerCount,
  getThrottleDelay,
  canCallRelayer,
  getRelayerBackoffRemaining,
} from '../utils/relayerRateLimit';

// TTL for the "already claimed" dedup key — 30 days so the Data API lag never re-triggers
const CLAIMED_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function claimedKey(proxyAddress: string, conditionId: string): string {
  return `redeem:claimed:${proxyAddress.toLowerCase()}:${conditionId}`;
}

// Polymarket contract addresses (from official docs)
const CTF_ADDRESS            = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER       = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC_E_POLYGON         = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (bridged)
const NATIVE_USDC_POLYGON    = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function setApprovalForAll(address operator, bool approved) external',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

const NEG_RISK_ADAPTER_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) external',
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
 * Checks on-chain CTF token balance for a given proxy wallet and token (asset) ID.
 * Returns the balance as a BigNumber. If the balance is 0, the position is already redeemed.
 */
async function getOnChainTokenBalance(proxyAddress: string, tokenId: string): Promise<ethers.BigNumber> {
  try {
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, polygonProvider);
    const balance = await Promise.race([
      ctf.balanceOf(proxyAddress, tokenId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('balanceOf timeout')), 10_000)
      ),
    ]);
    return balance;
  } catch (err: any) {
    logger.warn(`[redeem] Failed to check on-chain balance for ${tokenId.slice(0, 20)}...: ${err?.message}`);
    // Return a non-zero value so we don't skip redeem on RPC failures
    return ethers.BigNumber.from(1);
  }
}

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
  // Pre-flight: check if relayer is available
  const preflight = await canCallRelayer();
  if (!preflight.ok) {
    logger.info(`[redeem] Relayer unavailable (${preflight.reason}), skipping — retry in ${preflight.waitSec}s`);
    return { success: false, error: `Relayer unavailable (${preflight.reason}), retry in ${preflight.waitSec}s` };
  }

  // Check on-chain balance before wasting a relayer tx
  const onChainBalance = await getOnChainTokenBalance(params.proxyAddress, params.position.asset);
  if (onChainBalance.isZero()) {
    logger.info(`[redeem] On-chain CTF balance is 0 for ${params.position.asset.slice(0, 20)}... — position already redeemed, skipping`);
    return { success: false, error: 'Position already redeemed (on-chain balance is 0)' };
  }
  logger.info(`[redeem] On-chain CTF balance: ${onChainBalance.toString()} for ${params.position.asset.slice(0, 20)}... negRisk=${params.position.negativeRisk}`);

  // Check if the condition is actually resolved on-chain
  // payoutDenominator > 0 means the oracle has resolved the condition
  try {
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, polygonProvider);
    const payoutDenom = await Promise.race([
      ctf.payoutDenominator(params.position.conditionId),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
    ]);
    logger.info(`[redeem] payoutDenominator for ${params.position.conditionId.slice(0, 18)}... = ${payoutDenom.toString()}`);
    if (payoutDenom.isZero()) {
      logger.warn(`[redeem] Condition NOT resolved on-chain yet (payoutDenominator=0) — Data API says redeemable but oracle hasn't resolved`);
      return { success: false, error: 'Condition not yet resolved on-chain (oracle pending)' };
    }
  } catch (err: any) {
    logger.warn(`[redeem] Failed to check payoutDenominator: ${err?.message} — proceeding anyway`);
  }

  const privateKey  = decrypt(params.encryptedPrivateKey);

  // If Data API says negativeRisk, go straight to NegRiskAdapter
  if (params.position.negativeRisk) {
    return redeemNegRisk(privateKey, params.proxyAddress, params.position, onChainBalance);
  }

  // Try standard CTF path first (USDC.e, then native USDC)
  const stdResult = await redeemStandard(privateKey, params.proxyAddress, params.position, onChainBalance);
  if (stdResult.success) return stdResult;

  // Standard path failed — Data API negativeRisk flag can be unreliable,
  // so try NegRiskAdapter as fallback
  const balanceNow = await getOnChainTokenBalance(params.proxyAddress, params.position.asset);
  if (balanceNow.isZero()) {
    return stdResult;
  }
  logger.info(`[redeem] Standard CTF redeem failed, trying NegRiskAdapter as fallback (balance still ${balanceNow.toString()})`);
  return redeemNegRisk(privateKey, params.proxyAddress, params.position, balanceNow);
}

/**
 * Redeems a negative risk (spread/multi-outcome) position via NegRiskAdapter.
 * NegRiskAdapter.redeemPositions(conditionId, amounts) handles CTF internally and returns USDC.
 */
async function redeemNegRisk(
  privateKey: string,
  proxyAddress: string,
  position: ActivePosition,
  onChainBalance: ethers.BigNumber,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const negIface = new ethers.utils.Interface(NEG_RISK_ADAPTER_ABI);
  const ctfIface = new ethers.utils.Interface(CTF_ABI);
  const conditionId = position.conditionId;

  // Abort early if relayer is rate-limited
  if (await isRelayerBackedOff()) {
    const waitSec = await getRelayerBackoffRemaining();
    logger.info(`[redeem] Skipping NegRiskAdapter — relayer rate-limited for ${waitSec}s more`);
    return { success: false, error: `Relayer rate-limited, retry in ${waitSec}s` };
  }

  // effectiveOutcomeIndex may flip on subtraction overflow (Data API mismatch)
  let effectiveOutcomeIndex = position.outcomeIndex;
  let outcomeFlipped = false;
  const txTypes = [RelayerTxType.SAFE, RelayerTxType.PROXY];

  for (let ti = 0; ti < txTypes.length; ti++) {
    const txType = txTypes[ti];
    try {
      // Re-check backoff before each attempt (previous attempt may have triggered it)
      if (await isRelayerBackedOff()) break;

      // Re-check on-chain balance before EACH attempt to avoid "subtraction overflow"
      // when a previous attempt already redeemed (partially or fully).
      const currentBalance = await getOnChainTokenBalance(proxyAddress, position.asset);
      if (currentBalance.isZero()) {
        logger.info(`[redeem] ${txType}/NegRiskAdapter: balance is now 0, position already redeemed`);
        return { success: true, txHash: undefined };
      }

      // Also fetch opposite side balance from on-chain (don't assume 0)
      let currentOpposite = ethers.BigNumber.from(0);
      if (position.oppositeAsset) {
        currentOpposite = await getOnChainTokenBalance(proxyAddress, position.oppositeAsset);
      }

      // Build amounts using actual on-chain balances.
      // effectiveOutcomeIndex determines which slot gets which balance.
      // If Data API outcomeIndex is wrong, the flip-on-overflow logic below corrects it.
      const amounts = [ethers.BigNumber.from(0), ethers.BigNumber.from(0)];
      amounts[effectiveOutcomeIndex] = currentBalance;
      amounts[1 - effectiveOutcomeIndex] = currentOpposite;

      const approveData = ctfIface.encodeFunctionData('setApprovalForAll', [NEG_RISK_ADAPTER, true]);
      const redeemData = negIface.encodeFunctionData('redeemPositions', [conditionId, amounts]);
      const txPayload = [
        { to: CTF_ADDRESS, data: approveData, value: '0' },
        { to: NEG_RISK_ADAPTER, data: redeemData, value: '0' },
      ];

      logger.info(`[redeem] Trying ${txType}/NegRiskAdapter: conditionId=${conditionId.slice(0, 18)}... outcome=${position.outcome} outcomeIdx=${effectiveOutcomeIndex}${outcomeFlipped ? '(flipped)' : ''} amounts=[${amounts[0].toString()},${amounts[1].toString()}]`);

      const relayClient = createRelayClient(privateKey, txType);

      const response = await Promise.race([
        relayClient.execute(txPayload),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('relay execute timeout')), 30_000)
        ),
      ]);

      if (!response) {
        logger.warn(`[redeem] ${txType}/NegRiskAdapter: no response from relayer`);
        continue;
      }

      logger.info(`[redeem] ${txType}/NegRiskAdapter response: id=${response.transactionID} state=${response.state} hash=${response.transactionHash || 'none'}`);

      const result = await Promise.race([
        response.wait(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('confirmation timeout')), 60_000)
        ),
      ]);

      if (!result) {
        try {
          const txInfo = await response.getTransaction();
          logger.warn(`[redeem] ${txType}/NegRiskAdapter STATE_FAILED: ${JSON.stringify(txInfo).slice(0, 400)}`);
        } catch { /* ignore */ }
        logger.warn(`[redeem] ${txType}/NegRiskAdapter: relay tx failed (STATE_FAILED)`);
        continue;
      }

      const txHash = result.transactionHash;
      if (!txHash) {
        logger.warn(`[redeem] ${txType}/NegRiskAdapter: result has no transactionHash, state=${result.state}`);
        continue;
      }

      const verified = await verifyTxOnChain(txHash);
      if (!verified) {
        logger.warn(`[redeem] ${txType}/NegRiskAdapter: tx ${txHash} on-chain verification FAILED`);
        continue;
      }

      // Verify CTF tokens were actually burned
      const balanceAfter = await getOnChainTokenBalance(proxyAddress, position.asset);
      if (balanceAfter.gte(currentBalance)) {
        logger.warn(`[redeem] ${txType}/NegRiskAdapter: tx succeeded but CTF balance unchanged (${balanceAfter.toString()})`);
        continue;
      }

      await incrementRelayerCount();
      logger.info(`[redeem] Confirmed via ${txType}/NegRiskAdapter: ${txHash} (balance: ${currentBalance.toString()} → ${balanceAfter.toString()})`);
      return { success: true, txHash };
    } catch (error: any) {
      const errMsg = error?.message ?? '';
      if (isRateLimitError(errMsg)) {
        await setRelayerBackoff(errMsg);
        break; // Stop trying — relayer is exhausted
      }
      // Detect "subtraction overflow" — amounts don't match on-chain token→slot mapping.
      // Most likely cause: Data API outcomeIndex doesn't match NegRiskAdapter's internal slot order.
      // Fix: flip the outcomeIndex and restart the tx type loop from SAFE.
      if (/subtraction overflow/i.test(errMsg)) {
        const freshBalance = await getOnChainTokenBalance(proxyAddress, position.asset);
        if (freshBalance.isZero()) {
          logger.info(`[redeem] Position already fully redeemed (balance now 0)`);
          return { success: true, txHash: undefined };
        }
        if (!outcomeFlipped) {
          effectiveOutcomeIndex = 1 - effectiveOutcomeIndex;
          outcomeFlipped = true;
          logger.warn(`[redeem] ${txType}/NegRiskAdapter: SafeMath subtraction overflow — flipping outcomeIndex to ${effectiveOutcomeIndex} and restarting`);
          ti = -1; // will become 0 after loop increment → restart from SAFE
          continue;
        }
        logger.warn(`[redeem] ${txType}/NegRiskAdapter: SafeMath subtraction overflow persists after flip — skipping`);
        continue;
      }
      logger.warn(`[redeem] ${txType}/NegRiskAdapter attempt failed: ${errMsg.slice(0, 200)}`);
      // Short delay between tx type attempts to avoid hammering
      await new Promise(r => setTimeout(r, 2_000));
      continue;
    }
  }

  return { success: false, error: (await isRelayerBackedOff()) ? 'Relayer rate-limited' : 'NegRiskAdapter redemption failed with all tx types' };
}

/**
 * Redeems a standard (non-negative-risk) position via CTF.redeemPositions.
 * Tries USDC.e first (legacy), then native USDC (post-migration).
 */
async function redeemStandard(
  privateKey: string,
  proxyAddress: string,
  position: ActivePosition,
  onChainBalance: ethers.BigNumber,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  // Abort early if relayer is rate-limited
  if (await isRelayerBackedOff()) {
    const waitSec = await getRelayerBackoffRemaining();
    logger.info(`[redeem] Skipping standard redeem — relayer rate-limited for ${waitSec}s more`);
    return { success: false, error: `Relayer rate-limited, retry in ${waitSec}s` };
  }

  const iface       = new ethers.utils.Interface(CTF_ABI);
  const conditionId = position.conditionId;

  for (const collateralToken of [USDC_E_POLYGON, NATIVE_USDC_POLYGON]) {
    // Re-check backoff before each collateral attempt
    if (await isRelayerBackedOff()) break;

    const callData = iface.encodeFunctionData('redeemPositions', [
      collateralToken,
      ethers.constants.HashZero,
      conditionId,
      [1, 2],
    ]);
    const txPayload = [{ to: CTF_ADDRESS, data: callData, value: '0' }];
    const tokenLabel = collateralToken === USDC_E_POLYGON ? 'USDC.e' : 'native USDC';

    for (const txType of [RelayerTxType.SAFE, RelayerTxType.PROXY]) {
      // Re-check backoff before each tx type attempt
      if (await isRelayerBackedOff()) break;

      try {
        logger.info(
          `[redeem] Trying ${txType}/${tokenLabel}: conditionId=${conditionId.slice(0, 18)}... outcome=${position.outcome}`
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

        const verified = await verifyTxOnChain(txHash);
        if (!verified) {
          logger.warn(`[redeem] ${txType}/${tokenLabel}: relayer returned tx ${txHash} but on-chain verification FAILED`);
          continue;
        }

        // Verify CTF tokens were actually burned (balance decreased)
        const balanceAfter = await getOnChainTokenBalance(proxyAddress, position.asset);
        if (balanceAfter.gte(onChainBalance)) {
          logger.warn(`[redeem] ${txType}/${tokenLabel}: tx succeeded but CTF balance unchanged (${balanceAfter.toString()}) — wrong collateral token, trying next`);
          break; // break inner loop (txType), continue outer loop (collateralToken)
        }

        await incrementRelayerCount();
        logger.info(`[redeem] Confirmed via ${txType}/${tokenLabel} Relayer: ${txHash} (balance: ${onChainBalance.toString()} → ${balanceAfter.toString()})`);
        return { success: true, txHash };
      } catch (error: any) {
        const errMsg = error?.message ?? '';
        if (isRateLimitError(errMsg)) {
          await setRelayerBackoff(errMsg);
          break; // Stop trying — relayer is exhausted
        }
        logger.warn(`[redeem] ${txType}/${tokenLabel} attempt failed: ${errMsg.slice(0, 200)}`);
        // Short delay between tx type attempts to avoid hammering
        await new Promise(r => setTimeout(r, 2_000));
        continue;
      }
    }
    if (await isRelayerBackedOff()) break;
    logger.info(`[redeem] ${tokenLabel} did not redeem, trying next collateral token...`);
  }

  return { success: false, error: (await isRelayerBackedOff()) ? 'Relayer rate-limited' : 'Redemption failed with all collateral token variants' };
}

function normId(s: string | undefined | null): string {
  if (!s) return '';
  const t = s.trim().toLowerCase();
  return t.startsWith('0x') ? t.slice(2) : t;
}

function isPredexonClaimable(p: PredexonPosition): boolean {
  if (p.status === 'redeemable') return true;
  if (p.status === 'resolved' && p.result === 'won') return true;
  return false;
}

function findPredexonRedeemable(
  position: ActivePosition,
  candidates: PredexonPosition[],
): { match?: PredexonPosition; idMatches: PredexonPosition[] } {
  const assetN = normId(position.asset);
  const condN = normId(position.conditionId);
  const idMatches = candidates.filter(
    p => (p.tokenId && normId(p.tokenId) === assetN) ||
         (p.marketIdentifier && normId(p.marketIdentifier) === condN),
  );
  return { match: idMatches.find(isPredexonClaimable), idMatches };
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
      const { match, idMatches } = findPredexonRedeemable(params.position, predexonPositions);
      if (match?.tokenId) {
        const matchedBy = normId(match.tokenId) === normId(params.position.asset) ? 'tokenId' : 'marketIdentifier';
        logger.info(`[redeem] Using Predexon API for tokenId=${match.tokenId} venue=${match.venue} status=${match.status} result=${match.result ?? '-'} (matched by ${matchedBy})`);
        const result = await redeemPositionPredexon(params.predexonUserId, match.tokenId, match.venue || 'polymarket');
        logger.info(`[redeem] Predexon redeem response: ${JSON.stringify(result).slice(0, 400)}`);

        if (result.status === 'completed' && result.transactionHash) {
          // Verify the transaction actually succeeded on-chain
          const verified = await verifyTxOnChain(result.transactionHash);
          if (verified) {
            logger.info(`[redeem] Predexon redeem completed: amountRedeemed=${result.amountRedeemed} sizeRedeemed=${result.sizeRedeemed} result=${result.result}`);
            return { success: true, txHash: result.transactionHash };
          }
          logger.warn(`[redeem] Predexon returned tx ${result.transactionHash} but on-chain verification FAILED`);
        } else if (result.transactionHash) {
          // Has tx hash but status is not 'completed'
          const verified = await verifyTxOnChain(result.transactionHash);
          if (verified) {
            logger.info(`[redeem] Predexon redeem status=${result.status} but tx verified on-chain`);
            return { success: true, txHash: result.transactionHash };
          }
          logger.warn(`[redeem] Predexon returned tx ${result.transactionHash} with status=${result.status}, on-chain verification FAILED`);
        } else {
          logger.warn(`[redeem] Predexon redeem returned status=${result.status} with no transactionHash`);
        }
      } else if (idMatches.length > 0) {
        const statuses = idMatches.map(p => `${p.status}${p.result ? '/' + p.result : ''}`).join(',');
        logger.info(`[redeem] Predexon has position by id but not claimable (statuses=${statuses}), falling back to relayer`);
      } else {
        logger.info(`[redeem] No Predexon position matches asset=${params.position.asset.slice(0,20)}... or conditionId=${params.position.conditionId.slice(0,18)}... (scanned ${predexonPositions.length}), falling back to relayer`);
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
  for (let i = 0; i < pending.length; i++) {
    const pos = pending[i];
    // Abort auto-redeem loop if relayer is rate-limited
    if (await isRelayerBackedOff()) {
      logger.warn(`[redeem] Relayer rate-limited, stopping auto-redeem loop (${pending.length - i} remaining)`);
      break;
    }
    // Proactive throttle: add delay when approaching hourly quota
    const throttleMs = await getThrottleDelay();
    if (throttleMs < 0) {
      logger.warn(`[redeem] Hourly relayer limit reached, stopping auto-redeem loop (${pending.length - i} remaining)`);
      break;
    }
    if (throttleMs > 0) {
      logger.info(`[redeem] Throttling ${throttleMs}ms before next relayer call (approaching quota)`);
      await new Promise(r => setTimeout(r, throttleMs));
    }
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
        // Stop loop if rate-limited
        if (result.error && /rate.?limit/i.test(result.error)) break;
      }
    } catch (err: any) {
      logger.error(`[redeem] Unexpected error for ${pos.conditionId}:`, err?.message);
    }
    // Delay between positions to avoid rate limiting
    if (i < pending.length - 1) {
      await new Promise(r => setTimeout(r, 3_000));
    }
  }

  return claimed;
}
