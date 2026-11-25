import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildIndodaxContext, indodaxPromptSummary } from '../server/market/indodax-context.js';
import { RoleRunner } from '../server/v2/agents/runner.js';
import { buildRoleSystemPrompt } from '../server/v2/agents/roles.js';
import { getRoleSchemaInstruction } from '../server/v2/agents/runner.js';
import { promptPolicy, promptTicket } from '../server/v2/decision/cycle.js';
import { toIndodaxVerdict } from '../server/v2/decision/indodax-verdict.js';
import { createReplacementRuntime, type ReplacementRuntimeHandle } from '../server/v2/runtime.js';
import { FakeIndodaxClient } from './indodax-fixtures.js';

const ROLES = ['lead', 'market', 'research', 'strategist', 'risk', 'execution'] as const;
const BANNED = /\b(bybit|perp|perpetual|funding|leverage|maxLeverage|short|testnet|futures|margin|liquidation|open interest|LIMIT_GTC|supportsLimitGtc)\b/i;

const reply = (role: string, stance = 'LONG') => JSON.stringify({
  stance, reasoning: `${role} reads Indodax closed candles.`, confidence: { value: 0.8, scale: 'probability_0_1' },
  claimRefs: [], contraryRefs: [], proposedStop: '90', proposedTp: '130', proposedOrderType: 'MARKET',
  ...(role === 'risk' ? { decision: 'APPROVE' } : {})
});

describe('Indodax debate', () => {
  const runtimes: ReplacementRuntimeHandle[] = [];
  afterEach(async () => { await Promise.all(runtimes.splice(0).map((r) => r.stop())); });
  const make = (options: Parameters<typeof createReplacementRuntime>[0]) => {
    const runtime = createReplacementRuntime(options);
    runtimes.push(runtime);
    return runtime;
  };

  it('runs a real cycle whose prompts name only Indodax spot', async () => {
    const seen: { system: string; user: string }[] = [];
    const providerCaller = vi.fn(async (req: { role: string; system: string; user: string }) => {
      seen.push({ system: req.system, user: req.user });
      return reply(req.role);
    });
    const roleRunner = new RoleRunner({
      providerCaller: providerCaller as never,
      resolveAssignment: () => ({ provider: 'openai', model: 'test-model', apiKey: 'test-key' })
    });
    const runtime = make({ roleRunner, indodaxClient: new FakeIndodaxClient() });

    const result = await runtime.runIndodaxDebate('btc_usdt');

    expect(result.ok).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(6);
    for (const call of seen) {
      expect(call.system).toContain('Indodax');
      expect(call.system).not.toMatch(BANNED);
      expect(call.user).toContain('"venue": "Indodax"');
      expect(call.user).toContain('"quoteCurrency": "USDT"');
      expect(call.user).not.toMatch(BANNED);
    }
    expect(result.verdict).toMatchObject({ symbol: 'BTCUSDT', action: 'OPEN_LONG', executed: false });
    expect(runtime.snapshot().verdicts[0]).toMatchObject({ symbol: 'BTCUSDT', action: 'OPEN_LONG', executed: false });
    expect(runtime.snapshot().auto.running).toBe(false);
  }, 30_000);

  it('rejects a pair Indodax does not list before any agent is called', async () => {
    const cycleRunner = { run: vi.fn() };
    const runtime = make({ cycleRunner: cycleRunner as never, indodaxClient: new FakeIndodaxClient() });
    const result = await runtime.runIndodaxDebate('FOOIDR');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Indodax/);
    expect(cycleRunner.run).not.toHaveBeenCalled();
  });

  it('answers the analyze command with the pair error and starts nothing for an unlisted pair', async () => {
    const cycleRunner = { run: vi.fn() };
    const runtime = make({ cycleRunner: cycleRunner as never, indodaxClient: new FakeIndodaxClient() });
    const res = await runtime.handleCommand({ text: 'analyze FOOIDR' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Indodax/);
    expect(cycleRunner.run).not.toHaveBeenCalled();
  });

  it('turns a second-side entry and a resting limit order into a HOLD that says why', async () => {
    for (const verdict of [
      { action: 'OPEN_SHORT' as const, thesis: { stop: '110', tp: '80', orderType: 'MARKET' }, rejectionReason: null },
      { action: 'OPEN_LONG' as const, thesis: { stop: '90', tp: '130', orderType: 'LIMIT_GTC' }, rejectionReason: null }
    ]) {
      const mapped = toIndodaxVerdict({ status: 'completed', verdict }, 'BTCIDR');
      expect(mapped).toMatchObject({ action: 'HOLD', thesis: null });
      expect(mapped.rejectionReason).toMatch(/Rejected/);
    }
    expect(toIndodaxVerdict({ status: 'incomplete', verdict: null }, 'BTCIDR')).toMatchObject({ action: 'HOLD' });
  });

  it('records a HOLD, not an order, when the cycle returns a short entry', async () => {
    const cycleRunner = { run: vi.fn(async () => ({
      status: 'completed', roleResults: [],
      verdict: { action: 'OPEN_SHORT', symbol: 'BTCIDR', thesis: { stop: '110', tp: '80', orderType: 'MARKET' }, exit: null, rejectionReason: null }
    })) };
    const runtime = make({ cycleRunner: cycleRunner as never, indodaxClient: new FakeIndodaxClient() });
    const result = await runtime.runIndodaxDebate('BTCIDR');
    expect(result.verdict).toMatchObject({ action: 'HOLD', executed: false });
    expect(result.verdict?.reason).toMatch(/spot-only/);
  });

  it('refuses to start while the kill switch is on', async () => {
    const cycleRunner = { run: vi.fn() };
    const runtime = make({ cycleRunner: cycleRunner as never, indodaxClient: new FakeIndodaxClient() });
    runtime.updateState((draft) => { draft.killed = true; });
    const result = await runtime.runIndodaxDebate('BTCIDR');
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/Kill switch/);
    expect(cycleRunner.run).not.toHaveBeenCalled();
  });

  it('gives the debate and the PAPER session the same market description for the same pair', async () => {
    const cycleRunner = { run: vi.fn(async () => ({ status: 'completed', roleResults: [], verdict: null })) };
    const client = new FakeIndodaxClient();
    const runtime = make({ cycleRunner: cycleRunner as never, indodaxClient: client });

    await runtime.runIndodaxDebate('BTCIDR');
    const paperSummary = { ...indodaxPromptSummary(await buildIndodaxContext(client, 'BTCIDR', '4h')), mode: 'PAPER' };
    await runtime.runIndodaxPaperCycle?.({ symbol: 'BTCIDR', accountRef: 'indodax-paper-local', marketSummary: paperSummary, hasPosition: false, signal: new AbortController().signal });

    const [debateCall, paperCall] = cycleRunner.run.mock.calls.map((c) => (c as unknown as [{ marketSummary: unknown; policy: unknown }])[0]);
    expect(debateCall.marketSummary).toEqual(paperCall.marketSummary);
    expect(debateCall.policy).toEqual(paperCall.policy);
  });
});

