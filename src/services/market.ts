import axios from 'axios';
import { logger } from '../utils/logger';
import { redisCache } from '../database/redis';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const CACHE_TTL = 120; // 2 minutes — short enough to feel real-time
const SEARCH_CACHE_TTL = 120; // 2 minutes for search results

/** Gamma API tag slugs for main categories (matches Polymarket website) */
export const CATEGORY_TAG_SLUGS: Record<string, string> = {
  'politics':    'politics',
  'crypto':      'crypto',
  'sports':      'sports',
  'business':    'finance',
  'pop-culture': 'pop-culture',
  'geopolitics': 'geopolitics',
  'tech':        'tech',
  'ai':          'ai',
  'science':     'science',
  'elections':   'elections',
  'middle-east': 'middle-east',
};

export interface Market {
  id: string;
  question: string;
  slug: string;
  image?: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  volume24hr: number;
  volumeNum: number;
  liquidity: number;
  outcomePrices: string[] | string; // Can be array or JSON string
  outcomes: string[] | string; // Can be array or JSON string
  events?: Event[];
}

export interface Event {
  id: string;
  title: string;
  slug: string;
  description?: string;
  image?: string;
  volume24hr: number;
  volume: number;
  liquidity: number;
  markets: Market[]; // Events contain their markets
  startDate?: string;
  endDate?: string;
  active: boolean;
  closed: boolean;
  marketCount?: number;
}

export interface Category {
  name: string;
  slug: string;
  emoji: string;
  volume24hr: number;
}

// ─── Up/Down Markets ──────────────────────────────────────────────────────────

/** Coin metadata used to recognise and label up/down markets. */
const UPDOWN_COIN_MAP: Record<string, { symbol: string; name: string; emoji: string }> = {
  'bitcoin':   { symbol: 'BTC',  name: 'Bitcoin',   emoji: '₿'  },
  'ethereum':  { symbol: 'ETH',  name: 'Ethereum',  emoji: 'Ξ'  },
  'solana':    { symbol: 'SOL',  name: 'Solana',    emoji: '◎'  },
  'xrp':       { symbol: 'XRP',  name: 'XRP',       emoji: '✕'  },
  'bnb':       { symbol: 'BNB',  name: 'BNB',       emoji: '🟡' },
  'dogecoin':  { symbol: 'DOGE', name: 'Dogecoin',  emoji: '🐕' },
  'cardano':   { symbol: 'ADA',  name: 'Cardano',   emoji: '💙' },
  'avalanche':    { symbol: 'AVAX', name: 'Avalanche',    emoji: '🔺' },
  'hyperliquid':  { symbol: 'HYPE', name: 'Hyperliquid',  emoji: '💧' },
  'trump':        { symbol: 'TRUMP', name: 'TRUMP',       emoji: '🎯' },
  'melania':      { symbol: 'MELANIA', name: 'Melania',   emoji: '💎' },
};

export interface UpDownMarket {
  eventId:      string;
  marketId:     string;   // Numeric Gamma market ID — used for trade deep links
  conditionId:  string;   // CLOB condition ID — used for detail deep links
  coin:         string;   // BTC
  coinEmoji:    string;   // ₿
  coinName:     string;   // Bitcoin
  timeframe:    string;   // 5-Minute | 15-Minute | 1-Hour | 4-Hour | Daily | Weekly
  startDate:    string;   // ISO date string
  endDate:      string;   // ISO date string
  upPrice:      number;   // probability of going Up  (0–1)
  downPrice:    number;   // probability of going Down (0–1)
  upTokenId:    string;   // CLOB token ID for Up outcome
  downTokenId:  string;   // CLOB token ID for Down outcome
  volume24hr:   number;
  liquidity:    number;
  slug:         string;
}

/** Sort order for timeframes (shorter = higher priority = shown first) */
const TIMEFRAME_ORDER: Record<string, number> = {
  '5-Minute':  1,
  '15-Minute': 2,
  '1-Hour':    3,
  '4-Hour':    4,
  'Daily':     5,
  'Weekly':    6,
};

/**
 * Fetches all active "Up or Down" crypto markets from Polymarket.
 * Results are cached for 60 s (prices update frequently).
 */
