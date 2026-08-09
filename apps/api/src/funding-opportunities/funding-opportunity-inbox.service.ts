import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OPPORTUNITY_SOURCES } from './funding-opportunities.types.js';
import { readSourceRecordId } from './funding-opportunity-identity.js';

/**
 * The cross-client triage inbox: what a government-affairs team needs to look at,
 * across every client they can see, in one bounded list.
 *
 * WHY THIS IS NOT THE EXISTING LIST ENDPOINT
 * -----------------------------------------
 * `GET /opportunities` answers "what is in the catalog", one row per SOURCE
 * record, and it needs a client to score against. That is a research tool. It
 * cannot answer "what needs my attention today" because the default experience it
 * produces is a raw federal catalog with no client selected — which is the thing
 * this program exists to replace.
 *
 * The inbox returns one row per client-opportunity DECISION CONTEXT, which is a
 * row of `client_funding_opportunity`. That table already is the decision record:
 * it carries the workflow status, the human decision, the owner and the source
 * snapshot. Reading from it is what makes the inbox cheap — the alternative,
 * scoring every visible client against every source row on request, is a
 * clients x opportunities product per page view.
 *
 * WHY IT READS SNAPSHOTS, NOT THE LIVE CATALOG
 * -------------------------------------------
 * `responseDeadlineSnapshot`, `sourceStatusSnapshot` and `sourceActiveSnapshot`
 * are written by the producers and the lifecycle pass. Sorting and filtering on
 * them means the inbox needs no join to `federal_grant` / `sam_opportunity` to
 * decide what to show, so one query serves a page regardless of how many distinct
 * sources it spans. Titles ARE joined, batched per page, because a row with no
 * title is not usable — but nothing in the ordering depends on that join.
 *
 * A stale snapshot is reported through `freshness`, never by hiding rows. A source
 * rail that failed last night must not turn into an empty inbox.
 */

export const INBOX_FILTERS = [
  'needs_review',
  'pursuing',
  'deadlines',
  'recently_changed',
  'monitoring',
  'passed',
] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/**
 * The rails the inbox can be NARROWED TO, and the rails an inbox row can
 * report itself as (P26).
 *
 * ── Why this is a third vocabulary, not a widening of an existing one ────────
 *
 * `OPPORTUNITY_SOURCES` gates the CATALOG: `GET /opportunities`,
 * `GET /opportunities/:source/:id`, every write route's `:source` segment, and
 * every DTO that validates one. Widening THAT list is what makes a source
 * requestable as a `FundingOpportunity` — a scored record with money, an
 * eligibility determination and a response deadline. A forecast has none of
 * those three (see `forecast-opportunity-read.service.ts`), so it must never
 * be servable as one, and `OPPORTUNITY_SOURCES` stays exactly two entries
 * wide. `funding-opportunity-identity.spec.ts` pins that.
 *
 * The INBOX is a different question. It reads `client_funding_opportunity`,
 * whose `source` CHECK constraint has admitted `'agency_forecast'` since P13,
 * and it has ALWAYS returned a forecast-sourced row when one existed — no
 * source predicate excludes what the caller did not ask about, and P25 added
 * the forecast title/agency lookup that makes such a row render honestly.
 * What was missing was (1) a caller's ability to say "show me only the
 * forecasts" and (2) a row's ability to SAY it is a forecast: `InboxRow.source`
 * was typed `OpportunitySource` while the service cast a raw column into it,
 * so a forecast row claimed to be `grants_gov` or `sam_gov` at the type level.
 * That was a real, if dormant, defect — a UI switching on `row.source` had no
 * legal value to switch to.
 */
export const INBOX_SOURCES = [...OPPORTUNITY_SOURCES, 'agency_forecast', 'dibbs'] as const;
export type InboxSource = (typeof INBOX_SOURCES)[number];

/** `INBOX_SOURCES` entries that are not also an `OpportunitySource`. */
export const FORECAST_INBOX_SOURCE = 'agency_forecast' as const;

/**
 * The DLA bid-board rail (P41 part 2).
 *
 * Added here and NOT to `OPPORTUNITY_SOURCES`, for the reason the block above
 * gives: widening that list would make a DIBBS row requestable as a
 * `FundingOpportunity` — a scored record with money, an eligibility
 * determination and a response deadline. A bid-board line item has none of
 * those three. It has a quantity, a unit of issue and a closing date, and its
 * recommendation comes from `dibbs-relevance.ts`, which is a different function
 * with a different vocabulary. `funding-opportunity-identity.spec.ts` pins
 * `OPPORTUNITY_SOURCES` at two entries and must keep passing.
 *
 * Nothing new was needed in the database for this. P13's generic identity
 * bridge already anticipated it: `client_funding_opportunity_source_chk` has
 * admitted `'dibbs'` since `20260820010000_funding_opportunity_generic_source`,
 * and `SOURCE_RECORD_TYPES.dibbs` is already `'dibbs_solicitation'`. This is
 * the opposite of D-63's `tango_sync_checkpoint.resource_type`, which had to be
 * worked around because no migration ever widened it — worth noting, because
 * the two look identical from a distance and only one of them is a blocker.
 */
export const DIBBS_INBOX_SOURCE = 'dibbs' as const;

export const INBOX_PAGE_SIZE = 50;
export const INBOX_MAX_PAGE_SIZE = 200;

