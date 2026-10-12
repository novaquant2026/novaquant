import crypto from 'crypto';
import { SupportedExchange } from '../src/types';

export interface MarketBalanceInfo {
  capital: number;
  botCapital: number;
  available: number;
  lockedInOrders: number;
  marginUsed?: number;
  unrealizedPnl?: number;
  currency: string;
}

export interface ExchangeAccountBalance {
  exchange: SupportedExchange;
  connected: boolean;
  lastSyncedAt: number;
  spot: MarketBalanceInfo;
  futures: MarketBalanceInfo;
  selectedMode: 'SPOT' | 'FUTURES';
  activeBotCapital: number;
  rawSummary?: string;
  error?: string;
}

const REQUEST_TIMEOUT_MS = 10000;

// Helper for fetch with timeout
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Real Binance Spot & Futures Available Balance Retriever
 */
export async function fetchBinanceRealBalances(
  apiKey: string,
  secretKey: string
): Promise<{ spot: MarketBalanceInfo; futures: MarketBalanceInfo; rawSummary?: string }> {
  const recvWindow = 10000;
  let spotBalance: MarketBalanceInfo = {
    capital: 0,
    botCapital: 0,
    available: 0,
    lockedInOrders: 0,
    currency: 'USDT',
  };
  let futuresBalance: MarketBalanceInfo = {
    capital: 0,
    botCapital: 0,
    available: 0,
    lockedInOrders: 0,
    marginUsed: 0,
    unrealizedPnl: 0,
    currency: 'USDT',
  };

  const errors: string[] = [];

  // 1. Fetch Binance Spot
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(queryString)
      .digest('hex');

    const spotUrl = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;
    const spotRes = await fetchWithTimeout(spotUrl, {
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/json',
      },
    });

    const spotData = await spotRes.json();
    if (!spotRes.ok || spotData.code) {
      errors.push(`Spot error: ${spotData.msg || spotData.code || spotRes.statusText}`);
    } else if (Array.isArray(spotData.balances)) {
      const usdt = spotData.balances.find((b: any) => b.asset === 'USDT');
      const free = usdt ? parseFloat(usdt.free || '0') : 0;
      const locked = usdt ? parseFloat(usdt.locked || '0') : 0;
      const total = free + locked;

      spotBalance = {
        capital: Number(total.toFixed(4)),
        botCapital: Number(free.toFixed(4)), // Bot Capital = Available Exchange Trading Balance
        available: Number(free.toFixed(4)),
        lockedInOrders: Number(locked.toFixed(4)),
        currency: 'USDT',
      };
    }
  } catch (err: any) {
    errors.push(`Spot network error: ${err.message}`);
  }

  // 2. Fetch Binance USDT-M Futures
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(queryString)
      .digest('hex');

    const futuresUrl = `https://fapi.binance.com/fapi/v2/account?${queryString}&signature=${signature}`;
    const futuresRes = await fetchWithTimeout(futuresUrl, {
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/json',
      },
    });

    const futuresData = await futuresRes.json();
    if (!futuresRes.ok || futuresData.code) {
      errors.push(`Futures notice: ${futuresData.msg || futuresData.code || futuresRes.statusText}`);
    } else {
      // In Binance Futures v2 account:
      // availableBalance: available margin balance for new trades
      // totalMarginBalance: wallet balance + unrealized profit
      // totalPositionInitialMargin: margin currently used in open positions
      // totalOpenOrderInitialMargin: funds locked in open futures orders
      const available = parseFloat(futuresData.availableBalance || '0');
      const totalMargin = parseFloat(futuresData.totalMarginBalance || futuresData.totalWalletBalance || '0');
      const positionMargin = parseFloat(futuresData.totalPositionInitialMargin || '0');
      const orderMargin = parseFloat(futuresData.totalOpenOrderInitialMargin || '0');
      const unrealizedProfit = parseFloat(futuresData.totalUnrealizedProfit || '0');

      futuresBalance = {
        capital: Number(totalMargin.toFixed(4)),
        botCapital: Number(available.toFixed(4)), // Bot Capital = Available Exchange Trading Balance
        available: Number(available.toFixed(4)),
        lockedInOrders: Number(orderMargin.toFixed(4)),
        marginUsed: Number(positionMargin.toFixed(4)),
        unrealizedPnl: Number(unrealizedProfit.toFixed(4)),
        currency: 'USDT',
      };
    }
  } catch (err: any) {
    errors.push(`Futures network error: ${err.message}`);
  }

  // If both Spot and Futures failed with errors, throw to inform the caller
  if (spotBalance.capital === 0 && futuresBalance.capital === 0 && errors.length > 0) {
    // Check if both had errors
    const errorSummary = errors.join('; ');
    // If it was an explicit auth error, bubble it up
    if (errorSummary.includes('Invalid API-key') || errorSummary.includes('Signature') || errorSummary.includes('IP')) {
      throw new Error(`Binance API Authentication Failed: ${errorSummary}`);
    }
  }

  return {
    spot: spotBalance,
    futures: futuresBalance,
    rawSummary: errors.length ? errors.join('; ') : 'Binance Spot & Futures balances queried successfully',
  };
}

