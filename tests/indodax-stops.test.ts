import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStore } from '../server/v2/store/database.js';
import { IndodaxStopService, readIndodaxStops } from '../server/v2/execution/indodax-stops.js';
import { IndodaxStopClient, IndodaxStopError, type IndodaxStopExchange, type StopOrder } from '../server/v2/execution/indodax-client.js';
import { deriveClientOrderId } from '../server/v2/execution/gateway.js';
import { safe } from '../server/redact.js';

const NOW = Date.UTC(2026, 10, 20, 12);
const dirs: string[] = [];
const stores: RuntimeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
      // Windows native SQLite handles may trail close; safety assertions already completed.
    }
  }
});
async function database(file?: string) {
  if (!file) { const dir = mkdtempSync(path.join(os.tmpdir(), 'mpu-indodax-sl-')); dirs.push(dir); file = path.join(dir, 'stops.sqlite'); }
  const store = await RuntimeStore.open(file); stores.push(store); return store;
}
const pair = { symbol: 'BTCIDR', tickerId: 'btc_idr', asset: 'BTC', quote: 'IDR' as const, maintenance: false, suspended: false, quantityIncrement: '0.1', minQuote: '1', minQuantity: '0.1' };
function fakeExchange() {
  const state = { price: '100', observedAt: NOW, identity: 'test-account', free: '10' };
  const exchange = {
    account: vi.fn(async () => ({ identity: state.identity, free: { BTC: state.free } })),
    pair: vi.fn(async () => pair),
    quote: vi.fn(async () => ({ last: state.price, observedAt: state.observedAt })),
    sell: vi.fn(async (_symbol: string, _quantity: string, id: string): Promise<StopOrder> => ({ clientOrderId: id, venueOrderId: 'test-123', state: 'ACCEPTED', filledQty: null })),
    lookup: vi.fn(async (_symbol: string, id: string): Promise<StopOrder> => ({ clientOrderId: id, venueOrderId: 'test-123', state: 'ACCEPTED', filledQty: '0' }))
  } satisfies IndodaxStopExchange;
  return { exchange, state };
}
async function fixture(mode: 'PAPER' | 'LIVE' = 'LIVE') {
  const store = await database(), fake = fakeExchange();
  let killed = false;
  const service = await IndodaxStopService.open({ store, exchange: fake.exchange, mode, liveAcknowledged: true, now: () => NOW, isKilled: () => killed });
  return { store, service, ...fake, kill: (value: boolean) => { killed = value; } };
}
const arm = (service: IndodaxStopService, overrides = {}) => service.arm({ symbol: 'BTCIDR', quantity: '1', entry: '100', stop: '90', ...overrides });

