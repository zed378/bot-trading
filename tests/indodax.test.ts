import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndodaxPublicClient, indodaxDecimal, indodaxSymbol } from '../server/market/indodax.js';
import { analyzeIndodax, mountIndodaxRoutes } from '../server/v2/api/indodax.js';

const NOW = Date.UTC(2026, 10, 20, 12);
const pair = { symbol: 'BTCIDR', ticker_id: 'btc_idr', base_currency: 'idr', traded_currency: 'btc', quantity_increment: '0.00000001', trade_min_base_currency: '10000', trade_min_traded_currency: '0.00001', is_maintenance: '0', is_market_suspended: 0 };
const bars = (seconds = 14_400) => Array.from({ length: 71 }, (_, i) => ({ Time: NOW / 1000 - (70 - i) * seconds, Open: '1500000000', High: '1520000000', Low: '1490000000', Close: String(1500000000 + i * 1000), Volume: '0.0123456789' }));

function fixture(transform: (url: URL, body: any) => any = (_url, body) => body) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    let body: any;
    if (url.pathname === '/api/pairs') body = [pair];
    else if (url.pathname === '/api/v2/ticker/price') body = { symbol: 'btcidr', price: '1500000000.12345678' };
    else if (url.pathname === '/api/v2/ticker/bookTicker') body = { symbol: 'BTCIDR', bidPrice: '1499999000', askPrice: '1500001000', bidQty: '1', askQty: '1' };
    else if (url.pathname === '/tradingview/history_v2') body = bars(url.searchParams.get('tf') === '1D' ? 86_400 : 14_400);
    else throw new Error('Unexpected endpoint');
    return new Response(JSON.stringify(transform(url, body)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('Indodax public connector', () => {
  it('preserves exchange display aliases while validating legacy currency identities', async () => {
    const fetcher = fixture((url, body) => url.pathname === '/api/pairs' ? [{ ...pair, id: 'galagamesidr', symbol: 'GALAIDR', ticker_id: 'galagames_idr', traded_currency: 'galagames' }] : body);
    expect((await new IndodaxPublicClient(fetcher, () => NOW).pairs())[0]).toMatchObject({ symbol: 'GALAIDR', asset: 'GALAGAMES', tickerId: 'galagames_idr', quote: 'IDR' });
    const invalid = fixture((url, body) => url.pathname === '/api/pairs' ? [{ ...pair, id: 'ethidr' }] : body);
    await expect(new IndodaxPublicClient(invalid, () => NOW).pairs()).rejects.toThrow('inconsistent pair');
  });
  it('expands actual public API scientific increments without rounding', async () => {
    expect(indodaxDecimal(1e-8)).toBe('0.00000001');
    expect(indodaxDecimal('1.234567890123456789e-8')).toBe('0.00000001234567890123456789');
    expect(indodaxDecimal('12.34e3')).toBe('12340');
    expect(() => indodaxDecimal('1e10000000')).toThrow();
    const fetcher = fixture((url, body) => url.pathname === '/api/pairs' ? [{ ...pair, quantity_increment: 1e-8 }] : body);
    expect((await new IndodaxPublicClient(fetcher, () => NOW).pairs())[0].quantityIncrement).toBe('0.00000001');
  });
  it('canonicalizes complete pairs without implicitly converting currencies', () => {
    expect(indodaxSymbol('btc_idr')).toBe('BTCIDR');
    expect(indodaxSymbol('eth/usdt')).toBe('ETHUSDT');
    for (const invalid of ['BTC', 'BTCUSD', 'BTC?IDR', 'https://example.test/BTCIDR']) expect(() => indodaxSymbol(invalid)).toThrow();
  });

  it('keeps IDR units and precision, excludes forming candles, and uses only public GETs', async () => {
    const fetcher = fixture();
    const market = await new IndodaxPublicClient(fetcher, () => NOW).market('btc_idr');
    expect(market.pair).toMatchObject({ symbol: 'BTCIDR', asset: 'BTC', quote: 'IDR', minQuote: '10000', maintenance: false });
    expect(market.last).toBe('1500000000.12345678');
    expect(market.candles).toHaveLength(70);
    expect(market.candles.at(-1)?.time).toBe(NOW / 1000 - 14_400);
    expect(market).toMatchObject({ venue: 'indodax', marketType: 'spot', access: 'public-read-only', example: false, executionSupported: false });
    for (const [input, init] of fetcher.mock.calls) {
      expect(['indodax.com', 'api.indodax.com']).toContain(new URL(String(input)).host);
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({ accept: 'application/json' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    const request = fetcher.mock.calls.map(c => new URL(String(c[0]))).find(u => u.pathname.endsWith('history_v2'))!;
    expect(request.searchParams.get('tf')).toBe('240');
    expect(request.searchParams.get('symbol')).toBe('BTCIDR');
  });

  it('supports daily candles, and computes indicators with this project strategy utilities', async () => {
    const client = new IndodaxPublicClient(fixture(), () => NOW);
    const market = await analyzeIndodax(client, 'BTCIDR', '1d');
    expect(market.timeframe).toBe('1d');
    expect(market.indicators.ema20).toBeGreaterThan(0);
    expect(market.indicators.rsi14).toBeGreaterThanOrEqual(0);
    expect(market.indicators.rsi14).toBeLessThanOrEqual(100);
    expect(market.sources.candles).toContain('tf=1D');
  });

  it('coalesces concurrent reads and caches bounded public requests', async () => {
    const fetcher = fixture();
    const client = new IndodaxPublicClient(fetcher, () => NOW);
    await Promise.all([client.market('BTCIDR'), client.market('BTCIDR')]);
    await client.market('BTCIDR');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('preserves observation timestamps when returning cached data', async () => {
    let now = NOW;
    const client = new IndodaxPublicClient(fixture(), () => now);
    await client.market('BTCIDR');
    now += 5000;
    expect((await client.market('BTCIDR')).observedAt).toBe(NOW);
  });

  it('supports listed USDT pairs without converting IDR or changing the quote', async () => {
    const fetcher = fixture((url, body) => url.pathname === '/api/pairs'
      ? [{ ...pair, symbol: 'BTCUSDT', ticker_id: 'btc_usdt', base_currency: 'usdt' }]
      : !Array.isArray(body) ? { ...body, symbol: 'BTCUSDT' } : body);
    expect((await new IndodaxPublicClient(fetcher, () => NOW).market('btc_usdt')).pair.quote).toBe('USDT');
  });

  it('bounds requests per public host even during repeated upstream failures', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 503 }));
    const client = new IndodaxPublicClient(fetcher, () => NOW);
    for (let n = 0; n < 160; n++) await expect(client.pairs()).rejects.toThrow('HTTP 503');
    await expect(client.pairs()).rejects.toThrow('budget');
    expect(fetcher).toHaveBeenCalledTimes(160);
  });

  it.each(['is_maintenance', 'is_market_suspended'])('blocks %s without requesting prices', async field => {
    const fetcher = fixture((url, body) => url.pathname === '/api/pairs' ? [{ ...pair, [field]: '1' }] : body);
    await expect(new IndodaxPublicClient(fetcher, () => NOW).market('BTCIDR')).rejects.toThrow(/maintenance|suspended/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown pairs and unsupported timeframes without mapping to another venue', async () => {
    const fetcher = fixture();
    const client = new IndodaxPublicClient(fetcher, () => NOW);
    await expect(client.market('ETHIDR')).rejects.toThrow('not listed');
    await expect(client.market('BTCIDR', '5m' as any)).rejects.toThrow('timeframes');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong symbol', (url: URL, body: any) => url.pathname.endsWith('/price') ? { ...body, symbol: 'ETHIDR' } : body],
    ['missing price', (url: URL, body: any) => url.pathname.endsWith('/price') ? { symbol: 'BTCIDR' } : body],
    ['negative price', (url: URL, body: any) => url.pathname.endsWith('/price') ? { ...body, price: '-1' } : body],
    ['crossed book', (url: URL, body: any) => url.pathname.endsWith('/bookTicker') ? { ...body, bidPrice: '2000000000' } : body],
    ['malformed candles', (url: URL, body: any) => url.pathname.endsWith('history_v2') ? { status: 'ok' } : body],
    ['insufficient candles', (url: URL, body: any) => url.pathname.endsWith('history_v2') ? body.slice(0, 5) : body],
    ['stale candles', (url: URL, body: any) => url.pathname.endsWith('history_v2') ? body.slice(0, 60) : body],
    ['duplicate candles', (url: URL, body: any) => url.pathname.endsWith('history_v2') ? [...body, body[0]] : body],
    ['bad timestamp', (url: URL, body: any) => url.pathname.endsWith('history_v2') ? [{ ...body[0], Time: 'oops' }, ...body.slice(1)] : body],
    ['bad OHLC', (url: URL, body: any) => url.pathname.endsWith('history_v2') ? [{ ...body[0], High: '1' }, ...body.slice(1)] : body],
    ['invalid flag', (url: URL, body: any) => url.pathname === '/api/pairs' ? [{ ...pair, is_maintenance: 'unknown' }] : body],
    ['wrong pair units', (url: URL, body: any) => url.pathname === '/api/pairs' ? [{ ...pair, traded_currency: 'eth' }] : body]
  ])('fails closed on %s', async (_label, transform) => {
    await expect(new IndodaxPublicClient(fixture(transform), () => NOW).market('BTCIDR')).rejects.toThrow();
  });

  it.each([-1021, -1003, -2010])('rejects API error %s without treating it as market data', async code => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code, msg: 'upstream error' })));
    await expect(new IndodaxPublicClient(fetcher).pairs()).rejects.toThrow('rejected');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 500, 503])('reports HTTP %s without retrying or exposing response text', async status => {
    const fetcher = vi.fn(async () => new Response('sensitive upstream text', { status }));
    await expect(new IndodaxPublicClient(fetcher).pairs()).rejects.toThrow(`HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('honors a cooldown after 429 and never retries automatically', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 429 }));
    const client = new IndodaxPublicClient(fetcher, () => NOW);
    await expect(client.pairs()).rejects.toThrow('rate limit');
    await expect(client.pairs()).rejects.toThrow('rate limit');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sanitizes transport and JSON errors', async () => {
    for (const fetcher of [vi.fn(async () => { throw new Error('private transport detail'); }), vi.fn(async () => new Response('not JSON'))]) {
      await expect(new IndodaxPublicClient(fetcher).pairs()).rejects.toThrow('unavailable or timed out');
    }
  });
});

describe('Indodax API', () => {
  let server: Server | undefined;
  afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve())); server = undefined; } });
  async function start(client = new IndodaxPublicClient(fixture(), () => NOW)) {
    const app = express();
    mountIndodaxRoutes(app, client);
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  it('serves typed public analysis from local requests', async () => {
    const base = await start();
    const response = await fetch(`${base}/api/indodax/market?symbol=btc_idr&tf=4h`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ ok: true, data: { pair: { quote: 'IDR' }, executionSupported: false } });
    expect((await fetch(`${base}/api/indodax/pairs`)).status).toBe(200);
  });
  it('rejects invalid parameters and external origins before calling Indodax', async () => {
    const fetcher = fixture();
    const base = await start(new IndodaxPublicClient(fetcher, () => NOW));
    for (const query of ['symbol=BTCIDR&tf=5m', 'symbol=BTCIDR&url=https://example.test', 'symbol=BTCIDR&symbol=ETHIDR', '']) {
      expect((await fetch(`${base}/api/indodax/market?${query}`)).status).toBe(400);
    }
    expect((await fetch(`${base}/api/indodax/pairs?url=bad`)).status).toBe(400);
    expect((await fetch(`${base}/api/indodax/pairs`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('has no order endpoint or mutation path', async () => {
    const base = await start();
    expect((await fetch(`${base}/api/indodax/order`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/api/indodax/market`, { method: 'POST' })).status).toBe(404);
  });
  it('returns 503 on upstream failure without sample or another exchange fallback', async () => {
    const base = await start(new IndodaxPublicClient(vi.fn(async () => new Response('', { status: 503 }))));
    const response = await fetch(`${base}/api/indodax/market?symbol=BTCIDR`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, executionSupported: false });
  });
});
