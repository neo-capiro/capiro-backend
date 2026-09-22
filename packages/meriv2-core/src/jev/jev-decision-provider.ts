import { CLAIM_SUPPORT_QUESTION_ID, CLAIM_SUPPORT_QUESTION_VERSION } from './claim-support-question';
import {
  EVIDENCE_OUTCOMES,
  type DecisionProvider,
  type EvidenceDecision,
  type EvidenceOperationalState,
  type EvidenceOutcome,
  type JevProviderScope,
} from './decision-contract';
import {
  JevAuthError,
  JevCancelledError,
  type JevClient,
  JevMalformedResponseError,
  JevRequestError,
  JevScopeError,
  JevTimeoutError,
} from './jev-client';

export interface JevDecisionProviderOptions {
  client: JevClient;
  model: string;
  scope: JevProviderScope;
}

function failure(
  model: string,
  state: EvidenceOperationalState,
  reasonCodes: string[],
  latencyMs: number,
): EvidenceDecision {
  return {
    kind: 'failure',
    state,
    reasonCodes,
    provider: { name: 'jev', model, questionVersion: CLAIM_SUPPORT_QUESTION_VERSION },
    latencyMs,
  };
}

export function createJevDecisionProvider(options: JevDecisionProviderOptions): DecisionProvider {
  return {
    name: 'jev',
    available: () => true,
    async assess(envelope, question, callOptions = {}) {
      if (envelope.tenantId !== options.scope.tenantId) {
        const error = new JevScopeError();
        return failure(options.model, 'scope_refused', [error.code], 0);
      }
      const startedAt = Date.now();
      try {
        const result = await options.client.systemOne(question, callOptions);
        const answer = result.response.answers[CLAIM_SUPPORT_QUESTION_ID];
        if (!answer) throw new JevMalformedResponseError();
        const outcome = answer.choice as EvidenceOutcome;
        const probabilities = Object.fromEntries(
          EVIDENCE_OUTCOMES.map((key) => [key, answer.probabilities[key]]),
        ) as Record<EvidenceOutcome, number>;
        const reasonCodes = answer.confidence < 0.5 ? ['low_confidence'] : [];
        return {
          kind: 'outcome',
          outcome,
          probabilities,
          confidence: answer.confidence,
          reasonCodes,
          evidenceIds: envelope.sources.map((source) => source.evidenceId),
          provider: {
            name: 'jev',
            model: result.response.model,
            questionVersion: CLAIM_SUPPORT_QUESTION_VERSION,
          },
          latencyMs: result.latencyMs,
          usage: {
            inputTokens: result.response.usage.input_tokens,
            outputTokens: result.response.usage.output_tokens,
          },
        };
      } catch (error) {
        const latencyMs = Math.max(0, Date.now() - startedAt);
        if (error instanceof JevAuthError) {
          return failure(options.model, 'judge_unavailable', ['auth_failed'], latencyMs);
        }
        if (error instanceof JevRequestError) {
          return failure(options.model, 'judge_unavailable', ['request_rejected'], latencyMs);
        }
        if (error instanceof JevTimeoutError) {
          return failure(options.model, 'timeout', ['timeout'], latencyMs);
        }
        if (error instanceof JevCancelledError) {
          return failure(options.model, 'cancelled', ['cancelled'], latencyMs);
        }
        if (error instanceof JevMalformedResponseError) {
          return failure(options.model, 'malformed_response', ['malformed_response'], latencyMs);
        }
        return failure(options.model, 'judge_unavailable', ['provider_unavailable'], latencyMs);
      }
    },
  };
}
