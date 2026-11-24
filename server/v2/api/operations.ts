import type express from 'express';
import { z } from 'zod';
import { isLocalLoopbackClient, type OfficeRuntime } from '../contracts.js';

const sizeBodySchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(['LONG', 'SHORT']),
  entry: z.string().min(1),
  stop: z.string().min(1),
  leverage: z.number().int().positive().optional()
});

const openBodySchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(['LONG', 'SHORT']),
  qty: z.string().min(1),
  stop: z.string().min(1),
  tp: z.string().optional().nullable(),
  leverage: z.number().int().positive().optional(),
  orderType: z.enum(['MARKET', 'LIMIT_GTC']).default('MARKET'),
  limitPrice: z.string().optional()
});

const closeBodySchema = z.object({
  symbol: z.string().min(1),
  cause: z.string().optional()
});

const cancelEntryBodySchema = z.object({
  clientId: z.string().min(1),
  symbol: z.string().optional()
});

const autoBodySchema = z.object({
  on: z.boolean().optional(),
  runNow: z.boolean().optional(),
  intervalMin: z.number().int().min(1).max(1440).optional(),
  maxHoldHours: z.number().int().min(0).max(720).optional(),
  reportIntervalMin: z.number().int().min(1).max(1440).optional(),
  symbols: z.array(z.string()).optional(),
  symbolsOverride: z.array(z.string()).optional(),
  n: z.number().int().min(1).max(4).optional(),
  debateMode: z.enum(['normal', 'fast']).optional()
});

const commandBodySchema = z.object({
  text: z.string().min(1),
  agent: z.string().optional(),
  clientRequestId: z.string().optional(),
  conversationId: z.string().optional()
});

export function mountOperationsRoutes(
  app: express.Express,
  runtime: OfficeRuntime
): void {
  function verifyOwner(req: express.Request, res: express.Response): boolean {
    const check = isLocalLoopbackClient({
      remoteAddress: req.socket.remoteAddress,
      hostHeader: req.headers.host,
      origin: req.get('origin')
    });
    if (!check.ok) {
      res.status(403).json({ ok: false, error: check.reason });
      return false;
    }
    return true;
  }

  app.get('/api/ops/kill', (req, res) => {
    if (!verifyOwner(req, res)) return;

    const state = runtime.snapshot();
    res.json({
      ok: true,
      killed: state.killed,
      source: 'local_latch',
      persistence: 'durable',
      releaseCommand: 'npm run unkill -- --yes'
    });
  });

  app.post('/api/ops/kill', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const body = req.body ?? {};
    const isRelease =
      body.on === false ||
      body.killed === false ||
      body.action === 'release' ||
      body.action === 'unkill';

    const reply = await runtime.dispatch({
      kind: isRelease ? 'unkill' : 'kill',
      actor: 'local_owner'
    });
    const state = runtime.snapshot();

    if (isRelease) {
      const released = reply.ok && !state.killed;
      res.status(released ? 200 : 409).json({
        ok: released,
        killed: state.killed,
        autoTrading: 'OFF',
        message: released
          ? reply.message
          : (state.killed ? 'Release failed: persisted halt latch remains active.' : reply.message)
      });
      return;
    }

    res.json({
      ok: reply.ok,
      killed: state.killed,
      reason: 'MANUAL_HALT_AND_FLATTEN',
      flatten: reply.data?.flatten ?? 'COMPLETED',
      entryCancellation: reply.data?.entryCancellation ?? 'COMPLETED',
      message: reply.message
    });
  });

  app.post('/api/kill', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const reply = await runtime.dispatch({
      kind: 'kill',
      actor: 'local_owner'
    });

    const state = runtime.snapshot();
    res.json({
      ok: reply.ok,
      killed: state.killed,
      action: 'HALT_AND_FLATTEN',
      flatten: reply.data?.flatten ?? 'COMPLETED',
      entryCancellation: reply.data?.entryCancellation ?? 'COMPLETED',
      message: reply.message
    });
  });

  app.post('/api/unkill', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const reply = await runtime.dispatch({
      kind: 'unkill',
      actor: 'local_owner'
    });
    const state = runtime.snapshot();
    const released = reply.ok && !state.killed;
    res.status(released ? 200 : 409).json({
      ok: released,
      killed: state.killed,
      autoTrading: 'OFF',
      message: released
        ? reply.message
        : (state.killed ? 'Release failed: persisted halt latch remains active.' : reply.message)
    });
  });

  app.post('/api/debate', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const symbol = String(req.body?.symbol ?? '').slice(0, 20).trim().toUpperCase() || 'BTCIDR';
    if (runtime.triggerCycle) {
      const result = await runtime.triggerCycle(symbol, 'owner');
      res.json(result);
    } else {
      res.status(503).json({ ok: false, error: 'Cycle runner not configured.' });
    }
  });

  app.post('/api/command', async (req, res) => {
    if (!verifyOwner(req, res)) return;

    const parsed = commandBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Command text cannot be empty.' });
      return;
    }

    if (runtime.handleCommand) {
      const reply = await runtime.handleCommand({
        text: parsed.data.text,
        agent: parsed.data.agent,
        clientRequestId: parsed.data.clientRequestId,
        conversationId: parsed.data.conversationId
      });
      res.json(reply);
      return;
    }

    const reply = await runtime.dispatch({
      kind: 'command',
      actor: 'local_owner',
      text: parsed.data.text,
      agent: parsed.data.agent as any,
      clientRequestId: parsed.data.clientRequestId
    });

    res.json({
      ok: reply.ok,
      reply: reply.message
    });
  });
}
