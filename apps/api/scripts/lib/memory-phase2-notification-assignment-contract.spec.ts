import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';

function resolveApiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'prisma/schema.prisma'))) return cwd;
  const monorepoApi = resolve(cwd, 'apps/api');
  if (existsSync(resolve(monorepoApi, 'prisma/schema.prisma'))) return monorepoApi;
  throw new Error(`Could not resolve apps/api from ${cwd}.`);
}

const apiRoot = resolveApiRoot();
const migration = readFileSync(
  resolve(
    apiRoot,
    'prisma/migrations/20260818040100_memory_phase2_notification_assignment_classification/migration.sql',
  ),
  'utf8',
);

describe('memory Phase 2 notification assignment classification', () => {
  it('treats the first named reviewer as an initial assignment', () => {
    expect(migration).toContain('IF OLD.assigned_to IS NULL THEN');
    expect(migration).toContain("THEN 'review_revision_assigned'");
    expect(migration).toContain("ELSE 'review_assigned'");
  });

  it('reserves reassignment for a workflow that already had a reviewer', () => {
    expect(migration).toContain("assignment_event := 'review_reassigned';");
    expect(migration.indexOf('IF OLD.assigned_to IS NULL THEN')).toBeLessThan(
      migration.indexOf("assignment_event := 'review_reassigned';"),
    );
  });

  it('preserves security-invoker and pinned-search-path boundaries', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).not.toMatch(/SECURITY\s+DEFINER/i);
  });
});
