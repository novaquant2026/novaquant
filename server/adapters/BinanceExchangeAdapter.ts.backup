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
  ExchangeAccount,
} from './types';
import { fetchBinanceRealBalances } from '../exchangeBalanceService';

export class BinanceExchangeAdapter implements ExchangeAdapter {
  readonly exchange: SupportedExchange = 'Binance';
  private apiKey: string;
  private secretKey: string;
  private isDemoMode: boolean;

  constructor(apiKey: string, secretKey: string, isDemoMode: boolean = false) {
    this.apiKey = apiKey?.trim() || '';
    this.secretKey = secretKey?.trim() || '';
    this.isDemoMode = isDemoMode;
  }

  private signQuery(queryString: string): string {
    return crypto
      .createHmac('sha256', this.secretKey)
      .update(queryString)
      .digest('hex');
  }

  private async makeSignedRequest(
    endpoint: string,
    params: Record<string, string | number> = {},
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    isFutures: boolean = false
  ): Promise<any> {
    const timestamp = Date.now();
    const queryParts = Object.entries({
      ...params,
      timestamp,
      recvWindow: 10000,
    }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);

    const queryString = queryParts.join('&');
    const signature = this.signQuery(queryString);
    const fullQuery = `${queryString}&signature=${signature}`;

    const baseUrl = isFutures ? 'https://fapi.binance.com' : 'https://api.binance.com';
    const url = method === 'GET' || method === 'DELETE' 
      ? `${baseUrl}${endpoint}?${fullQuery}`
      : `${baseUrl}${endpoint}`;

    const fetchOptions: RequestInit = {
      method,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };

    if (method === 'POST') {
      fetchOptions.body = fullQuery;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
      const data = await res.json();
      if (!res.ok || (data && data.code && data.code !== 200)) {
        throw new Error(data.msg || `Binance API request failed (${res.status})`);
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async makePublicRequest(endpoint: string, params: Record<string, string | number> = {}): Promise<any> {
    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `https://api.binance.com${endpoint}${queryString ? `?${queryString}` : ''}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.msg || `Binance public request failed (${res.status})`);
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async connect(): Promise<ConnectionStatus> {
    if (!this.apiKey || !this.secretKey) {
      return 'DISCONNECTED';
    }
    if (this.apiKey.length < 16 || this.secretKey.length < 16) {
      return 'ERROR';
    }
    return 'CONNECTED';
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    try {
      if (this.isDemoMode) {
        return {
          success: true,
          status: 'CONNECTED',
          exchange: 'Binance',
          latencyMs: 42,
          permissions: {
            read: true,
            trade: true,
            withdrawal: false,
          },
        };
      }

      // Query account information to verify credentials and check permissions
      const accountData = await this.makeSignedRequest('/api/v3/account', {}, 'GET', false);
      const latencyMs = Date.now() - startTime;

      const permissions = {
        read: true,
        trade: Boolean(accountData.canTrade),
        withdrawal: Boolean(accountData.canWithdraw),
      };

      // Security requirement: Trading bot MUST NEVER have withdrawal permissions
      if (permissions.withdrawal) {
        return {
          success: false,
          status: 'ERROR',
          exchange: 'Binance',
          latencyMs,
          permissions,
          errorMessage: 'SECURITY REJECTION: API key has withdrawal permissions enabled. For safety, disable withdrawals on Binance before connecting.',
        };
      }

      const account: ExchangeAccount = {
        exchange: 'Binance',
        status: 'CONNECTED',
        permissions,
        makerCommission: accountData.makerCommission,
        takerCommission: accountData.takerCommission,
        canTrade: accountData.canTrade,
        canWithdraw: accountData.canWithdraw,
        canDeposit: accountData.canDeposit,
        accountType: accountData.accountType,
        updateTime: accountData.updateTime,
      };

      return {
        success: true,
        status: 'CONNECTED',
        exchange: 'Binance',
        latencyMs,
        permissions,
        account,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const isAuth = err.message?.toLowerCase().includes('api-key') || err.message?.toLowerCase().includes('signature');
      return {
        success: false,
        status: isAuth ? 'UNAUTHORIZED' : 'ERROR',
        exchange: 'Binance',
        latencyMs,
        permissions: { read: false, trade: false, withdrawal: false },
        errorMessage: err.message || 'Connection test failed',
      };
    }
  }

  async getAccountBalance(): Promise<AccountBalance> {
    const balances = await fetchBinanceRealBalances(this.apiKey, this.secretKey);
    const spotAvailable = balances.spot.available;
    const futuresAvailable = balances.futures.available;
    const totalUSDT = Number((balances.spot.capital + balances.futures.capital).toFixed(4));
    // Available USDT is the liquid available trading capital across the active account
    const availableUSDT = Number((spotAvailable + futuresAvailable).toFixed(4));
    const lockedUSDT = Number((balances.spot.lockedInOrders + balances.futures.lockedInOrders).toFixed(4));
    const unrealizedPnL = balances.futures.unrealizedPnl || 0;

    return {
      exchange: 'Binance',
      totalUSDT,
      availableUSDT,
      lockedUSDT,
      unrealizedPnL,
      spotAvailable,
      futuresAvailable,
      balances: [
        { asset: 'USDT (Spot)', free: spotAvailable, locked: balances.spot.lockedInOrders, total: balances.spot.capital },
        { asset: 'USDT (Futures)', free: futuresAvailable, locked: balances.futures.lockedInOrders, total: balances.futures.capital },
      ],
      timestamp: Date.now(),
      rawSummary: balances.rawSummary,
    };
  }

  async getAvailableBalance(): Promise<number> {
    const details = await this.getAccountBalance();
    return details.availableUSDT;
  }

  // Alias for backward compatibility
  async getAvailableUSDT(): Promise<number> {
    return this.getAvailableBalance();
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    try {
      const data = await this.makeSignedRequest('/fapi/v2/positionRisk', {}, 'GET', true);
      if (Array.isArray(data)) {
        const cleanSymbol = symbol ? symbol.replace('/', '').toUpperCase() : null;
        return data
          .filter((p: any) => {
            const amt = parseFloat(p.positionAmt);
            if (amt === 0) return false;
            if (cleanSymbol && p.symbol !== cleanSymbol) return false;
            return true;
          })
          .map((p: any) => {
            const amt = parseFloat(p.positionAmt);
            return {
              symbol: p.symbol,
              side: amt > 0 ? 'LONG' : 'SHORT',
              size: Math.abs(amt),
              entryPrice: parseFloat(p.entryPrice),
              markPrice: parseFloat(p.markPrice),
              unrealizedPnl: parseFloat(p.unRealizedProfit),
              leverage: parseFloat(p.leverage),
              margin: parseFloat(p.isolatedMargin || p.positionInitialMargin || '0'),
              liquidationPrice: parseFloat(p.liquidationPrice || '0'),
              isolated: Boolean(p.isAutoAddMargin === 'true'),
            };
          });
      }
    } catch (err: any) {
      console.warn('[BINANCE ADAPTER] Failed fetching positions:', err.message);
    }
    return [];
  }

  // Alias for backward compatibility
  async getOpenPositions(): Promise<Position[]> {
    return this.getPositions();
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    try {
      const params: Record<string, string> = {};
      if (symbol) {
        params.symbol = symbol.replace('/', '').toUpperCase();
      }
      const data = await this.makeSignedRequest('/api/v3/openOrders', params, 'GET', false);
      if (Array.isArray(data)) {
        return data.map((o: any) => ({
          orderId: String(o.orderId),
          clientOrderId: o.clientOrderId,
          symbol: o.symbol,
          side: o.side as 'BUY' | 'SELL',
          type: o.type,
          price: parseFloat(o.price),
          origQty: parseFloat(o.origQty),
          executedQty: parseFloat(o.executedQty),
          cummulativeQuoteQty: parseFloat(o.cummulativeQuoteQty || '0'),
          status: o.status,
          time: o.time,
          updateTime: o.updateTime,
        }));
      }
    } catch (err: any) {
      console.warn('[BINANCE ADAPTER] Failed fetching open orders:', err.message);
    }
    return [];
  }

  async getOrderHistory(symbol?: string, limit: number = 50): Promise<Order[]> {
    try {
      const params: Record<string, string | number> = { limit };
      if (symbol) {
        params.symbol = symbol.replace('/', '').toUpperCase();
        const data = await this.makeSignedRequest('/api/v3/allOrders', params, 'GET', false);
        if (Array.isArray(data)) {
          return data.map((o: any) => ({
            orderId: String(o.orderId),
            clientOrderId: o.clientOrderId,
            symbol: o.symbol,
            side: o.side as 'BUY' | 'SELL',
            type: o.type,
            price: parseFloat(o.price),
            origQty: parseFloat(o.origQty),
            executedQty: parseFloat(o.executedQty),
            cummulativeQuoteQty: parseFloat(o.cummulativeQuoteQty || '0'),
            status: o.status,
            time: o.time,
            updateTime: o.updateTime,
          }));
        }
      }
    } catch (err: any) {
      console.warn('[BINANCE ADAPTER] Failed fetching order history:', err.message);
    }
    return [];
  }

  async getMarketPrice(symbol: string): Promise<number> {
    const cleanSymbol = symbol.replace('/', '').toUpperCase();
    try {
      const data = await this.makePublicRequest('/api/v3/ticker/price', { symbol: cleanSymbol });
      if (data && data.price) {
        return parseFloat(data.price);
      }
    } catch (err: any) {
      console.warn(`[BINANCE ADAPTER] Failed fetching market price for ${symbol}:`, err.message);
    }
    return 0;
  }

  async placeOrder(orderRequest: OrderRequest): Promise<OrderResult> {
    const cleanSymbol = orderRequest.symbol.replace('/', '').toUpperCase();
    const clientOrderId = orderRequest.clientOrderId || `nq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    if (this.isDemoMode) {
      return {
        orderId: `demo_binance_${Date.now()}`,
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
      side: orderRequest.side,
      type: orderRequest.type,
      quantity: orderRequest.quantity,
      newClientOrderId: clientOrderId,
    };

    if (orderRequest.type === 'LIMIT' && orderRequest.price) {
      payload.price = orderRequest.price;
      payload.timeInForce = orderRequest.timeInForce || 'GTC';
    }

    const data = await this.makeSignedRequest('/api/v3/order', payload, 'POST', false);

    return {
      orderId: String(data.orderId),
      clientOrderId: data.clientOrderId,
      symbol: data.symbol,
      side: data.side,
      type: data.type,
      status: data.status,
      executedQty: parseFloat(data.executedQty || '0'),
      cummulativeQuoteQty: parseFloat(data.cummulativeQuoteQty || '0'),
      price: parseFloat(data.price || '0'),
      avgPrice: parseFloat(data.avgPrice || data.price || '0'),
      timestamp: data.transactTime || Date.now(),
      raw: data,
    };
  }

  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    try {
      const cleanSymbol = symbol.replace('/', '').toUpperCase();
      await this.makeSignedRequest('/api/v3/order', { symbol: cleanSymbol, orderId }, 'DELETE', false);
      return true;
    } catch (err: any) {
      console.warn('[BINANCE ADAPTER] Cancel order failed:', err.message);
      return false;
    }
  }

  async getOrderStatus(orderId: string, symbol: string): Promise<OrderResult> {
    const cleanSymbol = symbol.replace('/', '').toUpperCase();
    const data = await this.makeSignedRequest('/api/v3/order', { symbol: cleanSymbol, orderId }, 'GET', false);
    return {
      orderId: String(data.orderId),
      clientOrderId: data.clientOrderId,
      symbol: data.symbol,
      side: data.side,
      type: data.type,
      status: data.status,
      executedQty: parseFloat(data.executedQty || '0'),
      cummulativeQuoteQty: parseFloat(data.cummulativeQuoteQty || '0'),
      price: parseFloat(data.price || '0'),
      avgPrice: parseFloat(data.avgPrice || data.price || '0'),
      timestamp: data.time || Date.now(),
      raw: data,
    };
  }
}