export async function getUpDownMarkets(): Promise<UpDownMarket[]> {
  try {
    const cacheKey = 'markets:updown:v8';
    const cached = await redisCache.get<UpDownMarket[]>(cacheKey);
    if (cached) return cached;

    logger.info('Fetching crypto up/down markets');

    // Two parallel fetches:
    // 1. Top-200 by volume  → covers popular daily/hourly markets
    // 2. Soonest-ending 100 → catches new 5-min/15-min markets that have near-zero volume
    //    and are pushed off the top-200 list (endDate asc = currently-live short-term rounds)
    const [volResp, shortResp] = await Promise.all([
      axios.get(`${GAMMA_API_BASE}/events`, {
        params: { active: true, closed: false, order: 'volume24hr', ascending: false, limit: 200, tag_id: 21 },
        timeout: 15000,
      }),
      // startDate desc = most recently created events first → new 5-min/15-min rounds always appear here
      axios.get(`${GAMMA_API_BASE}/events`, {
        params: { active: true, closed: false, order: 'startDate', ascending: false, limit: 100, tag_id: 21 },
        timeout: 15000,
      }),
    ]);

    // Merge and deduplicate by event id
    const seen = new Set<string>();
    const merged = [...(Array.isArray(volResp.data) ? volResp.data : []), ...(Array.isArray(shortResp.data) ? shortResp.data : [])];
    const events: any[] = merged.filter(e => {
      const id = String(e.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const markets: UpDownMarket[] = [];

    const now = Date.now();

    for (const event of events) {
      const titleLower = (event.title ?? event.slug ?? '').toLowerCase();
      const slugLower  = (event.slug ?? '').toLowerCase();
      if (
        !titleLower.includes('up or down') &&
        !titleLower.includes('up-or-down') &&
        !slugLower.includes('updown')
      ) continue;

      const market = (event.markets ?? [])[0];
      if (!market?.conditionId || !market.active || market.closed) continue;

      // Skip markets that have already ended
      const endMs = new Date(market.endDate ?? event.endDate ?? 0).getTime();
      if (endMs > 0 && endMs < now) continue;

      // Parse JSON string fields safely
      let outcomes: string[]  = [];
      let prices:   string[]  = [];
      let tokenIds: string[]  = [];
      try {
        outcomes = Array.isArray(market.outcomes)      ? market.outcomes      : JSON.parse(market.outcomes      ?? '[]');
        prices   = Array.isArray(market.outcomePrices) ? market.outcomePrices : JSON.parse(market.outcomePrices ?? '[]');
        tokenIds = Array.isArray(market.clobTokenIds)  ? market.clobTokenIds  : JSON.parse(market.clobTokenIds  ?? '[]');
      } catch { continue; }

      if (outcomes.length < 2 || prices.length < 2 || tokenIds.length < 2) continue;

      // Detect coin from event title
      let coinInfo: { symbol: string; name: string; emoji: string } | null = null;
      for (const [key, info] of Object.entries(UPDOWN_COIN_MAP)) {
        if (titleLower.includes(key)) { coinInfo = info; break; }
      }
      if (!coinInfo) continue;

      // Detect timeframe from seriesSlug (e.g. "btc-up-or-down-daily", "btc-up-or-down-5m")
      const seriesSlug = (event.seriesSlug ?? '').toLowerCase();
      let timeframe = 'Daily';
      // 15-Minute must be checked before 5-Minute to avoid '15min'.includes('5min') false-match
      if      (seriesSlug.includes('15-minute') || seriesSlug.includes('15min') || seriesSlug.includes('-15m')) timeframe = '15-Minute';
      else if (seriesSlug.includes('5-minute')  || seriesSlug.includes('5min')  || seriesSlug.includes('-5m'))  timeframe = '5-Minute';
      else if (seriesSlug.includes('weekly'))                                                                     timeframe = 'Weekly';
      else if (seriesSlug.includes('hourly') || seriesSlug.includes('-1h') || seriesSlug.includes('1-hour'))    timeframe = '1-Hour';
      else if (seriesSlug.includes('-4h') || seriesSlug.includes('4-hour'))                                     timeframe = '4-Hour';

      // Find Up/Down outcome indices
      const upIdx   = outcomes.findIndex((o: string) => o.toLowerCase() === 'up');
      const downIdx = outcomes.findIndex((o: string) => o.toLowerCase() === 'down');
      if (upIdx < 0 || downIdx < 0) continue;

      markets.push({
        eventId:     String(event.id),
        marketId:    String(market.id),
        conditionId: market.conditionId,
        coin:        coinInfo.symbol,
        coinEmoji:   coinInfo.emoji,
        coinName:    coinInfo.name,
        timeframe,
        startDate:   event.startDate ?? '',
        endDate:     market.endDate ?? event.endDate ?? '',
        upPrice:     parseFloat(prices[upIdx]   ?? '0.5'),
        downPrice:   parseFloat(prices[downIdx] ?? '0.5'),
        upTokenId:   tokenIds[upIdx]   ?? '',
        downTokenId: tokenIds[downIdx] ?? '',
        volume24hr:  event.volume24hr ?? 0,
        liquidity:   event.liquidity  ?? 0,
        slug:        event.slug ?? '',
      });
    }

    // Sort: timeframe asc → coin asc → endDate asc (soonest = current active window first)
    markets.sort((a, b) => {
      const orderA = TIMEFRAME_ORDER[a.timeframe] ?? 99;
      const orderB = TIMEFRAME_ORDER[b.timeframe] ?? 99;
      if (orderA !== orderB) return orderA - orderB;
      if (a.coin !== b.coin) return a.coin.localeCompare(b.coin);
      return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    });

    await redisCache.set(cacheKey, markets, 60); // 60 s — prices change frequently
    logger.info(`Fetched ${markets.length} crypto up/down markets`);
    return markets;
  } catch (error) {
    logger.error('Error fetching crypto up/down markets:', error);
    return [];
  }
}

/**
 * Gets top categories based on event volume using events endpoint
 */
export async function getTopCategories(): Promise<Category[]> {
  try {
    const cacheKey = 'markets:top_categories';
    const cached = await redisCache.get<Category[]>(cacheKey);

    if (cached) {
      logger.debug('Returning cached categories');
      return cached;
    }

    logger.info('Fetching top events from Gamma API...');

    // Fetch top events by volume
    const response = await axios.get(`${GAMMA_API_BASE}/events`, {
      params: {
        active: true,
        closed: false,
        limit: 100, // Get more events for better category calculation
      },
      timeout: 10000,
    });

    const events: Event[] = response.data;

    // Group events by theme and create categories
    const categories: Category[] = [
      {
        name: 'Politics',
        slug: 'politics',
        emoji: '🏛️',
        volume24hr: 0,
      },
      {
        name: 'Crypto',
        slug: 'crypto',
        emoji: '₿',
        volume24hr: 0,
      },
      {
        name: 'Sports',
        slug: 'sports',
        emoji: '⚽',
        volume24hr: 0,
      },
      {
        name: 'Business',
        slug: 'business',
        emoji: '💼',
        volume24hr: 0,
      },
      {
        name: 'Pop Culture',
        slug: 'pop-culture',
        emoji: '🎬',
        volume24hr: 0,
      },
      {
        name: 'All Markets',
        slug: 'all',
        emoji: '🔥',
        volume24hr: 0,
      },
    ];

    // Calculate volume for each category based on matching events
    for (const event of events) {
      const searchText = `${event.title} ${event.slug} ${event.description || ''}`.toLowerCase();

      for (const category of categories) {
        if (category.slug === 'all') continue; // Skip 'all' for now

        const keywords = getCategoryKeywords(category.slug);
        const matches = keywords.some(keyword => searchText.includes(keyword.toLowerCase()));

        if (matches) {
          category.volume24hr += event.volume24hr || 0;
        }
      }
    }

    // Calculate total volume for "All Markets"
    const totalVolume = events.reduce((sum, event) => sum + (event.volume24hr || 0), 0);
    const allMarketsCategory = categories.find(c => c.slug === 'all');
    if (allMarketsCategory) {
      allMarketsCategory.volume24hr = totalVolume;
    }

    await redisCache.set(cacheKey, categories, CACHE_TTL);

    logger.info(`Fetched ${categories.length} categories from ${events.length} events`);
    return categories;
  } catch (error) {
    logger.error('Error fetching categories:', error);
    throw new Error('Failed to fetch market categories');
  }
}

/**
 * Gets trending events from Polymarket's curated featured list (homepage trending section).
 * Uses featured=true to match what Polymarket shows on their homepage.
 */
export async function getTrendingEvents(limit: number = 30): Promise<Event[]> {
  try {
    const cacheKey = `markets:trending:${limit}`;
    const cached = await redisCache.get<Event[]>(cacheKey);
    if (cached) {
      logger.debug(`Returning ${cached.length} cached trending events`);
      return cached;
    }

    logger.info(`Fetching top ${limit} trending events from Gamma API...`);

    const response = await axios.get(`${GAMMA_API_BASE}/events`, {
      params: {
        active: true,
        closed: false,
        featured: true,
        end_date_min: new Date().toISOString(), // exclude expired-but-unresolved events
        order: 'volume24hr',
        ascending: false,
        limit: 50,
      },
      timeout: 15000,
    });

    const events: Event[] = Array.isArray(response.data) ? response.data : [];
    const result = filterAndSortEvents(events).slice(0, limit);
    await redisCache.set(cacheKey, result, CACHE_TTL);

    logger.info(`Fetched ${result.length} trending events`);
    return result;
  } catch (error) {
    logger.error('Error fetching trending events:', error);
    // Fall back to getTopEvents on error
    return getTopEvents(limit);
  }
}

/**
 * Gets top events by volume using events endpoint
 * Returns events instead of individual markets for better UX
 */
export async function getTopEvents(limit: number = 50): Promise<Event[]> {
  try {
    const cacheKey = `markets:top_events:${limit}`;
    const cached = await redisCache.get<Event[]>(cacheKey);

    if (cached) {
      logger.debug(`Returning ${cached.length} cached events`);
      return cached;
    }

    logger.info(`Fetching top ${limit} events from Gamma API...`);

    const response = await axios.get(`${GAMMA_API_BASE}/events`, {
      params: {
        active: true,
        closed: false,
        end_date_min: new Date().toISOString(), // exclude expired-but-unresolved events
        order: 'volume24hr',
        ascending: false,
        limit: Math.min(limit + 10, 100),
      },
      timeout: 15000,
    });

    const events: Event[] = Array.isArray(response.data) ? response.data : [];
    const sortedEvents = filterAndSortEvents(events).slice(0, limit);

    await redisCache.set(cacheKey, sortedEvents, CACHE_TTL);
    logger.info(`Fetched ${sortedEvents.length} top events`);
    return sortedEvents;
  } catch (error) {
    logger.error('Error fetching top events:', error);
    throw new Error('Failed to fetch top events');
  }
}

/**
 * Shared helper: filters out non-tradeable markets and sorts events by 24h volume.
 */
function filterAndSortEvents(events: Event[]): Event[] {
  const now = Date.now();
  return events
    // I1: min $1K liquidity · I2: client-side endDate expiry guard
    .filter(e => {
      if (!e.volume24hr || (e.liquidity ?? 0) < 1000) return false;
      if (!Array.isArray(e.markets) || e.markets.length === 0) return false;
      const endMs = (e as any).endDate ? new Date((e as any).endDate).getTime() : 0;
      if (endMs > 0 && endMs < now) return false;
      return true;
    })
    .map(e => {
      const tradeableMarkets = e.markets.filter(m => {
        if (!m.active || m.closed) return false;
        try {
          const outcomes = Array.isArray(m.outcomes) ? m.outcomes :
            (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : []);
          if (outcomes.length !== 2) return false;

          const prices = Array.isArray(m.outcomePrices) ? m.outcomePrices :
            (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : []);
          if (prices.length !== 2) return false;

          const p0 = parseFloat(prices[0]);
          const p1 = parseFloat(prices[1]);
          // I3: exclude resolved/near-resolved markets (matches event detail page threshold)
          if (isNaN(p0) || isNaN(p1) || p0 < 0.01 || p0 > 0.99 || p1 < 0.01 || p1 > 0.99) return false;

          if (!(m as any).conditionId && !(m as any).condition_id) return false;

          const raw = (m as any).clobTokenIds;
          const ids: any[] = Array.isArray(raw) ? raw :
            (typeof raw === 'string' ? JSON.parse(raw) : []);
          if (ids.length !== 2 || !ids[0] || !ids[1]) return false;
        } catch {
          return false;
        }
        return true;
      });
      return { ...e, markets: tradeableMarkets };
    })
    .filter(e => e.markets.length > 0)
    .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));
}

/**
 * Gets top markets by volume (all markets) using events endpoint
 * @deprecated Use getTopEvents() instead for better UX
 */
export async function getTopMarkets(limit: number = 50): Promise<Market[]> {
  try {
    const cacheKey = `markets:top_markets:${limit}`;
    const cached = await redisCache.get<Market[]>(cacheKey);

    if (cached) {
      logger.debug(`Returning ${cached.length} cached markets`);
      return cached;
    }

    logger.info(`Fetching top ${limit} markets from Gamma API using events endpoint...`);

    // Use events endpoint with active markets - most efficient approach
    const response = await axios.get(`${GAMMA_API_BASE}/events`, {
      params: {
        active: true,
        closed: false,
        limit: 100, // Fetch more events to get enough markets
      },
      timeout: 15000,
    });

    const events: Event[] = response.data;

    // Extract all markets from events
    const allMarkets: Market[] = [];
    for (const event of events) {
      if (event.markets && Array.isArray(event.markets)) {
        // Add event info to each market for better context
        // Only include necessary event fields to avoid circular references
        const eventInfo = {
          id: event.id,
          title: event.title,
          slug: event.slug,
          description: event.description,
          image: event.image,
          volume24hr: event.volume24hr,
          volume: event.volume,
          liquidity: event.liquidity,
          markets: [], // Empty array to avoid circular reference
          active: event.active,
          closed: event.closed
        };

        for (const market of event.markets) {
          // Create a clean market object without circular references
          const cleanMarket: Market = {
            id: market.id,
            question: market.question,
            slug: market.slug,
            image: market.image,
            endDate: market.endDate,
            active: market.active,
            closed: market.closed,
            volume24hr: market.volume24hr,
            volumeNum: market.volumeNum,
            liquidity: market.liquidity,
            outcomePrices: market.outcomePrices,
            outcomes: market.outcomes,
            events: [eventInfo]
          };
          allMarkets.push(cleanMarket);
        }
      }
    }

    // Sort by 24hr volume and filter out markets with invalid prices
    const sortedMarkets = allMarkets
      .filter(m => {
        // Filter out markets with no volume
        if (!m.volume24hr || m.volume24hr <= 0) return false;

        // Parse prices safely
        const prices = parseOutcomePrices(m);
        if (!prices || prices.length < 2) return false;

        // Check if prices are valid numbers
        const price1 = parseFloat(prices[0]);
        const price2 = parseFloat(prices[1]);

        return !isNaN(price1) && !isNaN(price2);
      })
      .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0))
      .slice(0, limit);

    await redisCache.set(cacheKey, sortedMarkets, CACHE_TTL);

    logger.info(`Fetched ${sortedMarkets.length} top markets from ${events.length} events`);
    return sortedMarkets;
  } catch (error) {
    logger.error('Error fetching top markets:', error);
    throw new Error('Failed to fetch top markets');
  }
}

