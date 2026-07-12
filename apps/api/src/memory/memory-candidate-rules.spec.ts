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
