import { describe, expect, it } from 'vitest';
import { RoleRunner, parseRetryAfterMs } from '../server/v2/agents/runner.js';
import { CycleRunner } from '../server/v2/decision/cycle.js';
import type { ProviderAssignment, ProviderCallRequest } from '../server/v2/agents/providers.js';
import type { RoleId } from '../server/v2/contracts.js';

function assignment(role: RoleId): ProviderAssignment {
  return { provider: 'openai', model: 'fixture-model', apiKey: 'fixture-key' };
}

function roleJson(req: ProviderCallRequest): string {
  if (req.role === 'risk') {
    return JSON.stringify({
      stance: 'HOLD',
      decision: 'REJECT',
      reasoning: 'Hold for spot safety.',
      confidence: { value: 0.7, scale: 'probability_0_1' },
      claimRefs: [],
      contraryRefs: []
    });
  }
  return JSON.stringify({
    stance: 'HOLD',
    reasoning: `${req.role} holds on Indodax spot.`,
    confidence: { value: 0.7, scale: 'probability_0_1' },
    claimRefs: [],
    contraryRefs: []
  });
}

describe('provider resilience on 429 and 503 (task 4.5)', () => {
  it('parses Retry-After seconds and bounds the delay', () => {
    expect(parseRetryAfterMs('Provider openai HTTP 429 retry-after 2 body: slow down')).toBe(2000);
    expect(parseRetryAfterMs('Provider openai HTTP 503 retry-after 120')).toBe(30000);
    expect(parseRetryAfterMs('Provider openai HTTP 503 body: busy')).toBeNull();
  });

  it('recovers when provider returns 429 with Retry-After then 503 before succeeding, and counts providerCalls', async () => {
    let marketCalls = 0;
    let totalCalls = 0;
    const roleRunner = new RoleRunner({
      resolveAssignment: assignment,
      retryBaseDelayMs: 5,
      maxRateLimitAttempts: 4,
      providerCaller: async (req) => {
        totalCalls += 1;
        if (req.role === 'market' && req.phase === 'observe') {
          marketCalls += 1;
          if (marketCalls === 1) throw new Error('Provider openai HTTP 429 retry-after 0.01 body: rate limit');
          if (marketCalls === 2) throw new Error('Provider openai HTTP 503 body: All providers busy');
        }
        return roleJson(req);
      }
    });
    const cycleRunner = new CycleRunner({ roleRunner });
    const result = await cycleRunner.run({
      reason: 'owner',
      accountRef: 'indodax-paper-local',
      symbol: 'BTCIDR',
      evidenceId: 'ev-45-1',
      configVersion: 1,
      policy: { minEntryConfidencePct: 65, requireTwoOfThreeAnalysts: true, availableCapitalUsdt: 1000000 },
      marketSummary: { symbol: 'BTCIDR', quote: 'IDR', bid: '1000', ask: '1010', last: '1005' }
    });

    expect(result.status).toBe('completed');
    expect(result.verdict?.action).toBe('HOLD');
    expect(marketCalls).toBe(3);
    expect(result.providerCalls).toBe(totalCalls);
    expect(result.providerCalls).toBeGreaterThanOrEqual(11);
  });

  it('stops cleanly with a readable 503 reason without infinite retries when 503 persists', async () => {
    let marketCalls = 0;
    const roleRunner = new RoleRunner({
      resolveAssignment: assignment,
      retryBaseDelayMs: 5,
      maxRateLimitAttempts: 4,
      providerCaller: async (req) => {
        if (req.role === 'market') {
          marketCalls += 1;
          throw new Error('Provider openai HTTP 503 body: {"error":"All providers busy."}');
        }
        return roleJson(req);
      }
    });
    const cycleRunner = new CycleRunner({ roleRunner });
    const result = await cycleRunner.run({
      reason: 'owner',
      accountRef: 'indodax-paper-local',
      symbol: 'BTCIDR',
      evidenceId: 'ev-45-2',
      configVersion: 1,
      policy: { minEntryConfidencePct: 65, requireTwoOfThreeAnalysts: true, availableCapitalUsdt: 1000000 },
      marketSummary: { symbol: 'BTCIDR', quote: 'IDR', bid: '1000', ask: '1010', last: '1005' }
    });

    expect(result.status).toBe('incomplete');
    expect(marketCalls).toBe(8);
    const failedMarket = result.roleResults.find((r) => r.role === 'market');
    expect(failedMarket?.status).toBe('unavailable');
    expect(failedMarket?.errorReason).toContain('HTTP 503');
    expect(failedMarket?.providerCalls).toBe(4);
  });
});
