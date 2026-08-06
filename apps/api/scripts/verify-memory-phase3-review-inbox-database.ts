import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { MemoryAuthorizationService } from '../src/memory/memory-authorization.service.js';
import { MemoryReviewInboxService } from '../src/memory/memory-review-inbox.service.js';
import { MemoryReviewCompatibilityGuardService } from '../src/reviews/memory-review-compatibility-guard.service.js';

const SECRET_BODY = 'PHASE3_SECRET_BODY_MUST_NOT_ENTER_THE_INBOX_LIST';
const FIXED_CREATED_AT = '2026-08-06T12:00:00.000Z';

interface FixtureIds {
  tenantId: string;
  proposerId: string;
  reviewerId: string;
}

interface SeededIds {
  formerReviewerId: string;
  assignedCandidateIds: string[];
  formerReviewerCandidateId: string;
  unassignedCandidateId: string;
  crossTenantCandidateId: string;
  notificationId: string;
  otherRecipientNotificationId: string;
  firstReviewRequestId: string;
}

async function main(): Promise<void> {
  const cleanUrl = requireDisposableUrl('MEMORY_PHASE2_CLEAN_DATABASE_URL');
  const upgradeUrl = requireDisposableUrl('MEMORY_PHASE2_UPGRADE_DATABASE_URL');
  if (databaseIdentity(cleanUrl) === databaseIdentity(upgradeUrl)) {
    throw new Error('Clean and upgrade database URLs must identify different databases.');
  }

  const cleanIds = fixtureIds('clean');
  const upgradeIds = fixtureIds('upgrade');
  process.env.MEMORY_CLIENT_REVIEW = 'enforce';
  process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
  process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
  process.env.MEMORY_GOVERNANCE_TENANTS = `${cleanIds.tenantId},${upgradeIds.tenantId}`;

  await runAcceptance(cleanUrl, cleanIds, 'clean');
  await runAcceptance(upgradeUrl, upgradeIds, 'upgrade');
  process.stdout.write('MEMORY_PHASE3_DATABASE_ACCEPTANCE_COMPLETE\n');
}

