import { evaluateReplayCommitGateV1 } from './replay-commit-gate-v1.js';

describe('replay commit gate (Phase 10B-10 Part I dry-run-by-default requirement)', () => {
  test('no --commit -> zero mutation allowed, dry_run mode, not a refusal', () => {
    const gate = evaluateReplayCommitGateV1({ commit: false, confirm: undefined, environment: 'production' });
    expect(gate.allowed).toBe(false);
    expect(gate.mode).toBe('dry_run');
    expect(gate.refusalReason).toBeUndefined();
  });

  test('supplying --outbox-row-id/--reason/--actor alone (no --commit at all) never authorizes a mutation, regardless of environment', () => {
    for (const environment of ['production', 'dev', 'staging']) {
      const gate = evaluateReplayCommitGateV1({ commit: false, confirm: undefined, environment });
      expect(gate.allowed).toBe(false);
    }
  });

  test('--commit without --confirm at all -> zero mutation allowed, refused', () => {
    const gate = evaluateReplayCommitGateV1({ commit: true, confirm: undefined, environment: 'production' });
    expect(gate.allowed).toBe(false);
    expect(gate.mode).toBe('commit');
    expect(gate.refusalReason).toMatch(/--confirm production/);
  });

  test('--commit with the wrong environment confirmation -> zero mutation allowed, refused', () => {
    const gate = evaluateReplayCommitGateV1({ commit: true, confirm: 'staging', environment: 'production' });
    expect(gate.allowed).toBe(false);
    expect(gate.mode).toBe('commit');
    expect(gate.refusalReason).toMatch(/--confirm production/);
    expect(gate.refusalReason).toMatch(/got staging/);
  });

  test('--commit with an empty-string confirm -> zero mutation allowed, refused (not accidentally treated as a match)', () => {
    const gate = evaluateReplayCommitGateV1({ commit: true, confirm: '', environment: 'production' });
    expect(gate.allowed).toBe(false);
  });

  test('valid --commit + exact --confirm <environment> -> mutation allowed', () => {
    const gate = evaluateReplayCommitGateV1({ commit: true, confirm: 'production', environment: 'production' });
    expect(gate.allowed).toBe(true);
    expect(gate.mode).toBe('commit');
    expect(gate.refusalReason).toBeUndefined();
  });

  test('--confirm must echo THIS run\'s environment exactly, even if it matches some other valid environment name', () => {
    const gate = evaluateReplayCommitGateV1({ commit: true, confirm: 'dev', environment: 'production' });
    expect(gate.allowed).toBe(false);
  });
});
