import { createHmac } from 'node:crypto';
import { IndodaxPublicClient, indodaxDecimal, indodaxSymbol } from '../../market/indodax.js';
import { registerSecrets } from '../../redact.js';
import type { IndodaxPair } from '../../../shared/indodax.js';
import { DecimalStringSchema, type IntentState } from '../contracts.js';
import { compareDecimals, mulDecimals, quantize } from './decimal.js';

export class IndodaxStopError extends Error {
  constructor(message: string) { super(message); this.name = 'IndodaxStopError'; }
}
export interface StopAccount { identity: string; free: Record<string, string> }
export interface StopQuote { last: string; observedAt: number }
export interface StopOrder { clientOrderId: string; venueOrderId: string | null; state: IntentState; filledQty: string | null }
export interface IndodaxStopExchange {
  account(): Promise<StopAccount>;
  pair(symbol: string): Promise<IndodaxPair>;
  quote(symbol: string): Promise<StopQuote>;
  sell(symbol: string, quantity: string, clientOrderId: string): Promise<StopOrder>;
  lookup(symbol: string, clientOrderId: string): Promise<StopOrder>;
}
const API = 'https://api.indodax.com';
const PUBLIC = 'https://indodax.com';
const fail = (detail: string): never => { throw new IndodaxStopError(detail); };
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('Malformed Indodax response.');
}
export function stopDecimal(value: unknown, positive = false): string {
  if (typeof value !== 'string' && typeof value !== 'number') return fail('Missing Indodax decimal.');
  let normalized: string;
  try { normalized = indodaxDecimal(value, !positive); } catch { return fail('Invalid Indodax decimal.'); }
  const parsed = DecimalStringSchema.safeParse(normalized);
  if (!parsed.success || parsed.data.length > 80 || compareDecimals(parsed.data, '0') < (positive ? 1 : 0)) return fail('Invalid Indodax decimal.');
  return parsed.data;
}

/** Only account reads, order lookup, and spot MARKET SELL; no generic API or entry surface. */
export class IndodaxStopClient implements IndodaxStopExchange {
  private readonly publicClient: IndodaxPublicClient;
  private requestTimes: number[] = [];
  private cooldownUntil = 0;
  constructor(
    private readonly credentials: () => { key: string; secret: string } | Promise<{ key: string; secret: string }>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly isKilled: () => boolean = () => false
  ) { this.publicClient = new IndodaxPublicClient(fetchImpl, now); }

  private async request(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    this.requestTimes = this.requestTimes.filter(at => at > this.now() - 60_000);
    if (this.now() < this.cooldownUntil || this.requestTimes.length >= 150) return fail('Indodax stop worker rate limit; no order retry.');
    this.requestTimes.push(this.now());
    try {
      const response = await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (response.status === 429) this.cooldownUntil = this.now() + 60_000;
      if (!response.ok) return fail(`Indodax stop request failed (HTTP ${response.status}); reconcile before any new sell.`);
      const body = object(await response.json());
      if (body.error || Number(body.code) < 0) return fail('Indodax rejected the stop worker request; no automatic resubmission.');
      return body;
    } catch (error) {
      if (error instanceof IndodaxStopError) throw error;
      return fail('Indodax stop request unavailable or timed out; outcome may be unknown.');
    }
  }

