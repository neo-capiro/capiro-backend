import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientPeRelevanceService } from '../intelligence/client-pe-relevance.service.js';
import { TrackerService } from '../tracker/tracker.service.js';
import {
  FundingOpportunityV2SearchService,
  type OpportunitySearchContext,
} from '../funding-opportunities/funding-opportunity-v2-search.service.js';
import { normalizeOpportunitySearchQuery } from '../funding-opportunities/funding-opportunity-v2-search.service.js';
import {
  billToMatch,
  capsForMatchedTags,
  capsForPeDirect,
  foToMatch,
  peToMatch,
  sortMatches,
  takeTop,
  type CapabilityFitMatch,
  type FoCapabilityFitInput,
} from './client-capability-fit.normalize.js';
import { capabilityFitFingerprint } from './client-capability-fit.fingerprint.js';

/** Why the card has nothing to show — distinct causes get distinct UI copy. */
export type CapabilityFitStatus = 'ready' | 'empty' | 'profile_too_thin' | 'stale';

export interface CapabilityFitResult {
  matches: CapabilityFitMatch[];
  /** ISO timestamp of the compute behind these rows, or null if never computed. */
  computedAt: string | null;
  status: CapabilityFitStatus;
  emptyReason?: string;
  /** Which upstream scorers contributed to this payload. */
  sources: { pe: boolean; bill: boolean; fo: boolean };
  inputFingerprint?: string;
}

/** Minimum PE relevance considered for the card — matches the PE service default. */
const PE_MIN_SCORE = 0.5;
/** Upper bound on PEs pulled from the fan-out before capability filtering. */
const PE_FETCH_LIMIT = 50;
/**
 * FO page size for the card fan-in. The FO service clamps to 100; we only keep
 * top-N after cross-kind sort anyway (MAX_STORED_MATCHES=12).
 */
const FO_FETCH_PAGE_SIZE = 50;

/** Named, honest empty states — the card never renders a bare blank. */
const REASON = {
  notComputed: 'Not computed yet — refresh to score this client’s capabilities.',
  thin: 'Add a capability area with tags or PE numbers to see where it creates fit.',
  noMatches:
    'No program element, bill, or funding opportunity cleared the capability match floor for this client’s capabilities.',
} as const;

/** Which scorers a payload came from. */
const SOURCES = {
  none: { pe: false, bill: false, fo: false },
  all: { pe: true, bill: true, fo: true },
} as const;

/** Extract verbatim PE keyword evidence for capability attribution. */
function peKeywordTokens(paths: Array<{ path: string; evidence?: string[] }> | null | undefined): string[] {
  const evidence = paths?.find((path) => path.path === 'capability_keyword')?.evidence?.[0] ?? '';
  const prefix = 'Keyword match:';
  if (!evidence.startsWith(prefix)) return [];
  return evidence.slice(prefix.length).split(',').map((token) => token.trim()).filter(Boolean);
}

/** The transaction handle shape `withTenant` hands to its callback. */
type PrismaTx = Parameters<Parameters<PrismaService['withTenant']>[1]>[0];

/** Rows present → ready; none → a named empty. Shared by the read and compute paths. */
function settled(matches: CapabilityFitMatch[]): Pick<CapabilityFitResult, 'status' | 'emptyReason'> {
  return matches.length > 0 ? { status: 'ready' } : { status: 'empty', emptyReason: REASON.noMatches };
}

/** Build the sources mask from which fan-outs actually fulfilled. */
function sourcesFromSettled(peOk: boolean, billOk: boolean, foOk: boolean) {
  return { pe: peOk, bill: billOk, fo: foOk };
}

/**
 * "Where capabilities create fit" on the client Portfolio → Capabilities tab.
 *
 * This service is deliberately NOT a matcher. It is a projection: it fans in
 * scores the platform already computes (PE relevance, tracker bill
 * recommendations, funding-opportunity relevance), keeps only the rows a
 * capability actually caused, and re-labels them for the card. Adding scoring
 * logic here would silently diverge from the Intelligence tab, where the same
 * numbers are shown.
 *
 * Caching mirrors ClientTargetRecommendationsService with one deliberate
 * difference: a GET never triggers the compute. The PE fan-out runs with a 30s
 * transaction budget, and blocking every Capabilities tab paint on it is not
 * acceptable — so a GET serves the cache (flagged `stale` when the capability
 * signals have changed since) and the user's explicit Refresh recomputes.
 */
