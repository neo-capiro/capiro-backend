import { MERI_CAPABILITY_REGISTRY } from '@capiro/shared';
import {
  CAPABILITY_ROUTING_FIXED_CHOICES,
  CAPABILITY_ROUTING_QUESTION_VERSION,
  JEV_TASK_REGISTRY,
  JEV_TASK_REGISTRY_VERSION,
  createJevClient,
  resolveJevConfig,
  resolveJevProviderMode,
  resolveJevTaskRollout,
  validateCapabilityRoutingCandidateSet,
  validateCapabilityRoutingResult,
  type CapabilityRolloutEnvironment,
  type JevChoiceAnswer,
  type JevClient,
  type JevSystemOneRequest,
} from '@capiro/meriv2-core';
import type {
  MeriCapabilityRoutingDecision,
  MeriCapabilityRoutingProvider,
  MeriCapabilityRoutingRequest,
} from './meri-context-plane.service.js';

export const MERI_CAPABILITY_ROUTING_CANDIDATE_SET_VERSION = 'meri-capability-registry.v1';

export type CapabilityRoutingFallbackReason =
  | 'off'
  | 'missing_credential'
  | 'invalid_config'
  | 'inactive_task'
  | 'no_eligible_candidates'
  | 'invalid_candidate_set'
  | 'unknown_candidate'
  | 'version_mismatch'
  | 'malformed_result'
  | 'timeout'
  | 'cancelled'
  | 'provider_unavailable';

export interface CapabilityRoutingAssessmentRequest {
  request: MeriCapabilityRoutingRequest;
  candidateSet: { version: string; candidateIds: readonly string[] };
  candidates: readonly { id: string; description: string; effect: 'read_only' | 'write' }[];
}

/** Injection point deliberately accepts an untrusted normalized value for validation. */
export interface CapabilityRoutingAssessmentProvider {
  assess(
    input: CapabilityRoutingAssessmentRequest,
    options: { signal?: AbortSignal; deadlineAt: number },
  ): Promise<unknown>;
}

const CANONICAL_DESCRIPTORS = MERI_CAPABILITY_REGISTRY.map((descriptor) => ({
  id: descriptor.name,
  description: descriptor.description,
  effect: descriptor.readOnly ? 'read_only' as const : 'write' as const,
}));
const CANONICAL_IDS = CANONICAL_DESCRIPTORS.map(({ id }) => id);
type CanonicalCapabilityDescriptor = (typeof CANONICAL_DESCRIPTORS)[number];
class RoutingTimeout extends Error {}
class RoutingCancelled extends Error {}

function bounded<T>(
  start: () => Promise<T>,
  input: { signal?: AbortSignal; deadlineAt: number },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new RoutingCancelled()));
    const remainingMs = input.deadlineAt - Date.now();
    if (input.signal?.aborted) return finish(() => reject(new RoutingCancelled()));
    if (remainingMs <= 0) return finish(() => reject(new RoutingTimeout()));
    timer = setTimeout(() => finish(() => reject(new RoutingTimeout())), remainingMs);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    queueMicrotask(() => {
      // Abort can arrive after the initial check but before the provider starts.
      // A settled request must not dispatch billable work in that window.
      if (settled) return;
      let pending: Promise<T>;
      try {
        pending = Promise.resolve(start());
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      pending.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  });
}

function fallback(reason: CapabilityRoutingFallbackReason): MeriCapabilityRoutingDecision {
  return { kind: 'fallback', reason };
}

function validationFailure(reason: string): CapabilityRoutingFallbackReason {
  if (reason.includes('version_mismatch')) return 'version_mismatch';
  if (reason === 'unknown_candidate_id' || reason === 'reserved_candidate_id' || reason === 'outcome_not_allowed') {
    return 'unknown_candidate';
  }
  if (reason === 'malformed_result' || reason === 'invalid_probabilities') return 'malformed_result';
  return 'invalid_candidate_set';
}

/**
 * API-side JEV boundary adapter. It returns a validated advisory proposal only;
 * this module has no tool executor and cannot turn a write descriptor into an action.
 */
export class JevCapabilityRoutingAdapter implements MeriCapabilityRoutingProvider {
  constructor(
    private readonly provider: CapabilityRoutingAssessmentProvider | null,
    private readonly settings: {
      disabledReason?: CapabilityRoutingFallbackReason;
      timeoutMs?: number;
    } = {},
  ) {}

