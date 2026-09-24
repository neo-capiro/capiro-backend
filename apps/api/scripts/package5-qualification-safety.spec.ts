import { assertPackage5QualificationTarget } from './package5-qualification-safety.js';

const valid = {
  databaseUrl: 'postgresql://qualification:secret@localhost:5432/package5_qualification?schema=public',
  environmentOptIn: '1',
  args: ['--execute-on-disposable-package5-db'],
};

describe('Package 5 qualification write safety', () => {
  it('fails closed until both independent opt-ins are present', () => {
    expect(() => assertPackage5QualificationTarget({ ...valid, environmentOptIn: undefined })).toThrow(
      /Both opt-ins are required/,
    );
    expect(() => assertPackage5QualificationTarget({ ...valid, args: [] })).toThrow(/Both opt-ins are required/);
  });

  it('refuses database URLs without the exact disposable qualification database name', () => {
    expect(() => assertPackage5QualificationTarget({ ...valid, databaseUrl: 'postgresql://user:secret@localhost/app' }))
      .toThrow(/named exactly package5_qualification/);
    expect(() => assertPackage5QualificationTarget({ ...valid, databaseUrl: 'mysql://localhost/package5_qualification' }))
      .toThrow(/requires PostgreSQL/);
  });

  it('rejects a production-looking host and never includes URL credentials in errors', () => {
    expect(() => assertPackage5QualificationTarget({
      ...valid,
      databaseUrl: 'postgresql://private-user:private-password@db.production.example/package5_qualification',
    })).toThrow(/production-looking/);
    try {
      assertPackage5QualificationTarget({
        ...valid,
        databaseUrl: 'not-a-url-with-private-password',
      });
    } catch (error) {
      expect(String(error)).not.toContain('private-password');
    }
  });

  it('approves only the visibly disposable Package 5 database', () => {
    expect(assertPackage5QualificationTarget(valid)).toEqual({ databaseName: 'package5_qualification' });
  });
});
