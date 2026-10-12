import { RiskSettings, TradeDirection, SupportedExchange } from '../src/types';
import { CapitalState } from './capitalManager';

export interface OrderIntent {
  symbol: string;
  direction: TradeDirection;
  aiSuggestedSize?: number;
  aiSuggestedCapital?: number;
  currentPrice: number;
  atr?: number;
  customStopLoss?: number;
  customTakeProfit?: number;
  clientOrderId?: string;
}

export interface RiskValidationResult {
  approved: boolean;
  rejectedReason?: string;
  clampedPositionSize: number;
  allocatedCapital: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  riskAmount: number;
  potentialProfit: number;
  warnings: string[];
}

export class RiskManager {
  private recentOrders: Array<{ symbol: string; direction: string; timestamp: number; clientOrderId?: string }> = [];
  private isEmergencyStopActive: boolean = false;

  triggerEmergencyStop(reason: string = 'User or circuit breaker emergency stop triggered'): void {
    this.isEmergencyStopActive = true;
    console.warn(`[EMERGENCY STOP TRIGGERED] Trading halted: ${reason}`);
  }

  resetEmergencyStop(): void {
    this.isEmergencyStopActive = false;
    console.log('[EMERGENCY STOP RESET] Trading operations resumed.');
  }

  isEmergencyStopped(): boolean {
    return this.isEmergencyStopActive;
  }

