import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ownerRetentionDatabase } from './memory-owner-retention.postgres-fixture.js';

export async function conversationMemoryRetentionFixture(
  url: string,
  additionalTables: string[] = [],
) {
  const store = await ownerRetentionDatabase(url, undefined, [
    ...new Set(['clio_conversations', 'review_request', ...additionalTables]),
  ]);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    // Match the canonical identity schema, where users is global and the
    // tenant-membership join supplies the actor scope (as in Settings fixtures).
    await db.query('ALTER TABLE users DISABLE ROW LEVEL SECURITY');
    await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    // Isolated fixture models the required content-free receipt disposition.
    // This is not a migration or a disposition of an existing deployed payload.
    if (
      !(await db.query("SELECT to_regclass('public.clio_meri_memory_submissions') ready")).rows[0]
        .ready
    )
      await db.query(`CREATE TABLE clio_meri_memory_submissions(tenant_id uuid NOT NULL,candidate_id uuid NOT NULL,
        candidate_sha256 char(64) NOT NULL,proposer_user_id uuid NOT NULL,review_id uuid NOT NULL,
        created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(tenant_id,candidate_id));
        ALTER TABLE clio_meri_memory_submissions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE clio_meri_memory_submissions FORCE ROW LEVEL SECURITY;
        CREATE POLICY scope ON clio_meri_memory_submissions USING(rls_bypass() OR tenant_id=current_tenant_id());
        GRANT SELECT,INSERT ON clio_meri_memory_submissions TO capiro_app`);
    for (const [ready, migration] of [
      [
        "to_regclass('public.clio_conversation_bootstrap_receipts')",
        '20281016020000_clio_conversation_bootstrap_receipts',
      ],
      [
        "to_regprocedure('protect_meri_bootstrap_binding()')",
        '20281023010000_meri_general_conversation_binding',
      ],
      [
        "to_regclass('public.clio_conversation_management_receipts')",
        '20281024020000_meri_conversation_management',
      ],
      ["to_regclass('public.meri_office_drafts')", '20281029020000_office_draft_owner'],
      [
        "(SELECT 1 FROM information_schema.columns WHERE table_name='meri_office_drafts' AND column_name='editor_epoch')",
        '20281029070000_office_editor_admission',
      ],
      [
        "to_regprocedure('memory_review_workflow_metadata(text,text,boolean)')",
        '20260818010000_memory_phase2_review_workflow_foundation',
      ],
      [
        "to_regclass('public.memory_review_notification_outbox')",
        '20260818040000_memory_phase2_notification_outbox',
      ],
      [
        "to_regclass('public.memory_review_in_app_notification')",
        '20260818040200_memory_phase2_notification_dispatcher',
      ],
      [
        "to_regprocedure('memory_candidate_guard_conversation()')",
        '20281029110000_memory_conversation_retention',
      ],
      [
        "to_regprocedure('meri_management_deletion_reference_v1(jsonb,uuid,uuid)')",
        '20281029130000_conversation_deletion_readback',
      ],
    ]) {
      if (!(await db.query(`SELECT ${ready} AS ready`)).rows[0].ready)
        await db.query(
          readFileSync(
            join(__dirname, '../../prisma/migrations', migration!, 'migration.sql'),
            'utf8',
          ),
        );
    }
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON memory_review_notification_outbox,
      memory_review_in_app_notification TO capiro_app`);
  } finally {
    await db.end();
  }
  const prisma = {
    withTenant: <T>(tenantId: string, work: (tx: any) => Promise<T>) =>
      store.scoped(tenantId, work),
    withTenantUser: <T>(
      tenantId: string,
      actorId: string,
      work: (tx: Prisma.TransactionClient) => Promise<T>,
    ) =>
      store.scoped(tenantId, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_user',${actorId},true)`;
        return work(tx);
      }),
    withSystem: <T>(work: (tx: any) => Promise<T>) => store.scoped(null, work),
  } as PrismaService;
  return { ...store, prisma };
}