/**
 * Real Bybit Spot & Futures (Unified / Contract) Available Balance Retriever
 */
export async function fetchBybitRealBalances(
  apiKey: string,
  secretKey: string
): Promise<{ spot: MarketBalanceInfo; futures: MarketBalanceInfo; rawSummary?: string }> {
  const recvWindow = '10000';
  let spotBalance: MarketBalanceInfo = {
    capital: 0,
    botCapital: 0,
    available: 0,
    lockedInOrders: 0,
    currency: 'USDT',
  };
  let futuresBalance: MarketBalanceInfo = {
    capital: 0,
    botCapital: 0,
    available: 0,
    lockedInOrders: 0,
    marginUsed: 0,
    unrealizedPnl: 0,
    currency: 'USDT',
  };

  const errors: string[] = [];

  // 1. Query Bybit Unified Trading Account (UTA)
  try {
    const timestamp = Date.now().toString();
    const queryString = 'accountType=UNIFIED';
    const signPayload = timestamp + apiKey + recvWindow + queryString;
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(signPayload)
      .digest('hex');

    const res = await fetchWithTimeout(`https://api.bybit.com/v5/account/wallet-balance?${queryString}`, {
      headers: {
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'X-BAPI-SIGN': signature,
      },
    });

    const data = await res.json();
    if (data.retCode === 0 && data.result?.list?.length > 0) {
      const account = data.result.list[0];
      const coinData = account.coin?.find((c: any) => c.coin === 'USDT');

      if (coinData) {
        const walletBalance = parseFloat(coinData.walletBalance || '0');
        const availableToWithdraw = parseFloat(coinData.availableToWithdraw || coinData.free || '0');
        const totalOrderIM = parseFloat(coinData.totalOrderIM || '0');
        const totalPositionIM = parseFloat(coinData.totalPositionIM || '0');
        const unrealisedPnl = parseFloat(coinData.unrealisedPnl || '0');

        // In Bybit UTA, available trading balance accounts for position & order margin
        const availableTrading = Math.max(0, availableToWithdraw);

        spotBalance = {
          capital: Number(walletBalance.toFixed(4)),
          botCapital: Number(availableTrading.toFixed(4)),
          available: Number(availableTrading.toFixed(4)),
          lockedInOrders: Number(totalOrderIM.toFixed(4)),
          currency: 'USDT',
        };

        futuresBalance = {
          capital: Number(walletBalance.toFixed(4)),
          botCapital: Number(availableTrading.toFixed(4)),
          available: Number(availableTrading.toFixed(4)),
          lockedInOrders: Number(totalOrderIM.toFixed(4)),
          marginUsed: Number(totalPositionIM.toFixed(4)),
          unrealizedPnl: Number(unrealisedPnl.toFixed(4)),
          currency: 'USDT',
        };
      }
    } else {
      errors.push(`UTA query: ${data.retMsg || data.retCode}`);
    }
  } catch (err: any) {
    errors.push(`Bybit UTA error: ${err.message}`);
  }

  // If UTA returned 0 or error, query Classic Contract (Derivatives)
  if (futuresBalance.capital === 0) {
    try {
      const timestamp = Date.now().toString();
      const queryString = 'accountType=CONTRACT';
      const signPayload = timestamp + apiKey + recvWindow + queryString;
      const signature = crypto
        .createHmac('sha256', secretKey)
        .update(signPayload)
        .digest('hex');

      const res = await fetchWithTimeout(`https://api.bybit.com/v5/account/wallet-balance?${queryString}`, {
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'X-BAPI-SIGN': signature,
        },
      });

      const data = await res.json();
      if (data.retCode === 0 && data.result?.list?.length > 0) {
        const coinData = data.result.list[0].coin?.find((c: any) => c.coin === 'USDT');
        if (coinData) {
          const wallet = parseFloat(coinData.walletBalance || '0');
          const avail = parseFloat(coinData.availableToWithdraw || '0');
          const orderIM = parseFloat(coinData.totalOrderIM || '0');
          const posIM = parseFloat(coinData.totalPositionIM || '0');
          const pnl = parseFloat(coinData.unrealisedPnl || '0');

          futuresBalance = {
            capital: Number(wallet.toFixed(4)),
            botCapital: Number(avail.toFixed(4)),
            available: Number(avail.toFixed(4)),
            lockedInOrders: Number(orderIM.toFixed(4)),
            marginUsed: Number(posIM.toFixed(4)),
            unrealizedPnl: Number(pnl.toFixed(4)),
            currency: 'USDT',
          };
        }
      }
    } catch (err: any) {
      errors.push(`Bybit Contract error: ${err.message}`);
    }
  }

  // If Spot is still 0, query Classic SPOT
  if (spotBalance.capital === 0) {
    try {
      const timestamp = Date.now().toString();
      const queryString = 'accountType=SPOT';
      const signPayload = timestamp + apiKey + recvWindow + queryString;
      const signature = crypto
        .createHmac('sha256', secretKey)
        .update(signPayload)
        .digest('hex');

      const res = await fetchWithTimeout(`https://api.bybit.com/v5/account/wallet-balance?${queryString}`, {
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'X-BAPI-SIGN': signature,
        },
      });

      const data = await res.json();
      if (data.retCode === 0 && data.result?.list?.length > 0) {
        const coinData = data.result.list[0].coin?.find((c: any) => c.coin === 'USDT');
        if (coinData) {
          const free = parseFloat(coinData.free || coinData.availableToWithdraw || '0');
          const locked = parseFloat(coinData.locked || '0');
          const total = free + locked;

          spotBalance = {
            capital: Number(total.toFixed(4)),
            botCapital: Number(free.toFixed(4)),
            available: Number(free.toFixed(4)),
            lockedInOrders: Number(locked.toFixed(4)),
            currency: 'USDT',
          };
        }
      }
    } catch (err: any) {
      errors.push(`Bybit Spot error: ${err.message}`);
    }
  }

  if (spotBalance.capital === 0 && futuresBalance.capital === 0 && errors.length > 0) {
    const errorSummary = errors.join('; ');
    if (errorSummary.includes('10003') || errorSummary.includes('10004') || errorSummary.includes('sign') || errorSummary.includes('key')) {
      throw new Error(`Bybit API Authentication Failed: ${errorSummary}`);
    }
  }

  return {
    spot: spotBalance,
    futures: futuresBalance,
    rawSummary: errors.length ? errors.join('; ') : 'Bybit balances queried successfully',
  };
}

