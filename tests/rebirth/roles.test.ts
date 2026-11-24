import { describe, expect, it } from 'vitest';
import {
  GROK_ROLE_ALIASES,
  ROLE_DEFINITIONS,
  buildRoleSystemPrompt,
  resolveCanonicalRole
} from '../../server/v2/agents/roles.js';
import {
  RoleRunner,
  satisfiesLeadProbabilityThreshold
} from '../../server/v2/agents/runner.js';
import type { RoleTask } from '../../server/v2/agents/runner.js';
import type { ProviderCaller } from '../../server/v2/agents/providers.js';

describe('T07 six-role integrity, task fencing, confidence scales and non-mock unavailability', () => {
  it('exactly_six_roles', () => {
    const ids = Object.keys(ROLE_DEFINITIONS);
    expect(ids).toEqual(['lead', 'market', 'research', 'strategist', 'risk', 'execution']);
    expect(ids).toHaveLength(6);
    expect(ids).not.toContain('jev');

    expect(resolveCanonicalRole('Head of Trading')).toBe('lead');
    expect(resolveCanonicalRole('Technical Market')).toBe('market');
    expect(resolveCanonicalRole('Macro Research')).toBe('research');
    expect(resolveCanonicalRole('Trading Systems')).toBe('strategist');
    expect(resolveCanonicalRole('Head of Risk')).toBe('risk');
    expect(resolveCanonicalRole('Execution Trader')).toBe('execution');
    expect(Object.keys(GROK_ROLE_ALIASES)).toHaveLength(6);

    for (const id of ids as Array<keyof typeof ROLE_DEFINITIONS>) {
      const prompt = buildRoleSystemPrompt(id);
      expect(prompt).toContain('Trading Agent Mpu Gandring');
      expect(prompt).not.toContain('\u2014');
    }
  });

  it('model_change_applies_next_task', async () => {
    let activeModel = 'grok-3';
    let activeProvider = 'xai';

    const runner = new RoleRunner({
      providerCaller: async () =>
        JSON.stringify({
          stance: 'HOLD',
          claimRefs: ['ev-1'],
          contraryRefs: [],
          reasoning: 'No confirmed break.',
          confidence: { value: 3, scale: 'ordinal_1_5' }
        }),
      resolveAssignment: () => ({
        provider: activeProvider,
        model: activeModel,
        apiKey: 'configured-key'
      })
    });

    const first = await runner.run({
      cycleId: 'cycle-model-1',
      role: 'market',
      phase: 'observe',
      taskAttempt: 1,
      evidenceId: 'ev-1',
      configVersion: 1,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 10_000
    });
    expect(first.provider).toBe('xai');
    expect(first.model).toBe('grok-3');

    activeProvider = 'anthropic';
    activeModel = 'claude-sonnet-4-5';

    const second = await runner.run({
      cycleId: 'cycle-model-2',
      role: 'market',
      phase: 'observe',
      taskAttempt: 1,
      evidenceId: 'ev-2',
      configVersion: 2,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 10_000
    });
    expect(second.provider).toBe('anthropic');
    expect(second.model).toBe('claude-sonnet-4-5');
  });

  it('cancellation_discards_late_result', async () => {
    let releaseAttempt1: (() => void) | null = null;
    const runner = new RoleRunner({
      providerCaller: async (req) => {
        if (req.taskAttempt === 1) {
          await new Promise<void>((resolve) => {
            releaseAttempt1 = resolve;
            req.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return JSON.stringify({
          stance: req.taskAttempt === 1 ? 'LONG' : 'SHORT',
          claimRefs: [`attempt-${req.taskAttempt}`],
          contraryRefs: [],
          reasoning: `Attempt ${req.taskAttempt}`,
          confidence: { value: 0.65, scale: 'probability_0_1' }
        });
      },
      resolveAssignment: () => ({
        provider: 'openai',
        model: 'gpt-5',
        apiKey: 'key-1'
      })
    });

    const abort1 = new AbortController();
    const p1 = runner.run(
      {
        cycleId: 'cycle-cancel-1',
        role: 'lead',
        phase: 'final',
        taskAttempt: 1,
        evidenceId: 'ev-cancel',
        configVersion: 1,
        accountRef: 'paper:default',
        route: 'LOCAL',
        deadlineAt: Date.now() + 30_000
      },
      abort1.signal
    );

    const p2 = runner.run({
      cycleId: 'cycle-cancel-1',
      role: 'lead',
      phase: 'final',
      taskAttempt: 2,
      evidenceId: 'ev-cancel',
      configVersion: 1,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 30_000
    });

    abort1.abort();
    releaseAttempt1?.();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe('cancelled');
    expect(r1.stance).toBeNull();
    expect(r2.status).toBe('completed');
    expect(r2.stance).toBe('HOLD');
    expect(runner.getAcceptedResult('cycle-cancel-1', 'lead', 'final')?.taskAttempt).toBe(2);
  });

  it('maps non-compliant SHORT stance to HOLD without holding and CLOSE with holding', async () => {
    const runner = new RoleRunner({
      providerCaller: async () => JSON.stringify({
        stance: 'SHORT',
        claimRefs: [],
        contraryRefs: [],
        reasoning: 'Bearish view',
        confidence: { value: 0.7, scale: 'probability_0_1' }
      }),
      resolveAssignment: () => ({ provider: 'openai', model: 'gpt-5', apiKey: 'key-1' })
    });
    const noHolding = await runner.run({
      cycleId: 'cycle-short-map-1',
      role: 'market',
      phase: 'observe',
      taskAttempt: 1,
      evidenceId: 'ev-1',
      configVersion: 1,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 30_000,
      promptContext: { policy: { hasPosition: false } }
    });
    const withHolding = await runner.run({
      cycleId: 'cycle-short-map-2',
      role: 'market',
      phase: 'observe',
      taskAttempt: 1,
      evidenceId: 'ev-2',
      configVersion: 1,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 30_000,
      promptContext: { policy: { hasPosition: true } }
    });
    expect(noHolding.stance).toBe('HOLD');
    expect(withHolding.stance).toBe('CLOSE');
  });

  it('no_key_is_unavailable_not_mock', async () => {
    let callerInvoked = false;
    const runner = new RoleRunner({
      providerCaller: async () => {
        callerInvoked = true;
        return '{}';
      },
      resolveAssignment: () => ({
        provider: 'xai',
        model: 'grok-3',
        apiKey: null
      })
    });

    const res = await runner.run({
      cycleId: 'cycle-nokey-1',
      role: 'strategist',
      phase: 'observe',
      taskAttempt: 1,
      evidenceId: 'ev-nokey',
      configVersion: 1,
      accountRef: 'paper:default',
      route: 'LOCAL',
      deadlineAt: Date.now() + 10_000
    });

    expect(callerInvoked).toBe(false);
    expect(res.status).toBe('unavailable');
    expect(res.stance).toBeNull();
    expect(res.provider).toBe('xai');
    expect(res.errorReason).toMatch(/missing|unconfigured|api key/i);
  });

  it('ordinal_confidence_is_not_probability', () => {
    const grokTmOrdinal = {
      value: 5,
      scale: 'ordinal_1_5' as const,
      source: 'grok:market',
      availability: 'AVAILABLE' as const,
      reason: null
    };
    const tsScore = {
      value: 92,
      scale: 'score_0_100' as const,
      source: 'local:strategist',
      availability: 'AVAILABLE' as const,
      reason: null
    };
    const leadProb = {
      value: 0.74,
      scale: 'probability_0_1' as const,
      source: 'local:lead',
      availability: 'AVAILABLE' as const,
      reason: null
    };

    expect(grokTmOrdinal.value).toBe(5);
    expect(grokTmOrdinal.scale).toBe('ordinal_1_5');
    expect(satisfiesLeadProbabilityThreshold('market', grokTmOrdinal, 65)).toBe(false);
    expect(satisfiesLeadProbabilityThreshold('lead', grokTmOrdinal, 65)).toBe(false);
    expect(satisfiesLeadProbabilityThreshold('strategist', tsScore, 65)).toBe(false);
    expect(satisfiesLeadProbabilityThreshold('lead', tsScore, 65)).toBe(false);
    expect(satisfiesLeadProbabilityThreshold('lead', leadProb, 70)).toBe(true);
    expect(satisfiesLeadProbabilityThreshold('lead', leadProb, 80)).toBe(false);
  });

  it('handles_think_tags_and_chatter_in_raw_replies', async () => {
    let capturedPrompt = '';
    const runner = new RoleRunner({
      providerCaller: async (req) => {
        capturedPrompt = req.user;
        return '<think>The market is ranging, wait for breakout</think>\nHere is my analysis:\n```json\n{\n  "stance": "HOLD",\n  "reasoning": "Wait for valid reclaim of resistance",\n  "confidence": 0.45\n}\n```\nHope that helps!';
      },
      resolveAssignment: () => ({
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4.1-flash',
        apiKey: 'test-key'
      })
    });

    const res = await runner.run({
      cycleId: 'c1',
      role: 'market',
      phase: 'observe',
      taskAttempt: 1,
      evidenceId: 'ev1',
      configVersion: 1,
      accountRef: 'acct1',
      route: 'LOCAL',
      deadlineAt: Date.now() + 60000,
      symbol: 'BTCUSDT'
    });

    expect(capturedPrompt).toContain('Respond strictly with a valid JSON object matching this schema');
    expect(res.status).toBe('completed');
    expect(res.stance).toBe('HOLD');
    expect(res.confidence.value).toBe(0.45);
    expect(res.confidence.scale).toBe('probability_0_1');
  });

  it('normalizes_numeric_confidence_and_infers_risk_decision', async () => {
    const runner = new RoleRunner({
      providerCaller: async (req) => {
        if (req.role === 'risk') {
          return JSON.stringify({
            stance: 'LONG',
            reasoning: 'Parameters approved within risk limits',
            confidence: 90
          });
        }
        return JSON.stringify({
          stance: 'LONG',
          reasoning: 'Strong bullish engulfing candle',
          confidence: 0.88
        });
      },
      resolveAssignment: () => ({
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4.1-flash',
        apiKey: 'test-key'
      })
    });

    const riskRes = await runner.run({
      cycleId: 'c2',
      role: 'risk',
      phase: 'final',
      taskAttempt: 1,
      evidenceId: 'ev2',
      configVersion: 1,
      accountRef: 'acct1',
      route: 'LOCAL',
      deadlineAt: Date.now() + 60000,
      symbol: 'BTCUSDT'
    });

    expect(riskRes.status).toBe('completed');
    expect((riskRes as any).decision).toBe('APPROVE');
    expect(riskRes.confidence.value).toBe(90);
    expect(riskRes.confidence.scale).toBe('score_0_100');
  });

  it('runner_cleans_up_active_attempts_and_bounds_cycles', async () => {
    const runner = new RoleRunner({
      providerCaller: async () => JSON.stringify({
        stance: 'LONG',
        reasoning: 'Bounded memory cycle',
        confidence: { value: 0.8, scale: 'probability_0_1' }
      }),
      resolveAssignment: () => ({
        provider: 'xai',
        model: 'grok-3',
        apiKey: 'test-key'
      })
    });

    for (let i = 0; i < 30; i++) {
      await runner.run({
        cycleId: `cycle-mem-${i}`,
        role: 'lead',
        phase: 'final',
        taskAttempt: 1,
        evidenceId: `ev-${i}`,
        configVersion: 1,
        accountRef: 'paper:default',
        route: 'LOCAL',
        deadlineAt: Date.now() + 30_000,
        symbol: 'BTCUSDT'
      });
    }

    const metrics = runner.getMetrics();
    expect(metrics.activeAttemptsCount).toBe(0);
    expect(metrics.retainedCyclesCount).toBeLessThanOrEqual(20);
    expect(metrics.acceptedResultsCount).toBeLessThanOrEqual(20);

    runner.cleanupCycle('cycle-mem-29');
    expect(runner.getAcceptedResult('cycle-mem-29', 'lead', 'final')).toBeUndefined();
  });
});
