/**
 * Drain verified Tango webhook events into client alerts — Funding
 * Opportunities P48.
 *
 *   tsx scripts/process-tango-events.ts                 # dry run (default)
 *   tsx scripts/process-tango-events.ts --commit
 *   tsx scripts/process-tango-events.ts --commit --limit=200
 *
 * Two phases, in order:
 *
 *   1. ENQUEUE — copy `received` deliveries (P46) into `tango_event_outbox`.
 *      Idempotent by the outbox's unique index on delivery_id, so re-running is
 *      free and a delivery can never be queued twice.
 *   2. DRAIN — claim a leased batch, classify, fan out, alert once.
 *
 * ── Dry run is the default and writes nothing ────────────────────────────────
 *
 * Without `--commit` this reports what it WOULD enqueue and what it WOULD
 * alert, and performs no insert, no lease, and no status change. Every
 * mutating command in this program behaves this way.
 *
 * ── Where the provider refresh actually happens ──────────────────────────────
 *
 * The plan's wording is "fetch/refresh the affected resource through the
 * provider adapter". This command reads the notices Capiro already HOLDS
 * (`tango_opportunity_notice`) rather than re-fetching inline, and that is a
 * deliberate boundary, not an omission:
 *
 *   - P28's `sync-tango-opportunity-notices` already owns fetching, mapping and
 *     upserting notices, including its own checkpointing and rate handling.
 *     Re-implementing that here would give this program two upsert paths for
 *     one table, which is exactly how two sources of truth start.
 *   - The schedule therefore runs the notice sync BEFORE this command, and the
 *     sequencing — not an inline fetch — is what makes the data current.
 *
 * The honest consequence, recorded rather than hidden: if the notice sync has
 * not run since a delivery arrived, this command classifies against slightly
 * stale local state and simply finds no change yet. The event stays `done`, and
 * the next sync-then-drain cycle picks the change up. It never invents one.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import {
  type AffectedClientRow,
  type AlertToWrite,
  type EventProcessorPort,
  type OutboxRow,
  TangoEventProcessorService,
} from '../src/funding-opportunities/tango-event-processor.service.js';
import type { NoticeObservation } from '../src/funding-opportunities/opportunity-change-classifier.js';

dotenvConfig();

export interface ParsedArgs {
  commit: boolean;
  limit: number;
  leaseSeconds: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const num = (name: string, fallback: number): number => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    if (!hit) return fallback;
    const parsed = Number(hit.slice(name.length + 3));
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
  };
  return {
    commit: argv.includes('--commit'),
    limit: num('limit', 50),
    leaseSeconds: num('lease-seconds', 300),
  };
}

/**
 * Copy verified deliveries into the work queue.
 *
 * `ON CONFLICT DO NOTHING` against the outbox's unique delivery_id is what
 * makes this idempotent — the same guarantee P46 relies on for replay, applied
 * one layer down.
 */
export async function enqueuePendingDeliveries(
  prisma: PrismaClient,
  commit: boolean,
  limit: number,
): Promise<number> {
  const pending = await prisma.$queryRaw<
    { delivery_id: string; event_type: string; payload: unknown }[]
  >`
    SELECT d."delivery_id", d."event_type", d."payload"
    FROM "tango_webhook_delivery" d
    LEFT JOIN "tango_event_outbox" o ON o."delivery_id" = d."delivery_id"
    WHERE d."status" = 'received' AND o."id" IS NULL
    ORDER BY d."received_at" ASC
    LIMIT ${limit}
  `;

  if (!commit || pending.length === 0) return pending.length;

  for (const row of pending) {
    const { resourceType, externalId } = readResourceRef(row.payload, row.event_type);
    await prisma.$executeRaw`
      INSERT INTO "tango_event_outbox"
        ("delivery_id", "event_type", "resource_type", "external_id")
      VALUES (${row.delivery_id}, ${row.event_type}, ${resourceType}, ${externalId})
      ON CONFLICT ("delivery_id") DO NOTHING
    `;
  }
  return pending.length;
}

