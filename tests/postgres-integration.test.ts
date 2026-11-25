import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStore, postgresParameters, StoreConflictError } from '../server/v2/store/database.js';
import { CredentialVault, openSecret, sealSecret } from '../server/v2/settings/vault.js';
import { importSqlite } from '../server/v2/store/import-sqlite.js';
import { IndodaxStopService } from '../server/v2/execution/indodax-stops.js';
import { createOfficialProviderCaller } from '../server/v2/agents/providers.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { mountIndodaxStopRoutes } from '../server/v2/api/indodax-stops.js';
import { mountProviderProfileRoutes } from '../server/v2/api/provider-profiles.js';
import { SettingsService } from '../server/v2/settings/service.js';
import { SecretStore } from '../server/v2/settings/secrets.js';
import { loadProviderProfiles, type SavedProviderProfile } from '../server/v2/settings/provider-profiles.js';

describe('PostgreSQL parameter binding and authenticated encryption', () => {
  it('binds values without modifying quoted text, identifiers or comments', () => {
    expect(postgresParameters("SELECT '?', \"?\", ? -- ?\n, ? /* ? */", 2)).toBe("SELECT '?', \"?\", $1 -- ?\n, $2 /* ? */");
    expect(() => postgresParameters('SELECT ?', 2)).toThrow('count mismatch');
  });
  it('uses unique nonces and rejects ciphertext modification, wrong keys and wrong context', () => {
    const key = randomBytes(32), input = { key: 'fixture_key_not_real', secret: 'fixture_secret_not_real' };
    const a = sealSecret(input, key, 'indodax'), b = sealSecret(input, key, 'indodax');
    expect(a).not.toBe(b); expect(a).not.toContain(input.key); expect(a).not.toContain(input.secret);
    expect(openSecret(a, key, 'indodax')).toEqual(input);
    expect(() => openSecret(a, key, 'other-provider')).toThrow('authenticated');
    expect(() => openSecret(a, randomBytes(32), 'indodax')).toThrow('authenticated');
    const changed = JSON.parse(a); changed.ciphertext = Buffer.from('modified').toString('base64');
    expect(() => openSecret(JSON.stringify(changed), key, 'indodax')).toThrow('authenticated');
  });
});

describe('OpenAI-compatible Responses and Anthropic protocol contracts', () => {
  const baseRequest = { cycleId: 'fixture', role: 'lead' as const, phase: 'observe' as const, taskAttempt: 1, turn: 1, provider: 'openai', model: 'fixture-model', apiKey: 'fixture-api-key-only', system: 'system', user: 'user' };
  it('routes Responses without Chat Completions fields and extracts assistant output', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'fixture response' }] }] })));
    const value = await createOfficialProviderCaller({ fetchImpl: fetcher })({ ...baseRequest, baseUrl: 'https://compatible.example/v1', apiProtocol: 'responses' });
    expect(value).toBe('fixture response');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://compatible.example/v1/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({ instructions: 'system', input: 'user', model: 'fixture-model' });
    expect(JSON.parse(String(init.body))).not.toHaveProperty('messages');
    expect(init.redirect).toBe('error');
  });
  it('rejects incomplete Responses output instead of using a truncated decision', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'incomplete', output_text: '{partial' })));
    await expect(createOfficialProviderCaller({ fetchImpl: fetcher })({ ...baseRequest, apiProtocol: 'responses' })).rejects.toThrow('token limit');
  });
  it('supports the native Anthropic Messages protocol with a /v1 base URL', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'fixture anthropic response' }] })));
    expect(await createOfficialProviderCaller({ fetchImpl: fetcher })({ ...baseRequest, provider: 'anthropic', baseUrl: 'https://anthropic.example/v1', apiProtocol: 'anthropic' })).toBe('fixture anthropic response');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://anthropic.example/v1/messages');
    expect(new Headers(init.headers).get('x-api-key')).toBe(baseRequest.apiKey);
    expect(new Headers(init.headers).get('authorization')).toBeNull();
  });
});

