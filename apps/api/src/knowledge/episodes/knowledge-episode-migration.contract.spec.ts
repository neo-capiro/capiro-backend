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

const migration = readFileSync(
  repositoryPath('prisma/migrations/20261120160000_knowledge_episodes/migration.sql'),
  'utf8',
);

describe('Knowledge Plane Phase 7 episode migration contract', () => {
  test('creates all five Phase 7 tables with forced RLS and tenant isolation', () => {
    for (const table of [
      'knowledge_episodes',
      'knowledge_episode_events',
      'knowledge_episode_assertions',
      'knowledge_episode_entities',
      'knowledge_episode_projection_jobs',
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`"${table}_tenant_isolation"`);
    }
  });

  test('every Phase 7 table carries tenant_id NOT NULL with a tenant FK', () => {
    const tables = [
      'knowledge_episodes',
      'knowledge_episode_events',
      'knowledge_episode_assertions',
      'knowledge_episode_entities',
      'knowledge_episode_projection_jobs',
    ];
    for (const table of tables) {
      expect(migration).toContain(`"${table}_tenant_fkey"`);
    }
    // tenant_id NOT NULL appears once per CREATE TABLE block.
    expect((migration.match(/"tenant_id" UUID NOT NULL/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  test('does not create a second graph/relationship-history/evidence store', () => {
    expect(migration).not.toMatch(/CREATE TABLE "knowledge_relationship_history"/i);
    expect(migration).not.toMatch(/CREATE TABLE "knowledge_graph"/i);
    expect(migration).not.toMatch(/CREATE TABLE "knowledge_episode_evidence"/i);
    expect(migration).not.toMatch(/CREATE EXTENSION.*vector/i);
  });

  test('episode membership tables are append-only for the application role', () => {
    expect(migration).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "knowledge_episode_events" FROM capiro_app',
    );
    expect(migration).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "knowledge_episode_assertions" FROM capiro_app',
    );
    expect(migration).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "knowledge_episode_entities" FROM capiro_app',
    );
    // Episodes/jobs are mutable derived state but never destructively deleted.
    expect(migration).toContain(
      'REVOKE DELETE, TRUNCATE ON TABLE "knowledge_episodes" FROM capiro_app',
    );
    expect(migration).toContain(
      'REVOKE DELETE, TRUNCATE ON TABLE "knowledge_episode_projection_jobs" FROM capiro_app',
    );
  });

  test('membership uniqueness enforces idempotent replay and single-episode-per-row', () => {
    expect(migration).toContain('"knowledge_episode_events_membership_unique"');
    expect(migration).toContain('UNIQUE ("tenant_id", "episode_id", "event_id")');
    expect(migration).toContain('"knowledge_episode_events_event_unique"');
    expect(migration).toContain('UNIQUE ("tenant_id", "event_id")');
    expect(migration).toContain('"knowledge_episode_assertions_membership_unique"');
    expect(migration).toContain('"knowledge_episode_assertions_assertion_unique"');
    expect(migration).toContain('"knowledge_episode_entities_membership_unique"');
    expect(migration).toContain('"knowledge_episodes_identity_unique"');
    expect(migration).toContain('UNIQUE ("tenant_id", "strategy", "identity_key")');
  });

  test('cross-tenant linkage is rejected by trigger, not just application code', () => {
    expect(migration).toContain('enforce_knowledge_episode_event_links');
    expect(migration).toContain('Episode membership must reference an episode in the same tenant');
    expect(migration).toContain(
      'Episode event membership must reference a KnowledgeEvent in the same tenant',
    );
    expect(migration).toContain('enforce_knowledge_episode_assertion_links');
    expect(migration).toContain(
      'Episode assertion membership must reference a KnowledgeAssertion in the same tenant',
    );
    expect(migration).toContain('enforce_knowledge_episode_entity_links');
    expect(migration).toContain(
      'Episode entity membership cannot reference a canonical entity owned by another tenant',
    );
  });

  test('grouping can never widen scope: member event/assertion scope must exactly match the episode', () => {
    expect(migration).toContain(
      'Episode member KnowledgeEvent scope must exactly match the episode scope',
    );
    expect(migration).toContain(
      'Episode member KnowledgeAssertion scope must exactly match the episode scope',
    );
    expect(migration).toContain('v_event_sensitivity IS DISTINCT FROM v_episode_sensitivity');
    expect(migration).toContain('v_assertion_sensitivity IS DISTINCT FROM v_episode_sensitivity');
  });

  test('assertion membership origin_event_id must match the assertion own origin event', () => {
    expect(migration).toContain("origin_event_id must match the assertion''s own origin event");
    expect(migration).toContain('v_assertion_origin_event IS DISTINCT FROM NEW.origin_event_id');
  });

  test('queue claim due-index and lock-state checks exist for a bounded stale lease', () => {
    expect(migration).toContain('"knowledge_episode_projection_jobs_due_idx"');
    expect(migration).toContain(
      'CHECK (\n      ("status" = \'processing\' AND "locked_at" IS NOT NULL AND "locked_by" IS NOT NULL)',
    );
    expect(migration).toContain(
      'CHECK (\n      ("status" = \'succeeded\' AND "episode_id" IS NOT NULL)',
    );
  });

  test('enqueue trigger fires only on live Phase 4 success and performs no historical backfill or rollout filtering', () => {
    expect(migration).toContain('enqueue_knowledge_episode_projection_job');
    expect(migration).toContain('knowledge_mailbox_jobs_enqueue_episode_projection');
    expect(migration).toContain("NEW.status = 'succeeded'");
    expect(migration).toContain('NEW.result_event_id IS NOT NULL');
    expect(migration).not.toMatch(
      /INSERT\s+INTO\s+knowledge_episode_projection_jobs[\s\S]{0,300}\bSELECT\b/i,
    );
    expect(migration).toContain('No historical backfill is performed by this migration');
  });

  test('succeeded projection jobs remain purgeable without nulling their episode_id', () => {
    expect(migration).toContain(
      'FOREIGN KEY ("episode_id") REFERENCES "knowledge_episodes"("id")\n    ON DELETE CASCADE ON UPDATE CASCADE',
    );
    expect(migration).not.toContain(
      'FOREIGN KEY ("episode_id") REFERENCES "knowledge_episodes"("id")\n    ON DELETE SET NULL ON UPDATE CASCADE',
    );
  });

  test('projection job enqueue is idempotent under replay', () => {
    expect(migration).toContain('ON CONFLICT (tenant_id, event_id) DO NOTHING');
    expect(migration).toContain('"knowledge_episode_projection_jobs_event_unique"');
  });

  test('reuses Phase 5 canonical_entities and performs no new resolver table', () => {
    expect(migration).toContain('REFERENCES "canonical_entities"("id")');
    expect(migration).not.toMatch(/CREATE TABLE "canonical_entities"/);
  });
});
