import { MATCH_LABELS, type MatchLabel } from '../grounding/match-label';
import {
  CLIENT_FIT_ALIGNMENT_LEVELS,
  CLIENT_FIT_ALIGNMENT_QUESTION_ID,
  CLIENT_FIT_QUESTION_ID,
  CLIENT_FIT_QUESTION_VERSION,
  type ClientFitAlignmentLevel,
} from './client-fit-question';
import type {
  DecisionProviderMetadata,
  DecisionProviderOptions,
  EvidenceEnvelope,
  EvidenceOperationalState,
  EvidenceQuestion,
  JevProviderScope,
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

export type ClientFitDecision =
  | {
      kind: 'outcome';
      category: {
        value: MatchLabel;
        probabilities: Record<MatchLabel, number>;
        confidence: number;
      };
      alignment: {
        level: ClientFitAlignmentLevel;
        probabilities: Record<ClientFitAlignmentLevel, number>;
        confidence: number;
      };
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

export interface ClientFitProvider {
  readonly name: string;
  available(): boolean;
  assess(
    envelope: EvidenceEnvelope,
    question: EvidenceQuestion,
    opts?: DecisionProviderOptions,
  ): Promise<ClientFitDecision>;
}

export interface ClientFitProviderOptions {
  client: JevClient;
  model: string;
  scope: JevProviderScope;
}

function metadata(model: string): DecisionProviderMetadata {
  return { name: 'jev-client-fit', model, questionVersion: CLIENT_FIT_QUESTION_VERSION };
}

function failure(
  model: string,
  state: EvidenceOperationalState,
  reasonCodes: string[],
  latencyMs: number,
): ClientFitDecision {
  return { kind: 'failure', state, reasonCodes, provider: metadata(model), latencyMs };
}

export function createClientFitProvider(options: ClientFitProviderOptions): ClientFitProvider {
  return {
    name: 'jev-client-fit',
    available: () => true,
    async assess(envelope, question, callOptions = {}) {
      if (envelope.tenantId !== options.scope.tenantId) {
        const error = new JevScopeError();
        return failure(options.model, 'scope_refused', [error.code], 0);
      }
      const startedAt = Date.now();
      try {
        const result = await options.client.systemOne(question, callOptions);
        const category = result.response.answers[CLIENT_FIT_QUESTION_ID];
        const alignment = result.response.answers[CLIENT_FIT_ALIGNMENT_QUESTION_ID];
        if (!category || category.type !== 'choice' || !MATCH_LABELS.includes(category.choice as MatchLabel)) {
          throw new JevMalformedResponseError();
        }
        if (!alignment || alignment.type !== 'score'
          || !CLIENT_FIT_ALIGNMENT_LEVELS.includes(alignment.level as ClientFitAlignmentLevel)) {
          throw new JevMalformedResponseError();
        }
        return {
          kind: 'outcome',
          category: {
            value: category.choice as MatchLabel,
            probabilities: Object.fromEntries(
              MATCH_LABELS.map((key) => [key, category.probabilities[key]]),
            ) as Record<MatchLabel, number>,
            confidence: category.confidence,
          },
          alignment: {
            level: alignment.level as ClientFitAlignmentLevel,
            probabilities: Object.fromEntries(
              CLIENT_FIT_ALIGNMENT_LEVELS.map((key) => [key, alignment.probabilities[key]]),
            ) as Record<ClientFitAlignmentLevel, number>,
            confidence: alignment.confidence,
          },
          provider: metadata(result.response.model),
          latencyMs: result.latencyMs,
          usage: {
            inputTokens: result.response.usage.input_tokens,
            outputTokens: result.response.usage.output_tokens,
          },
        };
      } catch (error) {
        const latencyMs = Math.max(0, Date.now() - startedAt);
        if (error instanceof JevAuthError) return failure(options.model, 'judge_unavailable', ['auth_failed'], latencyMs);
        if (error instanceof JevRequestError) return failure(options.model, 'judge_unavailable', ['request_rejected'], latencyMs);
        if (error instanceof JevTimeoutError) return failure(options.model, 'timeout', ['timeout'], latencyMs);
        if (error instanceof JevCancelledError) return failure(options.model, 'cancelled', ['cancelled'], latencyMs);
        if (error instanceof JevMalformedResponseError) {
          return failure(options.model, 'malformed_response', ['malformed_response'], latencyMs);
        }
        return failure(options.model, 'judge_unavailable', ['provider_unavailable'], latencyMs);
      }
    },
  };
}