/**
 * Which column each filter sorts by, and in which direction.
 *
 * Every filter has a DIFFERENT natural order — a deadline queue sorted by row id
 * is useless — so the cursor is compound: `(sortValue, id)`. `id` is the
 * tiebreaker that makes the order TOTAL, which is what stops a page boundary
 * between two rows sharing a deadline from repeating or skipping one.
 */
export const FILTER_SORT: Readonly<
  Record<InboxFilter, { column: 'responseDeadlineSnapshot' | 'updatedAt'; direction: 'asc' | 'desc' }>
> = Object.freeze({
  // Soonest deadline first: an undecided row with a deadline next week outranks one
  // closing in a year.
  needs_review: { column: 'responseDeadlineSnapshot', direction: 'asc' },
  pursuing: { column: 'responseDeadlineSnapshot', direction: 'asc' },
  deadlines: { column: 'responseDeadlineSnapshot', direction: 'asc' },
  monitoring: { column: 'responseDeadlineSnapshot', direction: 'asc' },
  // Most recently touched first — the point of the tab is what moved.
  recently_changed: { column: 'updatedAt', direction: 'desc' },
  // A passed row is history; most recent decision first.
  passed: { column: 'updatedAt', direction: 'desc' },
});

/**
 * The source-stated facts an AGENCY FORECAST row carries and a grant/SAM row
 * does not (P26). Null on every other rail.
 *
 * Deliberately holds no `responseDeadline`, no `eligibility` and no
 * `estimatedValue`: a forecast is an agency's own statement of what it expects
 * to buy, not a competition anybody can respond to yet. Every field here is
 * verbatim from `tango_procurement_forecast`, and null means the provider
 * stated nothing — never zero, and never "no".
 */
export interface InboxForecastFacts {
  /**
   * The agency's own rough estimate of when it expects to award. A DATE with no
   * time component, and NEVER a response deadline — there is nothing to respond
   * to. Null when the provider stated none.
   */
  anticipatedAwardDate: string | null;
  /**
   * ALWAYS NULL, and a fact about the source rather than a gap here: this
   * provider resource carries no anticipated-solicitation date at all
   * (decision-log D-45 enumerates the resource's real fields). Present as an
   * explicit null so the UI can say "not provided by the source" instead of
   * silently omitting a field the plan asks for.
   */
  anticipatedSolicitationDate: null;
  /** Free text, e.g. "Q3 FY27". Not a date, and never parsed into one. */
  estimatedPeriod: string | null;
  fiscalYear: number | null;
  /** The agency system the forecast came from, e.g. an APFS instance. */
  sourceSystem: string | null;
  /** The provider's own lifecycle word. Never rewritten into "open"/"closed". */
  status: string | null;
  /** `false` = the agency withdrew or closed it out. `null` = never stated. */
  isActive: boolean | null;
  /** When Capiro last observed this forecast. Freshness, not a source fact. */
  lastSyncedAt: string | null;
  /** The provider's own last-touched stamp, when it states one. */
  providerModifiedAt: string | null;
}

/**
 * The source-stated facts a DIBBS bid-board row carries and no other rail does
 * (P41 part 2). Null on every other rail.
 *
 * Holds no `estimatedValue` and no `eligibility`: `tango_dibbs_solicitation`
 * states neither, and a bid-board item's money is whatever the supplier quotes.
 * Every field is verbatim from that table, and null means the provider stated
 * nothing — never zero, and never "no".
 *
 * `quantity` is a STRING because the column is NUMERIC(18,4) and a value near
 * the top of that range exceeds 2^53. P40's mapper takes the provider's exact
 * digits precisely to avoid a float round-trip, and turning it into a JS number
 * here would undo that on the last step before the screen.
 */
export interface InboxDibbsFacts {
  /** `'rfq' | 'rfp'`. An award is never a workflow row — awards are informational and live in their own table. */
  documentType: string;
  solicitation: string;
  /** The provider's own display spelling, when it gave one. Never parsed. */
  solicitationFormatted: string | null;
  nsn: string | null;
  partNumber: string | null;
  nomenclature: string | null;
  /** RFQ only, as an exact decimal string. Null on an RFP, which states none. */
  quantity: string | null;
  /** RFQ only. A quantity without its unit is meaningless, so P40 drops the pair rather than inventing a unit. */
  unitOfIssue: string | null;
  /** RFQ only. */
  setAside: string | null;
  /** RFP only. */
  buyerCode: string | null;
  /** Calendar day, no time component — the column is a DATE. */
  closesDate: string | null;
  /** The provider's own open/closed judgement. `null` = never stated, and never rewritten into "open". */
  isOpen: boolean | null;
  documentUrl: string | null;
  /** RFP only. */
  techDocsUrl: string | null;
  /** When Capiro last observed this item. Freshness, not a source fact. */
  lastSyncedAt: string | null;
}

export interface InboxRow {
  /** The workflow row id — the stable identity of this decision context. */
  id: string;
  client: { id: string; name: string };
  /**
   * The rail this decision context belongs to, INCLUDING `agency_forecast`
   * (P26). Widened from `OpportunitySource` because the service always could
   * emit a forecast row and the narrower type made that unrepresentable — see
   * {@link INBOX_SOURCES}.
   */
  source: InboxSource;
  sourceRecordId: string;
  title: string;
  agency: string | null;
  /** Populated ONLY for `agency_forecast` rows. Null on every other rail. */
  forecast: InboxForecastFacts | null;
  /** Populated ONLY for `dibbs` rows. Null on every other rail. */
  dibbs: InboxDibbsFacts | null;
  /** From the snapshot, so the inbox never blocks on a catalog join to sort. */
  responseDeadline: string | null;
  daysUntilDeadline: number | null;
  workflowStatus: string;
  humanDecision: string | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
  owner: { userId: string; name: string | null; email: string | null } | null;
  relevanceScore: number | null;
  eligibility: { state: string | null; reason: string | null };
  /** True when the producer stopped suggesting this but a human decision stands. */
  noLongerSuggested: boolean;
  /** True when the SOURCE has closed since it was last observed. */
  sourceClosed: boolean;
  updatedAt: string;
}

