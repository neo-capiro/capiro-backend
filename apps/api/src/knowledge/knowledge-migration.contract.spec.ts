import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import {
  DISALLOWED_KNOWLEDGE_FACTUAL_SOURCE_TYPES,
  KNOWLEDGE_ASSERTION_CLASSES,
} from './knowledge.types.js';

function repositoryPath(relativePath: string): string {
  const candidates = [
    join(process.cwd(), relativePath),
    join(process.cwd(), 'apps/api', relativePath),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Could not resolve repository path: ${relativePath}`);
  return found;
}

const phase12Migration = readFileSync(
  repositoryPath(
    'prisma/migrations/20261120050000_knowledge_events_assertions/migration.sql',
  ),
  'utf8',
);
const phase3Migration = readFileSync(
  repositoryPath('prisma/migrations/20261120060000_knowledge_evidence/migration.sql'),
  'utf8',
);

describe('Knowledge Plane migration contract', () => {
  test('creates immutable tenant-scoped event, assertion, and evidence tables', () => {
    expect(phase12Migration).toContain('CREATE TABLE "knowledge_events"');
    expect(phase12Migration).toContain('CREATE TABLE "knowledge_assertions"');
    expect(phase3Migration).toContain('CREATE TABLE "knowledge_evidence"');
    expect(phase12Migration).toContain(
      'ALTER TABLE "knowledge_events" FORCE ROW LEVEL SECURITY',
    );
    expect(phase12Migration).toContain(
      'ALTER TABLE "knowledge_assertions" FORCE ROW LEVEL SECURITY',
    );
    expect(phase3Migration).toContain(
      'ALTER TABLE "knowledge_evidence" FORCE ROW LEVEL SECURITY',
    );
    expect(phase3Migration).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "knowledge_evidence"',
    );
    expect(phase3Migration).toContain('knowledge_evidence_reject_mutation');
  });

  test('enforces same-tenant active evidence and immutable assertion lineage', () => {
    expect(phase12Migration).toContain('enforce_knowledge_assertion_links');
    expect(phase12Migration).toContain('origin KnowledgeEvent must exist in the same tenant');
    expect(phase12Migration).toContain('origin KnowledgeEvent must be active');
    expect(phase12Migration).toContain(
      'KnowledgeAssertion must inherit evidence sensitivity and access scope',
    );
    expect(phase12Migration).toContain(
      'superseded KnowledgeAssertion must exist in the same tenant',
    );
    expect(phase12Migration).toContain(
      'contradicted KnowledgeAssertion must exist in the same tenant',
    );
    expect(phase12Migration).toContain('knowledge_assertions_supersedes_fkey');
    expect(phase12Migration).toContain('knowledge_assertions_contradicts_fkey');
  });

  test('requires exact-source evidence before a new assertion transaction commits', () => {
    expect(phase3Migration).toContain('enforce_knowledge_evidence_links');
    expect(phase3Migration).toContain(
      'KnowledgeEvidence assertion must exist in the same tenant',
    );
    expect(phase3Migration).toContain(
      'KnowledgeEvidence event must exist in the same tenant',
    );
    expect(phase3Migration).toContain(
      'KnowledgeEvidence source identity must match its KnowledgeEvent',
    );
    expect(phase3Migration).toContain(
      'KnowledgeEvidence content hash must match its KnowledgeEvent source version',
    );
    expect(phase3Migration).toContain(
      'KnowledgeEvidence cannot widen assertion sensitivity or access scope',
    );
    expect(phase3Migration).toContain('CREATE CONSTRAINT TRIGGER');
    expect(phase3Migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(phase3Migration).toContain(
      'KnowledgeAssertion requires at least one immutable KnowledgeEvidence row from its origin event',
    );
  });

  test('encodes the bounded Phase 2 assertion classes', () => {
    for (const assertionClass of KNOWLEDGE_ASSERTION_CLASSES) {
      expect(phase12Migration).toContain(`'${assertionClass}'`);
    }
  });

  test('prevents model answers from becoming source evidence at both layers', () => {
    for (const sourceType of DISALLOWED_KNOWLEDGE_FACTUAL_SOURCE_TYPES) {
      expect(phase12Migration).toContain(`'${sourceType}'`);
      expect(phase3Migration).toContain(`'${sourceType}'`);
    }
  });

  test('repositories repeat tenant predicates and expose no mutation methods', () => {
    for (const relativePath of [
      'src/knowledge/events/knowledge-event.repository.ts',
      'src/knowledge/assertions/knowledge-assertion.repository.ts',
      'src/knowledge/evidence/knowledge-evidence.repository.ts',
    ]) {
      const source = readFileSync(repositoryPath(relativePath), 'utf8');
      expect(source).toContain('WHERE tenant_id = ${tenantId}::uuid');
      expect(source).not.toMatch(/\n\s+async\s+(update|delete)\s*\(/);
    }
  });

  test('assertion writes and evidence writes share one transaction', () => {
    const assertionRepository = readFileSync(
      repositoryPath('src/knowledge/assertions/knowledge-assertion.repository.ts'),
      'utf8',
    );
    const evidenceRepository = readFileSync(
      repositoryPath('src/knowledge/evidence/knowledge-evidence.repository.ts'),
      'utf8',
    );

    expect(assertionRepository).toContain('appendWithEvidence');
    expect(assertionRepository).toContain('appendManyInTransaction');
    expect(assertionRepository).toContain('FROM knowledge_evidence');
    expect(evidenceRepository).toContain('tx: Prisma.TransactionClient');
  });

  test('validator binds exact excerpts to canonical source text and source hash', () => {
    const validator = readFileSync(
      repositoryPath('src/knowledge/evidence/knowledge-evidence-validator.service.ts'),
      'utf8',
    );
    expect(validator).toContain('sha256Text(input.sourceText)');
    expect(validator).toContain('sourceText.slice(input.startOffset, input.endOffset)');
    expect(validator).toContain('exactExcerpt !== input.excerpt');
  });

  test('rehearses deferred provenance, tenant isolation, and immutability in PostgreSQL', () => {
    const rehearsal = readFileSync(
      repositoryPath('../../scripts/verify-knowledge-plane-migrations.sh'),
      'utf8',
    );
    expect(rehearsal).toContain('evidence-less assertion unexpectedly committed');
    expect(rehearsal).toContain('cross-tenant evidence unexpectedly committed');
    expect(rehearsal).toContain('immutable evidence unexpectedly updated');
    expect(rehearsal).toContain('SET ROLE capiro_app');
  });

});
