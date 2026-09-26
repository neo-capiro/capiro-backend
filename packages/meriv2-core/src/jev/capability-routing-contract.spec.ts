import { describe, expect, it } from '@jest/globals';
import { MERI_CAPABILITY_REGISTRY } from '@capiro/shared';
import {
  CAPABILITY_ROUTING_FIXED_CHOICES,
  CAPABILITY_ROUTING_QUESTION_VERSION,
  validateCapabilityRoutingCandidateSet,
  validateCapabilityRoutingResult,
} from './capability-routing-contract';
import { JEV_TASK_REGISTRY_VERSION } from './task-registry';

const canonicalIds = MERI_CAPABILITY_REGISTRY.map(({ name }) => name);
const candidateSet = { version: 'meri-capability-registry.v1', candidateIds: ['search_congress_bills', 'send_email'] };
const result = {
  task: 'capability_routing', registryVersion: JEV_TASK_REGISTRY_VERSION,
  questionVersion: CAPABILITY_ROUTING_QUESTION_VERSION, candidateSetVersion: candidateSet.version,
  outcome: 'search_congress_bills',
  probabilities: { search_congress_bills: 0.7, send_email: 0.1, multi_intent: 0.1, needs_context: 0.05, no_match: 0.05 },
  confidence: 0.7,
};

describe('dormant capability-routing contract', () => {
  it('accepts eligible canonical IDs, including a write descriptor, without producing an action', () => {
    expect(MERI_CAPABILITY_REGISTRY.find(({ name }) => name === 'send_email')?.readOnly).toBe(false);
    expect(validateCapabilityRoutingCandidateSet(candidateSet, canonicalIds)).toEqual({ ok: true, value: candidateSet });
    expect(validateCapabilityRoutingResult(result, { candidateSet, canonicalDescriptorIds: canonicalIds })).toEqual({ ok: true, value: result });
    expect(CAPABILITY_ROUTING_FIXED_CHOICES).toEqual(['multi_intent', 'needs_context', 'no_match']);
    expect(result).not.toHaveProperty('action');
  });

  it.each([
    [{ version: 'v1', candidateIds: ['not_a_canonical_tool'] }, 'unknown_candidate_id'],
    [{ version: 'v1', candidateIds: ['search_congress_bills', 'search_congress_bills'] }, 'duplicate_candidate_id'],
    [{ version: 'v1', candidateIds: ['needs_context'] }, 'reserved_candidate_id'],
    [{ version: ' ', candidateIds: [] }, 'malformed_candidate_set'],
  ])('rejects malformed/noncanonical candidate sets', (input, reason) => {
    expect(validateCapabilityRoutingCandidateSet(input, canonicalIds)).toEqual({ ok: false, reason });
  });

  it.each([
    [' leading-space'],
    ['needs_context'],
    ['search_congress_bills', 'search_congress_bills'],
  ])('rejects malformed canonical descriptor lists before considering a candidate set', (...ids) => {
    expect(validateCapabilityRoutingCandidateSet(candidateSet, ids))
      .toEqual({ ok: false, reason: 'malformed_canonical_descriptors' });
  });

  it.each([
    [{ ...result, task: 'claim_support' }, 'malformed_result'],
    [{ ...result, registryVersion: 'jev-task-registry.v5' }, 'registry_version_mismatch'],
    [{ ...result, questionVersion: 'capability_routing.v0' }, 'question_version_mismatch'],
    [{ ...result, candidateSetVersion: 'other.v1' }, 'candidate_set_version_mismatch'],
    [{ ...result, outcome: 'delete_records' }, 'outcome_not_allowed'],
    [{ ...result, probabilities: { ...result.probabilities, extra: 0 } }, 'invalid_probabilities'],
    [{ ...result, confidence: Number.NaN }, 'malformed_result'],
    [{ ...result, extra: true }, 'malformed_result'],
  ])('fails closed for mismatches and malformed results', (input, reason) => {
    expect(validateCapabilityRoutingResult(input, { candidateSet, canonicalDescriptorIds: canonicalIds })).toEqual({ ok: false, reason });
  });

  it('allows abstention choices with no eligible candidates', () => {
    const empty = { version: 'meri-capability-registry.v1', candidateIds: [] };
    const abstention = { ...result, candidateSetVersion: empty.version, outcome: 'needs_context',
      probabilities: { multi_intent: 0, needs_context: 1, no_match: 0 }, confidence: 1 };
    expect(validateCapabilityRoutingResult(abstention, { candidateSet: empty, canonicalDescriptorIds: canonicalIds }))
      .toMatchObject({ ok: true, value: { outcome: 'needs_context' } });
  });
});