/**
 * Gets events by category using the Gamma API's tag_slug parameter with related_tags.
 * This matches how Polymarket's website fetches category events.
 * Falls back to keyword filtering if tag_slug is unknown.
 */
export async function getEventsByCategory(category: string, limit: number = 30): Promise<Event[]> {
  try {
    const cacheKey = `events:category:${category}:${limit}`;
    const cached = await redisCache.get<Event[]>(cacheKey);
    if (cached) {
      logger.debug(`Returning ${cached.length} cached events for category ${category}`);
      return cached;
    }

    const tagSlug = CATEGORY_TAG_SLUGS[category];
    logger.info(`Fetching events for category: ${category} (tag_slug=${tagSlug ?? 'keyword'})`);

    const params: Record<string, any> = {
      active: true,
      closed: false,
      end_date_min: new Date().toISOString(),
      order: 'volume24hr',
      ascending: false,
      limit: Math.min(limit + 15, 50),
    };

    if (tagSlug) {
      params.tag_slug = tagSlug;
      params.related_tags = true;
    }

    const response = await axios.get(`${GAMMA_API_BASE}/events`, {
      params,
      timeout: 15000,
    });

    let events: Event[] = Array.isArray(response.data) ? response.data : [];

    // Keyword fallback for unknown categories
    if (!tagSlug) {
      const keywords = getCategoryKeywords(category);
      events = events.filter(event => {
        const searchText = `${event.title} ${event.slug} ${event.description || ''}`.toLowerCase();
        return keywords.some(kw => searchText.includes(kw.toLowerCase()));
      });
    }

    const sortedEvents = filterAndSortEvents(events).slice(0, limit);
    await redisCache.set(cacheKey, sortedEvents, CACHE_TTL);

    logger.info(`Fetched ${sortedEvents.length} events for category ${category}`);
    return sortedEvents;
  } catch (error) {
    logger.error(`Error fetching events for category ${category}:`, error);
    throw new Error(`Failed to fetch events for category ${category}`);
  }
}

