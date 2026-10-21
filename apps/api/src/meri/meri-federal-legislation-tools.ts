import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { LdaIntelService } from '../lda-intel/lda-intel.service.js';
import {
  formatBillId,
  isValidCanonicalId,
  normalizeCanonicalId,
  parseBillDesignation,
  currentCongress,
  billStatusLabel,
} from '@capiro/shared';
import {
  BILL_TEXT_BILLS_PER_PAGE,
  BILL_TEXT_MAX_BILLS_PER_PAGE,
  BILL_TEXT_PAGE_CHARS,
  BILL_TEXT_PASSAGE_SEARCH_SQL,
  billTextCursor,
  billTextSearchResponse,
  locateBillTextPassages,
  type BillTextSearchRow,
} from './meri-bill-text-search.js';
import { UUID_V4_RE, requiredString, optionalString, clampInt } from './meri-tool-input.helpers.js';

interface FederalBillTextRow {
  revisionId: string;
  sourceKey: string;
  provider: string;
  packageId: string;
  billId: string;
  versionCode: string;
  lineageKey: string;
  contentHash: string;
  extractionHash: string;
  sourceUrl: string;
  sourceModifiedAt: Date | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  extractedText: string;
}

/** Canonical public federal-legislation reads, independent of agent orchestration. */
export class MeriFederalLegislationTools {
  private readonly prisma: PrismaService;
  private readonly ldaIntel: LdaIntelService;

  constructor(prisma: PrismaService, ldaIntel: LdaIntelService) {
    this.prisma = prisma;
    this.ldaIntel = ldaIntel;
  }

  /**
   * Resolve a free-form bill reference ("H.R. 8800", "119-hr-8800") to a
   * canonical bill id, or null. Shared by the congress-bill / status / votes
   * tools so a designation query becomes a direct lookup, not a title guess.
   */
  private resolveBillId(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const norm = normalizeCanonicalId('billId', raw);
    if (isValidCanonicalId('billId', norm)) return norm;
    const parsed = parseBillDesignation(raw, currentCongress());
    return parsed ? formatBillId(parsed.congress, parsed.type, parsed.number) : null;
  }

  public async searchCongressBills(input: Record<string, unknown>) {
    const search = optionalString(input, 'query', 240) ?? optionalString(input, 'search', 240);
    const policyArea = optionalString(input, 'policyArea', 120);
    const congressNum = input.congress ? Number(input.congress) : undefined;
    const activeSince = optionalString(input, 'activeSince', 30);
    const limit = clampInt(input.limit, 1, 50, 20);
    const page = clampInt(input.page, 1, 100, 1);
    const textQuery = optionalString(input, 'textQuery', 300);
    if (textQuery) {
      // Paged by bill and bounded in size so the whole page reaches the model
      // (the orchestrator projects results over 12,000 characters to metadata).
      const perPage = clampInt(
        input.limit,
        1,
        BILL_TEXT_MAX_BILLS_PER_PAGE,
        BILL_TEXT_BILLS_PER_PAGE,
      );
      const rows = await this.prisma.$queryRawUnsafe<BillTextSearchRow[]>(
        BILL_TEXT_PASSAGE_SEARCH_SQL,
        textQuery,
        Number.isSafeInteger(congressNum) ? congressNum : null,
        perPage,
        (page - 1) * perPage,
      );
      return billTextSearchResponse(rows, {
        textQuery,
        page,
        perPage,
        generatedAt: new Date().toISOString(),
      });
    }

    // Direct lookup when the query is itself a bill designation/id — a title
    // substring search would otherwise miss "H.R. 8800".
    const directId = this.resolveBillId(search);
    if (directId) {
      const bill = await this.prisma.congressBill.findUnique({ where: { id: directId } });
      if (bill) {
        return {
          tool: 'search_congress_bills',
          generatedAt: new Date().toISOString(),
          data: [bill],
          total: 1,
          page: 1,
          limit,
          resolvedBy: 'bill-id',
        };
      }
    }

    const bills = await this.ldaIntel.getCongressBills(
      search ?? undefined,
      policyArea ?? undefined,
      congressNum,
      page,
      limit,
      activeSince ?? undefined,
    );

    return {
      tool: 'search_congress_bills',
      generatedAt: new Date().toISOString(),
      ...bills,
    };
  }

