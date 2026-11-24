import type express from 'express';
import { z } from 'zod';
import { isLocalLoopbackClient, ROLE_IDS, type OfficeRuntime } from '../contracts.js';
import { MODEL_CHOICES, MODEL_KEY_ENV, MODEL_SOURCES, MODEL_CATALOG_DATE, USAGE_SOURCE, fetchLiveProviderModels } from '../settings/model-catalog.js';
import { JEV_DECISION_MODELS } from '../../../shared/jev-models.js';
import { LOCAL_CLI_AGENTS } from '../agents/local.js';
import type { AccountRegistry } from '../accounts/registry.js';
import { API_PROVIDERS, MODEL_PROVIDERS, PreferencesBody, type ApiProviderId } from '../settings/schema.js';
import { PROVIDER_KEY_ENV, type SecretStore } from '../settings/secrets.js';
import type { SettingsService } from '../settings/service.js';
import { V2_CHANNELS, V2_CHANNEL_GUIDES, CHANNEL_LINKS_CHECKED_ON, SUPERVISOR_ENV, channelStatusV2, isChannelV2, testChannelV2, saveChannelV2, resetChannelV2, telegramChatsV2, syncTelegramCommandsV2 } from '../telegram.js';

export interface SetupApiDeps {
  settings: SettingsService;
  secrets: SecretStore;
  accounts: AccountRegistry;
  fetchImpl?: typeof fetch;
  runtime?: OfficeRuntime;
}

