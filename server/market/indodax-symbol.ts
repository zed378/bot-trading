import type { IndodaxPair } from '../../shared/indodax.js';
import { IndodaxDataError, indodaxSymbol, type IndodaxPublicClient } from './indodax.js';

/**
 * Resolves user input against the Indodax pair list. The listing, not the spelling, decides:
 * BTCUSDT is a valid Indodax pair and also a symbol on other venues.
 */
export async function resolveIndodaxSymbol(client: Pick<IndodaxPublicClient, 'pairs'>, input: string): Promise<IndodaxPair> {
  const symbol = indodaxSymbol(input);
  const pair = (await client.pairs()).find((p) => p.symbol === symbol);
  if (!pair) throw new IndodaxDataError(`${symbol} is not a pair listed on Indodax.`, 'input');
  if (pair.maintenance || pair.suspended) throw new IndodaxDataError(`Indodax reports ${symbol} in maintenance or suspended.`);
  return pair;
}
