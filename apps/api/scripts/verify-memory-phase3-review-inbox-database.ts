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
  existingOtherUserId: string;
}

interface SeededIds {
  formerReviewerId: string;
  candidateIds: string[];
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
    const candidateIds = [
      ...firstPage.items.map((item) => item.candidateId),
      ...secondPage.items.map((item) => item.candidateId),
    ];
    const expected = new Set([
      ...seeded.candidateIds,
      seeded.formerReviewerCandidateId,
    ]);
    const observed = new Set(candidateIds.filter((id) => expected.has(id)));
    if (observed.size !== expected.size || candidateIds.length !== new Set(candidateIds).size) {
      throw new Error(
        `${label}: cursor pagination duplicated or omitted review work: ${JSON.stringify(candidateIds)}.`,
      );
    }
    if (JSON.stringify([...firstPage.items, ...secondPage.items]).includes(SECRET_BODY)) {
      throw new Error(`${label}: broad inbox serialization leaked proposal content.`);
    }

    const detail = await inbox.detail(reviewerCtx, seeded.candidateIds[0]!);
    if (!JSON.stringify(detail.proposal).includes(SECRET_BODY)) {
      throw new Error(`${label}: protected detail did not load proposal content.`);
    }
    if (!detail.activeMemoryUnchanged || detail.timeline.length !== 1) {
      throw new Error(`${label}: detail did not preserve pending revision truth.`);
    }

    let formerDenied = false;
    try {
      await inbox.detail(formerCtx, seeded.formerReviewerCandidateId);
    } catch (error) {
      formerDenied = isNotFound(error);
    }
    if (!formerDenied) {
      throw new Error(`${label}: former reviewer retained detail access after reassignment.`);
    }

    let crossTenantDenied = false;
    try {
      await inbox.detail(reviewerCtx, seeded.crossTenantCandidateId);
    } catch (error) {
      crossTenantDenied = isNotFound(error);
    }
    if (!crossTenantDenied) {
      throw new Error(`${label}: cross-tenant candidate id was readable.`);
    }

    const blocked = await inbox.list(proposerCtx, { view: 'blocked', limit: 50 });
    if (!blocked.items.some((item) => item.candidateId === seeded.unassignedCandidateId)) {
      throw new Error(`${label}: unassigned workflow was absent from the blocked view.`);
    }

    let wrongRecipientDenied = false;
    try {
      await inbox.markNotificationRead(formerCtx, seeded.notificationId);
    } catch (error) {
      wrongRecipientDenied = isNotFound(error);
    }
    if (!wrongRecipientDenied) {
      throw new Error(`${label}: another member marked the recipient notification read.`);
    }
    await inbox.markNotificationRead(reviewerCtx, seeded.notificationId);
    const marked = await notificationReadAt(prisma, seeded.notificationId);
    if (!marked) throw new Error(`${label}: recipient notification was not marked read.`);

    const markedAll = await inbox.markAllNotificationsRead(reviewerCtx);
    if (markedAll < 1) {
      throw new Error(`${label}: mark-all did not update the current recipient's unread rows.`);
    }
    if (await notificationReadAt(prisma, seeded.otherRecipientNotificationId)) {
      throw new Error(`${label}: mark-all changed another recipient's notification.`);
    }

    let compatibilityDenied = false;
    try {
      await compatibility.assertNotMemoryReview(reviewerCtx, seeded.firstReviewRequestId);
    } catch (error) {
      compatibilityDenied = isNotFound(error);
    }
    if (!compatibilityDenied) {
      throw new Error(`${label}: generic review compatibility guard accepted a memory row.`);
    }
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
  const candidateIds = [randomUUID(), randomUUID(), randomUUID()];
  const formerReviewerCandidateId = randomUUID();
  const unassignedCandidateId = randomUUID();
  const crossTenantId = randomUUID();
  const crossTenantUserId = randomUUID();
  const crossTenantCandidateId = randomUUID();
  const notificationId = randomUUID();
  const secondNotificationId = randomUUID();
  const otherRecipientNotificationId = randomUUID();

