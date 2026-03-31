import { ethers } from 'ethers';
import { logger } from './logger';

export type WsProviderState = 'connecting' | 'connected' | 'disconnected' | 'destroyed';

export interface ManagedWsProvider {
  getProvider(): ethers.providers.WebSocketProvider | null;
  onConnected(cb: (provider: ethers.providers.WebSocketProvider) => void): void;
  onDisconnected(cb: () => void): void;
  destroy(): void;
  readonly state: WsProviderState;
}

/**
 * Creates a managed WebSocket provider with automatic reconnection.
 * Uses exponential backoff (1s → 2s → 4s … up to maxBackoffMs).
 */
export function createManagedWsProvider(url: string, maxBackoffMs = 60_000): ManagedWsProvider {
  let provider: ethers.providers.WebSocketProvider | null = null;
  let state: WsProviderState = 'connecting';
  let destroyed = false;
  let backoff = 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connectedCbs: Array<(p: ethers.providers.WebSocketProvider) => void> = [];
  const disconnectedCbs: Array<() => void> = [];

  function connect() {
    if (destroyed) return;
    state = 'connecting';
    logger.info('[wsProvider] Connecting to WebSocket RPC...');

    try {
      provider = new ethers.providers.WebSocketProvider(url);
    } catch (err: any) {
      logger.warn(`[wsProvider] Failed to create WebSocketProvider: ${err?.message}`);
      scheduleReconnect();
      return;
    }

    const ws = (provider as any)._websocket as WebSocket | null;

    if (ws) {
      ws.onopen = () => {
        if (destroyed) { provider?.destroy(); return; }
        state = 'connected';
        backoff = 1_000; // reset backoff on successful connection
        logger.info('[wsProvider] Connected');
        connectedCbs.forEach((cb) => cb(provider!));
      };

      ws.onerror = (ev: any) => {
        logger.warn(`[wsProvider] WebSocket error: ${ev?.message ?? 'unknown'}`);
      };

      ws.onclose = () => {
        if (destroyed) return;
        logger.warn('[wsProvider] WebSocket closed — will reconnect');
        state = 'disconnected';
        disconnectedCbs.forEach((cb) => cb());
        provider = null;
        scheduleReconnect();
      };
    } else {
      // Fallback: poll readyState via network event
      provider.on('network', () => {
        if (destroyed) return;
        if (state !== 'connected') {
          state = 'connected';
          backoff = 1_000;
          logger.info('[wsProvider] Connected (via network event)');
          connectedCbs.forEach((cb) => cb(provider!));
        }
      });

      // If we cannot hook into ws events directly, treat as connected after creation
      state = 'connected';
      backoff = 1_000;
      connectedCbs.forEach((cb) => cb(provider!));
    }
  }

  function scheduleReconnect() {
    if (destroyed) return;
    logger.info(`[wsProvider] Reconnecting in ${backoff / 1000}s...`);
    reconnectTimer = setTimeout(() => {
      backoff = Math.min(backoff * 2, maxBackoffMs);
      connect();
    }, backoff);
  }

  connect();

  return {
    get state() { return state; },
    getProvider() { return provider; },
    onConnected(cb) { connectedCbs.push(cb); },
    onDisconnected(cb) { disconnectedCbs.push(cb); },
    destroy() {
      destroyed = true;
      state = 'destroyed';
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (provider) { provider.destroy(); provider = null; }
      logger.info('[wsProvider] Destroyed');
    },
  };
}