  public async readBillText(input: Record<string, unknown>) {
    const raw = requiredString(input, 'billId', 60);
    const billId = this.resolveBillId(raw);
    if (!billId)
      throw new BadRequestException('Use an exact canonical federal bill ID or designation.');
    const requestedVersion = optionalString(input, 'versionCode', 32);
    const locate = optionalString(input, 'query', 300);
    if (locate && input.cursor !== undefined)
      throw new BadRequestException('Use query or cursor, not both.');
    let expectedRevisionId: string | null = null;
    let expectedTextHash: string | null = null;
    let offset = 0;
    if (input.cursor !== undefined) {
      try {
        if (
          typeof input.cursor !== 'string' ||
          input.cursor.length > 1024 ||
          !/^[A-Za-z0-9_-]+$/.test(input.cursor)
        )
          throw new Error('shape');
        const bytes = Buffer.from(input.cursor, 'base64url');
        if (bytes.toString('base64url') !== input.cursor) throw new Error('canonical');
        const cursor = JSON.parse(bytes.toString('utf8')) as unknown;
        if (!Array.isArray(cursor) || cursor.length !== 5) throw new Error('shape');
        const [cursorBillId, cursorVersion, revisionId, textHash, cursorOffset] = cursor;
        if (
          cursorBillId !== billId ||
          typeof cursorVersion !== 'string' ||
          (requestedVersion && requestedVersion !== cursorVersion) ||
          typeof revisionId !== 'string' ||
          !UUID_V4_RE.test(revisionId) ||
          typeof textHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(textHash) ||
          !Number.isSafeInteger(cursorOffset) ||
          cursorOffset < 1 ||
          cursorOffset > 30_000_000
        )
          throw new Error('scope');
        expectedRevisionId = revisionId;
        expectedTextHash = textHash;
        offset = cursorOffset;
      } catch {
        throw new BadRequestException('Invalid or stale bill-text continuation.');
      }
    }

    const versionCode = requestedVersion ?? null;
    const rows = await this.prisma.$queryRawUnsafe<FederalBillTextRow[]>(
      `SELECT r.id AS "revisionId", r.source_key AS "sourceKey", r.provider,
              r.package_id AS "packageId", r.bill_id AS "billId",
              r.version_code AS "versionCode", r.lineage_key AS "lineageKey",
              r.content_hash AS "contentHash", r.extraction_hash AS "extractionHash",
              r.source_url AS "sourceUrl", r.source_modified_at AS "sourceModifiedAt",
              r.published_at AS "publishedAt", r.fetched_at AS "fetchedAt",
              r.extracted_text AS "extractedText"
         FROM federal_evidence_current c
         JOIN federal_evidence_revision r ON r.id = c.revision_id
        WHERE c.state = 'present' AND c.bill_id = $1
          AND r.completeness = 'complete' AND r.version_code IS NOT NULL
          AND ($2::text IS NULL OR r.version_code = $2)
        ORDER BY COALESCE(r.source_modified_at, r.published_at, r.fetched_at) DESC,
                 r.fetched_at DESC, r.source_key ASC
        LIMIT 20`,
      billId,
      versionCode,
    );
    const row = expectedRevisionId
      ? rows.find((candidate) => candidate.revisionId === expectedRevisionId)
      : rows[0];
    if (!row) {
      return {
        tool: 'read_bill_text',
        authoritativeOwner: 'federal_evidence_current',
        currentStatus: 'unavailable',
        billId,
        requestedVersionCode: requestedVersion ?? null,
        found: false,
        coverage: { complete: true, truncated: false, nextCursor: null },
        note: requestedVersion
          ? `No current complete bill-text revision ${requestedVersion} is available for ${billId}.`
          : `No current complete bill-text revision is available for ${billId}.`,
      };
    }
    if (expectedTextHash && row.extractionHash !== expectedTextHash)
      throw new BadRequestException('Bill text changed since the previous page; restart the read.');
    if (offset > row.extractedText.length)
      throw new BadRequestException('Bill-text continuation is outside the current revision.');
    if (locate) return this.locatedBillText(billId, row, locate);
    let end = Math.min(row.extractedText.length, offset + BILL_TEXT_PAGE_CHARS);
    if (end < row.extractedText.length && /[\uD800-\uDBFF]/.test(row.extractedText.charAt(end - 1)))
      end -= 1;
    const nextCursor =
      end < row.extractedText.length
        ? billTextCursor(billId, row.versionCode, row.revisionId, row.extractionHash, end)
        : null;
    return {
      tool: 'read_bill_text',
      authoritativeOwner: 'federal_evidence_current',
      currentStatus: 'available',
      found: true,
      billId,
      versionCode: row.versionCode,
      revisionId: row.revisionId,
      packageId: row.packageId,
      provider: row.provider,
      lineageKey: row.lineageKey,
      versionHash: row.contentHash,
      textHash: row.extractionHash,
      sourceLocator: row.sourceUrl,
      sourceModifiedAt: row.sourceModifiedAt,
      publishedAt: row.publishedAt,
      fetchedAt: row.fetchedAt,
      text: row.extractedText.slice(offset, end),
      trust: 'external_untrusted',
      coverage: {
        locator: { offset, endOffset: end },
        totalCharacters: row.extractedText.length,
        pageComplete: true,
        contentComplete: nextCursor === null && offset === 0,
        paginationComplete: nextCursor === null,
        complete: true,
        truncated: nextCursor !== null || offset > 0,
        nextCursor,
      },
      note: 'This is exact bill-version text from the current federal evidence owner. It is not amendment text or bill status.',
    };
  }

