import type { Prisma } from '@prisma/client';
import {
  aliasPlanHash,
  validateOfficialAliasReview,
  type AliasReview,
} from './hearing-alias-review.js';

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;
type Reference = { tableName: string; columnName: string; immutableGuards?: string[] };
type Tx = Prisma.TransactionClient;

/** Public hearing→bill agenda links. UNIQUE(hearing_id, bill_id): both sides of
 * a reviewed pair can legitimately link the same bill, so this table is never
 * blindly relocated like scalar reference columns. */
const BILL_LINK_TABLE = 'committee_hearing_bill';
const BILL_LINK_COLUMN = 'hearing_id';

type BillLinkRow = {
  id: string;
  hearingId: string;
  billId: string;
  congress: number;
  /** Microsecond-precise UTC text. A JS Date would truncate to milliseconds
   * and hide sub-ms evidence changes from the reviewed plan hash. */
  syncedText: string;
  /** Canonical engine-rendered row text (id|hearing_id|bill_id|congress|synced). */
  rowText: string;
  side: 'alias' | 'canonical';
  disposition: 'retained' | 'moved' | null;
};
type BillLinkDisposition = { rows: BillLinkRow[]; retained: string[]; moved: string[] };
type CountedReference = Reference & {
  source: number;
  target: number;
  /** Exact bill-link rows (only on the bill-link reference): retained vs moved
   * dispositions plus per-row content so a stable-count change still
   * invalidates the reviewed hash. */
  rows?: BillLinkRow[];
  retained?: string[];
  moved?: string[];
};

/** Inventory the exact bill-link rows of a reviewed pair and classify each
 * alias-side link: RETAINED when the canonical side already links the same
 * billId with the same Congress (the canonical link serves the same mapping),
 * MOVED when it does not. A duplicate linking the same billId under a
 * different Congress is never silently merged — the whole batch aborts. */
