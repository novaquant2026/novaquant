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
import { fetchBybitRealBalances } from '../exchangeBalanceService';

export class BybitExchangeAdapter implements ExchangeAdapter {
  readonly exchange: SupportedExchange = 'Bybit';
  private apiKey: string;
  private secretKey: string;
  private isDemoMode: boolean;

  constructor(apiKey: string, secretKey: string, isDemoMode: boolean = false) {
    this.apiKey = apiKey?.trim() || '';
    this.secretKey = secretKey?.trim() || '';
    this.isDemoMode = isDemoMode;
  }


  private signPayload(timestamp: string, recvWindow: string, paramsString: string): string {
    const payload = timestamp + this.apiKey + recvWindow + paramsString;
    return crypto.createHmac('sha256', this.secretKey).update(payload).digest('hex');
  }

  private async makeV5Request(
    endpoint: string,
    params: Record<string, any> = {},
    method: 'GET' | 'POST' = 'GET'
  ): Promise<any> {
    const timestamp = Date.now().toString();
    const recvWindow = '10000';
    let fullUrl = `https://api.bybit.com${endpoint}`;
    let paramsString = '';
    const headers: Record<string, string> = {
      'X-BAPI-API-KEY': this.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = { method };

    if (method === 'GET') {
      const queryString = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
      paramsString = queryString;
      if (queryString) fullUrl += `?${queryString}`;
    } else {
      paramsString = JSON.stringify(params);
      fetchOptions.body = paramsString;
    }

    headers['X-BAPI-SIGN'] = this.signPayload(timestamp, recvWindow, paramsString);
    fetchOptions.headers = headers;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(fullUrl, { ...fetchOptions, signal: controller.signal });
      const data = await res.json();
      if (!res.ok || data.retCode !== 0) {
        throw new Error(data.retMsg || `Bybit API request failed (${res.status})`);
      }
      return data.result;
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
          exchange: 'Bybit',
          latencyMs: 38,
          permissions: { read: true, trade: true, withdrawal: false },
        };
      }
      const data = await this.makeV5Request('/v5/user/query-api', {}, 'GET');
      const latencyMs = Date.now() - startTime;
      const perms = data?.result?.permissions || {};
      const canWithdraw = Array.isArray(perms.Wallet) && perms.Wallet.includes('Withdraw');

      if (canWithdraw) {
        return {
          success: false,
          status: 'ERROR',
          exchange: 'Bybit',
          latencyMs,
          permissions: { read: true, trade: true, withdrawal: true },
          errorMessage: 'SECURITY REJECTION: API key has withdrawal permissions enabled. For safety, disable withdrawals on Bybit before connecting.',
        };
      }

