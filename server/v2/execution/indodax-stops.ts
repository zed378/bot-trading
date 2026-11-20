import { createHash, randomUUID } from 'node:crypto';
import type { DomainEvent, IntentState } from '../contracts.js';
import { RuntimeStore } from '../store/database.js';
import { ExecutionAuthorityService } from '../accounts/authority.js';
import { ExecutionGateway, deriveClientOrderId, type GatewayVenueTransport } from './gateway.js';
import { compareDecimals, subDecimals, mulDecimals, quantize } from './decimal.js';
import { IndodaxStopError, stopDecimal, type IndodaxStopExchange, type StopOrder } from './indodax-client.js';
import { indodaxSymbol } from '../../market/indodax.js';

export const INDODAX_STOP_SCHEMA = 'indodax_stops';
export type StopMode = 'PAPER' | 'LIVE';
export interface BotStopView {
  symbol: string; quantity: string; entry: string; stop: string; quote: string; asset: string;
  mode: StopMode; protection: 'BOT_MANAGED'; status: string; lastError: string | null;
  updatedAt: string; workerHeartbeatAt: number | null;
}
type StopRow = Record<string, string | number | bigint | null | Uint8Array>;

function event(accountRef: string, kind: string, payload: Record<string, unknown>): DomainEvent {
  return { eventId: `indodax-stop-${randomUUID()}`, scope: accountRef, kind: `indodax.stop.${kind}`, createdAt: new Date().toISOString(), correlationId: null, causationId: null, schemaVersion: 1, payload };
}
function errorText(error: unknown): string {
  return error instanceof IndodaxStopError ? error.message : 'Stop worker operation failed; check local diagnostics and reconcile before rearming.';
}

/** Reads only local records; account identifiers and credentials are never projected to the Office. */
export async function readIndodaxStops(store: RuntimeStore, accountRef?: string): Promise<BotStopView[]> {
  const result = await store.execute(`SELECT p.*, b.status AS bot_status, b.last_error, a.mode, a.metadata_json
    FROM managed_positions p JOIN indodax_bot_stops b USING (account_ref, position_key)
    JOIN accounts a USING (account_ref) WHERE a.venue = 'indodax' ${accountRef ? 'AND p.account_ref = ?' : ''} ORDER BY a.mode, p.symbol`, accountRef ? [accountRef] : []);
  return result.rows.map(r => {
    const meta = JSON.parse(String(r.thesis_json));
    const account = JSON.parse(String(r.metadata_json));
    return { symbol: String(r.symbol), quantity: String(r.qty), entry: String(r.entry_price), stop: String(r.stop_price),
      quote: meta.quote, asset: meta.asset, mode: String(r.mode) as StopMode, protection: 'BOT_MANAGED',
      status: String(r.bot_status), lastError: r.last_error == null ? null : String(r.last_error), updatedAt: String(r.updated_at),
      workerHeartbeatAt: typeof account.heartbeatAt === 'number' ? account.heartbeatAt : null };
  });
}