/**
 * Gets live sports events — games/matches happening now or starting within the next few hours.
 * Filters sports events by endDate within 24h (same-day games).
 */
export async function getLiveSportsEvents(limit: number = 30): Promise<Event[]> {
  try {
    const cacheKey = `events:live_sports:${limit}`;
    const cached = await redisCache.get<Event[]>(cacheKey);
    if (cached) return cached;

    logger.info('Fetching live sports events from Gamma API...');

    const response = await axios.get(`${GAMMA_API_BASE}/events`, {
      params: {
        tag_slug: 'sports',
        related_tags: true,
        active: true,
        closed: false,
        end_date_min: new Date().toISOString(),
        order: 'volume24hr',
        ascending: false,
        limit: 100,
      },
      timeout: 15000,
    });

    const events: Event[] = Array.isArray(response.data) ? response.data : [];
    const now = Date.now();
    const H24 = 24 * 60 * 60 * 1000;

    // Keep only events ending within 24 hours (live/same-day matches)
    const liveEvents = events.filter(e => {
      if (!e.endDate) return false;
      const endMs = new Date(e.endDate).getTime();
      return endMs > now && endMs - now < H24;
    });

    const sorted = filterAndSortEvents(liveEvents).slice(0, limit);
    await redisCache.set(cacheKey, sorted, 60); // 1 min cache — live data changes fast
    logger.info(`Fetched ${sorted.length} live sports events`);
    return sorted;
  } catch (error) {
    logger.error('Error fetching live sports events:', error);
    throw new Error('Failed to fetch live sports events');
  }
}

