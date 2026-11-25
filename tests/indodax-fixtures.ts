import { IndodaxPublicClient } from '../server/market/indodax.js';
import type { IndodaxMarket, IndodaxPair } from '../shared/indodax.js';

export const pairOf = (symbol: string): IndodaxPair => {
  const quote = symbol.endsWith('IDR') ? 'IDR' : 'USDT';
  const asset = symbol.slice(0, -quote.length);
  return { symbol, tickerId: `${asset.toLowerCase()}_${quote.toLowerCase()}`, asset, quote, maintenance: false, suspended: false, quantityIncrement: '0.01', minQuote: '1', minQuantity: '0.01', feeTakerPct: '0.3', feeMakerPct: null };
};

/** Offline Indodax client: lists the given pairs and serves a flat, closed 4h market for each. */
export class FakeIndodaxClient extends IndodaxPublicClient {
  constructor(readonly listed: string[] = ['BTCIDR', 'BTCUSDT'], private readonly observedAt = Date.now(), private bid = '99') { super(); }
  setBid(bid: string) { this.bid = bid; }
  async pairs() { return this.listed.map(pairOf); }
  async market(input: string): Promise<IndodaxMarket> {
    const symbol = input.toUpperCase();
    if (!this.listed.includes(symbol)) throw new Error('Pair is not listed in Indodax public metadata.');
    const candles = Array.from({ length: 60 }, (_, i) => ({ time: 1_700_000_000 + i * 14_400, open: '100', high: '102', low: '98', close: '100', volume: '10' }));
    return {
      venue: 'indodax', marketType: 'spot', access: 'public-read-only', executionSupported: false, example: false,
      pair: pairOf(symbol), timeframe: '4h', last: '100', bid: this.bid, ask: '101', observedAt: this.observedAt, candles,
      sources: { ticker: 'x', book: 'x', candles: 'x', pairs: 'x' }
    };
  }
}