      return {
        success: true,
        status: 'CONNECTED',
        exchange: 'Bybit',
        latencyMs,
        permissions: { read: true, trade: true, withdrawal: false },
      };
    } catch (err: any) {
      return {
        success: false,
        status: 'ERROR',
        exchange: 'Bybit',
        latencyMs: Date.now() - startTime,
        permissions: { read: false, trade: false, withdrawal: false },
        errorMessage: err.message || 'Bybit connection test failed',
      };
    }
  }

  async getAccountBalance(): Promise<AccountBalance> {
    const balances = await fetchBybitRealBalances(this.apiKey, this.secretKey);
    const spotAvailable = balances.spot.available;
    const futuresAvailable = balances.futures.available;
    const totalUSDT = Number(Math.max(balances.spot.capital, balances.futures.capital).toFixed(4));
    const availableUSDT = Number(Math.max(spotAvailable, futuresAvailable).toFixed(4));
    const lockedUSDT = Number(Math.max(balances.spot.lockedInOrders, balances.futures.lockedInOrders).toFixed(4));
    const unrealizedPnL = balances.futures.unrealizedPnl || 0;

    return {
      exchange: 'Bybit',
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
      const params: Record<string, any> = { category: 'linear', settleCoin: 'USDT' };
      if (symbol) params.symbol = symbol.replace('/', '').toUpperCase();
      const result = await this.makeV5Request('/v5/position/list', params, 'GET');
      if (result && Array.isArray(result.list)) {
        return result.list
          .filter((p: any) => parseFloat(p.size) > 0)
          .map((p: any) => ({
            symbol: p.symbol,
            side: p.side === 'Buy' ? 'LONG' : 'SHORT',
            size: parseFloat(p.size),
            entryPrice: parseFloat(p.avgPrice || '0'),
            markPrice: parseFloat(p.markPrice || '0'),
            unrealizedPnl: parseFloat(p.unrealisedPnl || '0'),
            leverage: parseFloat(p.leverage || '1'),
            margin: parseFloat(p.positionIM || '0'),
          }));
      }
    } catch (err: any) {
      console.warn('[BYBIT ADAPTER] Failed fetching positions:', err.message);
    }
    return [];
  }

  async getOpenPositions(): Promise<Position[]> {
    return this.getPositions();
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    try {
      const params: Record<string, any> = { category: 'spot' };
      if (symbol) params.symbol = symbol.replace('/', '').toUpperCase();
      const result = await this.makeV5Request('/v5/order/realtime', params, 'GET');
      if (result && Array.isArray(result.list)) {
        return result.list.map((o: any) => ({
          orderId: o.orderId,
          clientOrderId: o.orderLinkId,
          symbol: o.symbol,
          side: o.side === 'Buy' ? 'BUY' : 'SELL',
          price: parseFloat(o.price || '0'),
          origQty: parseFloat(o.qty || '0'),
          executedQty: parseFloat(o.cumExecQty || '0'),
          status: o.orderStatus,
          time: parseInt(o.createdTime || Date.now().toString(), 10),
        }));
      }
    } catch (err: any) {
      console.warn('[BYBIT ADAPTER] Failed fetching open orders:', err.message);
    }
    return [];
  }

  async getOrderHistory(symbol?: string, limit: number = 50): Promise<Order[]> {
    try {
      const params: Record<string, any> = { category: 'spot', limit };
      if (symbol) params.symbol = symbol.replace('/', '').toUpperCase();
      const result = await this.makeV5Request('/v5/order/history', params, 'GET');
      if (result && Array.isArray(result.list)) {
        return result.list.map((o: any) => ({
          orderId: o.orderId,
          clientOrderId: o.orderLinkId,
          symbol: o.symbol,
          side: o.side === 'Buy' ? 'BUY' : 'SELL',
          price: parseFloat(o.price || '0'),
          origQty: parseFloat(o.qty || '0'),
          executedQty: parseFloat(o.cumExecQty || '0'),
          status: o.orderStatus,
          time: parseInt(o.createdTime || Date.now().toString(), 10),
        }));
      }
    } catch (err: any) {
      console.warn('[BYBIT ADAPTER] Failed fetching order history:', err.message);
    }
    return [];
  }

  async getMarketPrice(symbol: string): Promise<number> {
    try {
      const cleanSymbol = symbol.replace('/', '').toUpperCase();
      const res = await fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${cleanSymbol}`);
      const data = await res.json();
      if (data?.result?.list?.[0]?.lastPrice) {
        return parseFloat(data.result.list[0].lastPrice);
      }
    } catch (err: any) {
      console.warn(`[BYBIT ADAPTER] Market price lookup failed for ${symbol}:`, err.message);
    }
    return 0;
  }


  async placeOrder(orderRequest: OrderRequest): Promise<OrderResult> {
    const cleanSymbol = orderRequest.symbol.replace('/', '').toUpperCase();
    const clientOrderId = orderRequest.clientOrderId || `by_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    if (this.isDemoMode) {
      return {
        orderId: `demo_bybit_${Date.now()}`,
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
      category: 'spot',
      symbol: cleanSymbol,
      side: orderRequest.side === 'BUY' ? 'Buy' : 'Sell',
      orderType: orderRequest.type === 'MARKET' ? 'Market' : 'Limit',
      qty: String(orderRequest.quantity),
      orderLinkId: clientOrderId,
    };

    if (orderRequest.type === 'LIMIT' && orderRequest.price) {
      payload.price = String(orderRequest.price);
    }

    const result = await this.makeV5Request('/v5/order/create', payload, 'POST');

    return {
      orderId: result.orderId,
      clientOrderId: result.orderLinkId || clientOrderId,
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
      await this.makeV5Request('/v5/order/cancel', { category: 'spot', symbol: cleanSymbol, orderId }, 'POST');
      return true;
    } catch (err: any) {
      console.warn('[BYBIT ADAPTER] Cancel order failed:', err.message);
      return false;
    }
  }

  async getOrderStatus(orderId: string, symbol: string): Promise<OrderResult> {
    const cleanSymbol = symbol.replace('/', '');
    const result = await this.makeV5Request('/v5/order/realtime', { category: 'spot', symbol: cleanSymbol, orderId }, 'GET');
    const order = result?.list?.[0] || {};
    return {
      orderId: order.orderId || orderId,
      clientOrderId: order.orderLinkId,
      symbol: order.symbol || cleanSymbol,
      side: order.side === 'Buy' ? 'BUY' : 'SELL',
      status: order.orderStatus || 'NEW',
      executedQty: parseFloat(order.cumExecQty || '0'),
      cummulativeQuoteQty: parseFloat(order.cumExecValue || '0'),
      price: parseFloat(order.price || '0'),
      avgPrice: parseFloat(order.avgPrice || '0'),
      timestamp: parseInt(order.updatedTime || Date.now().toString(), 10),
      raw: order,
    };
  }
}
