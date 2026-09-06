/**
 * Real-Postgres concurrency proof for P08 idempotency.
 *
 * This exercises the actual FundingOpportunityActionsService and
 * FundingOpportunitiesService against a migrated disposable Postgres. Eight
 * identical Pursue actions must all return the same task and leave exactly one
 * task row and one client_funding_opportunity row behind.
 *
 * The caller must provide DATABASE_URL for an already-migrated database. CI
 * supplies the funding-opportunities workflow's Postgres service; locally this
 * can be a disposable Docker Postgres after `prisma migrate deploy`.
 */
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TangoGatewayService } from '../src/external/tango/tango.client.js';
import { TangoStoreService } from '../src/external/tango/tango-store.service.js';
import {
  FundingOpportunityActionsService,
  FUNDING_OPPORTUNITY_TASK_SOURCE,
} from '../src/funding-opportunities/funding-opportunity-actions.service.js';
import { FundingOpportunitiesService } from '../src/funding-opportunities/funding-opportunities.service.js';
import { buildSourceRecordIdentity } from '../src/funding-opportunities/funding-opportunity-identity.js';

const CONCURRENCY = 8;
const OPPORTUNITY_SOURCE = 'sam_gov' as const;
const OPPORTUNITY_TITLE = 'P08 disposable concurrency opportunity';

/**
 * Refuse to run against a non-disposable database.
 *
 * This script creates and deletes tenants/users/clients/tasks. It is only safe
 * against the funding-opportunities CI Postgres service or an explicit local
 * disposable instance. Set ALLOW_P08_CONCURRENCY_DB=1 to opt in.
 */
function assertDisposableDatabaseUrl(urlRaw: string | undefined): void {
  // Opt-in first so a missing DATABASE_URL cannot hide the deliberate safety gate.
  if (process.env.ALLOW_P08_CONCURRENCY_DB !== '1' && process.env.CI !== 'true') {
    throw new Error(
      'Refusing to run P08 concurrency proof without ALLOW_P08_CONCURRENCY_DB=1 (or CI=true)',
    );
  }
  const url = (urlRaw ?? '').trim();
  if (!url) {
    throw new Error('DATABASE_URL is required for the P08 concurrency proof');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  const host = (parsed.hostname || '').toLowerCase();
  const allowHosts = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);
  if (!allowHosts.has(host)) {
    throw new Error(
      `Refusing P08 concurrency proof against non-local host '${host}'. Use a disposable Postgres.`,
    );
  }
}

type Fixture = {
  tenantId: string;
  userId: string;
  clientId: string;
  otherClientId: string;
  samOpportunityId: string;
  reviewOpportunityId: string;
  legacyOpportunityId: string;
};

type ActionResult = Awaited<ReturnType<FundingOpportunityActionsService['act']>>;

