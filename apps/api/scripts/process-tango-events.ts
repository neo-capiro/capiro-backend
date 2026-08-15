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
 *   1. ENQUEUE — copy `received` deliveries (P46) into `tango_event_outbox`,
 *      one row PER EVENT. Idempotent by the outbox's unique key on
 *      (delivery_id, event_index), so re-running is free and a delivery's
 *      events can never be queued twice. Each delivery's rows go in as ONE
 *      statement — deliberately NOT a transaction, which is what makes a
 *      crash mid-batch unable to leave a delivery partially enqueued without
 *      inheriting a transaction timeout. See `enqueuePendingDeliveries`'s own
 *      doc for why that distinction is the whole point (D-59).
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
 * `ON CONFLICT DO NOTHING` against the outbox's widened unique key
 * (delivery_id, event_index) is what makes this idempotent — the same
 * guarantee P46 relies on for replay, applied one layer down.
 *
 * ── EACH DELIVERY'S ROWS ARE INSERTED AS ONE STATEMENT, AND THAT IS NOT
 *    OPTIONAL ──────────────────────────────────────────────────────────────
 *
 * A prior version inserted one row per event as N separate, independent
 * `$executeRaw` calls. That created a state nothing else in this program
 * could recover from: if the process died — a crash, a task timeout, a
 * redeploy — after inserting row 0 but before rows 1..N-1, the "already
 * enqueued" check above (`o.id IS NOT NULL`) saw that *a* row existed for
 * that delivery and never revisited it. The remaining events were lost
 * PERMANENTLY: the receiver never re-delivers (delivery_id is unique there
 * too), and nothing downstream reconciles a partially-enqueued delivery.
 *
 * THE NEXT FIX WRAPPED THOSE N CALLS IN ONE `$transaction`, and an
 * independent review found that fix ALSO broken: Prisma's interactive
 * transactions carry a default 5-second timeout, measured against real
 * Postgres to bite at roughly 3000 sequential statements — a delivery well
 * under the existing 1MB webhook body limit (~152KB for 3000 minimal
 * events), so a legitimately-sized delivery could trip it. Worse than the
 * original bug: this failure is NOT transient (the same delivery fails
 * identically on every retry), and because the enqueue loop processes
 * deliveries oldest-first with no per-delivery isolation, one such delivery
 * would permanently block every delivery behind it — the whole pipeline
 * jams rather than losing one delivery's tail. Same failure shape, a fourth
 * time, introduced by the fix meant to close the third.
 *
 * THIS VERSION ELIMINATES THE FAILURE CLASS RATHER THAN MOVING ITS
 * THRESHOLD. All of a delivery's rows go in as ONE `INSERT ... SELECT FROM
 * unnest(...)` statement. Postgres executes a single statement atomically by
 * construction — no explicit transaction, no interactive-transaction
 * machinery, and therefore no interactive-transaction timeout to size a
 * batch against. It is also ONE ROUND TRIP regardless of N, so it does not
 * get slower — let alone time out — as a delivery's event count grows.
 * Raising the timeout number instead would only have moved the same cliff to
 * a different N.
 *
 * `unnest` of five ARRAYS, rather than a multi-row `VALUES (...), (...)`,
 * for a specific reason: `VALUES` binds five parameters PER ROW, and Postgres
 * caps a statement at 65535 bound parameters — which would have reintroduced
 * a hard ceiling at ~13k events, higher than the 5-second cliff but still a
 * cliff, and still inside what the 1MB body limit can deliver. Passing five
 * arrays binds five parameters TOTAL for any N, so there is no event count
 * at which this statement stops working.
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

  if (pending.length === 0) return 0;

  // A dry run must report the SAME UNIT the commit path reports, or it does not
  // predict anything. This returned `pending.length` — a count of DELIVERIES —
  // while the commit path below returns a count of EVENTS. That agreed only
  // while the outbox held one row per delivery; the per-event widening broke
  // the correspondence silently, so two deliveries carrying 3 and 2 events had
  // a dry run promising 2 and a commit writing 5.
  if (!commit) {
    return pending.reduce(
      (total, row) => total + readResourceRefs(row.payload, row.event_type).length,
      0,
    );
  }

  let enqueued = 0;
  for (const row of pending) {
    const refs = readResourceRefs(row.payload, row.event_type);
    // ONE statement for ALL of this delivery's rows, and FIVE bound parameters
    // no matter how many events it carries. Nothing wraps across deliveries:
    // each delivery's atomicity is entirely self-contained, so a later
    // delivery can never be at risk because an earlier one failed.
    await prisma.$executeRaw`
      INSERT INTO "tango_event_outbox"
        ("delivery_id", "event_index", "event_type", "resource_type", "external_id")
      SELECT * FROM unnest(
        ${refs.map(() => row.delivery_id)}::text[],
        ${refs.map((ref) => ref.eventIndex)}::int[],
        ${refs.map(() => row.event_type)}::text[],
        ${refs.map((ref) => ref.resourceType)}::text[],
        ${refs.map((ref) => ref.externalId)}::text[]
      )
      ON CONFLICT ("delivery_id", "event_index") DO NOTHING
    `;
    enqueued += refs.length;
  }
  return enqueued;
}

/**
 * Which provider resource an event refers to.
 *
 * Reads several candidate keys because the provider's payload shape is not
 * contractually fixed, and returns a NULL external id rather than guessing when
 * none is present — a null resource completes as a no-op instead of retrying
 * forever against an id that was never there.
 */
export interface ResourceRef {
  /** Position within the delivery. 0 for a single-event body. */
  eventIndex: number;
  resourceType: string;
  externalId: string | null;
}

/**
 * EVERY resource a delivery refers to, one entry per event.
 *
 * Returns a LIST because the provider's batch envelope carries an array. The
 * first version returned a single ref read from `events[0]`, so a two-event
 * delivery resolved the first opportunity, marked itself done, and silently
 * discarded the second — accepted at the receiver, dropped here. That is the
 * same failure an earlier fix was supposed to close and only narrowed.
 *
 * A body with no `events` array yields exactly one ref at index 0, which is
 * what a single-event delivery has always been.
 */
export function readResourceRefs(payload: unknown, eventType: string): ResourceRef[] {
  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  // The TRUE position within the delivery, preserved through filtering.
  //
  // A prior version filtered non-object entries out BEFORE indexing
  // (`events.filter(...).map((event, i) => ...)`), so `event_index` was the
  // position within the FILTERED list, not the delivery — `['junk', {...}]`
  // gave the real event index 0 instead of 1. That column is documented, in
  // its own migration comment and Prisma doc, as "position of this event
  // within its delivery" and is part of the idempotency key; silently
  // renumbering breaks both.
  const events = envelope.events;
  const eventList: { event: Record<string, unknown>; index: number }[] = Array.isArray(events)
    ? events.reduce<{ event: Record<string, unknown>; index: number }[]>((acc, e, index) => {
        if (typeof e === 'object' && e !== null && !Array.isArray(e)) {
          acc.push({ event: e as Record<string, unknown>, index });
        }
        return acc;
      }, [])
    : [];

  const outer =
    envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? (envelope.data as Record<string, unknown>)
      : envelope;

  const ID_KEYS = ['opportunity_id', 'opportunityId', 'resource_id', 'id', 'external_id'];
  const TYPE_KEYS = ['event_type', 'eventType'];

  // THE EVENT'S OWN TYPE WINS. This precedence was inverted before, and it
  // meant per-event classification never ran: `eventType` is the DELIVERY's
  // type, supplied by the caller from `tango_webhook_delivery.event_type`,
  // which `readEnvelope` never allows to be empty and the column CHECK
  // forbids being blank — so `eventType || <event's own type> || ''` always
  // short-circuited on the left side. A batch mixing
  // opportunity.updated/forecast.updated/entity.updated events classified
  // every one of them as whatever the delivery header said, silently.
  //
  // The fallback still matters: a single-event body whose envelope carries no
  // type key of its own (a bare `{opportunity_id: '...'}`) has nothing else to
  // classify on, so the delivery-level type is the right answer THERE.
  const classify = (source: Record<string, unknown>): string => {
    const own = TYPE_KEYS.map((k) =>
      typeof source[k] === 'string' ? (source[k] as string) : '',
    ).find(Boolean);
    const stated = own || eventType || '';
    if (stated.includes('forecast')) return 'forecast';
    if (stated.includes('entity')) return 'entity';
    return 'opportunity';
  };

  const idFrom = (source: Record<string, unknown>): string | null => {
    for (const key of ID_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return null;
  };

  if (eventList.length === 0) {
    return [{ eventIndex: 0, resourceType: classify(outer), externalId: idFrom(outer) }];
  }

  // Each event supplies its own id and type; the envelope fills only what the
  // event omits. A batch names its type per event, not on the wrapper.
  return eventList.map(({ event, index }) => {
    const merged = { ...outer, ...event };
    return {
      eventIndex: index,
      resourceType: classify(merged),
      externalId: idFrom(merged),
    };
  });
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
  /** Alerts this DRY RUN has already counted as new. Never used when committing. */
  const plannedInThisRun = new Set<string>();

  return {
    claimBatch: async (limit, leaseSeconds) => {
      if (!commit) {
        const rows = await prisma.$queryRaw<OutboxRow[]>`
          SELECT "id", "delivery_id" AS "deliveryId", "event_index" AS "eventIndex", "event_type" AS "eventType",
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
        RETURNING o."id", o."delivery_id" AS "deliveryId", o."event_index" AS "eventIndex", "event_index" AS "eventIndex", o."event_type" AS "eventType",
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
               -- CAPIRO's own identity, not the provider's. The first version
               -- wrote the TANGO opportunity id under the literal
               -- 'sam_opportunity', which is not a member of
               -- SOURCE_RECORD_TYPES at all (it belongs to
               -- tango_resource_link.local_resource_type). The canonical type
               -- for a sam_gov row is 'sam_notice' and the key is Capiro's own
               -- record id. Fixed NOW rather than later precisely because
               -- source_record_key is part of the dedupe index: correcting it
               -- after alerts exist would invalidate every fingerprint written.
               COALESCE(c."source_record_type", 'sam_notice') AS "sourceType",
               COALESCE(c."source_record_key", c."sam_opportunity_id"::text) AS "sourceRecordKey",
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
      if (!commit) {
        // Ask whether it WOULD be new, rather than assuming it would.
        //
        // Two things count as "already there": a row persisted by an earlier
        // run, and a row THIS run would already have written. The first version
        // returned true unconditionally; the second checked only the database,
        // so a dry run over a history containing the same change twice still
        // reported both as new. Both inflate the numbers an operator uses to
        // decide whether to commit, and both break the canary's two-quiet-
        // passes check.
        const key = [
          alert.tenantId,
          alert.clientId,
          alert.sourceRecordKey,
          alert.changeFingerprint,
        ].join('|');
        if (plannedInThisRun.has(key)) return false;
        const existing = await withSystem(
          prisma,
          (tx) => tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM "tango_event_alert"
          WHERE "tenant_id" = ${alert.tenantId}::uuid
            AND "client_id" = ${alert.clientId}::uuid
            AND "source_record_key" = ${alert.sourceRecordKey}
            AND "change_fingerprint" = ${alert.changeFingerprint}
        `,
        );
        const wouldBeNew = Number(existing[0]?.n ?? 0) === 0;
        if (wouldBeNew) plannedInThisRun.add(key);
        return wouldBeNew;
      }
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
