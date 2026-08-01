import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260812010000_memory_immutable_versions/migration.sql',
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

  test('version candidates require typed and source-kind-matched lineage', () => {
    expect(migration).toContain('memory_candidate_version_payload_check');
    expect(migration).toContain("payload_jsonb #>> '{versionProposal,sourceItemId}'");
    expect(migration).toContain("IN ('correction','restore','contradiction')");
    expect(migration).toContain("source_kind = 'memory_correction'");
    expect(migration).toContain("source_kind = 'memory_restore'");
    expect(migration).toContain("source_kind = 'memory_contradiction'");
  });

  test('ordinary memory inserts bypass the immutable-version-only trigger', () => {
    expect(migration).toContain('NEW.origin_surface IS NULL');
    expect(migration).toContain(
      "NEW.origin_surface NOT IN ('memory_correction','memory_restore','memory_contradiction')",
    );
  });

  test('approval is bound to the exact target reviewed by the proposer', () => {
    expect(migration).toContain('memory_items_immutable_version_insert_guard');
    expect(migration).toContain("payload_jsonb #>> '{versionProposal,targetItemId}'");
    expect(migration).toContain('memory version approval target drifted from reviewed proposal');
    expect(migration).toContain('memory version target is not the controlling version');
  });

  test('legal hold follows derivative versions and blocks terminal transitions', () => {
    expect(migration).toContain('NEW.legal_hold := true');
    expect(migration).toContain('memory_items_legal_hold_transition_guard');
    expect(migration).toContain('legal-held memory cannot be destructively transitioned');
    expect(migration).toContain("NEW.status IN ('revoked','superseded')");
  });

  test('expired restores cannot become silently invisible active rows', () => {
    expect(migration).toContain("NEW.origin_surface = 'memory_restore'");
    expect(migration).toContain('NEW.valid_until := NULL');
    expect(migration).toContain('NEW.expires_at := NULL');
    expect(migration).toContain('expired working-memory restore requires a new TTL');
  });

  test('resolved losers and open conflict members cannot be superseded as controlling truth', () => {
    expect(migration).toContain('memory_items_controlling_supersession_guard');
    expect(migration).toContain('noncontrolling conflict memory cannot be superseded');
    expect(migration).toContain("OLD.conflict_status = 'controlling'");
  });

  test('duplicate contradictions do not remain falsely marked as open conflicts', () => {
    expect(migration).toContain("NEW.conflict_status := 'none'");
    expect(migration).toContain('NEW.conflict_group_id := committed_conflict_group_id');
    expect(migration).toContain('approved contradiction has no conflict group');
  });
});
