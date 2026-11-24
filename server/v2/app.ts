import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { SessionLogger } from '../session-log.js';
import type { OfficeRuntime } from './contracts.js';
import { mountStateRoutes } from './api/state.js';
import { mountOperationsRoutes } from './api/operations.js';
import { ChatService, mountChatRoutes } from './api/chat.js';
import { HistoryService, mountHistoryRoutes } from './api/history.js';
import { ReportsService, mountReportRoutes } from './reports.js';
import { mountSetupApiRoutes, type SetupApiDeps } from './api/setup.js';
import { mountLocalAgentsRoutes } from './api/local-agents.js';
import { mountIndodaxRoutes } from './api/indodax.js';
import { mountIndodaxPaper } from './api/indodax-paper.js';
import { mountIndodaxStopRoutes } from './api/indodax-stops.js';
import { mountProviderProfileRoutes } from './api/provider-profiles.js';

export interface ReplacementAppOptions {
  providerProfileDeps?: Parameters<typeof mountProviderProfileRoutes>[1];
  instanceId?: string;
  sessionLogger?: SessionLogger | null;
  sessionLogRoot?: string;
  staticWebDir?: string | null;
  reportsService?: ReportsService;
  chatService?: ChatService;
  historyService?: HistoryService;
  setupDeps?: SetupApiDeps;
  mountAdditionalRoutes?: (app: express.Express, runtime: OfficeRuntime) => void;
}




export function createReplacementApp(
  runtime: OfficeRuntime,
  options: ReplacementAppOptions = {}
): express.Express {
  const app = express();
  const instanceId = options.instanceId ?? randomUUID();

  app.disable('x-powered-by');
  app.use(
    express.json({
      limit: '256kb',
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      }
    })
  );

  mountStateRoutes(app, runtime, {
    instanceId,
    sessionLogger: options.sessionLogger,
    sessionLogRoot: options.sessionLogRoot
  });

  mountOperationsRoutes(app, runtime);
  mountIndodaxRoutes(app, runtime.indodaxClient);
  app.locals.indodaxPaperAgent = mountIndodaxPaper(app, runtime, runtime.indodaxClient);
  app.locals.indodaxStopWorker = mountIndodaxStopRoutes(app, { isKilled: () => runtime.snapshot().killed });
  if (options.providerProfileDeps) mountProviderProfileRoutes(app, options.providerProfileDeps);

  if (options.setupDeps) {
    mountSetupApiRoutes(app, { ...options.setupDeps, runtime });
    mountLocalAgentsRoutes(app, { ...options.setupDeps, runtime });
  }

  const reportsService = options.reportsService ?? new ReportsService();
  const reportInterval = options.setupDeps?.settings.current().effective.auto.reportIntervalMin ?? 60;
  reportsService.start(runtime, reportInterval);
  mountReportRoutes(app, reportsService, runtime);

  const chatService = options.chatService ?? new ChatService();
  mountChatRoutes(app, chatService, runtime);

  const historyService = options.historyService ?? new HistoryService();
  mountHistoryRoutes(app, historyService, runtime);

  app.use('/api', (_req, res) => {
    res.status(503).json({
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      availability: 'UNAVAILABLE',
      error: 'Endpoint service is not configured or initialized in the active runtime.'
    });
  });

  const webRoot =
    options.staticWebDir === undefined ? (process.env.MPU_STATIC_WEB_DIR || path.resolve('dist/web')) : options.staticWebDir;

  if (webRoot && existsSync(webRoot)) {
    app.use(express.static(webRoot));
    app.get(/^\/(?!api|ws).*/, (_req, res) => {
      res.sendFile(path.join(webRoot, 'index.html'));
    });
  }

  return app;
}