/**
 * Gets markets by category using events endpoint
 * @deprecated Use getEventsByCategory() instead for better UX
 */
export async function getMarketsByCategory(category: string, limit: number = 50): Promise<Market[]> {
  try {
    const cacheKey = `markets:category:${category}:${limit}`;
    const cached = await redisCache.get<Market[]>(cacheKey);

    if (cached) {
      logger.debug(`Returning ${cached.length} cached markets for category ${category}`);
      return cached;
    }

    logger.info(`Fetching markets for category: ${category} using events endpoint`);

    // Use events endpoint for better performance
    const response = await axios.get(`${GAMMA_API_BASE}/events`, {
      params: {
        active: true,
        closed: false,
        limit: 100, // Fetch more events for better filtering
      },
      timeout: 15000,
    });

    const events: Event[] = response.data;

    // Filter events based on category keywords
    const categoryKeywords = getCategoryKeywords(category);
    const filteredEvents = events.filter(event => {
      const searchText = `${event.title} ${event.slug} ${event.description || ''}`.toLowerCase();
      return categoryKeywords.some(keyword => searchText.includes(keyword.toLowerCase()));
    });

    // Extract markets from filtered events
    const allMarkets: Market[] = [];
    for (const event of filteredEvents) {
      if (event.markets && Array.isArray(event.markets)) {
        // Create clean event info without circular references
        const eventInfo = {
          id: event.id,
          title: event.title,
          slug: event.slug,
          description: event.description,
          image: event.image,
          volume24hr: event.volume24hr,
          volume: event.volume,
          liquidity: event.liquidity,
          markets: [], // Empty array to avoid circular reference
          active: event.active,
          closed: event.closed
        };

        for (const market of event.markets) {
          // Create a clean market object without circular references
          const cleanMarket: Market = {
            id: market.id,
            question: market.question,
            slug: market.slug,
            image: market.image,
            endDate: market.endDate,
            active: market.active,
            closed: market.closed,
            volume24hr: market.volume24hr,
            volumeNum: market.volumeNum,
            liquidity: market.liquidity,
            outcomePrices: market.outcomePrices,
            outcomes: market.outcomes,
            events: [eventInfo]
          };
          allMarkets.push(cleanMarket);
        }
      }
    }

    // Sort by volume and filter valid markets
    const sortedMarkets = allMarkets
      .filter(m => {
        // Filter out markets with no volume
        if (!m.volume24hr || m.volume24hr <= 0) return false;

        // Parse prices safely
        const prices = parseOutcomePrices(m);
        if (!prices || prices.length < 2) return false;

        // Check if prices are valid numbers
        const price1 = parseFloat(prices[0]);
        const price2 = parseFloat(prices[1]);

        return !isNaN(price1) && !isNaN(price2);
      })
      .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0))
      .slice(0, limit);

    await redisCache.set(cacheKey, sortedMarkets, CACHE_TTL);

    logger.info(`Fetched ${sortedMarkets.length} markets for category ${category} from ${filteredEvents.length} filtered events`);
    return sortedMarkets;
  } catch (error) {
    logger.error(`Error fetching markets for category ${category}:`, error);
    throw new Error(`Failed to fetch markets for category ${category}`);
  }
}

