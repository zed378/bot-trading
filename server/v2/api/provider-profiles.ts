import type express from 'express';
import { z } from 'zod';
import { isLocalLoopbackClient, ROLE_IDS } from '../contracts.js';
import type { RuntimeStore } from '../store/database.js';
import { CredentialVault, VaultError } from '../settings/vault.js';
import { ProviderProfileSchema, type SavedProviderProfile } from '../settings/provider-profiles.js';
import type { SettingsService } from '../settings/service.js';
import { createOfficialProviderCaller } from '../agents/providers.js';

export function mountProviderProfileRoutes(app: express.Express, deps: { store: RuntimeStore; schema: string; env: NodeJS.ProcessEnv; profiles: Map<string, SavedProviderProfile>; onSaved?: (profile: SavedProviderProfile) => void; settings: SettingsService }) {
  const vault = new CredentialVault(deps.store, deps.schema, deps.env);
  app.use('/api/providers', (req, res, next) => {
    const access = isLocalLoopbackClient({ remoteAddress: req.socket.remoteAddress, hostHeader: req.headers.host, origin: req.get('origin') });
    if (!access.ok) return res.status(403).json({ ok: false, error: access.reason });
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  app.get('/api/providers', async (_req, res) => {
    try {
      const profiles = await Promise.all(['openai', 'anthropic'].map(async provider => ({ provider, ...await vault.status(`provider.${provider}`) })));
      return res.json({ ok: true, profiles, encryption: 'AES-256-GCM' });
    } catch { return res.status(503).json({ ok: false, error: 'Provider configuration storage unavailable.' }); }
  });
  app.post('/api/providers', async (req, res) => {
    const input = ProviderProfileSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ ok: false, error: 'Choose provider, matching protocol, base URL and model. API key is required on first save.' });
    try {
      const { apiKey: supplied, ...metadata } = input.data;
      const existing = supplied ? null : await vault.load(`provider.${metadata.provider}`);
      const apiKey = supplied || existing?.apiKey;
      if (!apiKey) return res.status(400).json({ ok: false, error: 'API key is required on first save.' });
      await vault.save(`provider.${metadata.provider}`, { apiKey }, { ...metadata, baseUrl: metadata.baseUrl.replace(/\/$/, '') });
      const profile: SavedProviderProfile = { ...metadata, baseUrl: metadata.baseUrl.replace(/\/$/, ''), apiKey };
      deps.profiles.set(profile.provider, profile); deps.onSaved?.(profile);
      return res.json({ ok: true, configured: true, note: 'Provider saved with an encrypted key. Agent assignments and Auto Trading were not changed.' });
    } catch (error) { return res.status(400).json({ ok: false, error: error instanceof VaultError ? error.message : 'Provider configuration could not be saved.' }); }
  });
  app.post('/api/providers/apply', async (req, res) => {
    const input = z.object({ provider: z.enum(['openai', 'anthropic']) }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ ok: false, error: 'Choose a saved provider.' });
    const profile = deps.profiles.get(input.data.provider);
    if (!profile) return res.status(400).json({ ok: false, error: 'Save the provider configuration first.' });
    const snapshot = deps.settings.current();
    const agents = Object.fromEntries(ROLE_IDS.map(role => [role, { ...snapshot.effective.agents[role], provider: profile.provider, model: profile.model, route: 'LOCAL' as const }]));
    try {
      const result = await deps.settings.apply({ agents } as any, snapshot.activeVersion);
      return res.status(result.applyStatus === 'applied' ? 200 : 409).json({ ok: result.applyStatus === 'applied', note: 'Provider assigned to all six agents. Auto Trading was not enabled.' });
    } catch { return res.status(503).json({ ok: false, error: 'Agent settings could not be applied.' }); }
  });
  app.post('/api/providers/check', async (req, res) => {
    const input = z.object({ provider: z.enum(['openai', 'anthropic']) }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ ok: false, error: 'Choose a saved provider.' });
    const profile = deps.profiles.get(input.data.provider);
    if (!profile) return res.status(400).json({ ok: false, error: 'Save the provider first.' });
    try {
      await createOfficialProviderCaller()({ cycleId: 'owner-provider-check', role: 'lead', phase: 'observe', taskAttempt: 1, turn: 1, provider: profile.provider, model: profile.model, apiKey: profile.apiKey, baseUrl: profile.baseUrl, apiProtocol: profile.protocol, system: 'Reply with OK.', user: 'Connection test. Reply with OK.', timeoutMs: 15_000 });
      return res.json({ ok: true, note: 'Model responded. No trading order was submitted.' });
    } catch { return res.status(502).json({ ok: false, error: 'Provider check failed. Verify endpoint, protocol, model, key and quota.' }); }
  });
}
