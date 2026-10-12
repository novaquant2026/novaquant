import crypto from 'crypto';
import { SupportedExchange } from '../../src/types';
import {
  ExchangeAdapter,
  AccountBalance,
  OrderRequest,
  OrderResult,
  Position,
  Order,
  ConnectionStatus,
  ConnectionTestResult,
} from './types';
import { fetchBitgetRealBalances } from '../exchangeBalanceService';

export class BitgetExchangeAdapter implements ExchangeAdapter {
  readonly exchange: SupportedExchange = 'Bitget';
  private apiKey: string;
  private secretKey: string;
  private passphrase?: string;
  private isDemoMode: boolean;

  constructor(apiKey: string, secretKey: string, passphrase?: string, isDemoMode: boolean = false) {
    this.apiKey = apiKey?.trim() || '';
    this.secretKey = secretKey?.trim() || '';
    this.passphrase = passphrase?.trim();
    this.isDemoMode = isDemoMode;
  }


  private signBitget(timestamp: string, method: string, requestPath: string, bodyString: string = ''): string {
    const message = timestamp + method.toUpperCase() + requestPath + bodyString;
    return crypto.createHmac('sha256', this.secretKey).update(message).digest('base64');
  }

  private async makeV2Request(
    endpoint: string,
    params: Record<string, any> = {},
    method: 'GET' | 'POST' = 'GET'
  ): Promise<any> {
    const timestamp = Date.now().toString();
    let fullUrl = `https://api.bitget.com${endpoint}`;
    let bodyString = '';

    const headers: Record<string, string> = {
      'ACCESS-KEY': this.apiKey,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': this.passphrase || '',
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = { method };

    if (method === 'GET') {
      const queryString = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
      if (queryString) {
        fullUrl += `?${queryString}`;
        headers['ACCESS-SIGN'] = this.signBitget(timestamp, 'GET', `${endpoint}?${queryString}`, '');
      } else {
        headers['ACCESS-SIGN'] = this.signBitget(timestamp, 'GET', endpoint, '');
      }
    } else {
      bodyString = JSON.stringify(params);
      fetchOptions.body = bodyString;
      headers['ACCESS-SIGN'] = this.signBitget(timestamp, 'POST', endpoint, bodyString);
    }

    fetchOptions.headers = headers;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(fullUrl, { ...fetchOptions, signal: controller.signal });
      const data = await res.json();
      if (!res.ok || (data.code && data.code !== '00000')) {
        throw new Error(data.msg || `Bitget API error (${data.code || res.status})`);
      }
      return data.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async connect(): Promise<ConnectionStatus> {
    if (!this.apiKey || !this.secretKey) return 'DISCONNECTED';
    if (this.apiKey.length < 10 || this.secretKey.length < 10) return 'ERROR';
    return 'CONNECTED';
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    try {
      if (this.isDemoMode) {
        return {
          success: true,
          status: 'CONNECTED',
          exchange: 'Bitget',
          latencyMs: 45,
          permissions: { read: true, trade: true, withdrawal: false },
        };
      }
      const data = await this.makeV2Request('/api/v2/spot/account/info', {}, 'GET');
      const latencyMs = Date.now() - startTime;
      const authorities = Array.isArray(data?.authorities) ? data.authorities : [];
      const canWithdraw = authorities.some((a: string) => a.toLowerCase().includes('withdraw'));

      if (canWithdraw) {
        return {
          success: false,
          status: 'ERROR',
          exchange: 'Bitget',
          latencyMs,
          permissions: { read: true, trade: true, withdrawal: true },
          errorMessage: 'SECURITY REJECTION: API key has withdrawal permissions enabled. For safety, disable withdrawals on Bitget before connecting.',
        };
      }

      return {
        success: true,
        status: 'CONNECTED',
        exchange: 'Bitget',
        latencyMs,
        permissions: { read: true, trade: true, withdrawal: false },
      };
    } catch (err: any) {
      return {
        success: false,
        status: 'ERROR',
        exchange: 'Bitget',
        latencyMs: Date.now() - startTime,
        permissions: { read: false, trade: false, withdrawal: false },
        errorMessage: err.message || 'Bitget connection test failed',
      };
    }
  }

  async getAccountBalance(): Promise<AccountBalance> {
    const balances = await fetchBitgetRealBalances(this.apiKey, this.secretKey, this.passphrase);
    const spotAvailable = balances.spot.available;
    const futuresAvailable = balances.futures.available;
    const totalUSDT = Number((balances.spot.capital + balances.futures.capital).toFixed(4));
    const availableUSDT = Number((spotAvailable + futuresAvailable).toFixed(4));
    const lockedUSDT = Number((balances.spot.lockedInOrders + balances.futures.lockedInOrders).toFixed(4));
    const unrealizedPnL = balances.futures.unrealizedPnl || 0;

    return {
      exchange: 'Bitget',
      totalUSDT,
      availableUSDT,
      lockedUSDT,
      unrealizedPnL,
      spotAvailable,
      futuresAvailable,
      timestamp: Date.now(),
      rawSummary: balances.rawSummary,
    };
  }

  async getAvailableBalance(): Promise<number> {
    const details = await this.getAccountBalance();
    return details.availableUSDT;
  }

  async getAvailableUSDT(): Promise<number> {
    return this.getAvailableBalance();
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    try {
      const data = await this.makeV2Request('/api/v2/mix/position/all-position', { productType: 'USDT-FUTURES' }, 'GET');
      if (Array.isArray(data)) {
        const cleanSymbol = symbol ? symbol.replace('/', '').toUpperCase() : null;
        return data
          .filter((p: any) => {
            if (parseFloat(p.total) <= 0) return false;
            if (cleanSymbol && p.symbol !== cleanSymbol) return false;
            return true;
          })
          .map((p: any) => ({
            symbol: p.symbol,
            side: p.holdSide === 'long' ? 'LONG' : 'SHORT',
            size: parseFloat(p.total),
            entryPrice: parseFloat(p.openPriceAvg || '0'),
            markPrice: parseFloat(p.markPrice || '0'),
            unrealizedPnl: parseFloat(p.unrealizedPL || '0'),
            leverage: parseFloat(p.leverage || '1'),
            margin: parseFloat(p.margin || '0'),
          }));
      }
    } catch (err: any) {
      console.warn('[BITGET ADAPTER] Failed fetching positions:', err.message);
    }
    return [];
  }

  async getOpenPositions(): Promise<Position[]> {
    return this.getPositions();
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    try {
      const params: Record<string, any> = {};
      if (symbol) params.symbol = symbol.replace('/', '').toUpperCase();
      const data = await this.makeV2Request('/api/v2/spot/trade/unfilled-orders', params, 'GET');
      if (Array.isArray(data)) {
        return data.map((o: any) => ({
          orderId: o.orderId,
          clientOrderId: o.clientOid,
          symbol: o.symbol,
          side: o.side === 'buy' ? 'BUY' : 'SELL',
          price: parseFloat(o.price || '0'),
          origQty: parseFloat(o.size || '0'),
          executedQty: parseFloat(o.baseVolume || '0'),
          status: o.status,
          time: parseInt(o.cTime || Date.now().toString(), 10),
        }));
      }
    } catch (err: any) {
      console.warn('[BITGET ADAPTER] Failed fetching open orders:', err.message);
    }
    return [];
  }

  async getOrderHistory(symbol?: string, limit: number = 50): Promise<Order[]> {
    try {
      const params: Record<string, any> = { limit };
      if (symbol) params.symbol = symbol.replace('/', '').toUpperCase();
      const data = await this.makeV2Request('/api/v2/spot/trade/history-orders', params, 'GET');
      if (Array.isArray(data)) {
        return data.map((o: any) => ({
          orderId: o.orderId,
          clientOrderId: o.clientOid,
          symbol: o.symbol,
          side: o.side === 'buy' ? 'BUY' : 'SELL',
          price: parseFloat(o.price || '0'),
          origQty: parseFloat(o.size || '0'),
          executedQty: parseFloat(o.baseVolume || '0'),
          status: o.status,
          time: parseInt(o.cTime || Date.now().toString(), 10),
        }));
      }
    } catch (err: any) {
      console.warn('[BITGET ADAPTER] Failed fetching order history:', err.message);
    }
    return [];
  }

  async getMarketPrice(symbol: string): Promise<number> {
    try {
      const cleanSymbol = symbol.replace('/', '').toUpperCase();
      const res = await fetch(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${cleanSymbol}`);
      const json = await res.json();
      if (json?.data?.[0]?.lastPr) {
        return parseFloat(json.data[0].lastPr);
      }
    } catch (err: any) {
      console.warn(`[BITGET ADAPTER] Market price query failed for ${symbol}:`, err.message);
    }
    return 0;
  }


  async placeOrder(orderRequest: OrderRequest): Promise<OrderResult> {
    const cleanSymbol = orderRequest.symbol.replace('/', '').toUpperCase();
    const clientOrderId = orderRequest.clientOrderId || `bg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    if (this.isDemoMode) {
      return {
        orderId: `demo_bitget_${Date.now()}`,
        clientOrderId,
        symbol: orderRequest.symbol,
        side: orderRequest.side,
        type: orderRequest.type,
        status: 'FILLED',
        executedQty: orderRequest.quantity,
        cummulativeQuoteQty: (orderRequest.price || 65000) * orderRequest.quantity,
        price: orderRequest.price || 65000,
        avgPrice: orderRequest.price || 65000,
        timestamp: Date.now(),
      };
    }


    const payload: Record<string, any> = {
      symbol: cleanSymbol,
      side: orderRequest.side === 'BUY' ? 'buy' : 'sell',
      orderType: orderRequest.type === 'MARKET' ? 'market' : 'limit',
      size: String(orderRequest.quantity),
      clientOid: clientOrderId,
      force: 'gtc',
    };

    if (orderRequest.type === 'LIMIT' && orderRequest.price) {
      payload.price = String(orderRequest.price);
    }

    const result = await this.makeV2Request('/api/v2/spot/trade/place-order', payload, 'POST');

    return {
      orderId: result.orderId,
      clientOrderId: result.clientOid || clientOrderId,
      symbol: cleanSymbol,
      side: orderRequest.side,
      type: orderRequest.type,
      status: 'NEW',
      executedQty: 0,
      cummulativeQuoteQty: 0,
      price: orderRequest.price || 0,
      timestamp: Date.now(),
      raw: result,
    };
  }

  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    try {
      const cleanSymbol = symbol.replace('/', '');
      await this.makeV2Request('/api/v2/spot/trade/cancel-order', { symbol: cleanSymbol, orderId }, 'POST');
      return true;
    } catch (err: any) {
      console.warn('[BITGET ADAPTER] Cancel order failed:', err.message);
      return false;
    }
  }

  async getOrderStatus(orderId: string, symbol: string): Promise<OrderResult> {
    const cleanSymbol = symbol.replace('/', '');
    const result = await this.makeV2Request('/api/v2/spot/trade/order-info', { symbol: cleanSymbol, orderId }, 'GET');
    return {
      orderId: result.orderId || orderId,
      clientOrderId: result.clientOid,
      symbol: result.symbol || cleanSymbol,
      side: result.side === 'buy' ? 'BUY' : 'SELL',
      status: result.status || 'NEW',
      executedQty: parseFloat(result.baseVolume || '0'),
      cummulativeQuoteQty: parseFloat(result.quoteVolume || '0'),
      price: parseFloat(result.price || '0'),
      avgPrice: parseFloat(result.priceAvg || '0'),
      timestamp: parseInt(result.uTime || Date.now().toString(), 10),
      raw: result,
    };
  }
}
