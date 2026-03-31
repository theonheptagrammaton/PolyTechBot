import { config } from '../config';
import { logger } from '../utils/logger';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PredexonUser {
  userId: string;
  createdAt: string;
  status: 'provisioning' | 'ready' | 'failed';
  polymarketWalletAddress: string;
  predictWalletAddress: string;
}

export interface PredexonOrder {
  venue: 'polymarket' | 'predict';
  tokenId: string;
  marketId?: string;           // required for predict venue
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  amount?: string;             // market BUY only (stablecoin to spend)
  size?: string;               // limit orders & market SELL (number of shares)
  price?: string;              // limit orders only (0–1 exclusive)
}

export interface PredexonOrderResponse {
  orderId: string;
  status: 'open' | 'filled' | 'cancelled' | 'expired' | 'pending';
  venue: string;
  side: string;
  type: string;
  tokenId: string;
  marketIdentifier?: string;
  sizeMatched?: string;
  price?: string;
  amount?: string;
  size?: string;
  fee?: {
    policyApplied: boolean;
    feeBps: number;
    platformFeeBps: number;
    partnerFeeBps: number;
    grossAmount?: string;
    netOrderAmount?: string;
    maxFeeReserved?: string;
  };
  [key: string]: unknown;
}

export interface PredexonPosition {
  venue: string;
  title: string | null;
  outcome: string;
  size: string;
  status: 'active' | 'resolved' | 'redeemable';
  averagePrice: string | null;
  currentPrice: string | null;
  currentValue: string | null;
  pnl: string | null;
  result?: 'won' | 'lost';
  tokenId?: string;
  marketIdentifier?: string;
  positionId?: string;
  [key: string]: unknown;
}

export interface PredexonBalance {
  venue: string;
  available: string;
  locked: string;
  total: string;
}

export interface PredexonDepositInfo {
  wallet: string;
  depositAddresses: {
    evm: string;
    solana: string;
    bitcoin: string;
  };
  supportedAssets?: unknown[];
}

export interface PredexonWithdrawParams {
  venue: 'polymarket' | 'predict';
  amount: string;
  destinationAddress: string;
  chain: 'polygon' | 'bsc';
}

export interface PredexonWithdrawResult {
  transactionHash: string;
  amount: string;
  destinationAddress: string;
  chain: string;
  status: string;
}

export interface PredexonRedeemResult {
  status: string;
  transactionHash?: string;
  [key: string]: unknown;
}

// ── HTTP Client ────────────────────────────────────────────────────────────

const TRADE_URL = () => config.predexon.tradeUrl;
const DATA_URL = () => config.predexon.dataUrl;

function headers(): Record<string, string> {
  return {
    'x-api-key': config.predexon.apiKey,
    'Content-Type': 'application/json',
  };
}

async function predexonFetch<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const opts: RequestInit = {
    ...options,
    headers: { ...headers(), ...(options.headers as Record<string, string> || {}) },
  };

  logger.debug(`[predexon] ${opts.method || 'GET'} ${url}`);

  const res = await fetch(url, opts);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const msg = `Predexon API error: ${res.status} ${res.statusText} — ${body}`;
    logger.error(`[predexon] ${msg}`);
    throw new Error(msg);
  }

  return res.json() as Promise<T>;
}

// ── User Management ────────────────────────────────────────────────────────

export async function createPredexonUser(): Promise<PredexonUser> {
  return predexonFetch<PredexonUser>(`${TRADE_URL()}/api/users/create`, {
    method: 'POST',
  });
}

export async function getPredexonUser(userId: string): Promise<PredexonUser> {
  return predexonFetch<PredexonUser>(`${TRADE_URL()}/api/users/${userId}`);
}

/**
 * Creates a user and polls until status becomes "ready".
 * Throws if provisioning fails or times out.
 */
export async function createAndWaitForUser(maxWaitMs = 180_000): Promise<PredexonUser> {
  const user = await createPredexonUser();
  logger.info(`[predexon] User created: ${user.userId} (status: ${user.status})`);

  if (user.status === 'ready') return user;

  const pollIntervalMs = 3_000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const current = await getPredexonUser(user.userId);

    if (current.status === 'ready') {
      logger.info(`[predexon] User ${user.userId} is ready`);
      return current;
    }
    if (current.status === 'failed') {
      throw new Error(`Predexon user provisioning failed for ${user.userId}`);
    }
    logger.debug(`[predexon] User ${user.userId} still provisioning...`);
  }

  throw new Error(`Predexon user provisioning timed out for ${user.userId}`);
}

