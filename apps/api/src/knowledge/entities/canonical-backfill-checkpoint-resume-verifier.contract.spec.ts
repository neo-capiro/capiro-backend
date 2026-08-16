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
  repositoryPath('scripts/verify-canonical-backfill-checkpoint-resume.ts'),
  'utf8',
);

describe('canonical backfill checkpoint/resume verifier contract', () => {
  test('simulates a crash mid-run and restarts from a brand-new service instance', () => {
    expect(source).toContain('maxPages: 1');
    expect(source).toContain("status === 'running'");
    expect(source).toContain('newService(prisma).runToCompletion(TENANT_RESUMED');
  });

  test('would fail a from-scratch restart, not just a duplicate-entity regression', () => {
    // The core proof: resume must scan only the remaining rows, not the whole
    // corpus again. A regression to "always start from cursor null" trips
    // this assertion even though the identity layer's own idempotency would
    // still prevent duplicate canonical entities from being created.
    expect(source).toContain('CLIENT_COUNT - scannedBeforeCrash');
    expect(source).toContain('a from-scratch restart would re-scan the whole corpus instead');
  });

  test('would fail a skipped-row regression', () => {
    expect(source).toContain('a skipped row would undercount');
    expect(source).toContain('no skipped or duplicated record');
  });

  test('compares the resumed run against a real uninterrupted clean run, not a hand-built expectation', () => {
    expect(source).toContain('runToCompletion(TENANT_CLEAN');
    expect(source).toContain('resumedState.entityCount === cleanState.entityCount');
    expect(source).toContain('resumedState.canonicalNames) === JSON.stringify(cleanState.canonicalNames)');
  });

  test('checks for duplicate identifiers directly in the database, not only via counts', () => {
    expect(source).toContain('duplicateIdentifierGroups');
    expect(source).toContain('HAVING count(*) > 1');
  });

  test('cleans up every fixture it created, even on failure', () => {
    expect(source).toMatch(/finally\s*{\s*await cleanup\(prisma\)/);
  });
});