describe('persistent Indodax bot SL, reusing the existing close gateway', () => {
  it('defaults to PAPER and never sends a private account read or live sell', async () => {
    const store = await database(), { exchange, state } = fakeExchange();
    const service = await IndodaxStopService.open({ store, exchange, now: () => NOW });
    await arm(service); state.price = '90'; await service.tick();
    expect(exchange.account).not.toHaveBeenCalled(); expect(exchange.sell).not.toHaveBeenCalled();
    expect((await service.list())[0]).toMatchObject({ mode: 'PAPER', status: 'CLOSED', quantity: '0', protection: 'BOT_MANAGED' });
  });
  it('requires LIVE acknowledgment before even reading the private account', async () => {
    const store = await database(), { exchange } = fakeExchange();
    await expect(IndodaxStopService.open({ store, exchange, mode: 'LIVE' })).rejects.toThrow('confirmation');
    expect(exchange.account).not.toHaveBeenCalled();
  });
  it('persists decimal SL, never claims exchange verification, and waits above the trigger', async () => {
    const { service, store, exchange } = await fixture(); await arm(service); await service.tick();
    const position = (await store.execute('SELECT stop_price, qty, protection_state FROM managed_positions')).rows[0];
    expect(position).toMatchObject({ stop_price: '90', qty: '1', protection_state: 'BOT_MANAGED' });
    expect((await service.list())[0].status).toBe('ARMED'); expect(exchange.sell).not.toHaveBeenCalled();
  });
  it('journals the trigger and gateway intent durably before the single SELL', async () => {
    const { service, store, state, exchange } = await fixture(); await arm(service); state.price = '89';
    exchange.sell.mockImplementationOnce(async (_symbol, quantity, id) => {
      expect(quantity).toBe('1');
      expect((await store.execute('SELECT order_state FROM execution_intents')).rows[0].order_state).toBe('SUBMITTING');
      expect((await store.execute('SELECT status FROM indodax_bot_stops')).rows[0].status).toBe('TRIGGERED');
      expect((await store.execute("SELECT kind FROM events WHERE kind='indodax.stop.triggered'")).rows).toHaveLength(1);
      return { clientOrderId: id, venueOrderId: 'test-123', state: 'ACCEPTED', filledQty: null };
    });
    await service.tick(); await service.tick();
    expect(exchange.sell).toHaveBeenCalledTimes(1); expect(exchange.lookup).toHaveBeenCalledTimes(1);
    expect((await service.list())[0]).toMatchObject({ status: 'WORKING', quantity: '1' });
    expect((await store.execute('SELECT venue_order_id FROM execution_intents')).rows[0].venue_order_id).toBe('test-123');
  });
  it('recovers ARMED references after reopening SQLite and triggers at equality', async () => {
    const { service, store, exchange, state } = await fixture(); await arm(service);
    const file = store.filePath; await store.close();
    const reopened = await database(file);
    const resumed = await IndodaxStopService.open({ store: reopened, exchange, mode: 'LIVE', liveAcknowledged: true, now: () => NOW });
    state.price = '90'; await resumed.tick(); expect(exchange.sell).toHaveBeenCalledTimes(1);
  });
  it('reconciles a timed out sell after restart without resending or allowing rearm/disarm', async () => {
    const { service, store, exchange, state } = await fixture(); await arm(service); state.price = '89';
    exchange.sell.mockRejectedValueOnce(new IndodaxStopError('Sell timed out.'));
    await service.tick(); expect((await service.list())[0].status).toBe('UNKNOWN');
    await expect(arm(service)).rejects.toThrow('unresolved');
    await expect(service.disarm('BTCIDR')).rejects.toThrow('unresolved');
    const resumed = await IndodaxStopService.open({ store, exchange, mode: 'LIVE', liveAcknowledged: true, now: () => NOW });
    exchange.lookup.mockImplementationOnce(async (_symbol, id) => ({ clientOrderId: id, venueOrderId: 'test-123', state: 'FILLED', filledQty: '1' }));
    await resumed.tick();
    expect(exchange.sell).toHaveBeenCalledTimes(1);
    expect((await resumed.list())[0]).toMatchObject({ status: 'CLOSED', quantity: '0' });
  });
  it('credits partial fills exactly once and closes only after full native confirmation', async () => {
    const { service, exchange, state } = await fixture(); await arm(service); state.price = '89'; await service.tick();
    const response = (qty: string, state: StopOrder['state']) => async (_symbol: string, id: string): Promise<StopOrder> => ({ clientOrderId: id, venueOrderId: 'test-123', state, filledQty: qty });
    exchange.lookup.mockImplementation(response('0.4', 'PARTIAL'));
    await service.tick(); expect((await service.list())[0].quantity).toBe('0.6');
    await service.tick(); expect((await service.list())[0].quantity).toBe('0.6');
    exchange.lookup.mockImplementation(response('1', 'FILLED'));
    await service.tick(); expect((await service.list())[0]).toMatchObject({ quantity: '0', status: 'CLOSED' });
    expect(exchange.sell).toHaveBeenCalledTimes(1);
  });
  it('retains a latched trigger when price recovers, and does not resubmit while working', async () => {
    const { service, exchange, state } = await fixture(); await arm(service); state.price = '89'; await service.tick();
    state.price = '120'; await service.tick(); expect(exchange.lookup).toHaveBeenCalledTimes(1); expect(exchange.sell).toHaveBeenCalledTimes(1);
  });
  it('keeps UNKNOWN on not-found or malformed lookup; no blind sell retry', async () => {
    const { service, exchange, state } = await fixture(); await arm(service); state.price = '89'; await service.tick();
    exchange.lookup.mockRejectedValue(new IndodaxStopError('Order not found or not yet visible.'));
    await service.tick(); await service.tick();
    expect((await service.list())[0].status).toBe('UNKNOWN'); expect(exchange.sell).toHaveBeenCalledTimes(1);
  });
  it('does not sell again after a crash between gateway journal and network write', async () => {
    const { service, store, exchange, state } = await fixture(); await arm(service); state.price = '89';
    const intent = 'crashed-before-send', at = new Date(NOW).toISOString();
    await store.execute("UPDATE indodax_bot_stops SET status='TRIGGERED', intent_id=?, attempt_qty='1'", [intent]);
    await store.execute(`INSERT INTO execution_intents (account_ref,intent_id,client_order_id,symbol,side,intent_kind,order_state,protection_state,payload_json,created_at,updated_at) VALUES (?,?,?,'BTCIDR','LONG','CLOSE','SUBMITTING','NOT_APPLICABLE','{}',?,?)`, [service.accountRef, intent, deriveClientOrderId(service.accountRef, intent), at, at]);
    exchange.lookup.mockRejectedValue(new IndodaxStopError('Order not visible.'));
    await service.tick(); expect(exchange.sell).not.toHaveBeenCalled(); expect((await service.list())[0].status).toBe('UNKNOWN');
  });
  it('resumes a durable trigger if no gateway intent has been journaled yet', async () => {
    const { service, store, exchange } = await fixture(); await arm(service);
    await store.execute("UPDATE indodax_bot_stops SET status='TRIGGERED', intent_id='trigger-before-crash', attempt_qty='1'");
    await service.tick(); expect(exchange.sell).toHaveBeenCalledTimes(1);
  });
  it('leaves the residual protected reference visible when a partial sell is cancelled', async () => {
    const { service, exchange, state } = await fixture(); await arm(service); state.price = '89'; await service.tick();
    exchange.lookup.mockImplementationOnce(async (_symbol, id) => ({ clientOrderId: id, venueOrderId: 'test-123', state: 'CANCELLED', filledQty: '0.4' }));
    await service.tick(); await service.tick();
    expect((await service.list())[0]).toMatchObject({ quantity: '0.6', status: 'ERROR' }); expect(exchange.sell).toHaveBeenCalledTimes(1);
    await arm(service, { quantity: '0.6' }); expect((await service.list())[0].status).toBe('ARMED');
  });
  it('recovers read-only quote outages while keeping the stored reference armed', async () => {
    const { service, exchange, state } = await fixture(); await arm(service);
    exchange.quote.mockRejectedValueOnce(new IndodaxStopError('Quote unavailable.'));
    await service.tick(); expect((await service.list())[0]).toMatchObject({ status: 'ARMED', lastError: 'Quote unavailable.' });
    state.price = '89'; await service.tick(); expect(exchange.sell).toHaveBeenCalledTimes(1);
  });
  it('blocks stale quotes, kill switches, balance drift and changed account identity', async () => {
    const { service, exchange, state, kill } = await fixture(); await arm(service); state.price = '89';
    kill(true); await service.tick(); expect(exchange.sell).not.toHaveBeenCalled();
    kill(false); state.observedAt = NOW - 6000; await service.tick(); expect(exchange.sell).not.toHaveBeenCalled();
    state.observedAt = NOW; state.free = '0.5'; await service.tick(); expect(exchange.sell).not.toHaveBeenCalled();
    expect((await service.list())[0].status).toBe('ERROR');
    state.free = '10';
    // A new stop with no ambiguous gateway intent is explicitly rearmed by the Owner.
    await expect(arm(service)).rejects.toThrow('unresolved');
  });
  it('refuses to sell holdings on a different account after a key change', async () => {
    const { service, exchange, state } = await fixture(); await arm(service); state.identity = 'other-account'; state.price = '89';
    await service.tick(); expect(exchange.sell).not.toHaveBeenCalled(); expect((await service.list())[0].status).toBe('ERROR');
  });
  it('fails closed on database writes and never rounds quantities up', async () => {
    const { service, store, exchange, state } = await fixture();
    await expect(arm(service, { quantity: '0.19' })).rejects.toThrow('increments');
    await arm(service); state.price = '89'; store.simulateWriteFailure('test readonly');
    await expect(service.tick()).rejects.toThrow('test readonly'); expect(exchange.sell).not.toHaveBeenCalled();
    store.simulateWriteFailure(null);
  });
  it('makes an older monitor lose execution authority', async () => {
    const { service, store, exchange, state } = await fixture(); await arm(service); await service.tick();
    const second = await IndodaxStopService.open({ store, exchange, mode: 'LIVE', liveAcknowledged: true, now: () => NOW });
    await second.tick(); state.price = '89';
    await expect(service.tick()).rejects.toThrow('authority was replaced');
    await second.tick(); expect(exchange.sell).toHaveBeenCalledTimes(1);
  });
  it('disarms without selling or pretending the wallet holding was closed', async () => {
    const { service, store, exchange, state } = await fixture(); await arm(service); await service.disarm('BTCIDR'); state.price = '1'; await service.tick();
    expect(exchange.sell).not.toHaveBeenCalled();
    expect((await store.execute('SELECT state, closed_at FROM managed_positions')).rows[0]).toMatchObject({ state: 'UNMANAGED', closed_at: null });
    expect((await readIndodaxStops(store))[0].status).toBe('DISARMED');
  });
});

