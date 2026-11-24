import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RoleRunner } from '../../server/v2/agents/runner.js';
import { CycleRunner } from '../../server/v2/decision/cycle.js';
import { AccountRegistry } from '../../server/v2/accounts/registry.js';
import { ExecutionAuthorityService } from '../../server/v2/accounts/authority.js';
import { RuntimeStore } from '../../server/v2/store/database.js';
import {
  ExecutionGateway,
  type GatewayVenueTransport,
  type TradeIntent
} from '../../server/v2/execution/gateway.js';
import { unavailableEvidence, verifiedEvidence, type MarketFrame } from '../../server/v2/contracts.js';

const tempDirs: string[] = [];
const openStores: RuntimeStore[] = [];

afterEach(async () => {
  while (openStores.length > 0) {
    const s = openStores.pop();
    if (s) await s.close();
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Windows WAL handles can lag behind test teardown.
      }
    }
  }
});

function makeFreshMarket(price = '68500'): MarketFrame {
  return {
    evidenceId: 'ev-int-mkt',
    revision: 1,
    symbol: 'BTCUSDT',
    venue: 'aster',
    category: 'linear',
    asOf: Date.now(),
    last: verifiedEvidence({ value: price, source: 'aster.tickers.BTCUSDT', unit: 'USDT' }),
    bid: verifiedEvidence({ value: price, source: 'aster.tickers.BTCUSDT', unit: 'USDT' }),
    ask: verifiedEvidence({ value: price, source: 'aster.tickers.BTCUSDT', unit: 'USDT' }),
    closed: { '1m': [], '5m': [], '15m': [], '1h': [], '4h': [], '1d': [] },
    current: {},
    tradesEvidenceId: null,
    bookEvidenceId: null,
    funding: unavailableEvidence('aster.tickers.BTCUSDT', 'n/a'),
    openInterest: unavailableEvidence('aster.tickers.BTCUSDT', 'n/a')
  };
}

describe('Approved order consistency', () => {
  it('gives Risk and Lead the same Owner candidate including side', async () => {
    const seen: Array<{ role: string; user: string }> = [];
    const runner = new RoleRunner({
      providerCaller: async (req) => {
        seen.push({ role: req.role, user: req.user });
        if (req.role === 'risk') {
          return JSON.stringify({
            stance: 'LONG',
            decision: 'APPROVE',
            claimRefs: ['ev-1'],
            contraryRefs: [],
            reasoning: 'Candidate matches Owner caps.',
            confidence: { value: 0.8, scale: 'probability_0_1' }
          });
        }
        if (req.role === 'execution') {
          return JSON.stringify({
            stance: 'LONG',
            claimRefs: ['ev-1'],
            contraryRefs: [],
            reasoning: 'Resting limit is the candidate.',
            confidence: { value: 0.7, scale: 'probability_0_1' },
            proposedStop: '67000',
            proposedTp: '72000',
            proposedOrderType: 'LIMIT_GTC',
            proposedLimitPrice: '68400'
          });
        }
        if (req.role === 'lead') {
          return JSON.stringify({
            stance: 'LONG',
            claimRefs: ['ev-1'],
            contraryRefs: [],
            reasoning: 'Lead keeps the working ticket.',
            confidence: { value: 0.4, scale: 'probability_0_1' },
            proposedStop: '67000',
            proposedTp: '72000',
            proposedOrderType: 'LIMIT_GTC',
            proposedLimitPrice: '68400'
          });
        }
        return JSON.stringify({
          stance: 'LONG',
          claimRefs: ['ev-1'],
          contraryRefs: [],
          reasoning: `${req.role} observe`,
          confidence: { value: 0.7, scale: 'probability_0_1' },
          proposedStop: '67000'
        });
      },
      resolveAssignment: () => ({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-test' })
    });

    const out = await new CycleRunner({ roleRunner: runner }).run({
      cycleId: 'cycle-candidate-consistency',
      reason: 'owner',
      accountRef: 'paper:default',
      symbol: 'BTCUSDT',
      evidenceId: 'ev-1',
      configVersion: 1,
      policy: {
        minEntryConfidencePct: 60,
        requireTwoOfThreeAnalysts: false,
        maxLeverage: 5,
        defaultStopPct: 20,
        takeProfitPct: 40,
        availableCapitalUsdt: 800,
        allocationPerOrderUsdt: 266.66,
        maxPositions: 3,
        orderSizePct: null,
        dailyLossLimitPct: 10
      },
      marketSummary: { last: '68500' }
    });

    expect(out.verdict?.action).toBe('OPEN_LONG');
    expect(out.verdict?.thesis?.orderType).toBe('LIMIT_GTC');
    expect(out.verdict?.thesis?.limitPrice).toBe('68400');
    expect(out.verdict?.thesis?.stop).toBe('67000');
    expect(out.verdict?.thesis?.tp).toBe('72000');

    const riskPrompt = seen.find((s) => s.role === 'risk')?.user ?? '';
    const leadPrompt = seen.find((s) => s.role === 'lead')?.user ?? '';
    for (const prompt of [riskPrompt, leadPrompt]) {
      expect(prompt).toContain('"side": "LONG"');
      expect(prompt).toContain('67000');
      expect(prompt).toContain('72000');
      expect(prompt).not.toContain('LIMIT_GTC');
      expect(prompt).not.toContain('maxLeverage');
    }
  });
});


