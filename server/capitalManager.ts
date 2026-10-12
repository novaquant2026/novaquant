import { SupportedExchange } from '../src/types';
import { IExchangeAdapter } from './adapters';

export type CapitalMode = 'AUTO_SYNC' | 'FIXED_ALLOCATION';
export type SyncStatus = 'SYNCED' | 'STALE' | 'ERROR' | 'PENDING';

export interface CapitalState {
  exchange: SupportedExchange;
  userId: string;
  exchangeBalance: number;       // Real total USDT on exchange
  availableBalance: number;      // Real liquid USDT on exchange
  allocatedCapital: number;      // Capital allocated to bot (in AUTO_SYNC = availableBalance, in FIXED = min(configured, available))
  usedCapital: number;           // Capital committed to open positions/margin
  availableTradingCapital: number;// Liquid capital available for new trades = max(0, allocatedCapital - usedCapital)
  unrealizedPnL: number;         // Current unrealized P&L from exchange
  realizedPnL: number;           // Realized P&L tracked
  lastSyncTime: number;          // Timestamp of last successful sync
  capitalMode: CapitalMode;
  configuredAllocation: number;  // User-configured allocation in FIXED_ALLOCATION mode
  syncStatus: SyncStatus;
  syncError: string | null;
  isLiveTradingEnabled: boolean; // Must be explicitly enabled by user after 5-step checklist
}

export interface LiveTradingReadinessCheck {
  isReady: boolean;
  checks: {
    exchangeConnected: boolean;
    balanceSuccessfullySynced: boolean;
    tradingPermissionEnabled: boolean;
    riskLimitsConfigured: boolean;
    userExplicitlyEnabledLiveTrading: boolean;
  };
  missingRequirements: string[];
}

export class CapitalManager {
  private states: Map<string, CapitalState> = new Map(); // key: `${userId}:${exchange}`
  private activeTradeAllocations: Map<string, { userId: string; exchange: SupportedExchange; amount: number }> = new Map();

  private getStateKey(userId: string, exchange: SupportedExchange): string {
    return `${userId}:${exchange}`;
  }

  getCapitalState(userId: string, exchange: SupportedExchange): CapitalState {
    const key = this.getStateKey(userId, exchange);
    let state = this.states.get(key);
    if (!state) {
      state = {
        exchange,
        userId,
        exchangeBalance: 0,
        availableBalance: 0,
        allocatedCapital: 0,
        usedCapital: 0,
        availableTradingCapital: 0,
        unrealizedPnL: 0,
        realizedPnL: 0,
        lastSyncTime: 0,
        capitalMode: 'AUTO_SYNC',
        configuredAllocation: 0,
        syncStatus: 'PENDING',
        syncError: null,
        isLiveTradingEnabled: false,
      };
      this.states.set(key, state);
    }
    return { ...state };
  }

