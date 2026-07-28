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

  test('declares its SELECT-only, no-automatic-division policy in the report', () => {
    expect(source()).toContain('SELECT_ONLY_NO_AUTOMATIC_DIVISION');
  });

  test('performs no automatic scale division and exposes no repair flag', () => {
    const text = source();
    // The defect is a ~1000x inflation; dividing here is exactly what Phase B forbids.
    expect(text).not.toMatch(/\/\s*1_?000\b/);
    expect(text).not.toMatch(/--repair|allowRepair|applyRepair/);
  });

  // The proof rule itself is verified by executing classifyUnitAuditFinding in
  // defense-budget-commit.spec.ts. This asserts only that the audit DELEGATES to
  // that tested function instead of re-implementing the rule inline, which is what
  // makes the executable tests meaningful for this script's behavior.
  test('delegates the proof rule to the unit-tested classifier', () => {
    const text = source();
    expect(text).toContain('classifyUnitAuditFinding({');
    expect(text).not.toMatch(/const\s+thousandScale\s*=/);
  });

  test('reports a recommended replay source so repair never re-runs a paid parse', () => {
    expect(source()).toContain('recommendedReplaySource');
  });
});