async function runAcceptance(
  databaseUrl: string,
  ids: FixtureIds,
  label: 'clean' | 'upgrade',
): Promise<void> {
  const prisma = client(databaseUrl);
  try {
    const seeded = await seedPhase3(prisma, ids, label);
    const adapter = scopedPrismaAdapter(prisma);
    const authorization = new MemoryAuthorizationService(adapter);
    const inbox = new MemoryReviewInboxService(adapter, authorization);
    const compatibility = new MemoryReviewCompatibilityGuardService(adapter);

    const reviewerCtx = tenantContext(ids.tenantId, ids.reviewerId, 'user_admin');
    const proposerCtx = tenantContext(ids.tenantId, ids.proposerId, 'user_admin');
    const formerCtx = tenantContext(
      ids.tenantId,
      seeded.formerReviewerId,
      'standard_user',
    );

    const firstPage = await inbox.list(reviewerCtx, {
      view: 'needs_my_review',
      limit: 2,
    });
    if (firstPage.items.length !== 2 || !firstPage.nextCursor) {
      throw new Error(`${label}: expected a two-row first inbox page with a cursor.`);
    }
    const secondPage = await inbox.list(reviewerCtx, {
      view: 'needs_my_review',
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    const observedIds = [
      ...firstPage.items.map((item) => item.candidateId),
      ...secondPage.items.map((item) => item.candidateId),
    ];
    const expectedIds = new Set([
      ...seeded.assignedCandidateIds,
      seeded.formerReviewerCandidateId,
    ]);
    const observedExpected = new Set(
      observedIds.filter((candidateId) => expectedIds.has(candidateId)),
    );
    if (
      observedExpected.size !== expectedIds.size ||
      observedIds.length !== new Set(observedIds).size
    ) {
      throw new Error(
        `${label}: cursor pagination duplicated or omitted review work: ${JSON.stringify(observedIds)}.`,
      );
    }
    if (JSON.stringify([...firstPage.items, ...secondPage.items]).includes(SECRET_BODY)) {
      throw new Error(`${label}: broad inbox serialization leaked proposal content.`);
    }

    const detail = await inbox.detail(reviewerCtx, seeded.assignedCandidateIds[0]!);
    if (!JSON.stringify(detail.proposal).includes(SECRET_BODY)) {
      throw new Error(`${label}: protected detail did not load proposal content.`);
    }
    if (!detail.activeMemoryUnchanged || detail.timeline.length !== 1) {
      throw new Error(`${label}: detail did not preserve pending revision truth.`);
    }

    await expectNotFound(
      () => inbox.detail(formerCtx, seeded.formerReviewerCandidateId),
      `${label}: former reviewer retained detail access after reassignment.`,
    );
    await expectNotFound(
      () => inbox.detail(reviewerCtx, seeded.crossTenantCandidateId),
      `${label}: cross-tenant candidate id was readable.`,
    );

    const blocked = await inbox.list(proposerCtx, { view: 'blocked', limit: 50 });
    if (!blocked.items.some((item) => item.candidateId === seeded.unassignedCandidateId)) {
      throw new Error(`${label}: unassigned workflow was absent from the blocked view.`);
    }

    await expectNotFound(
      () => inbox.markNotificationRead(formerCtx, seeded.notificationId),
      `${label}: another member marked the recipient notification read.`,
    );
    await inbox.markNotificationRead(reviewerCtx, seeded.notificationId);
    if (!(await notificationReadAt(prisma, seeded.notificationId))) {
      throw new Error(`${label}: recipient notification was not marked read.`);
    }

    const markedAll = await inbox.markAllNotificationsRead(reviewerCtx);
    if (markedAll < 1) {
      throw new Error(`${label}: mark-all did not update the current recipient's unread rows.`);
    }
    if (await notificationReadAt(prisma, seeded.otherRecipientNotificationId)) {
      throw new Error(`${label}: mark-all changed another recipient's notification.`);
    }

    await expectNotFound(
      () => compatibility.assertNotMemoryReview(reviewerCtx, seeded.firstReviewRequestId),
      `${label}: generic review compatibility guard accepted a memory row.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function seedPhase3(
  prisma: PrismaClient,
  ids: FixtureIds,
  label: string,
): Promise<SeededIds> {
  const formerReviewerId = randomUUID();
  const assignedCandidateIds = [randomUUID(), randomUUID(), randomUUID()];
  const formerReviewerCandidateId = randomUUID();
  const unassignedCandidateId = randomUUID();

  await prisma.$transaction(async (tx) => {
    await setContext(tx, ids.tenantId, ids.proposerId);
    await insertUser(
      tx,
      formerReviewerId,
      `phase3-former-${label}-${formerReviewerId}`,
      `phase3-former-${label}-${formerReviewerId}@example.test`,
      'Former',
      'Reviewer',
    );
    await insertMembership(tx, ids.tenantId, formerReviewerId, 'standard_user');

    const allCandidates = [
      ...assignedCandidateIds,
      formerReviewerCandidateId,
      unassignedCandidateId,
    ];
    for (const [index, candidateId] of allCandidates.entries()) {
      await insertFirmCandidate(
        tx,
        ids.tenantId,
        ids.proposerId,
        candidateId,
        `Phase 3 ${label} ${index + 1}`,
      );
    }
    for (const candidateId of assignedCandidateIds) {
      await assignReviewer(tx, ids.tenantId, candidateId, ids.reviewerId);
    }
    await assignReviewer(
      tx,
      ids.tenantId,
      formerReviewerCandidateId,
      formerReviewerId,
    );
    await assignReviewer(
      tx,
      ids.tenantId,
      formerReviewerCandidateId,
      ids.reviewerId,
    );
  });

  const crossTenantCandidateId = await seedCrossTenantCandidate(prisma, label);
  const firstReviewRequestId = await reviewRequestIdForCandidate(
    prisma,
    ids.tenantId,
    assignedCandidateIds[0]!,
  );
  const secondReviewRequestId = await reviewRequestIdForCandidate(
    prisma,
    ids.tenantId,
    assignedCandidateIds[1]!,
  );

  const notificationId = randomUUID();
  const secondNotificationId = randomUUID();
  const otherRecipientNotificationId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await setContext(tx, ids.tenantId, ids.reviewerId);
    await insertNotification(tx, {
      id: notificationId,
      tenantId: ids.tenantId,
      recipientUserId: ids.reviewerId,
      reviewRequestId: firstReviewRequestId,
      candidateId: assignedCandidateIds[0]!,
    });
    await insertNotification(tx, {
      id: secondNotificationId,
      tenantId: ids.tenantId,
      recipientUserId: ids.reviewerId,
      reviewRequestId: secondReviewRequestId,
      candidateId: assignedCandidateIds[1]!,
    });
    await insertNotification(tx, {
      id: otherRecipientNotificationId,
      tenantId: ids.tenantId,
      recipientUserId: formerReviewerId,
      reviewRequestId: firstReviewRequestId,
      candidateId: assignedCandidateIds[0]!,
    });
  });

  return {
    formerReviewerId,
    assignedCandidateIds,
    formerReviewerCandidateId,
    unassignedCandidateId,
    crossTenantCandidateId,
    notificationId,
    otherRecipientNotificationId,
    firstReviewRequestId,
  };
}

async function seedCrossTenantCandidate(
  prisma: PrismaClient,
  label: string,
): Promise<string> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const candidateId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, status)
       VALUES ($1::uuid, $2, $3, 'active'::tenant_status)`,
      tenantId,
      `phase3-cross-${label}-${tenantId.slice(0, 8)}`,
      `Phase 3 Cross Tenant ${label}`,
    );
    await insertUser(
      tx,
      userId,
      `phase3-cross-${label}-${userId}`,
      `phase3-cross-${label}-${userId}@example.test`,
      null,
      null,
    );
    await insertMembership(tx, tenantId, userId, 'user_admin');
    await setContext(tx, tenantId, userId);
    await insertFirmCandidate(
      tx,
      tenantId,
      userId,
      candidateId,
      `Phase 3 Cross Tenant ${label}`,
    );
  });
  return candidateId;
}

async function insertUser(
  tx: { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> },
  userId: string,
  clerkUserId: string,
  email: string,
  firstName: string | null,
  lastName: string | null,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO users (id, clerk_user_id, email, first_name, last_name)
     VALUES ($1::uuid, $2, $3::citext, $4, $5)`,
    userId,
    clerkUserId,
    email,
    firstName,
    lastName,
  );
}

async function insertMembership(
  tx: { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> },
  tenantId: string,
  userId: string,
  role: 'user_admin' | 'standard_user',
): Promise<void> {
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

async function insertFirmCandidate(
  tx: { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> },
  tenantId: string,
  proposerId: string,
  candidateId: string,
  title: string,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO memory_candidate (
       id, tenant_id, proposed_by, source_kind, scope,
       payload_jsonb, provenance_jsonb, status, created_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'explicit_user', 'firm',
       $4::jsonb, $5::jsonb, 'pending', $6::timestamptz
     )`,
    candidateId,
    tenantId,
    proposerId,
    JSON.stringify({
      key: `phase3:${candidateId}`,
      value: SECRET_BODY,
      source: 'memory_phase3_closeout',
      scope: 'firm',
      canonicalItem: {
        type: 'firm-soul',
        slug: candidateId,
        title,
        sections: [
          {
            key: 'mission',
            heading: 'Mission',
            owner: 'human',
            body: SECRET_BODY,
          },
        ],
      },
    }),
    JSON.stringify({ tool: 'memory_phase3_closeout' }),
    FIXED_CREATED_AT,
  );
}