  /**
   * Synchronizes capital directly from the exchange adapter.
   * AUTO_SYNC:
   *  - Fetches real available USDT balance.
   *  - Sets availableTradingCapital based on real available balance minus used capital.
   * FIXED_ALLOCATION:
   *  - Sets allocatedCapital to Math.min(configuredAllocation, availableBalance).
   *  - Trades strictly within the configured allocation.
   */
  async syncCapital(
    adapter: IExchangeAdapter,
    userId: string,
    modeOverride?: CapitalMode,
    configuredAllocationOverride?: number
  ): Promise<CapitalState> {
    const key = this.getStateKey(userId, adapter.exchange);
    let current = this.states.get(key) || this.getCapitalState(userId, adapter.exchange);

    if (modeOverride) current.capitalMode = modeOverride;
    if (configuredAllocationOverride !== undefined) current.configuredAllocation = configuredAllocationOverride;

    try {
      // 1. Query live balance from exchange
      const balanceDetails = await adapter.getAccountBalance();

      // 2. Query open positions to get live margin used and unrealized PnL
      let positionMargin = 0;
      let unrealized = balanceDetails.unrealizedPnL;
      try {
        const positions = await adapter.getOpenPositions();
        positionMargin = positions.reduce((acc, p) => acc + (p.margin || (p.size * p.entryPrice) / (p.leverage || 1)), 0);
        if (positions.length > 0) {
          unrealized = positions.reduce((acc, p) => acc + (p.unrealizedPnl || 0), 0);
        }
      } catch (posErr: any) {
        console.warn(`[CAPITAL MANAGER] Could not load positions for ${adapter.exchange}:`, posErr?.message);
      }

      const totalUSDT = Number(balanceDetails.totalUSDT.toFixed(2));
      const availableUSDT = Number(balanceDetails.availableUSDT.toFixed(2));

      // Calculate committed trade allocations tracked locally
      let trackedOrderCapital = 0;
      for (const alloc of this.activeTradeAllocations.values()) {
        if (alloc.userId === userId && alloc.exchange === adapter.exchange) {
          trackedOrderCapital += alloc.amount;
        }
      }

      const effectiveUsedCapital = Number(Math.max(positionMargin, trackedOrderCapital).toFixed(2));

      // 3. Compute allocated capital based on Capital Mode
      let allocated = 0;
      if (current.capitalMode === 'AUTO_SYNC') {
        allocated = availableUSDT;
      } else {
        // FIXED_ALLOCATION: NovaQuant may trade only with the configured allocation, clamped to what is actually available
        allocated = Math.min(current.configuredAllocation > 0 ? current.configuredAllocation : availableUSDT, availableUSDT);
      }

      // 4. Calculate availableTradingCapital
      const availableTrading = Number(Math.max(0, allocated - effectiveUsedCapital).toFixed(2));

      current = {
        ...current,
        exchangeBalance: totalUSDT,
        availableBalance: availableUSDT,
        allocatedCapital: Number(allocated.toFixed(2)),
        usedCapital: effectiveUsedCapital,
        availableTradingCapital: availableTrading,
        unrealizedPnL: Number(unrealized.toFixed(2)),
        lastSyncTime: Date.now(),
        syncStatus: 'SYNCED',
        syncError: null,
      };

      this.states.set(key, current);
      return { ...current };
    } catch (err: any) {
      console.error(`[CAPITAL MANAGER ERROR] Balance sync failed for ${adapter.exchange}:`, err?.message || err);
      current = {
        ...current,
        syncStatus: 'STALE',
        syncError: err?.message || 'Failed to communicate with exchange API',
      };
      this.states.set(key, current);
      throw err;
    }
  }

  /**
   * Sets the Capital Mode (AUTO_SYNC or FIXED_ALLOCATION).
   */
  setCapitalMode(
    userId: string,
    exchange: SupportedExchange,
    mode: CapitalMode,
    configuredAllocation?: number
  ): CapitalState {
    const key = this.getStateKey(userId, exchange);
    const state = this.getCapitalState(userId, exchange);
    state.capitalMode = mode;
    if (configuredAllocation !== undefined) {
      state.configuredAllocation = Math.max(0, Number(configuredAllocation));
    }

    // Recompute allocation
    if (mode === 'AUTO_SYNC') {
      state.allocatedCapital = state.availableBalance;
    } else {
      state.allocatedCapital = Math.min(state.configuredAllocation, state.availableBalance);
    }
    state.availableTradingCapital = Math.max(0, state.allocatedCapital - state.usedCapital);

    this.states.set(key, state);
    return { ...state };
  }

  /**
   * Sets Live Trading enabled flag.
   */
  setLiveTrading(userId: string, exchange: SupportedExchange, enabled: boolean): CapitalState {
    const key = this.getStateKey(userId, exchange);
    const state = this.getCapitalState(userId, exchange);
    state.isLiveTradingEnabled = Boolean(enabled);
    this.states.set(key, state);
    return { ...state };
  }