/**
 * Gets category keywords for filtering
 */
function getCategoryKeywords(category: string): string[] {
  const keywordMap: Record<string, string[]> = {
    'politics': [
      'trump', 'biden', 'harris', 'obama', 'clinton',
      'election', 'president', 'presidential', 'nominee', 'nomination',
      'senate', 'senator', 'congress', 'congressman', 'representative',
      'political', 'vote', 'voting', 'ballot', 'campaign',
      'government', 'federal', 'state', 'governor', 'mayor',
      'minister', 'prime', 'parliament', 'macron', 'merkel',
      'policy', 'law', 'bill', 'legislation',
      'deport', 'deportation', 'immigration', 'border',
      'republican', 'democrat', 'democratic', 'gop',
      'cabinet', 'administration', 'white house',
      'supreme court', 'justice', 'judge',
      'fed chair', 'federal reserve', 'treasury'
    ],
    'crypto': [
      'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'cryptocurrency',
      'blockchain', 'nft', 'defi', 'token', 'coin',
      'solana', 'sol', 'cardano', 'ada', 'polkadot', 'dot',
      'binance', 'coinbase', 'kraken', 'ftx', 'gemini',
      'xrp', 'ripple', 'bnb', 'usdt', 'usdc', 'tether',
      'avalanche', 'avax', 'polygon', 'matic', 'chainlink', 'link',
      'uniswap', 'uni', 'doge', 'dogecoin', 'shiba',
      'litecoin', 'ltc', 'stellar', 'xlm',
      'microstrategy', 'saylor', 'mining', 'miner', 'hash rate',
      'web3', 'metaverse', 'dao', 'smart contract',
      'altcoin', 'memecoin', 'stablecoin',
      'satoshi', 'vitalik', 'nakamoto',
      'halving', 'hard fork', 'soft fork',
      'ico', 'ipo crypto', 'airdrop',
      'eth price', 'btc price', 'crypto market'
    ],
    'sports': [
      'nfl', 'nba', 'mlb', 'nhl', 'mls',
      'soccer', 'football', 'basketball', 'baseball', 'hockey',
      'champion', 'championship', 'playoff', 'finals',
      'game', 'match', 'team', 'player', 'coach',
      'league', 'division', 'conference',
      'super bowl', 'world series', 'stanley cup',
      'fifa', 'world cup', 'uefa', 'champions league',
      'premier league', 'la liga', 'serie a',
      'olympics', 'medal', 'gold',
      'ufc', 'boxing', 'fight', 'mma',
      'tennis', 'golf', 'f1', 'racing'
    ],
    'business': [
      'stock', 'stocks', 'market', 'markets', 'trading',
      'ipo', 'initial public offering',
      'company', 'corporation', 'firm',
      'ceo', 'executive', 'founder',
      'merger', 'acquisition', 'buyout', 'takeover',
      'nasdaq', 'dow', 'sp500', 's&p',
      'economy', 'economic', 'gdp', 'inflation',
      'earnings', 'revenue', 'profit',
      'apple', 'google', 'amazon', 'microsoft', 'meta', 'tesla',
      'startup', 'unicorn', 'valuation',
      'kraken', 'coinbase', 'stripe'
    ],
    'pop-culture': [
      'movie', 'movies', 'film', 'films', 'cinema',
      'actor', 'actress', 'celebrity', 'star',
      'music', 'musician', 'singer', 'band', 'album',
      'award', 'awards', 'oscar', 'oscars', 'academy',
      'grammy', 'grammys', 'emmy', 'emmys',
      'show', 'series', 'tv', 'television',
      'netflix', 'disney', 'hbo', 'streaming',
      'youtube', 'youtuber', 'influencer',
      'video game', 'gaming', 'esports',
      'fashion', 'model', 'runway'
    ],
  };

  return keywordMap[category] || [];
}

