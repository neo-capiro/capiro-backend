/**
 * Funding Opportunities — deterministic producer for client ↔ SBIR/STTR topic
 * suggestions (`client_funding_opportunity`, source 'sbir_sttr').
 *
 *   tsx scripts/generate-sbir-opportunity-candidates.ts                        # dry run
 *   tsx scripts/generate-sbir-opportunity-candidates.ts --commit
 *   tsx scripts/generate-sbir-opportunity-candidates.ts --commit --tenant <id>
 *   tsx scripts/generate-sbir-opportunity-candidates.ts --commit --client <id>
 *   tsx scripts/generate-sbir-opportunity-candidates.ts --commit --min-relevance=25
 *
 * DRY-RUN BY DEFAULT. Nothing is written without `--commit`.
 *
 * ── Why this producer is the ONLY path to visibility, unlike SAM/Grants' ────
 *
 * `generate-sam-opportunity-candidates.ts` exists on top of a live read-time
 * scoring path. SBIR has no such path: `scoreSbirRelevance`
 * (sbir-relevance.ts) is a pure, tested function that nothing outside its own
 * spec calls. Until this producer runs, `client_funding_opportunity` holds
 * zero 'sbir_sttr' rows for anyone — deliberate, matching the posture
 * `forecast-relevance.ts` (P25) has always had (see decision-log.md, the
 * entry after D-78).
 *
 * ── The topic→cycle join, replicated from the inbox's OWN rendering path ────
 *
 * `program` (SBIR vs STTR) and the cycle's display name live on the PARENT
 * CYCLE (`tango_sbir_solicitation`), not on the topic — `tango_sbir_topic` only
 * carries a stated, unenforced `solicitationNumber`. `scoreSbirRelevance` does
 * NOT take `program` as an input at all (it isn't a scoring signal), so this
 * join exists purely to persist accurate display data alongside the score,
 * mirroring exactly what `funding-opportunity-inbox.service.ts`'s `titlesFor`
 * already does for rendering: batch the topic page's distinct solicitation
 * numbers, look up cycles once, and treat a topic with no resolvable cycle as
 * a normal (if less informative) row — never a reason to skip scoring it.
 *
 * ── RLS ─────────────────────────────────────────────────────────────────────
 * `clients`, `client_intel_mapping` and `client_funding_opportunity` are all
 * FORCE-RLS; every read/write against them runs inside `withBypass` with an
 * explicit `tenantId` filter alongside it, same idiom as every other producer
 * in this program. `tango_sbir_topic` and `tango_sbir_solicitation` are global
 * (no tenantId, no RLS) and are read directly.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun, emptyCounts, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import { FUNDING_OPPORTUNITIES_FEATURE } from '../src/funding-opportunities/funding-opportunities-flag.guard.js';
import { scoreSbirRelevance, isTopicClosed } from '../src/funding-opportunities/sbir-relevance.js';
import { GENERIC_TOKENS, normAgency } from '../src/funding-opportunities/sam-opportunity-relevance.js';
import { buildClientOpportunityProfile } from '../src/funding-opportunities/client-opportunity-profile.builder.js';
import { profileIsTooThin } from '../src/funding-opportunities/missing-profile-fields.js';
import type {
  ClientOpportunityProfileV1,
  ClientProfileFacts,
} from '../src/funding-opportunities/client-opportunity-profile.types.js';
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

dotenvConfig();

const SOURCE = 'generate-sbir-opportunity-candidates';
const EVIDENCE_SOURCE_TYPE = 'deterministic_relevance_v1';

/**
 * Confidence → relevanceScore bridge. Same shape and same reasoning as the
 * DIBBS producer's — see that file's docblock for the full explanation.
 *
 * VERIFIED INVARIANT (read `scoreSbirRelevance`'s full rule chain to confirm):
 * `clearsSuggestionFloor` is only ever `true` in Rule 4 (always 'high' or
 * 'medium') or Rule 5 when `historyIsIdentifierBacked` is true, where
 * `recommendationConfidence` is set to `'medium'` in lockstep with
 * `clearsSuggestionFloor: strong` — never `'low'`. So the boolean floor is
 * always the real gate.
 */
