import { describe, expect, it } from 'vitest';
import { character, episodeStats, minTargetPrice, roundTripNetPerUnit, routeSpot, type Bar } from '../server/market/indodax-params.js';

const bar = (i: number, close: number, spread = 1, volume = 10): Bar => ({ time: i * 14_400, open: close, high: close + spread, low: close - spread, close, volume });
// Deterministic pseudo-random walk, no Math.random so the test is stable.
const walk = (n: number, drift: number) => {
  let seed = 7, price = 100;
  return Array.from({ length: n }, (_, i) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    price *= 1 + drift + ((seed / 2 ** 31) - 0.5) * 0.02;
    return bar(i, price);
  });
};

describe('Indodax atlas parameters', () => {
  it('reproduces the atlas 24h episode example', () => {
    const nets = [...Array(28).fill(0.27079695), ...Array(12).fill(-0.26528646)];
    const s = episodeStats(nets)!;
    expect(s.n).toBe(40);
    expect(s.winRate).toBeCloseTo(0.7, 10);
    expect(s.payoffRR).toBeCloseTo(1.02077, 4);
    expect(s.profitFactor).toBeCloseTo(2.3818, 3);
    expect(s.kellyRaw).toBeCloseTo(0.4061, 3);
    expect(s.breakEvenWinRate).toBeCloseTo(0.4949, 3);
    expect(s.edgeWinRate).toBeCloseTo(0.2051, 3);
    expect(s.expectancy).toBeCloseTo(0.109971924, 8);
  });

  it('measures drawdown on the cumulative episode curve', () => {
    const s = episodeStats([1, -2, 1, -1, 3])!;
    expect(s.maxDrawdown).toBe(2);
    expect(s.recoveryFactor).toBeCloseTo(2 / 2, 10);
  });

  it('returns null ratios instead of dividing by zero', () => {
    expect(episodeStats([])).toBeNull();
    const onlyWins = episodeStats([1, 2])!;
    expect(onlyWins.payoffRR).toBeNull();
    expect(onlyWins.kellyRaw).toBeNull();
    expect(onlyWins.recoveryFactor).toBeNull();
  });

  it('computes character only with enough closed candles and valid variance', () => {
    expect(character(walk(100, 0))).toBeNull();
    expect(character(Array.from({ length: 181 }, (_, i) => bar(i, 100)))).toBeNull();
    const c = character(walk(200, 0.001))!;
    expect(c.atrp).toBeGreaterThan(0);
    expect(c.zeroRate).toBe(0);
    expect(Math.abs(c.rho1)).toBeLessThanOrEqual(1);
    expect(c.varianceRatio).toBeGreaterThan(0);
  });

  it('routes rising price with rising OBV to TF_LONG and refuses the short branches', () => {
    const up = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i));
    expect(routeSpot(up)?.route).toBe('TF_LONG');
    const down = Array.from({ length: 60 }, (_, i) => bar(i, 200 - i));
    expect(routeSpot(down)?.route).toBe('NO_SPOT_ACTION');
    expect(routeSpot(up.slice(-20))).toBeNull();
  });

  it('routes falling price with rising OBV to MR_LONG', () => {
    // Small down steps on low volume, one large up step on heavy volume: price falls, OBV rises.
    const bars = Array.from({ length: 60 }, (_, i) => bar(i, 100 - i * 0.1, 1, i % 4 === 0 ? 50 : 1));
    for (let i = 1; i < 60; i += 4) bars[i] = { ...bars[i], close: bars[i - 1].close + 0.05, volume: 100 };
    const routed = routeSpot(bars)!;
    expect(routed.priceDirection).toBe(-1);
    expect(routed.obvSlopeSign).toBe(1);
    expect(routed.route).toBe('MR_LONG');
  });

  it('applies the 0.1% round-trip fee gate', () => {
    const fee = 0.003;
    const min = minTargetPrice(100, fee, fee);
    expect(roundTripNetPerUnit(100, min, fee, fee)).toBeCloseTo(100 * 0.001, 8);
    expect(roundTripNetPerUnit(100, min - 0.01, fee, fee)).toBeLessThan(100 * 0.001);
    expect(roundTripNetPerUnit(100, 100.5, fee, fee)).toBeLessThan(100 * 0.001);
  });
});