  /**
   * The passages of one stored bill version that best match a query, with the
   * section heading above each and a cursor to read on from it. Coverage is
   * partial by construction: these are excerpts, not the whole text.
   */
  private locatedBillText(billId: string, row: FederalBillTextRow, query: string) {
    const versionCode = row.versionCode;
    const located = locateBillTextPassages(row.extractedText, query);
    const passages = located.passages.map((passage) => ({
      heading: passage.heading,
      startOffset: passage.startOffset,
      endOffset: passage.endOffset,
      matchedTerms: passage.matchedTerms,
      readCursor:
        passage.startOffset > 0
          ? billTextCursor(billId, versionCode, row.revisionId, row.extractionHash, passage.startOffset)
          : null,
    }));
    const text = located.passages
      .map(
        (passage) =>
          `[${passage.heading ?? 'Text'} | characters ${passage.startOffset}-${passage.endOffset}]\n` +
          row.extractedText.slice(passage.startOffset, passage.endOffset),
      )
      .join('\n\n…\n\n');
    return {
      tool: 'read_bill_text',
      authoritativeOwner: 'federal_evidence_current',
      currentStatus: 'available',
      found: true,
      billId,
      versionCode,
      revisionId: row.revisionId,
      packageId: row.packageId,
      provider: row.provider,
      lineageKey: row.lineageKey,
      versionHash: row.contentHash,
      textHash: row.extractionHash,
      sourceLocator: row.sourceUrl,
      sourceModifiedAt: row.sourceModifiedAt,
      publishedAt: row.publishedAt,
      fetchedAt: row.fetchedAt,
      query,
      queryParts: located.parts,
      totalHits: located.totalHits,
      passages,
      text,
      trust: 'external_untrusted',
      coverage: {
        locator: { query },
        totalCharacters: row.extractedText.length,
        pageComplete: true,
        contentComplete: false,
        paginationComplete: false,
        complete: false,
        truncated: true,
        nextCursor: null,
      },
      note: located.passages.length
        ? 'Excerpts of the exact bill-version text that match the query, best first by section order. Read on from a passage with read_bill_text and its readCursor before relying on surrounding context.'
        : 'No exact match for these words in this bill version. Try other wording or a shorter phrase before concluding the bill does not address the topic.',
    };
  }

