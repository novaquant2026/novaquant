import { SupportedExchange } from '../../src/types';

export type ConnectionStatus = 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'UNAUTHORIZED' | 'CONNECTING';

export interface ExchangeAccountPermissions {
  read: boolean;
  trade: boolean;
  withdrawal: boolean;
}

export interface ExchangeAccount {
  id?: string;
  userId?: string;
  exchange: SupportedExchange;
  status: ConnectionStatus;
  permissions: ExchangeAccountPermissions;
  makerCommission?: number;
  takerCommission?: number;
  buyerCommission?: number;
  sellerCommission?: number;
  canTrade?: boolean;
  canWithdraw?: boolean;
  canDeposit?: boolean;
  accountType?: string;
  updateTime?: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

export interface AccountBalance {
  exchange: SupportedExchange;
  totalUSDT: number;
  availableUSDT: number;
  lockedUSDT: number;
  unrealizedPnL: number;
  spotAvailable: number;
  futuresAvailable: number;
  balances?: Balance[];
  timestamp: number;
  rawSummary?: string;
}

// Backward compatibility alias for capital manager and legacy consumers
export type AccountBalanceDetails = AccountBalance;

export interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  margin: number;
  liquidationPrice?: number;
  isolated?: boolean;
}

export interface Order {
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type?: 'MARKET'
    | 'LIMIT'
    | 'STOP_LOSS'
    | 'TAKE_PROFIT'
    | 'STOP_MARKET'
    | 'TAKE_PROFIT_MARKET';
  price: number;
  avgPrice?: number;
  origQty: number;
  executedQty: number;
  cummulativeQuoteQty?: number;
  reduceOnly?: boolean;
  closePosition?: boolean;
  positionSide?: 'BOTH' | 'LONG' | 'SHORT' | string;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'PENDING_CANCEL' | 'REJECTED' | 'EXPIRED' | string;
  time: number;
  updateTime?: number;
}

// Backward compatibility alias for legacy consumers
export type OpenOrder = Order;

export interface OrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  clientOrderId?: string;
  reduceOnly?: boolean;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';

  // Binance USDⓈ-M Futures execution controls
  leverage?: number;
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  stopPrice?: number;
  closePosition?: boolean;
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
}

// Backward compatibility alias
export type OrderParams = OrderRequest;

export interface OrderResult {
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type?: 'MARKET' | 'LIMIT';
  status: 'NEW' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELED' | 'REJECTED';
  executedQty: number;
  cummulativeQuoteQty: number;
  price: number;
  avgPrice?: number;
  timestamp: number;
  raw?: any;
}

export interface ConnectionTestResult {
  success: boolean;
  status: ConnectionStatus;
  exchange: SupportedExchange;
  latencyMs: number;
  permissions: ExchangeAccountPermissions;
  errorMessage?: string;
  account?: ExchangeAccount;
}

export interface ExchangeAdapter {
  readonly exchange: SupportedExchange;

  /**
   * Connects and verifies credentials format
   */
  connect(): Promise<ConnectionStatus>;

  /**
   * Tests API connection, latency, and ensures withdrawal permissions are disabled
   */
  testConnection(): Promise<ConnectionTestResult>;

  /**
   * Retrieves full account balances (spot & futures)
   */
  getAccountBalance(): Promise<AccountBalance>;

  /**
   * Retrieves available liquid USDT trading capital (source of truth)
   */
  getAvailableBalance(): Promise<number>;

  /**
   * Retrieves open positions
   */
  getPositions(symbol?: string): Promise<Position[]>;

  /**
   * Retrieves open active orders
   */
  getOpenOrders(symbol?: string): Promise<Order[]>;

  /**
   * Retrieves historical executed/cancelled orders
   */
  getOrderHistory(symbol?: string, limit?: number): Promise<Order[]>;

  /**
   * Retrieves real-time market price for a symbol
   */
  getMarketPrice(symbol: string): Promise<number>;

  /**
   * Submits an order to the exchange
   */
  placeOrder(orderRequest: OrderRequest): Promise<OrderResult>;

  /**
   * Cancels an open order by ID
   */
  cancelOrder(orderId: string, symbol: string): Promise<boolean>;

  /**
   * Retrieves current status and execution details for an order
   */
  getOrderStatus(orderId: string, symbol: string): Promise<OrderResult>;

  // Futures-specific capabilities (optional for non-Futures adapters)
  setFuturesLeverage?(symbol: string, leverage: number): Promise<number>;
  getFuturesLeverage?(symbol: string): Promise<number>;
  getFuturesPositionMode?(): Promise<'ONE_WAY' | 'HEDGE'>;
  placeFuturesProtectionOrders?(params: {
    symbol: string;
    positionSide?: 'BOTH' | 'LONG' | 'SHORT';
    side: 'BUY' | 'SELL';
    stopPrice?: number;
    takeProfitPrice?: number;
    quantity?: number;
  }): Promise<{ stopLossOrderId?: string; takeProfitOrderId?: string }>;
  closeFuturesPosition?(symbol: string, positionSide?: 'BOTH' | 'LONG' | 'SHORT'): Promise<OrderResult>;
  cancelAllFuturesOrders?(symbol: string): Promise<boolean>;

  // Backward compatibility method aliases
  getAvailableUSDT?(): Promise<number>;
  getOpenPositions?(): Promise<Position[]>;
}

// Backward compatibility alias for existing code
export type IExchangeAdapter = ExchangeAdapter;