function assertEqual(actual: number, expected: number, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function makeFixture(): Fixture {
  return {
    tenantId: randomUUID(),
    userId: randomUUID(),
    clientId: randomUUID(),
    otherClientId: randomUUID(),
    samOpportunityId: randomUUID(),
    reviewOpportunityId: randomUUID(),
    legacyOpportunityId: randomUUID(),
  };
}

async function seedFixtures(prisma: PrismaService, fixture: Fixture): Promise<void> {
  const now = new Date();

  await prisma.withSystem(async (tx) => {
    await tx.tenant.create({
      data: {
        id: fixture.tenantId,
        slug: `p08-concurrency-${fixture.tenantId.slice(0, 8)}`,
        name: 'P08 disposable concurrency tenant',
        status: 'active',
      },
    });
    await tx.user.create({
      data: {
        id: fixture.userId,
        clerkUserId: `p08-concurrency-${fixture.userId}`,
        email: `p08-concurrency-${fixture.userId}@example.invalid`,
        firstName: 'P08',
        lastName: 'Concurrency',
      },
    });
    await tx.tenantMembership.create({
      data: {
        tenantId: fixture.tenantId,
        userId: fixture.userId,
        role: 'standard_user',
        status: 'active',
        joinedAt: now,
      },
    });
    for (const clientId of [fixture.clientId, fixture.otherClientId]) {
      await tx.client.create({
        data: {
          id: clientId,
          tenantId: fixture.tenantId,
          name: 'P08 disposable concurrency client',
        },
      });
    }
    await tx.$executeRaw`
      INSERT INTO intel_feature_flag (id, tenant_id, feature, enabled)
      VALUES (${randomUUID()}, ${fixture.tenantId}, 'funding_opportunities', true)
    `;
  });

  for (const id of [
    fixture.samOpportunityId,
    fixture.reviewOpportunityId,
    fixture.legacyOpportunityId,
  ]) {
    await prisma.samOpportunity.create({
      data: {
        id,
        noticeId: `P08-CONCURRENCY-${id}`,
        solicitationNumber: 'P08-CONCURRENCY',
        title: OPPORTUNITY_TITLE,
        noticeType: 'Solicitation',
        baseType: 'Solicitation',
        agency: 'P08 Test Agency',
        responseDeadline: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        archiveDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        sourceUrl: 'https://example.invalid/p08-concurrency',
        active: true,
        updatedAt: now,
      },
    });
  }
}

/**
 * Pre-create the decision row. THIS IS WHAT MAKES THE PROOF ABOUT engagement_tasks.
 *
 * act() writes TWO rows: the task, then the decision row via
 * applyActionDecision(). client_funding_opportunity ALREADY has its own partial
 * unique index (client_funding_opportunity_sam_uniq). So when the decision row
 * does not exist yet, a concurrent burst is caught by THAT index instead: every
 * loser's applyActionDecision create raises P2002, its whole transaction rolls
 * back — taking its duplicate task insert with it — and act()'s catch returns
 * the winner. The assertions below then pass at 1 task row / CONCURRENCY-1
 * reused WHETHER OR NOT engagement_tasks_tenant_source_uniq exists, i.e. the
 * test would be vacuous. Verified by execution: with this seed removed and the
 * index dropped, the script still reported P08_ACTION_CONCURRENCY_OK.
 *
 * With the decision row already present, applyActionDecision takes its `update`
 * branch, which serializes harmlessly on an ordinary row lock and raises no
 * P2002 — leaving engagement_tasks_tenant_source_uniq as the ONLY thing between
 * CONCURRENCY parallel find-then-create calls and CONCURRENCY duplicate rows.
 *
 * Seeded directly so the pursuit concurrency proof is independent of review
 * behavior. A separate assertion below exercises dated review creation through
 * the real service and its database constraint.
 */
async function seedDecisionRow(prisma: PrismaService, fixture: Fixture): Promise<void> {
  const identity = buildSourceRecordIdentity(OPPORTUNITY_SOURCE, fixture.samOpportunityId);
  await prisma.withTenant(fixture.tenantId, async (tx) => {
    await tx.clientFundingOpportunity.create({
      data: {
        tenantId: fixture.tenantId,
        clientId: fixture.clientId,
        source: identity.source,
        samOpportunityId: identity.samOpportunityId,
        sourceRecordType: identity.sourceRecordType,
        sourceRecordKey: identity.sourceRecordKey,
        workflowStatus: 'saved',
        // Same value applyActionDecision writes on its own create path.
        evidenceSourceType: 'user_action',
      },
    });
  });
}

async function cleanupFixtures(prisma: PrismaService, fixture: Fixture): Promise<void> {
  // Each cleanup step is independent so a missing table/row after a partial
  // seed cannot skip the rest. The user row is global and does not cascade
  // from tenant deletion.
  const steps: Array<[string, () => Promise<unknown>]> = [
    [
      'samOpportunity',
      () =>
        prisma.samOpportunity.deleteMany({
          where: {
            id: {
              in: [
                fixture.samOpportunityId,
                fixture.reviewOpportunityId,
                fixture.legacyOpportunityId,
              ],
            },
          },
        }),
    ],
    [
      'featureFlag',
      () =>
        prisma.withSystem(
          (tx) =>
            tx.$executeRaw`DELETE FROM intel_feature_flag WHERE tenant_id = ${fixture.tenantId}`,
        ),
    ],
    [
      'tenant',
      () =>
        prisma.withSystem(async (tx) => {
          // Tenant deletion cascades audit_logs. This is the repository's
          // explicit GDPR-purge escape hatch; ordinary deletes remain append-only.
          await tx.$executeRaw`SELECT set_config('app.allow_audit_purge', 'on', true)`;
          await tx.tenant.deleteMany({ where: { id: fixture.tenantId } });
        }),
    ],
    ['user', () => prisma.user.deleteMany({ where: { id: fixture.userId } })],
  ];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (error: unknown) {
      console.warn(
        `P08 cleanup warning (${label}):`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

async function main(): Promise<void> {
  assertDisposableDatabaseUrl(process.env.DATABASE_URL);
  const prisma = new PrismaService();
  const fixture = makeFixture();
  let connected = false;

  try {
    await prisma.$connect();
    connected = true;
    await seedFixtures(prisma, fixture);

    // The SAM path does not call Tango, but these are the real collaborators
    // used by FundingOpportunitiesService rather than a fake service or fake DB.
    const tangoStore = new TangoStoreService(prisma);
    // The SAM action path must not call Tango. Keep the gateway explicitly
    // unconfigured so an accidental provider call fails closed without a key.
    const tangoGateway = new TangoGatewayService();
    const opportunities = new FundingOpportunitiesService(prisma, tangoStore, tangoGateway);
    const actions = new FundingOpportunityActionsService(prisma, opportunities);
    const sourceId = FundingOpportunityActionsService.taskSourceId(
      fixture.clientId,
      OPPORTUNITY_SOURCE,
      fixture.samOpportunityId,
      'pursuit',
    );

    await seedDecisionRow(prisma, fixture);

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        actions.act(
          fixture.tenantId,
          fixture.clientId,
          OPPORTUNITY_SOURCE,
          fixture.samOpportunityId,
          {
            intent: 'pursuit',
            actorUserId: fixture.userId,
          },
        ),
      ),
    );

    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected.length > 0) {
      const reasons = rejected
        .map((result) =>
          result.reason instanceof Error ? result.reason.stack : String(result.reason),
        )
        .join('\n');
      throw new Error(
        `${rejected.length}/${CONCURRENCY} concurrent actions rejected; expected every loser to recover from P2002\n${reasons}`,
      );
    }

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<ActionResult> => result.status === 'fulfilled',
    );
    const taskIds = new Set(fulfilled.map((result) => result.value.task.id));
    const reusedCount = fulfilled.filter((result) => result.value.task.reused).length;

    const counts = await prisma.withTenant(fixture.tenantId, async (tx) => {
      const [taskCount, decisionCount] = await Promise.all([
        tx.engagementTask.count({
          where: {
            sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
            sourceId,
          },
        }),
        tx.clientFundingOpportunity.count({
          where: {
            clientId: fixture.clientId,
            source: OPPORTUNITY_SOURCE,
            samOpportunityId: fixture.samOpportunityId,
          },
        }),
      ]);
      return { taskCount, decisionCount };
    });

    assertEqual(taskIds.size, 1, 'all concurrent actions must return the same task id');
    assertEqual(counts.taskCount, 1, 'exactly one engagement_tasks row must survive');
    assertEqual(counts.decisionCount, 1, 'exactly one client_funding_opportunity row must survive');
    assertEqual(reusedCount, CONCURRENCY - 1, 'all but the winning action must report reused=true');

    // Same source notice, different client: the original tenant/source-only key
    // used to return the first client's task here.
    await seedDecisionRow(prisma, { ...fixture, clientId: fixture.otherClientId });
    const other = await actions.act(
      fixture.tenantId,
      fixture.otherClientId,
      OPPORTUNITY_SOURCE,
      fixture.samOpportunityId,
      {
        intent: 'pursuit',
        actorUserId: fixture.userId,
      },
    );
    if (taskIds.has(other.task.id) || other.task.reused)
      throw new Error('A second client reused the first client task');
    const otherRetry = await actions.act(
      fixture.tenantId,
      fixture.otherClientId,
      OPPORTUNITY_SOURCE,
      fixture.samOpportunityId,
      {
        intent: 'pursuit',
        actorUserId: fixture.userId,
      },
    );
    if (otherRetry.task.id !== other.task.id || !otherRetry.task.reused)
      throw new Error('Second client retry did not reuse its own task');

    // Exercise the actual non-null-date / non-empty-text database constraint.
    const followUp = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const reviewed = await actions.act(
      fixture.tenantId,
      fixture.clientId,
      OPPORTUNITY_SOURCE,
      fixture.reviewOpportunityId,
      {
        intent: 'review',
        actorUserId: fixture.userId,
        nextAction: '   ',
        nextActionDueAt: followUp.toISOString(),
      },
    );
    const reviewRow = await prisma.withTenant(fixture.tenantId, (tx) =>
      tx.clientFundingOpportunity.findFirstOrThrow({
        where: { clientId: fixture.clientId, samOpportunityId: fixture.reviewOpportunityId },
      }),
    );
    if (
      !reviewRow.nextAction?.trim() ||
      reviewRow.nextActionDueAt?.toISOString() !== reviewed.task.dueDate
    ) {
      throw new Error('Dated review did not persist matching date and nonempty next action');
    }

    // Preserve preexisting task identity and human edits, but never reuse it for
    // another client even when an old workflow audit incorrectly referenced it.
    const legacy = await prisma.withTenant(fixture.tenantId, (tx) =>
      tx.engagementTask.create({
        data: {
          tenantId: fixture.tenantId,
          clientId: fixture.clientId,
          title: 'Human-edited legacy pursuit',
          ownerUserId: fixture.userId,
          dueDate: followUp,
          sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
          sourceId: `${OPPORTUNITY_SOURCE}:${fixture.legacyOpportunityId}:pursuit`,
          createdByUserId: fixture.userId,
        },
      }),
    );
    const legacyReused = await actions.act(
      fixture.tenantId,
      fixture.clientId,
      OPPORTUNITY_SOURCE,
      fixture.legacyOpportunityId,
      {
        intent: 'pursuit',
        actorUserId: fixture.userId,
        ownerUserId: null,
        nextActionDueAt: null,
      },
    );
    if (
      legacyReused.task.id !== legacy.id ||
      !legacyReused.task.reused ||
      legacyReused.task.ownerUserId !== fixture.userId ||
      legacyReused.task.dueDate !== followUp.toISOString()
    ) {
      throw new Error('Legacy reuse changed the task identity, owner or date');
    }
    const legacyOther = await actions.act(
      fixture.tenantId,
      fixture.otherClientId,
      OPPORTUNITY_SOURCE,
      fixture.legacyOpportunityId,
      {
        intent: 'pursuit',
        actorUserId: fixture.userId,
      },
    );
    if (legacyOther.task.id === legacy.id || legacyOther.task.reused)
      throw new Error('Legacy task leaked across client boundaries');

    // Retrying after a teammate edits the task must retain their actual task
    // fields and human workflow notes instead of replaying stale input.
    await prisma.withTenant(fixture.tenantId, async (tx) => {
      await tx.clientFundingOpportunity.updateMany({
        where: { clientId: fixture.clientId, samOpportunityId: fixture.legacyOpportunityId },
        data: {
          notes: 'Human note survives retry',
          nextAction: 'Teammate confirmed acquisition requirements',
        },
      });
    });
    await actions.act(
      fixture.tenantId,
      fixture.clientId,
      OPPORTUNITY_SOURCE,
      fixture.legacyOpportunityId,
      {
        intent: 'pursuit',
        actorUserId: fixture.userId,
        ownerUserId: null,
        notes: 'Stale request note',
        nextAction: 'Stale next action',
        nextActionDueAt: null,
      },
    );
    const preserved = await prisma.withTenant(fixture.tenantId, (tx) =>
      tx.clientFundingOpportunity.findFirstOrThrow({
        where: { clientId: fixture.clientId, samOpportunityId: fixture.legacyOpportunityId },
      }),
    );
    if (
      preserved.notes !== 'Human note survives retry' ||
      preserved.nextAction !== 'Teammate confirmed acquisition requirements' ||
      preserved.ownerUserId !== fixture.userId ||
      preserved.nextActionDueAt?.toISOString() !== followUp.toISOString()
    ) {
      throw new Error('Retry overwrote human workflow edits or disagreed with the task owner/date');
    }

    console.log(
      `P08_ACTION_CONCURRENCY_OK: ${CONCURRENCY} concurrent actions -> 1 task row, 1 decision row, ${reusedCount} reused=true; client isolation, dated review, legacy reuse and human-edit preservation passed`,
    );
  } finally {
    if (connected) {
      // Cleanup is diagnostic hygiene, not part of the proof. A seed failure can
      // happen before the migration-created tables exist, so cleanup must never
      // replace the original failure with a second missing-table/row error.
      try {
        await cleanupFixtures(prisma, fixture);
      } catch (cleanupError: unknown) {
        console.warn(
          'P08 cleanup warning (preserving the original result):',
          cleanupError instanceof Error ? cleanupError.message : cleanupError,
        );
      } finally {
        try {
          await prisma.$disconnect();
        } catch (disconnectError: unknown) {
          console.warn(
            'P08 disconnect warning (preserving the original result):',
            disconnectError instanceof Error ? disconnectError.message : disconnectError,
          );
        }
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
