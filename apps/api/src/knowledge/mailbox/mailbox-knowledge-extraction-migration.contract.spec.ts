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
  repositoryPath('prisma/migrations/20261120150000_mailbox_knowledge_extraction/migration.sql'),
  'utf8',
);
const consumer = readFileSync(
  repositoryPath('src/knowledge/mailbox/mailbox-knowledge-extraction.consumer.ts'),
  'utf8',
);
const extractor = readFileSync(
  repositoryPath('src/knowledge/mailbox/mailbox-knowledge-extractor.service.ts'),
  'utf8',
);
const phase4Consumer = readFileSync(
  repositoryPath('src/knowledge/mailbox/mailbox-knowledge.consumer.ts'),
  'utf8',
);
const drain = readFileSync(repositoryPath('scripts/drain-mailbox-knowledge.ts'), 'utf8');
const extractionRepository = readFileSync(
  repositoryPath('src/knowledge/mailbox/mailbox-knowledge-extraction.repository.ts'),
  'utf8',
);

describe('Knowledge Plane Phase 6 mailbox extraction architecture', () => {
  test('queues extraction only after a successful Phase 4 KnowledgeEvent and does no historical backfill', () => {
    expect(migration).toContain('CREATE TABLE "knowledge_mailbox_extraction_jobs"');
    expect(migration).toContain('knowledge_mailbox_jobs_enqueue_extraction');
    expect(migration).toContain("NEW.status = 'succeeded'");
    expect(migration).toContain('NEW.result_event_id IS NOT NULL');
    expect(migration).toContain('NEW.processed_content_hash IS NOT NULL');
    expect(migration).not.toMatch(
      /INSERT\s+INTO\s+knowledge_mailbox_extraction_jobs[\s\S]{0,300}\bSELECT\b/i,
    );
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
  });

  test('does not put model extraction back inside the deterministic Phase 4 consumer', () => {
    expect(phase4Consumer).not.toMatch(
      /MailboxKnowledgeExtractorService|resolveAcrossSources|llm\.complete/,
    );
    expect(phase4Consumer).toContain('Phase 5/6 consume the event handoff');
    expect(consumer).toContain('MailboxKnowledgeExtractorService');
    expect(consumer).toContain('UniversalEntityResolutionOrchestratorService');
    expect(consumer).toContain('KnowledgeAssertionService');
  });

  test('keeps the model out of identity authority and requires exact evidence before assertion', () => {
    expect(extractor).toContain('Never invent or output a canonical ID');
    expect(consumer).toContain('allowAuthoritativePublicRegistration: false');
    expect(consumer).toContain("subjectType: 'canonical_entity'");
    expect(consumer).toContain('sourceText: input.normalized.authoritativeText');
    expect(consumer).toContain("disposition: 'held_invalid_evidence'");
    expect(consumer).toContain("'held_subject_ambiguous'");
  });

  test('reuses the established out-of-band worker verb and stays independently feature-gated', () => {
    expect(drain).toContain('MailboxKnowledgeConsumer');
    expect(drain).toContain('MailboxKnowledgeExtractionConsumer');
    expect(drain).toContain('mailbox_knowledge_extraction_worker.drain');
    expect(extractor).not.toMatch(/setInterval|OnModuleInit/);
    expect(consumer).not.toMatch(/setInterval|OnModuleInit/);
  });

  test('claims with a bounded stale lease and transitions with tenant plus job predicates', () => {
    expect(extractionRepository).toContain('FOR UPDATE SKIP LOCKED');
    expect(extractionRepository).toContain("locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'");
    expect(extractionRepository).toContain('attempt_count < 100');
    expect(extractionRepository).toContain(
      "CASE WHEN status IN ('pending', 'failed') THEN 0 ELSE 1 END",
    );
    expect(extractionRepository).toContain(
      "WHEN jobs.status = 'processing' THEN CURRENT_TIMESTAMP",
    );
    expect(extractionRepository).toContain('WHERE tenant_id = ${job.tenantId}::uuid');
    expect(extractionRepository).toContain("AND status = 'processing'");
    expect(extractionRepository).toContain('AND locked_by = ${job.lockedBy}');
    expect(extractionRepository).toContain('AND attempt_count = ${job.attemptCount}');
    expect(extractionRepository).toContain('async withClaimLease<T>(');
    expect(extractionRepository).toContain('FOR UPDATE');
    expect(extractionRepository).toContain("last_error = 'MaxAttemptsExceeded'");
  });

  test('does not persist mailbox bodies in operational error state', () => {
    expect(extractionRepository).toContain(
      "return error instanceof Error ? error.name : 'UnknownError'",
    );
    expect(extractionRepository).not.toContain('error.message`');
  });
});
