import 'dotenv/config';
import { parseArgs } from 'node:util';
import { RuntimeStore, DEFAULT_DATABASE_SCHEMA } from '../server/v2/store/database.js';
import { IndodaxStopClient, IndodaxStopError } from '../server/v2/execution/indodax-client.js';
import { INDODAX_STOP_SCHEMA, IndodaxStopService, readIndodaxStops, type StopMode } from '../server/v2/execution/indodax-stops.js';
import { readKill, DEFAULT_KILL_FILE } from '../server/v2/kill-file.js';
import { registerSecrets } from '../server/redact.js';
import { CredentialVault } from '../server/v2/settings/vault.js';

const confirmation = 'I understand LIVE trades real money';
const help = `Trading Agent Mpu Gandring — Indodax bot-managed SL
  npm run indodax:stops -- arm BTCIDR --qty <asset amount> --entry <price> --stop <price>
  npm run indodax:stops -- watch [--interval-ms 3000]
  npm run indodax:stops -- status
  npm run indodax:stops -- disarm BTCIDR
  npm run indodax:stops -- doctor --mode LIVE
Default mode: PAPER. For LIVE arm/watch/disarm also type:
  --mode LIVE --confirm-live "${confirmation}"
LIVE sells adopted real assets automatically at the database SL; money can be lost.
Bot/computer/network/API outages disable execution. No exchange-side stop exists in this worker.
This worker cannot buy or open a new position. This is not financial advice.
Keys: save through the masked Indodax dashboard form (encrypted PostgreSQL vault), never chat or flags.`;

let store: RuntimeStore | null = null;
let service: IndodaxStopService | null = null;
let stopRequested = false;
let wake: (() => void) | undefined;
const stop = () => { stopRequested = true; wake?.(); };
try {
  const parsed = parseArgs({ allowPositionals: true, strict: true, options: {
    mode: { type: 'string' }, qty: { type: 'string' }, entry: { type: 'string' }, stop: { type: 'string' },
    'confirm-live': { type: 'string' }, 'interval-ms': { type: 'string' }, help: { type: 'boolean' }
  } });
  const [command, symbol, ...extra] = parsed.positionals;
  if (parsed.values.help || !command) {
    console.log(help);
  } else {
    const mode = (parsed.values.mode ?? 'PAPER').toUpperCase() as StopMode;
    if (!['PAPER', 'LIVE'].includes(mode)) throw new IndodaxStopError('Use PAPER or LIVE. No Indodax testnet is assumed.');
    if (!['arm', 'watch', 'status', 'disarm', 'doctor'].includes(command) || extra.length || (['arm', 'disarm'].includes(command) ? !symbol : Boolean(symbol))) throw new IndodaxStopError('Invalid stop command. Use --help.');
    const liveAcknowledged = parsed.values['confirm-live'] === confirmation;
    if (mode === 'LIVE' && ['arm', 'watch', 'disarm'].includes(command) && !liveAcknowledged) throw new IndodaxStopError(`LIVE sells real assets automatically and can lose money. Type --confirm-live "${confirmation}" yourself. This is not financial advice.`);
    const interval = Number(parsed.values['interval-ms'] ?? 3000);
    if (!Number.isInteger(interval) || interval < 1000 || interval > 60_000) throw new IndodaxStopError('Polling interval must be 1000–60000 milliseconds.');
    const schema = process.env.INDODAX_STOP_SCHEMA || INDODAX_STOP_SCHEMA;
    if (schema === (process.env.DATABASE_SCHEMA || DEFAULT_DATABASE_SCHEMA)) throw new IndodaxStopError('Use a separate PostgreSQL schema for Indodax stops and the USDT entry ledger.');
    const isKilled = () => stopRequested || readKill(process.env.KILL_SWITCH_FILE || DEFAULT_KILL_FILE) !== null;
    let credentials: Promise<{key: string; secret: string}> | undefined;
    const exchange = new IndodaxStopClient(() => credentials ??= (async () => {
      const db = await RuntimeStore.openPostgres({ schema });
      try {
        const value = await new CredentialVault(db, schema).load('indodax.mainnet');
        if (!value?.key || !value.secret) throw new IndodaxStopError('Save encrypted Indodax credentials in the dashboard first.');
        registerSecrets([value.key, value.secret]); return {key: value.key, secret: value.secret};
      } finally { await db.close(); }
    })(), fetch, Date.now, isKilled);
    if (command === 'doctor') {
      if (mode !== 'LIVE') throw new IndodaxStopError('Use doctor --mode LIVE for an explicitly requested private permission check. PAPER needs no account key.');
      await exchange.account();
      console.log(JSON.stringify({ ok: true, venue: 'indodax', canTrade: true, canWithdraw: false, canWithdrawFiat: false, protection: 'BOT_MANAGED', orderSubmitted: false }));
    } else {
      store = await RuntimeStore.openPostgres({ schema });
      if (command === 'status') {
        console.log(JSON.stringify({ venue: 'indodax', stops: await readIndodaxStops(store), note: 'A stored SL is not proof a worker is running; inspect workerHeartbeatAt.' }, null, 2));
      } else {
        service = await IndodaxStopService.open({ store, exchange, mode, liveAcknowledged, isKilled });
        if (command === 'arm') {
          if (!parsed.values.qty || !parsed.values.entry || !parsed.values.stop) throw new IndodaxStopError('arm requires --qty, --entry and --stop. Entry is your reference cost basis, not a verified fill.');
          await service.arm({ symbol, quantity: parsed.values.qty, entry: parsed.values.entry, stop: parsed.values.stop });
          console.log(JSON.stringify({ ok: true, mode, protection: 'BOT_MANAGED', stops: await service.list(), note: 'SL saved. Keep the matching watch process running for automatic execution.' }, null, 2));
        } else if (command === 'disarm') {
          await service.disarm(symbol);
          console.log(JSON.stringify({ ok: true, mode, protection: 'DISARMED', symbol, note: 'No sale submitted. This reference no longer protects the holding.' }));
        } else {
          process.once('SIGINT', stop); process.once('SIGTERM', stop);
          console.log(JSON.stringify({ worker: 'indodax-bot-stop', mode, intervalMs: interval, protection: 'BOT_MANAGED', note: mode === 'LIVE' ? 'Automatically sells adopted real holdings; losses are possible. Bot must stay running.' : 'Simulated sells only; no private order requests.' }));
          let previous = '';
          while (!stopRequested) {
            await service.tick();
            const stops = await service.list();
            const change = JSON.stringify(stops.map(({ workerHeartbeatAt: _heartbeat, ...r }) => r));
            if (change !== previous) { console.log(JSON.stringify({ at: Date.now(), mode, stops })); previous = change; }
            if (!stopRequested) await new Promise<void>(resolve => { const timer = setTimeout(() => { wake = undefined; resolve(); }, interval); wake = () => { clearTimeout(timer); wake = undefined; resolve(); }; });
          }
        }
      }
    }
  }
} catch (error) {
  console.error(error instanceof IndodaxStopError ? error.message : 'Indodax stop worker failed. No blind order retry; inspect database status before restarting.');
  process.exitCode = 2;
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  if (service) await service.markStopped().catch(() => { process.exitCode = 2; });
  await store?.close();
}
