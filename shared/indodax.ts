/** Public Indodax observations. Decimal strings retain the venue's precision. */
export const INDODAX_TIMEFRAMES = ['4h', '1d'] as const;
export type IndodaxTimeframe = typeof INDODAX_TIMEFRAMES[number];
export interface IndodaxPair {
  symbol: string;
  tickerId: string;
  asset: string;
  quote: 'IDR' | 'USDT';
  maintenance: boolean;
  suspended: boolean;
  quantityIncrement: string | null;
  minQuote: string | null;
  minQuantity: string | null;
}
export interface IndodaxCandle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}
export interface IndodaxMarket {
  venue: 'indodax';
  marketType: 'spot';
  access: 'public-read-only';
  executionSupported: false;
  example: false;
  pair: IndodaxPair;
  timeframe: IndodaxTimeframe;
  last: string;
  bid: string;
  ask: string;
  observedAt: number;
  candles: IndodaxCandle[];
  sources: { ticker: string; book: string; candles: string; pairs: string };
}

export interface IndodaxAnalysis extends IndodaxMarket {
  indicators: { ema20: number; ema50: number | null; rsi14: number; trend: 'BULLISH' | 'BEARISH' | 'MIXED' };
}