  /**
   * Validates available capital before placing an order.
   * Enforces:
   * 1. Balance must not be STALE (must be synced within the last 60 seconds).
   * 2. Sufficient available trading capital.
   */
  validateCapitalForOrder(
    userId: string,
    exchange: SupportedExchange,
    requiredCapital: number
  ): { valid: boolean; reason?: string; availableTradingCapital: number } {
    const state = this.getCapitalState(userId, exchange);

    // Stale check (Never use stale balance data for order sizing!)
    const STALE_THRESHOLD_MS = 60000; // 60 seconds
    const isStale = Date.now() - state.lastSyncTime > STALE_THRESHOLD_MS || state.syncStatus !== 'SYNCED';

    if (isStale) {
      return {
        valid: false,
        reason: `Balance data for ${exchange} is stale or unverified (Last sync: ${
          state.lastSyncTime > 0 ? Math.round((Date.now() - state.lastSyncTime) / 1000) + 's ago' : 'Never'
        }). Immediate re-synchronization required before order execution.`,
        availableTradingCapital: state.availableTradingCapital,
      };
    }

    if (state.availableTradingCapital <= 0) {
      return {
        valid: false,
        reason: `Insufficient trading balance on ${exchange}: Available Trading Capital is $0.00 USDT. Please fund your exchange account or adjust allocated capital.`,
        availableTradingCapital: 0,
      };
    }

    if (requiredCapital > state.availableTradingCapital) {
      return {
        valid: false,
        reason: `Order capital ($${requiredCapital.toFixed(2)} USDT) exceeds Available Trading Capital ($${state.availableTradingCapital.toFixed(2)} USDT) on ${exchange}.`,
        availableTradingCapital: state.availableTradingCapital,
      };
    }

    return {
      valid: true,
      availableTradingCapital: state.availableTradingCapital,
    };
  }

  /**
   * Tracks capital allocation when an order is submitted.
   */
  allocateCapitalForTrade(userId: string, exchange: SupportedExchange, tradeId: string, amount: number): void {
    const key = this.getStateKey(userId, exchange);
    this.activeTradeAllocations.set(tradeId, { userId, exchange, amount });
    const state = this.getCapitalState(userId, exchange);
    state.usedCapital = Number((state.usedCapital + amount).toFixed(2));
    state.availableTradingCapital = Number(Math.max(0, state.allocatedCapital - state.usedCapital).toFixed(2));
    this.states.set(key, state);
  }

  /**
   * Releases capital when a trade is closed.
   */
  releaseCapitalFromTrade(tradeId: string, pnl: number = 0): void {
    const alloc = this.activeTradeAllocations.get(tradeId);
    if (!alloc) return;

    this.activeTradeAllocations.delete(tradeId);
    const key = this.getStateKey(alloc.userId, alloc.exchange);
    const state = this.getCapitalState(alloc.userId, alloc.exchange);

    state.usedCapital = Number(Math.max(0, state.usedCapital - alloc.amount).toFixed(2));
    state.realizedPnL = Number((state.realizedPnL + pnl).toFixed(2));
    state.availableTradingCapital = Number(Math.max(0, state.allocatedCapital - state.usedCapital).toFixed(2));
    this.states.set(key, state);
  }

  /**
   * Verifies production 5-step checklist before allowing LIVE trading:
   * 1. Exchange Connected
   * 2. Balance Successfully Synced
   * 3. Trading Permission Enabled
   * 4. Risk Limits Configured
   * 5. User explicitly enables Live Trading
   */
  verifyLiveTradingReadiness(
    userId: string,
    exchange: SupportedExchange,
    isConnected: boolean,
    hasTradingPermission: boolean,
    hasRiskConfigured: boolean
  ): LiveTradingReadinessCheck {
    const state = this.getCapitalState(userId, exchange);
    const isSynced = state.syncStatus === 'SYNCED' && state.lastSyncTime > 0 && Date.now() - state.lastSyncTime < 120000;
    const isLiveEnabled = Boolean(state.isLiveTradingEnabled);

    const checks = {
      exchangeConnected: isConnected,
      balanceSuccessfullySynced: isSynced,
      tradingPermissionEnabled: hasTradingPermission,
      riskLimitsConfigured: hasRiskConfigured,
      userExplicitlyEnabledLiveTrading: isLiveEnabled,
    };

    const missingRequirements: string[] = [];
    if (!checks.exchangeConnected) missingRequirements.push('Exchange must be securely connected with valid API credentials.');
    if (!checks.balanceSuccessfullySynced) missingRequirements.push('Exchange USDT balance must be successfully synced (fresh within 120s).');
    if (!checks.tradingPermissionEnabled) missingRequirements.push('API key must have Spot/Futures trading permissions enabled (Withdrawal disabled).');
    if (!checks.riskLimitsConfigured) missingRequirements.push('Mandatory risk management limits (Max trade %, SL/TP, Daily loss) must be active.');
    if (!checks.userExplicitlyEnabledLiveTrading) missingRequirements.push('User must explicitly switch on and confirm Live Trading mode.');

    return {
      isReady: missingRequirements.length === 0,
      checks,
      missingRequirements,
    };
  }
}

// Global Singleton Instance
export const capitalManager = new CapitalManager();
