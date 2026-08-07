/**
 * Persist Grants.gov suggestions into client_funding_opportunity.
 *
 * Dry-run by default. Pass --commit to write. This is intentionally separate
 * from generate-grant-opportunity-candidates.ts, which remains the District
 * Nexus compatibility producer for ClientGrantNexus.
 */
import { config as dotenvConfig } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithSyncRun, emptyCounts, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import { FUNDING_OPPORTUNITIES_FEATURE } from '../src/funding-opportunities/funding-opportunities-flag.guard.js';
import { decideProducerAction } from '../src/funding-opportunities/producer-decision.js';
import { sourceRecordIdentityColumns } from '../src/funding-opportunities/funding-opportunity-identity.js';
import {
  computeEligibility,
  scoreOpportunityRelevance,
  MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR,
  type ClientRelevanceProfile,
} from '../src/district-nexus/grant-opportunity-relevance.js';
import { buildClientOpportunityProfile } from '../src/funding-opportunities/client-opportunity-profile.builder.js';
import type { ClientProfileFacts } from '../src/funding-opportunities/client-opportunity-profile.types.js';
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

dotenvConfig();

const SOURCE = 'generate-funding-grant-candidates';
const EVIDENCE_SOURCE_TYPE = 'deterministic_relevance_v1';
export const DEFAULT_MIN_RELEVANCE = MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR;
/**
 * Page size for BOTH keyset walks. Not a coverage boundary — see
 * producer-pagination.ts. Replaces OPPORTUNITY_SCAN_CAP (4000) and CLIENT_CAP
 * (500), which were coverage boundaries and silently truncated the corpus.
 */
export const PAGE_SIZE = DEFAULT_PAGE_SIZE;
/** Runaway guard per walk. Reaching it is INCOMPLETE, never a clean success. */
export const MAX_PAGES = DEFAULT_MAX_PAGES;

/** Fields the grant scorer and the workflow snapshot need. */
const GRANT_SELECT = {
  id: true,
  title: true,
  agency: true,
  category: true,
  eligibility: true,
  cfdaNumbers: true,
  description: true,
  status: true,
  closeDate: true,
  lastUpdatedAt: true,
  detailSyncedAt: true,
  syncedAt: true,
} as const;

interface Args {
  commit: boolean;
  tenantId: string | null;
  clientId: string | null;
  minRelevance: number;
  /** Resume point from a prior INCOMPLETE run's reported cursor. */
  resumeClient: string | null;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function value(argv: string[], name: string): string | null {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}
export function parseArgs(argv: string[]): Args {
  const min = value(argv, 'min-relevance');
  const parsed = min == null ? DEFAULT_MIN_RELEVANCE : Number(min);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('--min-relevance must be a number from 0 to 100');
  }
  return {
    commit: flag(argv, 'commit'),
    tenantId: value(argv, 'tenant'),
    clientId: value(argv, 'client'),
    minRelevance: parsed,
    resumeClient: value(argv, 'resume-client'),
  };
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}
async function withBypass<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as PrismaClient;
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

export async function resolveTenantIds(
  prisma: PrismaClient,
  explicitTenantId: string | null,
): Promise<string[]> {
  if (explicitTenantId) return [explicitTenantId];
  const rows = await withBypass(prisma, (tx) =>
    tx.$queryRaw<Array<{ tenant_id: string }>>`
      SELECT DISTINCT tenant_id
      FROM intel_feature_flag
      WHERE feature = ${FUNDING_OPPORTUNITIES_FEATURE} AND enabled = true
    `,
  );
  return dedupe(rows.map((row) => row.tenant_id));
}

type GrantRow = {
  id: string;
  title: string;
  agency: string | null;
  category: string | null;
  eligibility: string[];
  cfdaNumbers: string[];
  description: string | null;
  status: string | null;
  closeDate: Date | null;
  lastUpdatedAt: Date | null;
  detailSyncedAt: Date | null;
  syncedAt: Date | null;
};