/**
 * Which provider resource an event refers to.
 *
 * Reads several candidate keys because the provider's payload shape is not
 * contractually fixed, and returns a NULL external id rather than guessing when
 * none is present — a null resource completes as a no-op instead of retrying
 * forever against an id that was never there.
 */
export function readResourceRef(
  payload: unknown,
  eventType: string,
): { resourceType: string; externalId: string | null } {
  const body =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  // DESCEND INTO A BATCH. The receiver deliberately accepts the provider's
  // `{ timestamp, events: [...] }` shape (see tango-webhook.service.ts), but
  // this function only ever looked at the top level and `data`. A batch
  // delivery therefore resolved to `externalId: null`, which the processor
  // treats as a legitimate no-op and marks DONE — so the delivery was accepted
  // with a 202, queued, and silently discarded. No alert, no error, no
  // quarantine. Accepting a shape at one layer and dropping it at the next is
  // worse than rejecting it outright.
  const events = body.events;
  const firstEvent =
    Array.isArray(events) &&
    events.length > 0 &&
    typeof events[0] === 'object' &&
    events[0] !== null &&
    !Array.isArray(events[0])
      ? (events[0] as Record<string, unknown>)
      : null;

  const envelope =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : body;

  // Top level wins where it states an id; the first event fills the gap.
  const data = firstEvent ? { ...firstEvent, ...envelope } : envelope;

  // Prefer the EVENT's own type when the envelope carries none — a batch names
  // its type per event, not on the wrapper.
  const typeSource =
    eventType ||
    (typeof firstEvent?.event_type === 'string' ? firstEvent.event_type : '') ||
    (typeof firstEvent?.eventType === 'string' ? firstEvent.eventType : '');

  const resourceType = typeSource.includes('forecast')
    ? 'forecast'
    : typeSource.includes('entity')
      ? 'entity'
      : 'opportunity';

  for (const key of ['opportunity_id', 'opportunityId', 'resource_id', 'id', 'external_id']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return { resourceType, externalId: value.trim() };
    }
  }
  return { resourceType, externalId: null };
}

/**
 * Run one unit of work in SYSTEM context.
 *
 * THIS SCRIPT CANNOT FUNCTION WITHOUT IT, and the first version did not have
 * it. `client_funding_opportunity` and `tango_event_alert` are both RLS ENABLED
 * and FORCED. A bare `PrismaClient` sets neither `app.current_tenant` nor
 * `app.bypass_rls`, so as the real application role:
 *
 *   - `findAffectedClients` returns ZERO rows — fan-out finds nobody;
 *   - `insertAlertIfNew` raises `new row violates row-level security policy`,
 *     which the processor counts as a failure: five retries, then quarantine.
 *
 * The drain is CROSS-TENANT by nature — it must consider every tenant that
 * saved an opportunity — so a per-tenant GUC is the wrong tool and system
 * context is the right one. Every other drain and backfill in this repo does
 * exactly this (`drain-pe-change-outbox.ts`, `drain-identity-outbox.ts`,
 * `bootstrap-tenant.ts`, and a dozen more).
 *
 * Why it was invisible: the CI workflow provisions `POSTGRES_USER: postgres`,
 * a SUPERUSER, which bypasses RLS even under FORCE — so the migration
 * rehearsal could never surface it. The unit tests drive an in-memory
 * `EventProcessorPort` double and never touch a database at all.
 *
 * Set only inside the transaction (`is_local = true`), so it cannot leak to
 * another statement on a pooled connection.
 */
function withSystem<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return fn(tx);
  });
}

