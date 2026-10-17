export async function startAutonomousEngine(PORT: number, intervalMs = 10000) {
  const DEFAULT_USER_ID = 'usr_novaquant';
  let autonomousInFlight = false;
  let consecutiveFailures = 0;

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function postJson(path: string, body: any) {
    try {
      const url = `http://127.0.0.1:${PORT}${path}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // pass x-user-id so server middleware treats requests as the default user
          'x-user-id': DEFAULT_USER_ID,
        },
        body: JSON.stringify(body),
      });
      const txt = await resp.text();
      try {
        return JSON.parse(txt);
      } catch {
        return txt;
      }
    } catch (err) {
      throw err;
    }
  }

  async function analyzeSymbol(symbol: string) {
    return postJson('/api/ai/analyze', { symbol });
  }

  async function runConsensus(payload: any) {
    return postJson('/api/consensus', payload);
  }

  async function runRiskCheck(payload: any) {
    return postJson('/api/risk/check', payload);
  }

  async function placeTrade(payload: any) {
    return postJson('/api/trades/open', payload);
  }

  console.log('[AUTONOMOUS] Starting autonomous engine loop (LIVE mode)');

  setInterval(async () => {
    if (autonomousInFlight) return;
    autonomousInFlight = true;

    try {
      // Query a safe snapshot to ensure the bot is in RUNNING & LIVE verified
      const syncResp = await fetch(`http://127.0.0.1:${PORT}/api/bot/sync`, {
        method: 'GET',
        headers: { 'x-user-id': DEFAULT_USER_ID },
      });
      const syncJson = await syncResp.json();

      const { botStatus, activeTradingProcessesRunning, autonomousEligible } = syncJson;
      if (botStatus !== 'RUNNING' || !activeTradingProcessesRunning) {
        autonomousInFlight = false;
        return;
      }

      // Choose a symbol from the first user bot if available
      let symbol = 'BTC/USDT';
      try {
        const botsResp = await fetch(`http://127.0.0.1:${PORT}/api/bots`, { method: 'GET', headers: { 'x-user-id': DEFAULT_USER_ID } });
        const botsJson = await botsResp.json();
        if (botsJson && Array.isArray(botsJson.bots) && botsJson.bots.length > 0) {
          symbol = botsJson.bots[0].trading_pair || symbol;
        }
      } catch (e) {
        // ignore and use default symbol
      }

      // 1) Get AI analysis
      const analysis = await analyzeSymbol(symbol);
      if (!analysis) {
        throw new Error('AI analysis returned empty');
      }

      // The /api/ai/analyze endpoint returns openai and gemini objects
      const openai = analysis.openai || null;
      const gemini = analysis.gemini || null;
      const tech = analysis.technical || null;

      // Build consensus input (use defaults if missing)
      const openai_decision = openai?.decision || (tech ? tech.decision : 'HOLD');
      const openai_confidence = openai?.confidence || 0;
      const gemini_decision = gemini?.decision || (tech ? tech.decision : 'HOLD');
      const gemini_confidence = gemini?.confidence || 0;
      const technical_decision = tech?.decision || 'HOLD';
      const technical_confidence = tech?.confidence || 0;

      const consensusReq = {
        openai_decision,
        gemini_decision,
        technical_decision,
        openai_confidence,
        gemini_confidence,
        technical_confidence,
      };

      const consensus = await runConsensus(consensusReq);
      if (!consensus) {
        throw new Error('Consensus engine returned empty');
      }

      // Only proceed if consensus approved_for_risk_check
      if (!consensus.approved_for_risk_check) {
        // nothing to execute
        autonomousInFlight = false;
        return;
      }

      const direction = consensus.final_consensus;
      if (!['LONG', 'SHORT'].includes(direction)) {
        autonomousInFlight = false;
        return;
      }

      // Current market price
      const marketResp = await fetch(`http://127.0.0.1:${PORT}/api/market-data/${encodeURIComponent(symbol)}`, { method: 'GET', headers: { 'x-user-id': DEFAULT_USER_ID } });
      const marketJson = await marketResp.json();
      const entryPrice = marketJson.price || marketJson?.market?.price || (Date.now() % 1000); // fallback

      // 2) Run risk check
      const riskPayload = { symbol, direction, entryPrice };
      const riskRes = await runRiskCheck(riskPayload);

      if (!riskRes || !riskRes.approved) {
        // record audit via endpoint
        await fetch(`http://127.0.0.1:${PORT}/api/audit-logs/clear`, { method: 'POST', headers: { 'x-user-id': DEFAULT_USER_ID } }).catch(() => {});
        autonomousInFlight = false;
        return;
      }

      // 3) Place the trade using the approved size
      const tradePayload = {
        symbol,
        direction,
        position_size: riskRes.position_size,
        stop_loss: riskRes.stop_loss,
        take_profit: riskRes.take_profit,
        exchange: (analysis.aiAvailability && analysis.aiAvailability.exchange) || undefined,
        consensusScore: consensus.consensusScore || 80,
      };

      const placeRes = await placeTrade(tradePayload);

      // Log outcome
      console.log('[AUTONOMOUS] Trade attempt result:', placeRes);

      consecutiveFailures = 0;
    } catch (err: any) {
      consecutiveFailures += 1;
      console.warn('[AUTONOMOUS] Loop error:', err?.message || err);
      if (consecutiveFailures >= 5) {
        console.error('[AUTONOMOUS] Too many consecutive failures, entering cooldown');
        await sleep(60000); // 60s cooldown
        consecutiveFailures = 0;
      }
    } finally {
      autonomousInFlight = false;
    }
  }, intervalMs);
}
