import 'dotenv/config';
import { parseArgs } from 'node:util';
import { RuntimeStore } from '../server/v2/store/database.js';
import { importSqlite } from '../server/v2/store/import-sqlite.js';
let target: RuntimeStore | undefined;
try {
  const { values } = parseArgs({ strict: true, options: { source: { type: 'string' }, schema: { type: 'string', default: 'desk' }, apply: { type: 'boolean', default: false } } });
  if (!values.source) throw new Error('source required');
  if (values.apply) target = await RuntimeStore.openPostgres({ schema: values.schema });
  const counts = await importSqlite(values.source, target);
  console.log(JSON.stringify({ ok: true, applied: values.apply, targetSchema: values.schema, rows: counts, note: values.apply ? 'Import committed and verified; the SQLite source is unchanged.' : 'Dry run only. Add --apply after stopping the old runtime and backing up SQLite (including WAL/SHM).' }, null, 2));
} catch {
  console.error('PostgreSQL migration failed. Check source availability, PostgreSQL 18 connection and an empty destination schema. No target overwrite or source deletion was performed.');
  process.exitCode = 2;
} finally { await target?.close(); }