export interface InboxResponse {
  filter: InboxFilter;
  /**
   * Echo of the client narrowing actually applied, or null for the cross-client
   * inbox.
   *
   * ECHOED rather than assumed, because the service DROPS a `clientId` the actor
   * cannot see (see `list`). A UI that assumed its own request parameter took
   * effect would render "Acme Defense · no rows in this queue" for a walled client
   * the reader is not allowed to know exists — which both lies about the queue and
   * confirms the client's existence.
   */
  clientId: string | null;
  /**
   * Echo of the source narrowing applied, or null for every rail.
   *
   * Source is a FILTER here, never the top-level model. The catalog page made
   * "Grants" and "Government contracts" primary tabs, which framed the work as
   * "which rail am I reading" instead of "what needs deciding" — and it meant a
   * deadline in three days on the other rail was one click away from invisible.
   */
  source: InboxSource | null;
  rows: InboxRow[];
  /** Opaque. Pass back verbatim; never construct one client-side. */
  nextCursor: string | null;
  pageSize: number;
  /**
   * Per-filter counts, so tabs can show a number without a second round trip.
   *
   * Narrowed by `clientId` when one is applied: a tab badge that counted every
   * client while the list below it showed one would read as a broken filter.
   */
  counts: Record<InboxFilter, number>;
  /**
   * Per-filter counts across EVERY visible client, present only when `clientId`
   * narrows the view.
   *
   * This is what lets an empty state tell "this client has nothing in this queue"
   * apart from "nobody has anything in this queue" — two different problems, and
   * the first one is the reader's cue to clear the client filter rather than go
   * looking for a broken producer.
   */
  countsAllClients: Record<InboxFilter, number> | null;
  /**
   * Non-null when a count could not be read. The counts then hold -1 rather than
   * 0, because "we could not count" and "there are none" are different facts and
   * a zero badge on a full queue is the more dangerous of the two.
   */
  countsUnavailableReason: string | null;
  generatedAt: string;
}

/** `(sortValue, id)`. Opaque to callers; base64 so nobody hand-builds one. */
interface InboxCursor {
  s: string | null;
  i: string;
}

export function encodeInboxCursor(sortValue: Date | null, id: string): string {
  const payload: InboxCursor = { s: sortValue ? sortValue.toISOString() : null, i: id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeInboxCursor(raw: string): InboxCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Malformed cursor. Pass back the nextCursor value verbatim.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as InboxCursor).i !== 'string' ||
    !['string', 'object'].includes(typeof (parsed as InboxCursor).s)
  ) {
    throw new BadRequestException('Malformed cursor. Pass back the nextCursor value verbatim.');
  }
  const cursor = parsed as InboxCursor;
  if (cursor.s != null && Number.isNaN(new Date(cursor.s).getTime())) {
    throw new BadRequestException('Malformed cursor. Pass back the nextCursor value verbatim.');
  }
  return cursor;
}

/**
 * The six filters, as WHERE fragments.
 *
 * A pure exported function, not a private method, so the predicates can be
 * asserted DIRECTLY. Emulating Prisma's ordering in a hand-written double and then
 * checking pagination against that emulation proves the emulation works, not the
 * query — so the correctness argument rests on these predicates being right, and
 * they are tested as data.
 *
 * `needs_review` is the default and the only one defined by an ABSENCE: a producer
 * suggestion nobody has decided on. It deliberately excludes rows whose source has
 * been observed closed — asking somebody to review a closed opportunity wastes the
 * attention the inbox exists to direct.
 */
export function buildInboxFilterWhere(
filter: InboxFilter,
): Prisma.ClientFundingOpportunityWhereInput {
  switch (filter) {
    case 'needs_review':
      return {
        humanDecision: null,
        workflowStatus: { in: ['suggested', 'saved'] },
        NOT: { sourceActiveSnapshot: false },
      };
    case 'pursuing':
      return { OR: [{ workflowStatus: 'pursuing' }, { humanDecision: 'pursue' }] };
    case 'monitoring':
      return { humanDecision: 'monitor' };
    case 'passed':
      return { humanDecision: 'pass' };
    case 'deadlines':
      // A dated, still-open row somebody has not passed on.
      return {
        responseDeadlineSnapshot: { not: null },
        NOT: [{ sourceActiveSnapshot: false }, { humanDecision: 'pass' }],
      };
    case 'recently_changed':
      // The lifecycle pass touches `updatedAt` when a source fact moves, so this
      // is "what the sources did", not "what we did".
      return { NOT: { humanDecision: 'pass' } };
  }
}

export type InboxSort = {
column: 'responseDeadlineSnapshot' | 'updatedAt';
direction: 'asc' | 'desc';
};