describe('Indodax signed integration contract, mock fetch only', () => {
  // Locally invented test values; never copied from exchange examples or environment.
  const key = 'unit_indodax_key_only', secret = 'unit_indodax_secret_only';
  const account = { uid: 123, canTrade: true, canWithdraw: false, canWithdrawFiat: false, balances: [{ asset: 'BTC', free: '10', locked: '0' }] };
  function signedFixture(transform: (url: URL, body: any, init?: RequestInit) => any = (_url, body) => body) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      let body: any;
      if (url.pathname === '/api/server_time') body = { server_time: NOW };
      else if (url.pathname === '/api/v2/account') body = account;
      else if (url.pathname === '/api/pairs') body = [{ symbol: 'BTCIDR', ticker_id: 'btc_idr', base_currency: 'idr', traded_currency: 'btc', quantity_increment: '0.1', trade_min_base_currency: '1', trade_min_traded_currency: '0.1' }];
      else if (url.pathname === '/api/v2/ticker/price') body = { symbol: 'BTCIDR', price: '100' };
      else if (url.pathname === '/api/v2/order') {
        const clientOrderId = init?.method === 'POST' ? new URLSearchParams(String(init.body)).get('newClientOrderId') : url.searchParams.get('origClientOrderId');
        body = { symbol: 'BTCIDR', orderId: 1, clientOrderId, side: 'SELL', status: 'FILLED', origQty: '1', executedQty: '1' };
      } else throw new Error('Unexpected endpoint');
      const value = transform(url, body, init);
      return value instanceof Response ? value : new Response(JSON.stringify(value));
    });
  }
  const clientFor = (fetcher: typeof fetch, isKilled = () => false) => new IndodaxStopClient(() => ({ key, secret }), fetcher, () => NOW, isKilled);
  it('signs the transmitted query/body using v2 headers; accepted POST is not treated as filled', async () => {
    const fetcher = signedFixture(), client = clientFor(fetcher);
    expect((await client.account()).free.BTC).toBe('10');
    expect((await client.sell('BTCIDR', '1', 'test-stop-id')).state).toBe('ACCEPTED');
    expect((await client.lookup('BTCIDR', 'test-stop-id')).state).toBe('FILLED');
    for (const [input, init] of fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      if (!headers.has('X-APIKEY')) continue;
      const url = new URL(String(input)), signed = init?.method === 'POST' ? String(init.body) : url.search.slice(1);
      expect(headers.get('X-APIKEY')).toBe(key);
      expect(headers.get('Sign')).toBe(createHmac('sha256', secret).update(signed).digest('hex'));
      expect(new URLSearchParams(signed).get('recvWindow')).toBe('5000');
      if (init?.method === 'POST') {
        expect(url.search).toBe(''); expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
        expect(new URLSearchParams(signed).get('side')).toBe('SELL'); expect(new URLSearchParams(signed).get('type')).toBe('MARKET');
      }
    }
    expect(safe(`${key} ${secret}`)).not.toContain(secret);
  });
  it.each([{ canTrade: false }, { canWithdraw: true }, { canWithdrawFiat: true }, { canWithdrawFiat: undefined }, { canWithdraw: undefined }])('refuses unknown/unsafe permissions %j', async flags => {
    const fetcher = signedFixture((url, body) => url.pathname.endsWith('/account') ? { ...body, ...flags } : body);
    await expect(clientFor(fetcher).sell('BTCIDR', '1', 'test-stop-id')).rejects.toThrow('key refused');
    expect(fetcher.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(0);
  });
  it('refuses clock skew, kill, over-sized holdings and invalid increments before POST', async () => {
    const skewed = signedFixture((url, body) => url.pathname.endsWith('server_time') ? { server_time: NOW + 2000 } : body);
    await expect(clientFor(skewed).account()).rejects.toThrow('clock');
    const fetcher = signedFixture();
    await expect(clientFor(fetcher, () => true).sell('BTCIDR', '1', 'test-stop-id')).rejects.toThrow('Kill');
    await expect(clientFor(fetcher).sell('BTCIDR', '11', 'test-stop-id')).rejects.toThrow('available');
    await expect(clientFor(fetcher).sell('BTCIDR', '0.19', 'test-stop-id')).rejects.toThrow('increments');
    expect(fetcher.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(0);
  });
  it('does not retry a timed out POST and never exposes the transport error or credentials', async () => {
    const fetcher = signedFixture((_url, body, init) => { if (init?.method === 'POST') throw new Error(`${key} ${secret} private transport detail`); return body; });
    await expect(clientFor(fetcher).sell('BTCIDR', '1', 'test-stop-id')).rejects.toThrow('outcome may be unknown');
    expect(fetcher.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(1);
  });
  it.each([-1021, -1003, -2010])('fails closed on API error %s', async code => {
    const fetcher = signedFixture((url, body) => url.pathname.endsWith('/account') ? { code, msg: `${key} should not escape` } : body);
    await expect(clientFor(fetcher).account()).rejects.toThrow('rejected');
  });
  it.each([{ executedQty: '2' }, { executedQty: undefined }, { side: 'BUY' }, { symbol: 'ETHIDR' }, { clientOrderId: 'someone-else' }, { status: 'FILL' }])('refuses ambiguous lookup %j', async changes => {
    const fetcher = signedFixture((url, body) => url.pathname.endsWith('/order') ? { ...body, ...changes } : body);
    await expect(clientFor(fetcher).lookup('BTCIDR', 'test-stop-id')).rejects.toThrow();
  });
});
