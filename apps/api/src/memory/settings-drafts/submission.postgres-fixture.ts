import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { TenantContextStore } from '../../tenant/tenant-context.store.js';
import { MemoryAuthorizationService } from '../memory-authorization.service.js';
import { MemoryCandidateService } from '../memory-candidate.service.js';
import { MemoryCleanupOutboxService } from '../memory-cleanup-outbox.service.js';
import { MemoryTransitionAuditService } from '../memory-transition-audit.service.js';
import { SettingsMemoryVersionCandidateService } from '../settings-memory-version-candidate.service.js';
import { ImmutableMemoryVersionService } from '../immutable-memory-version.service.js';
import { MemorySettingsReviewReadinessService } from '../memory-settings-review-readiness.service.js';
import { MemoryReviewWorkflowService } from '../memory-review-workflow.service.js';
import { MemoryReviewInboxService } from '../memory-review-inbox.service.js';
import { MemoryCandidateReviewService } from '../memory-candidate-review.service.js';
import type { MemoryIngestService } from '../memory-ingest.service.js';
import { ownerRetentionDatabase } from '../memory-owner-retention.postgres-fixture.js';
import { SettingsMemoryDraftService } from './service.js';
import { SettingsMemorySubmissionService } from './submission.js';

export async function settingsSubmissionFixture(url: string) {
  const store = await ownerRetentionDatabase(
    url,
    async (db) => {
      // Canonical identity migration has a global users table; tenant membership
      // supplies the scope for the real reviewer-readiness join.
      await db.query('ALTER TABLE users DISABLE ROW LEVEL SECURITY');
    },
    ['memory_transition_audit', 'memory_cleanup_outbox', 'review_request'],
  );
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    // Prisma's @updatedAt has no SQL default in migrate diff; canonical
    // 20260625130000_institutional_memory supplies this default for raw writers.
    await db.query('ALTER TABLE memory_items ALTER COLUMN updated_at SET DEFAULT now()');
    for (const [table, migration] of [
      ['memory_settings_drafts', '20281029060000_settings_memory_drafts'],
      ['memory_settings_submissions', '20281029070000_settings_memory_submissions'],
    ]) {
      if (!(await db.query('SELECT to_regclass($1) AS present', [table])).rows[0].present)
        await db.query(
          readFileSync(
            join(__dirname, '../../../prisma/migrations', migration!, 'migration.sql'),
            'utf8',
          ),
        );
    }
  } finally {
    await db.end();
  }
  const prisma = {
    withTenantUser: <T>(tenantId: string, userId: string, work: (tx: any) => Promise<T>) =>
      store.scoped(tenantId, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_user',${userId},true)`;
        return work(tx);
      }),
    withTenant: <T>(tenantId: string, work: (tx: any) => Promise<T>) =>
      store.scoped(tenantId, work),
    withSystem: <T>(work: (tx: any) => Promise<T>) => store.scoped(null, work),
  } as PrismaService;
  // Projection provider is an external boundary; submission must never call it.
  let projected = 0;
  const ingest = {
    projectClioMemory: async () => {
      projected++;
    },
  } as unknown as MemoryIngestService;
  const authorization = new MemoryAuthorizationService(prisma),
    audit = new MemoryTransitionAuditService();
  const outbox = new MemoryCleanupOutboxService(prisma, ingest);
  const candidates = new MemoryCandidateService(
    prisma,
    ingest,
    { get: () => undefined } as any,
    audit,
    outbox,
    authorization,
  );
  const versions = new SettingsMemoryVersionCandidateService(prisma, authorization, audit);
  const immutable = new ImmutableMemoryVersionService(
    prisma,
    new TenantContextStore(),
    authorization,
    audit,
    outbox,
  );
  const readiness = new MemorySettingsReviewReadinessService(prisma, authorization);
  const workflow = new MemoryReviewWorkflowService(prisma, authorization);
  return {
    ...store,
    prisma,
    candidates,
    immutable,
    workflow,
    reviews: new MemoryCandidateReviewService(
      prisma,
      authorization,
      candidates,
      immutable,
      workflow,
    ),
    inbox: new MemoryReviewInboxService(prisma, authorization),
    projected: () => projected,
    drafts: new SettingsMemoryDraftService(prisma, authorization),
    submissions: new SettingsMemorySubmissionService(
      prisma,
      authorization,
      candidates,
      versions,
      readiness,
      workflow,
    ),
  };
}