/**
 * Client ids one user may see, as an ALLOW-LIST (not an exclusion list).
 *
 * A walled client is visible only to a user with an explicit
 * `ClientMemoryAccess` grant. Fail-closed by construction: a walled client with
 * zero grants is invisible to everyone, admins included.
 *
 * A positive allow-list rather than a `NOT IN`, because an exclusion list
 * silently opens up the moment a new kind of wall appears — the allow-list has
 * to be widened deliberately to let anything new through.
 *
 * Exported (P26) so every Funding Opportunities read that scopes to a client
 * shares ONE implementation of this rule. `FundingOpportunityInboxService`
 * calls it for the cross-client list; `ForecastOpportunityReadService` calls it
 * for a single-record read.
 */
export async function readVisibleClientIds(
  tx: Prisma.TransactionClient,
  tenantId: string,
  actorUserId: string,
): Promise<string[]> {
  const [clients, grants] = await Promise.all([
    tx.client.findMany({
      where: { tenantId, status: { not: 'archived' }, profileStatus: 'ACTIVE' },
      select: { id: true, memoryWall: true },
    }),
    tx.clientMemoryAccess.findMany({
      where: { tenantId, userId: actorUserId },
      select: { clientId: true },
    }),
  ]);
  const granted = new Set(grants.map((g) => g.clientId));
  return clients.filter((c) => !c.memoryWall || granted.has(c.id)).map((c) => c.id);
}

/** The `tango_procurement_forecast` columns {@link toInboxForecastFacts} reads. */
export interface ForecastFactRow {
  anticipatedAwardDate: Date | null;
  estimatedPeriod: string | null;
  fiscalYear: number | null;
  sourceSystem: string | null;
  status: string | null;
  isActive: boolean | null;
  lastSyncedAt: Date | null;
  providerModifiedAt: Date | null;
}

/**
 * One forecast row's source facts, for an inbox card (P26).
 *
 * A pure exported function rather than an inline object literal so the
 * date-shape decision below is assertable on its own.
 *
 * `anticipatedAwardDate` is a Postgres DATE and is serialized as a DATE —
 * `YYYY-MM-DD`, not a full timestamp. `toISOString()` on a UTC-midnight Date
 * would render `2027-03-01T00:00:00.000Z`, which a browser in any negative-offset
 * timezone then displays as 28 February: an agency's stated award month shifted
 * by a day for every user west of Greenwich. The two genuinely-instant fields
 * below (`lastSyncedAt`, `providerModifiedAt`) are TIMESTAMPTZ and keep their
 * full ISO form, because for those the time of day is real information.
 */
export function toInboxForecastFacts(row: ForecastFactRow): InboxForecastFacts {
  return {
    anticipatedAwardDate: row.anticipatedAwardDate
      ? row.anticipatedAwardDate.toISOString().slice(0, 10)
      : null,
    // Explicit null, never omitted — see the field's own doc.
    anticipatedSolicitationDate: null,
    estimatedPeriod: row.estimatedPeriod ?? null,
    fiscalYear: row.fiscalYear ?? null,
    sourceSystem: row.sourceSystem ?? null,
    status: row.status ?? null,
    isActive: row.isActive ?? null,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    providerModifiedAt: row.providerModifiedAt ? row.providerModifiedAt.toISOString() : null,
  };
}

/** The `tango_dibbs_solicitation` columns {@link toInboxDibbsFacts} reads. */
export interface DibbsFactRow {
  documentType: string;
  solicitation: string;
  solicitationFormatted: string | null;
  nsn: string | null;
  partNumber: string | null;
  nomenclature: string | null;
  quantity: Prisma.Decimal | null;
  unitOfIssue: string | null;
  setAside: string | null;
  buyerCode: string | null;
  closesDate: Date | null;
  isOpen: boolean | null;
  documentUrl: string | null;
  techDocsUrl: string | null;
  lastSyncedAt: Date | null;
}

/**
 * One bid-board row's source facts, for an inbox card (P41 part 2).
 *
 * `closesDate` is a Postgres DATE and is serialized as `YYYY-MM-DD`, for exactly
 * the reason `toInboxForecastFacts` gives: `toISOString()` on a UTC-midnight
 * Date renders a full timestamp that a browser west of Greenwich displays as the
 * previous day. On a forecast that shifts an agency's estimated award month; on
 * a bid board it moves a QUOTE DEADLINE a day earlier for every user in a
 * negative-offset timezone, which is the one field a supplier acts on.
 *
 * `quantity` is stringified via `toString()`, never `Number()`. The column is
 * NUMERIC(18,4) and P40's mapper deliberately passes the provider's exact digits
 * through as a string to avoid a float round-trip; coercing to a JS number here
 * would reintroduce that loss on the last hop before the screen.
 */
export function toInboxDibbsFacts(row: DibbsFactRow): InboxDibbsFacts {
  return {
    documentType: row.documentType,
    solicitation: row.solicitation,
    solicitationFormatted: row.solicitationFormatted ?? null,
    nsn: row.nsn ?? null,
    partNumber: row.partNumber ?? null,
    nomenclature: row.nomenclature ?? null,
    // Exact digits, not a float. See the function doc.
    quantity: row.quantity != null ? row.quantity.toString() : null,
    unitOfIssue: row.unitOfIssue ?? null,
    setAside: row.setAside ?? null,
    buyerCode: row.buyerCode ?? null,
    closesDate: row.closesDate ? row.closesDate.toISOString().slice(0, 10) : null,
    isOpen: row.isOpen ?? null,
    documentUrl: row.documentUrl ?? null,
    techDocsUrl: row.techDocsUrl ?? null,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
  };
}

