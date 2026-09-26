import { describe, expect, it } from '@jest/globals';
import { JEV_TASK_REGISTRY_VERSION } from './task-registry';
import {
  TYPED_CAPABILITY_ROUTING_QUESTION_VERSION,
  typedCapabilityRoutingChoiceKey,
  validateTypedCapabilityRoutingCandidateSet,
  validateTypedCapabilityRoutingResult,
} from './typed-capability-routing-contract';

const canonical = { toolIds: ['shared', 'search_congress_bills'], skillIds: ['shared', 'meeting_prep'] };
const candidateSet = {
  version: 'server-turn-bound-set.v1',
  candidates: [{ kind: 'tool', id: 'shared' }, { kind: 'skill', id: 'shared' }],
};
const result = {
  task: 'capability_routing',
  registryVersion: JEV_TASK_REGISTRY_VERSION,
  questionVersion: TYPED_CAPABILITY_ROUTING_QUESTION_VERSION,
  candidateSetVersion: candidateSet.version,
  outcome: { kind: 'skill', id: 'shared' },
  probabilities: {
    'tool:shared': 0.2,
    'skill:shared': 0.7,
    multi_intent: 0.05,
    needs_context: 0.03,
    no_match: 0.02,
  },
  confidence: 0.7,
};

describe('dormant typed capability-routing identity contract', () => {
  it('preserves tool and skill namespaces even for the same bare ID', () => {
    expect(typedCapabilityRoutingChoiceKey({ kind: 'tool', id: 'shared' })).toBe('tool:shared');
    expect(typedCapabilityRoutingChoiceKey({ kind: 'skill', id: 'shared' })).toBe('skill:shared');
    expect(validateTypedCapabilityRoutingCandidateSet(candidateSet, canonical))
      .toEqual({ ok: true, value: candidateSet });
    expect(validateTypedCapabilityRoutingResult(result, { candidateSet, canonical }))
      .toEqual({ ok: true, value: result });
  });

  it.each([
    [{ version: 'v1', candidates: [{ kind: 'skill', id: 'not_registered' }] }, 'unknown_candidate'],
    [{ version: 'v1', candidates: [{ kind: 'tool', id: 'meeting_prep' }] }, 'unknown_candidate'],
    [{ version: 'v1', candidates: [{ kind: 'skill', id: 'shared' }, { kind: 'skill', id: 'shared' }] }, 'duplicate_candidate'],
    [{ version: 'v1', candidates: [{ kind: 'skill', id: ' shared' }] }, 'malformed_candidate_set'],
    [{ version: 'v1', candidates: [{ kind: 'quick_action', id: 'meeting_prep' }] }, 'malformed_candidate_set'],
  ])('rejects invalid namespaced candidate identity', (input, reason) => {
    expect(validateTypedCapabilityRoutingCandidateSet(input, canonical)).toEqual({ ok: false, reason });
  });

  it.each([
    [{ toolIds: ['shared', 'shared'], skillIds: ['meeting_prep'] }],
    [{ toolIds: ['shared'], skillIds: ['meeting_prep', 'meeting_prep'] }],
    [{ toolIds: [' shared'], skillIds: [] }],
    [{ toolIds: [], skillIds: [''] }],
  ])('rejects duplicate or malformed canonical identity lists', (descriptors) => {
    expect(validateTypedCapabilityRoutingCandidateSet(candidateSet, descriptors))
      .toEqual({ ok: false, reason: 'malformed_canonical_descriptors' });
  });

  it.each([
    [{ ...result, outcome: { kind: 'skill', id: 'meeting_prep' } }, 'outcome_not_allowed'],
    [{ ...result, outcome: { kind: 'tool', id: 'shared' }, probabilities: {
      ...result.probabilities, 'skill:shared': 0.2, 'tool:shared': 0.7,
    } }, undefined],
    [{ ...result, probabilities: { ...result.probabilities, 'skill:meeting_prep': 0 } }, 'invalid_probabilities'],
    [{ ...result, candidateSetVersion: 'other-turn' }, 'candidate_set_version_mismatch'],
    [{ ...result, outcome: 'tool:shared' }, 'malformed_result'],
    [{ ...result, questionVersion: 'capability_routing.v1' }, 'malformed_result'],
  ])('checks a typed advisory result against the exact supplied set', (input, reason) => {
    const checked = validateTypedCapabilityRoutingResult(input, { candidateSet, canonical });
    if (reason === undefined) expect(checked.ok).toBe(true);
    else expect(checked).toEqual({ ok: false, reason });
  });

  it.each([
    [{ 'tool:shared': 0.2, multi_intent: 0.05, needs_context: 0.03, no_match: 0.02 }, 'invalid_probabilities'],
    [{ ...result.probabilities, 'skill:unoffered': 0 }, 'invalid_probabilities'],
    [{ ...result.probabilities, 'skill:shared': Number.NaN }, 'malformed_result'],
    [{ ...result.probabilities, 'skill:shared': Number.POSITIVE_INFINITY }, 'invalid_probabilities'],
    [{ ...result.probabilities, 'skill:shared': -0.1 }, 'invalid_probabilities'],
    [{ ...result.probabilities, 'skill:shared': 1.1 }, 'invalid_probabilities'],
    [{ ...result.probabilities, 'skill:shared': 0.1 }, 'invalid_probabilities'],
  ])('rejects incomplete, foreign, or invalid probability distributions', (probabilities, reason) => {
    expect(validateTypedCapabilityRoutingResult({ ...result, probabilities }, { candidateSet, canonical }))
      .toEqual({ ok: false, reason });
  });

  it('accepts only abstention choices for an empty candidate set', () => {
    const empty = { version: 'empty-turn', candidates: [] };
    const abstention = { ...result, candidateSetVersion: empty.version, outcome: 'needs_context',
      probabilities: { multi_intent: 0, needs_context: 1, no_match: 0 }, confidence: 1 };
    expect(validateTypedCapabilityRoutingResult(abstention, { candidateSet: empty, canonical }))
      .toEqual({ ok: true, value: abstention });
    expect(validateTypedCapabilityRoutingResult({ ...abstention, outcome: { kind: 'skill', id: 'shared' } },
      { candidateSet: empty, canonical })).toEqual({ ok: false, reason: 'outcome_not_allowed' });
  });
});
