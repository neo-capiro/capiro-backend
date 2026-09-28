import type {
  DecisionProviderMetadata,
  DecisionProviderOptions,
  EvidenceEnvelope,
  EvidenceOperationalState,
  EvidenceQuestion,
  JevProviderScope,
} from './decision-contract';
import { hashEvidenceEnvelope, hashJevBoundaryValue } from './decision-contract';
import { envelopeSourcesForJev } from './evidence-envelope';
import {
  JevAuthError,
  JevCancelledError,
  type JevClient,
  JevMalformedResponseError,
  JevRequestError,
  JevTimeoutError,
} from './jev-client';
import {
  JEV_TASK_REGISTRY,
  validateJevTaskEvidence,
  type JevTaskRegistration,
} from './task-registry';
import type { JevTask } from './jev-config';

export type JevChoiceTaskDecision =
  | {
      kind: 'outcome';
      task: JevTask;
      outcome: string;
      probabilities: Record<string, number>;
      confidence: number;
      action: 'propose' | 'abstain';
      reasonCodes: string[];
      evidenceIds: string[];
      provider: DecisionProviderMetadata;
      latencyMs: number;
      usage?: { inputTokens: number; outputTokens: number };
      cached?: boolean;
    }
  | {
      kind: 'failure';
      task: JevTask;
      state: EvidenceOperationalState;
      reasonCodes: string[];
      provider: DecisionProviderMetadata;
      latencyMs: number;
    };

export interface JevChoiceTaskProvider {
  readonly name: string;
  available(): boolean;
  assess(
    envelope: EvidenceEnvelope,
    question: EvidenceQuestion,
    opts?: DecisionProviderOptions,
  ): Promise<JevChoiceTaskDecision>;
}

