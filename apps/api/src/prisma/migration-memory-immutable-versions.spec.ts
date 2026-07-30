import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260812010000_memory_immutable_versions/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('immutable memory version migration', () => {
  test('generic candidate approval cannot activate correction or restore proposals', () => {
    expect(migration).toContain('memory_candidate_version_activation_guard');
    expect(migration).toContain("current_setting('app.memory_version_activation', true)");
    expect(migration).toContain("'memory_correction','memory_restore','memory_contradiction'");
    expect(migration).toContain('memory version candidates require immutable activation service');
  });

  test('version candidates require typed source lineage', () => {
    expect(migration).toContain('memory_candidate_version_payload_check');
    expect(migration).toContain("payload_jsonb #>> '{versionProposal,sourceItemId}'");
    expect(migration).toContain("IN ('correction','restore','contradiction')");
  });

  test('legal-held truth cannot be revoked or superseded through another path', () => {
    expect(migration).toContain('memory_items_legal_hold_transition_guard');
    expect(migration).toContain('legal-held memory cannot be destructively transitioned');
    expect(migration).toContain("NEW.status IN ('revoked','superseded')");
  });
});