export class IndodaxStopService {
  readonly authority: ExecutionAuthorityService;
  readonly gateway: ExecutionGateway;
  private epoch: number | null = null;
  private busy = false;
  private constructor(
    private readonly store: RuntimeStore,
    private readonly exchange: IndodaxStopExchange,
    readonly mode: StopMode,
    readonly accountRef: string,
    private readonly identityHash: string,
    private readonly isKilled: () => boolean,
    private readonly now: () => number
  ) {
    this.authority = new ExecutionAuthorityService(store);
    const unavailable = async (): Promise<never> => { throw new IndodaxStopError('Indodax stop worker is exit-only; entries and exchange-stop claims are not supported.'); };
    const transport: GatewayVenueTransport = {
      balance: unavailable, submitOrder: unavailable, cancelEntryOrder: unavailable, placeProtection: unavailable, readProtection: unavailable,
      positions: async () => {
        const rows = await this.rows();
        const account = this.mode === 'LIVE' ? await this.checkedAccount() : null;
        return rows.filter(r => r.state === 'OPEN' && compareDecimals(String(r.qty), '0') > 0).map(r => {
          const meta = JSON.parse(String(r.thesis_json));
          if (account && compareDecimals(account.free[meta.asset] ?? '0', String(r.qty)) < 0) throw new IndodaxStopError('Indodax holdings differ from the adopted quantity; stop sell blocked for reconciliation.');
          return { positionKey: String(r.position_key), symbol: String(r.symbol), side: 'LONG' as const, qty: String(r.qty), entryPrice: String(r.entry_price), positionMode: 'ONE_WAY' as const };
        });
      },
      lookupOrder: (symbol, clientOrderId) => this.lookup(symbol, clientOrderId),
      closePosition: async (position, clientOrderId) => {
        if (this.isKilled() || (await this.authority.current(this.accountRef))?.haltLatched) return { clientOrderId, venueOrderId: null, state: 'REJECTED', filledQty: '0' };
        if (this.mode === 'LIVE') return this.exchange.sell(position.symbol, position.qty, clientOrderId);
        // PAPER fills are explicitly local, and never call the private sell client.
        return { clientOrderId, venueOrderId: `paper-${clientOrderId}`, state: 'FILLED', filledQty: position.qty };
      }
    };
    this.gateway = new ExecutionGateway({ store, authority: this.authority, getTransport: ref => {
      if (ref !== this.accountRef) throw new IndodaxStopError('Stop account mismatch.');
      return transport;
    }, getAccountPolicy: () => { throw new IndodaxStopError('Stop worker cannot size or open entries.'); }, readFreshMarket: () => null });
  }

  static async open(options: { store: RuntimeStore; exchange: IndodaxStopExchange; mode?: StopMode; liveAcknowledged?: boolean; isKilled?: () => boolean; now?: () => number }): Promise<IndodaxStopService> {
    const mode = options.mode ?? 'PAPER';
    if (mode !== 'PAPER' && mode !== 'LIVE') throw new IndodaxStopError('Indodax stop mode must be PAPER or LIVE; no testnet is assumed.');
    if (mode === 'LIVE' && !options.liveAcknowledged) throw new IndodaxStopError('LIVE stop worker requires the local real-money confirmation.');
    const identity = mode === 'LIVE' ? (await options.exchange.account()).identity : 'local-paper';
    const identityHash = createHash('sha256').update(`indodax:${mode}:${identity}`).digest('hex');
    const accountRef = `indodax-stop-${mode.toLowerCase()}-${identityHash.slice(0, 20)}`;
    const now = new Date().toISOString();
    await options.store.transaction(async tx => {
      await tx.execute(`INSERT INTO accounts (account_ref, venue, network, mode, native_identity_hash, subaccount_ref, lifecycle_state, metadata_json, created_at, updated_at)
        VALUES (?, 'indodax', 'mainnet', ?, ?, NULL, 'ACTIVE', '{}', ?, ?) ON CONFLICT DO NOTHING`, [accountRef, mode, identityHash, now, now]);
    });
    return new IndodaxStopService(options.store, options.exchange, mode, accountRef, identityHash, options.isKilled ?? (() => false), options.now ?? Date.now);
  }

  private async checkedAccount() {
    const account = await this.exchange.account();
    if (createHash('sha256').update(`indodax:${this.mode}:${account.identity}`).digest('hex') !== this.identityHash) throw new IndodaxStopError('Indodax account changed; stop worker halted.');
    return account;
  }
  private async rows(): Promise<StopRow[]> {
    return (await this.store.execute(`SELECT p.*, b.status AS bot_status, b.intent_id, b.attempt_qty, b.credited_qty, b.last_error, b.revision
      FROM managed_positions p JOIN indodax_bot_stops b USING (account_ref, position_key) WHERE p.account_ref = ?`, [this.accountRef])).rows;
  }
  async list(): Promise<BotStopView[]> { return readIndodaxStops(this.store, this.accountRef); }

