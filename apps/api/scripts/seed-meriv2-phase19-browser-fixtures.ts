#!/usr/bin/env tsx
import { writeFile } from 'node:fs/promises';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { MemoryAuthorizationService } from '../src/memory/memory-authorization.service.js';
import { MemoryTransitionAuditService } from '../src/memory/memory-transition-audit.service.js';
import { ExactMemoryCleanupOutboxService } from '../src/memory/exact-memory-cleanup-outbox.service.js';
import { MemoryCandidateService } from '../src/memory/memory-candidate.service.js';
import { ImmutableMemoryVersionService } from '../src/memory/immutable-memory-version.service.js';
import type { MemoryIngestService } from '../src/memory/memory-ingest.service.js';
import type { TenantContextStore } from '../src/tenant/tenant-context.store.js';

const TENANT_ID = '19190000-0000-4000-8000-000000000001';
const PROPOSER_ID = '19190000-0000-4000-8000-000000000011';
const REVIEWER_ID = '19190000-0000-4000-8000-000000000012';
const CLIENT_REVIEWER_ID = '19190000-0000-4000-8000-000000000013';
const DENIED_ID = '19190000-0000-4000-8000-000000000014';
const CLIENT_ID = '19190000-0000-4000-8000-000000000021';
const PROJECTION_JOB_ID = '19190000-0000-4000-8000-000000000031';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function ctx(userId: string, role: TenantContext['role'], clerkUserId: string): TenantContext {
  return { tenantId: TENANT_ID, userId, role, clerkUserId };
}

