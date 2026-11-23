import type { IndodaxCandle } from '../../shared/indodax.js';

/**
 * Advisory statistics for the Indodax PAPER agent, adapted from the KORO Math Atlas
 * (stock-recommendation/param). Only formulas that make sense for spot, long-only trading
 * on Indodax 4h/1d candles are kept. Left out on purpose:
 *  - shorts, MMR, funding, open interest, net leverage, halving and the outlier brake (futures only);
 *  - the 5m frames (Indodax has no 5m candle);
 *  - Amihud and V24 (Indodax does not document the candle Volume unit).
 * Nothing here places an order or relaxes a guard. Output is context for the agents.
 */

export interface EpisodeStats {
  n: number; wins: number; losses: number; breakeven: number;
  winRate: number; avgWin: number | null; avgLoss: number | null;
  payoffRR: number | null; profitFactor: number | null;
  expectancy: number; breakEvenWinRate: number | null; edgeWinRate: number | null;
  kellyRaw: number | null; maxDrawdown: number; recoveryFactor: number | null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Net result per closed episode (fees included) to performance ratios. Atlas 01. */
export function episodeStats(nets: number[]): EpisodeStats | null {
  const y = nets.filter(Number.isFinite);
  if (!y.length) return null;
  const pos = y.filter(v => v > 0), neg = y.filter(v => v < 0);
  const n = y.length, p = pos.length / n;
  const avgWin = pos.length ? sum(pos) / pos.length : null;
  const avgLoss = neg.length ? Math.abs(sum(neg)) / neg.length : null;
  const rr = avgWin !== null && avgLoss !== null ? avgWin / avgLoss : null;
  const grossLoss = Math.abs(sum(neg));
  let cum = 0, peak = 0, mdd = 0;
  for (const v of y) { cum += v; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
  const total = sum(y);
  const wrBe = rr === null ? null : 1 / (1 + rr);
  return {
    n, wins: pos.length, losses: neg.length, breakeven: n - pos.length - neg.length,
    winRate: p, avgWin, avgLoss, payoffRR: rr,
    profitFactor: grossLoss > 0 ? sum(pos) / grossLoss : null,
    expectancy: total / n,
    breakEvenWinRate: wrBe, edgeWinRate: wrBe === null ? null : p - wrBe,
    // Raw diagnostic from the sample, never a position size.
    kellyRaw: rr === null ? null : p - (1 - p) / rr,
    maxDrawdown: mdd, recoveryFactor: mdd > 0 ? total / mdd : null
  };
}

export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }
export const toBars = (candles: IndodaxCandle[]): Bar[] => candles.map(c => ({
  time: c.time, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume)
}));

const sampleVar = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = sum(xs) / xs.length;
  return sum(xs.map(v => (v - m) ** 2)) / (xs.length - 1);
};

export interface Character {
  atrp: number; zeroRate: number; rho1: number; varianceRatio: number; efficiencyRatio: number;
  z4: number; z24: number;
}

/** Atlas 02: character statistics on closed 4h candles. Needs W+1 candles, otherwise null. */
export function character(bars: Bar[], { N = 42, W = 180, q = 6 } = {}): Character | null {
  if (bars.length < W + 1 || bars.length < N + 1) return null;
  const b = bars.slice(-(W + 1));
  if (b.some(x => !(x.close > 0) || !(x.high > 0) || !(x.low > 0))) return null;
  const r = b.slice(1).map((x, i) => Math.log(x.close / b[i].close)); // W returns
  const tail = b.slice(-(N + 1));
  const atrp = sum(tail.slice(1).map((x, i) => Math.max(x.high - x.low, Math.abs(x.high - tail[i].close), Math.abs(x.low - tail[i].close)) / x.close)) / N;
  const zeroRate = tail.slice(1).filter(x => x.volume === 0).length / N;
  const xs = r.slice(0, -1), ys = r.slice(1);
  const mx = sum(xs) / xs.length, my = sum(ys) / ys.length;
  const denom = Math.sqrt(sum(xs.map(v => (v - mx) ** 2)) * sum(ys.map(v => (v - my) ** 2)));
  const rho1 = denom > 0 ? sum(xs.map((v, i) => (v - mx) * (ys[i] - my))) / denom : NaN;
  const rq = Array.from({ length: r.length - q + 1 }, (_, i) => sum(r.slice(i, i + q)));
  const vr = sampleVar(rq) / (q * sampleVar(r));
  const path = sum(tail.slice(1).map((x, i) => Math.abs(x.close - tail[i].close)));
  const er = path > 0 ? Math.abs(tail[N].close - tail[0].close) / path : NaN;
  const last = b[W].close;
  const z4 = Math.log(last / b[W - 1].close) / atrp;
  const z24 = Math.log(last / b[W - q].close) / (atrp * Math.sqrt(q));
  const out = { atrp, zeroRate, rho1, varianceRatio: vr, efficiencyRatio: er, z4, z24 };
  return Object.values(out).every(Number.isFinite) && atrp > 0 ? out : null;
}