  async propose(
    request: MeriCapabilityRoutingRequest,
    options: { signal?: AbortSignal; deadlineAt?: number } = {},
  ): Promise<MeriCapabilityRoutingDecision> {
    if (this.settings.disabledReason) return fallback(this.settings.disabledReason);
    if (!this.provider) return fallback('provider_unavailable');
    const candidateSet = {
      version: MERI_CAPABILITY_ROUTING_CANDIDATE_SET_VERSION,
      candidateIds: [...request.eligibleCapabilityIds],
    };
    const checkedCandidates = validateCapabilityRoutingCandidateSet(candidateSet, CANONICAL_IDS);
    if (!checkedCandidates.ok) return fallback(validationFailure(checkedCandidates.reason));
    if (!checkedCandidates.value.candidateIds.length) return fallback('no_eligible_candidates');

    const candidateById = new Map<string, CanonicalCapabilityDescriptor>(
      CANONICAL_DESCRIPTORS.map((candidate) => [candidate.id, candidate]),
    );
    const candidates = checkedCandidates.value.candidateIds.map((id) => candidateById.get(id)!);
    const deadlineAt = Math.min(options.deadlineAt ?? Number.POSITIVE_INFINITY,
      Date.now() + (this.settings.timeoutMs ?? JEV_TASK_REGISTRY.capability_routing.timeoutMs));
    let raw: unknown;
    try {
      raw = await bounded(
        () => this.provider!.assess({ request, candidateSet: checkedCandidates.value, candidates }, {
          signal: options.signal,
          deadlineAt,
        }),
        { signal: options.signal, deadlineAt },
      );
    } catch (error) {
      if (error instanceof RoutingTimeout) return fallback('timeout');
      if (error instanceof RoutingCancelled || options.signal?.aborted) return fallback('cancelled');
      return fallback('provider_unavailable');
    }

    const validated = validateCapabilityRoutingResult(raw, {
      candidateSet: checkedCandidates.value,
      canonicalDescriptorIds: CANONICAL_IDS,
    });
    if (!validated.ok) return fallback(validationFailure(validated.reason));
    const candidate = candidateById.get(validated.value.outcome) ?? null;
    return {
      kind: 'proposal',
      outcome: validated.value.outcome,
      confidence: validated.value.confidence,
      probabilities: validated.value.probabilities,
      candidate,
    };
  }
}

function makeJevAssessmentProvider(client: JevClient): CapabilityRoutingAssessmentProvider {
  const registration = JEV_TASK_REGISTRY.capability_routing;
  const questionId = registration.questionId!;
  return {
    async assess(input, options) {
      const criteria: Record<string, string> = Object.fromEntries([
        ...input.candidates.map((candidate) => [candidate.id,
          `${candidate.description} [${candidate.effect}; advisory proposal only; never execute from this result]`]),
        [CAPABILITY_ROUTING_FIXED_CHOICES[0], 'The request requires more than one capability.'],
        [CAPABILITY_ROUTING_FIXED_CHOICES[1], 'Required context is missing; ask for clarification.'],
        [CAPABILITY_ROUTING_FIXED_CHOICES[2], 'No eligible capability matches the request.'],
      ]);
      const question: JevSystemOneRequest = {
        state: {
          task: 'capability_routing',
          registryVersion: JEV_TASK_REGISTRY_VERSION,
          questionVersion: CAPABILITY_ROUTING_QUESTION_VERSION,
          candidateSet: input.candidateSet,
          candidates: input.candidates,
        },
        questions: {
          [questionId]: {
            type: 'choice',
            instructions: {
              objective: 'Select only from the supplied server-eligible candidates or the fixed abstention choices.',
              userRequest: input.request.taskText,
              deterministicPlan: {
                subjectScope: input.request.deterministicPlan.subjectScope,
                queryClass: input.request.deterministicPlan.queryClass,
                requestedDomains: input.request.deterministicPlan.requestedDomains,
              },
            },
            criteria,
          },
        },
      };
      const response = await client.systemOne(question, {
        signal: options.signal,
        deadlineAt: options.deadlineAt,
        maxAttempts: registration.costBudget.maxCalls,
      });
      const answer = response.response.answers[questionId] as JevChoiceAnswer | undefined;
      if (!answer || answer.type !== 'choice') return null;
      return {
        task: 'capability_routing',
        registryVersion: JEV_TASK_REGISTRY_VERSION,
        questionVersion: CAPABILITY_ROUTING_QUESTION_VERSION,
        candidateSetVersion: input.candidateSet.version,
        outcome: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
    },
  };
}

/**
 * Production factory stays dark for every current environment because the task
 * registry lifecycle is inactive and max rollout is off. A client is created
 * only after all task/provider gates become eligible in a future reviewed change.
 */
export function createApiJevCapabilityRoutingAdapter(
  env: CapabilityRolloutEnvironment,
  deps: { fetchImpl?: typeof globalThis.fetch; now?: () => number } = {},
): JevCapabilityRoutingAdapter {
  const config = resolveJevConfig(env);
  if (!config.apiKeyPresent) return new JevCapabilityRoutingAdapter(null, { disabledReason: 'missing_credential' });
  if (!config.available) return new JevCapabilityRoutingAdapter(null, { disabledReason: 'invalid_config' });
  const registration = JEV_TASK_REGISTRY.capability_routing;
  if (registration.lifecycle === 'inactive' || registration.maxRolloutMode === 'off') {
    return new JevCapabilityRoutingAdapter(null, { disabledReason: 'inactive_task' });
  }
  if (!config.tasks.includes('capability_routing')) {
    return new JevCapabilityRoutingAdapter(null, { disabledReason: 'off' });
  }
  const providerMode = resolveJevProviderMode(env, undefined, 'chat');
  if (resolveJevTaskRollout('capability_routing', config, providerMode) === 'off') {
    return new JevCapabilityRoutingAdapter(null, { disabledReason: 'off' });
  }
  const client = createJevClient({
    apiKey: env.TYPESAFE_API_KEY!,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: Math.min(config.timeoutMs, registration.timeoutMs),
    maxAttempts: Math.min(config.maxAttempts, registration.costBudget.maxCalls),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  return new JevCapabilityRoutingAdapter(makeJevAssessmentProvider(client), {
    timeoutMs: registration.timeoutMs,
  });
}