  async arm(input: { symbol: string; quantity: string; entry: string; stop: string }): Promise<void> {
    if (this.isKilled()) throw new IndodaxStopError('Kill switch active; cannot arm a stop.');
    const symbol = indodaxSymbol(input.symbol), quantity = stopDecimal(input.quantity, true), entry = stopDecimal(input.entry, true), stop = stopDecimal(input.stop, true);
    const pair = await this.exchange.pair(symbol);
    const quote = await this.exchange.quote(symbol);
    this.assertFresh(quote.observedAt);
    if (!pair.quantityIncrement || !pair.minQuantity || !pair.minQuote || pair.maintenance || pair.suspended) throw new IndodaxStopError('Indodax pair rules unavailable.');
    if (compareDecimals(quantize(quantity, pair.quantityIncrement, 'floor'), quantity) !== 0 || compareDecimals(quantity, pair.minQuantity) < 0 || compareDecimals(mulDecimals(quantity, quote.last), pair.minQuote) < 0) throw new IndodaxStopError('Stop quantity must satisfy Indodax increments and minimums; quantities are never rounded up.');
    if (this.mode === 'LIVE' && compareDecimals((await this.checkedAccount()).free[pair.asset] ?? '0', quantity) < 0) throw new IndodaxStopError('Cannot adopt more assets than the available Indodax balance.');
    const key = `${symbol}:SPOT`, at = new Date(this.now()).toISOString();
    await this.store.transaction(async tx => {
      const active = await tx.execute(`SELECT p.symbol, p.thesis_json, p.position_key, b.intent_id, e.order_state
        FROM managed_positions p JOIN indodax_bot_stops b USING (account_ref, position_key)
        LEFT JOIN execution_intents e ON e.account_ref=b.account_ref AND e.intent_id=b.intent_id
        WHERE p.account_ref=? AND (p.state='OPEN' OR b.status IN ('TRIGGERED','WORKING','UNKNOWN','ERROR'))`, [this.accountRef]);
      for (const existing of active.rows) {
        if (existing.position_key === key && existing.intent_id && !['CANCELLED', 'REJECTED', 'FILLED'].includes(String(existing.order_state))) throw new IndodaxStopError('Existing stop exit is unresolved; reconcile it before changing or rearming the stop.');
        if (existing.position_key !== key && JSON.parse(String(existing.thesis_json)).asset === pair.asset) throw new IndodaxStopError('This asset already has a stop on another quote pair; duplicate adoption is refused.');
      }
      await tx.execute(`INSERT INTO managed_positions (account_ref, position_key, native_position_id, symbol, native_instrument, position_mode, side, qty, entry_price, stop_price, tp_price, leverage, ownership, protection_state, thesis_json, state, opened_at, updated_at, closed_at)
        VALUES (?, ?, NULL, ?, ?, 'ONE_WAY', 'LONG', ?, ?, ?, NULL, 1, 'MANAGED', 'BOT_MANAGED', ?, 'OPEN', ?, ?, NULL)
        ON CONFLICT(account_ref, position_key) DO UPDATE SET qty=excluded.qty, entry_price=excluded.entry_price, stop_price=excluded.stop_price, protection_state='BOT_MANAGED', thesis_json=excluded.thesis_json, state='OPEN', opened_at=excluded.opened_at, updated_at=excluded.updated_at, closed_at=NULL`,
        [this.accountRef, key, symbol, symbol, quantity, entry, stop, JSON.stringify({ asset: pair.asset, quote: pair.quote, entrySource: 'owner_reference', protectionKind: 'BOT_MANAGED' }), at, at]);
      await tx.execute(`INSERT INTO indodax_bot_stops (account_ref, position_key, revision, status, updated_at) VALUES (?, ?, ?, 'ARMED', ?)
        ON CONFLICT(account_ref, position_key) DO UPDATE SET revision=excluded.revision, status='ARMED', intent_id=NULL, attempt_qty=NULL, credited_qty='0', last_error=NULL, triggered_at=NULL, updated_at=excluded.updated_at`, [this.accountRef, key, randomUUID(), at]);
      await tx.append(event(this.accountRef, 'armed', { symbol, quantity, entry, stop, quote: pair.quote, mode: this.mode, protection: 'BOT_MANAGED' }));
    });
  }

