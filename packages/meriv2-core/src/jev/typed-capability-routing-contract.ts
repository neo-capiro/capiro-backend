import { z } from 'zod';
import { CAPABILITY_ROUTING_FIXED_CHOICES } from './capability-routing-contract';
import { JEV_TASK_REGISTRY_VERSION } from './task-registry';

/** Dormant wire contract. Identity validation does not establish turn eligibility. */
export const TYPED_CAPABILITY_ROUTING_QUESTION_VERSION = 'capability_routing.typed.v1';

const idSchema = z.string().min(1).max(200).refine((value) => value === value.trim());
const candidateSchema = z.object({
  kind: z.enum(['tool', 'skill']),
  id: idSchema,
}).strict();

export type TypedCapabilityRoutingCandidate = z.infer<typeof candidateSchema>;

export interface VersionedTypedCapabilityRoutingCandidateSet {
  version: string;
  candidates: readonly TypedCapabilityRoutingCandidate[];
}

const candidateSetSchema = z.object({
  version: z.string().min(1).max(128).refine((value) => value === value.trim()),
  candidates: z.array(candidateSchema).max(256),
}).strict();

const resultSchema = z.object({
  task: z.literal('capability_routing'),
  registryVersion: z.literal(JEV_TASK_REGISTRY_VERSION),
  questionVersion: z.literal(TYPED_CAPABILITY_ROUTING_QUESTION_VERSION),
  candidateSetVersion: z.string().min(1),
  outcome: z.union([candidateSchema, z.enum(CAPABILITY_ROUTING_FIXED_CHOICES)]),
  probabilities: z.record(z.number()),
  confidence: z.number(),
}).strict();

export type TypedCapabilityRoutingResult = z.infer<typeof resultSchema>;

type TypedValidationReason =
  | 'malformed_canonical_descriptors' | 'malformed_candidate_set'
  | 'duplicate_candidate' | 'unknown_candidate' | 'malformed_result'
  | 'candidate_set_version_mismatch' | 'outcome_not_allowed' | 'invalid_probabilities';

type Validation<T> = { ok: true; value: T } | { ok: false; reason: TypedValidationReason };

/** Distinct namespaces also permit a tool and skill to have the same bare ID. */
export function typedCapabilityRoutingChoiceKey(candidate: TypedCapabilityRoutingCandidate): string {
  return `${candidate.kind}:${candidate.id}`;
}

/**
 * Checks canonical identity and set shape only. The caller must separately prove
 * authenticated, turn-bound eligibility; registry/UI presence is not that proof.
 */
export function validateTypedCapabilityRoutingCandidateSet(
  input: unknown,
  canonical: { toolIds: readonly string[]; skillIds: readonly string[] },
): Validation<VersionedTypedCapabilityRoutingCandidateSet> {
  if (!canonical || !Array.isArray(canonical.toolIds) || !Array.isArray(canonical.skillIds)) {
    return { ok: false, reason: 'malformed_canonical_descriptors' };
  }
  const toolIds = new Set(canonical.toolIds);
  const skillIds = new Set(canonical.skillIds);
  if (toolIds.size !== canonical.toolIds.length || skillIds.size !== canonical.skillIds.length
    || canonical.toolIds.some((id) => !idSchema.safeParse(id).success)
    || canonical.skillIds.some((id) => !idSchema.safeParse(id).success)) {
    return { ok: false, reason: 'malformed_canonical_descriptors' };
  }
  const parsed = candidateSetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'malformed_candidate_set' };
  const keys = parsed.data.candidates.map(typedCapabilityRoutingChoiceKey);
  if (new Set(keys).size !== keys.length) return { ok: false, reason: 'duplicate_candidate' };
  if (parsed.data.candidates.some((candidate) =>
    !(candidate.kind === 'tool' ? toolIds : skillIds).has(candidate.id))) {
    return { ok: false, reason: 'unknown_candidate' };
  }
  return { ok: true, value: parsed.data };
}

/** Pure response check; a successful result is an advisory selection, never authorization. */
export function validateTypedCapabilityRoutingResult(
  input: unknown,
  options: {
    candidateSet: unknown;
    canonical: { toolIds: readonly string[]; skillIds: readonly string[] };
  },
): Validation<TypedCapabilityRoutingResult> {
  const candidates = validateTypedCapabilityRoutingCandidateSet(options.candidateSet, options.canonical);
  if (!candidates.ok) return candidates;
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'malformed_result' };
  if (parsed.data.candidateSetVersion !== candidates.value.version) {
    return { ok: false, reason: 'candidate_set_version_mismatch' };
  }
  const candidateKeys = candidates.value.candidates.map(typedCapabilityRoutingChoiceKey);
  const allowed = new Set<string>([...candidateKeys, ...CAPABILITY_ROUTING_FIXED_CHOICES]);
  const outcomeKey = typeof parsed.data.outcome === 'string'
    ? parsed.data.outcome : typedCapabilityRoutingChoiceKey(parsed.data.outcome);
  if (!allowed.has(outcomeKey)) return { ok: false, reason: 'outcome_not_allowed' };
  const entries = Object.entries(parsed.data.probabilities);
  if (entries.length !== allowed.size || entries.some(([key, probability]) =>
    !allowed.has(key) || !Number.isFinite(probability) || probability < 0 || probability > 1)
    || !Number.isFinite(parsed.data.confidence) || parsed.data.confidence < 0
    || parsed.data.confidence > 1) {
    return { ok: false, reason: 'invalid_probabilities' };
  }
  const total = entries.reduce((sum, [, probability]) => sum + probability, 0);
  if (Math.abs(total - 1) > 0.02) return { ok: false, reason: 'invalid_probabilities' };
  return { ok: true, value: parsed.data };
}
