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
  repositoryPath(
    'prisma/migrations/20261120070000_mailbox_knowledge_ingestion/migration.sql',
  ),
  'utf8',
);
const repository = readFileSync(
  repositoryPath('src/knowledge/mailbox/mailbox-knowledge.repository.ts'),
  'utf8',
);
const consumer = readFileSync(
  repositoryPath('src/knowledge/mailbox/mailbox-knowledge.consumer.ts'),
  'utf8',
);

describe('Phase 4 mailbox knowledge architecture contract', () => {
  test('creates a tenant-scoped durable outbox and incremental mail trigger', () => {
    expect(migration).toContain('CREATE TABLE "knowledge_mailbox_jobs"');
    expect(migration).toContain('CREATE TRIGGER "mail_messages_enqueue_knowledge"');
    expect(migration).toContain('AFTER INSERT OR UPDATE OF');
    expect(migration).toContain('ON CONFLICT ("tenant_id", "mail_message_id", "source_revision") DO NOTHING');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('enforce_knowledge_mailbox_job_links');
    expect(migration).toContain('KnowledgeMailboxJob message must exist in the same tenant');
    expect(migration).toContain('KnowledgeMailboxJob result event must exist in the same tenant');
    expect(migration).toContain('knowledge_mailbox_jobs_lock_state_check');
    expect(migration).toContain('knowledge_mailbox_jobs_result_state_check');
    expect(migration).toContain('mailbox_knowledge_source_revision');
    expect(migration).not.toMatch(/INSERT INTO\s+"knowledge_mailbox_jobs"[\s\S]+SELECT[\s\S]+FROM\s+"mail_messages"/i);
  });

  test('incremental-only outbox gate refuses backfill and non-full bodies', () => {
    const gate = readFileSync(
      repositoryPath(
        'prisma/migrations/20261120090000_mailbox_knowledge_incremental_only/migration.sql',
      ),
      'utf8',
    );
    expect(gate).toContain("metadata_jsonb ->> 'mailboxSyncMode'");
    expect(gate).toContain("IS DISTINCT FROM 'incremental'");
    expect(gate).toContain("metadata_jsonb ->> 'bodyCompleteness'");
    expect(gate).toContain("IS DISTINCT FROM 'full'");
    expect(gate).toContain('"metadata_jsonb"');
    expect(gate).not.toMatch(/received_at\s*[<>]=|sent_at\s*[<>]=|interval\s+'/i);
  });

  test('drops knowledge_assertions_created_by_fkey while keeping created_by', () => {
    const dropFkey = readFileSync(
      repositoryPath(
        'prisma/migrations/20261120080000_drop_knowledge_assertions_created_by_fkey/migration.sql',
      ),
      'utf8',
    );
    expect(dropFkey).toContain('DROP CONSTRAINT IF EXISTS "knowledge_assertions_created_by_fkey"');
    expect(dropFkey).not.toMatch(/DROP COLUMN\s+"created_by"/i);
    expect(dropFkey).toMatch(/COMMENT ON COLUMN "knowledge_assertions"."created_by"/);
  });

  test('keeps provider sync asynchronous and claims work safely across workers', () => {
    expect(repository).toContain('FOR UPDATE SKIP LOCKED');
    expect(repository).toContain("status = 'processing'");
    expect(repository).toContain("locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'");
    expect(repository).toContain('WHERE message.tenant_id = ${tenantId}::uuid');
    expect(repository).toContain('WHERE tenant_id = ${job.tenantId}::uuid');
    expect(consumer).toContain('message.currentSourceRevision !== job.sourceRevision');
    expect(consumer).toContain('mailbox owner is unavailable');
    expect(consumer).toContain('this.events.append');
    expect(consumer).not.toMatch(/anthropic|openai|bedrock|nvidia/i);
  });

  test('uses SHA-256 event proof rather than the operational outbox revision', () => {
    expect(migration).toMatch(/md5 is used only as an outbox revision identity/i);
    expect(migration).toContain('processed_content_hash');
    expect(consumer).toContain('normalized.authoritativeContentHash');
    expect(consumer).toContain('sourceContentHash: normalized.authoritativeContentHash');
  });

  test('gates rollout behind both required Phase 0 flags', () => {
    const flags = readFileSync(
      repositoryPath('src/knowledge/mailbox/mailbox-knowledge-flags.service.ts'),
      'utf8',
    );
    expect(flags).toContain("readBooleanFlag('KNOWLEDGE_PLANE_ENABLED')");
    expect(flags).toContain("readBooleanFlag('MAILBOX_KNOWLEDGE_INGEST_ENABLED')");
  });
});
