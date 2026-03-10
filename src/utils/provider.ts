import { ethers } from 'ethers';
import { logger } from './logger';

const POLYGON_RPC_LIST = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://1rpc.io/matic',
];

/**
 * Returns the first responsive Polygon JSON-RPC provider.
 * Races all endpoints in parallel — first to respond wins.
 */
export async function getPolygonProvider(): Promise<ethers.providers.JsonRpcProvider> {
  try {
    return await Promise.any(
      POLYGON_RPC_LIST.map(async (url) => {
        const p = new ethers.providers.JsonRpcProvider(url);
        await Promise.race([
          p.getBlockNumber(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
        ]);
        return p;
      })
    );
  } catch {
    logger.error('[rpc] All Polygon RPCs unresponsive, falling back to publicnode');
    return new ethers.providers.JsonRpcProvider(POLYGON_RPC_LIST[0]);
  }
}
