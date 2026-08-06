import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  resolveMemoryPhase2Pnpm,
  runMemoryPhase2Command,
} from './lib/memory-phase2-command-runner.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '..');
const pnpm = resolveMemoryPhase2Pnpm();

interface FixtureIds {
  tenantId: string;
  proposerId: string;
  reviewerId: string;
  otherUserId: string;
  candidateId: string;
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  review_request_id: string;
  candidate_id: string;
  recipient_user_id: string;
  event_type: string;
  payload_has_forbidden: boolean;
}

async function main(): Promise<void> {
  const cleanUrl = requireDisposableUrl('MEMORY_PHASE2_CLEAN_DATABASE_URL');
  const upgradeUrl = requireDisposableUrl('MEMORY_PHASE2_UPGRADE_DATABASE_URL');
  if (databaseIdentity(cleanUrl) === databaseIdentity(upgradeUrl)) {
    throw new Error('Clean and upgrade database URLs must identify different databases.');
  }

  runPnpm(['exec', 'tsx', 'scripts/verify-memory-phase2-persistence-closeout.ts']);
  runPnpm(['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    DATABASE_URL: upgradeUrl,
  });

  await runNotificationAcceptance(cleanUrl, fixtureIds('clean'));
  await runNotificationAcceptance(upgradeUrl, fixtureIds('upgrade'));

  process.stdout.write('MEMORY_PHASE2_NOTIFICATION_CLOSEOUT_COMPLETE\n');
}

