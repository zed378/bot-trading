import { describe, expect, it } from 'vitest';
import { createReplacementRuntime } from '../../server/v2/runtime.js';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { CycleRunner } from '../../server/v2/decision/cycle.js';

describe('Channel Commands and Synchronization Suite', () => {

  it('handles ask commands with agent resolution, aliases and Indonesian tanya', async () => {
    const roleRunner = new RoleRunner({
      providerCaller: async ({ role, user }) => {
        const question = user ? user.split('\n\n').pop() : '';
        return JSON.stringify({
          reply: `Acknowledged from ${role}: ${question}`,
          confidence: 0.9,
          claimRefs: [],
          contraryRefs: []
        });
      },
      resolveAssignment: () => ({
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'test-key'
      })
    });
    const cycleRunner = new CycleRunner({ roleRunner });
    const runtime = createReplacementRuntime({ roleRunner, cycleRunner });

    try {
      // 1. Without agent -> defaults to Desk Lead
      const askNoAgent = await runtime.handleCommand({
        text: 'ask apakah semua aman terkendali?'
      });
      expect(askNoAgent.ok).toBe(true);
      expect(askNoAgent.command).toBe('ask');
      expect(askNoAgent.reply).toContain('[LEAD]: Acknowledged from lead: apakah semua aman terkendali?');

      // 2. With slash /ask
      const askSlash = await runtime.handleCommand({
        text: '/ask apakah semua aman terkendali?'
      });
      expect(askSlash.ok).toBe(true);
      expect(askSlash.reply).toContain('[LEAD]: Acknowledged from lead: apakah semua aman terkendali?');

      // 3. Multi-word agent alias "desk lead"
      const askDeskLead = await runtime.handleCommand({
        text: 'ask desk lead bagaimana situasi?'
      });
      expect(askDeskLead.ok).toBe(true);
      expect(askDeskLead.reply).toContain('[LEAD]: Acknowledged from lead: bagaimana situasi?');

      // 4. Specific role "risk"
      const askRisk = await runtime.handleCommand({
        text: '/ask risk apa batas stop loss?'
      });
      expect(askRisk.ok).toBe(true);
      expect(askRisk.reply).toContain('[RISK]: Acknowledged from risk: apa batas stop loss?');

      // 5. Indonesian alias "tanya"
      const tanyaLead = await runtime.handleCommand({
        text: '/tanya pasar lagi tren apa?'
      });
      expect(tanyaLead.ok).toBe(true);
      expect(tanyaLead.reply).toContain('[LEAD]: Acknowledged from lead: pasar lagi tren apa?');

      // 6. Broadcast to @all
      const askAll = await runtime.handleCommand({
        text: '/ask @all berikan analisis cepat'
      });
      expect(askAll.ok).toBe(true);
      expect(askAll.reply).toContain('lead: Acknowledged from lead');
      expect(askAll.reply).toContain('risk: Acknowledged from risk');

      // 7. Empty prompt returns usage
      const askEmpty = await runtime.handleCommand({
        text: '/ask'
      });
      expect(askEmpty.ok).toBe(false);
      expect(askEmpty.error).toContain('Usage: /ask');
    } finally {
      await runtime.stop();
    }
  });


});