  async disarm(input: string): Promise<void> {
    const symbol = indodaxSymbol(input), at = new Date(this.now()).toISOString();
    await this.store.transaction(async tx => {
      const current = await tx.execute(`SELECT b.*, e.order_state FROM indodax_bot_stops b LEFT JOIN execution_intents e USING (account_ref, intent_id) WHERE b.account_ref=? AND b.position_key=?`, [this.accountRef, `${symbol}:SPOT`]);
      const r = current.rows[0];
      if (!r) throw new IndodaxStopError('No adopted stop for this pair.');
      if (r.intent_id && !['CANCELLED', 'REJECTED', 'FILLED'].includes(String(r.order_state))) throw new IndodaxStopError('Cannot disarm an unresolved exit order; reconcile it first.');
      await tx.execute(`UPDATE indodax_bot_stops SET status='DISARMED', updated_at=? WHERE account_ref=? AND position_key=?`, [at, this.accountRef, `${symbol}:SPOT`]);
      await tx.execute(`UPDATE managed_positions SET state=CASE WHEN state='CLOSED' THEN state ELSE 'UNMANAGED' END, protection_state='UNVERIFIED', updated_at=? WHERE account_ref=? AND position_key=?`, [at, this.accountRef, `${symbol}:SPOT`]);
      await tx.append(event(this.accountRef, 'disarmed', { symbol, mode: this.mode }));
    });
  }

  private assertFresh(observedAt: number): void {
    if (!Number.isSafeInteger(observedAt) || observedAt > this.now() + 1000 || this.now() - observedAt > 5000) throw new IndodaxStopError('Stop quote is stale or has an invalid observation time.');
  }
  private async lookup(symbol: string, clientOrderId: string): Promise<StopOrder> {
    if (this.mode === 'LIVE') { await this.checkedAccount(); return this.exchange.lookup(symbol, clientOrderId); }
    const r = (await this.store.execute(`SELECT order_state, venue_order_id, payload_json FROM execution_intents WHERE account_ref=? AND client_order_id=?`, [this.accountRef, clientOrderId])).rows[0];
    if (!r) throw new IndodaxStopError('Paper exit intent missing.');
    const payload = JSON.parse(String(r.payload_json));
    // A paper crash after journaling but before the local fill is indeterminate too; never fabricate a replayed fill.
    return { clientOrderId, venueOrderId: r.venue_order_id == null ? null : String(r.venue_order_id), state: String(r.order_state) === 'SUBMITTING' ? 'UNKNOWN' : String(r.order_state) as IntentState, filledQty: payload.filledQty ?? null };
  }

  private async setError(r: StopRow, message: string, status: 'ARMED' | 'ERROR' | 'UNKNOWN'): Promise<void> {
    await this.store.transaction(async tx => {
      await tx.execute(`UPDATE indodax_bot_stops SET status=?, last_error=?, updated_at=? WHERE account_ref=? AND position_key=? AND revision=?`, [status, message, new Date(this.now()).toISOString(), this.accountRef, String(r.position_key), String(r.revision)]);
      if (r.last_error !== message) await tx.append(event(this.accountRef, 'attention_required', { symbol: r.symbol, mode: this.mode, status, reason: message }));
    });
  }

