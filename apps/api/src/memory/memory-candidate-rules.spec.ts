import {
  DEFAULT_MIN_WRITE_CONFIDENCE,
  evaluateMemoryCandidate,
  passesWriteConfidenceGate,
} from './memory-candidate-rules.js';

describe('evaluateMemoryCandidate — explicit human saves', () => {
  it('auto-commits personal-scope saves regardless of admin status', () => {
    expect(evaluateMemoryCandidate({ scope: 'personal', isAdmin: false })).toMatchObject({
      outcome: 'PASS',
      ruleId: 'memory.personal.auto_commit',
    });
    expect(evaluateMemoryCandidate({ scope: 'personal', isAdmin: true })).toMatchObject({
      outcome: 'PASS',
      ruleId: 'memory.personal.auto_commit',
    });
  });

  it('auto-commits an explicit admin firm-scope save', () => {
    expect(evaluateMemoryCandidate({ scope: 'firm', isAdmin: true })).toMatchObject({
      outcome: 'PASS',
      ruleId: 'memory.firm.admin_auto_commit',
    });
  });

  it('requires approval for a non-admin firm-scope save', () => {
    expect(evaluateMemoryCandidate({ scope: 'firm', isAdmin: false })).toMatchObject({
      outcome: 'WARN',
      ruleId: 'memory.firm.requires_approval',
    });
  });
});

describe('evaluateMemoryCandidate — client scope', () => {
  it('explicit client + admin saves retain their existing auto-commit behavior', () => {
    const d = evaluateMemoryCandidate({ scope: 'client', isAdmin: true });
    expect(d.outcome).toBe('PASS');
    expect(d.ruleId).toBe('memory.client.admin_auto_commit');
  });

  it('explicit client + non-admin saves land pending for review', () => {
    const d = evaluateMemoryCandidate({ scope: 'client', isAdmin: false });
    expect(d.outcome).toBe('WARN');
    expect(d.ruleId).toBe('memory.client.requires_approval');
  });
});

describe('evaluateMemoryCandidate — Phase 0 machine extraction containment', () => {
  it.each([
    ['personal', false, 0.1],
    ['personal', true, 0.99],
    ['firm', true, 1],
    ['client', true, 0.95],
  ] as const)(
    'keeps model extraction pending for scope=%s admin=%s confidence=%s',
    (scope, isAdmin, confidence) => {
      const decision = evaluateMemoryCandidate({
        scope,
        isAdmin,
        sourceKind: 'model_extraction',
        confidence,
      });
      expect(decision.outcome).toBe('WARN');
      expect(decision.ruleId).toBe('memory.model_extraction.requires_review');
    },
  );

  it('does not let a threshold override turn machine output into active truth', () => {
    expect(
      evaluateMemoryCandidate({
        scope: 'personal',
        isAdmin: true,
        sourceKind: 'model_extraction',
        confidence: 1,
        minConfidence: 0,
      }),
    ).toMatchObject({ outcome: 'WARN', ruleId: 'memory.model_extraction.requires_review' });
  });

  it('is inert for explicit human saves even when a confidence number is present', () => {
    expect(
      evaluateMemoryCandidate({ scope: 'personal', isAdmin: false, confidence: 0.1 }).ruleId,
    ).toBe('memory.personal.auto_commit');
  });
});

describe('passesWriteConfidenceGate', () => {
  it('remains available for extraction/evaluation, not auto-promotion authority', () => {
    expect(passesWriteConfidenceGate(0.7)).toBe(true);
    expect(passesWriteConfidenceGate(0.69, 0.7)).toBe(false);
    expect(passesWriteConfidenceGate(null)).toBe(false);
    expect(passesWriteConfidenceGate(undefined)).toBe(false);
    expect(DEFAULT_MIN_WRITE_CONFIDENCE).toBe(0.7);
  });
});
