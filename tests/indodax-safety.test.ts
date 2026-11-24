import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfficeRuntime } from '../server/v2/contracts.js';
import { mountIndodaxPaper } from '../server/v2/api/indodax-paper.js';
import { mountIndodaxRoutes } from '../server/v2/api/indodax.js';
import { FakeIndodaxClient } from './indodax-fixtures.js';

type Desk = { mode: string; killed: boolean; auto: { running: boolean }; trading: { values: { dailyLossLimitPct: number } } };

describe('Indodax PAPER safety guards', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); server = undefined; }
  });

  async function start(runner: ReturnType<typeof vi.fn>, desk: Desk, client = new FakeIndodaxClient()) {
    const app = express();
    app.use(express.json());
    const runtime = { snapshot: () => desk, runIndodaxPaperCycle: runner } as unknown as OfficeRuntime;
    mountIndodaxRoutes(app, client);
    const worker = mountIndodaxPaper(app, runtime, client);
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async () => (await fetch(base + '/api/indodax/paper-agent')).json() as Promise<any>;
    const post = (path: string, body: unknown = {}) => fetch(base + '/api/indodax/paper-agent' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { worker, get, post, client };
  }
  const desk = (): Desk => ({ mode: 'PAPER', killed: false, auto: { running: false }, trading: { values: { dailyLossLimitPct: 3 } } });
  const openLong = vi.fn(async () => ({ status: 'completed' as const, verdict: { action: 'OPEN_LONG' as const, thesis: { stop: '90', tp: '130', orderType: 'MARKET' }, rejectionReason: null } }));
  const waitFor = async (get: () => Promise<any>, ok: (s: any) => boolean) => {
    let status: any;
    for (let i = 0; i < 200; i++) { await new Promise((r) => setTimeout(r, 10)); status = await get(); if (ok(status)) return status; }
    throw new Error(`condition not reached: ${JSON.stringify(status)}`);
  };

  it('refuses to start while the kill switch is on and never calls the agents', async () => {
    const runner = vi.fn();
    const d = desk(); d.killed = true;
    const { worker, post } = await start(runner, d);
    try {
      expect((await post('/start', { symbol: 'BTCUSDT', budget: '1000', intervalMin: 1 })).status).toBe(409);
      expect(runner).not.toHaveBeenCalled();
    } finally { worker.stop(); }
  });

  it('opens no position and stops the session when the kill switch turns on during a cycle', async () => {
    const d = desk();
    const runner = vi.fn(async () => { d.killed = true; return openLong(); });
    const { worker, get, post } = await start(runner, d);
    try {
      await post('/start', { symbol: 'BTCUSDT', budget: '1000', intervalMin: 1 });
      const status = await waitFor(get, (s) => !s.busy && !s.running);
      expect(status.position).toBeNull();
      expect(status.trades).toEqual([]);
      expect(status.cash).toBe('1000');
    } finally { worker.stop(); }
  });

  it('pauses the session once a loss reaches the daily loss limit', async () => {
    const { worker, get, post, client } = await start(vi.fn(openLong), desk());
    try {
      await post('/start', { symbol: 'BTCUSDT', budget: '1000', intervalMin: 1 });
      await waitFor(get, (s) => Boolean(s.position));
      client.setBid('20');
      const closed = await (await post('/close')).json() as any;
      expect(closed.position).toBeNull();
      expect(closed.running).toBe(false);
      expect(closed.lastAction).toMatch(/daily loss limit/i);
    } finally { worker.stop(); }
  });

  it('keeps the session running when a loss stays inside the daily loss limit', async () => {
    const { worker, get, post, client } = await start(vi.fn(openLong), desk());
    try {
      await post('/start', { symbol: 'BTCUSDT', budget: '1000', intervalMin: 1 });
      await waitFor(get, (s) => Boolean(s.position));
      client.setBid('100');
      const closed = await (await post('/close')).json() as any;
      expect(closed.position).toBeNull();
      expect(closed.running).toBe(true);
      expect(closed.lastAction).not.toMatch(/daily loss limit/i);
    } finally { worker.stop(); }
  });

it('refuses PAPER session commands from a foreign origin', async () => {
    const runner = vi.fn(openLong);
    const { worker, get } = await start(runner, desk());
    try {
      const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/indodax/paper-agent`;
      const foreign = { 'content-type': 'application/json', origin: 'https://evil.example' };
      expect((await fetch(base, { headers: foreign })).status).toBe(403);
      expect((await fetch(base + '/start', { method: 'POST', headers: foreign, body: JSON.stringify({ symbol: 'BTCUSDT', budget: '1000', intervalMin: 1 }) })).status).toBe(403);
      expect((await fetch(base + '/close', { method: 'POST', headers: foreign, body: '{}' })).status).toBe(403);
      expect(runner).not.toHaveBeenCalled();
      expect((await get()).running).toBe(false);
    } finally { worker.stop(); }
  });
});