/**
 * Waits for an existing user to become "ready".
 * Returns the user if ready, null if still provisioning after timeout.
 */
export async function waitForUserReady(userId: string, maxWaitMs = 120_000): Promise<PredexonUser | null> {
  const pollIntervalMs = 3_000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const current = await getPredexonUser(userId);
    if (current.status === 'ready') return current;
    if (current.status === 'failed') return null;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return null;
}

export async function deletePredexonUser(userId: string): Promise<void> {
  await predexonFetch<unknown>(`${TRADE_URL()}/api/users/${userId}`, {
    method: 'DELETE',
  });
}

// ── Trading ────────────────────────────────────────────────────────────────

export async function placeOrder(
  userId: string,
  order: PredexonOrder,
): Promise<PredexonOrderResponse> {
  return predexonFetch<PredexonOrderResponse>(
    `${TRADE_URL()}/api/users/${userId}/orders`,
    { method: 'POST', body: JSON.stringify(order) },
  );
}

export async function getOrders(
  userId: string,
  venue?: string,
): Promise<PredexonOrderResponse[]> {
  const params = venue ? `?venue=${venue}` : '';
  const data = await predexonFetch<{ orders: PredexonOrderResponse[] }>(
    `${TRADE_URL()}/api/users/${userId}/orders${params}`,
  );
  return data.orders ?? [];
}

export async function getOrder(
  userId: string,
  orderId: string,
): Promise<PredexonOrderResponse> {
  return predexonFetch<PredexonOrderResponse>(
    `${TRADE_URL()}/api/users/${userId}/orders/${orderId}`,
  );
}

export async function cancelOrder(
  userId: string,
  orderId: string,
): Promise<void> {
  await predexonFetch<unknown>(
    `${TRADE_URL()}/api/users/${userId}/orders/${orderId}/cancel`,
    { method: 'POST' },
  );
}

export async function cancelAllOrders(
  userId: string,
  venue?: string,
): Promise<void> {
  const body = venue ? JSON.stringify({ venue }) : undefined;
  await predexonFetch<unknown>(
    `${TRADE_URL()}/api/users/${userId}/orders/cancel`,
    { method: 'POST', body },
  );
}

// ── Positions & Balance ────────────────────────────────────────────────────

export async function getPositions(
  userId: string,
  venue?: string,
): Promise<PredexonPosition[]> {
  const params = venue ? `?venue=${venue}` : '';
  const data = await predexonFetch<{ positions: PredexonPosition[] }>(
    `${TRADE_URL()}/api/users/${userId}/positions${params}`,
  );
  return data.positions ?? [];
}

export async function getBalance(
  userId: string,
  venue?: string,
): Promise<PredexonBalance[]> {
  const params = venue ? `?venue=${venue}` : '';
  const data = await predexonFetch<{ balances: PredexonBalance[] }>(
    `${TRADE_URL()}/api/users/${userId}/balance${params}`,
  );
  return data.balances ?? [];
}

// ── Funds ──────────────────────────────────────────────────────────────────

export async function getBridgeDeposit(
  wallet: string,
): Promise<PredexonDepositInfo> {
  return predexonFetch<PredexonDepositInfo>(
    `${TRADE_URL()}/api/bridge/deposit?wallet=${encodeURIComponent(wallet)}`,
  );
}

export async function withdraw(
  userId: string,
  params: PredexonWithdrawParams,
): Promise<PredexonWithdrawResult> {
  return predexonFetch<PredexonWithdrawResult>(
    `${TRADE_URL()}/api/users/${userId}/withdraw`,
    { method: 'POST', body: JSON.stringify(params) },
  );
}

// ── Redemption ─────────────────────────────────────────────────────────────

export async function redeemPosition(
  userId: string,
  positionId: string,
): Promise<PredexonRedeemResult> {
  return predexonFetch<PredexonRedeemResult>(
    `${TRADE_URL()}/api/users/${userId}/positions/${positionId}/redeem`,
    { method: 'POST' },
  );
}

// ── Data API (Market Discovery) ────────────────────────────────────────────

export async function listMarkets(params?: {
  status?: string;
  sort?: string;
  limit?: number;
}): Promise<unknown> {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.sort) query.set('sort', params.sort);
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString() ? `?${query.toString()}` : '';
  return predexonFetch<unknown>(`${DATA_URL()}/v2/markets${qs}`);
}
