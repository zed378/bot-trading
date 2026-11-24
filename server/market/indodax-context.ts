import { IndodaxContextSchema, indodaxConstraints, type IndodaxContext } from '../../shared/indodax-context.js';
import type { IndodaxCandle, IndodaxTimeframe } from '../../shared/indodax.js';
import type { IndodaxPublicClient } from './indodax.js';
import { analyzeIndodax } from './indodax-analysis.js';
import { character, minTargetPrice, routeSpot, toBars } from './indodax-params.js';
import { analyzeSMC } from './smc.js';

/** Swing structure from the closed candles: trend, last break and the swing levels a stop can sit beyond. */
function structureOf(symbol: string, timeframe: IndodaxTimeframe, candles: IndodaxCandle[]) {
  const smc = analyzeSMC(
    candles.map((c) => ({ timestamp: c.time * 1000, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) })),
    { symbol, tf: timeframe }
  );
  if (!smc) return null;
  return {
    trend: smc.marketTrend,
    lastBreak: smc.lastBreak ? { type: smc.lastBreak.type, price: smc.lastBreak.price } : null,
    recentSwingLows: smc.recentSwingLows.slice(-2).map((p) => p.price),
    recentSwingHighs: smc.recentSwingHighs.slice(-2).map((p) => p.price),
    zone: smc.premiumDiscountZone.currentZone
  };
}

/** Number#toString switches to exponent notation for very small values, which the decimal schema rejects. */
function plainDecimal(value: number): string {
  const rounded = Number(value.toPrecision(8));
  return /e/i.test(String(rounded)) ? rounded.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : String(rounded);
}

/**
 * The only way to build the market description for an agent cycle. `client.market` already rejects
 * unlisted, maintenance and suspended pairs, stale data and unclosed candles.
 */
export async function buildIndodaxContext(
  client: Pick<IndodaxPublicClient, 'market'>,
  symbol: string,
  timeframe: IndodaxTimeframe = '4h'
): Promise<IndodaxContext> {
  const market = await analyzeIndodax(client, symbol, timeframe);
  const bars = toBars(market.candles);
  const taker = market.pair.feeTakerPct ? Number(market.pair.feeTakerPct) / 100 : null;
  return IndodaxContextSchema.parse({
    venue: 'Indodax',
    marketType: 'spot',
    symbol: market.pair.symbol,
    asset: market.pair.asset,
    quote: market.pair.quote,
    timeframe,
    last: market.last,
    bid: market.bid,
    ask: market.ask,
    observedAt: market.observedAt,
    fee: { takerPct: market.pair.feeTakerPct ?? null, makerPct: market.pair.feeMakerPct ?? null },
    rules: { quantityIncrement: market.pair.quantityIncrement, minQuote: market.pair.minQuote, minQuantity: market.pair.minQuantity },
    indicators: market.indicators,
    candles: market.candles.slice(-40),
    advisory: {
      // KORO Math Atlas subset. Context only; it never changes order size or relaxes a guard.
      character: character(bars),
      spotRoute: routeSpot(bars),
      structure: structureOf(market.pair.symbol, timeframe, market.candles),
      takerFeePct: market.pair.feeTakerPct ?? null,
      minTakeProfit: taker === null ? null : plainDecimal(minTargetPrice(Number(market.ask), taker, taker))
    },
    constraints: indodaxConstraints(market.pair.quote, timeframe)
  });
}

/** Flat object handed to the agent runner as `marketSummary`. */
export function indodaxPromptSummary(context: IndodaxContext) {
  return {
    venue: context.venue,
    marketType: context.marketType,
    symbol: context.symbol,
    quoteCurrency: context.quote,
    timeframe: context.timeframe,
    last: context.last,
    bid: context.bid,
    ask: context.ask,
    observedAt: context.observedAt,
    indicators: context.indicators,
    candles: context.candles,
    advisory: context.advisory,
    constraints: context.constraints
  };
}
