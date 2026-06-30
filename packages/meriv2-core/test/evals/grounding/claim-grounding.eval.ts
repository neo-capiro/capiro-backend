import { assembleClaimMap, type ClaimDraft } from '../../../src/index';
import type { EvalCase } from '../types';

export const claimGroundingCase: EvalCase = {
  id: 'grounding.claim-evidence',
  category: 'grounding',
  description: 'every EMITTED claim carries >= 1 evidence; unsupported are flagged, not emitted',
  async run() {
    const seedFailure = process.env.MERIV2_EVAL_SEED_FAILURE === '1';
    const claims: ClaimDraft[] = [
      {
        subjectType: 'bill',
        subjectId: 'hr-1',
        statement: 'HR 1 was referred to committee',
        confidence: 'high',
        evidence: [{ sourceType: 'congress_bill', sourceId: 'hr-1', accessedAt: new Date(0) }],
      },
      {
        subjectType: 'bill',
        subjectId: 'hr-2',
        statement: 'HR 2 will pass',
        confidence: 'low',
        evidence: [],
      },
    ];

    const map = assembleClaimMap(claims);
    // A grounded packet emits ONLY supported claims. The buggy path (seeded
    // failure) emits unsupported claims too — which the gate must catch.
    const emitted = seedFailure ? [...map.supported, ...map.unsupported] : map.supported;
    const ungrounded = emitted.filter((c) => c.evidence.length === 0);
    return {
      pass: ungrounded.length === 0,
      detail:
        ungrounded.length === 0
          ? `${emitted.length} claim(s) emitted, all evidence-backed`
          : `UNGROUNDED EMITTED: [${ungrounded.map((c) => c.subjectId).join(', ')}]`,
    };
  },
};
