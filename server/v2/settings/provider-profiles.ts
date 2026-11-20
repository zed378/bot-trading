import { z } from 'zod';
import type { RuntimeStore } from '../store/database.js';
import { CredentialVault } from './vault.js';

export const ProviderProfileSchema = z.object({
  provider: z.enum(['openai', 'anthropic']),
  protocol: z.enum(['chat_completions', 'responses', 'anthropic']),
  baseUrl: z.string().url().max(500).refine(value => {
    const u = new URL(value);
    return !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(u.hostname));
  }, 'Use HTTPS, or HTTP for an explicitly local compatible endpoint; no credentials/query in the URL.'),
  model: z.string().trim().min(1).max(150),
  apiKey: z.string().trim().min(8).max(400).regex(/^\S+$/).optional()
}).strict().refine(value => (value.provider === 'anthropic') === (value.protocol === 'anthropic'), 'Anthropic uses the Messages protocol.');
export type SavedProviderProfile = Omit<z.infer<typeof ProviderProfileSchema>, 'apiKey'> & { apiKey: string };
export async function loadProviderProfiles(store: RuntimeStore, namespace: string, env: NodeJS.ProcessEnv): Promise<Map<string, SavedProviderProfile>> {
  const vault = new CredentialVault(store, namespace, env), profiles = new Map<string, SavedProviderProfile>();
  for (const provider of ['openai', 'anthropic'] as const) {
    const status = await vault.status(`provider.${provider}`);
    if (!status.configured) continue;
    const secret = await vault.load(`provider.${provider}`);
    const profile = ProviderProfileSchema.parse({ ...status.metadata, apiKey: secret?.apiKey });
    if (!profile.apiKey) throw new Error('Encrypted provider API key unavailable.');
    profiles.set(provider, { ...profile, apiKey: profile.apiKey });
  }
  return profiles;
}