export function mountSetupApiRoutes(app: express.Express, deps: SetupApiDeps): void {
  const requireLoopback: express.RequestHandler = (req, res, next) => {
    const check = isLocalLoopbackClient({
      remoteAddress: req.socket.remoteAddress,
      hostHeader: req.headers.host,
      origin: req.get('origin')
    });
    if (!check.ok) {
      res.status(403).json({ ok: false, error: check.reason });
      return;
    }
    next();
  };

  app.use('/api/setup', requireLoopback);

  app.get('/api/setup/preferences', (_req, res) => {
    const snap = deps.settings.current();
    const prefs = {
      appMode: snap.effective.appMode,
      balance: snap.effective.paper.balance,
      safetyNet: snap.effective.paper.safetyNet,
      n: snap.effective.paper.n,
      dailyLoss: snap.effective.trading.dailyLossLimitPct,
      auto: snap.effective.auto.on,
      debateInterval: snap.effective.auto.intervalMin,
      reportInterval: snap.effective.auto.reportIntervalMin,
      maxHoldHours: snap.effective.auto.maxHoldHours
    };
    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      canRestart: true,
      values: prefs,
      preferences: prefs
    });
  });

  app.post('/api/setup/preferences', async (req, res) => {
    const expectedActiveVersion = Number(
      req.body?.expectedActiveVersion ?? deps.settings.current().activeVersion
    );
    const { expectedActiveVersion: _omit, ...rawPrefs } = (req.body ?? {}) as Record<string, unknown>;
    const parsed = PreferencesBody.safeParse(rawPrefs);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: 'Check the amounts, safety net, N (1-100), loss cap (0.1-100%), intervals (1-1440 minutes), and max hold hours (0-720 hours).'
      });
      return;
    }
    const v = parsed.data;
    const result = await deps.settings.apply(
      {
        appMode: v.appMode,
        paper: {
          balance: v.balance,
          safetyNet: v.safetyNet,
          n: v.n
        },
        trading: {
          safetyNet: v.safetyNet,
          maxPositions: v.n,
          dailyLossLimitPct: Math.min(100, Math.max(0.1, v.dailyLoss))
        },
        auto: {
          on: v.auto,
          intervalMin: v.debateInterval,
          reportIntervalMin: v.reportInterval,
          maxHoldHours: v.maxHoldHours ?? 0
        }
      },
      expectedActiveVersion
    );
    if (result.applyStatus === 'applied') {
      const updates: Record<string, string> = {};
      if (v.n !== undefined) {
        updates.OPEN_ORDERS_N = String(v.n);
        updates.MAINNET_DESK_OPEN_ORDERS_N = String(v.n);
      }
      if (v.safetyNet !== undefined) {
        updates.SAFETY_NET = String(v.safetyNet);
        updates.MAINNET_DESK_SAFETY_NET = String(v.safetyNet);
      }
      if (v.auto !== undefined) {
        updates.AUTO_TRADING = v.auto ? 'on' : 'off';
      }
      if (v.debateInterval !== undefined) {
        updates.DEBATE_INTERVAL_MIN = String(v.debateInterval);
      }
      if (v.reportInterval !== undefined) {
        updates.REPORT_INTERVAL_MIN = String(v.reportInterval);
      }
      if (Object.keys(updates).length > 0) {
        deps.secrets.writeSecrets(updates);
      }
    }
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', detail: 'Preferences saved.', ...result });
  });

  app.get('/api/setup/models', async (req, res) => {
    const discoverProvider = typeof req.query?.discover === 'string' ? req.query.discover.trim().toLowerCase() : null;
    if (discoverProvider && API_PROVIDERS.includes(discoverProvider as ApiProviderId)) {
      const prov = discoverProvider as ApiProviderId;
      const envKey = MODEL_KEY_ENV[prov];
      const apiKey = deps.secrets.getSecret(envKey);
      const result = await fetchLiveProviderModels(prov, apiKey ?? undefined);
      res.json({
        ok: true,
        provider: prov,
        source: result.source,
        models: result.models
      });
      return;
    }

    const snap = deps.settings.current();
    // This is a compatibility catalogue, not proof of live model availability.
    // Provider discovery is a separate authenticated operation; never fabricate 25 entries.
    const allProviderIds = [...new Set([...MODEL_PROVIDERS.filter((id) => id !== 'unconfigured'), 'mock'])];
    const catalog = allProviderIds.map((id) => {
      const provider = id as keyof typeof MODEL_CHOICES;
      const keyEnv = provider === 'local' || provider === 'mock'
        ? null : MODEL_KEY_ENV[provider as keyof typeof MODEL_KEY_ENV];
      const models = provider === 'local'
        ? LOCAL_CLI_AGENTS.flatMap(agent => agent.models.map(model => ({
            id: `${agent.id}:${model}`,
            label: `${agent.label}: ${model}`,
            tags: ['installed account required']
          })))
        : MODEL_CHOICES[provider].map(model => ({ ...model }));
      return {
        provider: id,
        keyEnv,
        keySet: keyEnv ? deps.secrets.hasProviderKey(provider as keyof typeof MODEL_KEY_ENV) : true,
        source: MODEL_SOURCES[provider],
        defaultModel: models[0]?.id ?? 'default',
        models
      };
    });

    const leadProviderRaw = snap.effective.agents.lead.provider;
    const defaultProvider = leadProviderRaw === 'unconfigured' || !catalog.some((c) => c.provider === leadProviderRaw) ? 'mock' : leadProviderRaw;
    const rawDefaultModel = snap.effective.agents.lead.model;
    const defaultModel = (!rawDefaultModel || rawDefaultModel === 'unconfigured')
      ? (catalog.find((c) => c.provider === defaultProvider)?.defaultModel ?? 'mock-desk-v1')
      : rawDefaultModel;

    const agentRows = ROLE_IDS.map((r) => {
      const a = snap.effective.agents[r];
      const prov = a.provider === 'unconfigured' || !catalog.some((c) => c.provider === a.provider) ? 'mock' : a.provider;
      const rawModel = a.model;
      const model = (!rawModel || rawModel === 'unconfigured')
        ? (catalog.find((c) => c.provider === prov)?.defaultModel ?? 'mock-desk-v1')
        : rawModel;
      const isCustom = prov !== defaultProvider || model !== defaultModel;
      return {
        id: r,
        provider: prov,
        model,
        reasoning: a.reasoning ?? null,
        custom: isCustom
      };
    });

    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      checkedOn: MODEL_CATALOG_DATE,
      usageSource: USAGE_SOURCE,
      providers: catalog,
      defaultProvider,
      defaultModel,
      defaultReasoning: null,
      agents: agentRows,
      providersConfigured: deps.secrets.statusSummary().providersConfigured
    });
  });

  app.post('/api/setup/models', async (req, res) => {
    try {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const bodySchema = z
      .object({
        expectedActiveVersion: z.number().int().positive().optional(),
        defaultProvider: z.string().optional(),
        defaultModel: z.string().optional(),
        defaultReasoning: z.string().nullable().optional(),
        reasoning: z.record(z.string(), z.string().nullable()).optional(),
        keys: z.record(z.string(), z.string().max(400)).optional(),
        agents: z
          .record(
            z.string(),
            z.object({
              provider: z.string().optional(),
              model: z.string().min(1).max(200).optional(),
              reasoning: z.string().nullable().optional(),
              route: z.enum(['LOCAL', 'GROK', 'MIRROR_READ_ONLY']).optional()
            })
          )
          .optional()
      })
      .passthrough();

    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid model configuration payload.' });
      return;
    }

    if (parsed.data.keys) {
      const secretUpdates: Record<string, string> = {};
      for (const [prov, keyVal] of Object.entries(parsed.data.keys)) {
        const envName = PROVIDER_KEY_ENV[prov as ApiProviderId];
        if (envName && keyVal.trim().length > 0) {
          secretUpdates[envName] = keyVal.trim();
        }
      }
      if (Object.keys(secretUpdates).length > 0) {
        deps.secrets.writeSecrets(secretUpdates);
      }
    }

    if (parsed.data.defaultProvider || parsed.data.defaultModel) {
      const secretUpdates: Record<string, string> = {};
      if (parsed.data.defaultProvider) {
        secretUpdates.DEFAULT_PROVIDER = parsed.data.defaultProvider;
      }
      if (parsed.data.defaultModel && parsed.data.defaultProvider) {
        const key = `${parsed.data.defaultProvider.toUpperCase()}_MODEL`;
        secretUpdates[key] = parsed.data.defaultModel;
      }
      if (Object.keys(secretUpdates).length > 0) {
        deps.secrets.writeSecrets(secretUpdates);
      }
    }

    const currentAgents = deps.settings.current().effective.agents;
    const patchedAgents: Record<string, { provider: any; model: string; reasoning?: any; route: any }> = {};
    for (const role of ROLE_IDS) {
      const explicit = parsed.data.agents?.[role];
      const provider = (explicit?.provider ?? parsed.data.defaultProvider ?? currentAgents[role].provider) as any;
      const rawModel = explicit?.model ?? parsed.data.defaultModel ?? currentAgents[role].model;
      const model = (provider === 'mock' && (!rawModel || rawModel === 'unconfigured')) ? 'mock-desk-v1' : rawModel;
      const reasoning = explicit?.reasoning !== undefined ? (explicit.reasoning as any) : currentAgents[role].reasoning;
      const route = explicit?.route ?? currentAgents[role].route;
      patchedAgents[role] = {
        provider,
        model,
        ...(reasoning ? { reasoning } : {}),
        route
      };
    }

    const expected = parsed.data.expectedActiveVersion ?? deps.settings.current().activeVersion;
    const patch = { agents: patchedAgents };
    const result = await deps.settings.apply(patch as any, expected);
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    res.status(status).json({ ok: result.applyStatus === 'applied', detail: 'Model configuration saved.', ...result });
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: 'Could not save model settings. Reload Setup before retrying; the save may have completed.'
        });
      }
    }
  });

  app.get('/api/setup/jev', (_req, res) => {
    const snap = deps.settings.current();
    const jev = snap.effective.jev;
    const dedicatedKeySet = Boolean(deps.secrets.getSecret('JEV_OPENROUTER_API_KEY'));
    const openrouterKeySet = deps.secrets.hasProviderKey('openrouter');
    const hasKey = dedicatedKeySet || openrouterKeySet;
    const health = !jev.enabled ? 'disabled' : (hasKey ? 'healthy' : 'unavailable');
    const uiMode = jev.mode === 'advisory' ? 'shadow' : jev.mode === 'strict' ? 'assist' : jev.mode;

    res.json({
      ok: true,
      savedVersion: snap.savedVersion,
      activeVersion: snap.activeVersion,
      enabled: jev.enabled,
      provider: jev.provider || 'openrouter',
      model: jev.model || 'typesafe/jev-1.14',
      mode: uiMode,
      configuredMode: uiMode,
      allowLive: jev.allowLive,
      health,
      dedicatedKeySet,
      openrouterKeySet,
      models: JEV_DECISION_MODELS,
      jev
    });
  });

  app.post('/api/setup/jev', async (req, res) => {
    const bodySchema = z
      .object({
        expectedActiveVersion: z.number().int().positive().optional(),
        enabled: z.boolean().optional(),
        model: z.string().min(1).max(200).optional(),
        mode: z.enum(['off', 'shadow', 'assist', 'advisory', 'strict']).optional(),
        allowLive: z.boolean().optional(),
        apiKey: z.string().max(400).optional(),
        key: z.string().max(400).optional()
      })
      .strict();
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid Jev setup payload.' });
      return;
    }
    const keyVal = parsed.data.apiKey ?? parsed.data.key;
    if (keyVal && keyVal.trim().length > 0) {
      deps.secrets.writeSecrets({ JEV_OPENROUTER_API_KEY: keyVal.trim() });
    }
    const mappedMode = parsed.data.mode === 'shadow'
      ? 'advisory'
      : parsed.data.mode === 'assist'
        ? 'strict'
        : parsed.data.mode;

    const expected = parsed.data.expectedActiveVersion ?? deps.settings.current().activeVersion;
    const result = await deps.settings.apply(
      {
        jev: {
          ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
          ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
          ...(mappedMode !== undefined ? { mode: mappedMode } : {}),
          ...(parsed.data.allowLive !== undefined ? { allowLive: parsed.data.allowLive } : {})
        }
      },
      expected
    );
    const status = result.applyStatus === 'conflict' ? 409 : result.applyStatus === 'failed' ? 400 : 200;
    const snap = deps.settings.current();
    const jev = snap.effective.jev;
    if (result.applyStatus === 'applied') {
      deps.secrets.writeSecrets({
        JEV_ENABLED: jev.enabled ? 'true' : 'false',
        JEV_MODEL: jev.model || 'typesafe/jev-1.14',
        JEV_MODE: jev.mode || 'off',
        JEV_ALLOW_LIVE: jev.allowLive ? 'true' : 'false'
      });
    }
    const dedicatedKeySet = Boolean(deps.secrets.getSecret('JEV_OPENROUTER_API_KEY'));
    const openrouterKeySet = deps.secrets.hasProviderKey('openrouter');
    const uiMode = jev.mode === 'advisory' ? 'shadow' : jev.mode === 'strict' ? 'assist' : jev.mode;
    if (result.applyStatus === 'applied') {
      deps.runtime?.updateState?.((draft) => {
        if (draft.jev) {
          draft.jev.enabled = jev.enabled;
          draft.jev.model = jev.model || 'typesafe/jev-1.14';
          draft.jev.mode = uiMode;
          draft.jev.configuredMode = uiMode;
          draft.jev.allowLive = jev.allowLive;
          draft.jev.dedicatedKeySet = dedicatedKeySet;
          draft.jev.openrouterKeySet = openrouterKeySet;
          draft.jev.health = !jev.enabled ? 'disabled' : ((dedicatedKeySet || openrouterKeySet) ? 'healthy' : 'unavailable');
        }
      });
    }

    res.status(status).json({
      ok: result.applyStatus === 'applied',
      detail: 'JEV configuration saved.',
      enabled: jev.enabled,
      provider: jev.provider || 'openrouter',
      model: jev.model || 'typesafe/jev-1.14',
      mode: uiMode,
      configuredMode: uiMode,
      allowLive: jev.allowLive,
      health: !jev.enabled ? 'disabled' : ((dedicatedKeySet || openrouterKeySet) ? 'healthy' : 'unavailable'),
      dedicatedKeySet,
      openrouterKeySet,
      models: JEV_DECISION_MODELS,
      ...result
    });
  });

  app.post('/api/setup/jev/test', async (_req, res) => {
    const key = deps.secrets.getSecret('JEV_OPENROUTER_API_KEY') ?? deps.secrets.getSecret('OPENROUTER_API_KEY');
    if (!key) {
      res.status(400).json({ ok: false, error: 'No Jev or OpenRouter API key configured.' });
      return;
    }
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { authorization: `Bearer ${key.trim()}` },
        signal: AbortSignal.timeout(10_000)
      });
      if (!resp.ok) {
        res.status(400).json({ ok: false, health: 'unhealthy', error: `Jev/OpenRouter authentication failed: HTTP ${resp.status}` });
        return;
      }
      res.json({ ok: true, health: 'healthy', detail: 'Jev credentials verified.' });
    } catch (err) {
      res.status(400).json({ ok: false, health: 'unhealthy', error: `Jev connection failed: ${(err as Error).message}` });
    }
  });

  const handleRestart: express.RequestHandler = (_req, res) => {
    res.json({ ok: true, detail: 'Restarting trading desk...' });
    setTimeout(() => {
      if (process.send) {
        process.send({ type: 'mpu:restart' });
      }
      process.exit(0);
    }, 200);
  };
  app.post('/api/setup/restart', handleRestart);
  app.post('/api/ops/restart', handleRestart);

  app.get('/api/setup/channels', (_req, res) => {
    const st = channelStatusV2(process.env);
    res.json({
      ok: true,
      linksCheckedOn: CHANNEL_LINKS_CHECKED_ON,
      entry: { available: true, reason: 'local loopback' },
      status: st,
      supervisorEnv: SUPERVISOR_ENV,
      channels: V2_CHANNELS,
      guides: V2_CHANNELS.map((ch) => {
        const g = V2_CHANNEL_GUIDES[ch];
        return {
          channel: ch,
          ...g,
          fields: g.fields.map((f) => ({
            env: f.env,
            label: f.label,
            secret: f.secret,
            required: f.required,
            hint: f.hint
          }))
        };
      })
    });
  });

  app.post('/api/setup/channels/telegram-sync', async (_req, res) => {
    try {
      const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
      const result = await syncTelegramCommandsV2(token, deps.fetchImpl ?? fetch);
      res.status(result.ok ? 200 : 422).json(result);
    } catch (error) {
      res.status(422).json({ ok: false, detail: (error as Error).message });
    }
  });

  app.post('/api/setup/channels/save', async (req, res) => {
    const raw = (req.body ?? {}) as { channel?: unknown; values?: Record<string, string>; commands?: boolean };
    const ch = raw.channel;
    if (!isChannelV2(ch)) {
      res.status(400).json({ ok: false, error: 'invalid channel' });
      return;
    }
    const result = saveChannelV2('.env', ch, raw.values ?? {}, { commands: raw.commands });
    if (result.ok) {
      for (const [k, v] of Object.entries(raw.values ?? {})) {
        if (v !== undefined) process.env[k] = v;
      }
      if (raw.commands !== undefined) {
        process.env.CHANNEL_COMMANDS = raw.commands ? 'on' : 'off';
        await deps.settings.apply({ channels: { commandsEnabled: raw.commands } }, deps.settings.current().activeVersion);
      }
      // Auto-sync commands for this channel
      if (ch === 'telegram') {
        const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
        if (token) {
          void syncTelegramCommandsV2(token, deps.fetchImpl ?? fetch).catch(() => {});
        }
      }
    }
    res.status(result.ok ? 200 : 422).json(result);
  });

  app.post('/api/setup/channels/reset', (req, res) => {
    const raw = (req.body ?? {}) as { channel?: unknown };
    const ch = raw.channel;
    if (!isChannelV2(ch)) {
      res.status(400).json({ ok: false, error: 'unknown channel' });
      return;
    }
    const result = resetChannelV2('.env', ch);
    res.json(result);
  });

  app.post('/api/setup/channels/test', async (req, res) => {
    const raw = (req.body ?? {}) as { channel?: unknown };
    const ch = raw.channel;
    if (!isChannelV2(ch)) {
      res.status(400).json({ ok: false, error: 'unknown channel' });
      return;
    }
    const result = await testChannelV2(process.env, ch, deps.fetchImpl ?? fetch);
    res.status(result.ok ? 200 : 422).json(result);
  });

  app.post('/api/setup/channels/telegram-chats', async (_req, res) => {
    const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
    const result = await telegramChatsV2(token, deps.fetchImpl ?? fetch);
    res.json(result);
  });
}
