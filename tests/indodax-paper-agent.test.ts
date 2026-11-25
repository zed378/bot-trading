import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfficeRuntime } from '../server/v2/contracts.js';
import { createReplacementRuntime } from '../server/v2/runtime.js';
import { mountIndodaxRoutes } from '../server/v2/api/indodax.js';
import { mountIndodaxPaper } from '../server/v2/api/indodax-paper.js';
import { IndodaxPublicClient } from '../server/market/indodax.js';
import type { IndodaxMarket } from '../shared/indodax.js';

class PaperMarketClient extends IndodaxPublicClient {
  async market(): Promise<IndodaxMarket> {
    const candles = Array.from({ length: 60 }, (_, i) => ({
      time: 1_700_000_000 + i * 14_400,
      open: '100', high: '102', low: '98', close: '100', volume: '10'
    }));
    return {
      venue: 'indodax', marketType: 'spot', access: 'public-read-only', executionSupported: false, example: false,
      pair: { symbol: 'BTCUSDT', tickerId: 'btc_usdt', asset: 'BTC', quote: 'USDT', maintenance: false, suspended: false, quantityIncrement: '0.01', minQuote: '1', minQuantity: '0.01' },
      timeframe: '4h', last: '100', bid: '99', ask: '101', observedAt: Date.now(), candles,
      sources: { ticker: 'https://api.indodax.com/ticker', book: 'https://api.indodax.com/book', candles: 'https://indodax.com/candles', pairs: 'https://indodax.com/pairs' }
    };
  }
}

describe('Indodax agent PAPER session', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      server = undefined;
    }
  });

  async function start(mode: string, runner: ReturnType<typeof vi.fn>) {
    const app = express();
    app.use(express.json());
    const client = new PaperMarketClient();
    mountIndodaxRoutes(app, client);
    const runtime = {
      snapshot: () => ({ mode, killed: false, auto: { running: false } }),
      runIndodaxPaperCycle: runner
    } as unknown as OfficeRuntime;
    const worker = mountIndodaxPaper(app, runtime, client);
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, worker };
  }

  it('runs a long-only paper buy and simulated close using Indodax quote currency', async () => {
    const runner = vi.fn(async (input: { marketSummary: Record<string, unknown>; hasPosition: boolean }) => ({
      status: 'completed' as const,
      verdict: input.hasPosition
        ? { action: 'HOLD' as const, thesis: null, rejectionReason: null }
        : { action: 'OPEN_LONG' as const, thesis: { stop: '90', tp: '120', orderType: 'MARKET' }, rejectionReason: null }
    }));
    const { base, worker } = await start('PAPER', runner);
    try {
      const started = await fetch(base + '/api/indodax/paper-agent/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTCUSDT', budget: '1000', intervalMin: 1 })
      });
      expect(started.status).toBe(200);
      let status: any;
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        status = await (await fetch(base + '/api/indodax/paper-agent')).json();
        if (status.position) break;
      }
      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner.mock.calls[0][0].marketSummary).toMatchObject({ venue: 'Indodax', marketType: 'spot', quoteCurrency: 'USDT' });
      expect(status.position).toMatchObject({ entry: '101', stop: '90', target: '120' });
      expect(status.trades[0]).toMatchObject({ side: 'BUY', reason: 'six-agent PAPER verdict' });

      worker.stop();
      const closed = await fetch(base + '/api/indodax/paper-agent/close', { method: 'POST' });
      expect(closed.status).toBe(200);
      const final = await closed.json() as any;
      expect(final.position).toBeNull();
      expect(final.trades[0]).toMatchObject({ side: 'SELL', reason: 'owner paper close' });
      expect(final.mode).toBe('PAPER');
    } finally { worker.stop(); }
  });

  it('skips an entry whose stop is implausibly far below the entry price', async () => {
    const runner = vi.fn(async () => ({
      status: 'completed' as const,
      verdict: { action: 'OPEN_LONG' as const, thesis: { stop: '5', tp: null, orderType: 'MARKET' }, rejectionReason: null }
    }));
    const { base, worker } = await start('PAPER', runner);
    try {
      await fetch(base + '/api/indodax/paper-agent/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTCUSDT', budget: '1000', intervalMin: 1 })
      });
      let status: any;
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        status = await (await fetch(base + '/api/indodax/paper-agent')).json();
        if (status.lastCycleAt) break;
      }
      expect(status.position).toBeNull();
      expect(status.trades).toHaveLength(0);
      expect(status.lastAction).toContain('below the entry');
    } finally { worker.stop(); }
  });

  it('refuses to start outside PAPER and never submits a venue order', async () => {
    const runner = vi.fn();
    const { base, worker } = await start('LIVE', runner);
    try {
      const response = await fetch(base + '/api/indodax/paper-agent/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTCUSDT', budget: '1000', intervalMin: 1 })
      });
      expect(response.status).toBe(409);
      expect(runner).not.toHaveBeenCalled();
      expect((await fetch(base + '/api/indodax/order', { method: 'POST' })).status).toBe(404);
    } finally { worker.stop(); }
  });

  it('does not open a simulated short position', async () => {
    const runner = vi.fn(async () => ({
      status: 'completed' as const,
      verdict: { action: 'OPEN_SHORT' as const, thesis: { stop: '110', tp: '80', orderType: 'MARKET' }, rejectionReason: null }
    }));
    const { base, worker } = await start('PAPER', runner);
    try {
      await fetch(base + '/api/indodax/paper-agent/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTCUSDT', budget: '1000', intervalMin: 1 })
      });
      let status: any;
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        status = await (await fetch(base + '/api/indodax/paper-agent')).json();
        if (status.lastCycleAt) break;
      }
      expect(status.position).toBeNull();
      expect(status.trades).toHaveLength(0);
      expect(status.lastAction).toContain('spot-only');
    } finally { worker.stop(); }
  });

  it('routes a paper request through the configured cycle runner with spot-only policy', async () => {
    const cycleRunner = { run: vi.fn(async () => ({ status: 'completed', verdict: null })) };
    const runtime = createReplacementRuntime({ cycleRunner: cycleRunner as any });
    try {
      await runtime.runIndodaxPaperCycle?.({
        symbol: 'BTCIDR',
        accountRef: 'indodax-paper-local',
        marketSummary: { ask: '100000000', quoteCurrency: 'IDR' },
        hasPosition: false,
        signal: new AbortController().signal
      });
      expect(cycleRunner.run).toHaveBeenCalledTimes(1);
      expect(cycleRunner.run.mock.calls[0][0]).toMatchObject({
        symbol: 'BTCIDR',
        accountRef: 'indodax-paper-local',
        policy: { maxLeverage: 1, supportsLimitGtc: false, requireTwoOfThreeAnalysts: true },
        marketSummary: { quoteCurrency: 'IDR' }
      });
      expect(runtime.snapshot().auto.running).toBe(false);
    } finally { await runtime.stop(); }
  });
});