/**
 * Real Bitget Spot & Futures Available Balance Retriever
 */
export async function fetchBitgetRealBalances(
  apiKey: string,
  secretKey: string,
  passphrase?: string
): Promise<{ spot: MarketBalanceInfo; futures: MarketBalanceInfo; rawSummary?: string }> {
  if (!passphrase) {
    throw new Error('Bitget (Bitgate) API requires an API passphrase.');
  }

  let spotBalance: MarketBalanceInfo = {
    capital: 0,
    botCapital: 0,
    available: 0,
    lockedInOrders: 0,
    currency: 'USDT',
  };
  let futuresBalance: MarketBalanceInfo = {
    capital: 0,
    botCapital: 0,
    available: 0,
    lockedInOrders: 0,
    marginUsed: 0,
    unrealizedPnl: 0,
    currency: 'USDT',
  };

  const errors: string[] = [];

  // 1. Bitget Spot Assets
  try {
    const timestamp = Date.now().toString();
    const method = 'GET';
    const requestPath = '/api/v2/spot/account/assets';
    const queryString = 'coin=USDT';
    const signPayload = `${timestamp}${method}${requestPath}?${queryString}`;
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(signPayload)
      .digest('base64');

    const res = await fetchWithTimeout(`https://api.bitget.com${requestPath}?${queryString}`, {
      headers: {
        'ACCESS-KEY': apiKey,
        'ACCESS-SIGN': signature,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-PASSPHRASE': passphrase,
        locale: 'en-US',
      },
    });

    const data = await res.json();
    if (data.code === '00000' && Array.isArray(data.data)) {
      const usdt = data.data.find((b: any) => b.coin === 'USDT') || data.data[0];
      if (usdt) {
        const free = parseFloat(usdt.available || usdt.limitAvailable || '0');
        const frozen = parseFloat(usdt.frozen || '0');
        const locked = parseFloat(usdt.locked || '0');
        const total = free + frozen + locked;

        spotBalance = {
          capital: Number(total.toFixed(4)),
          botCapital: Number(free.toFixed(4)), // Available Spot
          available: Number(free.toFixed(4)),
          lockedInOrders: Number((frozen + locked).toFixed(4)),
          currency: 'USDT',
        };
      }
    } else {
      errors.push(`Bitget Spot: ${data.msg || data.code}`);
    }
  } catch (err: any) {
    errors.push(`Bitget Spot network error: ${err.message}`);
  }

  // 2. Bitget Futures (USDT-FUTURES)
  try {
    const timestamp = Date.now().toString();
    const method = 'GET';
    const requestPath = '/api/v2/mix/account/accounts';
    const queryString = 'productType=USDT-FUTURES';
    const signPayload = `${timestamp}${method}${requestPath}?${queryString}`;
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(signPayload)
      .digest('base64');

    const res = await fetchWithTimeout(`https://api.bitget.com${requestPath}?${queryString}`, {
      headers: {
        'ACCESS-KEY': apiKey,
        'ACCESS-SIGN': signature,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-PASSPHRASE': passphrase,
        locale: 'en-US',
      },
    });

    const data = await res.json();
    if (data.code === '00000' && Array.isArray(data.data)) {
      const usdt = data.data.find((b: any) => b.marginCoin === 'USDT') || data.data[0];
      if (usdt) {
        const available = parseFloat(usdt.available || usdt.crossedMaxAvailable || '0');
        const locked = parseFloat(usdt.locked || '0');
        const equity = parseFloat(usdt.equity || usdt.usdtEquity || '0');
        const unrealized = parseFloat(usdt.unrealizedPL || '0');
        const capital = equity > 0 ? equity : available + locked;

        futuresBalance = {
          capital: Number(capital.toFixed(4)),
          botCapital: Number(available.toFixed(4)), // Available Futures Margin
          available: Number(available.toFixed(4)),
          lockedInOrders: Number(locked.toFixed(4)),
          marginUsed: Number(locked.toFixed(4)),
          unrealizedPnl: Number(unrealized.toFixed(4)),
          currency: 'USDT',
        };
      }
    } else {
      errors.push(`Bitget Futures: ${data.msg || data.code}`);
    }
  } catch (err: any) {
    errors.push(`Bitget Futures network error: ${err.message}`);
  }

  if (spotBalance.capital === 0 && futuresBalance.capital === 0 && errors.length > 0) {
    const errorSummary = errors.join('; ');
    if (errorSummary.includes('400') || errorSummary.includes('sign') || errorSummary.includes('passphrase') || errorSummary.includes('key')) {
      throw new Error(`Bitget API Authentication Failed: ${errorSummary}`);
    }
  }

  return {
    spot: spotBalance,
    futures: futuresBalance,
    rawSummary: errors.length ? errors.join('; ') : 'Bitget balances queried successfully',
  };
}
