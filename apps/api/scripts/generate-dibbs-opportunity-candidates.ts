/**
 * Funding Opportunities — deterministic producer for client ↔ DIBBS bid-board
 * suggestions (`client_funding_opportunity`, source 'dibbs').
 *
 *   tsx scripts/generate-dibbs-opportunity-candidates.ts                        # dry run
 *   tsx scripts/generate-dibbs-opportunity-candidates.ts --commit
 *   tsx scripts/generate-dibbs-opportunity-candidates.ts --commit --tenant <id>
 *   tsx scripts/generate-dibbs-opportunity-candidates.ts --commit --client <id>
 *   tsx scripts/generate-dibbs-opportunity-candidates.ts --commit --min-relevance=25
 *
 * DRY-RUN BY DEFAULT. Nothing is written without `--commit`.
 *
 * ── Why this producer is the ONLY path to visibility, unlike SAM/Grants' ────
 *
 * `generate-sam-opportunity-candidates.ts` exists on top of a live read-time
 * scoring path — a client's page works whether or not that job has ever run.
 * DIBBS has no such path: `scoreDibbsRelevance` (dibbs-relevance.ts) is a pure,
 * tested function that nothing outside its own spec calls. Until this producer
 * runs, `client_funding_opportunity` holds zero 'dibbs' rows for anyone. This
 * was a deliberate decision (see decision-log.md, the entry after D-78) — not a
 * live read-time path, matching the posture `forecast-relevance.ts` (P25) has
 * always had — not an oversight left for a follow-up to fix silently.
 *
 * ── RLS ─────────────────────────────────────────────────────────────────────
 * `clients`, `client_intel_mapping` and `client_funding_opportunity` are all
 * FORCE-RLS; every read/write against them runs inside `withBypass` with an
 * explicit `tenantId` filter alongside it, same idiom as the SAM/grant
 * producers. `tango_dibbs_solicitation` and `tango_dibbs_award` are global (no
 * tenantId, no RLS) and are read directly.
 *
 * ── DIBBS awards can never reach this producer, structurally ────────────────
 * `tango_dibbs_award` is read ONLY for the prior-CAGE-award-history lookup
 * below. It is never a source of candidate rows: `scoreDibbsRelevance`'s input
 * type admits only `documentType: 'rfq' | 'rfp'`, and an award has neither —
 * see dibbs-relevance.ts's own docblock for why that is enforced by TYPE, not
 * by a filter this script could get wrong.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun, emptyCounts, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import { FUNDING_OPPORTUNITIES_FEATURE } from '../src/funding-opportunities/funding-opportunities-flag.guard.js';
import {
  scoreDibbsRelevance,
  type DibbsPursuableDocumentType,
} from '../src/funding-opportunities/dibbs-relevance.js';
import { GENERIC_TOKENS } from '../src/funding-opportunities/sam-opportunity-relevance.js';
import { buildClientOpportunityProfile } from '../src/funding-opportunities/client-opportunity-profile.builder.js';
import { profileIsTooThin } from '../src/funding-opportunities/missing-profile-fields.js';
import type { ClientOpportunityProfileV1 } from '../src/funding-opportunities/client-opportunity-profile.types.js';
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_SIZE,
  completeCoverage,
  incompleteCoverage,
  walkKeyset,
  type KeysetWalkOutcome,
  type ProducerCompletion,
} from '../src/funding-opportunities/producer-pagination.js';
import {
  buildAwardHistoryIdentity,
  contractorIdsToResolve,
} from '../src/funding-opportunities/award-history-identity.js';
import {
  asProfileReadClient,
  readAwardHistoryByBasis,
  readClientProfileFactsMany,
  resolveContractorUeis,
} from '../src/funding-opportunities/client-opportunity-profile.repository.js';
import { sourceRecordIdentityColumns } from '../src/funding-opportunities/funding-opportunity-identity.js';
import { decideProducerAction } from '../src/funding-opportunities/producer-decision.js';
import type { ClientProfileFacts } from '../src/funding-opportunities/client-opportunity-profile.types.js';

dotenvConfig();

const SOURCE = 'generate-dibbs-opportunity-candidates';
const EVIDENCE_SOURCE_TYPE = 'deterministic_relevance_v1';

/**
 * Confidence → relevanceScore bridge.
 *
 * `scoreDibbsRelevance` returns no numeric score at all — only
 * `recommendationConfidence` ('high'/'medium'/'low') and a boolean
 * `clearsSuggestionFloor`. `decideProducerAction` requires a numeric
 * `relevanceScore`, the same way every other producer's scorer already
 * supplies one.
 *
 * VERIFIED INVARIANT (read `scoreDibbsRelevance`'s full rule chain to confirm,
 * do not assume): `clearsSuggestionFloor: true` only ever occurs in the
 * "strong match" rule, whose confidence is always 'high' or 'medium', never
 * 'low'. So the boolean floor is always the real gate here; this numeric
 * mapping only becomes load-bearing if an operator deliberately raises
 * `--min-relevance` above 60 to restrict to high-confidence rows only — see
 * `generate-dibbs-opportunity-candidates.spec.ts`'s dedicated test for this.
 */
