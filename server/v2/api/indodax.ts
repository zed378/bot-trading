import type express from 'express';
import { z } from 'zod';
import { INDODAX_TIMEFRAMES, type IndodaxAnalysis } from '../../../shared/indodax.js';
import { IndodaxDataError, IndodaxPublicClient } from '../../market/indodax.js';
import { ema, rsi } from '../../strategy.js';
import { isLocalLoopbackClient } from '../contracts.js';

export async function analyzeIndodax(client: IndodaxPublicClient, symbol: string, tf: typeof INDODAX_TIMEFRAMES[number]): Promise<IndodaxAnalysis> {
  const market = await client.market(symbol, tf);
  const closes = market.candles.map(c => Number(c.close));
  const ema20 = ema(closes, 20).at(-1)!;
  const ema50 = closes.length >= 50 ? ema(closes, 50).at(-1)! : null;
  const lastClose = closes.at(-1)!;
  const trend = ema50 === null ? 'MIXED' : lastClose > ema20 && ema20 > ema50 ? 'BULLISH' : lastClose < ema20 && ema20 < ema50 ? 'BEARISH' : 'MIXED';
  return { ...market, indicators: { ema20, ema50, rsi14: rsi(closes), trend } };
}

/** A separate read-only surface prevents IDR observations entering the USDT execution ledger. */
export function mountIndodaxRoutes(app: express.Express, client = new IndodaxPublicClient()): void {
  app.use('/api/indodax', (req, res, next) => {
    const access = isLocalLoopbackClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host, origin: req.get('origin') });
    if (!access.ok) return res.status(403).json({ ok: false, error: access.reason });
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const fail = (res: express.Response, error: unknown) => res.status(error instanceof IndodaxDataError && error.kind === 'input' ? 400 : 503).json({
    ok: false, venue: 'indodax', executionSupported: false,
    error: error instanceof IndodaxDataError ? error.message : 'Indodax public data unavailable.'
  });
  app.get('/api/indodax/pairs', async (req, res) => {
    if (Object.keys(req.query).length) return res.status(400).json({ ok: false, error: 'This endpoint takes no parameters.' });
    try { return res.json({ ok: true, venue: 'indodax', access: 'public-read-only', executionSupported: false, pairs: await client.pairs() }); }
    catch (error) { return fail(res, error); }
  });
  app.get('/api/indodax/market', async (req, res) => {
    const query = z.object({ symbol: z.string().min(4).max(32), tf: z.enum(INDODAX_TIMEFRAMES).default('4h') }).strict().safeParse(req.query);
    if (!query.success) return res.status(400).json({ ok: false, error: 'Choose a complete Indodax pair and tf=4h or tf=1d.' });
    try { return res.json({ ok: true, data: await analyzeIndodax(client, query.data.symbol, query.data.tf) }); }
    catch (error) { return fail(res, error); }
  });
}