async function billLinkInventory(
  tx: Tx,
  aliasId: string,
  canonicalId: string,
): Promise<BillLinkDisposition> {
  const synced = `to_char(synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
  const rows = await tx.$queryRawUnsafe<Array<Omit<BillLinkRow, 'side' | 'disposition'>>>(
    `SELECT id, hearing_id AS "hearingId", bill_id AS "billId", congress,
       ${synced} AS "syncedText",
       id || '|' || hearing_id || '|' || bill_id || '|' || congress || '|' || ${synced} AS "rowText"
     FROM ${quote(BILL_LINK_TABLE)} WHERE ${BILL_LINK_COLUMN} IN ($1, $2) ORDER BY id`,
    aliasId,
    canonicalId,
  );
  const canonicalBills = new Map(
    rows.filter((row) => row.hearingId === canonicalId).map((row) => [row.billId, row]),
  );
  const retained: string[] = [];
  const moved: string[] = [];
  const classified = rows.map<BillLinkRow>((row) => {
    const side: BillLinkRow['side'] = row.hearingId === aliasId ? 'alias' : 'canonical';
    if (side === 'canonical') return { ...row, side, disposition: null };
    const equivalent = canonicalBills.get(row.billId);
    if (!equivalent) {
      moved.push(row.id);
      return { ...row, side, disposition: 'moved' };
    }
    if (equivalent.congress !== row.congress)
      throw new Error(
        `conflicting Congress on committee_hearing_bill link for bill ${row.billId} (${row.congress} vs ${equivalent.congress})`,
      );
    retained.push(row.id);
    return { ...row, side, disposition: 'retained' };
  });
  return { rows: classified, retained, moved };
}

async function referenceColumns(tx: Tx): Promise<Reference[]> {
  // Soft references are deliberate in this schema. Discover every text hearing
  // ID column in the connected schema instead of maintaining an incomplete
  // hand-written table list. Other databases retain IDs via the alias API.
  return tx.$queryRaw<Reference[]>`
    SELECT c.relname AS "tableName", a.attname AS "columnName",
      ARRAY(SELECT tr.tgname || ':' || p.proname
        FROM pg_trigger tr JOIN pg_proc p ON p.oid = tr.tgfoid
        WHERE tr.tgrelid = c.oid AND NOT tr.tgisinternal AND tr.tgenabled <> 'D'
          AND (tr.tgtype::int & 16) <> 0
          AND (tr.tgname ILIKE '%immutable%' OR p.proname ILIKE '%immutable%'
               OR tr.tgname = 'public_hearing_review_context_guard'
               OR tr.tgname ILIKE '%append_only%' OR p.proname ILIKE '%append_only%')
        ORDER BY tr.tgname) AS "immutableGuards"
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped AND t.typname IN ('text', 'varchar')
      AND (a.attname IN ('hearing_id', 'canonical_hearing_id', 'hearingId', 'canonicalHearingId')
        OR (a.attname = 'event_id' AND c.relname IN ('intel_hearing_record_run', 'intel_hearing_record_brief', 'intel_hearing_record_job')))
      AND c.relname <> 'committee_hearing'
    ORDER BY c.relname, a.attname`;
}

export async function reconcileReviewedAliases(
  tx: Tx,
  reviews: AliasReview[],
  options: { apply: boolean; expectedPlanHash?: string },
): Promise<Record<string, unknown>> {
  if (!reviews.length || reviews.length > 20) throw new Error('Supply 1–20 reviewed pairs');
  const allIds = reviews.flatMap((r) => [r.aliasId, r.canonicalId]);
  if (new Set(allIds).size !== allIds.length)
    throw new Error('Repeated IDs or alias chains are not allowed');
  if (options.apply && !/^[a-f0-9]{64}$/.test(options.expectedPlanHash ?? ''))
    throw new Error('Apply requires the reviewed dry-run plan hash');
  // This does NOT bypass RLS: PostgreSQL errors if this role would receive a
  // policy-filtered view. Never produce an incomplete tenant-reference plan.
  await tx.$executeRawUnsafe('SET LOCAL row_security = off');
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
  const references = await referenceColumns(tx);
  if (options.apply) {
    // Quiesced writers + locks prevent an old-ID reference appearing between
    // counting and relocation. Failing to acquire any lock aborts, never waits
    // indefinitely while holding application tables.
    await tx.$executeRawUnsafe('LOCK TABLE "committee_hearing" IN SHARE ROW EXCLUSIVE MODE');
    for (const table of [...new Set(references.map((r) => r.tableName))])
      await tx.$executeRawUnsafe(`LOCK TABLE ${quote(table)} IN SHARE ROW EXCLUSIVE MODE`);
  }
  const plans = [];
  for (const review of reviews) {
    const alias = await tx.committeeHearing.findUniqueOrThrow({ where: { id: review.aliasId } });
    const canonical = await tx.committeeHearing.findUniqueOrThrow({
      where: { id: review.canonicalId },
    });
    validateOfficialAliasReview(review, alias, canonical);
    const children = await tx.committeeHearing.count({ where: { canonicalHearingId: alias.id } });
    if (children)
      throw new Error('Alias source already has aliases; review the entire group separately');
    const counts: CountedReference[] = [];
    for (const ref of references) {
      const [count] = await tx.$queryRawUnsafe<Array<{ source: bigint; target: bigint }>>(
        `SELECT count(*) FILTER (WHERE ${quote(ref.columnName)} = $1) AS source,
                count(*) FILTER (WHERE ${quote(ref.columnName)} = $2) AS target
         FROM ${quote(ref.tableName)} WHERE ${quote(ref.columnName)} IN ($1, $2)`,
        alias.id,
        canonical.id,
      );
      if (count && (count.source > 0n || count.target > 0n)) {
        const counted: CountedReference = {
          ...ref,
          source: Number(count.source),
          target: Number(count.target),
        };
        // Exact bill-link rows (with microsecond synced_at) feed the plan so a
        // stable-count content change still invalidates the reviewed hash.
        if (ref.tableName === BILL_LINK_TABLE && ref.columnName === BILL_LINK_COLUMN) {
          const inventory = await billLinkInventory(tx, alias.id, canonical.id);
          counted.rows = inventory.rows;
          counted.retained = inventory.retained;
          counted.moved = inventory.moved;
        }
        counts.push(counted);
      }
    }
    plans.push({ review, alias, canonical, references: counts });
  }
  const planHash = aliasPlanHash(plans);
  const blockedOperations = plans.flatMap((plan) =>
    plan.references
      .filter(
        (ref) =>
          ref.source > 0 &&
          ((ref.immutableGuards?.length ?? 0) > 0 ||
            [
              'intel_hearing_media_permission',
              'intel_live_hearing_session',
              'intel_hearing_record_run',
              'intel_hearing_record_brief',
              'intel_hearing_record_job',
            ].includes(ref.tableName)),
      )
      .map((ref) => ({
        aliasId: plan.review.aliasId,
        table: ref.tableName,
        column: ref.columnName,
        references: ref.source,
        guards: ref.immutableGuards,
        reason:
          'Protected hearing history or queued record work requires a separately reviewed integration; this repair will not rewrite it or bypass its trigger.',
      })),
  );
  if (options.apply && options.expectedPlanHash !== planHash)
    throw new Error('Hearing data or references changed since review; produce a new dry run');
  if (options.apply && blockedOperations.length)
    throw new Error(
      `Alias reconciliation blocked by immutable references: ${blockedOperations.map((b) => `${b.table}.${b.column} (${b.references})`).join(', ')}`,
    );
  if (options.apply) {
    for (const plan of plans) {
      for (const ref of plan.references.filter((r) => r.source > 0)) {
        // The bill-link table is UNIQUE(hearing_id, bill_id): both sides of the
        // pair legitimately link the same bill. Relocate ONLY the non-overlapping
        // rows, by exact id — never the blind per-column UPDATE, which would
        // collide with the canonical side's equivalent link (23505) and abort
        // the whole batch. Retained duplicates keep their id and synced_at.
        if (ref.tableName === BILL_LINK_TABLE && ref.columnName === BILL_LINK_COLUMN) {
          for (const id of ref.moved ?? []) {
            const affected = await tx.$executeRawUnsafe(
              `UPDATE ${quote(ref.tableName)} SET ${quote(ref.columnName)} = $2
               WHERE ${quote(ref.columnName)} = $1 AND id = $3`,
              plan.review.aliasId,
              plan.review.canonicalId,
              id,
            );
            if (affected !== 1)
              throw new Error(
                `committee_hearing_bill row ${id} moved or vanished since the plan was built`,
              );
          }
          continue;
        }
        await tx.$executeRawUnsafe(
          `UPDATE ${quote(ref.tableName)} SET ${quote(ref.columnName)} = $2 WHERE ${quote(ref.columnName)} = $1`,
          plan.review.aliasId,
          plan.review.canonicalId,
        );
      }
      await tx.committeeHearing.update({
        where: { id: plan.review.aliasId },
        data: {
          canonicalHearingId: plan.review.canonicalId,
          aliasedAt: new Date(),
          aliasEvidence: JSON.parse(JSON.stringify({ planHash, ...plan })) as Prisma.InputJsonValue,
        },
      });
    }
  }
  return {
    mode: options.apply ? 'applied' : 'dry-run',
    planHash,
    plans,
    readyToApply: blockedOperations.length === 0,
    blockedOperations,
    note: 'Both hearing rows retained. Same-schema references move atomically; a uniqueness/FK conflict aborts the whole batch. Duplicate public bill links already present on the canonical side are retained in place on the alias side (same row id, billId, Congress and synced_at — the canonical link serves the same mapping); only non-overlapping bill links move. Embedded JSON and other-database links retain legacy IDs resolved by the API.',
  };
}
