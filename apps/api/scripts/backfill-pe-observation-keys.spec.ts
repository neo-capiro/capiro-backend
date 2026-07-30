import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

const source = readFileSync(resolve(process.cwd(), 'scripts/backfill-pe-observation-keys.ts'), 'utf8');

describe('backfill-pe-observation-keys safety contract', () => {
  test('is dry-run by default and exact-count gated for writes', () => {
    expect(source).toContain("const commit = flag('commit')");
    expect(source).toContain("arg('approved-count')");
    expect(source).toContain('approvedCount !== candidates.length');
    expect(source).toMatch(/if \(!commit\) return;/);
  });

  test('changes only source-observation metadata and never canonical rows or deletes', () => {
    expect(source).toContain('programElementYearSourceValue.update');
    expect(source).not.toMatch(/programElementYear\.(update|create|delete|upsert)/);
    expect(source).not.toMatch(/deleteMany|\.delete\(/);
    expect(source).not.toMatch(/\/\s*1000|\/\s*1_000|\/\s*1000000|\/\s*1_000_000/);
    expect(source).toContain('canonicalValueM: row.canonicalValueM ?? row.valueDecimal');
    expect(source).toContain('observationKey: row.observationKey ?? `legacy:${row.id}`');
  });
});
