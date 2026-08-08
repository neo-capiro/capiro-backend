import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { TenantContext } from '@capiro/shared';
import type { CapabilityAuthorizationService } from '../src/capabilities/capability-authorization.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { OutreachStateRepository } from '../src/outreach-v3/persistence/outreach-state.repository.js';
import { OutreachCommandEngineService } from '../src/outreach-v3/services/outreach-command-engine.service.js';
import { OutreachCommandProposalService } from '../src/outreach-v3/services/outreach-command-proposal.service.js';
import { OutreachSessionService } from '../src/outreach-v3/services/outreach-session.service.js';
import { OutreachCommandError } from '../src/outreach-v3/state/outreach-command-errors.js';

const PROTECTED_TABLES = [
  'outreach_records',
  'outreach_draft_artifacts',
  'outreach_draft_versions',
  'outreach_jobs',
  'outreach_job_items',
  'outreach_send_intents',
  'outreach_deliveries',
  'engagement_connections',
  'meeting_bot_sessions',
] as const;

interface TableDigest {
  count: string;
  digest: string;
}

type DigestMap = Record<(typeof PROTECTED_TABLES)[number], TableDigest>;

function command(type: string, payload: unknown) {
  return { type, schemaVersion: 1, payload };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectCommandError(error: unknown, code: string): OutreachCommandError {
  assert(error instanceof OutreachCommandError, `Expected OutreachCommandError(${code})`);
  assert(error.code === code, `Expected ${code}, received ${error.code}`);
  return error;
}

async function protectedDigests(prisma: PrismaService): Promise<DigestMap> {
  return prisma.withSystem(async (tx) => {
    const result = {} as DigestMap;
    for (const table of PROTECTED_TABLES) {
      // Table names are compile-time constants above, never user input.
      const rows = await tx.$queryRawUnsafe<Array<{ count: string; digest: string }>>(`
        SELECT
          COUNT(*)::text AS count,
          md5(COALESCE(
            string_agg(md5(row_to_json(t)::text), ',' ORDER BY md5(row_to_json(t)::text)),
            ''
          )) AS digest
        FROM "${table}" t
      `);
      const row = rows[0];
      assert(row, `Missing digest row for ${table}`);
      result[table] = row;
    }
    return result;
  });
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const prisma = new PrismaService();
  const repository = new OutreachStateRepository();
  // This acceptance flow deliberately uses no client-backed sponsor or restored
  // client reference. Any call means a Phase 2 command unexpectedly widened its
  // authority requirement and must fail this rehearsal.
  const authorization = {
    authorizeClientWithinTx: async () => {
      throw new Error('Unexpected client authorization call in no-client Phase 2 flow');
    },
  } as unknown as CapabilityAuthorizationService;
  const engine = new OutreachCommandEngineService(prisma, repository, authorization);
  const sessions = new OutreachSessionService(prisma, repository);
  const proposals = new OutreachCommandProposalService(prisma, repository, engine);

  const tenantId = randomUUID();
  const userId = randomUUID();
  const ctx: TenantContext = {
    tenantId,
    tenantSlug: `outreach-v3-phase2-${tenantId.slice(0, 8)}`,
    userId,
    clerkUserId: `outreach_v3_phase2_${userId.replaceAll('-', '')}`,
    role: 'standard_user',
  };
  const legacyOutreachId = randomUUID();

  const results: Record<string, unknown> = {
    schemaVersion: 1,
    tenantId,
    userId,
    protectedTables: PROTECTED_TABLES,
  };

  await prisma.$connect();
  try {
    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: ctx.tenantSlug,
          name: 'Outreach V3 Phase 2 Flow',
          status: 'active',
        },
      });
      await tx.user.create({
        data: {
          id: userId,
          clerkUserId: ctx.clerkUserId,
          email: `${userId}@example.invalid`,
        },
      });
      await tx.outreachRecord.create({
        data: {
          id: legacyOutreachId,
          tenantId,
          createdByUserId: userId,
          type: 'follow_up',
          status: 'draft',
          title: 'Protected legacy Outreach sentinel',
        },
      });
    });

    const beforeProtected = await protectedDigests(prisma);
    results.protectedBefore = beforeProtected;

    const created = await sessions.createSession(ctx, { title: 'Phase 2 acceptance' });
    const sessionId = created.session.id;
    assert(created.currentStateVersion === 1, 'Blank session must start at version 1');
    assert(created.spec.sponsor.kind === 'undecided', 'Blank session sponsor must be undecided');
    results.sessionId = sessionId;
    results.blank = { version: created.currentStateVersion, specHash: created.specHash };

    const goalBatchId = randomUUID();
    const goal = await engine.applyBatch(ctx, sessionId, {
      batchId: goalBatchId,
      expectedStateVersion: 1,
      commands: [command('SET_GOAL', { value: 'Protect the program' })],
    });
    assert(goal.stateVersion === 2 && goal.changed, 'Goal command must create version 2');

    const replay = await engine.applyBatch(ctx, sessionId, {
      batchId: goalBatchId,
      expectedStateVersion: 1,
      commands: [command('SET_GOAL', { value: 'Protect the program' })],
    });
    assert(replay.replayed && replay.stateVersion === 2, 'Exact batch retry must replay v2');

    let idReuseCode: string | null = null;
    try {
      await engine.applyBatch(ctx, sessionId, {
        batchId: goalBatchId,
        expectedStateVersion: 2,
        commands: [command('SET_GOAL', { value: 'Different payload' })],
      });
    } catch (error) {
      idReuseCode = expectCommandError(error, 'OUTREACH_COMMAND_ID_REUSE').code;
    }
    assert(idReuseCode, 'Batch-id reuse with a changed payload must fail');

    const noOp = await engine.applyBatch(ctx, sessionId, {
      batchId: randomUUID(),
      expectedStateVersion: 2,
      commands: [command('SET_GOAL', { value: 'Protect the program' })],
    });
    assert(noOp.status === 'no_change' && noOp.stateVersion === 2, 'No-op must not create v3');

    const sponsor = await engine.applyBatch(ctx, sessionId, {
      batchId: randomUUID(),
      expectedStateVersion: 2,
      commands: [
        command('SET_SPONSOR_SCOPE', {
          kind: 'none',
          label: null,
          clientRefs: [],
        }),
      ],
    });
    assert(sponsor.stateVersion === 3, 'Sponsor-none must create version 3');

    const criteria = await engine.applyBatch(ctx, sessionId, {
      batchId: randomUUID(),
      expectedStateVersion: 3,
      commands: [
        command('SET_TARGET_CRITERIA', {
          value: {
            notes: 'Defense authorizers',
            governmentLevels: ['federal'],
            chambers: ['house', 'senate'],
            committees: ['Armed Services'],
            agencies: [],
            states: [],
            relationshipPreference: 'any',
            includeStaff: true,
            includePrincipals: true,
          },
        }),
      ],
    });
    assert(criteria.stateVersion === 4, 'Criteria must create version 4');

    const delivery = await engine.applyBatch(ctx, sessionId, {
      batchId: randomUUID(),
      expectedStateVersion: 4,
      commands: [command('SET_DELIVERY_PATTERN', { value: 'personalized_separate' })],
    });
    assert(delivery.stateVersion === 5, 'Delivery must create version 5');

    const proposalA = await proposals.createProposal(ctx, sessionId, {
      expectedStateVersion: 5,
      commands: [command('SET_TONE', { value: 'measured' })],
    });
    const proposalB = await proposals.createProposal(ctx, sessionId, {
      expectedStateVersion: 5,
      commands: [command('SET_CAMPAIGN_ANGLE', { value: 'Readiness and execution' })],
    });

    const beforeApply = await sessions.getSession(ctx, sessionId);
    assert(beforeApply.currentStateVersion === 5, 'Proposal creation must not mutate campaign state');
    const applied = await proposals.applyProposal(ctx, sessionId, proposalA.id);
    assert(!applied.stale && applied.result.stateVersion === 6, 'Explicit Apply must create version 6');

    let staleCode: string | null = null;
    try {
      await proposals.applyProposal(ctx, sessionId, proposalB.id);
    } catch (error) {
      staleCode = expectCommandError(error, 'OUTREACH_PROPOSAL_STALE').code;
    }
    assert(staleCode, 'Competing proposal must be superseded/stale after Apply');

    const proposalRows = await proposals.listProposals(ctx, sessionId);
    const appliedRow = proposalRows.find((row) => row.id === proposalA.id);
    const supersededRow = proposalRows.find((row) => row.id === proposalB.id);
    assert(appliedRow?.status === 'applied', 'Applied proposal must be terminal applied');
    assert(supersededRow?.status === 'superseded', 'Competing proposal must be superseded');

    const concurrentBase = (await sessions.getSession(ctx, sessionId)).currentStateVersion;
    assert(concurrentBase === 6, 'Concurrency probe must begin at version 6');
    const concurrent = await Promise.allSettled([
      engine.applyBatch(ctx, sessionId, {
        batchId: randomUUID(),
        expectedStateVersion: concurrentBase,
        commands: [command('SET_OBJECTIVE', { value: 'Objective A' })],
      }),
      engine.applyBatch(ctx, sessionId, {
        batchId: randomUUID(),
        expectedStateVersion: concurrentBase,
        commands: [command('SET_OBJECTIVE', { value: 'Objective B' })],
      }),
    ]);
    const winners = concurrent.filter((item) => item.status === 'fulfilled');
    const losers = concurrent.filter((item) => item.status === 'rejected');
    assert(winners.length === 1 && losers.length === 1, 'Exactly one concurrent writer must win');
    expectCommandError((losers[0] as PromiseRejectedResult).reason, 'OUTREACH_STATE_CONFLICT');

    const afterConcurrent = await sessions.getSession(ctx, sessionId);
    assert(afterConcurrent.currentStateVersion === 7, 'Concurrent winner must create exactly version 7');

    const restore = await engine.applyBatch(ctx, sessionId, {
      batchId: randomUUID(),
      expectedStateVersion: 7,
      commands: [command('RESTORE_STATE_VERSION', { version: 2 })],
    });
    assert(restore.stateVersion === 8 && restore.changed, 'Restore must create new version 8');
    const restored = await sessions.getSession(ctx, sessionId);
    const sourceV2 = await sessions.getVersion(ctx, sessionId, 2);
    assert(restored.specHash === sourceV2.specHash, 'Restored current content must equal source v2');

    await sessions.archiveSession(ctx, sessionId);
    let archivedCode: string | null = null;
    try {
      await engine.applyBatch(ctx, sessionId, {
        batchId: randomUUID(),
        expectedStateVersion: 8,
        commands: [command('SET_TOPIC', { value: 'Should not persist' })],
      });
    } catch (error) {
      archivedCode = expectCommandError(error, 'OUTREACH_COMMAND_BLOCKED').code;
    }
    assert(archivedCode, 'Archived session must reject mutation');

    const versions = await sessions.listVersions(ctx, sessionId, 200);
    const versionNumbers = versions.map((row) => row.version).sort((a, b) => a - b);
    assert(
      JSON.stringify(versionNumbers) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]),
      `Unexpected immutable version sequence: ${versionNumbers.join(',')}`,
    );

    const eventSequences = await prisma.withSystem(async (tx) =>
      tx.$queryRaw<Array<{ sequence: bigint }>>`
        SELECT sequence
        FROM outreach_events
        WHERE session_id = CAST(${sessionId} AS uuid)
        ORDER BY sequence ASC
      `,
    );
    const sequenceNumbers = eventSequences.map((row) => Number(row.sequence));
    assert(
      sequenceNumbers.every((value, index) => value === index + 1),
      `Event sequence is not contiguous: ${sequenceNumbers.join(',')}`,
    );

    const afterProtected = await protectedDigests(prisma);
    results.protectedAfter = afterProtected;
    for (const table of PROTECTED_TABLES) {
      assert(
        beforeProtected[table].count === afterProtected[table].count &&
          beforeProtected[table].digest === afterProtected[table].digest,
        `Protected table changed during Phase 2 state flow: ${table}`,
      );
    }

    results.commands = {
      goal,
      replay,
      idReuseCode,
      noOp,
      sponsor,
      criteria,
      delivery,
      concurrency: { winners: winners.length, losers: losers.length, finalVersion: 7 },
      restore,
      archivedCode,
    };
    results.proposals = {
      createdWithoutMutation: true,
      applied: { id: proposalA.id, status: appliedRow?.status },
      competing: { id: proposalB.id, status: supersededRow?.status, applyError: staleCode },
    };
    results.versions = versionNumbers;
    results.eventSequences = sequenceNumbers;
    results.final = {
      status: 'archived',
      stateVersion: restored.currentStateVersion,
      specHash: restored.specHash,
      protectedLegacyTablesUnchanged: true,
    };

    const output = process.env.OUTREACH_V3_PHASE2_FLOW_OUTPUT;
    if (output) await writeFile(output, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(results, null, 2));
    console.log('OUTREACH_V3_PHASE2_FLOW_COMPLETE');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