  public async getBillStatus(input: Record<string, unknown>) {
    const raw = optionalString(input, 'billId', 60) ?? optionalString(input, 'query', 60);
    const billId = this.resolveBillId(raw);
    if (!billId) {
      return {
        tool: 'get_bill_status',
        authoritativeOwner: 'congress_bill_status',
        currentStatus: 'invalid_request',
        generatedAt: new Date().toISOString(),
        found: false,
        note: 'Provide a bill id ("119-hr-8800") or designation ("H.R. 8800").',
      };
    }
    const bill = await this.prisma.congressBill.findUnique({
      where: { id: billId },
      select: {
        id: true,
        title: true,
        congress: true,
        status: true,
        statusAt: true,
        latestActionText: true,
        latestActionDate: true,
        sponsorName: true,
        sponsorBioguideId: true,
        cosponsorsCount: true,
        policyArea: true,
      },
    });
    if (!bill) {
      return {
        tool: 'get_bill_status',
        authoritativeOwner: 'congress_bill_status',
        currentStatus: 'unavailable',
        generatedAt: new Date().toISOString(),
        billId,
        found: false,
        note: `No bill ${billId} on record in the Capiro database. Say so explicitly — do not describe its status from memory.`,
      };
    }

    const [actions, votes, ruleLinks] = await Promise.all([
      this.prisma.congressBillAction.findMany({
        where: { billId },
        orderBy: { date: 'desc' },
        take: 15,
        select: { date: true, text: true, type: true, chamber: true },
      }),
      this.prisma.rollCallVote.findMany({
        where: { billId },
        orderBy: { voteDate: 'desc' },
        take: 15,
        select: {
          chamber: true,
          rollNumber: true,
          question: true,
          result: true,
          voteType: true,
          voteDate: true,
          yeas: true,
          nays: true,
          present: true,
          notVoting: true,
          partyTotals: true,
          sourceUrl: true,
        },
      }),
      this.prisma.billRuleLink.findMany({
        where: { targetBillId: billId },
        select: { ruleBillId: true, source: true },
      }),
    ]);

    const governingRules = await Promise.all(
      ruleLinks.map(async (l) => {
        const ruleBill = await this.prisma.congressBill.findUnique({
          where: { id: l.ruleBillId },
          select: { status: true, latestActionText: true, title: true },
        });
        const ruleVotes = await this.prisma.rollCallVote.findMany({
          where: { billId: l.ruleBillId },
          orderBy: { voteDate: 'desc' },
          take: 3,
          select: {
            rollNumber: true,
            result: true,
            yeas: true,
            nays: true,
            voteDate: true,
            question: true,
            sourceUrl: true,
          },
        });
        return {
          ruleBillId: l.ruleBillId,
          ruleTitle: ruleBill?.title ?? null,
          ruleStatus: ruleBill?.status ?? null,
          ruleLatestAction: ruleBill?.latestActionText ?? null,
          ruleVotes,
        };
      }),
    );

    const notes: string[] = [];
    if (votes.length === 0) {
      notes.push(
        'No recorded roll-call vote on this bill itself. Do NOT infer that it passed or failed a chamber from the absence of a vote.',
      );
    }
    if (bill.status === 'rule_failed') {
      notes.push(
        'The rule governing this bill FAILED — the bill did NOT advance to the floor under that rule; it is stalled, not pending passage.',
      );
    }

    return {
      tool: 'get_bill_status',
      authoritativeOwner: 'congress_bill_status',
      currentStatus: 'available',
      generatedAt: new Date().toISOString(),
      billId,
      found: true,
      title: bill.title,
      congress: bill.congress,
      status: bill.status,
      statusLabel: billStatusLabel(bill.status),
      statusAt: bill.statusAt,
      latestAction: { text: bill.latestActionText, date: bill.latestActionDate },
      sponsor: { name: bill.sponsorName, bioguideId: bill.sponsorBioguideId },
      cosponsorsCount: bill.cosponsorsCount,
      recentActions: actions,
      floorVotes: votes,
      governingRules,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  }

  public async searchFloorVotes(input: Record<string, unknown>) {
    const billId = this.resolveBillId(optionalString(input, 'billId', 60) ?? undefined);
    const query = optionalString(input, 'query', 200);
    const memberRaw = optionalString(input, 'member', 80);
    const chamber = optionalString(input, 'chamber', 10)?.toLowerCase();
    const congress = input.congress ? Number(input.congress) : undefined;
    const limit = clampInt(input.limit, 1, 25, 10);

    const where: Record<string, unknown> = {};
    if (billId) where.billId = billId;
    if (congress) where.congress = congress;
    if (chamber === 'house' || chamber === 'senate') where.chamber = chamber;
    if (query) {
      where.OR = [
        { question: { contains: query, mode: 'insensitive' } },
        { title: { contains: query, mode: 'insensitive' } },
      ];
    }

    // Member filter: accept a Bioguide id directly, else resolve a NAME. Name
    // resolution must never silently mislead — an unresolvable or AMBIGUOUS
    // name short-circuits with an explicit answer rather than returning
    // unscoped or wrong-member votes (adversarial-review fixes).
    let resolvedMember: {
      bioguideId: string;
      lisId: string | null;
      fullName: string;
      chamber: string;
      state: string | null;
    } | null = null;
    if (memberRaw) {
      const norm = normalizeCanonicalId('bioguide', memberRaw);
      if (isValidCanonicalId('bioguide', norm)) {
        const m = await this.prisma.congressMember.findUnique({
          where: { bioguideId: norm },
          select: { bioguideId: true, lisId: true, fullName: true, chamber: true, state: true },
        });
        if (!m) {
          return {
            tool: 'search_floor_votes',
            generatedAt: new Date().toISOString(),
            votesFound: 0,
            votes: [],
            note: `No member with Bioguide id ${norm} is on record. Results are NOT scoped to a member — say so; do not attribute votes.`,
          };
        }
        resolvedMember = m;
      } else {
        const candidates = await this.prisma.congressMember.findMany({
          where: {
            OR: [
              { fullName: { contains: memberRaw, mode: 'insensitive' } },
              { lastName: { contains: memberRaw, mode: 'insensitive' } },
            ],
          },
          orderBy: [{ isCurrent: 'desc' }, { lastName: 'asc' }],
          take: 8,
          select: {
            bioguideId: true,
            lisId: true,
            fullName: true,
            chamber: true,
            state: true,
            party: true,
            isCurrent: true,
          },
        });
        if (candidates.length === 0) {
          return {
            tool: 'search_floor_votes',
            generatedAt: new Date().toISOString(),
            votesFound: 0,
            votes: [],
            note: `Could not resolve a member named "${memberRaw}". Results are NOT scoped to that member — say so explicitly; do not attribute any vote to them.`,
          };
        }
        if (candidates.length > 1) {
          return {
            tool: 'search_floor_votes',
            generatedAt: new Date().toISOString(),
            votesFound: 0,
            votes: [],
            ambiguousMember: candidates.map((c) => ({
              bioguideId: c.bioguideId,
              fullName: c.fullName,
              chamber: c.chamber,
              state: c.state,
              party: c.party,
              isCurrent: c.isCurrent,
            })),
            note: `"${memberRaw}" matches ${candidates.length} members — ask the user which (by state/chamber/full name) before attributing votes. Results are NOT scoped to a member yet.`,
          };
        }
        resolvedMember = candidates[0]!;
      }
      // Match rows keyed by bioguide OR by lisId (Senate rows can carry a null
      // bioguide during crosswalk lag — see sync-senate-votes memberKey).
      const memberOr: Record<string, unknown>[] = [{ bioguideId: resolvedMember.bioguideId }];
      if (resolvedMember.lisId) memberOr.push({ lisId: resolvedMember.lisId });
      where.memberVotes = { some: { OR: memberOr } };
    }

    const memberVoteFilter = resolvedMember
      ? {
          where: {
            OR: [
              { bioguideId: resolvedMember.bioguideId },
              ...(resolvedMember.lisId ? [{ lisId: resolvedMember.lisId }] : []),
            ],
          },
          select: { voteCast: true, party: true, state: true },
        }
      : null;

    const votes = await this.prisma.rollCallVote.findMany({
      where,
      orderBy: { voteDate: 'desc' },
      take: limit,
      select: {
        id: true,
        chamber: true,
        congress: true,
        session: true,
        rollNumber: true,
        billId: true,
        question: true,
        result: true,
        voteType: true,
        voteDate: true,
        yeas: true,
        nays: true,
        present: true,
        notVoting: true,
        partyTotals: true,
        title: true,
        sourceUrl: true,
        ...(memberVoteFilter ? { memberVotes: memberVoteFilter } : {}),
      },
    });

    return {
      tool: 'search_floor_votes',
      generatedAt: new Date().toISOString(),
      votesFound: votes.length,
      ...(resolvedMember
        ? { member: { bioguideId: resolvedMember.bioguideId, fullName: resolvedMember.fullName } }
        : {}),
      votes,
      ...(votes.length === 0
        ? {
            note: resolvedMember
              ? `No roll-call vote on record matches — including none cast by ${resolvedMember.fullName} under these filters. Say so explicitly; do not infer a vote.`
              : 'No roll-call vote on record matches that. Say so explicitly — do not infer a vote outcome or tally.',
          }
        : {}),
    };
  }

  public async searchCboCostEstimates(input: Record<string, unknown>) {
    const billId = optionalString(input, 'billId', 40);
    const query = optionalString(input, 'query', 200);
    const congress = input.congress ? Number(input.congress) : undefined;
    const limit = clampInt(input.limit, 1, 25, 10);

    const where: Record<string, unknown> = {};
    if (billId) where.billId = billId.toLowerCase().trim();
    if (congress) where.congress = congress;
    if (query) where.title = { contains: query, mode: 'insensitive' };

    const estimates = await this.prisma.cboCostEstimate.findMany({
      where,
      orderBy: { pubDate: 'desc' },
      take: limit,
      select: {
        id: true,
        billId: true,
        congress: true,
        billType: true,
        billNumber: true,
        title: true,
        description: true,
        pubDate: true,
        cboUrl: true,
      },
    });

    return {
      tool: 'search_cbo_cost_estimates',
      generatedAt: new Date().toISOString(),
      estimatesFound: estimates.length,
      estimates,
      ...(estimates.length === 0
        ? {
            note: billId
              ? `No CBO cost estimate on record for ${billId}. Say so explicitly — do not estimate or guess a score.`
              : 'No CBO cost estimates matched. Say so explicitly — do not estimate or guess a score.',
          }
        : {}),
    };
  }
}
