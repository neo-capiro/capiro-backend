import { z } from 'zod';
import { EVIDENCE_OUTCOMES } from './decision-contract';

export const jevClaimEvidenceFixtureSchema = z.object({
  version: z.literal('jev_claim_evidence_fixture_v1'),
  cases: z.array(z.object({
    id: z.string().min(1),
    split: z.enum(['tuning', 'heldout']),
    category: z.enum(['supported', 'contradicted', 'insufficient', 'conflicting', 'stale', 'numerical', 'document_missing', 'adversarial']),
    claim: z.object({ id: z.string().min(1), text: z.string().min(1), kind: z.enum(['fact', 'inference', 'recommendation', 'uncertainty']), category: z.string().min(1) }),
    evidence: z.array(z.object({ id: z.string().min(1), text: z.string(), locator: z.string().optional(), sourceDate: z.string().optional() })),
    tenantId: z.string().uuid(),
    clientId: z.string().min(1),
    expectedOutcome: z.enum(EVIDENCE_OUTCOMES),
    expectedOperationalState: z.string().optional(),
    rationale: z.string().min(1),
    humanReview: z.object({ status: z.literal('proposed'), reviewer: z.null(), reviewedAt: z.null() }),
  })).min(24),
});
export type JevClaimEvidenceFixture = z.infer<typeof jevClaimEvidenceFixtureSchema>;
export type JevClaimEvidenceCase = JevClaimEvidenceFixture['cases'][number];
