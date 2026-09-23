import { JevRequestError } from './jev-client';
import type { EvidenceEnvelope, EvidenceQuestion } from './decision-contract';
import { envelopeSourcesForJev } from './evidence-envelope';
import { JEV_TASK_REGISTRY } from './task-registry';

export const CLAIM_SUPPORT_QUESTION_VERSION = JEV_TASK_REGISTRY.claim_support.questionVersion;
export const CLAIM_SUPPORT_QUESTION_ID = JEV_TASK_REGISTRY.claim_support.questionId!;
const MAX_STATE_ESTIMATED_TOKENS = 32_000;

export function buildClaimSupportQuestion(envelope: EvidenceEnvelope): EvidenceQuestion {
  const state = {
    claim: {
      id: envelope.claimId,
      text: envelope.claimText,
      kind: envelope.claimKind,
      category: envelope.claimCategory,
      asOf: envelope.asOf,
    },
    scope: {
      qualifiers: envelope.scopeQualifiers,
      tenantId: envelope.tenantId,
      clientId: envelope.clientId,
    },
    sources: envelopeSourcesForJev(envelope, { includeProvenance: false }),
  };
  if (JSON.stringify(state).length / 4 > MAX_STATE_ESTIMATED_TOKENS) {
    throw new JevRequestError('Jev request state exceeds the 32k-token pre-flight limit');
  }
  return {
    state,
    questions: {
      [CLAIM_SUPPORT_QUESTION_ID]: {
        type: 'choice',
        instructions:
          'How does the cited evidence relate to the claim, considering the stated scope qualifiers and dates? Judge only from the evidence passages provided.',
        criteria: {
          supported:
            'The evidence states the claim or directly implies it is true within the stated scope',
          contradicted: 'The evidence states the opposite or implies the claim is false',
          insufficient_evidence: 'The evidence does not establish the claim either way',
          conflicting_evidence:
            'Different evidence passages disagree about the claim and the conflict is not resolved by dates, scope or authority',
        },
      },
    },
  };
}
