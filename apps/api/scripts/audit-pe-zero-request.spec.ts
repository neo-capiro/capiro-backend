import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { classifyZeroRequestFinding } from './audit-pe-zero-request.js';

function source(): string {
  const cwd = process.cwd();
  const apiRoot = cwd.replace(/\\/g, '/').endsWith('/apps/api') ? cwd : resolve(cwd, 'apps/api');
  return readFileSync(resolve(apiRoot, 'scripts/audit-pe-zero-request.ts'), 'utf8');
}

describe('audit-pe-zero-request safety contract', () => {
  test('contains no Prisma mutation or raw execution call', () => {
    const text = source();
    expect(text).not.toMatch(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/);
    expect(text).not.toMatch(/\$executeRaw|\$executeRawUnsafe|\$queryRawUnsafe/);
    expect(text).not.toMatch(/\b(UPDATE|INSERT|DELETE)\s/);
    expect(text).not.toMatch(/--repair|--apply|--commit/);
  });

  test('declares its SELECT-only, no-re-pick policy in the report', () => {
    expect(source()).toContain('SELECT_ONLY_NO_REPICK');
  });
});

describe('classifyZeroRequestFinding', () => {
  test('a committee restatement alone can never own the request (PE 0603203F FY27 shape)', () => {
    expect(
      classifyZeroRequestFinding([{ source: 'hasc_report_fy27', valueM: 72.149 }]),
    ).toEqual({ bucket: 'committeeRestatementOnly', requestOwnerValuesM: [] });
  });

  test('a non-zero budget-request observation makes the $0 winner a lineage conflict', () => {
    expect(
      classifyZeroRequestFinding([
        { source: 'hasc_report_fy27', valueM: 72.149 },
        { source: 'llamaparse_fy2027_r1', valueM: 72.149 },
        { source: 'llamaparse_af_rdte_vol1', valueM: 72.149 },
      ]),
    ).toEqual({ bucket: 'pbAuthorityConflict', requestOwnerValuesM: [72.149] });
  });

  test('fixtures and unknown sources never count as request owners', () => {
    expect(
      classifyZeroRequestFinding([
        { source: 'fixture_seed', valueM: 10 },
        { source: 'mystery_feed', valueM: 10 },
      ]).bucket,
    ).toBe('committeeRestatementOnly');
  });
});
