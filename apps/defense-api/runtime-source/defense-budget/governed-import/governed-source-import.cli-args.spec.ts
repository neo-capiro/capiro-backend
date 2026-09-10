import { resolveGovernedImportCommitIntent } from './governed-source-import.cli-args.js';

describe('resolveGovernedImportCommitIntent — Phase 10B-18 Part F/M', () => {
  it('defaults to dry-run (no --commit flag) with no error', () => {
    expect(
      resolveGovernedImportCommitIntent({ commitFlagPresent: false, confirmValue: undefined, environment: 'production' }),
    ).toEqual({ commit: false, error: null });
  });

  it('refuses to commit when --confirm is missing entirely', () => {
    const result = resolveGovernedImportCommitIntent({
      commitFlagPresent: true,
      confirmValue: undefined,
      environment: 'production',
    });
    expect(result.commit).toBe(false);
    expect((result as { error: string | null }).error).toMatch(/--confirm production/);
  });

  it('refuses to commit when --confirm names the wrong environment', () => {
    const result = resolveGovernedImportCommitIntent({
      commitFlagPresent: true,
      confirmValue: 'staging',
      environment: 'production',
    });
    expect(result.commit).toBe(false);
  });

  it('commits only when --commit is present AND --confirm exactly matches --environment', () => {
    const result = resolveGovernedImportCommitIntent({
      commitFlagPresent: true,
      confirmValue: 'production',
      environment: 'production',
    });
    expect(result).toEqual({ commit: true });
  });
});
