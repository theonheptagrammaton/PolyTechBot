import { logger } from '../utils/logger';
import {
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
 * Instead of deploying a Gnosis Safe proxy, creating CLOB API keys,
 * and sending 9 approval transactions, Predexon handles all of this
 * with a single API call. No Builder API quota limits.
 *
 * @param _privateKey - Local EOA private key (no longer needed for setup but kept for signature)
 * @param eoaAddress - Local EOA address for reference
 */
export async function setupPolymarketAccount(
  _privateKey: string,
  eoaAddress?: string,
): Promise<PolymarketSetupResult> {
  try {
    logger.info('=== Starting Polymarket Account Setup via Predexon ===');

    // Step 1: Create Predexon user (managed wallet + proxy + approvals)
    logger.info('Step 1: Creating Predexon user (managed wallet)...');
    const predexonUser: PredexonUser = await createAndWaitForUser();
    logger.info(`✅ Predexon user ready: ${predexonUser.userId}`);
    logger.info(`   Polymarket wallet: ${predexonUser.polymarketWalletAddress}`);

    // Step 2: Get deposit addresses via Predexon Bridge API
    logger.info('Step 2: Fetching deposit addresses via Predexon Bridge...');
    let depositAddresses: DepositAddresses;
    try {
      const bridgeInfo = await getBridgeDeposit(predexonUser.polymarketWalletAddress);
      depositAddresses = {
        evm: bridgeInfo.depositAddresses.evm,
        svm: bridgeInfo.depositAddresses.solana,
        btc: bridgeInfo.depositAddresses.bitcoin,
        tvm: '', // Predexon bridge may not support Tron; fallback empty
      };
      logger.info('✅ Deposit addresses fetched');
      logger.info(`   EVM: ${depositAddresses.evm}`);
      logger.info(`   Solana: ${depositAddresses.svm}`);
      logger.info(`   Bitcoin: ${depositAddresses.btc}`);
    } catch (bridgeErr) {
      // Bridge is optional — user can still deposit directly to Polygon wallet
      logger.warn('Bridge deposit addresses unavailable, using direct Polygon deposit:', bridgeErr);
      depositAddresses = {
        evm: predexonUser.polymarketWalletAddress,
        svm: '',
        btc: '',
        tvm: '',
      };
    }

    logger.info('=== Polymarket Account Setup Complete (via Predexon) ===');

    return {
      predexonUserId: predexonUser.userId,
      proxyAddress: predexonUser.polymarketWalletAddress,
      eoaAddress: eoaAddress || '',
      depositAddresses,
      // Legacy fields — new users don't use CLOB credentials
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
 * Returns null if not found (triggers lazy migration).
 */
export async function getExistingProxyAddress(_privateKey: string): Promise<string | null> {
  // For Predexon users, the proxy address is always stored at creation time.
  // This function is kept for backward compatibility with old code paths.
  return null;
}
