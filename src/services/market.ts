import axios from 'axios';
import { logger } from '../utils/logger';
import { redisCache } from '../database/redis';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const CACHE_TTL = 180; // 3 minutes - shorter cache for more real-time data
const SEARCH_CACHE_TTL = 120; // 2 minutes for search results

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
        limit: Math.min(limit * 2, 100),
      },
      timeout: 15000,
    });

    const events: Event[] = response.data;

    // Filter and sort events, and filter out non-tradeable markets
    const sortedEvents = events
      .filter(e => {
        if (!e.volume24hr || e.volume24hr <= 0) return false;
        if (!e.markets || !Array.isArray(e.markets) || e.markets.length === 0) return false;
        return true;
      })
      .map(e => {
        // Filter out markets that cannot be traded
        const tradeableMarkets = e.markets.filter(m => {
          // Must be active and not closed
          if (!m.active || m.closed) return false;

          // Must have outcomes (binary markets)
          const outcomes = Array.isArray(m.outcomes) ? m.outcomes :
                          typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : [];
          if (!outcomes || outcomes.length !== 2) return false;

          // Must have outcome prices
          const prices = Array.isArray(m.outcomePrices) ? m.outcomePrices :
                        typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : [];
          if (!prices || prices.length !== 2) return false;

          // Prices must be valid numbers between 0 and 1
          const price0 = parseFloat(prices[0]);
          const price1 = parseFloat(prices[1]);
          if (isNaN(price0) || isNaN(price1)) return false;
          if (price0 < 0 || price0 > 1 || price1 < 0 || price1 > 1) return false;

          // Must have conditionId for CLOB API trading
          const conditionId = (m as any).conditionId || (m as any).condition_id;
          if (!conditionId) return false;

          // Must have valid clobTokenIds
          try {
            let clobTokenIds: any[] = [];
            if ((m as any).clobTokenIds) {
              if (Array.isArray((m as any).clobTokenIds)) {
                clobTokenIds = (m as any).clobTokenIds;
              } else if (typeof (m as any).clobTokenIds === 'string') {
                clobTokenIds = JSON.parse((m as any).clobTokenIds);
              }
            }

            // Must have 2 valid token IDs
            if (clobTokenIds.length !== 2 || !clobTokenIds[0] || !clobTokenIds[1]) {
              return false;
            }
          } catch (e) {
            // If parsing fails, filter out this market
            return false;
          }

          return true;
        });

        // Return event with filtered markets
        return { ...e, markets: tradeableMarkets };
      })
      .filter(e => e.markets.length > 0) // Remove events with no tradeable markets
      .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0))
      .slice(0, limit);

    await redisCache.set(cacheKey, sortedEvents, CACHE_TTL);

    logger.info(`Fetched ${sortedEvents.length} top events`);
    return sortedEvents;
  } catch (error) {
    logger.error('Error fetching top events:', error);
    throw new Error('Failed to fetch top events');
  }
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
 * Gets events by category using events endpoint
 * Returns events instead of individual markets for better UX
 */
export async function getEventsByCategory(category: string, limit: number = 50): Promise<Event[]> {
  try {
    const cacheKey = `events:category:${category}:${limit}`;
    const cached = await redisCache.get<Event[]>(cacheKey);

    if (cached) {
      logger.debug(`Returning ${cached.length} cached events for category ${category}`);
      return cached;
    }

    logger.info(`Fetching events for category: ${category}`);

    const response = await axios.get(`${GAMMA_API_BASE}/events`, {
      params: {
        active: true,
        closed: false,
        limit: 100,
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

    // Sort by volume and filter out non-tradeable markets
    const sortedEvents = filteredEvents
      .filter(e => {
        if (!e.volume24hr || e.volume24hr <= 0) return false;
        if (!e.markets || !Array.isArray(e.markets) || e.markets.length === 0) return false;
        return true;
      })
      .map(e => {
        // Filter out markets that cannot be traded
        const tradeableMarkets = e.markets.filter(m => {
          // Must be active and not closed
          if (!m.active || m.closed) return false;

          // Must have outcomes (binary markets)
          const outcomes = Array.isArray(m.outcomes) ? m.outcomes :
                          typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : [];
          if (!outcomes || outcomes.length !== 2) return false;

          // Must have outcome prices
          const prices = Array.isArray(m.outcomePrices) ? m.outcomePrices :
                        typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : [];
          if (!prices || prices.length !== 2) return false;

          // Prices must be valid numbers between 0 and 1
          const price0 = parseFloat(prices[0]);
          const price1 = parseFloat(prices[1]);
          if (isNaN(price0) || isNaN(price1)) return false;
          if (price0 < 0 || price0 > 1 || price1 < 0 || price1 > 1) return false;

          // Must have conditionId for CLOB API trading
          const conditionId = (m as any).conditionId || (m as any).condition_id;
          if (!conditionId) return false;

          // Must have valid clobTokenIds
          try {
            let clobTokenIds: any[] = [];
            if ((m as any).clobTokenIds) {
              if (Array.isArray((m as any).clobTokenIds)) {
                clobTokenIds = (m as any).clobTokenIds;
              } else if (typeof (m as any).clobTokenIds === 'string') {
                clobTokenIds = JSON.parse((m as any).clobTokenIds);
              }
            }

            // Must have 2 valid token IDs
            if (clobTokenIds.length !== 2 || !clobTokenIds[0] || !clobTokenIds[1]) {
              return false;
            }
          } catch (e) {
            // If parsing fails, filter out this market
            return false;
          }

          return true;
        });

        // Return event with filtered markets
        return { ...e, markets: tradeableMarkets };
      })
      .filter(e => e.markets.length > 0) // Remove events with no tradeable markets
      .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0))
      .slice(0, limit);

    await redisCache.set(cacheKey, sortedEvents, CACHE_TTL);

    logger.info(`Fetched ${sortedEvents.length} events for category ${category}`);
    return sortedEvents;
  } catch (error) {
    logger.error(`Error fetching events for category ${category}:`, error);
    throw new Error(`Failed to fetch events for category ${category}`);
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
 * Formats volume for display
 */
export function formatVolume(volume: number): string {
  if (volume >= 1000000) {
    return `$${(volume / 1000000).toFixed(1)}M`;
  } else if (volume >= 1000) {
    return `$${(volume / 1000).toFixed(1)}K`;
  }
  return `$${volume.toFixed(0)}`;
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
