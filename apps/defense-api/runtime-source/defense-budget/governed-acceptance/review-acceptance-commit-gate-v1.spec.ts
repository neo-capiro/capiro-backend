import { evaluateReviewAcceptanceCommitGateV1 } from './review-acceptance-commit-gate-v1.js';

describe('evaluateReviewAcceptanceCommitGateV1', () => {
  test('no --commit -> dry_run, never allowed, regardless of --confirm', () => {
    const result = evaluateReviewAcceptanceCommitGateV1({
      commit: false,
      confirm: 'production',
      environment: 'production',
    });
    expect(result).toEqual({ allowed: false, mode: 'dry_run' });
  });

  test('--commit without --confirm -> refused', () => {
    const result = evaluateReviewAcceptanceCommitGateV1({
      commit: true,
      confirm: undefined,
      environment: 'production',
    });
    expect(result.allowed).toBe(false);
    expect(result.mode).toBe('commit');
    expect(result.refusalReason).toMatch(/--confirm production/);
  });

  test('--commit with wrong --confirm value -> refused', () => {
    const result = evaluateReviewAcceptanceCommitGateV1({
      commit: true,
      confirm: 'staging',
      environment: 'production',
    });
    expect(result.allowed).toBe(false);
    expect(result.refusalReason).toMatch(/got staging/);
  });

  test('--commit with exact matching --confirm -> allowed', () => {
    const result = evaluateReviewAcceptanceCommitGateV1({
      commit: true,
      confirm: 'production',
      environment: 'production',
    });
    expect(result).toEqual({ allowed: true, mode: 'commit' });
  });
});
