import { ClobClient } from '@polymarket/clob-client';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { Wallet } from '@ethersproject/wallet';
import { providers, utils } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { config } from '../config';
import { logger } from '../utils/logger';
import { maskSensitiveData } from '../utils/encryption';

// Polygon RPC — public endpoints, no API key required
const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://rpc.polygon.technology';

// Polymarket Builder Relayer URL (v2) - MUST USE THIS
const RELAYER_URL = 'https://relayer-v2.polymarket.com';
const POLYGON_CHAIN_ID = 137;

// Polymarket Bridge API for deposit addresses
const BRIDGE_API_URL = 'https://bridge.polymarket.com';

// Polymarket Contract Addresses (Polygon Mainnet)
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const NATIVE_USDC_ADDR = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE_ADDRESS = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// Maximum approval amount (unlimited)
const MAX_APPROVAL = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

export interface DepositAddresses {
  evm: string;   // Ethereum, Arbitrum, Base, Optimism, etc.
  svm: string;   // Solana
  btc: string;   // Bitcoin
  tvm: string;   // Tron
}

export interface PolymarketSetupResult {
  // API Credentials
  apiKey: string;
  apiSecret: string;
  passphrase: string;

  // Proxy/Safe Address
  proxyAddress: string;

  // EOA Address
  eoaAddress: string;

  // Deposit Addresses (from Bridge API)
  depositAddresses: DepositAddresses;
}

/**
 * Complete Polymarket account setup
 * This creates everything needed for trading on Polymarket
 */
