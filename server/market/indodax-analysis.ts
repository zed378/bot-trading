import type { IndodaxAnalysis, IndodaxTimeframe } from '../../shared/indodax.js';
import { ema, rsi } from './indicators.js';
import type { IndodaxPublicClient } from './indodax.js';

export async function analyzeIndodax(client: Pick<IndodaxPublicClient, 'market'>, symbol: string, tf: IndodaxTimeframe): Promise<IndodaxAnalysis> {
  const market = await client.market(symbol, tf);
  const closes = market.candles.map(c => Number(c.close));
  const ema20 = ema(closes, 20).at(-1)!;
  const ema50 = closes.length >= 50 ? ema(closes, 50).at(-1)! : null;
  const lastClose = closes.at(-1)!;
  const trend = ema50 === null ? 'MIXED' : lastClose > ema20 && ema20 > ema50 ? 'BULLISH' : lastClose < ema20 && ema20 < ema50 ? 'BEARISH' : 'MIXED';
  return { ...market, indicators: { ema20, ema50, rsi14: rsi(closes), trend } };
}
