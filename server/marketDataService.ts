import { Candle, MarketData } from '../src/types';

export const SUPPORTED_PAIRS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];

interface CachedMarket {
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume: number;
  candles: Candle[];
  lastUpdated: number;
}

const cache: Record<string, CachedMarket> = {};

function formatBinanceSymbol(symbol: string): string {
  return symbol.replace('/', '').toUpperCase();
}

/**
 * Fetches real market candles and 24h ticker directly from Binance public API
 */
export async function fetchLiveMarketData(symbol: string): Promise<{
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume: number;
  candles: Candle[];
}> {
  const cleanSymbol = symbol.trim().toUpperCase();
  const binanceSymbol = formatBinanceSymbol(cleanSymbol);
  const now = Date.now();

  // Return cache if refreshed within last 4 seconds
  if (cache[cleanSymbol] && now - cache[cleanSymbol].lastUpdated < 4000) {
    return cache[cleanSymbol];
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const [tickerRes, klinesRes] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${binanceSymbol}`, {
        signal: controller.signal,
      }),
      fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=1h&limit=80`, {
        signal: controller.signal,
      }),
    ]);

    clearTimeout(timeout);

    if (!tickerRes.ok || !klinesRes.ok) {
      throw new Error(`Binance API error: ticker ${tickerRes.status}, klines ${klinesRes.status}`);
    }

    const ticker = await tickerRes.json();
    const klines = await klinesRes.json();

    const price = parseFloat(ticker.lastPrice || '0');
    const change24h = parseFloat(ticker.priceChangePercent || '0');
    const high24h = parseFloat(ticker.highPrice || '0');
    const low24h = parseFloat(ticker.lowPrice || '0');
    const volume = parseFloat(ticker.volume || '0');

    const candles: Candle[] = Array.isArray(klines)
      ? klines.map((k: any) => ({
          time: Number(k[0]),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }))
      : [];

    const result: CachedMarket = {
      price: price > 0 ? price : (cache[cleanSymbol]?.price || 67000),
      change24h,
      high24h,
      low24h,
      volume,
      candles: candles.length > 0 ? candles : (cache[cleanSymbol]?.candles || []),
      lastUpdated: now,
    };

    cache[cleanSymbol] = result;
    return result;
  } catch (error: any) {
    console.warn(`[MARKET DATA] Binance fetch failed for ${symbol}, using cached fallback:`, error?.message || error);
    
    // Fallback cache or realistic base
    if (cache[cleanSymbol]) {
      return cache[cleanSymbol];
    }

    const defaultPrices: Record<string, number> = {
      'BTC/USDT': 67450.0,
      'ETH/USDT': 3520.0,
      'SOL/USDT': 185.0,
      'BNB/USDT': 595.0,
      'XRP/USDT': 0.62,
    };

    const fallbackPrice = defaultPrices[cleanSymbol] || 100.0;
    return {
      price: fallbackPrice,
      change24h: 0,
      high24h: fallbackPrice,
      low24h: fallbackPrice,
      volume: 0,
      candles: [],
    };
  }
}
