import { IndodaxVerdictSchema, type IndodaxVerdict } from '../../../shared/indodax-verdict.js';

interface CycleOutcome {
  status: 'completed' | 'incomplete' | 'cancelled';
  verdict: {
    action: 'OPEN_LONG' | 'OPEN_SHORT' | 'HOLD' | 'CLOSE';
    thesis: { stop: string; tp: string | null; orderType: string } | null;
    rejectionReason: string | null;
  } | null;
}

/**
 * Final spot verdict boundary for Indodax. Rejects any unexpected non-spot action
 * or order type (such as OPEN_SHORT or LIMIT_GTC) by turning it into an explicit HOLD.
 */
export function toIndodaxVerdict(outcome: CycleOutcome, symbol: string): IndodaxVerdict {
  const hold = (rejectionReason: string): IndodaxVerdict => ({ action: 'HOLD', symbol, thesis: null, rejectionReason });
  const v = outcome.verdict;
  if (outcome.status !== 'completed' || !v) return hold('Deliberation did not complete');
  if (v.action === 'OPEN_SHORT') return hold('Rejected: Indodax is spot-only, there is no short entry');
  const parsed = IndodaxVerdictSchema.safeParse({
    action: v.action,
    symbol,
    thesis: v.action === 'OPEN_LONG' && v.thesis ? { stop: v.thesis.stop, tp: v.thesis.tp ?? null, orderType: v.thesis.orderType } : null,
    rejectionReason: v.rejectionReason ?? null
  });
  return parsed.success ? parsed.data : hold(`Rejected: verdict does not fit Indodax spot (${parsed.error.issues[0]?.message ?? 'invalid'})`);
}