function runPnpm(args: string[], env: Record<string, string> = {}): void {
  const result = runMemoryPhase2Command({
    command: pnpm.command,
    args: [...pnpm.prefixArgs, ...args],
    cwd: apiRoot,
    env,
    shell: pnpm.shell,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function runNotificationAcceptance(
  databaseUrl: string,
  ids: FixtureIds,
): Promise<void> {
  await createNotificationWorkflow(databaseUrl, ids);
  const outbox = await assertOutboxObligations(databaseUrl, ids);
  await assertConcurrentClaims(databaseUrl, ids, outbox.length);
  await assertRecipientInAppRls(databaseUrl, ids, outbox);
}

async function createNotificationWorkflow(
  databaseUrl: string,
  ids: FixtureIds,
): Promise<void> {
  const prisma = client(databaseUrl);
  try {
    await prisma.$transaction(async (tx) => {
      await setContext(tx, ids.tenantId, ids.proposerId);
      await tx.$executeRawUnsafe(
        `INSERT INTO memory_candidate (
           id, tenant_id, proposed_by, source_kind, scope,
           payload_jsonb, provenance_jsonb, status
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'explicit_user', 'firm',
           $4::jsonb, $5::jsonb, 'pending'
         )`,
        ids.candidateId,
        ids.tenantId,
        ids.proposerId,
        JSON.stringify({
          key: 'notification-closeout:firm',
          value: 'This proposal body must never enter a notification.',
          source: 'notification_closeout',
          scope: 'firm',
          canonicalItem: {
            type: 'firm-soul',
            slug: 'notification-closeout',
            title: 'Notification Closeout',
            sections: [
              {
                key: 'test',
                heading: 'Test',
                owner: 'human',
                body: 'This section must never enter a notification.',
              },
            ],
          },
        }),
        JSON.stringify({ tool: 'memory_phase2_notification_closeout' }),
      );
    });

    await prisma.$transaction(async (tx) => {
      await setContext(tx, ids.tenantId, ids.reviewerId);
      const assigned = await tx.$executeRawUnsafe(
        `UPDATE review_request
         SET assigned_to = $1::uuid
         WHERE tenant_id = $2::uuid
           AND surface = 'memory'
           AND subject_type = 'memory_candidate'
           AND subject_id = $3
           AND status = 'pending'`,
        ids.reviewerId,
        ids.tenantId,
        ids.candidateId,
      );
      if (assigned !== 1) throw new Error('Expected initial reviewer assignment.');
    });

    await prisma.$transaction(async (tx) => {
      await setContext(tx, ids.tenantId, ids.otherUserId);
      const reassigned = await tx.$executeRawUnsafe(
        `UPDATE review_request
         SET assigned_to = $1::uuid
         WHERE tenant_id = $2::uuid
           AND surface = 'memory'
           AND subject_type = 'memory_candidate'
           AND subject_id = $3
           AND status = 'pending'`,
        ids.otherUserId,
        ids.tenantId,
        ids.candidateId,
      );
      if (reassigned !== 1) throw new Error('Expected reviewer reassignment.');
    });

    await prisma.$transaction(async (tx) => {
      await setContext(tx, ids.tenantId, ids.otherUserId);
      const changed = await tx.$executeRawUnsafe(
        `UPDATE review_request
         SET status = 'changes_needed',
             reason = 'The dispatcher must not copy this feedback.',
             decided_by = $1::uuid,
             decided_at = now()
         WHERE tenant_id = $2::uuid
           AND surface = 'memory'
           AND subject_type = 'memory_candidate'
           AND subject_id = $3
           AND status = 'pending'`,
        ids.otherUserId,
        ids.tenantId,
        ids.candidateId,
      );
      if (changed !== 1) throw new Error('Expected changes-requested transition.');
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function assertOutboxObligations(
  databaseUrl: string,
  ids: FixtureIds,
): Promise<OutboxRow[]> {
  const prisma = client(databaseUrl);
  try {
    const rows = await prisma.$queryRawUnsafe<OutboxRow[]>(
      `SELECT outbox.id::text,
              outbox.tenant_id::text,
              outbox.review_request_id::text,
              outbox.candidate_id::text,
              outbox.recipient_user_id::text,
              outbox.event_type,
              (outbox.payload_jsonb ?| ARRAY[
                'value','sections','body','reason','feedbackReason',
                'sourceExcerpt','source_excerpt'
              ]) AS payload_has_forbidden
       FROM memory_review_notification_outbox outbox
       WHERE outbox.tenant_id = $1::uuid
         AND outbox.candidate_id = $2::uuid
       ORDER BY outbox.created_at ASC`,
      ids.tenantId,
      ids.candidateId,
    );
    const events = rows.map((row) => row.event_type).sort();
    const expected = [
      'review_assigned',
      'review_changes_requested',
      'review_reassigned',
    ].sort();
    if (JSON.stringify(events) !== JSON.stringify(expected)) {
      throw new Error(`Notification event mismatch: ${JSON.stringify(events)}`);
    }
    if (rows.some((row) => row.payload_has_forbidden)) {
      throw new Error('Notification outbox copied proposal or feedback content.');
    }
    const recipients = new Map(rows.map((row) => [row.event_type, row.recipient_user_id]));
    if (recipients.get('review_assigned') !== ids.reviewerId) {
      throw new Error('Initial assignment notification targeted the wrong reviewer.');
    }
    if (recipients.get('review_reassigned') !== ids.otherUserId) {
      throw new Error('Reassignment notification targeted the wrong reviewer.');
    }
    if (recipients.get('review_changes_requested') !== ids.proposerId) {
      throw new Error('Changes-requested notification targeted the wrong proposer.');
    }
    return rows;
  } finally {
    await prisma.$disconnect();
  }
}

async function assertConcurrentClaims(
  databaseUrl: string,
  ids: FixtureIds,
  expectedCount: number,
): Promise<void> {
  const claim = async (): Promise<string[]> => {
    const prisma = client(databaseUrl);
    const leaseToken = randomUUID();
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `WITH claimable AS (
             SELECT id
             FROM memory_review_notification_outbox
             WHERE tenant_id = $1::uuid
               AND candidate_id = $2::uuid
               AND delivered_at IS NULL
               AND terminal_at IS NULL
               AND (leased_until IS NULL OR leased_until < now())
             ORDER BY created_at ASC, id ASC
             LIMIT 2
             FOR UPDATE SKIP LOCKED
           )
           UPDATE memory_review_notification_outbox AS outbox
           SET lease_token = $3::uuid,
               leased_until = now() + interval '5 minutes',
               attempts = outbox.attempts + 1,
               last_attempt_at = now()
           FROM claimable
           WHERE outbox.id = claimable.id
           RETURNING outbox.id::text AS id`,
          ids.tenantId,
          ids.candidateId,
          leaseToken,
        );
        return rows.map((row) => row.id);
      });
    } finally {
      await prisma.$disconnect();
    }
  };

  const [left, right] = await Promise.all([claim(), claim()]);
  const all = [...left, ...right];
  if (all.length !== expectedCount || new Set(all).size !== expectedCount) {
    throw new Error(`Concurrent notification claim duplicated or lost work: ${JSON.stringify(all)}`);
  }
}

async function assertRecipientInAppRls(
  databaseUrl: string,
  ids: FixtureIds,
  outbox: OutboxRow[],
): Promise<void> {
  const assigned = outbox.find((row) => row.event_type === 'review_assigned');
  if (!assigned) throw new Error('Missing assignment outbox row.');
  const prisma = client(databaseUrl);
  try {
    await prisma.$transaction(async (tx) => {
      await setContext(tx, ids.tenantId, ids.reviewerId);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await tx.$executeRawUnsafe(
          `INSERT INTO memory_review_in_app_notification (
             tenant_id, recipient_user_id, review_request_id, candidate_id,
             event_type, title, metadata_jsonb
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             'review_assigned', 'Notification Closeout',
             jsonb_build_object(
               'workflow', 'memory_review_v2',
               'schemaVersion', 1,
               'reviewRequestId', $3::uuid,
               'candidateId', $4::uuid,
               'eventType', 'review_assigned',
               'candidateKind', 'standard',
               'requiresCurrentAuthorization', true
             )
           )
           ON CONFLICT (
             tenant_id, recipient_user_id, review_request_id, event_type
           ) DO NOTHING`,
          ids.tenantId,
          ids.reviewerId,
          assigned.review_request_id,
          ids.candidateId,
        );
      }
      const count = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count
         FROM memory_review_in_app_notification
         WHERE tenant_id = $1::uuid
           AND recipient_user_id = $2::uuid
           AND review_request_id = $3::uuid`,
        ids.tenantId,
        ids.reviewerId,
        assigned.review_request_id,
      );
      if (count[0]?.count !== 1) throw new Error('In-app notification was not idempotent.');
    });

    await prisma.$transaction(async (tx) => {
      await setContext(tx, ids.tenantId, ids.otherUserId);
      const rows = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count
         FROM memory_review_in_app_notification
         WHERE tenant_id = $1::uuid
           AND recipient_user_id = $2::uuid`,
        ids.tenantId,
        ids.reviewerId,
      );
      if ((rows[0]?.count ?? -1) !== 0) {
        throw new Error('Another tenant member could read the recipient notification.');
      }
    });

    let bodyRejected = false;
    try {
      await prisma.$transaction(async (tx) => {
        await setContext(tx, ids.tenantId, ids.reviewerId);
        await tx.$executeRawUnsafe(
          `INSERT INTO memory_review_in_app_notification (
             tenant_id, recipient_user_id, review_request_id, candidate_id,
             event_type, title, metadata_jsonb
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             'review_reassigned', 'Forbidden Body Probe',
             jsonb_build_object('reason', 'must not persist')
           )`,
          ids.tenantId,
          ids.reviewerId,
          assigned.review_request_id,
          ids.candidateId,
        );
      });
    } catch {
      bodyRejected = true;
    }
    if (!bodyRejected) throw new Error('In-app notification accepted forbidden feedback content.');

    await prisma.$transaction(async (tx) => {
      await setContext(tx, randomUUID(), ids.reviewerId);
      const rows = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM memory_review_in_app_notification`,
      );
      if ((rows[0]?.count ?? -1) !== 0) {
        throw new Error('Cross-tenant context could read an in-app notification.');
      }
    });
  } finally {
    await prisma.$disconnect();
  }
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

function fixtureIds(label: 'clean' | 'upgrade'): FixtureIds {
  const prefix = label === 'clean' ? '1' : '2';
  return {
    tenantId: `${prefix}1111111-1111-4111-8111-111111111111`,
    proposerId: `${prefix}2222222-2222-4222-8222-222222222222`,
    reviewerId: `${prefix}3333333-3333-4333-8333-333333333333`,
    otherUserId: `${prefix}4444444-4444-4444-8444-444444444444`,
    candidateId: `${prefix}6666666-6666-4666-8666-666666666666`,
  };
}

function requireDisposableUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const parsed = new URL(value);
  const localHost = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase());
  const databaseName = databaseNameFromUrl(parsed).toLowerCase();
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !localHost ||
    !databaseName.includes('memory_phase2')
  ) {
    throw new Error(
      `${name} must target a disposable local PostgreSQL database named with memory_phase2.`,
    );
  }
  return value;
}

function databaseIdentity(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  return `${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}/${databaseNameFromUrl(parsed).toLowerCase()}`;
}

function databaseNameFromUrl(parsed: URL): string {
  const databaseName = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((component) => decodeURIComponent(component))
    .at(-1);
  if (!databaseName) throw new Error('Disposable database URL must include a database name.');
  return databaseName;
}

function client(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
