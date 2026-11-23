import type { IndodaxCandle, IndodaxMarket, IndodaxPair, IndodaxTimeframe } from '../../shared/indodax.js';

const PUBLIC = 'https://indodax.com';
const V2 = 'https://api.indodax.com';
const PERIOD = { '4h': { api: '240', seconds: 14_400 }, '1d': { api: '1D', seconds: 86_400 } } as const;
type Row = Record<string, unknown>;

export class IndodaxDataError extends Error {
  constructor(message: string, public readonly kind: 'input' | 'unavailable' = 'unavailable') {
    super(message);
    this.name = 'IndodaxDataError';
  }
}

export function indodaxSymbol(input: string): string {
  const symbol = input.trim().toUpperCase().replace(/[_/\-]/g, '');
  if (!/^[A-Z0-9]{1,20}(?:IDR|USDT)$/.test(symbol)) {
    throw new IndodaxDataError('Use a complete Indodax pair, for example BTCIDR or BTCUSDT.', 'input');
  }
  return symbol;
}

function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IndodaxDataError('Indodax returned a malformed object.');
  return value as Row;
}

export function indodaxDecimal(value: unknown, zero = false): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new IndodaxDataError('Indodax returned a missing or malformed decimal.');
  }
  const text = String(value), match = text.match(/^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match || text.length > 200 || Math.abs(Number(match[3] ?? 0)) > 100) throw new IndodaxDataError('Indodax returned a missing or malformed decimal.');
  let normalized = text;
  if (match[3] !== undefined) {
    // /api/pairs sends numeric increments such as 1e-8. Expand digits, without float arithmetic.
    const digits = match[1] + (match[2] ?? ''), point = match[1].length + Number(match[3]);
    normalized = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
    normalized = normalized.replace(/^0+(?=\d)/, '');
  }
  const number = Number(normalized);
  if (!Number.isFinite(number) || (zero ? number < 0 : number <= 0)) throw new IndodaxDataError('Indodax returned an invalid market value.');
  return normalized;
}
const decimal = indodaxDecimal;

function flag(value: unknown): boolean {
  if (value === undefined || value === false || value === 0 || value === '0') return false;
  if (value === true || value === 1 || value === '1') return true;
  throw new IndodaxDataError('Indodax returned an invalid market status.');
}

function pairOf(value: unknown): IndodaxPair | null {
  const p = row(value);
  // Indodax calls the quote currency base_currency (opposite to common exchange terminology).
  const quote = String(p.base_currency ?? '').toUpperCase();
  if (quote !== 'IDR' && quote !== 'USDT') return null;
  const asset = String(p.traded_currency ?? '').toUpperCase();
  const symbol = indodaxSymbol(String(p.symbol ?? p.id ?? p.ticker_id ?? ''));
  // Display/V2 symbols can differ from legacy currency IDs (e.g. GALA / galagames).
  // Validate the legacy identity independently rather than guessing aliases.
  if (!/^[A-Z0-9]{1,20}$/.test(asset) || !symbol.endsWith(quote) || typeof p.ticker_id !== 'string' || p.ticker_id.toUpperCase() !== `${asset}_${quote}` || (p.id !== undefined && String(p.id).toUpperCase() !== `${asset}${quote}`)) {
    throw new IndodaxDataError('Indodax returned inconsistent pair metadata.');
  }
  const optional = (key: string) => p[key] === undefined || p[key] === null ? null : decimal(p[key], true);
  // Fees are advisory. A bad fee field must not hide the whole pair list.
  const fee = (key: string) => { try { return optional(key); } catch { return null; } };
  return {
    feeTakerPct: fee('trade_fee_percent_taker'), feeMakerPct: fee('trade_fee_percent_maker'),
    symbol, tickerId: p.ticker_id, asset, quote,
    maintenance: flag(p.is_maintenance), suspended: flag(p.is_market_suspended),
    quantityIncrement: optional('quantity_increment'), minQuote: optional('trade_min_base_currency'), minQuantity: optional('trade_min_traded_currency')
  };
}

