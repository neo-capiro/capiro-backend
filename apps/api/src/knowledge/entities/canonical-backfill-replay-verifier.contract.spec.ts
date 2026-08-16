import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function repositoryPath(relativePath: string): string {
  const candidates = [
    join(process.cwd(), relativePath),
    join(process.cwd(), 'apps/api', relativePath),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Could not resolve repository path: ${relativePath}`);
  return found;
}

const source = readFileSync(
  repositoryPath('scripts/verify-canonical-backfill-replay.ts'),
  'utf8',
);

describe('bounded canonical backfill replay verifier contract', () => {
  test('runs the exact same bounded cohort twice and evaluates snapshots', () => {
    expect(source).toContain('const first = await backfill.runPage(tenantId, options)');
    expect(source).toContain('const second = await backfill.runPage(tenantId, options)');
    expect(source).toContain('evaluateCanonicalBackfillReplay');
  });

  test('refuses empty cohorts and production-style unbounded runs', () => {
    expect(source).toContain('bounded replay requires a data-bearing cohort');
    expect(source).toContain("limit must be an integer between 1 and 100");
    expect(source).not.toContain('dryRun: true');
  });

  test('does not schedule work or mutate source records directly', () => {
    expect(source).not.toMatch(/EventBridge|Schedule|cron\s*:/i);
    expect(source).not.toMatch(/UPDATE\s+clients|DELETE\s+FROM\s+clients/i);
  });
});