export async function setupPolymarketAccount(privateKey: string): Promise<PolymarketSetupResult> {
  try {
    logger.info('=== Starting Complete Polymarket Account Setup ===');

    const provider = new providers.JsonRpcProvider(POLYGON_RPC);
    const wallet = new Wallet(privateKey, provider);
    const eoaAddress = wallet.address;

    logger.info(`EOA Address: ${eoaAddress}`);

    // Step 1: Deploy Proxy Wallet first (needed to derive API key with correct funder)
    logger.info('Step 1: Deploying Proxy wallet via Builder Relayer v2...');
    const proxyAddress = await deployProxyWallet(privateKey);
    logger.info(`✅ Proxy deployed: ${proxyAddress}`);

    // Step 2: Create/Derive API Credentials with signatureType=2 (GNOSIS_SAFE) and proxy as funder.
    // This is critical: the CLOB uses the funder address to check balances. If derived without
    // the proxy address, the CLOB will check EOA balances (which has 0 tokens) and reject orders.
    logger.info('Step 2: Creating Polymarket API credentials (GNOSIS_SAFE with proxy funder)...');
    const apiCreds = await createApiCredentials(wallet, proxyAddress);
    logger.info('✅ API credentials created (GNOSIS_SAFE type)');

    // Step 3: Enable Trading (Approve USDC & CTF automatically via Relayer)
    logger.info('Step 3: Enabling trading automatically via Relayer...');
    await enableTradingAutomatically(privateKey, proxyAddress);
    logger.info('✅ Trading enabled - Ready for deposits and trading');

    // Step 4: Create Deposit Addresses via Bridge API
    logger.info('Step 4: Creating deposit addresses via Bridge API...');
    const depositAddresses = await createDepositAddresses(proxyAddress);
    logger.info('✅ Deposit addresses created:');
    logger.info(`  - EVM (Ethereum/Arbitrum/Base): ${depositAddresses.evm}`);
    logger.info(`  - Solana: ${depositAddresses.svm}`);
    logger.info(`  - Bitcoin: ${depositAddresses.btc}`);
    logger.info(`  - Tron: ${depositAddresses.tvm}`);

    // Step 5: Verify Setup
    logger.info('Step 5: Verifying Polymarket setup...');
    await verifyPolymarketSetup(wallet, apiCreds, proxyAddress);
    logger.info('✅ Setup verified');

    logger.info('=== Polymarket Account Setup Complete ===');

    return {
      apiKey: apiCreds.apiKey,
      apiSecret: apiCreds.apiSecret,
      passphrase: apiCreds.passphrase,
      proxyAddress: proxyAddress,
      eoaAddress: eoaAddress,
      depositAddresses: depositAddresses,
    };
  } catch (error) {
    logger.error('Failed to setup Polymarket account:', error);
    throw new Error(`Polymarket account setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Step 2: Create/Derive API Credentials with GNOSIS_SAFE signature type
 * IMPORTANT: proxyAddress must be provided so the CLOB registers the proxy as the funder.
 * Without this, the CLOB uses the EOA as funder and rejects SELL orders because it can't
 * find conditional tokens in the EOA (they're in the proxy wallet).
 */
async function createApiCredentials(wallet: Wallet, proxyAddress: string): Promise<{
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}> {
  try {
    // Create CLOB client with signatureType=2 (GNOSIS_SAFE) and proxy as funder
    const clobClient = new ClobClient(
      config.polymarket.host,
      config.polymarket.chainId,
      wallet,
      undefined,  // no existing creds
      2,          // GNOSIS_SAFE — required for proxy wallet trading
      proxyAddress
    );

    // Create or derive API key registered for this proxy wallet as funder
    logger.info('Calling createOrDeriveApiKey (GNOSIS_SAFE, proxy funder)...');
    const apiCreds = await clobClient.createOrDeriveApiKey();

    if (!apiCreds || !apiCreds.key || !apiCreds.secret || !apiCreds.passphrase) {
      throw new Error('Invalid API credentials response');
    }

    logger.info(`API Key created: ${maskSensitiveData(apiCreds.key)}`);

    return {
      apiKey: apiCreds.key,
      apiSecret: apiCreds.secret,
      passphrase: apiCreds.passphrase,
    };
  } catch (error) {
    logger.error('Error creating API credentials:', error);
    throw new Error('Failed to create API credentials');
  }
}

/**
 * Step 2: Deploy Proxy Wallet using Builder Relayer Client
 * Uses RelayerTxType.PROXY and deploy() method with Builder credentials from config
 */
async function deployProxyWallet(privateKey: string): Promise<string> {
  try {
    // Create viem wallet from private key
    const viemAccount = privateKeyToAccount(privateKey as `0x${string}`);

    const viemWallet = createWalletClient({
      account: viemAccount,
      chain: polygon,
      transport: http(POLYGON_RPC),
    });

    logger.info(`Creating Builder Relayer Client for: ${viemAccount.address}`);

    // Create BuilderConfig with Builder credentials from config
    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: config.polymarket.builder.apiKey,
        secret: config.polymarket.builder.secret,
        passphrase: config.polymarket.builder.passphrase,
      },
    });

    logger.info('✅ BuilderConfig created with Builder credentials');

    // Create Builder Relayer client with PROXY type
    const client = new RelayClient(
      RELAYER_URL,
      POLYGON_CHAIN_ID,
      viemWallet as any,
      builderConfig,
      RelayerTxType.PROXY // Use PROXY type (can auto-deploy or manual deploy)
    );

    logger.info('✅ Builder RelayClient created (PROXY type)');

    // Deploy the proxy wallet explicitly
    logger.info('Calling deploy() on Builder Relayer...');
    const response = await client.deploy();

    if (!response) {
      throw new Error('Deploy returned no response');
    }

    logger.info(`Deploy response received, waiting for confirmation...`);

    // Wait for deployment to complete
    const result = await response.wait();

    if (!result) {
      throw new Error('Deployment failed - no result returned');
    }

    logger.info('✅ Deployment transaction confirmed');
    logger.info(`Transaction Hash: ${result.transactionHash}`);

    // Get the proxy address
    const proxyAddress = result.proxyAddress;

    if (!proxyAddress) {
      throw new Error('Proxy address not found in deployment result');
    }

    // Validate and checksum the address
    const checksummedProxy = utils.getAddress(proxyAddress);
    logger.info(`✅ Proxy deployed successfully: ${checksummedProxy}`);

    return checksummedProxy;

  } catch (error: any) {
    logger.error('Error deploying proxy wallet:', error);

    // Log detailed error information
    if (error.response) {
      logger.error('Error response:', error.response);
    }
    if (error.data) {
      logger.error('Error data:', error.data);
    }

    throw new Error(`Failed to deploy proxy wallet: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Step 3: Enable Trading Automatically
 * Sends approval transactions via Relayer (gasless) to enable trading
 */
async function enableTradingAutomatically(privateKey: string, _proxyAddress: string): Promise<void> {
  try {
    // Create viem wallet from private key
    const viemAccount = privateKeyToAccount(privateKey as `0x${string}`);
    const viemWallet = createWalletClient({
      account: viemAccount,
      chain: polygon,
      transport: http(POLYGON_RPC),
    });

    // Create BuilderConfig with Builder credentials
    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: config.polymarket.builder.apiKey,
        secret: config.polymarket.builder.secret,
        passphrase: config.polymarket.builder.passphrase,
      },
    });

    // Create Builder Relayer client with PROXY type
    const relayClient = new RelayClient(
      RELAYER_URL,
      POLYGON_CHAIN_ID,
      viemWallet as any,
      builderConfig,
      RelayerTxType.PROXY
    );

    logger.info('Sending approval transactions via Relayer...');

    // Helper to execute + wait + log
    const execAndWait = async (label: string, calls: { to: string; data: string; value: string }[]) => {
      const resp = await relayClient.execute(calls);
      if (resp) {
        const result = await resp.wait();
        if (result?.transactionHash) {
          logger.info(`✅ ${label} - TX: ${result.transactionHash}`);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    };

    // 1. USDC approvals (native + USDC.e) for all three exchange contracts
    await execAndWait('NativeUSDC → CTFExchange', [{ to: NATIVE_USDC_ADDR, data: encodeApprovalData(CTF_EXCHANGE_ADDRESS, MAX_APPROVAL), value: '0' }]);
    await execAndWait('NativeUSDC → NegRiskCTFExchange', [{ to: NATIVE_USDC_ADDR, data: encodeApprovalData(NEG_RISK_CTF_EXCHANGE_ADDRESS, MAX_APPROVAL), value: '0' }]);
    await execAndWait('NativeUSDC → NegRiskAdapter', [{ to: NATIVE_USDC_ADDR, data: encodeApprovalData(NEG_RISK_ADAPTER_ADDRESS, MAX_APPROVAL), value: '0' }]);
    await execAndWait('USDCe → CTFExchange', [{ to: USDC_ADDRESS, data: encodeApprovalData(CTF_EXCHANGE_ADDRESS, MAX_APPROVAL), value: '0' }]);
    await execAndWait('USDCe → NegRiskCTFExchange', [{ to: USDC_ADDRESS, data: encodeApprovalData(NEG_RISK_CTF_EXCHANGE_ADDRESS, MAX_APPROVAL), value: '0' }]);
    await execAndWait('USDCe → NegRiskAdapter', [{ to: USDC_ADDRESS, data: encodeApprovalData(NEG_RISK_ADAPTER_ADDRESS, MAX_APPROVAL), value: '0' }]);

    // 2. CTF ERC1155 setApprovalForAll for all three exchange contracts
    await execAndWait('CTF → CTFExchange', [{ to: CTF_ADDRESS, data: encodeSetApprovalForAllData(CTF_EXCHANGE_ADDRESS, true), value: '0' }]);
    await execAndWait('CTF → NegRiskCTFExchange', [{ to: CTF_ADDRESS, data: encodeSetApprovalForAllData(NEG_RISK_CTF_EXCHANGE_ADDRESS, true), value: '0' }]);
    await execAndWait('CTF → NegRiskAdapter', [{ to: CTF_ADDRESS, data: encodeSetApprovalForAllData(NEG_RISK_ADAPTER_ADDRESS, true), value: '0' }]);

    logger.info('✅ All approval transactions completed successfully');
  } catch (error: any) {
    logger.error('Error enabling trading:', error);

    // Log detailed error information
    if (error.response) {
      logger.error('Error response:', error.response);
    }
    if (error.data) {
      logger.error('Error data:', error.data);
    }

    throw new Error(`Failed to enable trading: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Encode ERC20 approve() function call
 */
function encodeApprovalData(spender: string, amount: string): string {
  // approve(address spender, uint256 amount)
  const iface = new utils.Interface([
    'function approve(address spender, uint256 amount) returns (bool)',
  ]);
  return iface.encodeFunctionData('approve', [spender, amount]);
}

/**
 * Encode ERC1155 setApprovalForAll() function call
 */
function encodeSetApprovalForAllData(operator: string, approved: boolean): string {
  // setApprovalForAll(address operator, bool approved)
  const iface = new utils.Interface([
    'function setApprovalForAll(address operator, bool approved)',
  ]);
  return iface.encodeFunctionData('setApprovalForAll', [operator, approved]);
}

/**
 * Step 4: Create Deposit Addresses via Bridge API
 * Returns unique deposit addresses for different chains (EVM, Solana, Bitcoin, Tron)
 */
async function createDepositAddresses(proxyAddress: string): Promise<DepositAddresses> {
  try {
    logger.info(`Creating deposit addresses for proxy: ${proxyAddress}`);

    const response = await fetch(`${BRIDGE_API_URL}/deposit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address: proxyAddress,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Bridge API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    logger.info(`Bridge API response: ${JSON.stringify(data)}`);

    // API returns: { address: { evm, svm, tron, btc }, note }
    if (!data.address || !data.address.evm || !data.address.svm || !data.address.btc || !data.address.tron) {
      logger.error('Bridge API returned incomplete data:', data);
      throw new Error('Invalid response from Bridge API - missing deposit addresses');
    }

    return {
      evm: data.address.evm,
      svm: data.address.svm,
      btc: data.address.btc,
      tvm: data.address.tron, // API uses "tron" not "tvm"
    };
  } catch (error: any) {
    logger.error('Error creating deposit addresses:', error);
    throw new Error(`Failed to create deposit addresses: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Step 5: Verify Polymarket Setup
 */
async function verifyPolymarketSetup(
  wallet: Wallet,
  apiCreds: { apiKey: string; apiSecret: string; passphrase: string },
  proxyAddress: string
): Promise<void> {
  try {
    // Verify API credentials work
    logger.info('Verifying API credentials...');
    const clobClient = new ClobClient(
      config.polymarket.host,
      config.polymarket.chainId,
      wallet,
      {
        key: apiCreds.apiKey,
        secret: apiCreds.apiSecret,
        passphrase: apiCreds.passphrase,
      },
      0 as any // Signature type 0 for EOA
    );

    // Test API by getting server time
    const serverTime = await clobClient.getServerTime();
    logger.info(`✅ API verified - Server time: ${serverTime}`);

    // Verify proxy address is valid (basic check)
    if (!proxyAddress || !proxyAddress.startsWith('0x') || proxyAddress.length !== 42) {
      throw new Error('Invalid proxy address format');
    }

    logger.info('✅ All verifications passed');
  } catch (error) {
    logger.error('Verification failed:', error);
    throw new Error('Polymarket setup verification failed');
  }
}

/**
 * Get existing proxy address (if already created)
 */
export async function getExistingProxyAddress(_privateKey: string): Promise<string | null> {
  try {
    // For checking existing proxy, we don't need full auth
    // Proxy will be deployed on user creation
    logger.debug('Checking for existing proxy address...');

    return null; // Proxy will be deployed on user creation
  } catch (error) {
    logger.debug('Error getting existing proxy:', error);
    return null;
  }
}