export type SpotRoute = 'TF_LONG' | 'MR_LONG' | 'NO_SPOT_ACTION' | 'INVALID';
export interface Routing {
  route: SpotRoute; obvSlopeSign: -1 | 0 | 1; priceDirection: -1 | 0 | 1;
  pullbackLong: boolean | null; extensionAtr: number | null;
}

/** Atlas 03 without OI/funding: OBV slope over the last 48 closed bars decides TF or MR. */
export function routeSpot(bars: Bar[]): Routing | null {
  const m = 48;
  if (bars.length < m + 1) return null;
  const w = bars.slice(-(m + 1));
  const obv: number[] = [0];
  for (let t = 1; t <= m; t++) obv.push(obv[t - 1] + Math.sign(w[t].close - w[t - 1].close) * w[t].volume);
  const series = obv.slice(1); // 48 observations, first started from 0
  const mean = sum(series) / m;
  let num = 0, den = 0;
  series.forEach((v, j) => { num += (j - 23.5) * (v - mean); den += (j - 23.5) ** 2; });
  const slope = Math.sign(num / den) as -1 | 0 | 1;
  // The atlas does not define the price direction window; the same 48 bars are assumed here.
  const price = Math.sign(w[m].close - w[1].close) as -1 | 0 | 1;
  if (!slope || !price) return { route: 'INVALID', obvSlopeSign: slope, priceDirection: price, pullbackLong: null, extensionAtr: null };
  let ema = bars[0].close, atr = 0;
  bars.forEach((x, i) => {
    if (i === 0) { atr = x.high - x.low; return; }
    ema += (2 / 22) * (x.close - ema);
    atr += (Math.max(x.high - x.low, Math.abs(x.high - bars[i - 1].close), Math.abs(x.low - bars[i - 1].close)) - atr) / 14;
  });
  const last = bars.at(-1)!, prev = bars.at(-2)!;
  const extension = atr > 0 ? Math.abs(last.close - ema) / atr : null;
  const touch = (last.low <= ema && ema <= last.high) || last.close <= ema;
  const pullbackLong = extension === null ? null : last.close < prev.close && touch && extension <= 0.5;
  const route: SpotRoute = slope > 0 ? (price > 0 ? 'TF_LONG' : 'MR_LONG') : 'NO_SPOT_ACTION';
  return { route, obvSlopeSign: slope, priceDirection: price, pullbackLong, extensionAtr: extension };
}

export interface FeeRates { taker: number; maker: number }
/** Atlas 05 fee gate: net round trip per unit must exceed 0.1% of the entry price. */
export const ROUND_TRIP_MIN_EDGE = 0.001;
export function roundTripNetPerUnit(entry: number, exit: number, feeIn: number, feeOut: number): number {
  return (exit - entry) - entry * feeIn - exit * feeOut;
}
/** Lowest exit price whose net round trip clears the fee gate. */
export function minTargetPrice(entry: number, feeIn: number, feeOut: number, minEdge = ROUND_TRIP_MIN_EDGE): number {
  return entry * (1 + feeIn + minEdge) / (1 - feeOut);
}