@Injectable()
export class ClientCapabilityFitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly peRelevance: ClientPeRelevanceService,
    private readonly tracker: TrackerService,
    private readonly fundingOpportunities: FundingOpportunityV2SearchService,
  ) {}

  private async assertClient(ctx: TenantContext, clientId: string): Promise<void> {
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
        select: { id: true },
      }),
    );
    if (!client) throw new NotFoundException('Client not found');
  }

  /**
   * Read the card. Serves the persisted cache by default; `refresh: true`
   * recomputes and overwrites it.
   */
  async getFit(
    ctx: TenantContext,
    clientId: string,
    opts: { refresh?: boolean } = {},
  ): Promise<CapabilityFitResult> {
    await this.assertClient(ctx, clientId);

    if (opts.refresh) return this.compute(ctx, clientId);

    const { cached, capabilities } = await this.prisma.withTenant(ctx.tenantId, async (tx) => ({
      cached: await tx.clientCapabilityFitRecommendation.findUnique({ where: { clientId } }),
      capabilities: await this.loadCapabilities(tx, clientId),
    }));

    if (!cached) {
      // No cache and no compute on the read path: an honest "not computed yet"
      // beats a tab that hangs for half a minute on first paint.
      return {
        matches: [],
        computedAt: null,
        status: 'empty',
        emptyReason: REASON.notComputed,
        sources: SOURCES.none,
      };
    }

    const matches = (cached.matches ?? []) as unknown as CapabilityFitMatch[];
    const stale = cached.inputFingerprint !== capabilityFitFingerprint({ capabilities });

    // Cache rows may mix PE + bill + FO. Report the full source mask on read so
    // the UI's source chips don't flip just because this was a cache hit.
    return {
      matches,
      computedAt: cached.computedAt.toISOString(),
      // A stale cache still shows its rows — outdated numbers with a warning are
      // more useful than a blank card while the user decides to refresh.
      ...(stale ? { status: 'stale' as const } : settled(matches)),
      sources: SOURCES.all,
      inputFingerprint: cached.inputFingerprint ?? undefined,
    };
  }

  /** Capability signal fields — the only columns that can change a match. */
  private loadCapabilities(tx: PrismaTx, clientId: string) {
    return tx.clientCapability.findMany({
      where: { clientId },
      select: {
        id: true,
        name: true,
        tags: true,
        keywords: true,
        peNumbers: true,
        peNumber: true,
        sector: true,
        updatedAt: true,
      },
    });
  }

  /** Recompute the projection from the upstream scorers and persist it. */
  private async compute(ctx: TenantContext, clientId: string): Promise<CapabilityFitResult> {
    const capabilities = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      this.loadCapabilities(tx, clientId),
    );
    const inputFingerprint = capabilityFitFingerprint({ capabilities });

    // No capabilities means nothing could be capability-grounded. Short-circuit
    // BEFORE the PE/tracker/FO fan-out — a scoring pass whose result is knowably empty.
    if (capabilities.length === 0) {
      return this.persist(ctx, clientId, {
        matches: [],
        status: 'profile_too_thin',
        emptyReason: REASON.thin,
        inputFingerprint,
        sources: SOURCES.none,
      });
    }

    // Fan out concurrently. Any single source failure must not blank the others —
    // settle each independently and report which ones actually contributed.
    const [peSettled, billSettled, foSettled] = await Promise.allSettled([
      this.peRelevance.getRelevantPesForClient(ctx, clientId, {
        minScore: PE_MIN_SCORE,
        limit: PE_FETCH_LIMIT,
      }),
      // NOTE arg order: (clientId, tenantId) — bare strings, no TenantContext.
      this.tracker.getRecommendations(clientId, ctx.tenantId),
      // Narrowest useful query: active client-scoped scored rows, first page.
      this.fundingOpportunities.search(
        { tenantId: ctx.tenantId, userId: ctx.userId } satisfies OpportunitySearchContext,
        normalizeOpportunitySearchQuery({
          mode: 'matched',
          clientId,
          lifecycle: ['active'],
          page: 1,
          pageSize: FO_FETCH_PAGE_SIZE,
        }),
      ),
    ]);

    const peMatches: CapabilityFitMatch[] =
      peSettled.status === 'fulfilled'
        ? peSettled.value.data
            .map((pe) => {
              const direct = capsForPeDirect(capabilities, pe.peCode);
              const keyword = capsForMatchedTags(capabilities, peKeywordTokens(pe.paths));
              return peToMatch(pe, { capabilityIds: [...new Set([...direct, ...keyword])] });
            })
            .filter((m): m is CapabilityFitMatch => m !== null)
        : [];

    const billMatches: CapabilityFitMatch[] =
      billSettled.status === 'fulfilled'
        ? billSettled.value.recommendations
            .map((rec) =>
              billToMatch(rec, { capabilityIds: capsForMatchedTags(capabilities, rec.matchedTags) }),
            )
            .filter((m): m is CapabilityFitMatch => m !== null)
        : [];

    const foMatches: CapabilityFitMatch[] =
      foSettled.status === 'fulfilled'
        ? foSettled.value.opportunities
            .map((row) => {
              if (row.relevanceScore == null) return null;
              const input: FoCapabilityFitInput = {
                id: row.id,
                source: row.source,
                sourceRecordId: row.sourceRecordId,
                title: row.title,
                relevanceScore: row.relevanceScore,
                matchedSignals: row.matchedSignals,
                eligibility: row.eligibility ?? { state: 'unknown', reason: 'Eligibility was not stated by the source.' },
                meetsSuggestionFloor: row.relevanceScore >= 50,
              };
              return foToMatch(input, {
                capabilityIds: capsForMatchedTags(
                  capabilities,
                  input.matchedSignals?.map((signal) => signal.matchedOn) ?? [],
                ),
              });
            })
            .filter((m): m is CapabilityFitMatch => m !== null)
        : [];

    const matches = takeTop(sortMatches([...peMatches, ...billMatches, ...foMatches]));
    const sources = sourcesFromSettled(
      peSettled.status === 'fulfilled',
      billSettled.status === 'fulfilled',
      foSettled.status === 'fulfilled',
    );

    return this.persist(ctx, clientId, {
      matches,
      ...settled(matches),
      inputFingerprint,
      sources,
    });
  }

  /** Upsert the single cache row for this client and echo it back. */
  private async persist(
    ctx: TenantContext,
    clientId: string,
    result: Omit<CapabilityFitResult, 'computedAt'> & { inputFingerprint: string },
  ): Promise<CapabilityFitResult> {
    const row = {
      matches: result.matches as unknown as object[],
      inputFingerprint: result.inputFingerprint,
      computedAt: new Date(),
    };
    const saved = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clientCapabilityFitRecommendation.upsert({
        where: { clientId },
        create: { tenantId: ctx.tenantId, clientId, ...row },
        update: row,
      }),
    );

    return { ...result, computedAt: saved.computedAt.toISOString() };
  }
}
