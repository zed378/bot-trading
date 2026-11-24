import { z } from 'zod';
import { INDODAX_TIMEFRAMES } from './indodax.js';

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const positive = decimal.refine((v) => Number(v) > 0);
const PERIOD_SECONDS = { '4h': 14_400, '1d': 86_400 } as const;

const candle = z.object({
  time: z.number().int().positive(),
  open: positive, high: positive, low: positive, close: positive,
  volume: decimal
}).strict();

/**
 * The single description of the market an agent cycle is allowed to reason about.
 * Every cycle (Office debate, `analyze`, PAPER session) receives this and nothing else about the venue.
 */
export const IndodaxContextSchema = z.object({
  venue: z.literal('Indodax'),
  marketType: z.literal('spot'),
  symbol: z.string().regex(/^[A-Z0-9]{1,20}(?:IDR|USDT)$/),
  asset: z.string().regex(/^[A-Z0-9]{1,20}$/),
  quote: z.enum(['IDR', 'USDT']),
  timeframe: z.enum(INDODAX_TIMEFRAMES),
  last: positive,
  bid: positive,
  ask: positive,
  observedAt: z.number().int().positive(),
  fee: z.object({ takerPct: decimal.nullable(), makerPct: decimal.nullable() }).strict(),
  rules: z.object({ quantityIncrement: decimal.nullable(), minQuote: decimal.nullable(), minQuantity: decimal.nullable() }).strict(),
  indicators: z.object({
    ema20: z.number().finite(), ema50: z.number().finite().nullable(), rsi14: z.number().finite(),
    trend: z.enum(['BULLISH', 'BEARISH', 'MIXED'])
  }).strict(),
  candles: z.array(candle).min(1).max(200),
  advisory: z.object({
    character: z.looseObject({}).nullable(),
    spotRoute: z.looseObject({}).nullable(),
    takerFeePct: decimal.nullable(),
    minTakeProfit: decimal.nullable()
  }).strict(),
  constraints: z.string().min(1)
}).strict().superRefine((c, ctx) => {
  const issue = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: 'custom', message, path });
  if (!c.symbol.endsWith(c.quote)) issue('symbol does not end with the quote currency', ['quote']);
  if (c.symbol !== `${c.asset}${c.quote}`) issue('symbol does not match asset and quote', ['symbol']);
  if (Number(c.bid) > Number(c.ask)) issue('bid is above ask', ['bid']);
  const period = PERIOD_SECONDS[c.timeframe];
  c.candles.forEach((bar, i) => {
    if (i > 0 && bar.time <= c.candles[i - 1].time) issue('candles must be strictly ascending', ['candles', i, 'time']);
  });
  const last = c.candles.at(-1);
  if (last && last.time + period > c.observedAt / 1000) issue('the latest candle has not closed yet', ['candles', c.candles.length - 1, 'time']);
});
export type IndodaxContext = z.infer<typeof IndodaxContextSchema>;

/**
 * Venue-level rules stated to every agent. Written as what is possible, so the text never has to name
 * instruments or order types that do not exist on Indodax spot.
 */
export function indodaxConstraints(quote: 'IDR' | 'USDT', timeframe: typeof INDODAX_TIMEFRAMES[number]): string {
  return `Venue: Indodax spot. Prices, balances and order sizes are in ${quote}; IDR and USDT pairs are never converted or mixed. ` +
    `Candles are closed ${timeframe} candles. The only actions are buying (LONG), holding (HOLD) and selling an existing holding (CLOSE), ` +
    `all as market orders at the quoted ask or bid. Every entry needs a stop price below the ask; a take profit is optional. ` +
    `When advisory.takerFeePct is set, a take profit below advisory.minTakeProfit does not cover round-trip fees and is rejected.`;
}

/** Added by the PAPER session on top of the venue rules. */
export const INDODAX_PAPER_CONSTRAINTS =
  'Paper session: at most half of the remaining paper cash goes into one entry, and every fill pays the pair taker fee on both legs.';
