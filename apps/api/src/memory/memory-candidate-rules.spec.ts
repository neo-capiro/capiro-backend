import { evaluateMemoryCandidate } from './memory-candidate-rules.js';

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