  await prisma.$transaction(async (tx) => {
    await setContext(tx, ids.tenantId, ids.proposerId);
    await tx.$executeRawUnsafe(
      `INSERT INTO users (id, clerk_user_id, email, first_name, last_name)
       VALUES ($1::uuid, $2, $3::citext, 'Former', 'Reviewer')`,
      formerReviewerId,
      `phase3-former-${label}-${formerReviewerId}`,
      `phase3-former-${label}-${formerReviewerId}@example.test`,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO tenant_memberships (
         tenant_id, user_id, role, status, joined_at
       ) VALUES (
         $1::uuid, $2::uuid, 'standard_user'::tenant_role,
         'active'::membership_status, now()
       )`,
      ids.tenantId,
      formerReviewerId,
    );

    for (const [index, candidateId] of [
      ...candidateIds.map((id, index) => [index, id] as const),
      [candidateIds.length, formerReviewerCandidateId] as const,
      [candidateIds.length + 1, unassignedCandidateId] as const,
    ]) {
      await insertFirmCandidate(
        tx,
        ids,
        candidateId,
        `Phase 3 ${label} ${index + 1}`,
      );
    }

    await tx.$executeRawUnsafe(
      `UPDATE review_request
       SET created_at = $1::timestamptz
       WHERE tenant_id = $2::uuid
         AND surface = 'memory'
         AND subject_type = 'memory_candidate'
         AND subject_id IN (${[
           ...candidateIds,
           formerReviewerCandidateId,
           unassignedCandidateId,
         ]
           .map((_, index) => `$${index + 3}`)
           .join(', ')})`,
      FIXED_CREATED_AT,
      ids.tenantId,
      ...candidateIds,
      formerReviewerCandidateId,
      unassignedCandidateId,
    );

    for (const candidateId of candidateIds) {
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

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, status)
       VALUES ($1::uuid, $2, $3, 'active'::tenant_status)`,
      crossTenantId,
      `phase3-cross-${label}-${crossTenantId.slice(0, 8)}`,
      `Phase 3 Cross Tenant ${label}`,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO users (id, clerk_user_id, email)
       VALUES ($1::uuid, $2, $3::citext)`,
      crossTenantUserId,
      `phase3-cross-${label}-${crossTenantUserId}`,
      `phase3-cross-${label}-${crossTenantUserId}@example.test`,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO tenant_memberships (
         tenant_id, user_id, role, status, joined_at
       ) VALUES (
         $1::uuid, $2::uuid, 'user_admin'::tenant_role,
         'active'::membership_status, now()
       )`,
      crossTenantId,
      crossTenantUserId,
    );
    await setContext(tx, crossTenantId, crossTenantUserId);
    await tx.$executeRawUnsafe(
      `INSERT INTO memory_candidate (
         id, tenant_id, proposed_by, source_kind, scope,
         payload_jsonb, provenance_jsonb, status
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'explicit_user', 'firm',
         $4::jsonb, $5::jsonb, 'pending'
       )`,
      crossTenantCandidateId,
      crossTenantId,
      crossTenantUserId,
      JSON.stringify({
        key: `phase3-cross:${label}`,
        value: SECRET_BODY,
        source: 'memory_phase3_closeout',
        scope: 'firm',
      }),
      JSON.stringify({ tool: 'memory_phase3_closeout' }),
    );
  });

  const reviewRows = await prisma.$queryRawUnsafe<
    Array<{ candidate_id: string; review_request_id: string }>
  >(
    `SELECT mc.id::text AS candidate_id, rr.id::text AS review_request_id
     FROM memory_candidate mc
     JOIN review_request rr
       ON rr.tenant_id = mc.tenant_id
      AND rr.surface = 'memory'
      AND rr.subject_type = 'memory_candidate'
      AND rr.subject_id = mc.id::text
     WHERE mc.tenant_id = $1::uuid
       AND mc.id = ANY($2::uuid[])`,
    ids.tenantId,
    [...candidateIds, formerReviewerCandidateId, unassignedCandidateId],
  );
  const reviewByCandidate = new Map(
    reviewRows.map((row) => [row.candidate_id, row.review_request_id]),
  );
  const firstReviewRequestId = reviewByCandidate.get(candidateIds[0]!);
  if (!firstReviewRequestId) throw new Error(`${label}: missing review request.`);

  await prisma.$transaction(async (tx) => {
    await setContext(tx, ids.tenantId, ids.reviewerId);
    for (const [id, recipientUserId] of [
      [notificationId, ids.reviewerId],
      [secondNotificationId, ids.reviewerId],
      [otherRecipientNotificationId, formerReviewerId],
    ] as const) {
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
        id,
        ids.tenantId,
        recipientUserId,
        firstReviewRequestId,
        candidateIds[0],
      );
    }
  });

  return {
    formerReviewerId,
    candidateIds,
    formerReviewerCandidateId,
    unassignedCandidateId,
    crossTenantCandidateId,
    notificationId,
    otherRecipientNotificationId,
    firstReviewRequestId,
  };
}

async function insertFirmCandidate(
  tx: {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  },
  ids: FixtureIds,
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
    ids.tenantId,
    ids.proposerId,
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
  tx: {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  },
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
  tx: {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  },
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
    existingOtherUserId: `${prefix}4444444-4444-4444-8444-444444444444`,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'NotFoundException' || error.message.includes('not found'))
  );
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
