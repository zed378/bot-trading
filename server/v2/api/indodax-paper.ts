import type express from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { IndodaxPublicClient, indodaxSymbol } from '../../market/indodax.js';
import { analyzeIndodax } from './indodax.js';
import type { OfficeRuntime } from '../contracts.js';
import { addDecimals, compareDecimals as cmp, divDecimals, mulDecimals, quantize, subDecimals } from '../execution/decimal.js';
import { DecimalStringSchema } from '../contracts.js';
import { character, episodeStats, minTargetPrice, roundTripNetPerUnit, routeSpot, toBars, ROUND_TRIP_MIN_EDGE } from '../../market/indodax-params.js';

const budgetSchema = z.string().regex(/^\d{1,12}(?:\.\d{1,8})?$/).refine(v => Number(v) > 0);
const startSchema = z.object({ symbol: z.string().max(32), budget: budgetSchema, intervalMin: z.number().int().min(1).max(1440) }).strict();
// cost and feeRate are quote-currency values; feeRate is a fraction (0.003 = 0.3%) or null when the pair publishes no fee.
type PaperPosition = { quantity: string; entry: string; stop: string; target: string | null; cost: string; feeRate: string | null };
type PaperTrade = { side: 'BUY' | 'SELL'; price: string; quantity: string; reason: string; at: number };