const CONFIDENCE_SCORE: Record<'high' | 'medium' | 'low', number> = {
  high: 90,
  medium: 60,
  low: 30,
};

export const DEFAULT_MIN_RELEVANCE = 15;
export const PAGE_SIZE = DEFAULT_PAGE_SIZE;
export const MAX_PAGES = DEFAULT_MAX_PAGES;

/** Fields the DIBBS scorer and the workflow snapshot need. */
const SOLICITATION_SELECT = {
  id: true,
  tangoDibbsId: true,
  documentType: true,
  isOpen: true,
  closesDate: true,
  nomenclature: true,
  updatedAt: true,
  lastSyncedAt: true,
} as const;

type DibbsSolicitationRow = {
  id: string;
  tangoDibbsId: string;
  documentType: string;
  isOpen: boolean | null;
  closesDate: Date | null;
  nomenclature: string | null;
  updatedAt: Date;
  lastSyncedAt: Date;
};

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export interface ParsedArgs {
  commit: boolean;
  tenantId: string | null;
  clientId: string | null;
  minRelevance: number;
  resumeClient: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const minArg = flagValue(argv, 'min-relevance');
  return {
    commit: hasFlag(argv, 'commit'),
    tenantId: flagValue(argv, 'tenant') ?? null,
    clientId: flagValue(argv, 'client') ?? null,
    minRelevance: minArg != null && minArg.length > 0 ? Number(minArg) : DEFAULT_MIN_RELEVANCE,
    resumeClient: flagValue(argv, 'resume-client') ?? null,
  };
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v && v.length > 0)),
  );
}

/** CAGE codes are 5-character provider identifiers, uppercased for comparison. */
function normalizeCage(value: string | null | undefined): string | null {
  const v = value?.trim().toUpperCase();
  return v && v.length > 0 ? v : null;
}

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

/**
 * Substring, not fuzzy — same convention as `sam-opportunity-relevance.ts`'s
 * own text signal: a deterministic hit an operator can go and find in the
 * nomenclature is the requirement. A generic single-word capability term
 * (shared `GENERIC_TOKENS`) is excluded unless it is part of a multi-word
 * phrase, so "systems" alone cannot manufacture a hit.
 */
function capabilityTextMatch(capabilityKeywords: string[], haystack: string | null): boolean {
  const h = norm(haystack);
  if (!h) return false;
  return capabilityKeywords.some((k) => {
    const needle = norm(k);
    if (needle.length <= 2) return false;
    if (!needle.includes(' ') && GENERIC_TOKENS.has(needle)) return false;
    return h.includes(needle);
  });
}

