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
import {
  computeEligibility,
  scoreOpportunityRelevance,
  MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR,
} from '../src/district-nexus/grant-opportunity-relevance.js';
import { buildClientOpportunityProfile } from '../src/funding-opportunities/client-opportunity-profile.builder.js';
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
export const OPPORTUNITY_SCAN_CAP = 4000;
export const CLIENT_CAP = 500;

interface Args {
  commit: boolean;
  tenantId: string | null;
  clientId: string | null;
  minRelevance: number;
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

export interface GenerateResult extends RunCounts {
  evaluated: number;
  created: number;
  refreshed: number;
  markedStale: number;
  humanDecisionsPreserved: number;
  capped: boolean;
}

export async function generateFundingGrantCandidates(
  prisma: PrismaClient,
  options: { tenantIds: string[]; clientId: string | null; minRelevance: number; commit: boolean },
): Promise<GenerateResult> {
  const counts = emptyCounts();
  let evaluated = 0;
  let created = 0;
  let refreshed = 0;
  let markedStale = 0;
  let humanDecisionsPreserved = 0;
  let capped = false;
  const now = new Date();

  const grants = await prisma.federalGrant.findMany({
    where: {
      status: { in: ['posted', 'forecasted'] },
      OR: [{ closeDate: null }, { closeDate: { gte: now } }],
    },
    select: {
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
    },
    orderBy: [{ closeDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    take: OPPORTUNITY_SCAN_CAP,
  });
  if (grants.length >= OPPORTUNITY_SCAN_CAP) capped = true;

  for (const tenantId of options.tenantIds) {
    const scoped = await withBypass(prisma, async (tx) => {
      // One shared repository read, so this producer, the SAM producer and the
      // HTTP read path all select the same client columns and apply the same
      // reviewed-mapping filter. Before P01 this selected 6 fields and its own
      // mapping query narrowed to `assistance_recipient`, which is a large part
      // of why the three profiles could differ.
      const clients = await readClientProfileFactsMany(asProfileReadClient(tx), {
        tenantId,
        clientId: options.clientId,
        take: CLIENT_CAP,
      });
      const clientIds = clients.map((client) => client.clientId);
      const existing = clientIds.length
        ? await tx.clientFundingOpportunity.findMany({
            where: { tenantId, clientId: { in: clientIds }, source: 'grants_gov' },
            select: {
              id: true,
              clientId: true,
              grantOpportunityId: true,
              workflowStatus: true,
              userCreated: true,
              evidenceSourceType: true,
              staleAt: true,
            },
          })
        : [];
      return { clients, existing };
    });
    if (scoped.clients.length >= CLIENT_CAP) capped = true;

    const existingByKey = new Map(
      scoped.existing
        .filter((row) => row.grantOpportunityId != null)
        .map((row) => [`${row.clientId}:${row.grantOpportunityId}`, row]),
    );

    // Resolve federal_contractor.uei for the WHOLE page in one query, not per
    // client. This is the join P02 adds: a contracting mapping's externalId is a
    // federal_contractor UUID, so without it the contract rail has no verified
    // identifier and falls back to matching on names.
    const contractorUeis = await resolveContractorUeis(
      prisma,
      contractorIdsToResolve(scoped.clients),
    );

    for (const client of scoped.clients) {
      // One award-history read per client, never one per grant. This does BOTH
      // rails now — the grant profile only reads the assistance half, but the
      // profile is built whole so a parity test can compare it against the SAM
      // producer and the read path byte for byte. That is one extra bounded query
      // per client, which is the price of the three sites being checkable.
      //
      // Not wrapped in a try/catch, deliberately: a nightly job that scored every
      // client against silently-empty award history would mark real suggestions
      // stale. The read path degrades; this must crash.
      const history = await readAwardHistoryByBasis(
        prisma,
        buildAwardHistoryIdentity(client, contractorUeis),
      );
      const profile = buildClientOpportunityProfile(client, history).grant;

      for (const grant of grants) {
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
            scored.matchedSignals.filter((signal) => signal.strength === 'moderate').length >= 2;
          const existing = existingByKey.get(`${client.clientId}:${grant.id}`) ?? null;
          const decision = decideProducerAction({
            existing,
            relevanceScore: scored.relevanceScore,
            meetsSuggestionFloor,
            minRelevance: options.minRelevance,
          });
          const sourceUpdatedAt = grant.lastUpdatedAt ?? grant.detailSyncedAt ?? grant.syncedAt;

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
                    grantOpportunityId: grant.id,
                    samOpportunityId: null,
                    workflowStatus: 'suggested',
                    evidenceSourceType: EVIDENCE_SOURCE_TYPE,
                    userCreated: false,
                    relevanceScore: scored.relevanceScore,
                    matchSignals: scored.matchedSignals as unknown as Prisma.InputJsonValue,
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
                    matchSignals: scored.matchedSignals as unknown as Prisma.InputJsonValue,
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
          console.warn(`[${SOURCE}] failed ${client.clientId} × ${grant.id}: ${(error as Error).message}`);
        }
      }
    }
  }

  if (capped) counts.errors += 1;
  return { ...counts, evaluated, created, refreshed, markedStale, humanDecisionsPreserved, capped };
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
      });
      console.log(
        `[${SOURCE}] ${args.commit ? 'COMMITTED' : 'DRY RUN'} tenants=${tenantIds.length} ` +
          `evaluated=${result.evaluated} created=${result.created} refreshed=${result.refreshed} ` +
          `stale=${result.markedStale} preserved=${result.humanDecisionsPreserved} errors=${result.errors}`,
      );
      if (result.capped) {
        console.warn(`[${SOURCE}] ⚠️ CAPPED: coverage is partial; narrow by --tenant/--client or raise the audited caps.`);
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
