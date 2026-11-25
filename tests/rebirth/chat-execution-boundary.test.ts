import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createReplacementRuntime } from '../../server/v2/runtime.js';

describe('Task 6: Chat Execution Boundary and Direct Command Routing', () => {


  it('verifies lead role prompt contains advisory-only boundary instructions', () => {
    const roleMd = readFileSync(
      path.join(process.cwd(), 'server/v2/agents/personas/lead/role.md'),
      'utf-8'
    );
    expect(roleMd).toContain('Conversational chat is strictly analytical advisory');
    expect(roleMd).toContain('/close <symbol>');
  });
});
