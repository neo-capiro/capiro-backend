import {
  DEFAULT_MIN_WRITE_CONFIDENCE,
  evaluateMemoryCandidate,
  passesWriteConfidenceGate,
} from './memory-candidate-rules.js';

describe('evaluateMemoryCandidate (Phase 1, 1B)', () => {
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

  it('auto-commits an admin firm-scope save (preserves pre-Phase-1 behavior)', () => {
    expect(evaluateMemoryCandidate({ scope: 'firm', isAdmin: true })).toMatchObject({
      outcome: 'PASS',
      ruleId: 'memory.firm.admin_auto_commit',
    });
  });

  it('requires approval for a non-admin firm-scope save (was a dead-end rejection before)', () => {
    expect(evaluateMemoryCandidate({ scope: 'firm', isAdmin: false })).toMatchObject({
      outcome: 'WARN',
      ruleId: 'memory.firm.requires_approval',
    });
  });
});

// ── G2: client scope ─────────────────────────────────────────────────────────
describe('evaluateMemoryCandidate — client scope (G2)', () => {
  it('client + admin auto-commits (same trust posture as firm)', () => {
    const d = evaluateMemoryCandidate({ scope: 'client', isAdmin: true });
    expect(d.outcome).toBe('PASS');
    expect(d.ruleId).toBe('memory.client.admin_auto_commit');
  });

  it('client + non-admin lands pending for review', () => {
    const d = evaluateMemoryCandidate({ scope: 'client', isAdmin: false });
    expect(d.outcome).toBe('WARN');
    expect(d.ruleId).toBe('memory.client.requires_approval');
  });
});

// ── Phase 4: model-extraction low-confidence gate ────────────────────────────
describe('evaluateMemoryCandidate — Phase 4 model_extraction confidence', () => {
  it('routes a low-confidence model extraction to review (WARN), first-match-wins', () => {
    const d = evaluateMemoryCandidate({
      scope: 'personal', // would normally auto-commit — the confidence rule wins
      isAdmin: true,
      sourceKind: 'model_extraction',
      confidence: 0.4,
    });
    expect(d.outcome).toBe('WARN');
    expect(d.ruleId).toBe('memory.model_extraction.low_confidence_requires_approval');
  });

  it('a high-confidence model extraction falls through to the normal scope rule', () => {
    const d = evaluateMemoryCandidate({
      scope: 'personal',
      isAdmin: false,
      sourceKind: 'model_extraction',
      confidence: 0.95,
    });
    expect(d.outcome).toBe('PASS');
    expect(d.ruleId).toBe('memory.personal.auto_commit');
  });

  it('is INERT for explicit human saves (no sourceKind/confidence) — unchanged behavior', () => {
    expect(evaluateMemoryCandidate({ scope: 'personal', isAdmin: false }).ruleId).toBe(
      'memory.personal.auto_commit',
    );
    // even a low number is ignored when the source is not a model extraction
    expect(
      evaluateMemoryCandidate({ scope: 'personal', isAdmin: false, confidence: 0.1 }).ruleId,
    ).toBe('memory.personal.auto_commit');
  });

  it('honors an explicit minConfidence override', () => {
    const strict = evaluateMemoryCandidate({
      scope: 'firm',
      isAdmin: true,
      sourceKind: 'model_extraction',
      confidence: 0.8,
      minConfidence: 0.9,
    });
    expect(strict.ruleId).toBe('memory.model_extraction.low_confidence_requires_approval');
  });
});

describe('passesWriteConfidenceGate', () => {
  it('passes >= floor, fails below and for non-finite', () => {
    expect(passesWriteConfidenceGate(0.7)).toBe(true);
    expect(passesWriteConfidenceGate(0.69, 0.7)).toBe(false);
    expect(passesWriteConfidenceGate(null)).toBe(false);
    expect(passesWriteConfidenceGate(undefined)).toBe(false);
    expect(DEFAULT_MIN_WRITE_CONFIDENCE).toBe(0.7);
  });
});
