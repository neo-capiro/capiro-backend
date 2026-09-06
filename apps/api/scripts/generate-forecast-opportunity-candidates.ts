/**
 * Tango agency forecasts → client recommendations. Dry-run unless --commit.
 * Reuses the read-side signal derivation and categorical scorer. Only a specific
 * program/code/capability fit or explicit concrete priority creates a suggestion;
 * priority-only fit is monitor, and location/history alone does not surface.
 * Estimates never populate responseDeadlineSnapshot or follow-up dates.
 *
 * --tenant and --client narrow scope; neither bypasses capability flags. Global
 * source reads stay outside tenant transactions. Every RLS bypass has an
 * explicit tenant/client predicate. Human decisions survive rescoring, including
 * a decision made after the initial read but before the conditional write.
 */
import { config as dotenvConfig } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { emptyCounts, runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  FUNDING_OPPORTUNITIES_FORECASTS_FEATURE,
} from '../src/funding-opportunities/funding-opportunities-flag.guard.js';
import {
  deriveForecastSignals,
  containsWholeToken,
} from '../src/funding-opportunities/forecast-signals.js';
import { normAgency } from '../src/funding-opportunities/sam-opportunity-relevance.js';
import { scoreForecastRelevance } from '../src/funding-opportunities/forecast-relevance.js';
import type {
  ClientOpportunityProfileV1,
  ClientProfileFacts,
} from '../src/funding-opportunities/client-opportunity-profile.types.js';
import { buildClientOpportunityProfile } from '../src/funding-opportunities/client-opportunity-profile.builder.js';
import { profileIsTooThin } from '../src/funding-opportunities/missing-profile-fields.js';
import {
  asProfileReadClient,
  readClientProfileFactsMany,
  readAwardHistoryByBasis,
  resolveContractorUeis,
} from '../src/funding-opportunities/client-opportunity-profile.repository.js';
import {
  buildAwardHistoryIdentity,
  contractorIdsToResolve,
} from '../src/funding-opportunities/award-history-identity.js';
import { sourceRecordIdentityColumns } from '../src/funding-opportunities/funding-opportunity-identity.js';
import { decideProducerAction } from '../src/funding-opportunities/producer-decision.js';
import {
  walkKeyset,
  DEFAULT_PAGE_SIZE,
  DEFAULT_MAX_PAGES,
} from '../src/funding-opportunities/producer-pagination.js';

const SOURCE = 'generate-forecast-opportunity-candidates';
const EVIDENCE = 'deterministic_relevance_v1';
const CONFIDENCE_SCORE = { high: 90, medium: 60, low: 30 } as const;
export const PAGE_SIZE = DEFAULT_PAGE_SIZE;
export const DEFAULT_MIN_RELEVANCE = 15;

dotenvConfig();

export interface GenerateOptions {
  tenantId: string | null;
  clientId: string | null;
  commit: boolean;
  minRelevance: number;
}

export function parseArgs(argv: string[]): GenerateOptions {
  const value = (name: string) => {
    const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && !argv[index + 1]?.startsWith('--') ? argv[index + 1] : undefined;
  };
  const minimum = Number(value('min-relevance') ?? DEFAULT_MIN_RELEVANCE);
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
    throw new Error('--min-relevance must be a number from 0 to 100.');
  }
  return {
    tenantId: value('tenant') ?? null,
    clientId: value('client') ?? null,
    commit: argv.includes('--commit'),
    minRelevance: minimum,
  };
}

function withBypass<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

export async function resolveTenantIds(
  prisma: PrismaClient,
  tenantId: string | null,
): Promise<string[]> {
  const rows = await withBypass(
    prisma,
    (tx) => tx.$queryRaw<Array<{ tenant_id: string }>>`
    SELECT DISTINCT master.tenant_id
    FROM intel_feature_flag master
    JOIN intel_feature_flag forecast ON forecast.tenant_id = master.tenant_id
    WHERE master.feature = ${FUNDING_OPPORTUNITIES_FEATURE} AND master.enabled = true
      AND forecast.feature = ${FUNDING_OPPORTUNITIES_FORECASTS_FEATURE} AND forecast.enabled = true
      ${tenantId ? Prisma.sql`AND master.tenant_id = ${tenantId}::uuid` : Prisma.empty}
  `,
  );
  return [...new Set(rows.map((row) => row.tenant_id))];
}

