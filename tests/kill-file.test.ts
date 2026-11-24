import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendKillAudit, auditKillReason, clearKill, readKill, writeKill } from '../server/v2/kill-file.js';

describe('kill switch file', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
  const fileIn = async () => { const dir = await mkdtemp(path.join(os.tmpdir(), 'mpu-kill-')); dirs.push(dir); return path.join(dir, 'kill-switch.json'); };

  it('reports no kill until one is written, then returns the record and clears it', async () => {
    const file = await fileIn();
    expect(readKill(file)).toBeNull();
    writeKill(file, { at: 1_700_000_000_000, reason: 'owner stop', source: 'office' });
    expect(readKill(file)).toMatchObject({ reason: 'owner stop', source: 'office' });
    expect(clearKill(file)).toBe(true);
    expect(readKill(file)).toBeNull();
    expect(clearKill(file)).toBe(false);
  });

  it('keeps one audit line per event and redacts identifiers from the reason', async () => {
    const file = await fileIn();
    appendKillAudit(file, { at: 1, source: 'channel', requestId: 'not-a-uuid', result: 'activated', reason: 'chat_id: 123456789012345678 owner@example.com\nstop now' });
    const lines = (await readFile(file + '.audit.jsonl', 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({ source: 'channel', result: 'activated' });
    expect(record.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(record.reason).not.toMatch(/123456789012345678|owner@example\.com|\n/);
  });

  it('bounds the audited reason', () => {
    expect(auditKillReason('x'.repeat(1000)).length).toBeLessThanOrEqual(400);
  });
});