/**
 * Gets market details by ID
 */
export async function getMarketDetails(marketId: string): Promise<Market | null> {
  try {
    const cacheKey = `market:${marketId}`;
    const cached = await redisCache.get<Market>(cacheKey);

    if (cached) {
      logger.debug(`Returning cached market ${marketId}`);
      return cached;
    }

    logger.info(`Fetching market details for: ${marketId}`);

    const response = await axios.get(`${GAMMA_API_BASE}/markets/${marketId}`, {
      timeout: 10000,
    });

    const market: Market = response.data;

    await redisCache.set(cacheKey, market, CACHE_TTL);

    return market;
  } catch (error) {
    logger.error(`Error fetching market ${marketId}:`, error);
    return null;
  }
}

/**
 * Fetches a single event by its slug.
 * Returns { id, title, slug, markets, ... } or null if not found.
 */
export async function getEventBySlug(slug: string): Promise<Event | null> {
  try {
    const cacheKey = `event:slug:${slug}`;
    const cached = await redisCache.get<Event>(cacheKey);
    if (cached) return cached;

    const response = await axios.get(`${GAMMA_API_BASE}/events`, {
      params: { slug },
      timeout: 10000,
    });

    const data = response.data;
    const event: Event | null = Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
    if (!event) return null;

    await redisCache.set(cacheKey, event, CACHE_TTL);
    return event;
  } catch (error) {
    logger.error(`Error fetching event by slug "${slug}":`, error);
    return null;
  }
}

/**
 * Formats volume for display
 */
export function formatVolume(volume: number | string | null | undefined): string {
  const v = typeof volume === 'string' ? parseFloat(volume) : (volume ?? 0);
  if (v == null || isNaN(v)) return '$0';
  if (v >= 1000000) {
    return `$${(v / 1000000).toFixed(1)}M`;
  } else if (v >= 1000) {
    return `$${(v / 1000).toFixed(1)}K`;
  }
  return `$${v.toFixed(0)}`;
}

/**
 * Formats price as percentage
 */
export function formatPrice(price: string | number): string {
  const numPrice = typeof price === 'string' ? parseFloat(price) : price;
  return `${(numPrice * 100).toFixed(1)}%`;
}

/**
 * Safely parse outcome prices from market data
 */
