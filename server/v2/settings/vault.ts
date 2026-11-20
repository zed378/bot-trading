import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RuntimeStore } from '../store/database.js';
import { registerSecrets } from '../../redact.js';

export class VaultError extends Error { constructor(message: string) { super(message); this.name = 'VaultError'; } }
export function sealSecret(value: Record<string, string>, key: Uint8Array, context: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
export function openSecret(envelope: string, key: Uint8Array, context: string): Record<string, string> {
  try {
    const data = JSON.parse(envelope);
    if (data.version !== 1 || typeof data.ciphertext !== 'string' || data.ciphertext.length > 30_000) throw new Error();
    const iv = Buffer.from(data.iv, 'base64'), tag = Buffer.from(data.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error();
    registerSecrets(Object.values(value) as string[]);
    return value;
  } catch { throw new VaultError('Encrypted credentials cannot be authenticated. Restore the correct Docker master key; no plaintext fallback.'); }
}
export class CredentialVault {
  constructor(private readonly store: RuntimeStore, private readonly namespace: string, private readonly env: NodeJS.ProcessEnv = process.env) {}
  private key(): Buffer {
    const file = this.env.CREDENTIAL_MASTER_KEY_FILE || this.env.INDODAX_MASTER_KEY_FILE;
    if (!file) throw new VaultError('Docker credential master-key secret is not configured.');
    try {
      const encoded = readFileSync(file, 'utf8').trim(), key = Buffer.from(encoded, 'base64');
      if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error();
      return key;
    } catch { throw new VaultError('Docker credential master-key secret is missing or invalid.'); }
  }
  async status(ref: string) {
    const row = (await this.store.execute('SELECT metadata_json, updated_at FROM encrypted_secrets WHERE secret_ref=?', [ref])).rows[0];
    return { configured: Boolean(row), metadata: row ? JSON.parse(String(row.metadata_json)) as Record<string, unknown> : {}, updatedAt: row ? String(row.updated_at) : null };
  }
  async load(ref: string): Promise<Record<string, string> | null> {
    const row = (await this.store.execute('SELECT envelope_json, metadata_json FROM encrypted_secrets WHERE secret_ref=?', [ref])).rows[0];
    if (!row) return null;
    const key = this.key();
    try { return openSecret(String(row.envelope_json), key, `mpu:v1:${this.namespace}:${ref}:${createHash('sha256').update(String(row.metadata_json)).digest('hex')}`); }
    finally { key.fill(0); }
  }
  async save(ref: string, value: Record<string, string>, metadata: Record<string, unknown> = {}): Promise<void> {
    if (!/^[a-z0-9_.:-]{1,100}$/.test(ref) || Object.values(value).some(v => typeof v !== 'string' || !v || v.length > 4096)) throw new VaultError('Invalid credential input.');
    registerSecrets(Object.values(value));
    const key = this.key(); let envelope: string;
    const metadataJson = JSON.stringify(metadata);
    // Bind endpoint/protocol metadata too: editing a DB row must not redirect a decrypted API key.
    try { envelope = sealSecret(value, key, `mpu:v1:${this.namespace}:${ref}:${createHash('sha256').update(metadataJson).digest('hex')}`); } finally { key.fill(0); }
    const at = new Date().toISOString();
    await this.store.transaction(async tx => {
      await tx.execute(`INSERT INTO encrypted_secrets (secret_ref,envelope_json,metadata_json,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(secret_ref) DO UPDATE SET envelope_json=excluded.envelope_json, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`, [ref, envelope, metadataJson, at]);
      await tx.append({ eventId: `credential-${randomUUID()}`, scope: 'credentials', kind: 'credential.updated', createdAt: at, correlationId: null, causationId: null, schemaVersion: 1, payload: { ref, encrypted: true } });
    });
  }
}
