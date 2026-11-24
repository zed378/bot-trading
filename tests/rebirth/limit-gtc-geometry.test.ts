import { describe, expect, it } from 'vitest';
import {
  CycleRunner
} from '../../server/v2/decision/cycle.js';
import type { RoleRunner } from '../../server/v2/agents/runner.js';

describe('Spot-only MARKET order normalization', () => {
  it('forces MARKET orderType and null limitPrice even if roles propose LIMIT_GTC', async () => {
    const fakeRoleRunner: RoleRunner = {
      async run(task) {
        if (task.role === 'market') {
          return {
            taskId: task.taskId,
            cycleId: task.cycleId,
            role: 'market',
            status: 'completed',
            stance: 'LONG',
            confidence: { value: 65, scale: 'integer_0_100' },
            reasoning: 'Market breakout',
            proposedOrderType: 'MARKET',
            proposedLimitPrice: null,
            proposedStop: '1.2000',
            proposedTp: '1.4000',
            claims: [],
            claimRefs: []
          };
        }
        if (task.role === 'execution') {
          return {
            taskId: task.taskId,
            cycleId: task.cycleId,
            role: 'execution',
            status: 'completed',
            stance: 'LONG',
            confidence: { value: 62, scale: 'integer_0_100' },
            reasoning: 'Propose limit retest',
            proposedOrderType: 'LIMIT_GTC',
            proposedLimitPrice: '1.2500',
            proposedStop: '1.2000',
            proposedTp: '1.4000',
            claims: [],
            claimRefs: []
          };
        }
        if (task.role === 'risk') {
          return {
            taskId: task.taskId,
            cycleId: task.cycleId,
            role: 'risk',
            status: 'completed',
            stance: 'LONG',
            confidence: { value: 65, scale: 'integer_0_100' },
            reasoning: 'Approved entry',
            decision: 'APPROVE',
            claims: [],
            claimRefs: []
          };
        }
        if (task.role === 'lead') {
          return {
            taskId: task.taskId,
            cycleId: task.cycleId,
            role: 'lead',
            status: 'completed',
            stance: 'LONG',
            confidence: { value: 65, scale: 'integer_0_100' },
            reasoning: 'Authorized entry',
            proposedOrderType: 'LIMIT_GTC',
            proposedLimitPrice: '1.2500',
            claims: [],
            claimRefs: []
          };
        }
        return {
          taskId: task.taskId,
          cycleId: task.cycleId,
          role: task.role,
          status: 'completed',
          stance: 'LONG',
          confidence: { value: 60, scale: 'integer_0_100' },
          reasoning: 'Long stance',
          claims: [],
          claimRefs: []
        };
      },
      async chat() {
        return 'chat reply';
      },
      cleanupCycle() {}
    };

    const runner = new CycleRunner({ roleRunner: fakeRoleRunner });
    const res = await runner.run({
      accountRef: 'test-acc',
      symbol: 'XRPIDR',
      evidenceId: 'ev-1',
      configVersion: 1,
      reason: 'manual',
      marketSummary: { lastPrice: '1.2779' },
      policy: {
        minEntryConfidencePct: 55,
        requireTwoOfThreeAnalysts: false,
        defaultStopPct: 5,
        takeProfitPct: 10,
        takeProfitR: 2
      }
    });

    expect(res.status).toBe('completed');
    expect(res.verdict.action).toBe('OPEN_LONG');
    expect(res.verdict.thesis?.orderType).toBe('MARKET');
    expect(res.verdict.thesis?.limitPrice).toBeNull();
    expect(res.verdict.thesis?.stop).toBe('1.2000');
    expect(res.verdict.thesis?.tp).toBe('1.4000');
  });
});
