import { describe, expect, it } from '@jest/globals';
import {
  HUMAN_TIER_MEMORY_AUTHORITIES,
  LEARNING_SIGNAL_PROVENANCE_KINDS,
  LEARNING_SIGNAL_SOURCE_SURFACES,
  LEARNING_SIGNAL_TYPES,
  assertEvidencePresentWhenProposingMemory,
  assertKnownSteeringLayer,
  assertNoAiSelfCorroboration,
  computeLearningSignalIdempotencyKey,
  type CaptureLearningSignalInput,
} from './contract';
import { MEMORY_AUTHORITIES } from '../memory/governance';

function baseInput(overrides: Partial<CaptureLearningSignalInput> = {}): CaptureLearningSignalInput {
  return {
    tenantId: 'tenant-1',
    actorUserId: 'user-1',
    clientId: null,
    sourceSurface: 'meri.chat',
    sourceObjectType: 'clio_message',
    sourceObjectId: 'msg-1',
    sourceRunId: null,
    signalType: 'meri_feedback_negative',
    proposedMemoryLayer: 'user-voice',
    proposedMemoryClass: null,
    evidenceRefs: [{ type: 'clio_message', id: 'msg-1' }],
    confidence: null,
    sourceAuthority: null,
    sensitivity: 'normal',
    provenanceKind: 'human_explicit',
    provenance: {},
    governanceRequirement: 'human_required',
    observedAt: new Date('2026-08-21T00:00:00.000Z'),
    ...overrides,
  };
}

describe('LearningSignal contract (Phase 27A)', () => {
  it('every human-tier authority is a real MemoryAuthority value', () => {
    for (const authority of HUMAN_TIER_MEMORY_AUTHORITIES) {
      expect(MEMORY_AUTHORITIES).toContain(authority);
    }
  });

  describe('assertNoAiSelfCorroboration', () => {
    it('allows a human-tier authority when provenance is human_explicit', () => {
      expect(() =>
        assertNoAiSelfCorroboration({ provenanceKind: 'human_explicit', sourceAuthority: 'user_asserted' }),
      ).not.toThrow();
    });

    it('allows a human-tier authority when provenance is human_implicit', () => {
      expect(() =>
        assertNoAiSelfCorroboration({ provenanceKind: 'human_implicit', sourceAuthority: 'analyst_verified' }),
      ).not.toThrow();
    });

    it('allows any provenance when sourceAuthority is null', () => {
      for (const provenanceKind of LEARNING_SIGNAL_PROVENANCE_KINDS) {
        expect(() => assertNoAiSelfCorroboration({ provenanceKind, sourceAuthority: null })).not.toThrow();
      }
    });

    it('allows a non-human-tier authority (model_inferred) with ai_generated_only', () => {
      expect(() =>
        assertNoAiSelfCorroboration({ provenanceKind: 'ai_generated_only', sourceAuthority: 'model_inferred' }),
      ).not.toThrow();
    });

    it('REJECTS a human-tier authority claimed from ai_generated_only provenance — the core anti-feedback-loop invariant', () => {
      for (const authority of HUMAN_TIER_MEMORY_AUTHORITIES) {
        expect(() =>
          assertNoAiSelfCorroboration({ provenanceKind: 'ai_generated_only', sourceAuthority: authority }),
        ).toThrow(/AI-generated content cannot be its own evidence/);
      }
    });

    it('REJECTS a human-tier authority claimed from system_derived provenance', () => {
      expect(() =>
        assertNoAiSelfCorroboration({ provenanceKind: 'system_derived', sourceAuthority: 'firm_approved' }),
      ).toThrow();
    });
  });

  describe('assertKnownSteeringLayer', () => {
    it('accepts null/undefined (no proposed layer)', () => {
      expect(() => assertKnownSteeringLayer(null)).not.toThrow();
      expect(() => assertKnownSteeringLayer(undefined)).not.toThrow();
    });

    it('accepts exactly the five frozen layers', () => {
      const frozen = ['firm-identity', 'firm-playbook', 'user-voice', 'client-steering', 'client-people'] as const;
      for (const layer of frozen) expect(() => assertKnownSteeringLayer(layer)).not.toThrow();
    });

    it('rejects a sixth/unknown layer — guards the frozen five-layer invariant', () => {
      expect(() => assertKnownSteeringLayer('external-research' as never)).toThrow(
        /not one of the five frozen context layers/,
      );
    });
  });

  describe('computeLearningSignalIdempotencyKey', () => {
    it('is deterministic for identical inputs', () => {
      const input = baseInput();
      expect(computeLearningSignalIdempotencyKey(input)).toBe(computeLearningSignalIdempotencyKey(input));
    });

    it('differs when signalType differs (a rating flip is a new signal, not a dedupe collision)', () => {
      const up = baseInput({ signalType: 'meri_feedback_positive' });
      const down = baseInput({ signalType: 'meri_feedback_negative' });
      expect(computeLearningSignalIdempotencyKey(up)).not.toBe(computeLearningSignalIdempotencyKey(down));
    });

    it('differs across tenants scoping components (sourceObjectId, actorUserId)', () => {
      const a = baseInput({ sourceObjectId: 'msg-1', actorUserId: 'user-1' });
      const b = baseInput({ sourceObjectId: 'msg-2', actorUserId: 'user-1' });
      const c = baseInput({ sourceObjectId: 'msg-1', actorUserId: 'user-2' });
      const keys = new Set([a, b, c].map(computeLearningSignalIdempotencyKey));
      expect(keys.size).toBe(3);
    });

    it('is identical for a retried/duplicated identical event (the idempotency guarantee)', () => {
      const first = baseInput();
      const retry = baseInput();
      expect(computeLearningSignalIdempotencyKey(first)).toBe(computeLearningSignalIdempotencyKey(retry));
    });
  });

  describe('assertEvidencePresentWhenProposingMemory', () => {
    it('allows no proposed layer with zero evidence', () => {
      expect(() =>
        assertEvidencePresentWhenProposingMemory({ proposedMemoryLayer: null, evidenceRefs: [] }),
      ).not.toThrow();
    });

    it('allows a proposed layer with at least one evidence ref', () => {
      expect(() =>
        assertEvidencePresentWhenProposingMemory({
          proposedMemoryLayer: 'user-voice',
          evidenceRefs: [{ type: 'clio_message', id: 'msg-1' }],
        }),
      ).not.toThrow();
    });

    it('REJECTS a proposed layer with zero evidence — "missing evidence fails where required"', () => {
      expect(() =>
        assertEvidencePresentWhenProposingMemory({ proposedMemoryLayer: 'client-steering', evidenceRefs: [] }),
      ).toThrow(/must carry at least one evidence reference/);
    });
  });

  it('vocabularies are non-empty and closed (no accidental duplicate entries)', () => {
    for (const vocab of [LEARNING_SIGNAL_SOURCE_SURFACES, LEARNING_SIGNAL_TYPES, LEARNING_SIGNAL_PROVENANCE_KINDS]) {
      expect(vocab.length).toBeGreaterThan(0);
      expect(new Set(vocab).size).toBe(vocab.length);
    }
  });
});
