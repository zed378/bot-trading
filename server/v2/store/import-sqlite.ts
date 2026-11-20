import { DatabaseSync } from 'node:sqlite';
import type { SqlValue } from '../contracts.js';
import type { RuntimeStore } from './database.js';
import { SCHEMA_STATEMENTS } from './schema.js';

const TABLES = SCHEMA_STATEMENTS.map(s => s.match(/^CREATE TABLE IF NOT EXISTS ([a-z_]+)/)?.[1]).filter((s): s is string => Boolean(s) && s !== 'schema_migrations');
function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Unsupported migration identifier.');
  return `"${value}"`;
}
/** SQLite is a read-only migration source. Import is atomic and refuses any nonempty destination. */
export async function importSqlite(source: string, target?: RuntimeStore): Promise<Record<string, number>> {
  const sqlite = new DatabaseSync(source, { readOnly: true });
  try {
    sqlite.exec('BEGIN');
    const available = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).map(r => String(r.name)));
    const tables = TABLES.filter(t => available.has(t));
    const counts = Object.fromEntries(tables.map(t => [t, Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${identifier(t)}`).get()?.n ?? 0)]));
    if (!target) return counts;
    await target.transaction(async tx => {
      for (const table of TABLES) {
        if (Number((await tx.execute(`SELECT COUNT(*) AS n FROM ${identifier(table)}`)).rows[0].n) !== 0) throw new Error('Migration target is not empty; existing PostgreSQL data will not be overwritten.');
      }
      for (const table of tables) {
        const statement = sqlite.prepare(`SELECT * FROM ${identifier(table)}`); statement.setReadBigInts(true);
        for (const row of statement.iterate()) {
          const columns = Object.keys(row);
          const args = columns.map(c => row[c]) as SqlValue[];
          const result = await tx.execute(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(',')}) VALUES (${columns.map(() => '?').join(',')}) RETURNING *`, args);
          for (const c of columns) {
            const old = row[c], inserted = result.rows[0][c];
            if (old === null ? inserted !== null : old instanceof Uint8Array ? Buffer.compare(Buffer.from(old), Buffer.from(inserted as Uint8Array)) !== 0 : String(old) !== String(inserted)) throw new Error('Imported row verification failed; transaction rolled back.');
          }
        }
        if (Number((await tx.execute(`SELECT COUNT(*) AS n FROM ${identifier(table)}`)).rows[0].n) !== counts[table]) throw new Error('Imported row count mismatch; transaction rolled back.');
      }
      await tx.execute("SELECT setval(pg_get_serial_sequence('events','seq'), COALESCE(MAX(seq),1), COUNT(*)>0) FROM events");
    });
    return counts;
  } finally { sqlite.close(); }
}
