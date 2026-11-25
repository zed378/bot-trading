import { z } from 'zod';

const positive = z.string().regex(/^\d+(?:\.\d+)?$/).refine((v) => Number(v) > 0);

/**
 * Verdict an Indodax spot cycle may return. Anything outside this shape (a second side, leverage,
 * a resting limit order) fails parsing instead of being accepted and rejected later.
 */
export const IndodaxVerdictSchema = z.object({
  action: z.enum(['OPEN_LONG', 'HOLD', 'CLOSE']),
  symbol: z.string().regex(/^[A-Z0-9]{1,20}(?:IDR|USDT)$/),
  thesis: z.object({
    stop: positive,
    tp: positive.nullable(),
    orderType: z.literal('MARKET')
  }).strict().nullable(),
  rejectionReason: z.string().max(500).nullable()
}).strict().superRefine((v, ctx) => {
  const issue = (message: string, path: string[]) => ctx.addIssue({ code: 'custom', message, path });
  if (v.action === 'OPEN_LONG' && !v.thesis) issue('OPEN_LONG needs a thesis with a stop', ['thesis']);
  if (v.action !== 'OPEN_LONG' && v.thesis) issue('only OPEN_LONG carries a thesis', ['thesis']);
  if (v.thesis?.tp && Number(v.thesis.tp) <= Number(v.thesis.stop)) issue('take profit must be above the stop', ['thesis', 'tp']);
});
export type IndodaxVerdict = z.infer<typeof IndodaxVerdictSchema>;
