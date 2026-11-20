import { IndodaxPublicClient, IndodaxDataError } from '../server/market/indodax.js';
import { analyzeIndodax } from '../server/v2/api/indodax.js';
import { INDODAX_TIMEFRAMES, type IndodaxTimeframe } from '../shared/indodax.js';

// Public reads only; intentionally does not load .env or initialize the trading runtime.
const [command, symbol, tf = '4h', ...extra] = process.argv.slice(2);
try {
  const client = new IndodaxPublicClient();
  if (command === 'pairs' && !symbol) {
    console.log(JSON.stringify({ venue: 'indodax', executionSupported: false, pairs: await client.pairs() }, null, 2));
  } else if (command === 'analyze' && symbol && !extra.length && (INDODAX_TIMEFRAMES as readonly string[]).includes(tf)) {
    console.log(JSON.stringify(await analyzeIndodax(client, symbol, tf as IndodaxTimeframe), null, 2));
  } else {
    console.error('Trading Agent Mpu Gandring: npm run indodax -- pairs | analyze BTCIDR [4h|1d]. Public analysis only; no orders.');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof IndodaxDataError ? error.message : 'Indodax public data unavailable.');
  process.exitCode = 2;
}