/**
 * The title and agency an inbox row shows for a bid-board item.
 *
 * NEITHER IS A COLUMN, which is why this is a named function rather than two
 * inline expressions:
 *
 *   - `tango_dibbs_solicitation` has no title. The useful label is the item's
 *     `nomenclature` ("BRACKET, ANGLE"); the solicitation number is the
 *     fallback, and it is NOT NULL, so a DIBBS row can never render as
 *     "Source record no longer in the catalog" merely for lacking a name.
 *   - the table has no agency column either, and `'Defense Logistics Agency'` is
 *     a fact about the RAIL, not an observation about the row: DIBBS is DLA's
 *     own bid board, so every record on it is a DLA solicitation. Stated as a
 *     constant here, in one place, with that reasoning — rather than left null,
 *     which would render "Agency not stated" for something whose agency is
 *     definitional. If a reviewer disagrees, this is the one line to change.
 */
export const DIBBS_AGENCY = 'Defense Logistics Agency' as const;

export function dibbsInboxTitle(row: { nomenclature: string | null; solicitation: string }): string {
  const nomenclature = row.nomenclature?.trim();
  return nomenclature && nomenclature.length > 0 ? nomenclature : row.solicitation;
}

/**
 * The compound keyset predicate: `(sort, id) > (cursorSort, cursorId)`.
 *
 * The NULL handling is the subtle half. On an ascending NULLS LAST sort, once the
 * cursor is in the NULL region every remaining row is also NULL, so the predicate
 * degenerates to `id > cursorId` — without that branch a cursor with no sort value
 * has nothing to compare and the walk either restarts or stops early.
 */
export function buildInboxCursorWhere(
  sort: { column: 'responseDeadlineSnapshot' | 'updatedAt'; direction: 'asc' | 'desc' },
  cursor: InboxCursor,
): Prisma.ClientFundingOpportunityWhereInput {
  const id = cursor.i;
  if (sort.column === 'updatedAt') {
    const at = new Date(cursor.s!);
    return sort.direction === 'desc'
      ? { OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { gt: id } }] }
      : { OR: [{ updatedAt: { gt: at } }, { updatedAt: at, id: { gt: id } }] };
  }
  if (cursor.s == null) {
    // Already past every dated row: only the undated tail remains.
    return { responseDeadlineSnapshot: null, id: { gt: id } };
  }
  const at = new Date(cursor.s);
  return {
    OR: [
      { responseDeadlineSnapshot: { gt: at } },
      { responseDeadlineSnapshot: at, id: { gt: id } },
      // The undated tail sorts after every dated row.
      { responseDeadlineSnapshot: null },
    ],
  };
}