// This paper session uses public market data and never reads or sends exchange credentials.
export function mountIndodaxPaper(app: express.Express, runtime: OfficeRuntime, client = new IndodaxPublicClient()) {
  let state = { running: false, busy: false, symbol: '', quote: '', initialCash: '0', cash: '0', lastPrice: '', lastAction: '', lastCycleAt: 0, trades: [] as PaperTrade[], episodes: [] as number[] };
  let position: PaperPosition | null = null;
  let cycleTimer: ReturnType<typeof setTimeout> | undefined;
  let monitorTimer: ReturnType<typeof setTimeout> | undefined;
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  let cycleController: AbortController | null = null;
  let positionEpoch = 0;
  let closeBusy = false;
  const base = '/api/indodax/paper-agent';
  const view = () => {
    const { episodes, ...rest } = state;
    return { ...rest, mode: 'PAPER' as const, protection: position ? 'SIMULATED_SL_TP' : 'NONE', position, stats: episodeStats(episodes) };
  };

  function pauseAgents() {
    state.running = false;
    clearTimeout(cycleTimer);
    clearTimeout(guardTimer);
    cycleController?.abort();
    cycleController = null;
  }

  const enforceDailyLossCap = (bid: string): boolean => {
    const stateSnapshot = runtime.snapshot();
    const configuredPct = Number(stateSnapshot.trading?.values?.dailyLossLimitPct ?? 3);
    const limitPct = Number.isFinite(configuredPct) && configuredPct > 0 ? Math.min(100, configuredPct) : 3;
    const equity = position ? addDecimals(state.cash, mulDecimals(position.quantity, bid)) : state.cash;
    const loss = subDecimals(state.initialCash, equity);
    const lossLimit = mulDecimals(state.initialCash, (limitPct / 100).toFixed(8));
    if (cmp(loss, '0') > 0 && cmp(loss, lossLimit) >= 0) {
      state.lastAction = `Paper daily loss limit reached (${limitPct}%); agent cycles paused`;
      pauseAgents();
      return false;
    }
    return true;
  };

  const closePaperPosition = (bid: string, reason: string) => {
    if (!position) return;
    const quantity = position.quantity;
    const gross = mulDecimals(quantity, bid);
    const proceeds = position.feeRate ? subDecimals(gross, mulDecimals(gross, position.feeRate)) : gross;
    state.cash = addDecimals(state.cash, proceeds);
    state.episodes = [...state.episodes, Number(subDecimals(proceeds, position.cost))].slice(-500);
    state.trades = [{ side: 'SELL' as const, price: bid, quantity, reason, at: Date.now() }, ...state.trades].slice(0, 50);
    position = null;
    positionEpoch += 1;
    state.lastAction = `Paper SELL at ${bid}: ${reason}`;
    enforceDailyLossCap(bid);
  };
  const checkStops = (bid: string): boolean => {
    if (!position) return false;
    if (cmp(bid, position.stop) <= 0) { closePaperPosition(bid, 'stop loss'); return true; }
    if (position.target && cmp(bid, position.target) >= 0) { closePaperPosition(bid, 'take profit'); return true; }
    return false;
  };

  const shutdown = () => {
    pauseAgents();
    clearTimeout(monitorTimer);
  };
  const scheduleSessionGuard = () => {
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => {
      if (!state.running) return;
      const desk = runtime.snapshot();
      if (desk.killed || desk.mode !== 'PAPER') {
        pauseAgents();
        if (desk.killed) clearTimeout(monitorTimer);
        return;
      }
      scheduleSessionGuard();
    }, 5_000);
    guardTimer.unref();
  };

  const scheduleMonitor = () => {
    clearTimeout(monitorTimer);
    const desk = runtime.snapshot();
    if (!position || desk.killed || desk.mode !== 'PAPER') return;
    monitorTimer = setTimeout(() => void monitorPosition(), 5_000);
    monitorTimer.unref();
  };
  const monitorPosition = async () => {
    const before = runtime.snapshot();
    if (!position || before.killed || before.mode !== 'PAPER') return;
    try {
      const market = await client.market(state.symbol, '4h');
      const after = runtime.snapshot();
      if (after.killed || after.mode !== 'PAPER') return;
      if (position && Date.now() - market.observedAt <= 60_000) {
        state.lastPrice = market.last;
        const withinLossCap = enforceDailyLossCap(market.bid);
        checkStops(market.bid);
        if (!withinLossCap) return;
      } else if (position) {
        state.lastAction = 'Paper SL/TP monitor: Indodax quote is stale';
      }
    } catch {
      state.lastAction = 'Paper SL/TP monitor: Indodax quote unavailable';
    } finally {
      scheduleMonitor();
    }
  };

  const runCycle = async (intervalMin: number) => {
    if (!state.running || runtime.snapshot().killed || runtime.snapshot().mode !== 'PAPER') { pauseAgents(); return; }
    if (state.busy || closeBusy) return;
    const controller = cycleController = new AbortController();
    const startingPositionEpoch = positionEpoch;
    state.busy = true;
    try {
      const market = await analyzeIndodax(client, state.symbol, '4h');
      if (!state.running || controller.signal.aborted || runtime.snapshot().killed || Date.now() - market.observedAt > 60_000) return;
      state.lastPrice = market.last;
      if (!enforceDailyLossCap(market.bid)) return;
      if (checkStops(market.bid)) return;

      const accountRef = 'indodax-paper-local';
      const bars = toBars(market.candles);
      const taker = market.pair.feeTakerPct ? Number(market.pair.feeTakerPct) / 100 : null;
      const advisory = {
        // KORO Math Atlas subset. Context only; it never changes order size or relaxes a guard.
        character: character(bars),
        spotRoute: routeSpot(bars),
        takerFeePct: market.pair.feeTakerPct ?? null,
        minTakeProfit: taker === null ? null : String(Number(minTargetPrice(Number(market.ask), taker, taker).toPrecision(8))),
        sessionStats: episodeStats(state.episodes)
      };
      const marketSummary = {
        venue: 'Indodax',
        marketType: 'spot',
        mode: 'PAPER',
        quoteCurrency: market.pair.quote,
        last: market.last,
        bid: market.bid,
        ask: market.ask,
        observedAt: market.observedAt,
        timeframe: '4h',
        indicators: market.indicators,
        candles: market.candles.slice(-40),
        advisory,
        availableCash: state.cash,
        currentPosition: position,
        constraints: `Spot only, prices and paper budget are in ${market.pair.quote}. LONG buys and CLOSE sells only the simulated holding. SHORT, leverage and limit orders are unavailable. Maximum allocation per entry is half of remaining paper cash. Every entry must include a valid stop below ask; take profit is optional. When advisory.takerFeePct is set, paper fills pay that taker fee on both legs and a take profit below advisory.minTakeProfit is rejected.`
      };
      const result = await runtime.runIndodaxPaperCycle?.({
        symbol: state.symbol,
        accountRef,
        marketSummary,
        hasPosition: Boolean(position),
        signal: controller.signal
      });
      if (!state.running || controller.signal.aborted || runtime.snapshot().killed || runtime.snapshot().mode !== 'PAPER') return;
      if (startingPositionEpoch !== positionEpoch) return;
      state.lastCycleAt = Date.now();
      const verdict = result?.status === 'completed' ? result.verdict : null;
      state.lastAction = verdict?.rejectionReason ?? verdict?.action ?? (result ? 'Agent cycle incomplete' : 'Agent cycle is unavailable');

      const fresh = await client.market(state.symbol, '4h');
      if (!state.running || controller.signal.aborted || runtime.snapshot().killed || runtime.snapshot().mode !== 'PAPER' || Date.now() - fresh.observedAt > 60_000) return;
      if (startingPositionEpoch !== positionEpoch) return;
      state.lastPrice = fresh.last;
      if (!enforceDailyLossCap(fresh.bid)) return;
      if (checkStops(fresh.bid)) return;
      if (verdict?.action === 'CLOSE') { closePaperPosition(fresh.bid, 'agent CLOSE'); return; }
      if (verdict?.action === 'OPEN_SHORT') { state.lastAction = 'Rejected: Indodax paper agent is spot-only'; return; }
      if (position || verdict?.action !== 'OPEN_LONG' || !verdict.thesis || verdict.thesis.orderType === 'LIMIT_GTC') return;

      const stop = DecimalStringSchema.safeParse(verdict.thesis.stop);
      const target = DecimalStringSchema.safeParse(verdict.thesis.tp);
      const pair = fresh.pair;
      if (!stop.success || cmp(stop.data, '0') <= 0 || cmp(stop.data, fresh.ask) >= 0 ||
          !pair.quantityIncrement || !pair.minQuantity || !pair.minQuote ||
          [pair.quantityIncrement, pair.minQuantity, pair.minQuote].some(value => cmp(value, '0') <= 0)) {
        state.lastAction = 'Entry skipped: invalid stop or missing Indodax pair rules';
        return;
      }
      const quantity = quantize(divDecimals(divDecimals(state.cash, '2'), fresh.ask, 24), pair.quantityIncrement, 'floor');
      const notional = mulDecimals(quantity, fresh.ask);
      if (cmp(quantity, pair.minQuantity) < 0 || cmp(notional, pair.minQuote) < 0) {
        state.lastAction = 'Entry skipped: simulated order is below Indodax pair minimum';
        return;
      }
      const feeRate = pair.feeTakerPct && cmp(pair.feeTakerPct, '0') > 0 ? divDecimals(pair.feeTakerPct, '100', 12) : null;
      const cost = feeRate ? addDecimals(notional, mulDecimals(notional, feeRate)) : notional;
      const targetPrice = target.success && cmp(target.data, fresh.ask) > 0 ? target.data : null;
      if (feeRate && targetPrice) {
        const fee = Number(feeRate);
        if (roundTripNetPerUnit(Number(fresh.ask), Number(targetPrice), fee, fee) <= Number(fresh.ask) * ROUND_TRIP_MIN_EDGE) {
          state.lastAction = 'Entry skipped: take profit does not clear round-trip taker fees plus 0.1%';
          return;
        }
      }
      position = { quantity, entry: fresh.ask, stop: stop.data, target: targetPrice, cost, feeRate };
      positionEpoch += 1;
      state.cash = subDecimals(state.cash, cost);
      // `cost` includes the entry fee, so a BUY row shows the price and quantity but cash moves by `cost`.
      state.trades = [{ side: 'BUY' as const, price: fresh.ask, quantity, reason: 'six-agent PAPER verdict', at: Date.now() }, ...state.trades].slice(0, 50);
      state.lastAction = `Paper BUY ${quantity} ${state.symbol} at ${fresh.ask}`;
      scheduleMonitor();
    } catch {
      if (!controller.signal.aborted) state.lastAction = 'Indodax data or agent cycle unavailable';
    } finally {
      state.busy = false;
      if (cycleController === controller) cycleController = null;
      if (state.running && !runtime.snapshot().killed && runtime.snapshot().mode === 'PAPER') {
        cycleTimer = setTimeout(() => void runCycle(intervalMin), intervalMin * 60_000);
        cycleTimer.unref();
      } else if (runtime.snapshot().killed) {
        pauseAgents();
        clearTimeout(monitorTimer);
      } else if (runtime.snapshot().mode !== 'PAPER') {
        pauseAgents();
      }
    }
  };

  app.get(base, (_req, res) => res.json(view()));
  app.post(base + '/stop', (_req, res) => { pauseAgents(); res.json(view()); });
  app.post(base + '/close', async (_req, res) => {
    if (!position || state.busy || closeBusy) return res.status(409).json({ error: 'No idle simulated position to close.' });
    closeBusy = true;
    try {
      const market = await client.market(state.symbol, '4h');
      if (Date.now() - market.observedAt > 60_000) return res.status(503).json({ error: 'Indodax paper quote is stale; no simulated close recorded.' });
      closePaperPosition(market.bid, 'owner paper close');
      return res.json(view());
    } catch {
      return res.status(503).json({ error: 'Indodax public quote unavailable; paper position remains open.' });
    } finally { closeBusy = false; }
  });
  app.post(base + '/start', (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose a valid pair, positive paper budget and cycle interval.' });
    const desk = runtime.snapshot();
    if (!runtime.runIndodaxPaperCycle || desk.mode !== 'PAPER' || desk.killed || desk.auto.running || state.running || state.busy || closeBusy) {
      return res.status(409).json({ error: 'Indodax paper agent requires the configured PAPER desk, no running desk cycle, and an available agent runner.' });
    }
    let symbol: string;
    try { symbol = indodaxSymbol(parsed.data.symbol); }
    catch { return res.status(400).json({ error: 'Invalid Indodax pair.' }); }
    if (position && symbol !== state.symbol) return res.status(409).json({ error: 'Close the existing simulated position before switching pairs.' });
    const quote = symbol.endsWith('IDR') ? 'IDR' : 'USDT';
    if (position) {
      state.running = true;
      state.lastAction = 'Resuming agent cycles; existing paper position retained';
    } else {
      state = { running: true, busy: false, symbol, quote, initialCash: parsed.data.budget, cash: parsed.data.budget, lastPrice: '', lastAction: 'Starting PAPER cycle', lastCycleAt: 0, trades: [], episodes: [] };
    }
    positionEpoch += 1;
    scheduleSessionGuard();
    void runCycle(parsed.data.intervalMin);
    return res.json(view());
  });
  return { stop: shutdown };
}