  private async applyOrder(r: StopRow, order: StopOrder): Promise<void> {
    const filled = order.filledQty;
    if (filled === null && ['FILLED', 'PARTIAL'].includes(order.state)) throw new IndodaxStopError('Stop order fill quantity missing.');
    const cumulative = stopDecimal(filled ?? '0'), credited = stopDecimal(r.credited_qty), attempt = stopDecimal(r.attempt_qty, true);
    if (compareDecimals(cumulative, credited) < 0 || compareDecimals(cumulative, attempt) > 0 || (order.state === 'FILLED' && compareDecimals(cumulative, attempt) !== 0)) throw new IndodaxStopError('Stop order fill totals changed inconsistently; manual reconciliation required.');
    const remaining = subDecimals(String(r.qty), subDecimals(cumulative, credited));
    if (compareDecimals(remaining, '0') < 0) throw new IndodaxStopError('Stop fill exceeds the adopted holding.');
    const status = order.state === 'FILLED' ? 'CLOSED' : ['CANCELLED', 'REJECTED'].includes(order.state) ? 'ERROR' : order.state === 'UNKNOWN' ? 'UNKNOWN' : 'WORKING';
    const message = status === 'ERROR' ? 'Stop sell was cancelled or rejected. Review remaining holdings and explicitly rearm; no automatic resubmission.' : status === 'UNKNOWN' ? 'Stop sell outcome unknown; lookup continues without resubmission.' : null;
    const at = new Date(this.now()).toISOString();
    await this.store.transaction(async tx => {
      // CAS prevents two monitors crediting the same partial fill twice.
      const updated = await tx.execute(`UPDATE indodax_bot_stops SET credited_qty=?, status=?, last_error=?, updated_at=? WHERE account_ref=? AND position_key=? AND intent_id=? AND credited_qty=?`, [cumulative, status, message, at, this.accountRef, String(r.position_key), String(r.intent_id), credited]);
      if (updated.rowsAffected !== 1) throw new IndodaxStopError('Stop changed during reconciliation; reload local state.');
      await tx.execute(`UPDATE execution_intents SET order_state=?, venue_order_id=COALESCE(?, venue_order_id), payload_json=?, updated_at=? WHERE account_ref=? AND intent_id=?`, [order.state, order.venueOrderId, JSON.stringify({ filledQty: cumulative, mode: this.mode, protectionKind: 'BOT_MANAGED' }), at, this.accountRef, String(r.intent_id)]);
      await tx.execute(`UPDATE managed_positions SET qty=?, state=?, closed_at=?, updated_at=? WHERE account_ref=? AND position_key=?`, [remaining, status === 'CLOSED' ? 'CLOSED' : 'OPEN', status === 'CLOSED' ? at : null, at, this.accountRef, String(r.position_key)]);
      if (cumulative !== credited || status !== r.bot_status) await tx.append(event(this.accountRef, 'exit_observed', { symbol: r.symbol, mode: this.mode, orderState: order.state, filledQty: cumulative, remainingQty: remaining }));
    });
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.epoch === null) this.epoch = (await this.authority.claim(this.accountRef)).writerEpoch;
      const authority = await this.authority.current(this.accountRef);
      if (authority?.holderId !== this.authority.defaultHolderId || authority.writerEpoch !== this.epoch) throw new IndodaxStopError('Stop monitor authority was replaced; stop this worker.');
      const killed = this.isKilled() || authority.haltLatched;
      await this.store.execute(`UPDATE accounts SET metadata_json=?, updated_at=? WHERE account_ref=?`, [JSON.stringify({ heartbeatAt: this.now(), workerState: killed ? 'PAUSED_KILL' : 'RUNNING', protectionKind: 'BOT_MANAGED' }), new Date(this.now()).toISOString(), this.accountRef]);
      if (killed) return;
      for (let r of await this.rows()) {
        if (['CLOSED', 'DISARMED'].includes(String(r.bot_status))) continue;
        if (r.bot_status === 'ERROR') {
          // No gateway journal means no network sell was possible. Retry that same durable trigger,
          // not a new client id. Confirmed cancelled/rejected orders still need explicit rearming.
          if (!r.intent_id || (await this.store.execute('SELECT intent_id FROM execution_intents WHERE account_ref=? AND intent_id=?', [this.accountRef, String(r.intent_id)])).rows.length) continue;
        }
        if (this.isKilled()) return;
        try {
          if (!r.intent_id) {
            const quote = await this.exchange.quote(String(r.symbol));
            this.assertFresh(quote.observedAt);
            if (compareDecimals(stopDecimal(quote.last, true), stopDecimal(r.stop_price, true)) > 0) continue;
            const intentId = `stop-${randomUUID()}`, at = new Date(this.now()).toISOString();
            await this.store.transaction(async tx => {
              const result = await tx.execute(`UPDATE indodax_bot_stops SET status='TRIGGERED', intent_id=?, attempt_qty=?, triggered_at=?, updated_at=? WHERE account_ref=? AND position_key=? AND revision=? AND intent_id IS NULL AND status='ARMED'`, [intentId, String(r.qty), at, at, this.accountRef, String(r.position_key), String(r.revision)]);
              if (result.rowsAffected !== 1) throw new IndodaxStopError('Stop changed before trigger; reload state.');
              await tx.append(event(this.accountRef, 'triggered', { symbol: r.symbol, mode: this.mode, last: quote.last, stop: r.stop_price, intentId }));
            });
            r = { ...r, intent_id: intentId, attempt_qty: String(r.qty), bot_status: 'TRIGGERED' };
          }
          const existing = (await this.store.execute(`SELECT client_order_id, venue_order_id, order_state, payload_json FROM execution_intents WHERE account_ref=? AND intent_id=?`, [this.accountRef, String(r.intent_id)])).rows[0];
          if (existing) {
            const terminal = ['FILLED', 'CANCELLED', 'REJECTED'].includes(String(existing.order_state));
            const payload = JSON.parse(String(existing.payload_json));
            const order = terminal ? { clientOrderId: String(existing.client_order_id), venueOrderId: existing.venue_order_id == null ? null : String(existing.venue_order_id), state: String(existing.order_state) as IntentState, filledQty: payload.filledQty ?? null } : await this.lookup(String(r.symbol), String(existing.client_order_id));
            await this.applyOrder(r, order);
          } else {
            if (this.isKilled()) return;
            const receipt = await this.gateway.close({ intentId: String(r.intent_id), accountRef: this.accountRef, configVersion: 0, authorityEpoch: this.epoch, symbol: String(r.symbol), side: 'LONG', quantity: String(r.qty), ownerAuthorized: true, trigger: 'DATABASE_STOP_LOSS' });
            // Authority rejections can occur before journaling and require owner attention.
            const journal = (await this.store.execute(`SELECT intent_id FROM execution_intents WHERE account_ref=? AND intent_id=?`, [this.accountRef, String(r.intent_id)])).rows.length;
            if (!journal) throw new IndodaxStopError('Stop exit was not journaled; check authority and available holdings.');
            await this.applyOrder(r, { clientOrderId: deriveClientOrderId(this.accountRef, String(r.intent_id)), venueOrderId: null, state: receipt.orderState, filledQty: receipt.filledQty });
          }
        } catch (error) {
          // An intent journal may survive a timeout/crash. Keep reconciling, never create a new order id.
          const journal = r.intent_id ? (await this.store.execute(`SELECT intent_id FROM execution_intents WHERE account_ref=? AND intent_id=?`, [this.accountRef, String(r.intent_id)])).rows.length : 0;
          await this.setError(r, errorText(error), journal ? 'UNKNOWN' : r.intent_id ? 'ERROR' : 'ARMED');
        }
      }
    } finally { this.busy = false; }
  }

  async markStopped(): Promise<void> {
    const authority = await this.authority.current(this.accountRef);
    if (authority?.holderId !== this.authority.defaultHolderId) return;
    await this.store.execute(`UPDATE accounts SET metadata_json=?, updated_at=? WHERE account_ref=?`, [JSON.stringify({ heartbeatAt: null, workerState: 'STOPPED', protectionKind: 'BOT_MANAGED' }), new Date(this.now()).toISOString(), this.accountRef]);
  }
}