@Injectable()
export class FundingOpportunityInboxService {
  private readonly logger = new Logger(FundingOpportunityInboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    actorUserId: string,
    query: {
      filter?: string;
      cursor?: string;
      pageSize?: number;
      clientId?: string;
      source?: string;
    },
  ): Promise<InboxResponse> {
    const filter = this.parseFilter(query.filter);
    const source = this.parseSource(query.source);
    const pageSize = this.parsePageSize(query.pageSize);
    const cursor = query.cursor ? decodeInboxCursor(query.cursor) : null;
    const sort = FILTER_SORT[filter];

    return this.prisma.withTenant(tenantId, async (tx) => {
      // Ethical wall FIRST, and as a positive allow-list of client ids rather than
      // a NOT IN. A walled client with zero grants is invisible to everyone
      // including admins, so the safe shape is "which clients may this user see"
      // — an exclusion list silently opens up the moment a new wall appears.
      const visibleClientIds = await this.visibleClientIds(tx, tenantId, actorUserId);
      if (visibleClientIds.length === 0) {
        return this.emptyResponse(filter, pageSize, 'no visible clients');
      }

      /**
       * The selected-client narrowing, INTERSECTED with the wall rather than
       * trusted.
       *
       * An unknown or walled `clientId` resolves to null — the cross-client inbox —
       * and the response says so through `clientId`. It deliberately does NOT 404
       * or 403: either would confirm that a client the reader may not see exists,
       * which is the one thing an ethical wall is for. The scoped ids are always a
       * SUBSET of `visibleClientIds`, so the wall cannot be widened by a query
       * parameter.
       */
      const appliedClientId =
        query.clientId && visibleClientIds.includes(query.clientId) ? query.clientId : null;
      const scopedClientIds = appliedClientId ? [appliedClientId] : visibleClientIds;

      const where: Prisma.ClientFundingOpportunityWhereInput = {
        tenantId,
        clientId: { in: scopedClientIds },
        ...(source ? { source } : {}),
        ...this.filterWhere(filter),
        ...(cursor ? this.cursorWhere(sort, cursor) : {}),
      };

      const rows = await tx.clientFundingOpportunity.findMany({
        where,
        orderBy: [
          // NULLS LAST on an ascending deadline sort: a row with no stated deadline
          // is not urgent, and Postgres would otherwise sort NULL first and put
          // every undated row at the top of a deadline queue.
          sort.column === 'responseDeadlineSnapshot'
            ? { responseDeadlineSnapshot: { sort: sort.direction, nulls: 'last' } }
            : { updatedAt: sort.direction },
          // The tiebreaker that makes the order TOTAL. Without it, two rows sharing
          // a deadline can land on both sides of a page boundary.
          { id: 'asc' },
        ],
        // One extra row, to know whether a next page exists without a count query.
        take: pageSize + 1,
        select: {
          id: true,
          clientId: true,
          source: true,
          grantOpportunityId: true,
          samOpportunityId: true,
          // P13's generic identity, selected so the row's source record id can be
          // read from either form. A row written by pre-P13 code during a rolling
          // deploy has only the legacy pointer; a future source will have only this.
          sourceRecordKey: true,
          workflowStatus: true,
          humanDecision: true,
          nextAction: true,
          nextActionDueAt: true,
          ownerUserId: true,
          relevanceScore: true,
          eligibilityState: true,
          eligibilityReason: true,
          responseDeadlineSnapshot: true,
          sourceActiveSnapshot: true,
          staleAt: true,
          updatedAt: true,
        },
      });

      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;

      // Batched per page: clients, owners and source titles. Three queries for the
      // whole page, never one per row — the N+1 this endpoint would otherwise be.
      const [clientsById, ownersById, titlesByKey] = await Promise.all([
        this.clientsById(tx, page.map((r) => r.clientId)),
        this.ownersById(tx, page.map((r) => r.ownerUserId).filter((v): v is string => v != null)),
        this.titlesFor(tx, page),
      ]);

      const now = new Date();
      const shaped: InboxRow[] = page.map((row) => {
        const rowSource = row.source as InboxSource;
        // readSourceRecordId, not a hand-rolled grantOpportunityId ??
        // samOpportunityId fallback (P25 fix) — see titlesFor's own doc for
        // why the fallback alone could never match a generic-identity-only
        // row (both legacy pointers null) in the first place.
        const key = `${row.source}:${readSourceRecordId(row) ?? ''}`;
        const meta = titlesByKey.get(key);
        const owner = row.ownerUserId ? ownersById.get(row.ownerUserId) : undefined;
        const deadline = row.responseDeadlineSnapshot;
        return {
          id: row.id,
          client: {
            id: row.clientId,
            name: clientsById.get(row.clientId) ?? 'Unknown client',
          },
          source: rowSource,
          sourceRecordId: readSourceRecordId(row) ?? '',
          // A missing title says so. It never renders as an empty card, and it
          // never silently drops the row — a decision context whose source row is
          // gone is exactly what somebody needs to see.
          title: meta?.title ?? 'Source record no longer in the catalog',
          agency: meta?.agency ?? null,
          // P26. Present ONLY on a forecast row, and only when the forecast
          // record itself was found — a workflow row pointing at a forecast
          // that is no longer in the catalog already says so through `title`,
          // and fabricating an empty facts block alongside it would read as
          // "the agency stated nothing" rather than "we no longer hold it".
          forecast: rowSource === FORECAST_INBOX_SOURCE ? (meta?.forecast ?? null) : null,
          // Same rule as `forecast` above: gated on the row's OWN rail, so a
          // facts block never appears on a row that is not a bid-board item, and
          // a bid-board row whose source record is gone gets null rather than a
          // fabricated empty block that would read as "the provider stated
          // nothing" instead of "we no longer hold it".
          dibbs: rowSource === DIBBS_INBOX_SOURCE ? (meta?.dibbs ?? null) : null,
          responseDeadline: deadline ? deadline.toISOString() : null,
          daysUntilDeadline: deadline
            ? Math.floor((deadline.getTime() - now.getTime()) / 86_400_000)
            : null,
          workflowStatus: row.workflowStatus,
          humanDecision: row.humanDecision ?? null,
          nextAction: row.nextAction ?? null,
          nextActionDueAt: row.nextActionDueAt ? row.nextActionDueAt.toISOString() : null,
          owner: owner
            ? {
                userId: owner.id,
                name: [owner.firstName, owner.lastName].filter(Boolean).join(' ') || null,
                email: owner.email,
              }
            : null,
          relevanceScore: row.relevanceScore ?? null,
          eligibility: { state: row.eligibilityState ?? null, reason: row.eligibilityReason ?? null },
          noLongerSuggested: row.staleAt != null,
          // From the snapshot the lifecycle pass maintains. `false` means observed
          // closed; `null` means never observed, which is NOT the same as open.
          sourceClosed: row.sourceActiveSnapshot === false,
          updatedAt: row.updatedAt.toISOString(),
        };
      });

      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeInboxCursor(
              sort.column === 'responseDeadlineSnapshot' ? last.responseDeadlineSnapshot : last.updatedAt,
              last.id,
            )
          : null;

      // Scoped counts always. The all-client set is read ONLY when a client filter
      // is applied — otherwise it would be the identical query run twice.
      //
      // The SOURCE narrowing is applied to both, so a tab badge and the list under
      // it always agree; `countsAllClients` widens the CLIENT scope only, because
      // its one job is to answer "does another client have rows in this queue".
      const { counts, unavailableReason } = await this.counts(tx, tenantId, scopedClientIds, source);
      const allClients = appliedClientId
        ? await this.counts(tx, tenantId, visibleClientIds, source)
        : null;

      return {
        filter,
        clientId: appliedClientId,
        source,
        rows: shaped,
        nextCursor,
        pageSize,
        counts,
        countsAllClients: allClients?.counts ?? null,
        countsUnavailableReason: unavailableReason ?? allClients?.unavailableReason ?? null,
        generatedAt: now.toISOString(),
      };
    });
  }

