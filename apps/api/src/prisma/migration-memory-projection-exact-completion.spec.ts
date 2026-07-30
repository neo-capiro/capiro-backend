import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260812030000_memory_projection_exact_completion/migration.sql',
  ),
  'utf8',
);

describe('memory projection exact-completion migration', () => {
  test('adds exact source version, content hash, and superseded evidence', () => {
    expect(migration).toContain('expected_source_version timestamptz');
    expect(migration).toContain('expected_content_hash varchar(64)');
    expect(migration).toContain('superseded_at timestamptz');
    expect(migration).toContain("'superseded'");
  });

  test('requires new index jobs to carry a valid exact expectation', () => {
    expect(migration).toContain('memory_cleanup_index_expectation_check');
    expect(migration).toContain("operation <> 'index_memory_item'");
    expect(migration).toContain("expected_content_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain('NOT VALID');
  });

  test('adds bounded exact-job and superseded operational indexes', () => {
    expect(migration).toContain('memory_cleanup_outbox_exact_index_job_idx');
    expect(migration).toContain('expected_source_version');
    expect(migration).toContain('expected_content_hash');
    expect(migration).toContain('memory_cleanup_outbox_superseded_idx');
  });

  test('is additive and does not delete queued obligations', () => {
    expect(migration).not.toMatch(/DELETE\s+FROM\s+memory_cleanup_outbox/i);
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
  });
});
