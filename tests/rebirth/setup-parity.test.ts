import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createReplacementRuntime } from '../../server/v2/runtime.js';
import { createReplacementApp } from '../../server/v2/app.js';
import { SettingsService } from '../../server/v2/settings/service.js';
import { SecretStore } from '../../server/v2/settings/secrets.js';
import { RuntimeStore } from '../../server/v2/store/database.js';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';

describe('Setup API Parity Verification', () => {
  async function withTestApp(fn: (baseUrl: string) => Promise<void>) {
    const dbFile = path.join(os.tmpdir(), `test-sp-${Date.now()}-${randomUUID()}.sqlite`);
    const store = await RuntimeStore.open(dbFile);
    const secrets = new SecretStore({ allowWrite: true });
    const settings = await SettingsService.initialize(store, secrets, {});
    const accounts = new AccountRegistry();
    const runtime = createReplacementRuntime();
    const app = createReplacementApp(runtime, {
      setupDeps: { settings, secrets, accounts }
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await fn(baseUrl);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
      try { rmSync(dbFile, { force: true }); } catch {}
    }
  }




  it('GET and POST /api/setup/models supports provider catalog and agent config', async () => {
    await withTestApp(async (baseUrl) => {
      const getRes = await fetch(`${baseUrl}/api/setup/models`, {
        headers: { host: '127.0.0.1' }
      });
      expect(getRes.status).toBe(200);
      const getData = (await getRes.json()) as {
        ok: boolean;
        providers: Array<{ provider: string }>;
        agents: Array<{ id: string; provider: string }>;
      };
      expect(getData.ok).toBe(true);
      expect(getData.providers.length).toBeGreaterThan(0);
      expect(getData.agents.length).toBe(6);

      const postRes = await fetch(`${baseUrl}/api/setup/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: '127.0.0.1' },
        body: JSON.stringify({
          defaultProvider: 'openai',
          defaultModel: 'gpt-4o'
        })
      });
      expect(postRes.status).toBe(200);
      const postData = (await postRes.json()) as { ok: boolean };
      expect(postData.ok).toBe(true);

      // Verify switching to offline demo (mock) model succeeds and persists
      const mockPostRes = await fetch(`${baseUrl}/api/setup/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: '127.0.0.1' },
        body: JSON.stringify({
          defaultProvider: 'mock',
          defaultModel: 'mock-desk-v1'
        })
      });
      expect(mockPostRes.status).toBe(200);
      const mockPostData = (await mockPostRes.json()) as { ok: boolean };
      expect(mockPostData.ok).toBe(true);

      const afterMockGet = await fetch(`${baseUrl}/api/setup/models`, {
        headers: { host: '127.0.0.1' }
      });
      expect(afterMockGet.status).toBe(200);
      const afterMockData = (await afterMockGet.json()) as {
        ok: boolean;
        defaultProvider: string;
        defaultModel: string;
        agents: Array<{ id: string; provider: string; model: string }>;
      };
      expect(afterMockData.ok).toBe(true);
      expect(afterMockData.defaultProvider).toBe('mock');
      expect(afterMockData.defaultModel).toBe('mock-desk-v1');
      expect(afterMockData.agents.every((a) => a.provider === 'mock' && a.model === 'mock-desk-v1')).toBe(true);
    });
  });


  it('GET /api/setup/channels returns channel status and guides', async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/setup/channels`, {
        headers: { host: '127.0.0.1' }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        ok: boolean;
        status: { commands: boolean };
        channels: string[];
      };
      expect(data.ok).toBe(true);
      expect(data.channels).toContain('telegram');
      expect(data.channels).toEqual(['telegram']);
    });
  });
});
