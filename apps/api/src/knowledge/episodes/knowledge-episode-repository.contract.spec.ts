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

const repository = readFileSync(
  repositoryPath('src/knowledge/episodes/knowledge-episode.repository.ts'),
  'utf8',
);

describe('KnowledgeEpisodeRepository contract', () => {
  test('every mutation goes through withTenant or the system claim boundary, never a bare query', () => {
    const withTenantCount = (repository.match(/this\.prisma\.withTenant\(/g) ?? []).length;
    // findOrCreateEpisode, addEventMembership, addAssertionMembership,
    // addEntityMembership, complete, skip, fail.
    expect(withTenantCount).toBeGreaterThanOrEqual(7);
    expect(repository).toContain('this.prisma.withSystem(');
  });

  test('claimBatch is a system queue boundary, but every later transition re-scopes by tenant', () => {
    expect(repository).toContain('FOR UPDATE SKIP LOCKED');
    expect(repository).toContain("locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'");
    expect(repository).toContain('attempt_count < 100');
    expect(repository).toContain(
      "CASE WHEN status IN ('pending', 'failed') THEN 0 ELSE 1 END",
    );
  });

  test('every job transition (complete/skip/fail) is fenced by tenant + id + locked_by + attempt_count', () => {
    for (const method of ['complete', 'skip', 'fail']) {
      const methodBody = extractMethod(repository, method);
      expect(methodBody).toContain('WHERE tenant_id = ${job.tenantId}::uuid');
      expect(methodBody).toContain("AND status = 'processing'");
      expect(methodBody).toContain('AND locked_by = ${job.lockedBy}');
      expect(methodBody).toContain('AND attempt_count = ${job.attemptCount}');
    }
  });

  test('membership inserts use ON CONFLICT DO NOTHING against the exact unique constraint columns', () => {
    expect(repository).toContain('ON CONFLICT (tenant_id, episode_id, event_id) DO NOTHING');
    expect(repository).toContain('ON CONFLICT (tenant_id, episode_id, assertion_id) DO NOTHING');
    expect(repository).toContain('ON CONFLICT (tenant_id, episode_id, canonical_entity_id) DO NOTHING');
    expect(repository).toContain('ON CONFLICT (tenant_id, strategy, identity_key) DO NOTHING');
  });

  test('counts are incremented only by the number of rows actually inserted this call (no double-count on replay)', () => {
    expect(repository).toContain('event_count = event_count + (SELECT count(*) FROM inserted_row)');
    expect(repository).toContain('assertion_count = assertion_count + (SELECT count(*) FROM inserted_row)');
    expect(repository).toContain('entity_count = entity_count + (SELECT count(*) FROM inserted_row)');
  });

  test('never persists a raw error message/exception into operational state', () => {
    expect(repository).toContain(
      "return error instanceof Error ? error.name : 'UnknownError'",
    );
    expect(repository).not.toContain('error.message`');
    expect(repository).not.toContain('${error}`');
  });

  test('claimBatch dead-letters stale-processing rows past 100 attempts before selecting candidates', () => {
    expect(repository).toContain("status = 'dead_letter'");
    expect(repository).toContain("last_error = 'MaxAttemptsExceeded'");
  });

});

function extractMethod(source: string, name: string): string {
  const marker = `async ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`Method ${name} not found in repository source.`);
  // Grab a generous window; exact statement boundaries don't matter for
  // these substring assertions.
  return source.slice(start, start + 1200);
}
