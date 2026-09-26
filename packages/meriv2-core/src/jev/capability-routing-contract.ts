import { z } from 'zod';
import { JEV_TASK_REGISTRY, JEV_TASK_REGISTRY_VERSION } from './task-registry';

export const CAPABILITY_ROUTING_QUESTION_VERSION = JEV_TASK_REGISTRY.capability_routing.questionVersion;
export const CAPABILITY_ROUTING_FIXED_CHOICES = ['multi_intent', 'needs_context', 'no_match'] as const;

export interface VersionedCapabilityRoutingCandidateSet {
  version: string;
  candidateIds: readonly string[];
}

export interface CapabilityRoutingResult {
  task: 'capability_routing';
  registryVersion: string;
  questionVersion: string;
  candidateSetVersion: string;
  outcome: string;
  probabilities: Readonly<Record<string, number>>;
  confidence: number;
}

export type CapabilityRoutingValidation =
  | { ok: true; value: CapabilityRoutingResult }
  | { ok: false; reason: 'malformed_canonical_descriptors' | 'malformed_candidate_set'
    | 'duplicate_candidate_id' | 'unknown_candidate_id' | 'reserved_candidate_id'
    | 'question_version_mismatch' | 'registry_version_mismatch' | 'candidate_set_version_mismatch'
    | 'malformed_result' | 'outcome_not_allowed' | 'invalid_probabilities' };

type CandidateSetValidation =
  | { ok: true; value: VersionedCapabilityRoutingCandidateSet }
  | { ok: false; reason: 'malformed_canonical_descriptors' | 'malformed_candidate_set'
    | 'duplicate_candidate_id' | 'unknown_candidate_id' | 'reserved_candidate_id' };

const candidateSetSchema = z.object({
  version: z.string().min(1).max(128).refine((value) => value === value.trim()),
  candidateIds: z.array(z.string().min(1).max(200).refine((value) => value === value.trim())).max(256),
}).strict();

const resultSchema = z.object({
  task: z.literal('capability_routing'),
  registryVersion: z.string().min(1),
  questionVersion: z.string().min(1),
  candidateSetVersion: z.string().min(1),
  outcome: z.string().min(1),
  probabilities: z.record(z.number()),
  confidence: z.number(),
}).strict();

/** Validate the server-derived eligible subset against caller-supplied canonical IDs. */
export function validateCapabilityRoutingCandidateSet(
  input: unknown,
  canonicalDescriptorIds: readonly string[],
): CandidateSetValidation {
  if (!Array.isArray(canonicalDescriptorIds) || canonicalDescriptorIds.some((id) =>
    typeof id !== 'string' || !id || id.length > 200 || id !== id.trim()
      || (CAPABILITY_ROUTING_FIXED_CHOICES as readonly string[]).includes(id))) {
    return { ok: false, reason: 'malformed_canonical_descriptors' };
  }
  const canonical = new Set(canonicalDescriptorIds);
  if (canonical.size !== canonicalDescriptorIds.length) {
    return { ok: false, reason: 'malformed_canonical_descriptors' };
  }
  const parsed = candidateSetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'malformed_candidate_set' };
  const ids = parsed.data.candidateIds;
  if (new Set(ids).size !== ids.length) return { ok: false, reason: 'duplicate_candidate_id' };
  if (ids.some((id) => (CAPABILITY_ROUTING_FIXED_CHOICES as readonly string[]).includes(id))) {
    return { ok: false, reason: 'reserved_candidate_id' };
  }
  if (ids.some((id) => !canonical.has(id))) return { ok: false, reason: 'unknown_candidate_id' };
  return { ok: true, value: { version: parsed.data.version, candidateIds: ids } };
}

/** Validate a normalized result only; this performs no routing or threshold decision. */
export function validateCapabilityRoutingResult(
  input: unknown,
  options: { candidateSet: unknown; canonicalDescriptorIds: readonly string[] },
): CapabilityRoutingValidation {
  const candidates = validateCapabilityRoutingCandidateSet(options.candidateSet, options.canonicalDescriptorIds);
  if (!candidates.ok) return candidates;
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'malformed_result' };
  if (parsed.data.registryVersion !== JEV_TASK_REGISTRY_VERSION) return { ok: false, reason: 'registry_version_mismatch' };
  if (parsed.data.questionVersion !== CAPABILITY_ROUTING_QUESTION_VERSION) return { ok: false, reason: 'question_version_mismatch' };
  if (parsed.data.candidateSetVersion !== candidates.value.version) return { ok: false, reason: 'candidate_set_version_mismatch' };

  const allowed = new Set([...candidates.value.candidateIds, ...CAPABILITY_ROUTING_FIXED_CHOICES]);
  if (!allowed.has(parsed.data.outcome)) return { ok: false, reason: 'outcome_not_allowed' };
  const entries = Object.entries(parsed.data.probabilities);
  if (entries.length !== allowed.size || entries.some(([choice, value]) =>
    !allowed.has(choice) || !Number.isFinite(value) || value < 0 || value > 1)
    || !Number.isFinite(parsed.data.confidence) || parsed.data.confidence < 0 || parsed.data.confidence > 1) {
    return { ok: false, reason: 'invalid_probabilities' };
  }
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (Math.abs(total - 1) > 0.02) return { ok: false, reason: 'invalid_probabilities' };
  return { ok: true, value: parsed.data };
}
