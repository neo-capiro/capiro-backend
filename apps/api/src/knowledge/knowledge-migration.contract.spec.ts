import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { KNOWLEDGE_ASSERTION_CLASSES } from './knowledge.types.js';

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
  repositoryPath(
    'prisma/migrations/20261120050000_knowledge_events_assertions/migration.sql',
  ),
  'utf8',
);

describe('Knowledge Plane migration contract', () => {
  test('creates immutable tenant-scoped event and assertion tables', () => {
    expect(migration).toContain('CREATE TABLE "knowledge_events"');
    expect(migration).toContain('CREATE TABLE "knowledge_assertions"');
    expect(migration).toContain('ALTER TABLE "knowledge_events" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE "knowledge_assertions" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE UPDATE, DELETE, TRUNCATE');
    expect(migration).toContain('reject_knowledge_plane_mutation');
  });

  test('enforces same-tenant active evidence and immutable assertion lineage', () => {
    expect(migration).toContain('enforce_knowledge_assertion_links');
    expect(migration).toContain('origin KnowledgeEvent must exist in the same tenant');
    expect(migration).toContain('origin KnowledgeEvent must be active');
    expect(migration).toContain(
      'KnowledgeAssertion must inherit evidence sensitivity and access scope',
    );
    expect(migration).toContain(
      'superseded KnowledgeAssertion must exist in the same tenant',
    );
    expect(migration).toContain(
      'contradicted KnowledgeAssertion must exist in the same tenant',
    );
    expect(migration).toContain('knowledge_assertions_supersedes_fkey');
    expect(migration).toContain('knowledge_assertions_contradicts_fkey');
  });

  test('encodes the bounded Phase 2 assertion classes', () => {
    for (const assertionClass of KNOWLEDGE_ASSERTION_CLASSES) {
      expect(migration).toContain(`'${assertionClass}'`);
    }
  });

  test('prevents model answers from becoming source evidence', () => {
    for (const sourceType of [
      'assistant_answer',
      'llm_output',
      'meri_answer',
      'model_answer',
      'model_output',
    ]) {
      expect(migration).toContain(`'${sourceType}'`);
    }
  });

  test('repositories repeat tenant predicates and expose no mutation methods', () => {
    for (const relativePath of [
      'src/knowledge/events/knowledge-event.repository.ts',
      'src/knowledge/assertions/knowledge-assertion.repository.ts',
    ]) {
      const source = readFileSync(repositoryPath(relativePath), 'utf8');
      expect(source).toContain('WHERE tenant_id = ${tenantId}::uuid');
      expect(source).not.toMatch(/\n\s+async\s+(update|delete)\s*\(/);
    }
  });
});