async function assignReviewer(
  tx: { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> },
  tenantId: string,
  candidateId: string,
  reviewerId: string,
): Promise<void> {
  const updated = await tx.$executeRawUnsafe(
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
  if (updated !== 1) throw new Error('Expected one Phase 3 reviewer assignment.');
}

async function reviewRequestIdForCandidate(
  prisma: PrismaClient,
  tenantId: string,
  candidateId: string,
): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id::text AS id
     FROM review_request
     WHERE tenant_id = $1::uuid
       AND surface = 'memory'
       AND subject_type = 'memory_candidate'
       AND subject_id = $2
     LIMIT 1`,
    tenantId,
    candidateId,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Phase 3 candidate is missing its review request.');
  return id;
}

async function insertNotification(
  tx: { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> },
  input: {
    id: string;
    tenantId: string;
    recipientUserId: string;
    reviewRequestId: string;
    candidateId: string;
  },
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO memory_review_in_app_notification (
       id, tenant_id, recipient_user_id, review_request_id, candidate_id,
       event_type, title, metadata_jsonb
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       'review_assigned', 'Phase 3 Review',
       jsonb_build_object(
         'workflow', 'memory_review_v2',
         'schemaVersion', 1,
         'reviewRequestId', $4::uuid,
         'candidateId', $5::uuid,
         'eventType', 'review_assigned',
         'candidateKind', 'standard',
         'requiresCurrentAuthorization', true
       )
     )`,
    input.id,
    input.tenantId,
    input.recipientUserId,
    input.reviewRequestId,
    input.candidateId,
  );
}