/** Prisma-backed port. Mirrors `opportunity-timeline.service.ts`'s own mapping. */
function buildPort(prisma: PrismaClient, commit: boolean): EventProcessorPort {
  return {
    claimBatch: async (limit, leaseSeconds) => {
      if (!commit) {
        const rows = await prisma.$queryRaw<OutboxRow[]>`
          SELECT "id", "delivery_id" AS "deliveryId", "event_type" AS "eventType",
                 "resource_type" AS "resourceType", "external_id" AS "externalId", "attempts"
          FROM "tango_event_outbox"
          WHERE "status" = 'pending'
          ORDER BY "created_at" ASC
          LIMIT ${limit}
        `;
        return rows;
      }
      // FOR UPDATE SKIP LOCKED inside a CTE feeding the UPDATE: several
      // processors claim disjoint batches without blocking each other.
      //
      // RECLAIMS EXPIRED LEASES, which the first version did not. It selected
      // `status = 'pending'` and then set `'processing'` — so nothing ever
      // selected a `'processing'` row again and the `lease_until` predicate was
      // dead code. A processor that died mid-batch left its rows in
      // `'processing'` FOREVER: never retried, never quarantined, never
      // surfaced. The migration's own comment promised the opposite ("a crashed
      // processor's row becomes eligible again when its lease expires").
      //
      // A row is claimable when it is pending, OR when it is processing and its
      // lease has expired — which is exactly what a lease is for.
      return prisma.$queryRaw<OutboxRow[]>`
        WITH claimed AS (
          SELECT "id" FROM "tango_event_outbox"
          WHERE (
                  "status" = 'pending'
                  OR ("status" = 'processing' AND "lease_until" IS NOT NULL AND "lease_until" < now())
                )
          ORDER BY "created_at" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "tango_event_outbox" o
        SET "status" = 'processing',
            "lease_until" = now() + make_interval(secs => ${leaseSeconds}::int),
            "last_attempted_at" = now(),
            "updated_at" = now()
        FROM claimed
        WHERE o."id" = claimed."id"
        RETURNING o."id", o."delivery_id" AS "deliveryId", o."event_type" AS "eventType",
                  o."resource_type" AS "resourceType", o."external_id" AS "externalId", o."attempts"
      `;
    },

    refreshAndReadNotices: async (_resourceType, externalId): Promise<NoticeObservation[]> => {
      // See the header: P28's sync owns fetching. This reads what is held.
      const rows = await prisma.tangoOpportunityNotice.findMany({
        where: { tangoOpportunityId: externalId },
        orderBy: [{ postedDate: 'asc' }, { tangoNoticeId: 'asc' }],
        take: 500,
        select: {
          tangoNoticeId: true,
          title: true,
          descriptionSha256: true,
          postedDate: true,
          providerUpdatedAt: true,
          responseDeadline: true,
          active: true,
          setAside: true,
          naicsCode: true,
          pscCode: true,
          attachmentCount: true,
          sourceUrl: true,
          contentHash: true,
        },
      });
      return rows.map(({ descriptionSha256, ...rest }) => ({
        ...rest,
        descriptionHash: descriptionSha256,
      }));
    },

    findAffectedClients: async (sourceRecordKey): Promise<AffectedClientRow[]> => {
      // Deliberately cross-tenant: fan-out must consider every tenant that saved
      // this opportunity. Each resulting alert is stamped with the tenant of the
      // ROW it came from, and `tango_event_alert` is RLS ENABLED and FORCED, so
      // a cross-tenant leak is impossible in both directions.
      //
      // Bridged through `tango_opportunity_notice`, which already carries BOTH
      // ids, rather than through a separate crosswalk table — one fewer join and
      // one fewer thing that can be out of date.
      return withSystem(
        prisma,
        (tx) => tx.$queryRaw<AffectedClientRow[]>`
        SELECT DISTINCT
               c."tenant_id"      AS "tenantId",
               c."client_id"      AS "clientId",
               COALESCE(c."source_record_type", 'sam_opportunity') AS "sourceType",
               ${sourceRecordKey}::text AS "sourceRecordKey",
               c."pipeline_stage"  AS "pipelineStage",
               c."workflow_status" AS "workflowStatus",
               c."human_decision"  AS "humanDecision"
        FROM "client_funding_opportunity" c
        WHERE c."sam_opportunity_id" IN (
          SELECT n."sam_opportunity_id"
          FROM "tango_opportunity_notice" n
          WHERE n."tango_opportunity_id" = ${sourceRecordKey}
            AND n."sam_opportunity_id" IS NOT NULL
        )
      `,
      );
    },

    /**
     * Insert one alert, or no-op on the dedupe index.
     *
     * ON CONFLICT names the COLUMN LIST, not the constraint. This matters and
     * was a real bug: `tango_event_alert_dedupe_uniq` is a unique INDEX
     * (`CREATE UNIQUE INDEX` / Prisma `@@unique`), and Postgres'
     * `ON CONFLICT ON CONSTRAINT <name>` resolves only real CONSTRAINTS —
     * against an index it raises `constraint "..." does not exist`.
     *
     * The first version used the constraint form, so this threw on EVERY
     * insert: the drain would have retried each event five times, quarantined
     * it, and written no alert at all. Every unit test still passed, because
     * they drive the service against an in-memory double and never execute
     * this SQL. Found only by running it against real Postgres, and the CI
     * migration job now executes the statement itself rather than asserting
     * the index exists — those are different claims.
     */
    insertAlertIfNew: async (alert: AlertToWrite): Promise<boolean> => {
      if (!commit) return true;
      const inserted = await withSystem(
        prisma,
        (tx) => tx.$executeRaw`
        INSERT INTO "tango_event_alert"
          ("tenant_id", "client_id", "source_type", "source_record_key",
           "change_dimension", "severity", "change_fingerprint", "evidence_jsonb",
           "before_value", "after_value", "pipeline_stage_at_alert",
           "source_observed_at", "delivery_id")
        VALUES
          (${alert.tenantId}::uuid, ${alert.clientId}::uuid, ${alert.sourceType},
           ${alert.sourceRecordKey}, ${alert.changeDimension}, ${alert.severity},
           ${alert.changeFingerprint}, ${JSON.stringify(alert.evidenceJsonb)}::jsonb,
           ${alert.beforeValue}, ${alert.afterValue}, ${alert.pipelineStageAtAlert},
           ${alert.sourceObservedAt}, ${alert.deliveryId})
        ON CONFLICT ("tenant_id", "client_id", "source_record_key", "change_fingerprint")
        DO NOTHING
      `,
      );
      return inserted > 0;
    },

    markDone: async (id) => {
      if (!commit) return;
      await prisma.$executeRaw`
        UPDATE "tango_event_outbox"
        SET "status" = 'done', "completed_at" = now(), "updated_at" = now(), "lease_until" = NULL
        WHERE "id" = ${id}::uuid
      `;
    },

    markFailed: async (id, attempts, error) => {
      if (!commit) return;
      await prisma.$executeRaw`
        UPDATE "tango_event_outbox"
        SET "status" = 'pending', "attempts" = ${attempts}, "last_error" = ${error},
            "lease_until" = NULL, "updated_at" = now()
        WHERE "id" = ${id}::uuid
      `;
    },

    markQuarantined: async (id, error) => {
      if (!commit) return;
      await prisma.$executeRaw`
        UPDATE "tango_event_outbox"
        SET "status" = 'quarantined', "last_error" = ${error}, "completed_at" = now(),
            "lease_until" = NULL, "updated_at" = now()
        WHERE "id" = ${id}::uuid
      `;
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const enqueued = await enqueuePendingDeliveries(prisma, args.commit, args.limit);
    const service = new TangoEventProcessorService(buildPort(prisma, args.commit));
    const summary = await service.processBatch(args.limit, args.leaseSeconds);

    console.log(
      JSON.stringify({ mode: args.commit ? 'commit' : 'dry-run', enqueued, ...summary }, null, 2),
    );
    if (!args.commit) {
      console.log('DRY RUN — nothing was written. Re-run with --commit to apply.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

const invoked = process.argv[1] ?? '';
if (invoked.includes('process-tango-events')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'Unknown failure');
    process.exitCode = 1;
  });
}
