import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { logger } from '../utils/logger';
import { decrypt } from '../utils/encryption';
import { redisCache } from '../database/redis';

const CACHE_TTL = 60; // 1 minute cache for portfolio data

export interface OpenOrder {
  id: string;
  status: string;
  owner: string;
  maker_address: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  size_matched: string;
  price: string;
  associate_trades: string[];
  outcome: string;
  created_at: number;
  expiration: string;
  order_type: string;
}

export interface Trade {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: string;
  size: string;
  fee_rate_bps: string;
  price: string;
  status: string;
  match_time: string;
  last_update: string;
  outcome: string;
  bucket_index: number;
  owner: string;
  maker_address: string;
  transaction_hash: string;
  trader_side?: string;
}

export interface Position {
  asset_id: string;
  market_id?: string;
  market?: string;
  outcome?: string;
  size: string; // Number of shares
  cost_basis?: string;
  realized_pnl?: string;
  unrealized_pnl?: string;
}

export interface PortfolioData {
  openOrders: OpenOrder[];
  trades: Trade[];
  activePositions: Position[]; // Positions I currently hold (size > 0)
  closedPositions: Position[]; // Positions I exited or settled
  balance: string;
}

/**
 * Creates CLOB client for user
 */
async function createClobClientForUser(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<ClobClient> {
  try {
    // Decrypt credentials
    const decryptedPrivateKey = decrypt(privateKey);
    const decryptedApiKey = decrypt(apiKey);
    const decryptedApiSecret = decrypt(apiSecret);
    const decryptedPassphrase = decrypt(passphrase);

    // Create wallet
    const wallet = new Wallet(decryptedPrivateKey);

    // Create CLOB client with POLY_PROXY signature type
    // Type 2 = POLY_PROXY (Gnosis Safe with EOA signer)
    const client = new ClobClient(
      'https://clob.polymarket.com',
      137, // Polygon mainnet
      wallet, // EOA wallet (signer)
      {
        key: decryptedApiKey,
        secret: decryptedApiSecret,
        passphrase: decryptedPassphrase,
      },
      2 // Signature type 2 for POLY_PROXY (Safe with EOA signer)
    );

    return client;
  } catch (error) {
    logger.error('Error creating CLOB client:', error);
    throw new Error('Failed to create CLOB client');
  }
}

/**
 * Gets user's open orders (active positions)
 */
export async function getOpenOrders(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<OpenOrder[]> {
  try {
    const cacheKey = `portfolio:open_orders:${privateKey.substring(0, 20)}`;
    const cached = await redisCache.get<OpenOrder[]>(cacheKey);

    if (cached) {
      logger.debug('Returning cached open orders');
      return cached;
    }

    logger.info('Fetching open orders from CLOB API');

    const client = await createClobClientForUser(privateKey, apiKey, apiSecret, passphrase);
    const openOrders = await client.getOpenOrders();

    // Filter only LIVE orders
    const liveOrders = openOrders.filter((order: OpenOrder) => order.status === 'LIVE');

    await redisCache.set(cacheKey, liveOrders, CACHE_TTL);

    logger.info(`Fetched ${liveOrders.length} open orders`);
    return liveOrders;
  } catch (error) {
    logger.error('Error fetching open orders:', error);
    // Return empty array instead of throwing to gracefully handle no positions
    return [];
  }
}

/**
 * Gets user's active positions (shares in markets)
 */
export async function getPositions(
  privateKey: string,
  _apiKey: string,
  _apiSecret: string,
  _passphrase: string
): Promise<Position[]> {
  try {
    const cacheKey = `portfolio:positions:${privateKey.substring(0, 20)}`;
    const cached = await redisCache.get<Position[]>(cacheKey);

    if (cached) {
      logger.debug('Returning cached positions');
      return cached;
    }

    logger.info('Fetching positions from Polymarket API');

    // Get wallet address from private key
    const wallet = new Wallet(decrypt(privateKey));
    const address = wallet.address;

    // Try to fetch positions via HTTP API
    let positions: any[] = [];

    try {
      // Polymarket API endpoint for positions (if available)
      const response = await fetch(`https://clob.polymarket.com/positions?address=${address}`);

      if (response.ok) {
        const data = await response.json();
        positions = data.positions || data || [];
      } else {
        logger.warn(`Positions API returned ${response.status}`);
        return [];
      }
    } catch (err) {
      logger.error('Error fetching positions via HTTP:', err);
      return [];
    }

    // Return all positions (including 0 size for closed)
    // We'll filter active/closed in getPortfolioData
    const allPositions = positions as Position[];

    await redisCache.set(cacheKey, allPositions, CACHE_TTL);

    logger.info(`Fetched ${allPositions.length} positions`);
    return allPositions;
  } catch (error) {
    logger.error('Error fetching positions:', error);
    // Return empty array instead of throwing to gracefully handle no positions
    return [];
  }
}

/**
 * Gets user's trade history
 */
export async function getTrades(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<Trade[]> {
  try {
    const cacheKey = `portfolio:trades:${privateKey.substring(0, 20)}`;
    const cached = await redisCache.get<Trade[]>(cacheKey);

    if (cached) {
      logger.debug('Returning cached trades');
      return cached;
    }

    logger.info('Fetching trades from CLOB API');

    const client = await createClobClientForUser(privateKey, apiKey, apiSecret, passphrase);
    const trades = await client.getTrades();

    // Sort by match_time descending (newest first)
    const sortedTrades = (trades as Trade[]).sort((a, b) => {
      return new Date(b.match_time).getTime() - new Date(a.match_time).getTime();
    });

    await redisCache.set(cacheKey, sortedTrades, CACHE_TTL);

    logger.info(`Fetched ${sortedTrades.length} trades`);
    return sortedTrades;
  } catch (error) {
    logger.error('Error fetching trades:', error);
    // Return empty array instead of throwing to gracefully handle no trades
    return [];
  }
}

/**
 * Gets user's complete portfolio data
 */
export async function getPortfolioData(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<PortfolioData> {
  try {
    logger.info('Fetching complete portfolio data');

    // Fetch open orders, trades, and positions in parallel
    const [openOrders, trades, positions] = await Promise.all([
      getOpenOrders(privateKey, apiKey, apiSecret, passphrase),
      getTrades(privateKey, apiKey, apiSecret, passphrase),
      getPositions(privateKey, apiKey, apiSecret, passphrase),
    ]);

    // Try to get balance
    let balance = '0.00';
    try {
      const client = await createClobClientForUser(privateKey, apiKey, apiSecret, passphrase);
      const balanceData = await client.getBalanceAllowance({
        asset_type: 'COLLATERAL' as any,
      });
      if (balanceData && balanceData.balance) {
        balance = (parseFloat(balanceData.balance) / 1000000).toFixed(2); // Convert from microUSDC
      }
    } catch (balanceError) {
      logger.error('Error fetching balance:', balanceError);
      // Continue with 0 balance
    }

    // Separate active and closed positions
    const activePositions = positions.filter((pos) => parseFloat(pos.size) > 0);
    const closedPositions = positions.filter((pos) => parseFloat(pos.size) === 0);

    logger.info(`Active positions: ${activePositions.length}, Closed positions: ${closedPositions.length}`);

    return {
      openOrders,
      trades,
      activePositions,
      closedPositions,
      balance,
    };
  } catch (error) {
    logger.error('Error fetching portfolio data:', error);
    throw new Error('Failed to fetch portfolio data');
  }
}

/**
 * Format price for display
 */
export function formatOrderPrice(price: string): string {
  const priceNum = parseFloat(price);
  return `${(priceNum * 100).toFixed(1)}¢`;
}

/**
 * Format size for display
 */
export function formatOrderSize(size: string): string {
  const sizeNum = parseFloat(size);
  if (sizeNum >= 1000) {
    return `${(sizeNum / 1000).toFixed(1)}K`;
  }
  return sizeNum.toFixed(2);
}

/**
 * Calculate trade value
 */
export function calculateTradeValue(size: string, price: string): string {
  const sizeNum = parseFloat(size);
  const priceNum = parseFloat(price);
  const value = sizeNum * priceNum;
  return `$${value.toFixed(2)}`;
}

/**
 * Format timestamp to date string
 */
export function formatTimestamp(timestamp: string | number): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp * 1000);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Gets user's USDC balance from Polymarket
 */
export async function getBalance(
  privateKey: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<string> {
  try {
    const cacheKey = `portfolio:balance:${privateKey.substring(0, 20)}`;
    const cached = await redisCache.get<string>(cacheKey);

    if (cached) {
      logger.debug('Returning cached balance');
      return cached;
    }

    logger.info('Fetching balance from CLOB API');

    const client = await createClobClientForUser(privateKey, apiKey, apiSecret, passphrase);

    // Get USDC balance (collateral)
    const balanceData = await client.getBalanceAllowance({
      asset_type: 'COLLATERAL' as any,
    });

    let balance = '0.00';
    if (balanceData && balanceData.balance) {
      // Convert from microUSDC (6 decimals) to USDC
      const balanceNum = parseFloat(balanceData.balance) / 1000000;
      balance = balanceNum.toFixed(2);
    }

    // Cache for 1 minute
    await redisCache.set(cacheKey, balance, 60);

    logger.info(`Fetched balance: $${balance}`);
    return balance;
  } catch (error) {
    logger.error('Error fetching balance:', error);
    // Return "0.00" instead of throwing to handle gracefully
    return '0.00';
  }
}