async function main(): Promise<void> {
  process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
  process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';

  const clerkOrgId = required('PHASE19_CLERK_ORG_ID');
  const users = {
    proposer: {
      id: PROPOSER_ID,
      clerk: required('PHASE19_PROPOSER_CLERK_USER_ID'),
      email: required('PHASE19_PROPOSER_EMAIL'),
      role: 'user_admin' as const,
    },
    reviewer: {
      id: REVIEWER_ID,
      clerk: required('PHASE19_REVIEWER_CLERK_USER_ID'),
      email: required('PHASE19_REVIEWER_EMAIL'),
      role: 'user_admin' as const,
    },
    clientReviewer: {
      id: CLIENT_REVIEWER_ID,
      clerk: required('PHASE19_CLIENT_REVIEWER_CLERK_USER_ID'),
      email: required('PHASE19_CLIENT_REVIEWER_EMAIL'),
      role: 'standard_user' as const,
    },
    denied: {
      id: DENIED_ID,
      clerk: required('PHASE19_DENIED_CLERK_USER_ID'),
      email: required('PHASE19_DENIED_EMAIL'),
      role: 'standard_user' as const,
    },
  };

  const prisma = new PrismaService();
  await prisma.$connect();
  const authorization = new MemoryAuthorizationService(prisma);
  const transitions = new MemoryTransitionAuditService();
  const ingest = {
    projectClioMemory: async () => undefined,
    projectClioMemoryStrict: async () => undefined,
  } as unknown as MemoryIngestService;
  const outbox = new ExactMemoryCleanupOutboxService(prisma, ingest);
  const config = { get: () => undefined } as unknown as ConfigService<Record<string, unknown>, true>;
  const candidates = new MemoryCandidateService(
    prisma,
    ingest,
    config as never,
    transitions,
    outbox,
    authorization,
  );
  (candidates as unknown as { dispatchProjectionFastPath: () => void }).dispatchProjectionFastPath =
    () => undefined;

  let activeCtx = ctx(REVIEWER_ID, 'user_admin', users.reviewer.clerk);
  const tenantCtx = { require: () => activeCtx } as TenantContextStore;
  const versions = new ImmutableMemoryVersionService(
    prisma,
    tenantCtx,
    authorization,
    transitions,
    outbox,
  );
  (versions as unknown as { embedAfterCommit: () => void }).embedAfterCommit = () => undefined;

  try {
    await prisma.withSystem(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = '${TENANT_ID}'::uuid`);
      await tx.$executeRawUnsafe(
        `DELETE FROM users WHERE id IN ('${PROPOSER_ID}'::uuid,'${REVIEWER_ID}'::uuid,'${CLIENT_REVIEWER_ID}'::uuid,'${DENIED_ID}'::uuid)`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO users (id, clerk_user_id, email)
         VALUES
           ($1::uuid,$2,$3::citext),
           ($4::uuid,$5,$6::citext),
           ($7::uuid,$8,$9::citext),
           ($10::uuid,$11,$12::citext)`,
        users.proposer.id,
        users.proposer.clerk,
        users.proposer.email,
        users.reviewer.id,
        users.reviewer.clerk,
        users.reviewer.email,
        users.clientReviewer.id,
        users.clientReviewer.clerk,
        users.clientReviewer.email,
        users.denied.id,
        users.denied.clerk,
        users.denied.email,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO tenants
           (id, slug, name, status, clerk_org_id, billing_status, settings_jsonb)
         VALUES
           ($1::uuid,'phase19-browser','Phase 19 Browser Acceptance','active',$2,'comped',
            '{"clioFeatureFlags":{"meriv2.contextPacketV2":true,"meriv2.contextPacketV2.chat":true,"meriv2.contextPacketV2.in-editor":true}}'::jsonb)`,
        TENANT_ID,
        clerkOrgId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO tenant_memberships (tenant_id,user_id,role,status)
         VALUES
           ($1::uuid,$2::uuid,'user_admin','active'),
           ($1::uuid,$3::uuid,'user_admin','active'),
           ($1::uuid,$4::uuid,'standard_user','active'),
           ($1::uuid,$5::uuid,'standard_user','active')`,
        TENANT_ID,
        PROPOSER_ID,
        REVIEWER_ID,
        CLIENT_REVIEWER_ID,
        DENIED_ID,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO clients (id,tenant_id,name,status,memory_wall)
         VALUES ($1::uuid,$2::uuid,'Phase 19 Walled Client','active',true)`,
        CLIENT_ID,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO client_memory_access (tenant_id,client_id,user_id,granted_by)
         VALUES
           ($1::uuid,$2::uuid,$3::uuid,$4::uuid),
           ($1::uuid,$2::uuid,$4::uuid,$3::uuid)`,
        TENANT_ID,
        CLIENT_ID,
        CLIENT_REVIEWER_ID,
        REVIEWER_ID,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO memory_access_grant
          (tenant_id,client_id,user_id,permissions,status,granted_by_user_id,reason,expires_at)
         VALUES
          ($1::uuid,$2::uuid,$3::uuid,
           ARRAY['propose','review','approve','edit','confirm','mark_stale','revoke','resolve_conflict'],
           'active',$4::uuid,'Phase 19 dedicated client reviewer',now() + interval '2 days'),
          ($1::uuid,$2::uuid,$4::uuid,
           ARRAY['propose','review','approve','edit','confirm','mark_stale','revoke','resolve_conflict'],
           'active',$3::uuid,'Phase 19 administrator client access',now() + interval '2 days')`,
        TENANT_ID,
        CLIENT_ID,
        CLIENT_REVIEWER_ID,
        REVIEWER_ID,
      );
    });

    const proposerCtx = ctx(PROPOSER_ID, 'user_admin', users.proposer.clerk);
    const reviewerCtx = ctx(REVIEWER_ID, 'user_admin', users.reviewer.clerk);
    const clientReviewerCtx = ctx(
      CLIENT_REVIEWER_ID,
      'standard_user',
      users.clientReviewer.clerk,
    );

    async function approvedFirm(
      suffix: string,
      input: { type?: string; slug?: string; title?: string; body?: string } = {},
    ) {
      const title = input.title ?? `Phase 19 ${suffix}`;
      const body = input.body ?? `${title} body`;
      const proposal = await candidates.proposeSaveMemory(
        TENANT_ID,
        PROPOSER_ID,
        {
          scope: 'firm',
          ownerUserId: null,
          key: `phase19:${suffix}`,
          value: body,
          source: 'phase19_browser_fixture',
          canonicalItem: {
            type: (input.type ?? 'playbook') as never,
            slug: input.slug ?? `phase19-${suffix}`,
            title,
            sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body }],
          },
        },
        true,
        'phase19_browser_fixture',
      );
      await candidates.approve(TENANT_ID, proposal.candidateId, REVIEWER_ID, reviewerCtx);
      const row = await prisma.withSystem((tx) =>
        tx.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT committed_memory_item_id::text AS id FROM memory_candidate WHERE id=$1::uuid',
          proposal.candidateId,
        ),
      );
      if (!row[0]?.id) throw new Error(`approved fixture ${suffix} did not create an item`);
      return { candidateId: proposal.candidateId, itemId: row[0].id, title, body };
    }

    const firm = await approvedFirm('firm-soul', {
      type: 'firm-soul',
      slug: 'firm',
      title: 'Phase 19 Firm Soul',
      body: 'Phase 19 baseline firm identity.',
    });
    const correctionBase = await approvedFirm('correction-base');
    const revokeRestore = await approvedFirm('revoke-restore');
    const legalHold = await approvedFirm('legal-hold');
    await prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        'UPDATE memory_items SET legal_hold=true WHERE id=$1::uuid',
        legalHold.itemId,
      ),
    );

    const conflictProposal = await versions.proposeContradiction(
      proposerCtx,
      correctionBase.itemId,
      'Phase 19 contradictory memory awaiting conflict resolution.',
    );
    if (conflictProposal.status !== 'pending_review') throw new Error('conflict proposal not pending');
    const conflict = await versions.approveCandidate(reviewerCtx, conflictProposal.candidateId);
    if (conflict.outcome !== 'conflict' || !conflict.memoryItemId || !conflict.conflictGroupId) {
      throw new Error('conflict fixture was not created');
    }

    const approvedClientProposal = await candidates.proposeSaveMemory(
      TENANT_ID,
      PROPOSER_ID,
      {
        scope: 'client',
        ownerUserId: null,
        clientId: CLIENT_ID,
        key: 'phase19:approved-client',
        value: 'Phase 19 confidential approved client memory.',
        source: 'phase19_browser_fixture',
        canonicalItem: {
          type: 'client-soul',
          slug: CLIENT_ID,
          title: 'Phase 19 Confidential Client Memory',
          sections: [
            {
              key: 'position',
              heading: 'Position',
              owner: 'human',
              body: 'Phase 19 confidential approved client memory.',
            },
          ],
        },
      },
      true,
      'phase19_browser_fixture',
    );
    await candidates.approve(
      TENANT_ID,
      approvedClientProposal.candidateId,
      CLIENT_REVIEWER_ID,
      clientReviewerCtx,
    );
    const approvedClientRows = await prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT committed_memory_item_id::text AS id FROM memory_candidate WHERE id=$1::uuid',
        approvedClientProposal.candidateId,
      ),
    );
    const approvedClientItemId = approvedClientRows[0]?.id;
    if (!approvedClientItemId) throw new Error('approved client fixture missing item');

    const pendingClient = await candidates.proposeSaveMemory(
      TENANT_ID,
      PROPOSER_ID,
      {
        scope: 'client',
        ownerUserId: null,
        clientId: CLIENT_ID,
        key: 'phase19:client-review',
        value: 'Phase 19 client reviewer candidate marker.',
        source: 'phase19_browser_fixture',
        canonicalItem: {
          type: 'client-compass',
          slug: 'phase19-client-review',
          title: 'Phase 19 Client Reviewer Candidate',
          sections: [
            {
              key: 'priority',
              heading: 'Priority',
              owner: 'human',
              body: 'Phase 19 client reviewer candidate marker.',
            },
          ],
        },
      },
      true,
      'phase19_browser_fixture',
    );

    const rejectCandidate = await candidates.proposeSaveMemory(
      TENANT_ID,
      PROPOSER_ID,
      {
        scope: 'firm',
        ownerUserId: null,
        key: 'phase19:reject',
        value: 'Phase 19 reviewer rejection marker.',
        source: 'phase19_browser_fixture',
      },
      true,
      'phase19_browser_fixture',
    );
    const withdrawCandidate = await candidates.proposeSaveMemory(
      TENANT_ID,
      PROPOSER_ID,
      {
        scope: 'firm',
        ownerUserId: null,
        key: 'phase19:withdraw',
        value: 'Phase 19 proposer withdrawal marker.',
        source: 'phase19_browser_fixture',
      },
      true,
      'phase19_browser_fixture',
    );

    await prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO memory_cleanup_outbox
          (id,tenant_id,memory_item_id,operation,idempotency_key,status,attempts,next_attempt_at,last_error)
         VALUES
          ($1::uuid,$2::uuid,$3::uuid,'revoke_projections',$4,'failed',2,now()-interval '1 minute','phase19_fixture_failure')`,
        PROJECTION_JOB_ID,
        TENANT_ID,
        revokeRestore.itemId,
        `phase19:projection:${PROJECTION_JOB_ID}`,
      ),
    );

    const fixtures = {
      marker: 'MERIV2_PHASE19_FIXTURES_READY',
      tenant: { id: TENANT_ID, slug: 'phase19-browser', clerkOrgId },
      users: {
        proposer: { localUserId: PROPOSER_ID, ...users.proposer },
        reviewer: { localUserId: REVIEWER_ID, ...users.reviewer },
        clientReviewer: { localUserId: CLIENT_REVIEWER_ID, ...users.clientReviewer },
        denied: { localUserId: DENIED_ID, ...users.denied },
      },
      client: { id: CLIENT_ID, name: 'Phase 19 Walled Client' },
      items: {
        firm,
        correctionBase,
        revokeRestore,
        legalHold,
        conflictAnchor: correctionBase.itemId,
        conflictOther: conflict.memoryItemId,
        conflictGroupId: conflict.conflictGroupId,
        approvedClientItemId,
      },
      candidates: {
        pendingClient: pendingClient.candidateId,
        reject: rejectCandidate.candidateId,
        withdraw: withdrawCandidate.candidateId,
      },
      projectionJobId: PROJECTION_JOB_ID,
    };

    const output = process.env.PHASE19_FIXTURE_FILE ?? '/tmp/meriv2-phase19-fixtures.json';
    await writeFile(output, `${JSON.stringify(fixtures, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(fixtures)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      marker: 'MERIV2_PHASE19_FIXTURES_FAILED',
      error: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
    }),
  );
  process.exitCode = 1;
});
