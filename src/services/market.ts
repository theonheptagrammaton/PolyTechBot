import axios from 'axios';
import { logger } from '../utils/logger';
import { redisCache } from '../database/redis';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const CACHE_TTL = 300; // 5 minutes

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
  markets?: number;
}

export interface Category {
  name: string;
  slug: string;
  emoji: string;
  volume24hr: number;
}

/**
 * Gets top categories based on event volume
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
        closed: false,
        active: true,
        limit: 20,
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

    // Calculate total volume for "All Markets"
    const totalVolume = events.reduce((sum, event) => sum + (event.volume24hr || 0), 0);
    const allMarketsCategory = categories.find(c => c.slug === 'all');
    if (allMarketsCategory) {
      allMarketsCategory.volume24hr = totalVolume;
    }

    await redisCache.set(cacheKey, categories, CACHE_TTL);

    logger.info(`Fetched ${categories.length} categories`);
    return categories;
  } catch (error) {
    logger.error('Error fetching categories:', error);
    throw new Error('Failed to fetch market categories');
  }
}

/**
 * Gets top markets by volume (all markets)
 */
export async function getTopMarkets(limit: number = 50): Promise<Market[]> {
  try {
    const cacheKey = `markets:top_markets:${limit}`;
    const cached = await redisCache.get<Market[]>(cacheKey);

    if (cached) {
      logger.debug(`Returning ${cached.length} cached markets`);
      return cached;
    }

    logger.info(`Fetching top ${limit} markets from Gamma API...`);

    const response = await axios.get(`${GAMMA_API_BASE}/markets`, {
      params: {
        closed: false,
        active: true,
        limit: Math.min(limit * 2, 100), // Fetch more to have better data after filtering
      },
      timeout: 15000,
    });

    const markets: Market[] = response.data;

    // Sort by 24hr volume and filter out markets with invalid prices
    const sortedMarkets = markets
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

    logger.info(`Fetched ${sortedMarkets.length} top markets`);
    return sortedMarkets;
  } catch (error) {
    logger.error('Error fetching top markets:', error);
    throw new Error('Failed to fetch top markets');
  }
}

/**
 * Gets markets by category (direct market filtering)
 */
export async function getMarketsByCategory(category: string, limit: number = 50): Promise<Market[]> {
  try {
    const cacheKey = `markets:category:${category}:${limit}`;
    const cached = await redisCache.get<Market[]>(cacheKey);

    if (cached) {
      logger.debug(`Returning ${cached.length} cached markets for category ${category}`);
      return cached;
    }

    logger.info(`Fetching markets for category: ${category}`);

    // Fetch more markets to have better filtering options
    const response = await axios.get(`${GAMMA_API_BASE}/markets`, {
      params: {
        closed: false,
        active: true,
        limit: 100, // Get more markets for better filtering
      },
      timeout: 15000,
    });

    const allMarkets: Market[] = response.data;

    // Filter markets based on category keywords
    const categoryKeywords = getCategoryKeywords(category);
    const filteredMarkets = allMarkets.filter(market => {
      // Parse prices safely
      const prices = parseOutcomePrices(market);
      if (!prices || prices.length < 2) return false;

      // Check if prices are valid numbers
      const price1 = parseFloat(prices[0]);
      const price2 = parseFloat(prices[1]);
      if (isNaN(price1) || isNaN(price2)) return false;

      // Filter by category keywords
      const searchText = `${market.question} ${market.slug}`.toLowerCase();

      // Check if any event titles match
      const eventText = market.events
        ? market.events.map(e => `${e.title} ${e.slug}`).join(' ').toLowerCase()
        : '';

      const fullText = `${searchText} ${eventText}`;
      return categoryKeywords.some(keyword => fullText.includes(keyword.toLowerCase()));
    });

    // Sort by volume and limit
    const sortedMarkets = filteredMarkets
      .filter(m => m.volume24hr > 0)
      .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0))
      .slice(0, limit);

    await redisCache.set(cacheKey, sortedMarkets, CACHE_TTL);

    logger.info(`Fetched ${sortedMarkets.length} markets for category ${category}`);
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
 * Search markets by keyword
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

    logger.info(`Searching markets for keyword: "${keyword}"`);

    // Fetch active markets
    const response = await axios.get(`${GAMMA_API_BASE}/markets`, {
      params: {
        closed: false,
        active: true,
        limit: 100,
      },
      timeout: 15000,
    });

    const allMarkets: Market[] = response.data;

    // Filter markets by keyword in question and events
    const filteredMarkets = allMarkets.filter(market => {
      // Parse prices safely
      const prices = parseOutcomePrices(market);
      if (!prices || prices.length < 2) return false;

      // Check if prices are valid numbers
      const price1 = parseFloat(prices[0]);
      const price2 = parseFloat(prices[1]);
      if (isNaN(price1) || isNaN(price2)) return false;

      // Search in question and slug
      const questionText = `${market.question} ${market.slug}`.toLowerCase();

      // Search in event titles
      const eventText = market.events
        ? market.events.map(e => `${e.title} ${e.slug}`).join(' ').toLowerCase()
        : '';

      const fullText = `${questionText} ${eventText}`;
      return fullText.includes(normalizedKeyword);
    });

    // Sort by volume
    const sortedMarkets = filteredMarkets
      .filter(m => m.volume24hr > 0)
      .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));

    // Cache results for shorter time (2 minutes)
    await redisCache.set(cacheKey, sortedMarkets, 120);

    logger.info(`Found ${sortedMarkets.length} markets for keyword "${keyword}"`);
    return sortedMarkets;
  } catch (error) {
    logger.error(`Error searching markets for "${keyword}":`, error);
    throw new Error('Failed to search markets');
  }
}
