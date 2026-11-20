import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg, { type PoolClient, type PoolConfig, type QueryResult as PgResult } from 'pg';
import type { DomainEvent, QueryResult, SqlValue, StoreTransaction } from '../contracts.js';
import { registerSecrets } from '../../redact.js';
import { prepareDomainEvent } from './events.js';
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from './schema.js';
import { StoreConflictError, StoreWriteError } from './errors.js';
export { StoreConflictError, StoreWriteError } from './errors.js';

/** Legacy source location, retained for migration and historical fixture tests only. */
export const DEFAULT_STORE_FILE = path.resolve('.mpu-gandring/rebirth/runtime.sqlite');
export const DEFAULT_DATABASE_SCHEMA = 'desk';
export interface PostgresStoreOptions { schema?: string; env?: NodeJS.ProcessEnv }
interface Backend {
  readonly filePath: string;
  execute(sql: string, args?: SqlValue[]): Promise<QueryResult>;
  transaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T>;
  append(event: DomainEvent): Promise<number>;
  simulateWriteFailure(reason: string | null): void;
  close(): Promise<void>;
  pragmas?(): Promise<{ foreignKeys: number; journalMode: string; synchronous: number }>;
}

/** Convert legacy parameter markers, preserving quoted text, identifiers and comments. */
export function postgresParameters(sql: string, count: number): string {
  let out = '', index = 0, state: 'normal' | 'single' | 'double' | 'line' | 'block' = 'normal';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (state === 'single' || state === 'double') {
      out += c;
      const quote = state === 'single' ? "'" : '"';
      if (c === quote) { if (next === quote) { out += next; i++; } else state = 'normal'; }
    } else if (state === 'line') { out += c; if (c === '\n') state = 'normal'; }
    else if (state === 'block') { out += c; if (c === '*' && next === '/') { out += next; i++; state = 'normal'; } }
    else if (c === "'") { out += c; state = 'single'; }
    else if (c === '"') { out += c; state = 'double'; }
    else if (c === '-' && next === '-') { out += '--'; i++; state = 'line'; }
    else if (c === '/' && next === '*') { out += '/*'; i++; state = 'block'; }
    else if (c === '?') out += `$${++index}`;
    else out += c;
  }
  if (index !== count && !(index === 0 && /\$\d+/.test(sql))) throw new StoreWriteError('SQL parameter count mismatch.');
  return out;
}
function result(rs: PgResult): QueryResult {
  return { rowsAffected: rs.rowCount ?? 0, rows: rs.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? null : value instanceof Buffer ? new Uint8Array(value) : typeof value === 'object' ? JSON.stringify(value) : value])) as Record<string, SqlValue>) };
}
function dbError(error: unknown, write = false): Error {
  if (error instanceof StoreConflictError || error instanceof StoreWriteError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNAVAILABLE';
  if (code === '23505') return new StoreConflictError('PostgreSQL unique constraint conflict.');
  if (code === '23503') return new StoreWriteError('PostgreSQL foreign key constraint failed.');
  if (code === '23514') return new StoreWriteError('PostgreSQL check constraint failed.');
  // Do not include driver details: they can contain connection strings, credentials or row data.
  return new StoreWriteError(`PostgreSQL ${write ? 'write' : 'operation'} failed (${/^[A-Z0-9_]+$/i.test(code) ? code : 'UNAVAILABLE'}).`);
}
function writeSql(sql: string) { return /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql); }

class PostgresBackend implements Backend {
  readonly filePath: string;
  private fault: string | null = null;
  private closed = false;
  private lock: Promise<void> = Promise.resolve();
  private constructor(private readonly pool: pg.Pool, readonly schema: string) { this.filePath = `postgresql:${schema}`; }