export function parseOutcomePrices(market: Market): string[] {
  try {
    if (Array.isArray(market.outcomePrices)) {
      return market.outcomePrices;
    }
    if (typeof market.outcomePrices === 'string') {
      return JSON.parse(market.outcomePrices);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Safely parse outcomes from market data
 */
export function parseOutcomes(market: Market): string[] {
  try {
    if (Array.isArray(market.outcomes)) {
      return market.outcomes;
    }
    if (typeof market.outcomes === 'string') {
      return JSON.parse(market.outcomes);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Search markets by keyword using events endpoint
 */
export async function searchMarkets(keyword: string): Promise<Market[]> {
  try {
    const normalizedKeyword = keyword.toLowerCase().trim();
    const cacheKey = `markets:search:${normalizedKeyword}`;
    const cached = await redisCache.get<Market[]>(cacheKey);

    if (cached) {
      logger.debug(`Returning ${cached.length} cached search results for "${keyword}"`);
      return cached;
    }

    logger.info(`Searching markets for keyword: "${keyword}" using events endpoint`);

    // Use events endpoint for better performance
    const response = await axios.get(`${GAMMA_API_BASE}/events`, {
      params: {
        active: true,
        closed: false,
        limit: 100,
      },
      timeout: 15000,
    });

    const events: Event[] = response.data;

    // Filter events by keyword
    const filteredEvents = events.filter(event => {
      const searchText = `${event.title} ${event.slug} ${event.description || ''}`.toLowerCase();
      return searchText.includes(normalizedKeyword);
    });

    // Extract markets from filtered events
    const allMarkets: Market[] = [];
    for (const event of filteredEvents) {
      if (event.markets && Array.isArray(event.markets)) {
        // Create clean event info without circular references
        const eventInfo = {
          id: event.id,
          title: event.title,
          slug: event.slug,
          description: event.description,
          image: event.image,
          volume24hr: event.volume24hr,
          volume: event.volume,
          liquidity: event.liquidity,
          markets: [], // Empty array to avoid circular reference
          active: event.active,
          closed: event.closed
        };

        for (const market of event.markets) {
          // Filter individual markets by keyword
          const marketText = `${market.question} ${market.slug}`.toLowerCase();
          const eventMatches = filteredEvents.some(e => e.id === event.id);
          const marketMatches = marketText.includes(normalizedKeyword);

          // Include if either event or market matches the keyword
          if (eventMatches || marketMatches) {
            // Create a clean market object without circular references
            const cleanMarket: Market = {
              id: market.id,
              question: market.question,
              slug: market.slug,
              image: market.image,
              endDate: market.endDate,
              active: market.active,
              closed: market.closed,
              volume24hr: market.volume24hr,
              volumeNum: market.volumeNum,
              liquidity: market.liquidity,
              outcomePrices: market.outcomePrices,
              outcomes: market.outcomes,
              events: [eventInfo]
            };
            allMarkets.push(cleanMarket);
          }
        }
      }
    }

    // Filter and sort by volume
    const sortedMarkets = allMarkets
      .filter(m => {
        // Filter out markets with no volume
        if (!m.volume24hr || m.volume24hr <= 0) return false;

        // Parse prices safely
        const prices = parseOutcomePrices(m);
        if (!prices || prices.length < 2) return false;

        // Check if prices are valid numbers
        const price1 = parseFloat(prices[0]);
        const price2 = parseFloat(prices[1]);

        return !isNaN(price1) && !isNaN(price2);
      })
      .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));

    // Cache results for shorter time
    await redisCache.set(cacheKey, sortedMarkets, SEARCH_CACHE_TTL);

    logger.info(`Found ${sortedMarkets.length} markets for keyword "${keyword}" from ${filteredEvents.length} events`);
    return sortedMarkets;
  } catch (error) {
    logger.error(`Error searching markets for "${keyword}":`, error);
    throw new Error('Failed to search markets');
  }
}

/**
 * Search active events by keyword. Returns up to `limit` Event objects
 * sorted by 24h volume, cached for 2 minutes.
 */
export async function searchEventsByKeyword(keyword: string, limit = 8): Promise<Event[]> {
  try {
    const normalized = keyword.toLowerCase().trim();
    if (!normalized || normalized.length < 2) return [];

    // v2 cache key (busts stale empty caches from previous search approach)
    const cacheKey = `events:kw:v2:${normalized}`;
    const cached = await redisCache.get<Event[]>(cacheKey);
    if (cached) return cached;

    // Use the dedicated /public-search endpoint — server-side keyword matching
    const response = await axios.get(`${GAMMA_API_BASE}/public-search`, {
      params: {
        q: normalized,
        events_status: 'active',
        limit_per_type: Math.max(limit, 10),
        search_tags: false,
        search_profiles: false,
      },
      timeout: 15000,
    });

    const rawEvents: any[] = response.data?.events ?? [];

    const sorted = rawEvents
      .filter((e: any) => Array.isArray(e.markets) && e.markets.length > 0)
      .sort((a: any, b: any) => (b.volume24hr || 0) - (a.volume24hr || 0))
      .slice(0, limit) as Event[];

    await redisCache.set(cacheKey, sorted, 2 * 60);
    logger.info(`[search] "${keyword}" → ${sorted.length} events via /public-search`);
    return sorted;
  } catch (error) {
    logger.error(`[search] Error searching events for "${keyword}":`, error);
    return [];
  }
}
