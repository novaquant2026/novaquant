export * from './types';
export * from './BinanceExchangeAdapter';
export * from './BybitExchangeAdapter';
export * from './BitgetExchangeAdapter';

import { SupportedExchange } from '../../src/types';
import { ExchangeAdapter } from './types';
import { BinanceExchangeAdapter } from './BinanceExchangeAdapter';
import { BybitExchangeAdapter } from './BybitExchangeAdapter';
import { BitgetExchangeAdapter } from './BitgetExchangeAdapter';

export interface AdapterCredentials {
  apiKey: string;
  secretKey: string;
  passphrase?: string;
  isDemoMode?: boolean;
}

export function createExchangeAdapter(
  exchange: SupportedExchange,
  credentials: AdapterCredentials
): ExchangeAdapter {
  const norm = exchange.toLowerCase();
  if (norm.includes('bitg')) {
    return new BitgetExchangeAdapter(
      credentials.apiKey,
      credentials.secretKey,
      credentials.passphrase,
      credentials.isDemoMode
    );
  } else if (norm.includes('bybit')) {
    return new BybitExchangeAdapter(
      credentials.apiKey,
      credentials.secretKey,
      credentials.isDemoMode
    );
  } else {
    return new BinanceExchangeAdapter(
      credentials.apiKey,
      credentials.secretKey,
      credentials.isDemoMode
    );
  }
}