/** Allowlisted public GETs only. No credentials, signed requests, or order methods. */
export class IndodaxPublicClient {
  private cache = new Map<string, { until: number; observedAt: number; value: unknown }>();
  private pending = new Map<string, Promise<unknown>>();
  private requestTimes = new Map<string, number[]>();
  private cooldownUntil = 0;

  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  private async get(url: string, ttlMs: number): Promise<unknown> {
    const cached = this.cache.get(url);
    if (cached && cached.until > this.now()) return cached.value;
    if (this.cooldownUntil > this.now()) throw new IndodaxDataError('Indodax rate limit; wait before trying again.');
    const existing = this.pending.get(url);
    if (existing) return existing;
    const host = new URL(url).host;
    const times = (this.requestTimes.get(host) ?? []).filter(at => at > this.now() - 60_000);
    if (times.length >= (host === 'indodax.com' ? 160 : 280)) throw new IndodaxDataError('Indodax public request budget reached; wait before trying again.');
    times.push(this.now());
    this.requestTimes.set(host, times);
    const request = (async () => {
      try {
        const response = await this.fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(8000), redirect: 'error', headers: { accept: 'application/json' } });
        if (response.status === 429) {
          this.cooldownUntil = this.now() + 60_000;
          throw new IndodaxDataError('Indodax rate limit; wait before trying again.');
        }
        if (!response.ok) throw new IndodaxDataError(`Indodax public data unavailable (HTTP ${response.status}).`);
        const value: unknown = await response.json();
        if (value && !Array.isArray(value) && typeof value === 'object' && ('error' in value || ('code' in value && Number(value.code) < 0))) {
          throw new IndodaxDataError('Indodax rejected the public data request.');
        }
        // Bound the cache even when callers browse many symbols.
        if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(url, { value, observedAt: this.now(), until: this.now() + ttlMs });
        return value;
      } catch (error) {
        if (error instanceof IndodaxDataError) throw error;
        // Never expose upstream bodies, transport errors, or configuration in API responses.
        throw new IndodaxDataError('Indodax public data unavailable or timed out.');
      }
    })();
    this.pending.set(url, request);
    try { return await request; } finally { this.pending.delete(url); }
  }

  async pairs(): Promise<IndodaxPair[]> {
    const raw = await this.get(`${PUBLIC}/api/pairs`, 60_000);
    if (!Array.isArray(raw)) throw new IndodaxDataError('Indodax returned a malformed pair list.');
    const pairs = raw.map(pairOf).filter((p): p is IndodaxPair => p !== null);
    if (!pairs.length || new Set(pairs.map(p => p.symbol)).size !== pairs.length) throw new IndodaxDataError('Indodax returned an empty or ambiguous pair list.');
    return pairs.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  async market(input: string, tf: IndodaxTimeframe = '4h'): Promise<IndodaxMarket> {
    const symbol = indodaxSymbol(input);
    if (!Object.hasOwn(PERIOD, tf)) throw new IndodaxDataError('Supported Indodax timeframes: 4h, 1d.', 'input');
    const pair = (await this.pairs()).find(p => p.symbol === symbol);
    if (!pair) throw new IndodaxDataError('Pair is not listed in Indodax public metadata.', 'input');
    if (pair.maintenance || pair.suspended) throw new IndodaxDataError('Indodax reports this pair in maintenance or suspended.');
    const { api, seconds } = PERIOD[tf];
    // Stable windows allow request coalescing and caching without retaining a forming candle.
    const to = Math.floor(this.now() / 1000 / seconds) * seconds;
    const query = new URLSearchParams({ from: String(to - seconds * 201), to: String(to), symbol, tf: api });
    const tickerUrl = `${V2}/api/v2/ticker/price?symbol=${symbol}`;
    const bookUrl = `${V2}/api/v2/ticker/bookTicker?symbol=${symbol}`;
    const candleUrl = `${PUBLIC}/tradingview/history_v2?${query}`;
    const [tickerRaw, bookRaw, candleRaw] = await Promise.all([
      this.get(tickerUrl, 10_000), this.get(bookUrl, 10_000), this.get(candleUrl, 60_000)
    ]);
    const single = (raw: unknown) => {
      const rows = Array.isArray(raw) ? raw : [raw];
      const matches = rows.map(row).filter(r => typeof r.symbol === 'string' && indodaxSymbol(r.symbol) === symbol);
      if (matches.length !== 1) throw new IndodaxDataError('Indodax returned a mismatched or ambiguous ticker symbol.');
      return matches[0];
    };
    const ticker = single(tickerRaw), book = single(bookRaw);
    const last = decimal(ticker.price), bid = decimal(book.bidPrice), ask = decimal(book.askPrice);
    if (Number(bid) > Number(ask)) throw new IndodaxDataError('Indodax returned a crossed order book.');
    if (!Array.isArray(candleRaw)) throw new IndodaxDataError('Indodax returned malformed candles.');
    const seen = new Set<number>();
    const candles: IndodaxCandle[] = [];
    for (const raw of candleRaw) {
      const c = row(raw);
      const time = Number(c.Time);
      if (!Number.isSafeInteger(time) || time <= 0 || time > this.now() / 1000) throw new IndodaxDataError('Indodax returned an invalid candle timestamp.');
      const bar = { time, open: decimal(c.Open), high: decimal(c.High), low: decimal(c.Low), close: decimal(c.Close), volume: decimal(c.Volume, true) };
      if (Number(bar.high) < Math.max(Number(bar.open), Number(bar.close), Number(bar.low)) || Number(bar.low) > Math.min(Number(bar.open), Number(bar.close))) {
        throw new IndodaxDataError('Indodax returned inconsistent OHLC values.');
      }
      if (seen.has(time)) throw new IndodaxDataError('Indodax returned duplicate candle timestamps.');
      seen.add(time);
      if (time + seconds <= this.now() / 1000 && time >= to - seconds * 201) candles.push(bar);
    }
    candles.sort((a, b) => a.time - b.time);
    if (candles.length < 20) throw new IndodaxDataError('Insufficient completed Indodax candles for analysis.');
    if (candles.at(-1)!.time + seconds < to) throw new IndodaxDataError('Indodax candle data is stale.');
    return {
      venue: 'indodax', marketType: 'spot', access: 'public-read-only', executionSupported: false, example: false,
      pair, timeframe: tf, last, bid, ask,
      observedAt: Math.min(...[tickerUrl, bookUrl, candleUrl].map(url => this.cache.get(url)?.observedAt ?? this.now())),
      candles: candles.slice(-200),
      sources: { ticker: tickerUrl, book: bookUrl, candles: candleUrl, pairs: `${PUBLIC}/api/pairs` }
    };
  }
}