const PACKAGE_2_CHOICE_TASKS = new Set<JevTask>([
  'program_identity',
  'mention_scope',
  'evidence_selection',
]);
const BD_CHOICE_TASKS = new Set<JevTask>(['bd_entity', 'bd_signal', 'bd_claim']);
const ENVELOPE_BOUND_CHOICE_TASKS = new Set<JevTask>([
  ...PACKAGE_2_CHOICE_TASKS,
  ...BD_CHOICE_TASKS,
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundEvidenceIds(
  task: JevTask,
  envelope: EvidenceEnvelope,
  question: EvidenceQuestion,
): string[] {
  const state = record(question.state);
  if (!state || state.envelopeHash !== hashEvidenceEnvelope(envelope)) {
    throw new JevRequestError('Jev task question is not bound to this evidence envelope');
  }
  const projected = envelopeSourcesForJev(envelope, { includeProvenance: true });
  const expectedById = new Map(
    projected.map((source) => [source.evidenceId, hashJevBoundaryValue(source)]),
  );
  const rawEvidence =
    task === 'evidence_selection'
      ? Array.isArray(state.candidates)
        ? state.candidates.map((candidate) => record(candidate)?.evidence)
        : []
      : Array.isArray(state.evidence)
        ? state.evidence
        : [];
  if (!rawEvidence.length)
    throw new JevRequestError('Jev task question has no envelope-bound evidence');
  const evidenceIds = rawEvidence.map((value) => {
    const source = record(value);
    const evidenceId = source?.evidenceId;
    if (
      typeof evidenceId !== 'string' ||
      expectedById.get(evidenceId) !== hashJevBoundaryValue(source)
    ) {
      throw new JevRequestError('Jev task question evidence does not match the envelope');
    }
    return evidenceId;
  });
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new JevRequestError('Jev task question repeats envelope evidence');
  }
  return evidenceIds;
}

function metadata(
  task: JevTask,
  model: string,
  registration: JevTaskRegistration,
): DecisionProviderMetadata {
  return { name: `jev:${task}`, model, questionVersion: registration.questionVersion };
}

function failure(
  task: JevTask,
  model: string,
  registration: JevTaskRegistration,
  state: EvidenceOperationalState,
  reasonCodes: string[],
  latencyMs: number,
): JevChoiceTaskDecision {
  return {
    kind: 'failure',
    task,
    state,
    reasonCodes,
    provider: metadata(task, model, registration),
    latencyMs,
  };
}

function validateQuestion(
  registration: JevTaskRegistration,
  question: EvidenceQuestion,
): {
  questionId: string;
  criteria: string[];
} {
  const questionId = registration.questionId;
  if (
    !questionId ||
    registration.primitive !== 'choice' ||
    Object.keys(question.questions).length !== 1 ||
    !question.questions[questionId] ||
    question.questions[questionId]?.type !== 'choice'
  )
    throw new JevMalformedResponseError();
  const criteria = Object.keys(question.questions[questionId].criteria);
  if (!criteria.length) throw new JevMalformedResponseError();
  const fixedOutcomes = registration.allowedOutcomes.filter(
    (outcome) => outcome !== 'candidate_id',
  );
  const candidateIds: string[] = [];
  if (registration.allowedOutcomes.includes('candidate_id')) {
    const state = record(question.state);
    if (!state || !Array.isArray(state.candidates)) throw new JevMalformedResponseError();
    for (const candidate of state.candidates) {
      const id = record(candidate)?.id;
      if (typeof id !== 'string' || !id.trim() || fixedOutcomes.includes(id)) {
        throw new JevMalformedResponseError();
      }
      candidateIds.push(id);
    }
    if (!candidateIds.length || new Set(candidateIds).size !== candidateIds.length) {
      throw new JevMalformedResponseError();
    }
  }
  const expectedCriteria = [...fixedOutcomes, ...candidateIds].sort();
  if (JSON.stringify([...criteria].sort()) !== JSON.stringify(expectedCriteria)) {
    throw new JevMalformedResponseError();
  }
  return { questionId, criteria };
}

export function createJevChoiceTaskProvider(options: {
  task: JevTask;
  client: JevClient;
  model: string;
  scope: JevProviderScope;
}): JevChoiceTaskProvider {
  const registration = JEV_TASK_REGISTRY[options.task];
  if (
    !ENVELOPE_BOUND_CHOICE_TASKS.has(options.task) ||
    registration.primitive !== 'choice' ||
    !registration.questionId
  ) {
    throw new Error(`Jev task ${options.task} is not an envelope-bound Choice task`);
  }
  return {
    name: `jev:${options.task}`,
    available: () => true,
    async assess(envelope, question, callOptions = {}) {
      if (envelope.tenantId !== options.scope.tenantId) {
        return failure(
          options.task,
          options.model,
          registration,
          'scope_refused',
          ['scope_refused'],
          0,
        );
      }
      const evidenceIssues = validateJevTaskEvidence(options.task, envelope);
      if (evidenceIssues.length) {
        return failure(
          options.task,
          options.model,
          registration,
          'document_unavailable',
          evidenceIssues,
          0,
        );
      }
      const startedAt = Date.now();
      try {
        const { questionId, criteria } = validateQuestion(registration, question);
        const evidenceIds = boundEvidenceIds(options.task, envelope, question);
        const estimatedInputTokens = Math.ceil(JSON.stringify(question).length / 4);
        if (estimatedInputTokens > registration.costBudget.maxInputTokens) {
          return failure(
            options.task,
            options.model,
            registration,
            'repair_budget_exhausted',
            ['input_token_budget_exceeded'],
            Math.max(0, Date.now() - startedAt),
          );
        }
        const taskDeadlineAt = Date.now() + registration.timeoutMs;
        const deadlineAt = Math.min(callOptions.deadlineAt ?? taskDeadlineAt, taskDeadlineAt);
        const result = await options.client.systemOne(question, {
          ...callOptions,
          deadlineAt,
          maxAttempts: registration.costBudget.maxCalls,
        });
        if (result.attempts > registration.costBudget.maxCalls) {
          return failure(
            options.task,
            options.model,
            registration,
            'repair_budget_exhausted',
            ['provider_call_budget_exceeded'],
            result.latencyMs,
          );
        }
        if (
          result.response.usage.input_tokens > registration.costBudget.maxInputTokens ||
          result.response.usage.output_tokens > registration.costBudget.maxOutputTokens
        ) {
          return failure(
            options.task,
            options.model,
            registration,
            'repair_budget_exhausted',
            ['provider_token_budget_exceeded'],
            result.latencyMs,
          );
        }
        const answer = result.response.answers[questionId];
        if (!answer || answer.type !== 'choice' || !criteria.includes(answer.choice)) {
          throw new JevMalformedResponseError();
        }
        const probabilities = Object.fromEntries(
          criteria.map((outcome) => {
            const probability = answer.probabilities[outcome];
            if (typeof probability !== 'number') throw new JevMalformedResponseError();
            return [outcome, probability];
          }),
        ) as Record<string, number>;
        const abstainBelow = registration.thresholdsByAction.abstain_below ?? 1;
        const abstained =
          registration.abstentionOutcomes.includes(answer.choice) ||
          answer.confidence < abstainBelow;
        return {
          kind: 'outcome',
          task: options.task,
          outcome: answer.choice,
          probabilities,
          confidence: answer.confidence,
          action: abstained ? 'abstain' : 'propose',
          reasonCodes: abstained
            ? [
                registration.abstentionOutcomes.includes(answer.choice)
                  ? 'abstention_outcome'
                  : 'below_action_threshold',
              ]
            : [],
          evidenceIds,
          provider: metadata(options.task, result.response.model, registration),
          latencyMs: result.latencyMs,
          usage: {
            inputTokens: result.response.usage.input_tokens,
            outputTokens: result.response.usage.output_tokens,
          },
        };
      } catch (error) {
        const latencyMs = Math.max(0, Date.now() - startedAt);
        if (error instanceof JevAuthError)
          return failure(
            options.task,
            options.model,
            registration,
            'judge_unavailable',
            ['auth_failed'],
            latencyMs,
          );
        if (error instanceof JevRequestError)
          return failure(
            options.task,
            options.model,
            registration,
            'judge_unavailable',
            ['request_rejected'],
            latencyMs,
          );
        if (error instanceof JevTimeoutError)
          return failure(
            options.task,
            options.model,
            registration,
            'timeout',
            ['timeout'],
            latencyMs,
          );
        if (error instanceof JevCancelledError)
          return failure(
            options.task,
            options.model,
            registration,
            'cancelled',
            ['cancelled'],
            latencyMs,
          );
        if (error instanceof JevMalformedResponseError) {
          return failure(
            options.task,
            options.model,
            registration,
            'malformed_response',
            ['malformed_response'],
            latencyMs,
          );
        }
        return failure(
          options.task,
          options.model,
          registration,
          'judge_unavailable',
          ['provider_unavailable'],
          latencyMs,
        );
      }
    },
  };
}
