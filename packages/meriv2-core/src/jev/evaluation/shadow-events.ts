import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { EVIDENCE_OUTCOMES, type EvidenceOutcome } from '../decision-contract';
import type { JevClaimEvidenceFixture } from '../fixture-schema';

const operationalStates = [
  'not_checked',
  'retrieval_failed',
  'document_unavailable',
  'judge_unavailable',
  'repair_budget_exhausted',
  'timeout',
  'cancelled',
  'malformed_response',
  'scope_refused',
] as const;

export const shadowLoggedDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('outcome'),
    outcome: z.enum(EVIDENCE_OUTCOMES),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.enum(EVIDENCE_OUTCOMES), z.number()),
    reasonCodes: z.array(z.string()),
    model: z.string().min(1),
    questionVersion: z.string().min(1),
    latencyMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('failure'),
    state: z.enum(operationalStates),
    confidence: z.null(),
    probabilities: z.null(),
    reasonCodes: z.array(z.string()),
    model: z.string().min(1),
    questionVersion: z.string().min(1),
    latencyMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
  }),
]);

export const evidenceShadowEventSchema = z.object({
  event: z.literal('meri.evidence_shadow').default('meri.evidence_shadow'),
  conversationId: z.string().nullable(),
  turnId: z.string().nullable(),
  claimId: z.string().min(1),
  claimKind: z.string().min(1),
  claimCategory: z.string().min(1),
  envelopeHash: z.string().min(1),
  eligibility: z.object({ eligible: z.boolean(), reason: z.string().min(1) }).passthrough(),
  jev: shadowLoggedDecisionSchema,
  legacy: shadowLoggedDecisionSchema,
  agreement: z.boolean(),
  legacyAdapterVersion: z.enum([
    'legacy-skeptic-adapter.v1',
    'legacy-skeptic-adapter.v2',
  ]).default('legacy-skeptic-adapter.v1'),
  proposedAction: z.object({ jev: z.string(), legacy: z.string() }),
  escalated: z.boolean().optional(),
  escalationReasons: z.array(z.enum([
    'jev_unavailable', 'jev_failure', 'low_confidence', 'compound_claim', 'conflict',
    'high_impact_category', 'out_of_distribution', 'audit_sample',
  ])).optional(),
  audited: z.boolean().optional(),
  auditDisagreement: z.boolean().optional(),
  claimText: z.string().optional(),
  split: z.enum(['tuning', 'heldout']).optional(),
  source: z.enum(['live', 'replay']).default('live'),
});

export const evidenceShadowTurnEventSchema = z.object({
  event: z.literal('meri.evidence_shadow.turn').default('meri.evidence_shadow.turn'),
  conversationId: z.string().nullable(),
  turnId: z.string().nullable(),
  selected: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  budgetExhausted: z.boolean(),
  durationMs: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  sampled: z.boolean(),
  source: z.enum(['live', 'replay']).default('live'),
});

export type EvidenceShadowEvent = z.infer<typeof evidenceShadowEventSchema>;
export type EvidenceShadowTurnEvent = z.infer<typeof evidenceShadowTurnEventSchema>;
export type ShadowEvent = EvidenceShadowEvent | EvidenceShadowTurnEvent;

export interface ReadShadowEventsResult {
  events: ShadowEvent[];
  rejected: number;
  unrelated: number;
}

function eventPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const name = row.event ?? row.message ?? row.name;
  if (name !== 'meri.evidence_shadow' && name !== 'meri.evidence_shadow.turn') return null;
  const fields = row.fields && typeof row.fields === 'object' ? row.fields as Record<string, unknown> : row;
  return { ...fields, event: name };
}

export function readShadowEvents(jsonlPath: string): ReadShadowEventsResult {
  const text = readFileSync(jsonlPath, 'utf8');
  const result: ReadShadowEventsResult = { events: [], rejected: 0, unrelated: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      result.rejected += 1;
      continue;
    }
    const payload = eventPayload(parsed);
    if (!payload) {
      result.unrelated += 1;
      continue;
    }
    const name = (payload as { event: string }).event;
    const checked = name === 'meri.evidence_shadow'
      ? evidenceShadowEventSchema.safeParse(payload)
      : evidenceShadowTurnEventSchema.safeParse(payload);
    if (checked.success) result.events.push(checked.data);
    else result.rejected += 1;
  }
  return result;
}

export const humanLabelsSchema = z.object({
  version: z.literal('jev_human_labels_v1'),
  labels: z.array(z.object({
    claimId: z.string().min(1).optional(),
    envelopeHash: z.string().min(1).optional(),
    label: z.enum(EVIDENCE_OUTCOMES),
    status: z.enum(['proposed', 'approved']).default('approved'),
    reviewer: z.string().min(1),
    reviewedAt: z.string().datetime(),
    note: z.string(),
  }).refine((row) => Boolean(row.claimId || row.envelopeHash), {
    message: 'A human label requires claimId or envelopeHash',
  })),
});

export type HumanLabels = z.infer<typeof humanLabelsSchema>;
export type HumanLabel = HumanLabels['labels'][number];

export type JoinedShadowRow = Omit<EvidenceShadowEvent, 'split' | 'claimText'> & {
  split: 'tuning' | 'heldout' | null;
  claimText: string | null;
  humanLabel: EvidenceOutcome | null;
  labelSource: 'override' | 'fixture' | null;
  reviewer: string | null;
};

export function joinWithLabels(
  events: readonly EvidenceShadowEvent[],
  fixtures?: JevClaimEvidenceFixture,
  labelsOverride?: HumanLabels | readonly HumanLabel[],
): JoinedShadowRow[] {
  const labels: readonly HumanLabel[] = !labelsOverride
    ? []
    : Array.isArray(labelsOverride)
      ? labelsOverride
      : (labelsOverride as HumanLabels).labels;
  const approved = labels.filter((label) => label.status === 'approved');
  return events.map((event) => {
    const override = approved.find((label) =>
      (label.claimId && label.claimId === event.claimId)
      || (label.envelopeHash && label.envelopeHash === event.envelopeHash));
    const fixture = fixtures?.cases.find((item) => item.claim.id === event.claimId || item.id === event.claimId);
    const fixtureApproved = fixture?.humanReview.status === 'approved';
    return {
      ...event,
      split: event.split ?? fixture?.split ?? null,
      claimText: event.claimText ?? fixture?.claim.text ?? null,
      humanLabel: override?.label ?? (fixtureApproved ? fixture.expectedOutcome : null),
      labelSource: override ? 'override' : fixtureApproved ? 'fixture' : null,
      reviewer: override?.reviewer ?? (fixtureApproved ? fixture.humanReview.reviewer : null),
    };
  });
}