describe.runIf(process.env.TEST_POSTGRES === '1')('real PostgreSQL 18 in Docker', () => {
  const stores: RuntimeStore[] = [], schemas: string[] = [], tempDirs: string[] = [];
  async function database() {
    const schema = `mpu_test_${randomUUID().replaceAll('-', '')}`; schemas.push(schema);
    const store = await RuntimeStore.openPostgres({ schema }); stores.push(store); return { store, schema };
  }
  afterEach(async () => {
    for (const schema of schemas.splice(0)) {
      const admin = await RuntimeStore.openPostgres({ schema });
      const name = (await admin.execute('SELECT current_database() AS name')).rows[0].name;
      if (name !== 'mpu_test' || !/^mpu_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Refusing to drop a non-test namespace.');
      await admin.execute(`DROP SCHEMA "${schema}" CASCADE`); await admin.close();
    }
    for (const store of stores.splice(0)) await store.close();
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  it('uses version 18, foreign keys, rollback and cross-connection writer serialization', async () => {
    const { store, schema } = await database();
    expect(Number((await store.execute('SHOW server_version_num')).rows[0].server_version_num)).toBeGreaterThanOrEqual(180000);
    await expect(store.execute("INSERT INTO managed_positions (account_ref) VALUES ('missing')")).rejects.toThrow();
    await store.execute('CREATE TABLE counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
    await store.execute('INSERT INTO counter VALUES (1,0)');
    await expect(store.transaction(async tx => { await tx.execute('UPDATE counter SET value=100'); throw new Error('rollback'); })).rejects.toThrow();
    expect(Number((await store.execute('SELECT value FROM counter')).rows[0].value)).toBe(0);
    const other = await RuntimeStore.openPostgres({ schema }); stores.push(other);
    await Promise.all([store, other].map(s => s.transaction(async tx => {
      const n = Number((await tx.execute('SELECT value FROM counter WHERE id=1')).rows[0].value);
      await tx.execute('UPDATE counter SET value=? WHERE id=1', [n + 1]);
    })));
    expect(Number((await store.execute('SELECT value FROM counter')).rows[0].value)).toBe(2);
    const e = { eventId: 'fixture-id', scope: 'test', kind: 'test', createdAt: new Date().toISOString(), correlationId: null, causationId: null, schemaVersion: 1, payload: { n: 1 } };
    const seq = await store.append(e); expect(await other.append(e)).toBe(seq);
    await expect(store.append({ ...e, payload: { n: 2 } })).rejects.toBeInstanceOf(StoreConflictError);
  });
  it('stores only encrypted credentials and can decrypt after reconnecting', async () => {
    const { store, schema } = await database(), dir = await mkdtemp(path.join(os.tmpdir(), 'mpu-pg-vault-')); tempDirs.push(dir);
    const master = path.join(dir, 'master'); await writeFile(master, randomBytes(32).toString('base64'), { mode: 0o600 });
    const env = { CREDENTIAL_MASTER_KEY_FILE: master }, value = { key: 'test_indodax_key_only', secret: 'test_indodax_secret_only' };
    await new CredentialVault(store, schema, env).save('indodax.mainnet', value);
    const raw = JSON.stringify((await store.execute('SELECT * FROM encrypted_secrets')).rows);
    expect(raw).not.toContain(value.key); expect(raw).not.toContain(value.secret);
    const second = await RuntimeStore.openPostgres({ schema }); stores.push(second);
    expect(await new CredentialVault(second, schema, env).load('indodax.mainnet')).toEqual(value);
    expect(JSON.stringify(await new CredentialVault(store, schema, env).status('indodax.mainnet'))).not.toContain(value.secret);
    expect(JSON.stringify((await store.execute('SELECT payload_json FROM events')).rows)).not.toContain(value.secret);
    await store.execute("UPDATE encrypted_secrets SET metadata_json='{} ' WHERE secret_ref='indodax.mainnet'");
    await expect(new CredentialVault(store, schema, env).load('indodax.mainnet')).rejects.toThrow('authenticated');
  });
  it('imports SQLite into PostgreSQL atomically, preserving event ids, money strings and sequence', async () => {
    const { store } = await database(), dir = await mkdtemp(path.join(os.tmpdir(), 'mpu-pg-import-')); tempDirs.push(dir);
    const file = path.join(dir, 'legacy.sqlite'), source = await RuntimeStore.open(file); stores.push(source);
    const at = new Date().toISOString();
    await source.execute("INSERT INTO accounts (account_ref,venue,network,mode,native_identity_hash,lifecycle_state,created_at,updated_at) VALUES ('fixture','indodax','mainnet','PAPER','fixture-hash','ACTIVE',?,?)", [at, at]);
    await source.append({ eventId: 'original-event', scope: 'fixture', kind: 'fixture', createdAt: at, correlationId: null, causationId: null, schemaVersion: 1, payload: { amount: '0.000000001234567890' } });
    const counts = await importSqlite(file, store); expect(counts.accounts).toBe(1); expect(counts.events).toBe(1);
    expect((await store.execute('SELECT payload_json FROM events')).rows[0].payload_json).toContain('0.000000001234567890');
    const next = await store.append({ eventId: 'next-event', scope: 'fixture', kind: 'fixture', createdAt: at, correlationId: null, causationId: null, schemaVersion: 1, payload: {} }); expect(next).toBe(2);
    await expect(importSqlite(file, store)).rejects.toThrow('not empty');
    expect((await source.execute('SELECT event_id FROM events')).rows).toHaveLength(1);
  });
  it('persists and executes a PAPER SL using PostgreSQL without any live sell', async () => {
    const { store } = await database(); let last = '100';
    const sell = vi.fn(), account = vi.fn();
    const service = await IndodaxStopService.open({ store, exchange: { account, sell,
      pair: async () => ({ symbol: 'BTCIDR', tickerId: 'btc_idr', asset: 'BTC', quote: 'IDR', maintenance: false, suspended: false, quantityIncrement: '0.1', minQuote: '1', minQuantity: '0.1' }),
      quote: async () => ({ last, observedAt: Date.now() }), lookup: vi.fn()
    } });
    await service.arm({ symbol: 'BTCIDR', quantity: '1', entry: '100', stop: '90' }); last = '90'; await service.tick();
    expect((await service.list())[0]).toMatchObject({ status: 'CLOSED', quantity: '0', protection: 'BOT_MANAGED' });
    expect(sell).not.toHaveBeenCalled(); expect(account).not.toHaveBeenCalled();
  });
  it('keeps dashboard credential responses masked and requires explicit LIVE activation', async () => {
    const { store, schema } = await database(), dir = await mkdtemp(path.join(os.tmpdir(), 'mpu-api-vault-')); tempDirs.push(dir);
    const master = path.join(dir, 'master'); await writeFile(master, randomBytes(32).toString('base64'), { mode: 0o600 });
    const env = { ...process.env, INDODAX_STOP_SCHEMA: schema, CREDENTIAL_MASTER_KEY_FILE: master };
    const account = vi.fn(async () => ({ identity: 'fixture-account', free: { BTC: '10' } })), sell = vi.fn();
    const app = express(); app.use(express.json());
    const controller = mountIndodaxStopRoutes(app, { env, exchangeFactory: () => ({ account, sell, pair: vi.fn(), quote: vi.fn(), lookup: vi.fn() }) });
    const profiles = new Map<string, SavedProviderProfile>();
    mountProviderProfileRoutes(app, { store, schema, env, profiles, settings: await SettingsService.initialize(store, new SecretStore()) });
    const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (url: string, body: unknown, origin?: string) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    try {
      const key = 'fixture_dashboard_api_key', secret = 'fixture_dashboard_api_secret';
      expect((await post('/api/indodax/credentials', { key, secret }, 'https://external.invalid')).status).toBe(403);
      const saved = await post('/api/indodax/credentials', { key, secret }); expect(saved.status).toBe(200);
      expect(JSON.stringify(await saved.json())).not.toContain(secret);
      const status = await (await fetch(base + '/api/indodax/credentials')).text(); expect(status).not.toContain(key); expect(status).not.toContain(secret);
      expect(account).not.toHaveBeenCalled(); expect(sell).not.toHaveBeenCalled();
      expect((await post('/api/indodax/stops/watch', { mode: 'LIVE' })).status).toBe(400); expect(account).not.toHaveBeenCalled();
      expect((await post('/api/indodax/credentials/check', {})).status).toBe(200); expect(account).toHaveBeenCalledTimes(1); expect(sell).not.toHaveBeenCalled();
      const provider = { provider: 'openai', protocol: 'responses', baseUrl: 'https://compatible.example/v1', model: 'fixture-model', apiKey: key };
      expect((await post('/api/providers', provider)).status).toBe(200);
      const providerStatus = await (await fetch(base + '/api/providers')).text(); expect(providerStatus).not.toContain(key); expect(providerStatus).toContain('responses');
      expect((await loadProviderProfiles(store, schema, env)).get('openai')).toMatchObject({ apiKey: key, protocol: 'responses' });
      expect((await post('/api/providers/apply', { provider: 'openai' })).status).toBe(200);
      expect((await post('/api/providers', { ...provider, baseUrl: 'https://user:password@example.test/v1' })).status).toBe(400);
      expect(JSON.stringify((await store.execute('SELECT * FROM encrypted_secrets')).rows)).not.toContain(key);
    } finally {
      await controller.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('rejects every LIVE stop action that lacks the exact typed confirmation', async () => {
    const { schema } = await database(), dir = await mkdtemp(path.join(os.tmpdir(), 'mpu-live-phrase-')); tempDirs.push(dir);
    const master = path.join(dir, 'master'); await writeFile(master, randomBytes(32).toString('base64'), { mode: 0o600 });
    const env = { ...process.env, INDODAX_STOP_SCHEMA: schema, CREDENTIAL_MASTER_KEY_FILE: master };
    const account = vi.fn(), sell = vi.fn();
    const app = express(); app.use(express.json());
    const controller = mountIndodaxStopRoutes(app, { env, exchangeFactory: () => ({ account, sell, pair: vi.fn(), quote: vi.fn(), lookup: vi.fn() }) });
    const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (url: string, body: unknown) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      for (const confirmation of [undefined, '', 'i understand live trades real money', 'I understand LIVE trades real money.']) {
        const extra = confirmation === undefined ? {} : { confirmation };
        expect((await post('/api/indodax/stops/arm', { symbol: 'BTCIDR', quantity: '1', entry: '100', stop: '90', mode: 'LIVE', ...extra })).status).toBe(400);
        expect((await post('/api/indodax/stops/disarm', { symbol: 'BTCIDR', mode: 'LIVE', ...extra })).status).toBe(400);
        expect((await post('/api/indodax/stops/watch', { mode: 'LIVE', ...extra })).status).toBe(400);
      }
      expect(account).not.toHaveBeenCalled(); expect(sell).not.toHaveBeenCalled();
    } finally {
      await controller.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('drops legacy bridge_* tables idempotently while keeping indodax_bot_stops intact', async () => {
    const { store, schema } = await database();
    const service = await IndodaxStopService.open({
      store,
      exchange: {
        account: vi.fn(), sell: vi.fn(),
        pair: async () => ({ symbol: 'BTCIDR', tickerId: 'btc_idr', asset: 'BTC', quote: 'IDR', maintenance: false, suspended: false, quantityIncrement: '0.1', minQuote: '1', minQuantity: '0.1' }),
        quote: async () => ({ last: '100', observedAt: Date.now() }), lookup: vi.fn()
      }
    });
    await service.arm({ symbol: 'BTCIDR', quantity: '1', entry: '100', stop: '90' });
    await store.execute('CREATE TABLE IF NOT EXISTS bridge_inbox (peer_id TEXT, event_id TEXT, PRIMARY KEY (peer_id, event_id))');
    await store.execute('CREATE TABLE IF NOT EXISTS bridge_outbox (peer_id TEXT, event_id TEXT, PRIMARY KEY (peer_id, event_id))');
    await store.execute('CREATE TABLE IF NOT EXISTS bridge_nonces (peer_id TEXT, key_id TEXT, nonce TEXT, PRIMARY KEY (peer_id, key_id, nonce))');
    await store.close();

    const reopened = await RuntimeStore.open({ schema });
    try {
      const tables = await reopened.execute(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE 'bridge_%'`,
        [schema]
      );
      expect(tables.rows).toHaveLength(0);
      const stops = await reopened.execute('SELECT status FROM indodax_bot_stops');
      expect(stops.rows).toEqual([{ status: 'ARMED' }]);
      const listed = await (await IndodaxStopService.open({
        store: reopened,
        exchange: { account: vi.fn(), sell: vi.fn(), pair: vi.fn(), quote: vi.fn(), lookup: vi.fn() }
      })).list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ symbol: 'BTCIDR', status: 'ARMED', stop: '90' });
    } finally {
      await reopened.close();
    }
  });
});
