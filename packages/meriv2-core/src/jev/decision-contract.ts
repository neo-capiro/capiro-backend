import { z } from 'zod';
import type { AssuredClaim } from '../assurance/claim-ledger';
import type { AssuranceSurface } from '../assurance/risk-gate';
import { hashEvidenceContent } from '../grounding/evidence';

export const EVIDENCE_OUTCOMES = [
  'supported',
  'contradicted',
  'insufficient_evidence',
  'conflicting_evidence',
] as const;
export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number];

export type EvidenceOperationalState =
  | 'not_checked'
  | 'retrieval_failed'
  | 'document_unavailable'
  | 'judge_unavailable'
  | 'repair_budget_exhausted'
  | 'timeout'
  | 'cancelled'
  | 'malformed_response'
  | 'scope_refused';

export interface DecisionProviderMetadata {
  name: string;
  model: string;
  questionVersion: string;
}

export type EvidenceDecision =
  | {
      kind: 'outcome';
      outcome: EvidenceOutcome;
      probabilities: Record<EvidenceOutcome, number>;
      confidence: number;
      reasonCodes: string[];
      evidenceIds: string[];
      provider: DecisionProviderMetadata;
      latencyMs: number;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | {
      kind: 'failure';
      state: EvidenceOperationalState;
      reasonCodes: string[];
      provider: DecisionProviderMetadata;
      latencyMs: number;
    };

const evidenceSourceSchema = z.object({
  evidenceId: z.string().min(1),
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  documentId: z.string().min(1).nullable(),
  version: z.string().min(1).nullable(),
  locator: z.string().min(1).nullable(),
  passage: z.string(),
  sourceDate: z.string().nullable(),
  retrievedAt: z.string().nullable(),
});

export const evidenceEnvelopeSchema = z.object({
  envelopeVersion: z.literal('meri-evidence-envelope-v1'),
  claimId: z.string().min(1),
  claimText: z.string().min(1),
  claimKind: z.enum(['fact', 'inference', 'recommendation', 'uncertainty']),
  claimCategory: z.string().min(1),
  tenantId: z.string().min(1),
  clientId: z.string().min(1).nullable(),
  scopeQualifiers: z.array(z.string()),
  asOf: z.string().nullable(),
  sources: z.array(evidenceSourceSchema),
  truncation: z
    .object({
      truncated: z.boolean(),
      originalSourceCount: z.number().int().nonnegative(),
      includedSourceCount: z.number().int().nonnegative(),
      reason: z.string().min(1),
    })
    .optional(),
});

export interface EvidenceEnvelope {
  envelopeVersion: 'meri-evidence-envelope-v1';
  claimId: string;
  claimText: string;
  claimKind: AssuredClaim['type'];
  claimCategory: string;
  tenantId: string;
  clientId: string | null;
  scopeQualifiers: string[];
  asOf: string | null;
  sources: Array<{
    evidenceId: string;
    sourceType: string;
    sourceId: string;
    documentId: string | null;
    version: string | null;
    locator: string | null;
    passage: string;
    sourceDate: string | null;
    retrievedAt: string | null;
  }>;
  truncation?: {
    truncated: boolean;
    originalSourceCount: number;
    includedSourceCount: number;
    reason: string;
  };
}

export function hashEvidenceEnvelope(envelope: EvidenceEnvelope): string {
  return hashEvidenceContent(evidenceEnvelopeSchema.parse(envelope));
}

export interface EvidenceQuestion {
  state: unknown;
  questions: Record<string, JevQuestion>;
}

export interface JevQuestion {
  type: 'choice';
  instructions: string | object | unknown[];
  criteria: Record<string, string | object | unknown[] | null>;
}

export interface DecisionProviderOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface DecisionProvider {
  readonly name: string;
  available(): boolean;
  assess(
    envelope: EvidenceEnvelope,
    question: EvidenceQuestion,
    opts?: DecisionProviderOptions,
  ): Promise<EvidenceDecision>;
}

export interface JevProviderScope {
  tenantId: string;
  surface: AssuranceSurface;
}