  private parseFilter(raw: string | undefined): InboxFilter {
    if (raw == null || raw === '') return 'needs_review';
    if ((INBOX_FILTERS as readonly string[]).includes(raw)) return raw as InboxFilter;
    throw new BadRequestException(`filter must be one of: ${INBOX_FILTERS.join(', ')}`);
  }

  /**
   * The optional source narrowing.
   *
   * An UNKNOWN source is a 400 rather than a silent widening to every rail: unlike
   * `clientId` — where dropping the value protects the ethical wall — a mistyped
   * source has no privacy dimension, and quietly returning grants to a caller that
   * asked for contracts is worse than saying no.
   *
   * Validated against {@link INBOX_SOURCES}, which is DELIBERATELY wider than
   * `OPPORTUNITY_SOURCES` — see that constant's own doc. Accepting
   * `agency_forecast` here narrows the query to a rail the table has been able
   * to hold since P13; it does not make a forecast servable through any catalog
   * route, and it cannot widen what the inbox returns (a narrowing predicate
   * only ever removes rows).
   */
  private parseSource(raw: string | undefined): InboxSource | null {
    if (raw == null || raw === '') return null;
    if ((INBOX_SOURCES as readonly string[]).includes(raw)) return raw as InboxSource;
    throw new BadRequestException(`source must be one of: ${INBOX_SOURCES.join(', ')}`);
  }

  private parsePageSize(raw: number | undefined): number {
    if (raw == null) return INBOX_PAGE_SIZE;
    if (!Number.isInteger(raw) || raw < 1 || raw > INBOX_MAX_PAGE_SIZE) {
      throw new BadRequestException(`pageSize must be an integer from 1 to ${INBOX_MAX_PAGE_SIZE}`);
    }
    return raw;
  }

  /**
   * The six filters, as WHERE fragments.
   *
   * `needs_review` is the default and the only one defined by an ABSENCE: a
   * producer suggestion nobody has decided on. It deliberately excludes rows whose
   * source has been observed closed — asking somebody to review a closed
   * opportunity wastes the attention the inbox exists to direct.
   */
  private filterWhere(filter: InboxFilter): Prisma.ClientFundingOpportunityWhereInput {
    return buildInboxFilterWhere(filter);
  }


  /**
   * The compound keyset predicate.
   *
   * `(sort, id) > (cursorSort, cursorId)` expressed in Prisma. The NULL handling is
   * the subtle half: on an ascending NULLS LAST sort, once the cursor is in the
   * NULL region every remaining row is also NULL, so the predicate degenerates to
   * `id > cursorId`.
   */
  private cursorWhere(
    sort: { column: 'responseDeadlineSnapshot' | 'updatedAt'; direction: 'asc' | 'desc' },
    cursor: InboxCursor,
  ): Prisma.ClientFundingOpportunityWhereInput {
    return buildInboxCursorWhere(sort, cursor);
  }


  /**
   * Client ids this user may see, as an allow-list.
   *
   * Delegates to {@link readVisibleClientIds} so the inbox and P26's forecast
   * read cannot drift into two different answers to "may this user see this
   * client" — an ethical wall enforced by two implementations is an ethical wall
   * with two chances to be wrong.
   */
  private async visibleClientIds(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actorUserId: string,
  ): Promise<string[]> {
    return readVisibleClientIds(tx, tenantId, actorUserId);
  }

