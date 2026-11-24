import { describe, expect, it, vi } from 'vitest';
import { IndodaxPublicClient } from '../server/market/indodax.js';
import { buildIndodaxContext, indodaxPromptSummary } from '../server/market/indodax-context.js';
import { resolveIndodaxSymbol } from '../server/market/indodax-symbol.js';
import { IndodaxContextSchema, INDODAX_PAPER_CONSTRAINTS, indodaxConstraints } from '../shared/indodax-context.js';
import { IndodaxVerdictSchema } from '../shared/indodax-verdict.js';

const NOW = Date.UTC(2026, 10, 20, 12);
const base = { quantity_increment: '0.00000001', trade_min_base_currency: '10000', trade_min_traded_currency: '0.00001', is_maintenance: '0', is_market_suspended: 0 };
const pairs = [
  { ...base, symbol: 'BTCIDR', ticker_id: 'btc_idr', base_currency: 'idr', traded_currency: 'btc', trade_fee_percent_taker: '0.3' },
  { ...base, symbol: 'BTCUSDT', ticker_id: 'btc_usdt', base_currency: 'usdt', traded_currency: 'btc' },
  { ...base, symbol: 'ETHIDR', ticker_id: 'eth_idr', base_currency: 'idr', traded_currency: 'eth', is_maintenance: '1' }
];
const bars = (seconds: number) => Array.from({ length: 71 }, (_, i) => ({
  Time: NOW / 1000 - (70 - i) * seconds, Open: '1500', High: '1600', Low: '1490', Close: String(1500 + i), Volume: '12.5'
}));

function client() {
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase();
    let body: unknown;
    if (url.pathname === '/api/pairs') body = pairs;
    else if (url.pathname === '/api/v2/ticker/price') body = { symbol, price: '1500.5' };
    else if (url.pathname === '/api/v2/ticker/bookTicker') body = { symbol, bidPrice: '1499', askPrice: '1501', bidQty: '1', askQty: '1' };
    else if (url.pathname === '/tradingview/history_v2') body = bars(url.searchParams.get('tf') === '1D' ? 86_400 : 14_400);
    else throw new Error('Unexpected endpoint');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return new IndodaxPublicClient(fetcher, () => NOW);
}

const BANNED = /\b(bybit|perp|perpetual|funding|leverage|short|testnet|futures|margin|liquidation)\b/i;

describe('buildIndodaxContext', () => {
  it('builds one schema-valid context for an IDR pair', async () => {
    const context = await buildIndodaxContext(client(), 'btc_idr', '4h');
    expect(IndodaxContextSchema.safeParse(context).success).toBe(true);
    expect(context).toMatchObject({
      venue: 'Indodax', marketType: 'spot', symbol: 'BTCIDR', asset: 'BTC', quote: 'IDR', timeframe: '4h',
      bid: '1499', ask: '1501', fee: { takerPct: '0.3', makerPct: null },
      rules: { quantityIncrement: '0.00000001', minQuote: '10000', minQuantity: '0.00001' }
    });
    expect(context.advisory.takerFeePct).toBe('0.3');
    expect(context.advisory.minTakeProfit).toMatch(/^\d+(?:\.\d+)?$/);
    expect(context.candles.length).toBeLessThanOrEqual(40);
    expect(context.constraints).toBe(indodaxConstraints('IDR', '4h'));
  });

  it('keeps the quote currency of a USDT pair and uses the daily timeframe when asked', async () => {
    const context = await buildIndodaxContext(client(), 'BTCUSDT', '1d');
    expect(context).toMatchObject({ symbol: 'BTCUSDT', quote: 'USDT', timeframe: '1d', fee: { takerPct: null } });
    expect(context.advisory.minTakeProfit).toBeNull();
    expect(context.constraints).toContain('USDT');
    expect(context.constraints).toContain('1d');
  });

  it('rejects an unlisted pair before building anything', async () => {
    await expect(buildIndodaxContext(client(), 'FOOIDR', '4h')).rejects.toThrow(/Indodax/);
  });

  it('maps the context to the flat prompt summary the agent runner receives', async () => {
    const summary = indodaxPromptSummary(await buildIndodaxContext(client(), 'BTCIDR', '4h'));
    expect(summary).toMatchObject({ venue: 'Indodax', marketType: 'spot', quoteCurrency: 'IDR', symbol: 'BTCIDR', timeframe: '4h' });
    expect(Object.keys(summary)).not.toContain('pair');
  });
});

