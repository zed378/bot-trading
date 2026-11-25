import type express from 'express';
import { z } from 'zod';
import { INDODAX_TIMEFRAMES } from '../../../shared/indodax.js';
import { IndodaxDataError, IndodaxPublicClient } from '../../market/indodax.js';
import { analyzeIndodax } from '../../market/indodax-analysis.js';
import { isLocalLoopbackClient } from '../contracts.js';

export { analyzeIndodax };

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