/** Minimal Prisma slice this job touches — duck-typed so it is unit-testable. */
export interface DibbsCandidatesPrisma {
  $transaction<T>(fn: (tx: DibbsCandidatesPrisma) => Promise<T>): Promise<T>;
  $executeRawUnsafe(sql: string): Promise<unknown>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  client: {
    findMany(args: unknown): Promise<
      Array<{
        id: string;
        naicsCodes: string[];
        pscCodes: string[];
        applicantTypes: string[];
        setAsideCertifications: string[];
        sectorTag: string | null;
        cageCode: string | null;
        capabilities: Array<{ name: string; tags: unknown; keywords: string[]; peNumbers: string[] }>;
        facilities: Array<{ city: string | null; state: string | null; zip: string | null }>;
      }>
    >;
  };
  clientIntelMapping: {
    findMany(args: unknown): Promise<
      Array<{
        clientId: string;
        source: string;
        externalId: string | null;
        externalName: string | null;
        rollUpAwards: boolean | null;
      }>
    >;
  };
  tangoDibbsSolicitation: {
    findMany(args: unknown): Promise<DibbsSolicitationRow[]>;
  };
  clientFundingOpportunity: {
    findMany(args: unknown): Promise<
      Array<{
        id: string;
        clientId: string;
        sourceRecordKey: string | null;
        workflowStatus: string;
        userCreated: boolean;
        evidenceSourceType: string;
        staleAt: Date | null;
      }>
    >;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
}

/** RLS bypass for the FORCE-RLS tables. Same idiom as the SAM/grant producers. */
async function withBypass<T>(
  prisma: DibbsCandidatesPrisma,
  fn: (tx: DibbsCandidatesPrisma) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

/**
 * Tenants to evaluate. Identical policy to the SAM producer — deliberately no
 * internal-tenant hardcode; see `resolveTenantIds` there for the full reasoning.
 */
export async function resolveTenantIds(
  prisma: DibbsCandidatesPrisma,
  explicitTenantId: string | null,
): Promise<string[]> {
  if (explicitTenantId) return [explicitTenantId];
  const rows = await withBypass(prisma, (tx) =>
    tx.$queryRaw<{ tenant_id: string }>`
      SELECT DISTINCT tenant_id FROM intel_feature_flag
      WHERE feature = ${FUNDING_OPPORTUNITIES_FEATURE} AND enabled = true
    `,
  );
  return dedupe(rows.map((r) => r.tenant_id));
}

/**
 * Whether ANY `tango_dibbs_award` names this CAGE as its awardee, on either of
 * the two provider fields the award mapper keeps separate (P40 stores both
 * because they can disagree). Case/whitespace-insensitive, matching
 * `describeDibbsAwardIntelligence`'s own normalization exactly, so a producer's
 * answer to "does this client have a prior award" can never disagree with what
 * the award-intelligence card would say about the same CAGE.
 *
 * One query per client, only when the client has a recorded CAGE — never an
 * unbounded scan for a client with none, the same discipline
 * `readAwardHistoryByBasis` uses for a client with no UEI.
 */
export async function hasPriorCageAward(
  prisma: Pick<DibbsCandidatesPrisma, '$queryRaw'>,
  cage: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ hit: number }>`
    SELECT 1 AS hit
    FROM tango_dibbs_award
    WHERE upper(trim(awardee_cage)) = ${cage}
       OR upper(trim(awardee_cage_code)) = ${cage}
    LIMIT 1
  `;
  return rows.length > 0;
}

export interface GenerateOptions {
  tenantIds: string[];
  clientId: string | null;
  minRelevance: number;
  commit: boolean;
  resumeClientCursor?: string | null;
}

export interface GenerateResult extends RunCounts {
  evaluated: number;
  created: number;
  refreshed: number;
  markedStale: number;
  humanDecisionsPreserved: number;
  completion: ProducerCompletion;
  clientsRead: number;
  opportunitiesRead: number;
  pursuableRead: number;
  resumeClientCursor: string | null;
}

/**
 * Core loop. Reads ALWAYS run, so a dry run reports the REAL counts of what
 * would happen; only the create/update is gated on `commit`.
 *
 * Query shape mirrors the SAM producer: nested keyset walks, clients outer and
 * solicitations inner. Per client page: one client read, one mapping read, one
 * contractor-UEI resolution. Per CLIENT (not per page): one award-history read
 * (for `completeness`/`profileTooThin`, shared with every other rail) and one
 * CAGE-award-history read (DIBBS-only) — mirroring exactly how the SAM producer
 * bounds its own award-history reads by clients, not by (client, opportunity)
 * pairs.
 */
export async function generateDibbsCandidates(
  prisma: DibbsCandidatesPrisma,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const counts = emptyCounts();
  let evaluated = 0;
  let created = 0;
  let refreshed = 0;
  let markedStale = 0;
  let humanDecisionsPreserved = 0;
  let clientsRead = 0;
  let solicitationCorpus = 0;
  let solicitationWalkIncomplete = false;
  let clientWalkOutcome: KeysetWalkOutcome | null = null;

  const now = new Date();
  // Not closed: the provider did not say closed, AND the closing date (if any)
  // has not passed. The exact complement of `isClosed` in dibbs-relevance.ts —
  // written as explicit OR-of-null-or-true rather than a Prisma `NOT`, because
  // `NOT: { isOpen: false }` is ambiguous for a nullable column and this must
  // not silently exclude every solicitation the provider never marked either
  // way.
  const activeSolicitationWhere = {
    AND: [
      { OR: [{ isOpen: null }, { isOpen: true }] },
      { OR: [{ closesDate: null }, { closesDate: { gte: now } }] },
    ],
  };

  for (const tenantId of options.tenantIds) {
    clientWalkOutcome = await walkKeyset<ClientProfileFacts>({
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
      startCursor: options.resumeClientCursor ?? null,
      key: (client) => client.clientId,
      shouldStop: () => solicitationWalkIncomplete,
      read: (cursor, take) =>
        withBypass(prisma, (tx) =>
          readClientProfileFactsMany(asProfileReadClient(tx), {
            tenantId,
            clientId: options.clientId,
            cursor,
            take,
          }),
        ),
      onPage: async (clientPage) => {
        clientsRead += clientPage.length;
        const clientIds = clientPage.map((c) => c.clientId);

        const contractorUeis = await resolveContractorUeis(
          prisma,
          contractorIdsToResolve(clientPage),
        );

        // Per CLIENT: the shared profile (so `profileTooThin`/`completeness`
        // agree with every other rail scoring the same client), plus the
        // DIBBS-only CAGE-award check.
        const profileByClient = new Map<string, ClientOpportunityProfileV1>();
        const priorCageByClient = new Map<string, boolean>();
        for (const client of clientPage) {
          const history = await readAwardHistoryByBasis(
            prisma,
            buildAwardHistoryIdentity(client, contractorUeis),
          );
          profileByClient.set(client.clientId, buildClientOpportunityProfile(client, history));

          const cage = normalizeCage(client.cageCode);
          priorCageByClient.set(
            client.clientId,
            cage != null ? await hasPriorCageAward(prisma, cage) : false,
          );
        }

        const solicitationWalk = await walkKeyset<DibbsSolicitationRow>({
          pageSize: PAGE_SIZE,
          maxPages: MAX_PAGES,
          key: (row) => row.id,
          read: (cursor, take) =>
            prisma.tangoDibbsSolicitation.findMany({
              where: { ...activeSolicitationWhere, ...(cursor ? { id: { gt: cursor } } : {}) },
              select: SOLICITATION_SELECT,
              // Keyset order, never closesDate — nullable, non-unique, mutable.
              orderBy: { id: 'asc' },
              take,
            }),
          onPage: async (solicitationPage) => {
            if (solicitationPage.length === 0) return;

            const existingRows = await withBypass(prisma, (tx) =>
              tx.clientFundingOpportunity.findMany({
                where: {
                  tenantId,
                  clientId: { in: clientIds },
                  source: 'dibbs',
                  sourceRecordKey: { in: solicitationPage.map((s) => s.tangoDibbsId) },
                },
                select: {
                  id: true,
                  clientId: true,
                  sourceRecordKey: true,
                  workflowStatus: true,
                  userCreated: true,
                  evidenceSourceType: true,
                  staleAt: true,
                },
              }),
            );
            const existingByKey = new Map<string, (typeof existingRows)[number]>();
            for (const r of existingRows) {
              if (r.sourceRecordKey) existingByKey.set(`${r.clientId}:${r.sourceRecordKey}`, r);
            }

            for (const client of clientPage) {
              const profile = profileByClient.get(client.clientId)!;
              const priorCage = priorCageByClient.get(client.clientId)!;
              for (const row of solicitationPage) {
                evaluated += 1;
                try {
                  const scored = scoreDibbsRelevance({
                    documentType: row.documentType as DibbsPursuableDocumentType,
                    isOpen: row.isOpen,
                    closesDate: row.closesDate ? row.closesDate.toISOString().slice(0, 10) : null,
                    profileTooThin: profileIsTooThin(profile.completeness),
                    // DORMANT — no client part/NSN store exists. See
                    // dibbs-relevance.ts's own docblock; never fed a lookalike.
                    exactNsnMatch: false,
                    exactPartNumberMatch: false,
                    priorCageAwardHistory: priorCage,
                    // DORMANT — nothing stores a client's DLA buyer history.
                    buyerHistory: false,
                    capabilityTextMatch: capabilityTextMatch(
                      profile.sam.capabilityKeywords,
                      row.nomenclature,
                    ),
                    // DORMANT today for every client — see the file doc.
                    clientHasRecordedParts: false,
                    asOf: now,
                  });
                  const relevanceScore = CONFIDENCE_SCORE[scored.recommendationConfidence];
                  const existing = existingByKey.get(`${client.clientId}:${row.tangoDibbsId}`) ?? null;
                  const decision = decideProducerAction({
                    existing,
                    relevanceScore,
                    meetsSuggestionFloor: scored.clearsSuggestionFloor,
                    minRelevance: options.minRelevance,
                  });

                  switch (decision.action) {
                    case 'skip_human_decision':
                      humanDecisionsPreserved += 1;
                      counts.skipped += 1;
                      break;
                    case 'skip_below_floor':
                    case 'noop':
                      counts.skipped += 1;
                      break;
                    case 'create': {
                      created += 1;
                      counts.inserted += 1;
                      if (options.commit) {
                        await withBypass(prisma, (tx) =>
                          tx.clientFundingOpportunity.create({
                            data: {
                              tenantId,
                              clientId: client.clientId,
                              source: 'dibbs',
                              ...sourceRecordIdentityColumns('dibbs', row.tangoDibbsId),
                              workflowStatus: 'suggested',
                              evidenceSourceType: EVIDENCE_SOURCE_TYPE,
                              userCreated: false,
                              relevanceScore,
                              // No numeric-weighted signal list exists for this
                              // scorer (see the confidence-bridge doc above), so
                              // the reason-code vocabulary IS the evidence, plus
                              // the part-profile gap — a first-class fact per
                              // dibbs-relevance.ts, never collapsed into a score.
                              matchSignals: {
                                reasonCodes: scored.reasonCodes,
                                dibbsPartProfileGap: scored.dibbsPartProfileGap,
                              },
                              // DIBBS has no eligibility concept — eligibilityState
                              // /eligibilityReason stay null, deliberately, rather
                              // than fabricating a value the scorer never produces.
                              sourceStatusSnapshot: row.isOpen === false ? 'closed' : 'open',
                              responseDeadlineSnapshot: row.closesDate,
                              sourceUpdatedAtSnapshot: row.updatedAt ?? row.lastSyncedAt,
                            },
                          }),
                        );
                      }
                      break;
                    }
                    case 'refresh': {
                      refreshed += 1;
                      counts.updated += 1;
                      if (options.commit) {
                        await withBypass(prisma, (tx) =>
                          tx.clientFundingOpportunity.update({
                            where: { id: decision.id },
                            data: {
                              relevanceScore,
                              matchSignals: {
                                reasonCodes: scored.reasonCodes,
                                dibbsPartProfileGap: scored.dibbsPartProfileGap,
                              },
                              sourceStatusSnapshot: row.isOpen === false ? 'closed' : 'open',
                              responseDeadlineSnapshot: row.closesDate,
                              sourceUpdatedAtSnapshot: row.updatedAt ?? row.lastSyncedAt,
                              staleAt: null,
                            },
                          }),
                        );
                      }
                      break;
                    }
                    case 'mark_stale':
                      markedStale += 1;
                      counts.updated += 1;
                      if (options.commit) {
                        await withBypass(prisma, (tx) =>
                          tx.clientFundingOpportunity.update({
                            where: { id: decision.id },
                            data: { staleAt: new Date() },
                          }),
                        );
                      }
                      break;
                  }
                } catch (err) {
                  counts.errors += 1;
                  console.warn(
                    `[dibbs-candidates] failed ${client.clientId} x ${row.tangoDibbsId}: ${
                      (err as Error).message
                    }`,
                  );
                }
              }
            }
          },
        });

        if (solicitationWalk.completion === 'INCOMPLETE') solicitationWalkIncomplete = true;
        // Every row read from `activeSolicitationWhere` is pursuable by
        // construction (rfq/rfp only; awards live in a separate table), so
        // there is no separate "pursuable" sub-count the way SAM's notice-kind
        // filter needs one.
        solicitationCorpus = Math.max(solicitationCorpus, solicitationWalk.rowsRead);
      },
    });
  }

  console.log(`[dibbs-candidates] ${solicitationCorpus} active rfq/rfp rows scanned`);

  const coverage =
    solicitationWalkIncomplete || clientWalkOutcome?.completion === 'INCOMPLETE'
      ? incompleteCoverage({
          clientsRead,
          opportunitiesRead: solicitationCorpus,
          resumeClientCursor: clientWalkOutcome?.resumeCursor ?? null,
          guard: solicitationWalkIncomplete ? 'opportunity_pages' : 'client_pages',
          resumeFlag: '--resume-client',
        })
      : completeCoverage(clientsRead, solicitationCorpus);

  if (coverage.completion === 'INCOMPLETE') {
    counts.complete = false;
    counts.incompleteReason = coverage.incompleteReason ?? undefined;
  }

  return {
    ...counts,
    evaluated,
    created,
    refreshed,
    markedStale,
    humanDecisionsPreserved,
    completion: coverage.completion,
    clientsRead: coverage.clientsRead,
    opportunitiesRead: coverage.opportunitiesRead,
    pursuableRead: coverage.opportunitiesRead,
    resumeClientCursor: coverage.resumeClientCursor,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log(
    `[dibbs-candidates] starting (${args.commit ? 'COMMIT' : 'DRY-RUN'}) minRelevance=${args.minRelevance}` +
      (args.tenantId ? ` tenant=${args.tenantId}` : '') +
      (args.clientId ? ` client=${args.clientId}` : ''),
  );
  try {
    const duck = prisma as unknown as DibbsCandidatesPrisma;
    const tenantIds = await resolveTenantIds(duck, args.tenantId);
    if (tenantIds.length === 0) {
      console.warn(
        `[dibbs-candidates] no tenant has an enabled '${FUNDING_OPPORTUNITIES_FEATURE}' flag — nothing to do. ` +
          `Pass --tenant <id> to evaluate a specific tenant regardless of flag state.`,
      );
    }
    console.log(`[dibbs-candidates] ${tenantIds.length} tenant(s) in scope`);

    const execute = async () => {
      const result = await generateDibbsCandidates(duck, {
        tenantIds,
        clientId: args.clientId,
        minRelevance: args.minRelevance,
        commit: args.commit,
        resumeClientCursor: args.resumeClient,
      });
      if (result.completion === 'INCOMPLETE') {
        console.warn(
          `[dibbs-candidates] ⚠️ INCOMPLETE: ${result.incompleteReason ?? 'coverage is partial'}`,
        );
      }
      console.log(
        `[dibbs-candidates] evaluated=${result.evaluated} created=${result.created} ` +
          `refreshed=${result.refreshed} markedStale=${result.markedStale} ` +
          `humanDecisionsPreserved=${result.humanDecisionsPreserved} errors=${result.errors} ` +
          `coverage=${result.completion} clients=${result.clientsRead} ` +
          `solicitations=${result.opportunitiesRead} ` +
          `in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
          `(${args.commit ? 'COMMITTED' : 'DRY-RUN, nothing written'})`,
      );
      return result;
    };
    if (args.commit) {
      await runWithSyncRun(prisma as never, SOURCE, async (): Promise<RunCounts> => execute());
    } else {
      await execute();
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Guarded entrypoint: only runs when invoked directly, never on import (the
// spec imports the pure helpers) — see decision-log D-28.
const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /generate-dibbs-opportunity-candidates(\.[cm]?[tj]s)?$/.test(
      invoked.replace(/\\/g, '/'),
    );
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error('[dibbs-candidates] FAILED', err);
    process.exit(1);
  });
}

export { main };
