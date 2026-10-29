import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ResearchPortfolioBillDetailDto,
  ResearchPortfolioBillMatchDto,
  ResearchPortfolioBillSearchResponseDto,
  TenantContext,
} from '@capiro/shared';
import { humanizeBillId } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;

export interface ResearchPortfolioBillSearchInput {
  q?: string;
  /** 'US' for federal, a two-letter state code, or omitted for both families. */
  jurisdiction?: string;
  /** Congress number (federal) or legislative session name/key (state). */
  session?: string;
  status?: string;
  topic?: string;
  cursor?: string | null;
  limit?: number;
}

interface CursorState {
  federalOffset: number;
  stateOffset: number;
}

/**
 * Read-only discovery and detail for bills as Research Portfolio subjects.
 *
 * The two canonical legislative catalogs that already exist (`congress_bill`,
 * `state_bill`) are the identity owners. This service adds no table, no ingest
 * path and no derivation: it selects the columns the portfolio needs, keeps the
 * federal and state identities distinct, and reports the coverage it actually has.
 */
@Injectable()
export class ResearchPortfolioBillsService {
  constructor(private readonly prisma: PrismaService) {}

  async search(
    ctx: TenantContext,
    input: ResearchPortfolioBillSearchInput,
  ): Promise<ResearchPortfolioBillSearchResponseDto> {
    const q = (input.q ?? '').trim();
    if (q.length === 1) throw new BadRequestException('Enter at least two characters to search bills');
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursor = this.decodeCursor(input.cursor ?? null);
    const jurisdiction = (input.jurisdiction ?? '').trim().toUpperCase();
    const federal = !jurisdiction || ['US', 'FED', 'FEDERAL', 'USA'].includes(jurisdiction);
    const stateCode = /^[A-Z]{2}$/.test(jurisdiction) ? jurisdiction : null;
    const state = !jurisdiction || stateCode !== null;
    const session = (input.session ?? '').trim();

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const items: ResearchPortfolioBillMatchDto[] = [];
      let federalStatus: 'searched' | 'empty' | 'unavailable' = 'empty';
      let stateStatus: 'searched' | 'empty' | 'unavailable' = 'empty';
      let federalOffset = cursor.federalOffset;
      let stateOffset = cursor.stateOffset;
      let hasMoreFederal = false;
      let hasMoreState = false;

      if (federal) {
        try {
          const rows = await tx.congressBill.findMany({
            where: {
              ...(session && /^\d+$/.test(session) ? { congress: Number(session) } : {}),
              ...(input.status ? { status: input.status } : {}),
              ...(input.topic
                ? { subjects: { has: input.topic } }
                : {}),
              ...(q
                ? {
                    OR: [
                      { id: q.toLowerCase().replace(/[.\s]+/g, '') },
                      { title: { contains: q, mode: 'insensitive' as const } },
                      { subjects: { has: q } },
                    ],
                  }
                : {}),
            },
            orderBy: [{ latestActionDate: 'desc' }, { id: 'asc' }],
            skip: federalOffset,
            take: limit + 1,
          });
          hasMoreFederal = rows.length > limit;
          for (const row of rows.slice(0, limit)) {
            items.push({
              targetKind: 'federal_bill',
              targetId: row.id,
              identifier: humanizeBillId(row.id),
              title: row.title,
              jurisdiction: 'US',
              session: String(row.congress),
              status: row.status,
              latestActionDate: row.latestActionDate?.toISOString().slice(0, 10) ?? null,
              latestActionText: row.latestActionText,
              sourceUrl: row.url,
              matchReason: this.matchReason(q, row.id, row.title, row.subjects),
            });
          }
          federalOffset += rows.slice(0, limit).length;
          federalStatus = rows.length ? 'searched' : 'empty';
        } catch {
          // A failed federal read is reported as unavailable, never as "no bills".
          federalStatus = 'unavailable';
        }
      }

      if (state) {
        try {
          const rows = await tx.stateBill.findMany({
            where: {
              ...(stateCode ? { state: stateCode } : {}),
              ...(session
                ? { OR: [{ session }, { sessionKey: session }] }
                : {}),
              ...(input.status ? { status: input.status } : {}),
              ...(input.topic ? { subjects: { has: input.topic } } : {}),
              ...(q
                ? {
                    OR: [
                      { billNumber: q.toUpperCase().replace(/[.\s]+/g, '') },
                      { identifier: { equals: q, mode: 'insensitive' as const } },
                      { title: { contains: q, mode: 'insensitive' as const } },
                      { subjects: { has: q } },
                    ],
                  }
                : {}),
            },
            orderBy: [{ latestActionDate: 'desc' }, { id: 'asc' }],
            skip: stateOffset,
            take: limit + 1,
          });
          hasMoreState = rows.length > limit;
          for (const row of rows.slice(0, limit)) {
            items.push({
              targetKind: 'state_bill',
              targetId: row.id,
              identifier: row.identifier,
              title: row.title,
              jurisdiction: row.state,
              session: row.session,
              status: row.status,
              latestActionDate: row.latestActionDate?.toISOString().slice(0, 10) ?? null,
              latestActionText: row.latestActionText,
              sourceUrl: row.stateUrl ?? row.url,
              matchReason: this.matchReason(q, row.billNumber, row.title, row.subjects),
            });
          }
          stateOffset += rows.slice(0, limit).length;
          stateStatus = rows.length ? 'searched' : 'empty';
        } catch {
          stateStatus = 'unavailable';
        }
      }

      // Only states with ingested bills are supported; this is the honest coverage signal.
      const stateRows = await tx.stateBill.findMany({
        distinct: ['state'],
        select: { state: true },
        orderBy: { state: 'asc' },
      });
      const statesWithData = stateRows.map((row) => row.state);
      return {
        items,
        nextCursor:
          hasMoreFederal || hasMoreState ? this.encodeCursor({ federalOffset, stateOffset }) : null,
        coverage: {
          federal: federalStatus,
          state: stateStatus,
          statesWithData,
          note: stateCode && !statesWithData.includes(stateCode)
            ? `${stateCode} has no ingested bills in this environment; it is not a supported state source yet.`
            : 'Federal bills come from Congress.gov. State bills cover only the jurisdictions with ingested legislative data.',
        },
      };
    });
  }

  async detail(ctx: TenantContext, kind: string, id: string): Promise<ResearchPortfolioBillDetailDto> {
    if (kind !== 'federal_bill' && kind !== 'state_bill') {
      throw new BadRequestException('Bill detail requires the federal_bill or state_bill kind');
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (kind === 'federal_bill') {
        const row = await tx.congressBill.findUnique({ where: { id: id.toLowerCase() } });
        if (!row) throw new NotFoundException('Bill not found');
        const [cosponsors, committees, votes] = await Promise.all([
          tx.congressBillCosponsor.findMany({
            where: { billId: row.id },
            orderBy: [{ isOriginal: 'desc' }, { fullName: 'asc' }],
            take: 50,
          }),
          tx.congressBillCommittee.findMany({ where: { billId: row.id }, take: 20 }),
          tx.rollCallVote.findMany({
            where: { billId: row.id },
            orderBy: { voteDate: 'desc' },
            take: 20,
          }),
        ]);
        const unavailable: string[] = [];
        if (!cosponsors.length) unavailable.push('cosponsors');
        if (!committees.length) unavailable.push('committees');
        if (!votes.length) unavailable.push('votes');
        unavailable.push('text_versions', 'amendments', 'related_bills');
        return {
          targetKind: 'federal_bill',
          targetId: row.id,
          identifier: humanizeBillId(row.id),
          title: row.title,
          jurisdiction: 'US',
          session: String(row.congress),
          status: row.status,
          statusAt: row.statusAt?.toISOString() ?? null,
          latestActionText: row.latestActionText,
          latestActionDate: row.latestActionDate?.toISOString().slice(0, 10) ?? null,
          sourceUrl: row.url,
          sourceRevision: (row.updateDateIncludingText ?? row.lastSyncedAt)?.toISOString() ?? null,
          // Congress.gov is read per request; the last sync is the freshness signal.
          refreshedAt: row.lastSyncedAt?.toISOString() ?? null,
          refreshStatus: null,
          refreshFailed: false,
          sponsors: row.sponsorName
            ? [
                {
                  name: row.sponsorName,
                  party: row.sponsorParty,
                  state: row.sponsorState,
                  role: 'sponsor',
                },
              ]
            : [],
          committees: committees.map((entry) => ({
            name: entry.committeeName,
            chamber: entry.chamber,
            role: 'referred',
          })),
          textVersions: [],
          votes: votes.map((entry) => ({
            date: entry.voteDate?.toISOString().slice(0, 10) ?? null,
            chamber: entry.chamber,
            question: entry.question ?? entry.title ?? 'Roll call',
            result: entry.result ?? 'Result unavailable',
          })),
          relatedBills: [],
          unavailable,
          coverage: {
            source: 'congress.gov',
            note: 'Federal bills are read from Congress.gov. Fields this source does not retain are labelled unavailable rather than inferred.',
            available: true,
          },
        };
      }
      const row = await tx.stateBill.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('Bill not found');
      const [sponsors, versions, votes, links] = await Promise.all([
        tx.stateBillSponsor.findMany({
          where: { billKey: row.id },
          orderBy: [{ sponsorType: 'asc' }, { sponsorOrder: 'asc' }],
          take: 50,
        }),
        tx.stateBillVersion.findMany({
          where: { billKey: row.id },
          orderBy: { date: 'desc' },
          take: 20,
        }),
        tx.stateRollCallVote.findMany({
          where: { billKey: row.id },
          orderBy: { date: 'desc' },
          take: 20,
        }),
        tx.stateBillLink.findMany({ where: { billKey: row.id }, take: 20 }),
      ]);
      // LegiScan carries the committee that holds the bill NOW as mutable bill state
      // (state_bill.current_committee_id), not as a derivable join. Report it when
      // present; only claim "unavailable" when the bill genuinely has no referral.
      const referred = row.currentCommitteeId
        ? await tx.stateCommittee.findUnique({
            where: { id: row.currentCommitteeId },
            select: { name: true, chamber: true },
          })
        : null;
      const relatedIds = links.map((link) => link.relatedBillKey).filter((key): key is string => Boolean(key));
      const related = relatedIds.length
        ? await tx.stateBill.findMany({
            where: { id: { in: relatedIds } },
            select: { id: true, identifier: true },
          })
        : [];
      const identifierById = new Map(related.map((entry) => [entry.id, entry.identifier]));
      const unavailable: string[] = [];
      if (!sponsors.length) unavailable.push('sponsors');
      if (!versions.length) unavailable.push('text_versions');
      if (!votes.length) unavailable.push('votes');
      if (!referred) unavailable.push('committees');
      unavailable.push('amendments');
      return {
        targetKind: 'state_bill',
        targetId: row.id,
        identifier: row.identifier,
        title: row.title,
        jurisdiction: row.state,
        session: row.session,
        status: row.status,
        statusAt: row.statusAt?.toISOString() ?? null,
        latestActionText: row.latestActionText,
        latestActionDate: row.latestActionDate?.toISOString().slice(0, 10) ?? null,
        sourceUrl: row.stateUrl ?? row.url,
        sourceRevision: (row.statusDerivedAt ?? row.syncedAt)?.toISOString() ?? null,
        refreshedAt: row.sourceCheckedAt?.toISOString() ?? null,
        refreshStatus: row.sourceCheckStatus ?? null,
        refreshFailed: Boolean(row.sourceCheckError),
        sponsors: sponsors.map((entry) => ({
          name: entry.name,
          party: entry.party,
          state: row.state,
          role: entry.sponsorType,
        })),
        committees: referred
          ? [{ name: referred.name, chamber: referred.chamber, role: 'referred' }]
          : [],
        textVersions: versions.map((entry) => ({
          label: entry.versionType,
          date: entry.date?.toISOString().slice(0, 10) ?? null,
          url: entry.stateUrl,
          revision: null,
        })),
        votes: votes.map((entry) => ({
          date: entry.date?.toISOString().slice(0, 10) ?? null,
          chamber: entry.chamber,
          question: entry.motion ?? 'Roll call',
          result: entry.passed == null ? 'Result unavailable' : entry.passed ? 'Passed' : 'Failed',
        })),
        relatedBills: links.map((link) => ({
          identifier: (link.relatedBillKey && identifierById.get(link.relatedBillKey)) || 'Unresolved bill',
          relation: link.linkType,
        })),
        unavailable,
        coverage: {
          source: 'legiscan',
          note:
            'State bills are read from the ingested LegiScan dataset for this jurisdiction only. Fields the source does not carry are labelled unavailable.' +
            // A failed check is unknown, never "no change": say so where the reader looks.
            (row.sourceCheckError
              ? ` The most recent source check failed${
                  row.sourceCheckStatus ? ` (${row.sourceCheckStatus})` : ''
                }${row.sourceCheckedAt ? ` at ${row.sourceCheckedAt.toISOString()}` : ''}; this record may be stale and its absence of change cannot be relied on.`
              : ''),
          available: true,
        },
      };
    });
  }

  private matchReason(
    q: string,
    identifier: string,
    title: string,
    subjects: readonly string[],
  ): ResearchPortfolioBillMatchDto['matchReason'] {
    if (!q) return 'title';
    const normalized = q.toLowerCase().replace(/[.\s]+/g, '');
    if (identifier.toLowerCase().replace(/[.\s]+/g, '').includes(normalized)) return 'exact_identifier';
    if (title.toLowerCase().includes(q.toLowerCase())) return 'title';
    if (subjects.some((subject) => subject.toLowerCase() === q.toLowerCase())) return 'subject';
    return 'title';
  }

  private encodeCursor(state: CursorState): string {
    return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string | null): CursorState {
    if (!cursor) return { federalOffset: 0, stateOffset: 0 };
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorState;
      const offset = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0);
      return { federalOffset: offset(parsed.federalOffset), stateOffset: offset(parsed.stateOffset) };
    } catch {
      throw new BadRequestException('Invalid bill search cursor');
    }
  }
}
