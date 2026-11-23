import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfficeRuntime } from '../server/v2/contracts.js';
import { mountIndodaxPaper } from '../server/v2/api/indodax-paper.js';
import { IndodaxPublicClient } from '../server/market/indodax.js';
import type { IndodaxMarket } from '../shared/indodax.js';

class FeeClient extends IndodaxPublicClient {
  constructor(private readonly feeTakerPct: string | null, private bid = '99') { super(); }
  setBid(bid: string) { this.bid = bid; }
  async market(): Promise<IndodaxMarket> {
    const candles = Array.from({ length: 60 }, (_, i) => ({ time: 1_700_000_000 + i * 14_400, open: '100', high: '102', low: '98', close: '100', volume: '10' }));
    return {
      venue: 'indodax', marketType: 'spot', access: 'public-read-only', executionSupported: false, example: false,
      pair: { symbol: 'BTCUSDT', tickerId: 'btc_usdt', asset: 'BTC', quote: 'USDT', maintenance: false, suspended: false, quantityIncrement: '0.01', minQuote: '1', minQuantity: '0.01', feeTakerPct: this.feeTakerPct, feeMakerPct: null },
      timeframe: '4h', last: '100', bid: this.bid, ask: '100', observedAt: Date.now(), candles,
      sources: { ticker: 'x', book: 'x', candles: 'x', pairs: 'x' }
    };
  }
}

describe('Indodax PAPER fees and session stats', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = undefined; }
  });

  async function start(client: FeeClient, tp: string) {
    const app = express();
    app.use(express.json());
    const runner = vi.fn(async (input: { hasPosition: boolean; marketSummary: Record<string, unknown> }) => ({
      status: 'completed' as const,
      verdict: input.hasPosition ? { action: 'HOLD' as const, thesis: null, rejectionReason: null }
        : { action: 'OPEN_LONG' as const, thesis: { stop: '90', tp, orderType: 'MARKET' }, rejectionReason: null }
    }));
    const runtime = { snapshot: () => ({ mode: 'PAPER', killed: false, auto: { running: false } }), runIndodaxPaperCycle: runner } as unknown as OfficeRuntime;
    const worker = mountIndodaxPaper(app, runtime, client);
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await fetch(base + '/api/indodax/paper-agent/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'BTCUSDT', budget: '1000', intervalMin: 1 }) });
    let status: any;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 10));
      status = await (await fetch(base + '/api/indodax/paper-agent')).json();
      if (status.position || status.lastCycleAt) break;
    }
    return { base, worker, runner, status };
  }

  it('charges the pair taker fee on both legs and reports the closed episode', async () => {
    const client = new FeeClient('0.3');
    const { base, worker, runner, status } = await start(client, '130');
    try {
      // 500 budget / 100 ask = 5.00 units, notional 500, entry fee 1.5.
      expect(status.position).toMatchObject({ quantity: '5.00', entry: '100', cost: '501.5', feeRate: '0.003' });
      expect(status.cash).toBe('498.5');
      expect(runner.mock.calls[0][0].marketSummary.advisory).toMatchObject({ takerFeePct: '0.3' });
      worker.stop();
      client.setBid('110');
      const closed = await (await fetch(base + '/api/indodax/paper-agent/close', { method: 'POST' })).json() as any;
      // 5 * 110 = 550, exit fee 1.65, proceeds 548.35, net 548.35 - 501.5 = 46.85.
      expect(closed.cash).toBe('1046.85');
      expect(closed.stats).toMatchObject({ n: 1, wins: 1, losses: 0 });
      expect(closed.stats.expectancy).toBeCloseTo(46.85, 6);
    } finally { worker.stop(); }
  });

  it('skips an entry whose take profit does not clear round-trip fees plus 0.1%', async () => {
    const { worker, status } = await start(new FeeClient('0.3'), '100.5');
    try {
      expect(status.position).toBeNull();
      expect(status.lastAction).toContain('take profit does not clear');
    } finally { worker.stop(); }
  });

  it('keeps the previous no-fee behavior when the pair publishes no fee', async () => {
    const { worker, status } = await start(new FeeClient(null), '100.5');
    try {
      expect(status.position).toMatchObject({ cost: '500', feeRate: null });
    } finally { worker.stop(); }
  });
});