  /**
   * Enforces all risk rules before any order reaches the Capital Manager or Exchange Adapter:
   * 1. Emergency Stop Check
   * 2. Duplicate Order Protection
   * 3. Max Open Positions Check
   * 4. Daily Loss Limit Check
   * 5. Stop Loss & Take Profit Mandatory Enforcement (R:R Ratio >= minRiskRewardRatio)
   * 6. Capital Allocation Cap & AI Override Protection
   * 7. Insufficient Balance Protection
   */
  evaluateOrderRisk(
    intent: OrderIntent,
    capitalState: CapitalState,
    riskSettings: RiskSettings,
    activeTradeCount: number,
    dailyPnL: number,
    dailyStartingCapital: number
  ): RiskValidationResult {
    const warnings: string[] = [];

    // 1. Emergency Stop Check
    if (this.isEmergencyStopActive) {
      return {
        approved: false,
        rejectedReason: 'Emergency Stop is currently active. All new order submissions are strictly halted.',
        clampedPositionSize: 0,
        allocatedCapital: 0,
        stopLoss: 0,
        takeProfit: 0,
        riskRewardRatio: 0,
        riskAmount: 0,
        potentialProfit: 0,
        warnings: ['Emergency Stop Triggered'],
      };
    }

    // 2. Duplicate Order Protection (Within 15 seconds for same symbol + direction or identical clientOrderId)
    const now = Date.now();
    const DUPLICATE_WINDOW_MS = 15000;
    // Clean old history
    this.recentOrders = this.recentOrders.filter((o) => now - o.timestamp < DUPLICATE_WINDOW_MS);

    const isDuplicate = this.recentOrders.some(
      (o) =>
        (intent.clientOrderId && o.clientOrderId === intent.clientOrderId) ||
        (o.symbol === intent.symbol && o.direction === intent.direction && now - o.timestamp < DUPLICATE_WINDOW_MS)
    );

    if (isDuplicate) {
      return {
        approved: false,
        rejectedReason: `Duplicate Order Protection: A recent order for ${intent.symbol} (${intent.direction}) was placed within the last 15s. Request rejected to prevent double-execution.`,
        clampedPositionSize: 0,
        allocatedCapital: 0,
        stopLoss: 0,
        takeProfit: 0,
        riskRewardRatio: 0,
        riskAmount: 0,
        potentialProfit: 0,
        warnings: ['Duplicate order prevented'],
      };
    }

    // 3. Maximum Number of Open Positions (Strictly 1 trade at a time)
    const maxTradesAllowed = Math.max(1, riskSettings.maxOpenTrades || 1);
    if (activeTradeCount >= maxTradesAllowed) {
      return {
        approved: false,
        rejectedReason: `Strict 1-Trade Rule Active: Position capacity reached (${activeTradeCount}/${maxTradesAllowed}). Only 1 trade can run at a time. The current position must close before the next trade can execute.`,
        clampedPositionSize: 0,
        allocatedCapital: 0,
        stopLoss: 0,
        takeProfit: 0,
        riskRewardRatio: 0,
        riskAmount: 0,
        potentialProfit: 0,
        warnings: ['Single-trade concurrency active (1 trade at a time)'],
      };
    }

    // 4. Maximum Daily Loss Limit
    const startingCap = dailyStartingCapital > 0 ? dailyStartingCapital : capitalState.allocatedCapital;
    const dailyPnLPct = startingCap > 0 ? (dailyPnL / startingCap) * 100 : 0;
    if (dailyPnLPct <= -riskSettings.dailyLossLimitPercent) {
      return {
        approved: false,
        rejectedReason: `Daily loss limit reached (${dailyPnLPct.toFixed(2)}% vs max allowable -${riskSettings.dailyLossLimitPercent}%). Daily circuit breaker active.`,
        clampedPositionSize: 0,
        allocatedCapital: 0,
        stopLoss: 0,
        takeProfit: 0,
        riskRewardRatio: 0,
        riskAmount: 0,
        potentialProfit: 0,
        warnings: ['Daily circuit breaker triggered'],
      };
    }

    // 5. Calculate ATR-based Stop Loss & Take Profit with Mandatory R:R Ratio Check
    const currentPrice = intent.currentPrice > 0 ? intent.currentPrice : 65000;
    const atr = intent.atr || currentPrice * 0.015;

    let stopLoss = intent.customStopLoss;
    let takeProfit = intent.customTakeProfit;

    if (intent.direction === 'LONG') {
      if (!stopLoss) stopLoss = Number((currentPrice - riskSettings.atrMultiplierSL * atr).toFixed(2));
      if (!takeProfit) takeProfit = Number((currentPrice + riskSettings.atrMultiplierTP * atr).toFixed(2));
    } else {
      if (!stopLoss) stopLoss = Number((currentPrice + riskSettings.atrMultiplierSL * atr).toFixed(2));
      if (!takeProfit) takeProfit = Number((currentPrice - riskSettings.atrMultiplierTP * atr).toFixed(2));
    }

    const priceRisk = Math.abs(currentPrice - stopLoss);
    const priceReward = Math.abs(takeProfit - currentPrice);

    if (priceRisk <= 0) {
      return {
        approved: false,
        rejectedReason: 'Invalid Stop Loss: Price risk distance cannot be zero.',
        clampedPositionSize: 0,
        allocatedCapital: 0,
        stopLoss,
        takeProfit,
        riskRewardRatio: 0,
        riskAmount: 0,
        potentialProfit: 0,
        warnings: ['Zero risk distance'],
      };
    }

    const riskRewardRatio = Number((priceReward / priceRisk).toFixed(2));
    if (riskRewardRatio < riskSettings.minRiskRewardRatio) {
      return {
        approved: false,
        rejectedReason: `Risk/Reward ratio (${riskRewardRatio}:1) is below the institutional policy threshold of ${riskSettings.minRiskRewardRatio}:1.`,
        clampedPositionSize: 0,
        allocatedCapital: 0,
        stopLoss,
        takeProfit,
        riskRewardRatio,
        riskAmount: 0,
        potentialProfit: 0,
        warnings: ['Unacceptable R:R ratio'],
      };
    }

    // 6. Mandatory Capital Sizing & AI Override Prevention
    // Rule: Never allow the AI model itself to directly decide how much money it can spend.
    // Example: Available Capital = $1,000, Max Position Size = 10% -> Max order capital = $100.
    const availableTradingCap = capitalState.availableTradingCapital;
    if (availableTradingCap <= 0) {
      return {
        approved: false,
        rejectedReason: 'Insufficient balance protection: Available trading capital is $0.00 USDT.',
        clampedPositionSize: 0,
        allocatedCapital: 0,
        stopLoss,
        takeProfit,
        riskRewardRatio,
        riskAmount: 0,
        potentialProfit: 0,
        warnings: ['Zero trading capital'],
      };
    }

    // Max capital per trade is capped by maxRiskPerTradePercent (or maxPositionSizePercent)
    const maxAllowedCapital = Math.min(
      availableTradingCap,
      availableTradingCap * (riskSettings.maxPositionSizePercent / 100)
    );

    // Max risk dollar amount allowed (e.g. 1.5% of total allocated capital)
    const maxDollarRisk = capitalState.allocatedCapital * (riskSettings.maxRiskPerTradePercent / 100);

    // Position size based on risk amount: size = maxDollarRisk / priceRisk
    const riskSizedUnits = maxDollarRisk / priceRisk;

    // Position size based on max allowable capital: size = maxAllowedCapital / currentPrice
    const capitalSizedUnits = maxAllowedCapital / currentPrice;

    // The final size MUST NOT exceed capital-sized units or risk-sized units
    let finalUnits = Math.min(riskSizedUnits, capitalSizedUnits);

    // If AI proposed a size, clamp it strictly to our maximum allowable size
    if (intent.aiSuggestedSize && intent.aiSuggestedSize > 0) {
      if (intent.aiSuggestedSize > finalUnits) {
        warnings.push(`AI requested ${intent.aiSuggestedSize} units, strictly clamped down to ${finalUnits.toFixed(4)} units by Risk Engine policy.`);
      }
      finalUnits = Math.min(intent.aiSuggestedSize, finalUnits);
    }

    const precision = currentPrice > 1000 ? 4 : 2;
    const finalSize = Math.max(0.0001, Number(finalUnits.toFixed(precision)));
    const requiredCapital = Number((finalSize * currentPrice).toFixed(2));

    // 7. Insufficient balance protection
    if (requiredCapital > availableTradingCap) {
      return {
        approved: false,
        rejectedReason: `Insufficient balance: Required trade margin ($${requiredCapital.toFixed(2)} USDT) exceeds available capital ($${availableTradingCap.toFixed(2)} USDT).`,
        clampedPositionSize: 0,
        allocatedCapital: 0,
        stopLoss,
        takeProfit,
        riskRewardRatio,
        riskAmount: 0,
        potentialProfit: 0,
        warnings: ['Balance exceeded'],
      };
    }

    const actualRisk = Number((priceRisk * finalSize).toFixed(2));
    const actualReward = Number((priceReward * finalSize).toFixed(2));

    // Record order in recent history for duplicate protection
    this.recentOrders.push({
      symbol: intent.symbol,
      direction: intent.direction,
      timestamp: now,
      clientOrderId: intent.clientOrderId,
    });

    return {
      approved: true,
      clampedPositionSize: finalSize,
      allocatedCapital: requiredCapital,
      stopLoss,
      takeProfit,
      riskRewardRatio,
      riskAmount: actualRisk,
      potentialProfit: actualReward,
      warnings,
    };
  }
}

export const riskManager = new RiskManager();