export interface GenerateResult extends RunCounts {
  evaluated: number;
  created: number;
  refreshed: number;
  markedStale: number;
  humanDecisionsPreserved: number;
  /** Shared completion vocabulary — identical words in the SAM producer. */
  completion: ProducerCompletion;
  clientsRead: number;
  opportunitiesRead: number;
  resumeClientCursor: string | null;
}

export async function generateFundingGrantCandidates(
  prisma: PrismaClient,
  options: {
    tenantIds: string[];
    clientId: string | null;
    minRelevance: number;
    commit: boolean;
    resumeClientCursor?: string | null;
  },
): Promise<GenerateResult> {
  const counts = emptyCounts();
  let evaluated = 0;
  let created = 0;
  let refreshed = 0;
  let markedStale = 0;
  let humanDecisionsPreserved = 0;
  let clientsRead = 0;
  let opportunityCorpus = 0;
  let opportunityWalkIncomplete = false;
  let clientWalkOutcome: KeysetWalkOutcome | null = null;
  const now = new Date();

  // Active, in-deadline grants. The predicate is unchanged; what changed is that
  // the walk visits ALL of them instead of the first 4,000 by close date.
  const activeGrantWhere: Prisma.FederalGrantWhereInput = {
    status: { in: ['posted', 'forecasted'] },
    OR: [{ closeDate: null }, { closeDate: { gte: now } }],
  };

  for (const tenantId of options.tenantIds) {
    // Outer walk: tenant clients, keyset on client id.
    clientWalkOutcome = await walkKeyset<ClientProfileFacts>({
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
      startCursor: options.resumeClientCursor ?? null,
      key: (client) => client.clientId,
      // Once the opportunity walk has gone incomplete no later client can be
      // fully evaluated either, so stop rather than issue hundreds more queries
      // for coverage already known to be partial.
      shouldStop: () => opportunityWalkIncomplete,
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
        const clientIds = clientPage.map((client) => client.clientId);

        // Per PAGE, not per client: one contractor-UEI resolution for the page.
        const contractorUeis = await resolveContractorUeis(
          prisma,
          contractorIdsToResolve(clientPage),
        );

        // Award history is one read per client per rail, built ONCE per client and
        // reused across every grant page below. Not wrapped in a try/catch,
        // deliberately: a nightly job that scored every client against
        // silently-empty award history would mark real suggestions stale. The read
        // path degrades; this must crash.
        const profileByClient = new Map<string, ClientRelevanceProfile>();
        for (const client of clientPage) {
          const history = await readAwardHistoryByBasis(
            prisma,
            buildAwardHistoryIdentity(client, contractorUeis),
          );
          profileByClient.set(
            client.clientId,
            buildClientOpportunityProfile(client, history).grant,
          );
        }

        // Inner walk: global grants, keyset on grant id.
        const grantWalk = await walkKeyset<GrantRow>({
          pageSize: PAGE_SIZE,
          maxPages: MAX_PAGES,
          key: (grant) => grant.id,
          read: (cursor, take) =>
            prisma.federalGrant.findMany({
              where: { ...activeGrantWhere, ...(cursor ? { id: { gt: cursor } } : {}) },
              select: GRANT_SELECT,
              // Keyset order, NOT close-date order. closeDate is nullable, not
              // unique and mutable, so paging on it can show a row twice or never.
              orderBy: { id: 'asc' },
              take,
            }),
          onPage: async (grantPage) => {
            // Existing rows for this (client page x grant page) only. Scoping to
            // the grant page keeps memory bounded regardless of how many
            // suggestions a client already has, and it is ONE query for the whole
            // block rather than one per pair.
            const existingRows = await withBypass(prisma, (tx) =>
              tx.clientFundingOpportunity.findMany({
                where: {
                  tenantId,
                  clientId: { in: clientIds },
                  source: 'grants_gov',
                  grantOpportunityId: { in: grantPage.map((grant) => grant.id) },
                },
                select: {
                  id: true,
                  clientId: true,
                  grantOpportunityId: true,
                  workflowStatus: true,
                  userCreated: true,
                  evidenceSourceType: true,
                  staleAt: true,
                },
              }),
            );
            const existingByKey = new Map(
              existingRows
                .filter((row) => row.grantOpportunityId != null)
                .map((row) => [`${row.clientId}:${row.grantOpportunityId}`, row]),
            );

            for (const client of clientPage) {
              const profile = profileByClient.get(client.clientId)!;
              for (const grant of grantPage) {
                evaluated += 1;
                try {
                  const opportunityProfile = {
                    assistanceListingNumber: grant.cfdaNumbers[0] ?? null,
                    agency: grant.agency,
                    fundingCategory: grant.category,
                    title: grant.title,
                    description: grant.description,
                    eligibleApplicantTypes: grant.eligibility,
                    geographicRestrictions: [] as string[],
                  };
                  const scored = scoreOpportunityRelevance(profile, opportunityProfile);
                  const eligibility = computeEligibility(profile, opportunityProfile);
                  const meetsSuggestionFloor =
                    scored.matchedSignals.some((signal) => signal.strength === 'strong') ||
                    scored.matchedSignals.filter((signal) => signal.strength === 'moderate')
                      .length >= 2;
                  const existing =
                    existingByKey.get(`${client.clientId}:${grant.id}`) ?? null;
                  const decision = decideProducerAction({
                    existing,
                    relevanceScore: scored.relevanceScore,
                    meetsSuggestionFloor,
                    minRelevance: options.minRelevance,
                  });
                  const sourceUpdatedAt =
                    grant.lastUpdatedAt ?? grant.detailSyncedAt ?? grant.syncedAt;

                  if (decision.action === 'skip_human_decision') {
                    humanDecisionsPreserved += 1;
                    counts.skipped += 1;
                    continue;
                  }
                  if (decision.action === 'skip_below_floor' || decision.action === 'noop') {
                    counts.skipped += 1;
                    continue;
                  }
                  if (decision.action === 'create') {
                    created += 1;
                    counts.inserted += 1;
                    if (options.commit) {
                      await withBypass(prisma, (tx) =>
                        tx.clientFundingOpportunity.create({
                          data: {
                            tenantId,
                            clientId: client.clientId,
                            source: 'grants_gov',
                            // DUAL-WRITE (P13): legacy pointer AND generic
                            // identity, from one helper so a producer cannot emit
                            // a row the generic index does not see.
                            ...sourceRecordIdentityColumns('grants_gov', grant.id),
                            workflowStatus: 'suggested',
                            evidenceSourceType: EVIDENCE_SOURCE_TYPE,
                            userCreated: false,
                            relevanceScore: scored.relevanceScore,
                            matchSignals:
                              scored.matchedSignals as unknown as Prisma.InputJsonValue,
                            eligibilityState: eligibility.state,
                            eligibilityReason: eligibility.reason,
                            sourceStatusSnapshot: grant.status,
                            responseDeadlineSnapshot: grant.closeDate,
                            sourceUpdatedAtSnapshot: sourceUpdatedAt,
                          },
                        }),
                      );
                    }
                    continue;
                  }
                  if (decision.action === 'refresh') {
                    refreshed += 1;
                    counts.updated += 1;
                    if (options.commit) {
                      await withBypass(prisma, (tx) =>
                        tx.clientFundingOpportunity.update({
                          where: { id: decision.id },
                          data: {
                            relevanceScore: scored.relevanceScore,
                            matchSignals:
                              scored.matchedSignals as unknown as Prisma.InputJsonValue,
                            eligibilityState: eligibility.state,
                            eligibilityReason: eligibility.reason,
                            sourceStatusSnapshot: grant.status,
                            responseDeadlineSnapshot: grant.closeDate,
                            sourceUpdatedAtSnapshot: sourceUpdatedAt,
                            staleAt: null,
                          },
                        }),
                      );
                    }
                    continue;
                  }
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
                } catch (error) {
                  counts.errors += 1;
                  console.warn(
                    `[${SOURCE}] failed ${client.clientId} x ${grant.id}: ${
                      (error as Error).message
                    }`,
                  );
                }
              }
            }
          },
        });

        if (grantWalk.completion === 'INCOMPLETE') opportunityWalkIncomplete = true;
        // Every grant walk covers the same corpus, so the largest is the corpus
        // size rather than a sum across client pages.
        opportunityCorpus = Math.max(opportunityCorpus, grantWalk.rowsRead);
      },
    });
  }

  const coverage =
    opportunityWalkIncomplete || clientWalkOutcome?.completion === 'INCOMPLETE'
      ? incompleteCoverage({
          clientsRead,
          opportunitiesRead: opportunityCorpus,
          resumeClientCursor: clientWalkOutcome?.resumeCursor ?? null,
          guard: opportunityWalkIncomplete ? 'opportunity_pages' : 'client_pages',
          resumeFlag: '--resume-client',
        })
      : completeCoverage(clientsRead, opportunityCorpus);

  // An INCOMPLETE run must not read as a clean success. `complete: false` makes
  // statusFromCounts return 'partial', and lastSuccessfulWatermark only reads
  // status='success' — so the unseen tail stays retryable and the incremental
  // watermark does not advance past data nobody looked at.
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
    resumeClientCursor: coverage.resumeClientCursor,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const prisma = new PrismaClient();
  try {
    const tenantIds = await resolveTenantIds(prisma, args.tenantId);
    // Report INSIDE the closure. The detail counters (evaluated/created/
    // refreshed/markedStale/humanDecisionsPreserved/capped) live on this
    // script's own result type, while runWithSyncRun resolves to the bare
    // RunCounts contract — so reading them off its return value does not
    // typecheck. It would also be dishonest: on the skipIfRunning path the
    // helper returns empty counts without ever running this body, and the
    // CAPPED warning in particular must only be printed by a real pass.
    // Mirrors generate-sam-opportunity-candidates.ts.
    const execute = async (): Promise<RunCounts> => {
      const result = await generateFundingGrantCandidates(prisma, {
        tenantIds,
        clientId: args.clientId,
        minRelevance: args.minRelevance,
        commit: args.commit,
        resumeClientCursor: args.resumeClient,
      });
      console.log(
        `[${SOURCE}] ${args.commit ? 'COMMITTED' : 'DRY RUN'} tenants=${tenantIds.length} ` +
          `evaluated=${result.evaluated} created=${result.created} refreshed=${result.refreshed} ` +
          `stale=${result.markedStale} preserved=${result.humanDecisionsPreserved} errors=${result.errors} ` +
          `coverage=${result.completion} clients=${result.clientsRead} grants=${result.opportunitiesRead}`,
      );
      if (result.completion === 'INCOMPLETE') {
        // Deliberately does NOT say "raise the cap" — there is no cap. It names
        // the guard that tripped and the exact flag needed to finish the walk.
        console.warn(`[${SOURCE}] ⚠️ INCOMPLETE: ${result.incompleteReason ?? 'coverage is partial'}`);
      }
      return result;
    };
    if (args.commit) {
      await runWithSyncRun(prisma as never, SOURCE, execute);
    } else {
      await execute();
    }
  } finally {
    await prisma.$disconnect();
  }
}

const direct = /generate-funding-grant-candidates(\.[cm]?[tj]s)?$/.test(
  (process.argv[1] ?? '').replace(/\\/g, '/'),
);
if (direct) {
  void main().catch((error) => {
    console.error(`[${SOURCE}] FAILED`, error);
    process.exit(1);
  });
}

export { main };