describe('Indodax chat context', () => {
  it('shows an agent chat the Indodax desk only, with fresh data for the pair in the question', async () => {
    const seen: string[] = [];
    const roleRunner = new RoleRunner({
      providerCaller: (async (req: { user: string }) => { seen.push(req.user); return JSON.stringify({ reply: 'Indodax spot only, Boss.' }); }) as never,
      resolveAssignment: () => ({ provider: 'openai', model: 'test-model', apiKey: 'test-key' })
    });
    const runtime = createReplacementRuntime({ roleRunner, indodaxClient: new FakeIndodaxClient() });
    try {
      const res = await runtime.handleCommand({ text: '/ask lead is leverage available?', symbol: 'BTCIDR' } as never);
      expect(res.ok).toBe(true);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toContain('"venue": "Indodax spot"');
      expect(seen[0]).toContain('"activePair": "BTCIDR"');
      expect(seen[0]).toContain('"quoteCurrency": "IDR"');
      const desk = seen[0].slice(0, seen[0].lastIndexOf('is leverage available?'));
      expect(desk).not.toMatch(/\b(bybit|perp|perpetual|funding|futures|margin|liquidation)\b/i);
    } finally { await runtime.stop(); }
  }, 30_000);
});

describe('spot-only prompt text', () => {
  it('names no instrument or order type Indodax spot lacks, for every role', () => {
    for (const role of ROLES) {
      const text = `${buildRoleSystemPrompt(role)}\n${getRoleSchemaInstruction(role)}`;
      expect(text).toContain('Indodax');
      expect(text).not.toMatch(BANNED);
    }
  });

  it('shows the model a spot view of the policy and the ticket', () => {
    const policy = promptPolicy({
      minEntryConfidencePct: 65, requireTwoOfThreeAnalysts: true, maxLeverage: 5, defaultStopPct: 5, takeProfitPct: 10, takeProfitR: 2,
      maxPositions: 3, supportsLimitGtc: true, hasPosition: true, positionSide: 'SHORT',
      profileBaselineStopPrice: { long: '95', short: '105' }, profileBaselineTpPrice: { long: '110', short: '90' }
    });
    expect(JSON.stringify(policy)).not.toMatch(BANNED);
    expect(policy).toMatchObject({ baselineStopPrice: '95', baselineTpPrice: '110', hasPosition: true });
    const ticket = promptTicket({ side: 'SHORT', orderType: 'LIMIT_GTC', limitPrice: '100', stop: '105', tp: '90', leverage: 5 });
    expect(JSON.stringify(ticket)).not.toMatch(BANNED);
    expect(ticket).toMatchObject({ side: null });
  });
});