function scopedPrismaAdapter(prisma: PrismaClient): PrismaService {
  return {
    withTenantUser: async <T>(
      tenantId: string,
      userId: string,
      work: (tx: never) => Promise<T>,
    ): Promise<T> =>
      prisma.$transaction(
        async (tx) => {
          await setContext(tx, tenantId, userId);
          return work(tx as never);
        },
        { timeout: 30_000 },
      ),
  } as unknown as PrismaService;
}

async function notificationReadAt(
  prisma: PrismaClient,
  notificationId: string,
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ read_at: Date | null }>>(
    `SELECT read_at
     FROM memory_review_in_app_notification
     WHERE id = $1::uuid`,
    notificationId,
  );
  return rows[0]?.read_at instanceof Date;
}

async function expectNotFound(
  work: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'NotFoundException' || error.message.includes('not found'))
    ) {
      return;
    }
    throw error;
  }
  throw new Error(message);
}

function tenantContext(
  tenantId: string,
  userId: string,
  role: TenantContext['role'],
): TenantContext {
  return {
    tenantId,
    tenantSlug: `phase3-${tenantId.slice(0, 8)}`,
    userId,
    clerkUserId: `clerk-${userId}`,
    role,
  };
}

async function setContext(
  tx: { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> },
  tenantId: string,
  userId: string,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `SELECT set_config('app.current_tenant', $1, true)`,
    tenantId,
  );
  await tx.$executeRawUnsafe(
    `SELECT set_config('app.current_user', $1, true)`,
    userId,
  );
  await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'off', true)`);
}

function fixtureIds(label: 'clean' | 'upgrade'): FixtureIds {
  const prefix = label === 'clean' ? '1' : '2';
  return {
    tenantId: `${prefix}1111111-1111-4111-8111-111111111111`,
    proposerId: `${prefix}2222222-2222-4222-8222-222222222222`,
    reviewerId: `${prefix}3333333-3333-4333-8333-333333333333`,
  };
}

function requireDisposableUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const parsed = new URL(value);
  const databaseName = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((component) => decodeURIComponent(component))
    .at(-1)
    ?.toLowerCase();
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase()) ||
    !databaseName?.includes('memory_phase2')
  ) {
    throw new Error(
      `${name} must target a disposable local PostgreSQL database named with memory_phase2.`,
    );
  }
  return value;
}

function databaseIdentity(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  return `${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}${parsed.pathname}`;
}

function client(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
