import { logger } from '../utils/logger';
import {
  createPredexonUser,
  createAndWaitForUser,
  getBridgeDeposit,
  type PredexonUser,
} from './predexon';

export interface DepositAddresses {
  evm: string;   // Ethereum, Arbitrum, Base, Optimism, etc.
  svm: string;   // Solana
  btc: string;   // Bitcoin
  tvm: string;   // Tron
}

export interface PolymarketSetupResult {
  // Predexon managed user
  predexonUserId: string;

  // Polymarket wallet address (managed by Predexon/Turnkey)
  proxyAddress: string;

  // EOA Address (local wallet — used for commission transfers & other chain ops)
  eoaAddress: string;

  // Deposit Addresses (from Predexon Bridge API)
  depositAddresses: DepositAddresses;

  // Legacy fields — kept for backward compat but no longer used for new users
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

/**
 * Complete Polymarket account setup via Predexon Trading API.
 *
 * Flow:
 * 1. Create Predexon user (returns immediately with status "provisioning")
 * 2. Try to wait up to 180s for "ready" status
 * 3. If still provisioning, save anyway — wallet will be ready by first trade
 * 4. Fetch bridge deposit addresses (or fallback to direct Polygon deposit)
 */
export async function setupPolymarketAccount(
  _privateKey: string,
  eoaAddress?: string,
): Promise<PolymarketSetupResult> {
  try {
    logger.info('=== Starting Polymarket Account Setup via Predexon ===');

    // Step 1: Create Predexon user and wait for provisioning
    logger.info('Step 1: Creating Predexon user (managed wallet)...');
    let predexonUser: PredexonUser;

    try {
      predexonUser = await createAndWaitForUser(180_000); // 3 min max
      logger.info(`✅ Predexon user ready: ${predexonUser.userId}`);
    } catch (waitErr: any) {
      // If timeout, check if user was at least created
      if (waitErr.message?.includes('timed out')) {
        // Create a fresh user and return immediately — provisioning continues in background
        logger.warn('Predexon provisioning slow, creating user and continuing...');
        predexonUser = await createPredexonUser();
        logger.info(`⏳ Predexon user created (still provisioning): ${predexonUser.userId}`);
      } else {
        throw waitErr;
      }
    }

    const walletAddress = predexonUser.polymarketWalletAddress || '';
    logger.info(`   Polymarket wallet: ${walletAddress || '(pending)'}`);

    // Step 2: Get deposit addresses via Predexon Bridge API
    let depositAddresses: DepositAddresses;
    if (walletAddress) {
      logger.info('Step 2: Fetching deposit addresses via Predexon Bridge...');
      try {
        const bridgeInfo = await getBridgeDeposit(walletAddress);
        depositAddresses = {
          evm: bridgeInfo.depositAddresses.evm,
          svm: bridgeInfo.depositAddresses.solana,
          btc: bridgeInfo.depositAddresses.bitcoin,
          tvm: '',
        };
        logger.info('✅ Deposit addresses fetched');
      } catch (bridgeErr) {
        logger.warn('Bridge deposit addresses unavailable, using direct Polygon deposit:', bridgeErr);
        depositAddresses = { evm: walletAddress, svm: '', btc: '', tvm: '' };
      }
    } else {
      // Wallet not ready yet — deposit addresses will be fetched later
      depositAddresses = { evm: '', svm: '', btc: '', tvm: '' };
    }

    logger.info('=== Polymarket Account Setup Complete (via Predexon) ===');

    return {
      predexonUserId: predexonUser.userId,
      proxyAddress: walletAddress,
      eoaAddress: eoaAddress || '',
      depositAddresses,
      apiKey: 'predexon-managed',
      apiSecret: 'predexon-managed',
      passphrase: 'predexon-managed',
    };
  } catch (error) {
    logger.error('Failed to setup Polymarket account via Predexon:', error);
    throw new Error(`Polymarket account setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get existing proxy address — for Predexon users this is stored in DB.
 */
export async function getExistingProxyAddress(_privateKey: string): Promise<string | null> {
  return null;
}
