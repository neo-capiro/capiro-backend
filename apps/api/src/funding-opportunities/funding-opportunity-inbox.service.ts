import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OPPORTUNITY_SOURCES, type OpportunitySource } from './funding-opportunities.types.js';
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

export interface InboxRow {
  /** The workflow row id — the stable identity of this decision context. */
  id: string;
  client: { id: string; name: string };
  source: OpportunitySource;
  sourceRecordId: string;
  title: string;
  agency: string | null;
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
  source: OpportunitySource | null;
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
        const key = `${row.source}:${row.grantOpportunityId ?? row.samOpportunityId ?? ''}`;
        const meta = titlesByKey.get(key);
        const owner = row.ownerUserId ? ownersById.get(row.ownerUserId) : undefined;
        const deadline = row.responseDeadlineSnapshot;
        return {
          id: row.id,
          client: {
            id: row.clientId,
            name: clientsById.get(row.clientId) ?? 'Unknown client',
          },
          source: row.source as OpportunitySource,
          sourceRecordId: readSourceRecordId(row) ?? '',
          // A missing title says so. It never renders as an empty card, and it
          // never silently drops the row — a decision context whose source row is
          // gone is exactly what somebody needs to see.
          title: meta?.title ?? 'Source record no longer in the catalog',
          agency: meta?.agency ?? null,
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
   */
  private parseSource(raw: string | undefined): OpportunitySource | null {
    if (raw == null || raw === '') return null;
    if ((OPPORTUNITY_SOURCES as readonly string[]).includes(raw)) return raw as OpportunitySource;
    throw new BadRequestException(`source must be one of: ${OPPORTUNITY_SOURCES.join(', ')}`);
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
   * A walled client is visible only to a user with an explicit
   * `ClientMemoryAccess` grant. Fail-closed by construction: a walled client with
   * zero grants is invisible to everyone, admins included.
   */
  private async visibleClientIds(
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
   * Titles and agencies for one page, in two queries — one per rail.
   *
   * tenant-scope-exempt: `federal_grant` and `sam_opportunity` are global
   * public-domain federal reference tables with no tenant_id, same as
   * `federal_award`. The rows fetched are constrained to ids that already came from
   * this tenant's own workflow rows.
   */
  private async titlesFor(
    tx: Prisma.TransactionClient,
    rows: Array<{ source: string; grantOpportunityId: string | null; samOpportunityId: string | null }>,
  ): Promise<Map<string, { title: string; agency: string | null }>> {
    const grantIds = rows.map((r) => r.grantOpportunityId).filter((v): v is string => v != null);
    const samIds = rows.map((r) => r.samOpportunityId).filter((v): v is string => v != null);
    const [grants, sam] = await Promise.all([
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
    ]);
    const out = new Map<string, { title: string; agency: string | null }>();
    for (const g of grants) out.set(`grants_gov:${g.id}`, { title: g.title, agency: g.agency });
    for (const s of sam) out.set(`sam_gov:${s.id}`, { title: s.title, agency: s.agency });
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
    source: OpportunitySource | null = null,
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
