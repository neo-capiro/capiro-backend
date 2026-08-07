import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { MemoryAuthorizationService } from '../src/memory/memory-authorization.service.js';

const authorization = new MemoryAuthorizationService({} as PrismaService);

async function main(): Promise<void> {
  const urls = [
    requireDisposableUrl('MEMORY_PHASE2_CLEAN_DATABASE_URL'),
    requireDisposableUrl('MEMORY_PHASE2_UPGRADE_DATABASE_URL'),
  ];
  for (const [index, databaseUrl] of urls.entries()) {
    await assertDatabasePolicy(databaseUrl, index === 0 ? 'clean' : 'upgrade');
  }
  process.stdout.write('MEMORY_ADMIN_SELF_APPROVAL_DATABASE_ACCEPTANCE_COMPLETE\n');
}

async function assertDatabasePolicy(databaseUrl: string, label: string): Promise<void> {
  const prisma = client(databaseUrl);
  const tenantId = randomUUID();
  const adminId = randomUUID();
  const standardId = randomUUID();
  const adminCandidateId = randomUUID();
  const otherAdminCandidateId = randomUUID();
  const standardCandidateId = randomUUID();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, status)
         VALUES ($1::uuid, $2, $3, 'active'::tenant_status)`,
        tenantId,
        `memory-admin-self-${label}-${tenantId.slice(0, 8)}`,
        `Memory Admin Self Approval ${label}`,
      );
      for (const [userId, role, prefix] of [
        [adminId, 'user_admin', 'admin'],
        [standardId, 'standard_user', 'standard'],
      ] as const) {
        await tx.$executeRawUnsafe(
          `INSERT INTO users (id, clerk_user_id, email)
           VALUES ($1::uuid, $2, $3::citext)`,
          userId,
          `clerk-${label}-${userId}`,
          `${prefix}-${label}-${userId}@example.test`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO tenant_memberships (
             tenant_id, user_id, role, status, joined_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::tenant_role,
             'active'::membership_status, now()
           )`,
          tenantId,
          userId,
          role,
        );
      }
    });

    for (const [candidateId, key] of [
      [adminCandidateId, `admin-self-${label}`],
      [otherAdminCandidateId, `admin-other-${label}`],
    ] as const) {
      await createCandidate(prisma, {
        tenantId,
        proposerId: adminId,
        candidateId,
        key,
      });
      await assignReviewer(prisma, tenantId, candidateId, adminId);
    }

    let rawAdminDenied = false;
    try {
      await prisma.$transaction(async (tx) => {
        await setContext(tx, tenantId, adminId);
        await updateCandidateApproved(tx, tenantId, adminId, adminCandidateId);
      });
    } catch (error) {
      rawAdminDenied = String(error).includes('MEMORY_REVIEW_SELF_DECISION_DENIED');
    }
    if (!rawAdminDenied) {
      throw new Error(`${label}: raw admin self-approval bypassed canonical authorization.`);
    }

    let crossCandidateDenied = false;
    try {
      await prisma.$transaction(async (tx) => {
        await setContext(tx, tenantId, adminId);
        await authorizeAdminDecision(tx, tenantId, adminId, adminCandidateId);
        await updateCandidateApproved(tx, tenantId, adminId, otherAdminCandidateId);
      });
    } catch (error) {
      crossCandidateDenied = String(error).includes('MEMORY_REVIEW_SELF_DECISION_DENIED');
    }
    if (!crossCandidateDenied) {
      throw new Error(`${label}: one candidate authorization enabled a different candidate.`);
    }

    const approved = await prisma.$transaction(async (tx) => {
      await setContext(tx, tenantId, adminId);
      await authorizeAdminDecision(tx, tenantId, adminId, adminCandidateId);
      return updateCandidateApproved(tx, tenantId, adminId, adminCandidateId);
    });
    if (approved !== 1) {
      throw new Error(`${label}: active administrator could not approve their own proposal.`);
    }

    const adminWorkflow = await prisma.$queryRawUnsafe<
      Array<{ status: string; decided_by: string | null }>
    >(
      `SELECT status, decided_by::text
       FROM review_request
       WHERE tenant_id = $1::uuid
         AND surface = 'memory'
         AND subject_id = $2`,
      tenantId,
      adminCandidateId,
    );
    if (
      adminWorkflow[0]?.status !== 'approved' ||
      adminWorkflow[0]?.decided_by !== adminId
    ) {
      throw new Error(`${label}: admin self-approval did not synchronize workflow evidence.`);
    }

    await createCandidate(prisma, {
      tenantId,
      proposerId: standardId,
      candidateId: standardCandidateId,
      key: `standard-self-${label}`,
    });
    await assignReviewer(prisma, tenantId, standardCandidateId, standardId);

    let denied = false;
    try {
      await prisma.$transaction(async (tx) => {
        await setContext(tx, tenantId, standardId);
        await setAdminCapability(tx, standardCandidateId, standardId);
        await updateCandidateApproved(tx, tenantId, standardId, standardCandidateId);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      denied = message.includes('MEMORY_REVIEW_SELF_DECISION_DENIED');
    }
    if (!denied) {
      throw new Error(`${label}: standard-user self-approval was not denied.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function authorizeAdminDecision(
  tx: Prisma.TransactionClient,
  tenantId: string,
  adminId: string,
  candidateId: string,
): Promise<void> {
  const subject = await authorization.loadCandidateInTx(tx, tenantId, candidateId);
  if (!subject) throw new Error('Acceptance candidate disappeared before authorization.');
  if (subject.legacyCandidateStatus !== 'pending') {
    throw new Error(
      `Expected legacy pending candidate, got ${String(subject.legacyCandidateStatus)}.`,
    );
  }
  if (subject.status !== 'suggested') {
    throw new Error(`Expected fresh governed status suggested, got ${subject.status}.`);
  }
  const decision = await authorization.evaluateInTx(
    tx,
    { tenantId, userId: adminId, role: 'user_admin' },
    subject,
    'approve',
  );
  if (!decision.allowed) {
    throw new Error(`Canonical admin authorization unexpectedly denied: ${decision.reason}`);
  }
}

async function setAdminCapability(
  tx: { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> },
  candidateId: string,
  actorId: string,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `SELECT set_config('app.memory_admin_review_candidate_id', $1, true)`,
    candidateId,
  );
  await tx.$executeRawUnsafe(
    `SELECT set_config('app.memory_admin_review_actor_id', $1, true)`,
    actorId,
  );
}

async function updateCandidateApproved(
  tx: { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> },
  tenantId: string,
  decidedBy: string,
  candidateId: string,
): Promise<number> {
  return tx.$executeRawUnsafe(
    `UPDATE memory_candidate
     SET status = 'approved', decided_by = $1::uuid, decided_at = now()
     WHERE tenant_id = $2::uuid
       AND id = $3::uuid
       AND status = 'pending'`,
    decidedBy,
    tenantId,
    candidateId,
  );
}

async function createCandidate(
  prisma: PrismaClient,
  input: { tenantId: string; proposerId: string; candidateId: string; key: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await setContext(tx, input.tenantId, input.proposerId);
    await tx.$executeRawUnsafe(
      `INSERT INTO memory_candidate (
         id, tenant_id, proposed_by, source_kind, scope,
         payload_jsonb, provenance_jsonb, status
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'settings_sections', 'firm',
         $4::jsonb, $5::jsonb, 'pending'
       )`,
      input.candidateId,
      input.tenantId,
      input.proposerId,
      JSON.stringify({
        key: input.key,
        value: 'Admin self-approval acceptance.',
        source: 'memory_admin_self_approval_acceptance',
        scope: 'firm',
        canonicalItem: {
          type: 'firm-soul',
          slug: input.key,
          title: 'Admin Self Approval Acceptance',
          sections: [
            {
              key: 'test',
              heading: 'Test',
              owner: 'human',
              body: 'Admin self-approval acceptance.',
            },
          ],
        },
      }),
      JSON.stringify({ tool: 'memory_admin_self_approval_acceptance' }),
    );
  });
}

async function assignReviewer(
  prisma: PrismaClient,
  tenantId: string,
  candidateId: string,
  reviewerId: string,
): Promise<void> {
  const updated = await prisma.$executeRawUnsafe(
    `UPDATE review_request
     SET assigned_to = $1::uuid
     WHERE tenant_id = $2::uuid
       AND surface = 'memory'
       AND subject_type = 'memory_candidate'
       AND subject_id = $3
       AND status = 'pending'`,
    reviewerId,
    tenantId,
    candidateId,
  );
  if (updated !== 1) throw new Error('Expected one memory review assignment row.');
}

async function setContext(
  tx: { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> },
  tenantId: string,
  userId: string,
): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, tenantId);
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, userId);
  await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'off', true)`);
}

function requireDisposableUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const parsed = new URL(value);
  const databaseName = parsed.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase();
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase()) ||
    !databaseName?.includes('memory_phase2')
  ) {
    throw new Error(`${name} must target a disposable local memory_phase2 database.`);
  }
  return value;
}

function client(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
