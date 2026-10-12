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
      const futuresAccountData = await this.makeSignedRequest('/fapi/v2/account', {}, 'GET', true);
      const apiRestrictions = await this.makeSignedRequest(
        '/sapi/v1/account/apiRestrictions',
        {},
        'GET',
        false
      );

      console.log('[BINANCE DEBUG] API restrictions:', JSON.stringify(apiRestrictions));
      console.log('[BINANCE DEBUG] Spot account permissions:', JSON.stringify({
        canTrade: accountData.canTrade,
        canWithdraw: accountData.canWithdraw,
        canDeposit: accountData.canDeposit,
      }));
      console.log('[BINANCE DEBUG] Futures account permissions:', JSON.stringify({
        canTrade: futuresAccountData.canTrade,
        canWithdraw: futuresAccountData.canWithdraw,
        canDeposit: futuresAccountData.canDeposit,
      }));

      const latencyMs = Date.now() - startTime;
      const futuresEnabled = Boolean(apiRestrictions.enableFutures);
      const futuresTradeEnabled = Boolean(futuresAccountData.canTrade);

      const permissions = {
        read: Boolean(apiRestrictions.enableReading),
        trade: futuresTradeEnabled,
        withdrawal: Boolean(apiRestrictions.enableWithdrawals),
        futuresTrading: futuresEnabled && futuresTradeEnabled,
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

      // Autonomous bot requires explicit USDⓈ-M Futures permission.
      if (!futuresEnabled) {
        return {
          success: false,
          status: 'ERROR',
          exchange: 'Binance',
          latencyMs,
          permissions,
          errorMessage: 'FUTURES PERMISSION REJECTION: Binance API key does not have USDⓈ-M Futures trading enabled. Enable Futures trading permission before connecting.',
        };
      }

      if (!futuresTradeEnabled) {
        return {
          success: false,
          status: 'ERROR',
          exchange: 'Binance',
          latencyMs,
          permissions,
          errorMessage: 'FUTURES TRADING REJECTION: Binance Futures account does not allow trading with this API key.',
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
    return details.futuresAvailable;
  }

  async setFuturesLeverage(symbol: string, leverage: number): Promise<number> {
    if (this.isDemoMode) {
      return leverage;
    }

    const cleanSymbol = symbol.replace('/', '').toUpperCase();
    const requested = Math.max(1, Math.floor(Number(leverage)));

    const data = await this.makeSignedRequest(
      '/fapi/v1/leverage',
      {
        symbol: cleanSymbol,
        leverage: requested,
      },
      'POST',
      true
    );

    const actual = Number(data.leverage);
    if (!Number.isFinite(actual) || actual < 1) {
      throw new Error(`Binance returned invalid Futures leverage for ${cleanSymbol}.`);
    }

    return actual;
  }

  async getFuturesLeverage(symbol: string): Promise<number> {
    const positions = await this.getPositions(symbol);
    const position = positions.find(
      (p) => p.symbol === symbol.replace('/', '').toUpperCase()
    );

    return position?.leverage || 1;
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
      const data = await this.makeSignedRequest('/fapi/v1/openOrders', params, 'GET', true);
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
        const data = await this.makeSignedRequest('/fapi/v1/allOrders', params, 'GET', true);
        if (Array.isArray(data)) {
          return data.map((o: any) => ({
            orderId: String(o.orderId),
            clientOrderId: o.clientOrderId,
            symbol: o.symbol,
            side: o.side as 'BUY' | 'SELL',
            type: o.type,
            price: parseFloat(o.price || '0'),
            avgPrice: parseFloat(o.avgPrice || '0'),
            origQty: parseFloat(o.origQty || '0'),
            executedQty: parseFloat(o.executedQty || '0'),
            cummulativeQuoteQty: parseFloat(o.cummulativeQuoteQty || '0'),
            reduceOnly: Boolean(o.reduceOnly),
            closePosition: Boolean(o.closePosition),
            positionSide: o.positionSide,
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

  private async makeFuturesPublicRequest(
    endpoint: string,
    params: Record<string, string | number> = {}
  ): Promise<any> {
    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    const url = `https://fapi.binance.com${endpoint}${queryString ? `?${queryString}` : ''}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      const data = await res.json();

      if (!res.ok || (data && data.code && data.code !== 200)) {
        throw new Error(data.msg || `Binance Futures public request failed (${res.status})`);
      }

      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getMarketPrice(symbol: string): Promise<number> {
    const cleanSymbol = symbol.replace('/', '').toUpperCase();
    try {
      const data = await this.makeFuturesPublicRequest('/fapi/v1/ticker/price', { symbol: cleanSymbol });
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
      positionSide: orderRequest.positionSide || 'BOTH',
    };

    if (orderRequest.reduceOnly !== undefined) {
      payload.reduceOnly = orderRequest.reduceOnly;
    }

    if (orderRequest.type === 'LIMIT' && orderRequest.price) {
      payload.price = orderRequest.price;
      payload.timeInForce = orderRequest.timeInForce || 'GTC';
    }

    const data = await this.makeSignedRequest('/fapi/v1/order', payload, 'POST', true);

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

  async getFuturesPositionMode(): Promise<'ONE_WAY' | 'HEDGE'> {
    if (this.isDemoMode) {
      return 'ONE_WAY';
    }

    const data = await this.makeSignedRequest(
      '/fapi/v1/positionSide/dual',
      {},
      'GET',
      true
    );

    return data.dualSidePosition ? 'HEDGE' : 'ONE_WAY';
  }

  async placeFuturesProtectionOrders(params: {
    symbol: string;
    positionSide?: 'BOTH' | 'LONG' | 'SHORT';
    side: 'BUY' | 'SELL';
    stopPrice?: number;
    takeProfitPrice?: number;
    quantity?: number;
  }): Promise<{ stopLossOrderId?: string; takeProfitOrderId?: string }> {
    const cleanSymbol = params.symbol.replace('/', '').toUpperCase();

    if (this.isDemoMode) {
      return {
        stopLossOrderId: params.stopPrice ? `demo-sl-${Date.now()}` : undefined,
        takeProfitOrderId: params.takeProfitPrice ? `demo-tp-${Date.now()}` : undefined,
      };
    }

    const positionMode = await this.getFuturesPositionMode();

    if (positionMode !== 'ONE_WAY') {
      throw new Error(
        `Futures protection rejected for ${cleanSymbol}: Hedge Mode is not supported by the autonomous engine yet.`
      );
    }

    const closeSide = params.side === 'BUY' ? 'SELL' : 'BUY';
    const result: {
      stopLossOrderId?: string;
      takeProfitOrderId?: string;
    } = {};

    try {
      if (params.stopPrice && Number.isFinite(Number(params.stopPrice))) {
        const sl = await this.makeSignedRequest(
          '/fapi/v1/order',
          {
            symbol: cleanSymbol,
            side: closeSide,
            type: 'STOP_MARKET',
            stopPrice: Number(params.stopPrice),
            closePosition: true,
            workingType: 'MARK_PRICE',
            positionSide: 'BOTH',
            newClientOrderId: `nq-sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          },
          'POST',
          true
        );

        result.stopLossOrderId = String(sl.orderId);
      }

      if (params.takeProfitPrice && Number.isFinite(Number(params.takeProfitPrice))) {
        const tp = await this.makeSignedRequest(
          '/fapi/v1/order',
          {
            symbol: cleanSymbol,
            side: closeSide,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: Number(params.takeProfitPrice),
            closePosition: true,
            workingType: 'MARK_PRICE',
            positionSide: 'BOTH',
            newClientOrderId: `nq-tp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          },
          'POST',
          true
        );

        result.takeProfitOrderId = String(tp.orderId);
      }

      return result;
    } catch (err) {
      // Fail closed: remove any protection order already created.
      try {
        await this.cancelAllFuturesOrders(cleanSymbol);
      } catch (cancelErr) {
        console.error(
          `[BINANCE FUTURES] Failed cancelling protection orders after error for ${cleanSymbol}:`,
          cancelErr
        );
      }

      throw err;
    }
  }

  async closeFuturesPosition(
    symbol: string,
    positionSide: 'BOTH' | 'LONG' | 'SHORT' = 'BOTH'
  ): Promise<OrderResult> {
    const cleanSymbol = symbol.replace('/', '').toUpperCase();

    if (this.isDemoMode) {
      return {
        orderId: `demo-close-${Date.now()}`,
        symbol: cleanSymbol,
        side: 'SELL',
        type: 'MARKET',
        status: 'FILLED',
        executedQty: 0,
        cummulativeQuoteQty: 0,
        price: 0,
        timestamp: Date.now(),
      };
    }

    const positionMode = await this.getFuturesPositionMode();

    if (positionMode !== 'ONE_WAY') {
      throw new Error(
        `Futures close rejected for ${cleanSymbol}: Hedge Mode is not supported by the autonomous engine yet.`
      );
    }

    const positions = await this.getPositions(cleanSymbol);
    const position = positions.find(
      (p) => Math.abs(Number(p.size)) > 0
    );

    if (!position) {
      throw new Error(`No open Futures position found for ${cleanSymbol}.`);
    }

    const quantity = Math.abs(Number(position.size));

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Invalid Futures position quantity for ${cleanSymbol}.`);
    }

    const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';

    const data = await this.makeSignedRequest(
      '/fapi/v1/order',
      {
        symbol: cleanSymbol,
        side: closeSide,
        type: 'MARKET',
        quantity,
        reduceOnly: true,
        positionSide: 'BOTH',
        newClientOrderId: `nq-close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
      'POST',
      true
    );

    const orderResult: OrderResult = {
      orderId: String(data.orderId),
      clientOrderId: data.clientOrderId,
      symbol: cleanSymbol,
      side: data.side === 'BUY' ? 'BUY' : 'SELL',
      type: 'MARKET',
      status: data.status || 'NEW',
      executedQty: Number(data.executedQty || 0),
      cummulativeQuoteQty: Number(
        data.cumQuote || data.cummulativeQuoteQty || 0
      ),
      price: Number(data.avgPrice || data.price || 0),
      avgPrice: Number(data.avgPrice || data.price || 0),
      timestamp: Number(
        data.updateTime || data.transactTime || Date.now()
      ),
      raw: data,
    };

    // IMPORTANT:
    // A returned orderId does NOT prove that the Futures position
    // has actually been closed. Verify the position itself.
    let finalPositionSize = quantity;

    for (let attempt = 1; attempt <= 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 300));

      try {
        const remainingPositions = await this.getPositions(cleanSymbol);

        finalPositionSize = Math.abs(
          Number(
            remainingPositions.find(
              (p) => Math.abs(Number(p.size)) > 0
            )?.size || 0
          )
        );

        console.log(
          `[BINANCE FUTURES CLOSE VERIFY] ${cleanSymbol} attempt=${attempt}/10 remainingPositionSize=${finalPositionSize}`
        );

        if (finalPositionSize <= 0) {
          orderResult.status = 'FILLED';
          return orderResult;
        }
      } catch (verifyErr: any) {
        console.warn(
          `[BINANCE FUTURES CLOSE VERIFY] ${cleanSymbol} attempt=${attempt}/10 failed:`,
          verifyErr?.message || verifyErr
        );
      }
    }

    throw new Error(
      `Emergency Futures close order ${orderResult.orderId} was submitted but position remains open for ${cleanSymbol}. Remaining position size=${finalPositionSize}.`
    );
  }

  async cancelAllFuturesOrders(symbol: string): Promise<boolean> {
    const cleanSymbol = symbol.replace('/', '').toUpperCase();

    if (this.isDemoMode) {
      return true;
    }

    await this.makeSignedRequest(
      '/fapi/v1/allOpenOrders',
      { symbol: cleanSymbol },
      'DELETE',
      true
    );

    return true;
  }

  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    try {
      const cleanSymbol = symbol.replace('/', '').toUpperCase();
      await this.makeSignedRequest('/fapi/v1/order', { symbol: cleanSymbol, orderId }, 'DELETE', true);
      return true;
    } catch (err: any) {
      console.warn('[BINANCE ADAPTER] Cancel order failed:', err.message);
      return false;
    }
  }

  async getOrderStatus(orderId: string, symbol: string): Promise<OrderResult> {
    const cleanSymbol = symbol.replace('/', '').toUpperCase();
    const data = await this.makeSignedRequest('/fapi/v1/order', { symbol: cleanSymbol, orderId }, 'GET', true);
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

