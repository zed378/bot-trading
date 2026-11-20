import type express from 'express';
import { z } from 'zod';
import { RuntimeStore, DEFAULT_DATABASE_SCHEMA } from '../store/database.js';
import { IndodaxStopClient, IndodaxStopError, type IndodaxStopExchange } from '../execution/indodax-client.js';
import { INDODAX_STOP_SCHEMA, IndodaxStopService, readIndodaxStops, type StopMode } from '../execution/indodax-stops.js';
import { isLocalLoopbackClient } from '../contracts.js';
import { readKill, DEFAULT_KILL_FILE } from '../kill-file.js';
import { CredentialVault, VaultError } from '../settings/vault.js';

const CONFIRM = 'I understand LIVE trades real money';
const modeFields = { mode: z.enum(['PAPER', 'LIVE']).default('PAPER'), confirmation: z.string().max(100).optional() };
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/).max(80);
const symbol = z.string().min(4).max(32);

export interface IndodaxStopApiOptions {
  env?: NodeJS.ProcessEnv;
  isKilled?: () => boolean;
  exchangeFactory?: (isKilled: () => boolean) => IndodaxStopExchange;
}

/** Office controls and CLI share IndodaxStopService and the existing ExecutionGateway close path. */
export function mountIndodaxStopRoutes(app: express.Express, options: IndodaxStopApiOptions = {}) {
  const env = options.env ?? process.env;
  const schema = env.INDODAX_STOP_SCHEMA || INDODAX_STOP_SCHEMA;
  let worker: { store: RuntimeStore; service: IndodaxStopService; mode: StopMode; cancelled: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let transitioning = false;
  let lastError: string | null = null;
  const killed = () => Boolean(options.isKilled?.()) || readKill(env.KILL_SWITCH_FILE || DEFAULT_KILL_FILE) !== null;
  const exchange = async (isKilled: () => boolean) => {
    if (options.exchangeFactory) return options.exchangeFactory(isKilled);
    const db = await openStore();
    try {
      const stored = await new CredentialVault(db, schema, env).load('indodax.mainnet');
      if (!stored?.key || !stored.secret) throw new IndodaxStopError('Save Indodax credentials in the dashboard first.');
      // Freeze one credential revision for the lifetime of this operation/worker.
      return new IndodaxStopClient(() => ({ key: stored.key, secret: stored.secret }), fetch, Date.now, isKilled);
    } finally { await db.close(); }
  };
  const forMode = (mode: StopMode, isKilled: () => boolean) => mode === 'PAPER' && !options.exchangeFactory ? Promise.resolve(new IndodaxStopClient(() => ({key:'',secret:''}))) : exchange(isKilled);
  const openStore = () => {
    if (schema === (env.DATABASE_SCHEMA || DEFAULT_DATABASE_SCHEMA)) throw new IndodaxStopError('Indodax stops require a separate PostgreSQL schema from the USDT entry ledger.');
    return RuntimeStore.openPostgres({ schema, env });
  };
  const ack = (mode: StopMode, confirmation?: string) => {
    if (mode === 'LIVE' && confirmation !== CONFIRM) throw new IndodaxStopError(`LIVE sells real holdings automatically and can lose money. Type: ${CONFIRM}`);
    return mode === 'LIVE';
  };
  const stopWorker = async () => {
    const previous = worker;
    if (previous) previous.cancelled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    await running?.catch(() => {});
    if (previous) { await previous.service.markStopped(); await previous.store.close(); }
    if (worker === previous) worker = null;
  };

  app.use(['/api/indodax/stops', '/api/indodax/credentials'], (req, res, next) => {
    const access = isLocalLoopbackClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host, origin: req.get('origin') });
    if (!access.ok) return res.status(403).json({ ok: false, error: access.reason });
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  const failure = (res: express.Response, error: unknown) => res.status(error instanceof IndodaxStopError || error instanceof VaultError ? 400 : 503).json({ ok: false, error: error instanceof IndodaxStopError || error instanceof VaultError ? error.message : 'Indodax stop storage or worker unavailable.' });
  app.get('/api/indodax/credentials', async (_req, res) => {
    let db: RuntimeStore | undefined;
    try { db = await openStore(); const status = await new CredentialVault(db, schema, env).status('indodax.mainnet'); return res.json({ ok: true, configured: status.configured, updatedAt: status.updatedAt, encryption: 'AES-256-GCM', liveEnabled: false }); }
    catch (error) { return failure(res, error); } finally { await db?.close(); }
  });
  app.post('/api/indodax/credentials', async (req, res) => {
    const input = z.object({ key: z.string().trim().min(8).max(400).regex(/^\S+$/), secret: z.string().trim().min(8).max(400).regex(/^\S+$/) }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ ok: false, error: 'Both API key and API secret are required; use the masked inputs.' });
    let db: RuntimeStore | undefined;
    try {
      db = await openStore();
      const active = await db.execute("SELECT metadata_json FROM accounts WHERE venue='indodax' AND mode='LIVE'");
      if (worker?.mode === 'LIVE' || active.rows.some(r => { const at = JSON.parse(String(r.metadata_json)).heartbeatAt; return typeof at === 'number' && Date.now() - at < 60_000; })) throw new IndodaxStopError('Stop the LIVE SL monitor before rotating credentials.');
      await new CredentialVault(db, schema, env).save('indodax.mainnet', input.data);
      return res.json({ ok: true, configured: true, encryption: 'AES-256-GCM', note: 'Encrypted credentials saved. LIVE was not enabled and no order was submitted.' });
    } catch (error) { return failure(res, error); } finally { await db?.close(); }
  });
  app.post('/api/indodax/credentials/check', async (_req, res) => {
    try { await (await exchange(killed)).account(); return res.json({ ok: true, canTrade: true, canWithdraw: false, canWithdrawFiat: false, note: 'Trade-only permissions verified. No order submitted.' }); }
    catch (error) { return failure(res, error); }
  });
  app.get('/api/indodax/stops', async (_req, res) => {
    let db: RuntimeStore | undefined;
    try {
      const stops = await readIndodaxStops(db = await openStore());
      return res.json({ ok: true, protection: 'BOT_MANAGED', worker: worker ? { mode: worker.mode, state: killed() ? 'PAUSED_KILL' : 'RUNNING' } : null, lastError, stops, note: 'Only worker started in this Office is shown as RUNNING. CLI worker activity is indicated by record heartbeats.' });
    } catch (error) { return failure(res, error); }
    finally { await db?.close(); }
  });
  app.post('/api/indodax/stops/arm', async (req, res) => {
    const input = z.object({ ...modeFields, symbol, quantity: decimal, entry: decimal, stop: decimal }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ ok: false, error: 'Supply mode, symbol, quantity, entry reference and stop as decimal strings.' });
    let db: RuntimeStore | undefined;
    try {
      const liveAcknowledged = ack(input.data.mode, input.data.confirmation);
      const service = await IndodaxStopService.open({ store: db = await openStore(), exchange: await forMode(input.data.mode, killed), mode: input.data.mode, liveAcknowledged, isKilled: killed });
      await service.arm(input.data);
      return res.json({ ok: true, mode: input.data.mode, protection: 'BOT_MANAGED', note: 'Saved to database. A matching mode/account worker must be running to execute the SL.' });
    } catch (error) { return failure(res, error); }
    finally { await db?.close(); }
  });
  app.post('/api/indodax/stops/disarm', async (req, res) => {
    const input = z.object({ ...modeFields, symbol }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ ok: false, error: 'Supply mode and symbol.' });
    let db: RuntimeStore | undefined;
    try {
      const liveAcknowledged = ack(input.data.mode, input.data.confirmation);
      const service = await IndodaxStopService.open({ store: db = await openStore(), exchange: await forMode(input.data.mode, killed), mode: input.data.mode, liveAcknowledged, isKilled: killed });
      await service.disarm(input.data.symbol);
      return res.json({ ok: true, note: 'SL disarmed. No sale submitted.' });
    } catch (error) { return failure(res, error); }
    finally { await db?.close(); }
  });
  app.post('/api/indodax/stops/watch', async (req, res) => {
    const input = z.object({ ...modeFields, intervalMs: z.number().int().min(1000).max(60_000).default(3000) }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ ok: false, error: 'Supply mode and a polling interval between 1000 and 60000 milliseconds.' });
    if (worker || transitioning) return res.status(409).json({ ok: false, error: 'Stop the current Office worker before starting another.' });
    let db: RuntimeStore | undefined;
    transitioning = true;
    try {
      const liveAcknowledged = ack(input.data.mode, input.data.confirmation);
      if (killed()) throw new IndodaxStopError('Kill switch active; cannot start a stop worker.');
      const current = { store: db = await openStore(), service: null as unknown as IndodaxStopService, mode: input.data.mode, cancelled: false };
      current.service = await IndodaxStopService.open({ store: current.store, exchange: await forMode(current.mode, () => current.cancelled || killed()), mode: current.mode, liveAcknowledged, isKilled: () => current.cancelled || killed() });
      worker = current; lastError = null;
      const step = () => {
        if (current.cancelled) return;
        running = current.service.tick().catch(async error => {
          lastError = error instanceof IndodaxStopError ? error.message : 'Stop worker failed; inspect local storage before restarting.';
          current.cancelled = true;
          await current.service.markStopped().catch(() => {});
          await current.store.close();
          if (worker === current) worker = null;
        }).finally(() => {
          running = null;
          if (!current.cancelled) { timer = setTimeout(step, input.data.intervalMs); timer.unref(); }
        });
      };
      timer = setTimeout(step, 0); timer.unref();
      return res.json({ ok: true, mode: current.mode, protection: 'BOT_MANAGED', note: 'Worker started. Keep this Office backend running; stopping it disables SL execution.' });
    } catch (error) { await db?.close(); return failure(res, error); }
    finally { transitioning = false; }
  });
  app.post('/api/indodax/stops/watch/stop', async (_req, res) => {
    if (transitioning) return res.status(409).json({ ok: false, error: 'Worker start is still being checked. Use Kill for an immediate stop.' });
    try { await stopWorker(); return res.json({ ok: true, note: 'Office SL worker stopped. References remain stored; automatic execution is disabled here.' }); }
    catch (error) { return failure(res, error); }
  });
  return { stop: stopWorker };
}