const CONFIDENCE_SCORE: Record<'high' | 'medium' | 'low', number> = {
  high: 90,
  medium: 60,
  low: 30,
};

export const DEFAULT_MIN_RELEVANCE = 15;
export const PAGE_SIZE = DEFAULT_PAGE_SIZE;
export const MAX_PAGES = DEFAULT_MAX_PAGES;

/** Fields the SBIR scorer and the workflow snapshot need. */
const TOPIC_SELECT = {
  id: true,
  tangoSbirId: true,
  title: true,
  agency: true,
  solicitationNumber: true,
  closeDate: true,
  solicitationStatus: true,
  updatedAt: true,
  lastSyncedAt: true,
} as const;

type SbirTopicRow = {
  id: string;
  tangoSbirId: string;
  title: string | null;
  agency: string | null;
  solicitationNumber: string | null;
  closeDate: Date | null;
  solicitationStatus: string | null;
  updatedAt: Date;
  lastSyncedAt: Date;
};

/** Fields the topic→cycle join reads. Program/cycleName are display-only. */
const CYCLE_SELECT = {
  solicitationNumber: true,
  program: true,
  cycleName: true,
} as const;

type SbirCycleRow = {
  solicitationNumber: string;
  program: string | null;
  cycleName: string | null;
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

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

/** Same substring convention as `sam-opportunity-relevance.ts`'s text signal. */
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
export interface SbirCandidatesPrisma {
  $transaction<T>(fn: (tx: SbirCandidatesPrisma) => Promise<T>): Promise<T>;
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
  tangoSbirTopic: {
    findMany(args: unknown): Promise<SbirTopicRow[]>;
  };
  tangoSbirSolicitation: {
    findMany(args: unknown): Promise<SbirCycleRow[]>;
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

/** RLS bypass for the FORCE-RLS tables. Same idiom as every other producer. */
async function withBypass<T>(
  prisma: SbirCandidatesPrisma,
  fn: (tx: SbirCandidatesPrisma) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

/** Tenants to evaluate. Identical policy to every other producer in this program. */
export async function resolveTenantIds(
  prisma: SbirCandidatesPrisma,
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
 * Query shape mirrors the DIBBS/SAM producers: nested keyset walks, clients
 * outer and topics inner. Per client page: one client read, one mapping read,
 * one contractor-UEI resolution. Per client: one award-history read (shared
 * `completeness`/`profileTooThin` with every other rail). Per topic page: one
 * batched cycle lookup, keyed on the page's distinct `solicitationNumber`s —
 * the SAME shape `titlesFor` already uses for rendering.
 */
export async function generateSbirCandidates(
  prisma: SbirCandidatesPrisma,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const counts = emptyCounts();
  let evaluated = 0;
  let created = 0;
  let refreshed = 0;
  let markedStale = 0;
  let humanDecisionsPreserved = 0;
  let clientsRead = 0;
  let topicCorpus = 0;
  let openCorpus = 0;
  let topicWalkIncomplete = false;
  let clientWalkOutcome: KeysetWalkOutcome | null = null;

  const now = new Date();
  // Date-only pre-filter in SQL — unambiguous, unlike the provider's free-text
  // status word, which is compared CASE-INSENSITIVELY against a small closed
  // set inside `isTopicClosed`. Replicating that exact vocabulary as a second
  // SQL predicate risks silently diverging from the scorer's own definition of
  // "closed" (a casing difference alone would do it); instead this SQL only
  // narrows by date, and the exact status-word filter runs in JS below via the
  // SAME `isTopicClosed` function the scorer itself is built on — matching how
  // the SAM producer keeps its own notice-kind filter in JS rather than SQL.
  const notPastCloseDateWhere = {
    OR: [{ closeDate: null }, { closeDate: { gte: now } }],
  };

  for (const tenantId of options.tenantIds) {
    clientWalkOutcome = await walkKeyset<ClientProfileFacts>({
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
      startCursor: options.resumeClientCursor ?? null,
      key: (client) => client.clientId,
      shouldStop: () => topicWalkIncomplete,
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

        const profileByClient = new Map<string, ClientOpportunityProfileV1>();
        for (const client of clientPage) {
          const history = await readAwardHistoryByBasis(
            prisma,
            buildAwardHistoryIdentity(client, contractorUeis),
          );
          profileByClient.set(client.clientId, buildClientOpportunityProfile(client, history));
        }

        let openThisWalk = 0;

        const topicWalk = await walkKeyset<SbirTopicRow>({
          pageSize: PAGE_SIZE,
          maxPages: MAX_PAGES,
          key: (row) => row.id,
          read: (cursor, take) =>
            prisma.tangoSbirTopic.findMany({
              where: { ...notPastCloseDateWhere, ...(cursor ? { id: { gt: cursor } } : {}) },
              select: TOPIC_SELECT,
              orderBy: { id: 'asc' },
              take,
            }),
          onPage: async (rawTopicPage) => {
            // The exact business-logic filter, not a re-derivation of it — see
            // the file doc above for why this stays in JS.
            const openTopics = rawTopicPage.filter(
              (t) =>
                !isTopicClosed({
                  solicitationStatus: t.solicitationStatus,
                  closeDate: t.closeDate ? t.closeDate.toISOString().slice(0, 10) : null,
                  asOf: now,
                }),
            );
            openThisWalk += openTopics.length;
            if (openTopics.length === 0) return;

            // Batched cycle lookup, same shape as titlesFor's own — one query
            // for the whole page, keyed on distinct solicitation numbers.
            const cycleNumbers = dedupe(openTopics.map((t) => t.solicitationNumber));
            const cycleByNumber = new Map<string, SbirCycleRow>();
            if (cycleNumbers.length > 0) {
              const cycles = await prisma.tangoSbirSolicitation.findMany({
                where: { solicitationNumber: { in: cycleNumbers } },
                select: CYCLE_SELECT,
              });
              for (const c of cycles) cycleByNumber.set(c.solicitationNumber, c);
            }

            const existingRows = await withBypass(prisma, (tx) =>
              tx.clientFundingOpportunity.findMany({
                where: {
                  tenantId,
                  clientId: { in: clientIds },
                  source: 'sbir_sttr',
                  sourceRecordKey: { in: openTopics.map((t) => t.tangoSbirId) },
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
              // Per CLIENT, not per (client, topic) pair.
              const priorAgencies = new Set(
                profile.sam.priorAgencies.map(normAgency).filter(Boolean),
              );
              const historyIsIdentifierBacked = profile.identityBasis.contract === 'exact_uei';

              for (const topic of openTopics) {
                evaluated += 1;
                try {
                  const cycle =
                    topic.solicitationNumber != null
                      ? (cycleByNumber.get(topic.solicitationNumber) ?? null)
                      : null;
                  const scored = scoreSbirRelevance({
                    solicitationStatus: topic.solicitationStatus,
                    closeDate: topic.closeDate ? topic.closeDate.toISOString().slice(0, 10) : null,
                    profileTooThin: profileIsTooThin(profile.completeness),
                    capabilityTopicMatch: capabilityTextMatch(
                      profile.sam.capabilityKeywords,
                      topic.title,
                    ),
                    priorAgencyHistory:
                      topic.agency != null && priorAgencies.has(normAgency(topic.agency)),
                    historyIsIdentifierBacked,
                    // DORMANT — no PE column on this source, nothing stores prior
                    // SBIR history. See sbir-relevance.ts's own docblock; never
                    // fed a lookalike.
                    programElementLinkedSourceBacked: false,
                    priorSbirHistorySourceBacked: false,
                    asOf: now,
                  });
                  const relevanceScore = CONFIDENCE_SCORE[scored.recommendationConfidence];
                  const existing = existingByKey.get(`${client.clientId}:${topic.tangoSbirId}`) ?? null;
                  const decision = decideProducerAction({
                    existing,
                    relevanceScore,
                    meetsSuggestionFloor: scored.clearsSuggestionFloor,
                    minRelevance: options.minRelevance,
                  });

                  const matchSignals = {
                    reasonCodes: scored.reasonCodes,
                    sbirPhaseGap: scored.sbirPhaseGap,
                    program: cycle?.program ?? null,
                    cycleName: cycle?.cycleName ?? null,
                  };

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
                              source: 'sbir_sttr',
                              ...sourceRecordIdentityColumns('sbir_sttr', topic.tangoSbirId),
                              workflowStatus: 'suggested',
                              evidenceSourceType: EVIDENCE_SOURCE_TYPE,
                              userCreated: false,
                              relevanceScore,
                              matchSignals,
                              // The scorer's REAL output — always 'needs_review'
                              // with a reason naming what's missing, never
                              // fabricated for a source that lacks the concept.
                              eligibilityState: scored.eligibility,
                              eligibilityReason: scored.eligibilityReason,
                              sourceStatusSnapshot: topic.solicitationStatus,
                              responseDeadlineSnapshot: topic.closeDate,
                              sourceUpdatedAtSnapshot: topic.updatedAt ?? topic.lastSyncedAt,
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
                              matchSignals,
                              eligibilityState: scored.eligibility,
                              eligibilityReason: scored.eligibilityReason,
                              sourceStatusSnapshot: topic.solicitationStatus,
                              responseDeadlineSnapshot: topic.closeDate,
                              sourceUpdatedAtSnapshot: topic.updatedAt ?? topic.lastSyncedAt,
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
                    `[sbir-candidates] failed ${client.clientId} x ${topic.tangoSbirId}: ${
                      (err as Error).message
                    }`,
                  );
                }
              }
            }
          },
        });

        if (topicWalk.completion === 'INCOMPLETE') topicWalkIncomplete = true;
        topicCorpus = Math.max(topicCorpus, topicWalk.rowsRead);
        openCorpus = Math.max(openCorpus, openThisWalk);
      },
    });
  }

  console.log(`[sbir-candidates] ${topicCorpus} not-past-close-date topics scanned, ${openCorpus} open`);

  const coverage =
    topicWalkIncomplete || clientWalkOutcome?.completion === 'INCOMPLETE'
      ? incompleteCoverage({
          clientsRead,
          opportunitiesRead: topicCorpus,
          resumeClientCursor: clientWalkOutcome?.resumeCursor ?? null,
          guard: topicWalkIncomplete ? 'opportunity_pages' : 'client_pages',
          resumeFlag: '--resume-client',
        })
      : completeCoverage(clientsRead, topicCorpus);

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
    pursuableRead: openCorpus,
    resumeClientCursor: coverage.resumeClientCursor,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log(
    `[sbir-candidates] starting (${args.commit ? 'COMMIT' : 'DRY-RUN'}) minRelevance=${args.minRelevance}` +
      (args.tenantId ? ` tenant=${args.tenantId}` : '') +
      (args.clientId ? ` client=${args.clientId}` : ''),
  );
  try {
    const duck = prisma as unknown as SbirCandidatesPrisma;
    const tenantIds = await resolveTenantIds(duck, args.tenantId);
    if (tenantIds.length === 0) {
      console.warn(
        `[sbir-candidates] no tenant has an enabled '${FUNDING_OPPORTUNITIES_FEATURE}' flag — nothing to do. ` +
          `Pass --tenant <id> to evaluate a specific tenant regardless of flag state.`,
      );
    }
    console.log(`[sbir-candidates] ${tenantIds.length} tenant(s) in scope`);

    const execute = async () => {
      const result = await generateSbirCandidates(duck, {
        tenantIds,
        clientId: args.clientId,
        minRelevance: args.minRelevance,
        commit: args.commit,
        resumeClientCursor: args.resumeClient,
      });
      if (result.completion === 'INCOMPLETE') {
        console.warn(
          `[sbir-candidates] ⚠️ INCOMPLETE: ${result.incompleteReason ?? 'coverage is partial'}`,
        );
      }
      console.log(
        `[sbir-candidates] evaluated=${result.evaluated} created=${result.created} ` +
          `refreshed=${result.refreshed} markedStale=${result.markedStale} ` +
          `humanDecisionsPreserved=${result.humanDecisionsPreserved} errors=${result.errors} ` +
          `coverage=${result.completion} clients=${result.clientsRead} ` +
          `topics=${result.opportunitiesRead} open=${result.pursuableRead} ` +
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
    return /generate-sbir-opportunity-candidates(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error('[sbir-candidates] FAILED', err);
    process.exit(1);
  });
}

export { main };