const FORECAST_SELECT = {
  id: true,
  tangoForecastId: true,
  title: true,
  description: true,
  agency: true,
  departmentName: true,
  organizationAgencyName: true,
  naicsCode: true,
  pscCode: true,
  placeOfPerformance: true,
  anticipatedAwardDate: true,
  estimatedPeriod: true,
  fiscalYear: true,
  isActive: true,
  status: true,
  providerModifiedAt: true,
} satisfies Prisma.TangoProcurementForecastSelect;

export interface GenerateResult extends RunCounts {
  evaluated: number;
  created: number;
  refreshed: number;
  markedStale: number;
  humanDecisionsPreserved: number;
  clientsRead: number;
  opportunitiesRead: number;
  tenantsRead: number;
  completion: 'COMPLETE' | 'INCOMPLETE';
}

export async function generateForecastCandidates(
  prisma: PrismaClient,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const counts = emptyCounts();
  let evaluated = 0,
    created = 0,
    refreshed = 0,
    markedStale = 0,
    humanDecisionsPreserved = 0;
  let clientsRead = 0,
    opportunitiesRead = 0;
  let incomplete = false;
  const now = new Date();
  const tenants = await resolveTenantIds(prisma, options.tenantId);

  for (const tenantId of tenants) {
    const clientWalk = await walkKeyset<ClientProfileFacts>({
      pageSize: PAGE_SIZE,
      maxPages: DEFAULT_MAX_PAGES,
      key: (client) => client.clientId,
      shouldStop: () => incomplete,
      read: (cursor, take) =>
        withBypass(prisma, (tx) =>
          readClientProfileFactsMany(asProfileReadClient(tx), {
            tenantId,
            clientId: options.clientId,
            cursor,
            take,
          }),
        ),
      onPage: async (clients) => {
        clientsRead += clients.length;
        const clientIds = clients.map((client) => client.clientId);
        const ueis = await resolveContractorUeis(prisma, contractorIdsToResolve(clients));
        const profiles = new Map<string, ClientOpportunityProfileV1>();
        for (const client of clients) {
          const history = await readAwardHistoryByBasis(
            prisma,
            buildAwardHistoryIdentity(client, ueis),
          );
          profiles.set(client.clientId, buildClientOpportunityProfile(client, history));
        }
        // Include inactive forecasts so a formerly eligible machine suggestion
        // becomes stale. Never expire human work or infer closure from timing.
        const forecastWalk = await walkKeyset<
          Prisma.TangoProcurementForecastGetPayload<{
            select: typeof FORECAST_SELECT;
          }>
        >({
          pageSize: PAGE_SIZE,
          maxPages: DEFAULT_MAX_PAGES,
          key: (row) => row.id,
          read: (cursor, take) =>
            prisma.tangoProcurementForecast.findMany({
              where: cursor ? { id: { gt: cursor } } : {},
              select: FORECAST_SELECT,
              orderBy: { id: 'asc' },
              take,
            }),
          onPage: async (forecasts) => {
            const existingRows = await withBypass(prisma, (tx) =>
              tx.clientFundingOpportunity.findMany({
                where: {
                  tenantId,
                  clientId: { in: clientIds },
                  source: 'agency_forecast',
                  sourceRecordKey: {
                    in: forecasts.map((row) => row.tangoForecastId),
                  },
                },
                select: {
                  id: true,
                  clientId: true,
                  sourceRecordKey: true,
                  workflowStatus: true,
                  humanDecision: true,
                  userCreated: true,
                  evidenceSourceType: true,
                  staleAt: true,
                },
              }),
            );
            const existing = new Map(
              existingRows.map((row) => [`${row.clientId}:${row.sourceRecordKey}`, row]),
            );
            for (const client of clients) {
              const profile = profiles.get(client.clientId)!;
              for (const forecast of forecasts) {
                evaluated++;
                try {
                  const row =
                    existing.get(`${client.clientId}:${forecast.tangoForecastId}`) ?? null;
                  if (row?.humanDecision) {
                    humanDecisionsPreserved++;
                    counts.skipped++;
                    continue;
                  }
                  const signals = deriveForecastSignals(forecast, profile.sam, {
                    knownVehicleAccess: false,
                    vehicleFitEnabled: false,
                  });
                  const scored = scoreForecastRelevance({
                    ...signals,
                    profileTooThin: profileIsTooThin(profile.completeness),
                    isActive: forecast.isActive,
                    anticipatedAwardDate: forecast.anticipatedAwardDate?.toISOString() ?? null,
                    asOf: now,
                  });
                  const relevanceScore = CONFIDENCE_SCORE[scored.recommendationConfidence];
                  const decision = decideProducerAction({
                    existing: row,
                    relevanceScore,
                    minRelevance: options.minRelevance,
                    meetsSuggestionFloor:
                      scored.forecastRecommendation === 'shape_now' ||
                      (scored.forecastRecommendation === 'monitor' &&
                        signals.fundingPriorityMatch === true),
                  });
                  const machineData = {
                    relevanceScore,
                    matchSignals: [
                      ...(signals.exactNaicsMatch
                        ? [
                            {
                              signal: 'exact_naics_match',
                              matchedOn: forecast.naicsCode,
                            },
                          ]
                        : []),
                      ...(signals.exactPscMatch
                        ? [
                            {
                              signal: 'exact_psc_match',
                              matchedOn: forecast.pscCode,
                            },
                          ]
                        : []),
                      ...(signals.capabilityMatch
                        ? [
                            {
                              signal: 'capability_match',
                              matchedOn: profile.sam.capabilityKeywords
                                .filter((keyword) =>
                                  containsWholeToken(
                                    [forecast.title, forecast.description]
                                      .filter(Boolean)
                                      .join(' '),
                                    keyword,
                                  ),
                                )
                                .slice(0, 3)
                                .join(', '),
                            },
                          ]
                        : []),
                      ...(signals.fundingPriorityMatch
                        ? [
                            {
                              signal: 'funding_priority_match',
                              source: 'funding_priority',
                              matchedOn: (profile.sam.fundingPriorities ?? [])
                                .filter((priority) =>
                                  containsWholeToken(
                                    [forecast.title, forecast.description]
                                      .filter(Boolean)
                                      .join(' '),
                                    priority,
                                  ),
                                )
                                .slice(0, 3)
                                .join(', '),
                            },
                          ]
                        : []),
                      ...(signals.programElementLinkedSourceBacked
                        ? [
                            {
                              signal: 'program_element_linked',
                              matchedOn: profile.sam.programElementCodes
                                .filter(
                                  (code) =>
                                    code.trim().length >= 4 &&
                                    [forecast.title, forecast.description]
                                      .join(' ')
                                      .toUpperCase()
                                      .includes(code.trim().toUpperCase()),
                                )
                                .join(', '),
                            },
                          ]
                        : []),
                      ...(signals.priorAgencyHistory
                        ? [
                            {
                              signal: 'prior_agency_history',
                              matchedOn: [
                                forecast.agency,
                                forecast.departmentName,
                                forecast.organizationAgencyName,
                              ]
                                .filter(
                                  (agency) =>
                                    agency &&
                                    profile.sam.priorAgencies
                                      .map(normAgency)
                                      .includes(normAgency(agency)),
                                )
                                .join(', '),
                            },
                          ]
                        : []),
                      {
                        signal: 'forecast_assessment',
                        reasonCodes: scored.reasonCodes,
                        forecastRecommendation: scored.forecastRecommendation,
                        recommendationConfidence: scored.recommendationConfidence,
                        primaryReason: scored.primaryReason,
                        recommendedNextAction: scored.recommendedNextAction,
                      },
                    ],
                    // No eligibility determination exists for an agency plan.
                    eligibilityState: null,
                    eligibilityReason: null,
                    staleAt: null,
                  };
                  if (decision.action === 'skip_human_decision') {
                    humanDecisionsPreserved++;
                    counts.skipped++;
                  } else if (decision.action === 'create') {
                    if (options.commit)
                      await withBypass(prisma, (tx) =>
                        tx.clientFundingOpportunity.create({
                          data: {
                            tenantId,
                            clientId: client.clientId,
                            source: 'agency_forecast',
                            ...sourceRecordIdentityColumns(
                              'agency_forecast',
                              forecast.tangoForecastId,
                            ),
                            workflowStatus: 'suggested',
                            evidenceSourceType: EVIDENCE,
                            userCreated: false,
                            ...machineData,
                            responseDeadlineSnapshot: null,
                            sourceStatusSnapshot: forecast.status,
                            sourceUpdatedAtSnapshot: forecast.providerModifiedAt,
                          },
                        }),
                      );
                    created++;
                    counts.inserted++;
                  } else if (decision.action === 'refresh' || decision.action === 'mark_stale') {
                    const result = options.commit
                      ? await withBypass(prisma, (tx) =>
                          tx.clientFundingOpportunity.updateMany({
                            where: {
                              id: decision.id,
                              tenantId,
                              clientId: client.clientId,
                              humanDecision: null,
                              userCreated: false,
                              workflowStatus: { in: ['suggested', 'expired'] },
                            },
                            data: decision.action === 'refresh' ? machineData : { staleAt: now },
                          }),
                        )
                      : { count: 1 };
                    if (!result.count) {
                      humanDecisionsPreserved++;
                      counts.skipped++;
                      continue;
                    }
                    if (decision.action === 'refresh') refreshed++;
                    else markedStale++;
                    counts.updated++;
                  } else {
                    counts.skipped++;
                  }
                } catch (error) {
                  // A concurrent producer/user may have inserted the same unique
                  // client/source identity. Never retry by overwriting that row.
                  if ((error as { code?: string }).code === 'P2002') {
                    counts.skipped++;
                    continue;
                  }
                  counts.errors++;
                  console.warn(
                    `[${SOURCE}] failed client=${client.clientId} forecast=${forecast.tangoForecastId}: ${(error as Error).message}`,
                  );
                }
              }
            }
          },
        });
        opportunitiesRead = Math.max(opportunitiesRead, forecastWalk.rowsRead);
        if (forecastWalk.completion === 'INCOMPLETE') incomplete = true;
      },
    });
    if (clientWalk.completion === 'INCOMPLETE') incomplete = true;
    if (incomplete) break;
  }
  if (incomplete) {
    counts.complete = false;
    // Restarting the idempotent walk is safer than returning a cursor past a
    // partially scanned client page. No unseen clients may be skipped.
    counts.incompleteReason =
      'Forecast/client page guard reached. Re-run scoped with --tenant and --client; no complete coverage claimed.';
  }
  return {
    ...counts,
    evaluated,
    created,
    refreshed,
    markedStale,
    humanDecisionsPreserved,
    clientsRead,
    opportunitiesRead,
    tenantsRead: tenants.length,
    completion: incomplete ? 'INCOMPLETE' : 'COMPLETE',
  };
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const execute = async () => {
      const result = await generateForecastCandidates(prisma, options);
      console.log(
        `[${SOURCE}] ${options.commit ? 'COMMITTED' : 'DRY RUN'} ${JSON.stringify(result)}`,
      );
      if (result.errors || result.completion === 'INCOMPLETE') process.exitCode = 1;
      return result;
    };
    if (options.commit) await runWithSyncRun(prisma as never, SOURCE, execute);
    else await execute();
  } finally {
    await prisma.$disconnect();
  }
}

if (
  /generate-forecast-opportunity-candidates(\.[cm]?[tj]s)?$/.test(
    (process.argv[1] ?? '').replace(/\\/g, '/'),
  )
) {
  void main().catch((error) => {
    console.error(`[${SOURCE}] FAILED`, error);
    process.exitCode = 1;
  });
}