  private async signed(method: 'GET' | 'POST', path: '/api/v2/account' | '/api/v2/order', params: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const clockStart = this.now();
    const clock = await this.request(`${PUBLIC}/api/server_time`, { method: 'GET' });
    const serverAt = Number(clock.server_time);
    const clockEnd = this.now();
    if (!Number.isSafeInteger(serverAt) || Math.abs(serverAt - (clockStart + clockEnd) / 2) > 900 || clockEnd - clockStart > 2000) return fail('Indodax clock check failed; synchronize the computer clock.');
    const { key, secret } = await this.credentials();
    if (!key.trim() || !secret.trim()) return fail('Indodax trade-only credentials are not configured.');
    registerSecrets([key, secret]);
    const encoded = new URLSearchParams({ ...params, timestamp: String(this.now()), recvWindow: '5000' }).toString();
    const signature = createHmac('sha256', secret).update(encoded).digest('hex');
    if (method === 'POST' && this.isKilled()) return fail('Kill switch active; stop sell was not sent.');
    return this.request(`${API}${path}${method === 'GET' ? `?${encoded}` : ''}`, {
      method, headers: { Accept: 'application/json', 'X-APIKEY': key, Sign: signature, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body: encoded } : {})
    });
  }

  async account(): Promise<StopAccount> {
    const body = await this.signed('GET', '/api/v2/account');
    if (body.canTrade !== true || body.canWithdraw !== false || body.canWithdrawFiat !== false) return fail('Indodax key refused: trading must be enabled and crypto/fiat withdrawal permissions must both be verified off.');
    if ((typeof body.uid !== 'number' && typeof body.uid !== 'string') || !/^\d+$/.test(String(body.uid))) return fail('Indodax account identity unavailable.');
    if (!Array.isArray(body.balances)) return fail('Indodax balances unavailable.');
    const free: Record<string, string> = Object.create(null);
    for (const value of body.balances) {
      const b = object(value);
      if (typeof b.asset !== 'string' || !/^[A-Z0-9]{1,24}$/i.test(b.asset)) return fail('Indodax balance asset malformed.');
      const asset = b.asset.toUpperCase();
      if (Object.hasOwn(free, asset)) return fail('Indodax returned duplicate balance assets.');
      free[asset] = stopDecimal(b.free);
      stopDecimal(b.locked);
    }
    return { identity: String(body.uid), free };
  }

  async pair(input: string): Promise<IndodaxPair> {
    const symbol = indodaxSymbol(input);
    const pair = (await this.publicClient.pairs()).find(p => p.symbol === symbol);
    if (!pair || pair.maintenance || pair.suspended) return fail('Indodax pair unavailable, suspended or in maintenance.');
    for (const field of [pair.quantityIncrement, pair.minQuantity, pair.minQuote]) stopDecimal(field, true);
    return pair;
  }

  async quote(input: string): Promise<StopQuote> {
    const symbol = indodaxSymbol(input), started = this.now();
    const body = await this.request(`${API}/api/v2/ticker/price?symbol=${symbol}`, { method: 'GET', headers: { Accept: 'application/json' } });
    if (body.symbol !== symbol && String(body.symbol).toUpperCase() !== symbol) return fail('Indodax stop quote symbol mismatch.');
    if (this.now() - started > 5000) return fail('Indodax stop quote arrived too late.');
    // This endpoint has no source timestamp. observedAt is local receipt time, not a venue freshness guarantee.
    return { last: stopDecimal(body.price, true), observedAt: this.now() };
  }

  async sell(symbol: string, quantity: string, clientOrderId: string): Promise<StopOrder> {
    if (!/^[A-Za-z0-9_-]{1,36}$/.test(clientOrderId)) return fail('Invalid stop client order id.');
    stopDecimal(quantity, true);
    const pair = await this.pair(symbol), account = await this.account(), quote = await this.quote(symbol);
    if (compareDecimals(account.free[pair.asset] ?? '0', quantity) < 0) return fail('Indodax available asset balance is below the adopted stop quantity.');
    if (compareDecimals(quantize(quantity, pair.quantityIncrement!, 'floor'), quantity) !== 0 || compareDecimals(quantity, pair.minQuantity!) < 0 || compareDecimals(mulDecimals(quantity, quote.last), pair.minQuote!) < 0) return fail('Indodax stop quantity violates pair increments or minimums; manual attention required.');
    const body = await this.signed('POST', '/api/v2/order', { symbol: pair.symbol, side: 'SELL', type: 'MARKET', quantity, newClientOrderId: clientOrderId, selfTradePreventionMode: 'EXPIRE_TAKER' });
    if (String(body.symbol).toUpperCase() !== symbol || body.clientOrderId !== clientOrderId || body.side !== 'SELL' || body.orderId === null || body.orderId === undefined) return fail('Indodax sell acceptance is ambiguous; reconcile the client order id.');
    // Accepted is not filled. Only GET order may confirm a fill.
    return { clientOrderId, venueOrderId: String(body.orderId), state: 'ACCEPTED', filledQty: null };
  }

  async lookup(symbol: string, clientOrderId: string): Promise<StopOrder> {
    const body = await this.signed('GET', '/api/v2/order', { symbol: indodaxSymbol(symbol), origClientOrderId: clientOrderId });
    if (String(body.symbol).toUpperCase() !== symbol || body.clientOrderId !== clientOrderId || body.side !== 'SELL') return fail('Indodax stop order identity mismatch.');
    const state: Partial<Record<string, IntentState>> = { NEW: 'ACCEPTED', PARTIALLY_FILLED: 'PARTIAL', FILLED: 'FILLED', CANCELLED: 'CANCELLED', CANCELED: 'CANCELLED', REJECTED: 'REJECTED' };
    const mapped = state[String(body.status)];
    if (!mapped) return fail('Indodax stop order state unknown.');
    const original = stopDecimal(body.origQty ?? body.oriQty, true), filledQty = stopDecimal(body.executedQty);
    if (compareDecimals(filledQty, original) > 0 || (mapped === 'FILLED' && compareDecimals(filledQty, original) !== 0)) return fail('Indodax stop fill quantity inconsistent.');
    return { clientOrderId, venueOrderId: body.orderId == null ? null : String(body.orderId), state: mapped, filledQty };
  }
}