  static async open(options: PostgresStoreOptions): Promise<PostgresBackend> {
    const env = options.env ?? process.env, schema = options.schema ?? env.DATABASE_SCHEMA ?? DEFAULT_DATABASE_SCHEMA;
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new StoreWriteError('Invalid PostgreSQL schema name.');
    let password = env.PGPASSWORD;
    if (env.DATABASE_PASSWORD_FILE) {
      try { password = readFileSync(env.DATABASE_PASSWORD_FILE, 'utf8').trim(); }
      catch { throw new StoreWriteError('PostgreSQL password secret file is unavailable.'); }
    }
    if (!env.DATABASE_URL && (!env.PGHOST || !env.PGUSER || !env.PGDATABASE || !password)) throw new StoreWriteError('PostgreSQL 18 is required. Start Docker Compose or configure DATABASE_URL / PGHOST, PGUSER, PGDATABASE and DATABASE_PASSWORD_FILE. No SQLite fallback.');
    registerSecrets([env.DATABASE_URL, password]);
    if (env.DATABASE_URL) { try { registerSecrets([decodeURIComponent(new URL(env.DATABASE_URL).password)]); } catch { throw new StoreWriteError('Invalid PostgreSQL connection configuration.'); } }
    const config: PoolConfig = {
      ...(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : { host: env.PGHOST, port: Number(env.PGPORT || 5432), user: env.PGUSER, database: env.PGDATABASE, password }),
      max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000,
      options: `-c search_path=${schema} -c synchronous_commit=on -c statement_timeout=30000 -c lock_timeout=5000`
    };
    const pool = new pg.Pool(config);
    // Idle socket errors must not crash a running protection monitor; next operation fails closed.
    pool.on('error', () => {});
    const store = new PostgresBackend(pool, schema);
    try {
      const version = await pool.query('SHOW server_version_num');
      const number = Number(version.rows[0]?.server_version_num);
      if (number < 180000 || number >= 190000 || !Number.isFinite(number)) throw new StoreWriteError('This runtime requires PostgreSQL major version 18.');
      const durability = await pool.query('SHOW fsync');
      if (durability.rows[0]?.fsync !== 'on') throw new StoreWriteError('PostgreSQL fsync must be enabled.');
      await store.transaction(async tx => {
        const namespace = await tx.execute('SELECT 1 FROM pg_namespace WHERE nspname=?', [schema]);
        if (!namespace.rows.length) await tx.execute(`CREATE SCHEMA "${schema}"`);
        for (const ddl of SCHEMA_STATEMENTS) await tx.execute(ddl);
        const now = new Date().toISOString();
        await tx.execute('INSERT INTO schema_migrations (version, applied_at, backup_manifest_json) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [SCHEMA_VERSION, now, null]);
        await tx.execute("UPDATE config_applies SET status='FAILED', reason='Recovered interrupted PREPARING config apply on startup', updated_at=? WHERE status='PREPARING'", [now]);
      });
      return store;
    } catch (error) { await pool.end(); throw dbError(error); }
  }
  simulateWriteFailure(reason: string | null) { this.fault = reason; }
  private assertWritable() { if (this.closed) throw new StoreWriteError('RuntimeStore is closed.'); if (this.fault) throw new StoreWriteError(this.fault); }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock; let release!: () => void;
    this.lock = new Promise<void>(resolve => { release = resolve; });
    await previous; try { return await fn(); } finally { release(); }
  }
  private async query(client: PoolClient, sql: string, args: SqlValue[] = []): Promise<QueryResult> {
    if (writeSql(sql)) this.assertWritable();
    try { return result(await client.query(postgresParameters(sql, args.length), args.map(a => a instanceof Uint8Array ? Buffer.from(a) : typeof a === 'bigint' ? a.toString() : a))); }
    catch (error) { throw dbError(error, writeSql(sql)); }
  }
  async execute(sql: string, args: SqlValue[] = []): Promise<QueryResult> {
    if (writeSql(sql)) return this.transaction(tx => tx.execute(sql, args));
    if (this.closed) throw new StoreWriteError('RuntimeStore is closed.');
    let client: PoolClient | undefined;
    try { client = await this.pool.connect(); return await this.query(client, sql, args); }
    catch (error) { throw dbError(error); } finally { client?.release(); }
  }
  async transaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    this.assertWritable();
    return this.exclusive(async () => {
      this.assertWritable(); let client: PoolClient | undefined; let callbackError = false;
      try {
        client = await this.pool.connect(); await client.query('BEGIN');
        // Preserve the single-writer invariant across containers, not just within one Node process.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended(current_database() || $1, 0))', [`.${this.schema}`]);
        const connection = client;
        const tx: StoreTransaction = { execute: (sql, args = []) => this.query(connection, sql, args), append: async event => {
          const prepared = prepareDomainEvent(event);
          const existing = await tx.execute('SELECT seq, payload_digest FROM events WHERE event_id=?', [prepared.eventId]);
          if (existing.rows.length) {
            if (String(existing.rows[0].payload_digest) !== prepared.payloadDigest) throw new StoreConflictError('Conflicting event payload for the same event id.');
            return Number(existing.rows[0].seq);
          }
          const inserted = await tx.execute(`INSERT INTO events (event_id,scope,kind,created_at,correlation_id,causation_id,schema_version,payload_json,payload_digest) VALUES (?,?,?,?,?,?,?,?,?) RETURNING seq`, [prepared.eventId, prepared.scope, prepared.kind, prepared.createdAt, prepared.correlationId, prepared.causationId, prepared.schemaVersion, prepared.payloadJson, prepared.payloadDigest]);
          return Number(inserted.rows[0].seq);
        } };
        const value = await fn(tx).catch(error => { callbackError = true; throw error; }); this.assertWritable(); await client.query('COMMIT'); return value;
      } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); throw callbackError ? error : dbError(error, true); }
      finally { client?.release(); }
    });
  }
  append(event: DomainEvent) { return this.transaction(tx => tx.append(event)); }
  async close() { if (this.closed) return; await this.exclusive(async () => { this.closed = true; await this.pool.end(); }); }
}

/** Production uses PostgreSQL 18 only. SQLite is an explicit historical test fixture adapter. */
export class RuntimeStore implements Backend {
  private constructor(private readonly backend: Backend) {}
  get filePath() { return this.backend.filePath; }
  static async open(options?: string | PostgresStoreOptions): Promise<RuntimeStore> {
    if (typeof options === 'string' || (options === undefined && process.env.VITEST === 'true' && !process.env.DATABASE_URL && !process.env.PGHOST)) {
      if (process.env.VITEST !== 'true') throw new StoreWriteError('SQLite runtime storage has been retired. Use PostgreSQL 18; import old files with db:migrate.');
      const { SqliteTestStore } = await import('./sqlite-test-store.js');
      return new RuntimeStore(await SqliteTestStore.open(typeof options === 'string' ? options : DEFAULT_STORE_FILE));
    }
    return new RuntimeStore(await PostgresBackend.open(options ?? {}));
  }
  static openPostgres(options: PostgresStoreOptions = {}) { return this.open(options); }
  execute(sql: string, args: SqlValue[] = []) { return this.backend.execute(sql, args); }
  transaction<T>(fn: (tx: StoreTransaction) => Promise<T>) { return this.backend.transaction(fn); }
  append(event: DomainEvent) { return this.backend.append(event); }
  simulateWriteFailure(reason: string | null) { this.backend.simulateWriteFailure(reason); }
  pragmas() { if (!this.backend.pragmas) throw new StoreWriteError('PostgreSQL uses durable transactions and foreign keys; SQLite PRAGMA is not available.'); return this.backend.pragmas(); }
  close() { return this.backend.close(); }
}
