import {
  assertPackage6QualificationTarget,
  Package6QualificationSafetyError,
} from './package6-qualification-safety.js';

const valid = {
  databaseUrl: 'postgresql://qualification:secret@127.0.0.1:5432/package6_qualification',
  environmentOptIn: '1',
  args: ['--execute-on-disposable-package6-db'],
} as const;

describe('Package 6 qualification safety', () => {
  it('accepts only the exact disposable target with both opt-ins', () => {
    expect(assertPackage6QualificationTarget(valid)).toEqual({ databaseName: 'package6_qualification' });
  });

  it.each([
    { ...valid, environmentOptIn: undefined },
    { ...valid, args: [] },
    { ...valid, databaseUrl: undefined },
    { ...valid, databaseUrl: 'not-a-url' },
    { ...valid, databaseUrl: 'mysql://localhost/package6_qualification' },
    { ...valid, databaseUrl: 'postgresql://localhost/capiro' },
    { ...valid, databaseUrl: 'postgresql://prod.internal/package6_qualification' },
  ])('rejects an unsafe target without disclosing credentials', (input: {
    databaseUrl: string | undefined;
    environmentOptIn: string | undefined;
    args: readonly string[];
  }) => {
    let error: unknown;
    try {
      assertPackage6QualificationTarget(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Package6QualificationSafetyError);
    expect(String(error)).not.toContain('secret');
  });
});