describe('IndodaxContextSchema', () => {
  const valid = async () => structuredClone(await buildIndodaxContext(client(), 'BTCIDR', '4h')) as Record<string, any>;

  it('rejects a context without a bid', async () => {
    const context = await valid();
    delete context.bid;
    expect(IndodaxContextSchema.safeParse(context).success).toBe(false);
  });

  it('rejects a symbol whose quote disagrees with the declared quote', async () => {
    const context = await valid();
    context.quote = 'USDT';
    expect(IndodaxContextSchema.safeParse(context).success).toBe(false);
  });

  it('rejects a crossed book, unsorted candles and a candle that has not closed', async () => {
    const crossed = await valid();
    crossed.bid = '1600';
    expect(IndodaxContextSchema.safeParse(crossed).success).toBe(false);

    const unsorted = await valid();
    unsorted.candles.reverse();
    expect(IndodaxContextSchema.safeParse(unsorted).success).toBe(false);

    const forming = await valid();
    forming.candles.push({ ...forming.candles.at(-1), time: forming.observedAt / 1000 - 60 });
    expect(IndodaxContextSchema.safeParse(forming).success).toBe(false);
  });

  it('rejects extra fields so venue data cannot slip in', async () => {
    const context = await valid();
    context.leverage = 5;
    expect(IndodaxContextSchema.safeParse(context).success).toBe(false);
  });
});

describe('IndodaxVerdictSchema', () => {
  const entry = { action: 'OPEN_LONG', symbol: 'BTCIDR', thesis: { stop: '1400', tp: '1700', orderType: 'MARKET' }, rejectionReason: null };

  it('accepts the three spot actions', () => {
    expect(IndodaxVerdictSchema.safeParse(entry).success).toBe(true);
    expect(IndodaxVerdictSchema.safeParse({ action: 'HOLD', symbol: 'BTCIDR', thesis: null, rejectionReason: null }).success).toBe(true);
    expect(IndodaxVerdictSchema.safeParse({ action: 'CLOSE', symbol: 'BTCIDR', thesis: null, rejectionReason: null }).success).toBe(true);
  });

  it('rejects a second side, leverage and resting limit orders at parse time', () => {
    expect(IndodaxVerdictSchema.safeParse({ ...entry, action: 'OPEN_SHORT' }).success).toBe(false);
    expect(IndodaxVerdictSchema.safeParse({ ...entry, leverage: 3 }).success).toBe(false);
    expect(IndodaxVerdictSchema.safeParse({ ...entry, thesis: { ...entry.thesis, leverage: 3 } }).success).toBe(false);
    expect(IndodaxVerdictSchema.safeParse({ ...entry, thesis: { ...entry.thesis, orderType: 'LIMIT_GTC' } }).success).toBe(false);
  });

  it('requires a thesis for entries only and a take profit above the stop', () => {
    expect(IndodaxVerdictSchema.safeParse({ ...entry, thesis: null }).success).toBe(false);
    expect(IndodaxVerdictSchema.safeParse({ action: 'HOLD', symbol: 'BTCIDR', thesis: entry.thesis, rejectionReason: null }).success).toBe(false);
    expect(IndodaxVerdictSchema.safeParse({ ...entry, thesis: { ...entry.thesis, tp: '1300' } }).success).toBe(false);
  });
});

describe('resolveIndodaxSymbol', () => {
  it('resolves spellings of the same pair to the listed pair', async () => {
    for (const input of ['BTCIDR', 'btc_idr', 'BTC/IDR']) expect((await resolveIndodaxSymbol(client(), input)).symbol).toBe('BTCIDR');
  });

  it('knows BTCUSDT as an Indodax USDT pair', async () => {
    expect(await resolveIndodaxSymbol(client(), 'BTCUSDT')).toMatchObject({ symbol: 'BTCUSDT', quote: 'USDT' });
  });

  it('rejects a pair that is not listed and names Indodax', async () => {
    await expect(resolveIndodaxSymbol(client(), 'FOOIDR')).rejects.toThrow(/not a pair listed on Indodax/);
  });

  it('rejects an incomplete symbol and a pair in maintenance', async () => {
    await expect(resolveIndodaxSymbol(client(), 'BTC')).rejects.toThrow(/Indodax pair/);
    await expect(resolveIndodaxSymbol(client(), 'ETHIDR')).rejects.toThrow(/maintenance or suspended/);
  });
});

describe('Indodax constraint text', () => {
  it('names no instrument, venue or order type that Indodax spot lacks', () => {
    for (const quote of ['IDR', 'USDT'] as const) {
      for (const timeframe of ['4h', '1d'] as const) expect(indodaxConstraints(quote, timeframe)).not.toMatch(BANNED);
    }
    expect(INDODAX_PAPER_CONSTRAINTS).not.toMatch(BANNED);
  });

  it('states the quote currency and the allowed actions', () => {
    const text = indodaxConstraints('IDR', '4h');
    expect(text).toContain('Indodax spot');
    expect(text).toContain('IDR');
    expect(text).toMatch(/LONG.*HOLD.*CLOSE/);
  });
});