  private async clientsById(
    tx: Prisma.TransactionClient,
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.client.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async ownersById(
    tx: Prisma.TransactionClient,
    ids: string[],
  ): Promise<Map<string, { id: string; firstName: string | null; lastName: string | null; email: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * Titles and agencies for one page, in three queries — one per rail.
   *
   * tenant-scope-exempt: `federal_grant`, `sam_opportunity` and
   * `tango_procurement_forecast` are global public-domain federal reference
   * tables with no tenant_id, same as `federal_award`. The rows fetched are
   * constrained to ids that already came from this tenant's own workflow
   * rows.
   *
   * KEYED VIA `readSourceRecordId`, NOT a hand-rolled
   * `grantOpportunityId ?? samOpportunityId` fallback (P25 fix). A row
   * addressed purely through P13's generic identity — both legacy pointers
   * null, `sourceRecordKey` set — is exactly the shape
   * `SOURCE_RECORD_TYPES.agency_forecast = 'tango_procurement_forecast'`
   * (`funding-opportunity-identity.ts`) already anticipates, and the ONLY
   * thing missing was this function actually looking one up: before this
   * fix, ANY such row computed an empty-id key (`"agency_forecast:"`) here
   * and unconditionally rendered "Source record no longer in the catalog"
   * — not because the record was gone, but because this function never knew
   * to look. No producer writes an `agency_forecast` row yet (that starts in
   * a later phase), so this was unreachable with today's data — same shape
   * of finding as decision-log D-41/D-44's other dormant-but-tested paths —
   * but it was a real, findable bug in the meantime for anyone reaching this
   * path by hand.
   */
  private async titlesFor(
    tx: Prisma.TransactionClient,
    rows: Array<{
      source: string;
      grantOpportunityId: string | null;
      samOpportunityId: string | null;
      sourceRecordKey: string | null;
    }>,
  ): Promise<
    Map<
      string,
      {
        title: string;
        agency: string | null;
        forecast?: InboxForecastFacts;
        dibbs?: InboxDibbsFacts;
      }
    >
  > {
    const grantIds = rows.map((r) => r.grantOpportunityId).filter((v): v is string => v != null);
    const samIds = rows.map((r) => r.samOpportunityId).filter((v): v is string => v != null);
    const forecastIds = rows
      .filter((r) => r.source === FORECAST_INBOX_SOURCE)
      .map((r) => readSourceRecordId(r))
      .filter((v): v is string => v != null);
    // Keyed on the provider's own uuid, same as the forecast rail: P13's generic
    // identity holds `tango_dibbs_solicitation.tangoDibbsId`, which is the
    // sync's upsert key and unique.
    const dibbsIds = rows
      .filter((r) => r.source === DIBBS_INBOX_SOURCE)
      .map((r) => readSourceRecordId(r))
      .filter((v): v is string => v != null);
    const [grants, sam, forecasts, dibbs] = await Promise.all([
      grantIds.length
        ? tx.federalGrant.findMany({
            where: { id: { in: [...new Set(grantIds)] } },
            select: { id: true, title: true, agency: true },
          })
        : Promise.resolve([]),
      samIds.length
        ? tx.samOpportunity.findMany({
            where: { id: { in: [...new Set(samIds)] } },
            select: { id: true, title: true, agency: true },
          })
        : Promise.resolve([]),
      forecastIds.length
        ? tx.tangoProcurementForecast.findMany({
            where: { tangoForecastId: { in: [...new Set(forecastIds)] } },
            // P26 widens this select from title/agency to the source facts a
            // forecast card must state. Still ONE batched query for the whole
            // page — the columns grew, the query count did not.
            select: {
              tangoForecastId: true,
              title: true,
              agency: true,
              anticipatedAwardDate: true,
              estimatedPeriod: true,
              fiscalYear: true,
              sourceSystem: true,
              status: true,
              isActive: true,
              lastSyncedAt: true,
              providerModifiedAt: true,
            },
          })
        : Promise.resolve([]),
      // P41 part 2. One more batched query for the whole page, same shape as the
      // three above — the rail count grew, the per-row query count did not.
      dibbsIds.length
        ? tx.tangoDibbsSolicitation.findMany({
            where: { tangoDibbsId: { in: [...new Set(dibbsIds)] } },
            select: {
              tangoDibbsId: true,
              documentType: true,
              solicitation: true,
              solicitationFormatted: true,
              nsn: true,
              partNumber: true,
              nomenclature: true,
              quantity: true,
              unitOfIssue: true,
              setAside: true,
              buyerCode: true,
              closesDate: true,
              isOpen: true,
              documentUrl: true,
              techDocsUrl: true,
              lastSyncedAt: true,
            },
          })
        : Promise.resolve([]),
    ]);
    const out = new Map<
      string,
      { title: string; agency: string | null; forecast?: InboxForecastFacts; dibbs?: InboxDibbsFacts }
    >();
    for (const g of grants) out.set(`grants_gov:${g.id}`, { title: g.title, agency: g.agency });
    for (const s of sam) out.set(`sam_gov:${s.id}`, { title: s.title, agency: s.agency });
    for (const f of forecasts) {
      out.set(`${FORECAST_INBOX_SOURCE}:${f.tangoForecastId}`, {
        title: f.title,
        agency: f.agency,
        forecast: toInboxForecastFacts(f),
      });
    }
    for (const d of dibbs) {
      out.set(`${DIBBS_INBOX_SOURCE}:${d.tangoDibbsId}`, {
        // Neither is a column — see dibbsInboxTitle / DIBBS_AGENCY.
        title: dibbsInboxTitle(d),
        agency: DIBBS_AGENCY,
        dibbs: toInboxDibbsFacts(d),
      });
    }
    return out;
  }

  /**
   * Per-filter counts.
   *
   * Degrades to -1 with a reason rather than to 0. A zero badge on a queue that
   * actually has forty rows in it is the more dangerous of the two failures, and it
   * is indistinguishable from an empty queue.
   */
  private async counts(
    tx: Prisma.TransactionClient,
    tenantId: string,
    visibleClientIds: string[],
    source: InboxSource | null = null,
  ): Promise<{ counts: Record<InboxFilter, number>; unavailableReason: string | null }> {
    try {
      const entries = await Promise.all(
        INBOX_FILTERS.map(async (filter) => {
          const n = await tx.clientFundingOpportunity.count({
            where: {
              tenantId,
              clientId: { in: visibleClientIds },
              ...(source ? { source } : {}),
              ...this.filterWhere(filter),
            },
          });
          return [filter, n] as const;
        }),
      );
      return {
        counts: Object.fromEntries(entries) as Record<InboxFilter, number>,
        unavailableReason: null,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`inbox counts unavailable: ${reason}`);
      return {
        counts: Object.fromEntries(INBOX_FILTERS.map((f) => [f, -1])) as Record<InboxFilter, number>,
        unavailableReason: reason,
      };
    }
  }

  private emptyResponse(filter: InboxFilter, pageSize: number, reason: string): InboxResponse {
    this.logger.debug(`inbox returned empty: ${reason}`);
    return {
      filter,
      clientId: null,
      source: null,
      rows: [],
      nextCursor: null,
      pageSize,
      counts: Object.fromEntries(INBOX_FILTERS.map((f) => [f, 0])) as Record<InboxFilter, number>,
      countsAllClients: null,
      countsUnavailableReason: null,
      generatedAt: new Date().toISOString(),
    };
  }
}
