import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function source(): string {
  const cwd = process.cwd();
  const apiRoot = cwd.replace(/\\/g, '/').endsWith('/apps/api')
    ? cwd
    : resolve(cwd, 'apps/api');
  return readFileSync(resolve(apiRoot, 'scripts/audit-llamaparse-pe-units.ts'), 'utf8');
}

describe('audit-llamaparse-pe-units safety contract', () => {
  test('contains no Prisma mutation or raw execution call', () => {
    const text = source();
    expect(text).not.toMatch(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/);
    expect(text).not.toMatch(/\$executeRaw|\$executeRawUnsafe|\$queryRawUnsafe/);
    expect(text).not.toContain('normalize-pe-units');
  });

  test('requires documentary and same-field evidence before provenAffected', () => {
    const text = source();
    expect(text).toContain('canonicalIsLlama && thousandScale && hasArchiveProof && hasMatchingParseProof');
    expect(text).toContain('same-PE/FY/field deterministic observation');
    expect(text).toContain('SELECT_ONLY_NO_AUTOMATIC_DIVISION');
  });
});
