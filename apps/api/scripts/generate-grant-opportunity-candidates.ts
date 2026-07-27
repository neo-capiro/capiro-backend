/**
 * District Nexus — deterministic producer for ClientGrantNexus
 * 'opportunity_candidate' rows (audit F3, remediation plan phase d8).
 *
 * Without this, `district-nexus.service.ts`'s aggregateOpportunitySummary has
 * nothing to read: the opportunity-pipeline UI is honest but permanently empty.
 * This scores every ACTIVE FederalGrant against every non-archived client's
 * relevance profile — built by the SAME `shapeClientRelevanceProfile` function
 * the live read path uses (grant-opportunity-candidates.ts), so a client read
 * live and a client scored by this job can never quietly disagree — and links
 * a candidate row when the score clears `--min-relevance` (default 40).
 *
 *   tsx scripts/generate-grant-opportunity-candidates.ts                    # dry run
 *   tsx scripts/generate-grant-opportunity-candidates.ts --commit           # writes
 *   tsx scripts/generate-grant-opportunity-candidates.ts --commit --tenant <id>
 *   tsx scripts/generate-grant-opportunity-candidates.ts --commit --min-relevance=55
 *
 * DRY-RUN BY DEFAULT. Pass --commit to write anything.
 *
 * ── RLS ─────────────────────────────────────────────────────────────────────
 * `clients` and `client_grant_nexus` are FORCE-RLS (migrations
 * 20260502000000_user_admin_brand_clients, 20260730010000_district_nexus_grants_v2).
 * This script has no NestJS `PrismaService` tenant-scope extension, so every
 * read/write against them runs inside `withBypass` (sets `app.bypass_rls`) AND
 * carries an explicit `tenantId` filter/data field — the bypass only satisfies
 * the RLS predicate, the explicit tenantId is what actually SCOPES the query.
 * Same idiom as diag-client-resolution.ts / diag-tenant-config.ts. Omitting
 * either half is a real cross-tenant bug, not a style choice — see
 * docs/plans/2026-07-19-capiro-app-rls-bypass-remediation.md §5.
 * `federal_grant` and `federal_assistance_award` are global (no tenantId
 * column) and are read directly, matching sync-grants.ts / enrich-grant-
 * details.ts precedent.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 * No unique index exists yet on (tenantId, clientId, grantOpportunityId,
 * relationshipType) — verified against schema.prisma:5383-5385, three plain
 * @@index, no @@unique. So this is find-then-create-or-update, not upsert. A
 * concurrent double-run COULD duplicate rows until that index lands (plan §6
 * follow-up) — do not disable runWithSyncRun's default skipIfRunning guard.
 *
 * Never deletes: a previously-generated candidate that drops below the floor
 * is marked `verificationStatus: 'rejected'` (every read path already filters
 * that out) rather than removed, and only rows THIS script created
 * (`evidenceSourceType: 'deterministic_relevance_v1'`) are ever touched — a
 * human-entered relationship for the same (client, opportunity) pair is never
 * read, updated, or rejected by this job.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun, emptyCounts, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import { DISTRICT_NEXUS_FEATURE } from '../src/district-nexus/district-nexus-flag.guard.js';
import {
  shapeClientRelevanceProfile,
  type ClientRelevanceProfileRows,
} from '../src/district-nexus/grant-opportunity-candidates.js';
import { scoreOpportunityRelevance } from '../src/district-nexus/grant-opportunity-relevance.js';

dotenvConfig();

const SOURCE = 'generate-grant-opportunity-candidates';
const EVIDENCE_SOURCE_TYPE = 'deterministic_relevance_v1';
const RELATIONSHIP_TYPE = 'opportunity_candidate';
export const DEFAULT_MIN_RELEVANCE = 40;

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
  minRelevance: number;
}

/** Unknown flags are ignored, matching the repo's dominant CLI-parsing convention. */
export function parseArgs(argv: string[]): ParsedArgs {
  const minArg = flagValue(argv, 'min-relevance');
  return {
    commit: hasFlag(argv, 'commit'),
    tenantId: flagValue(argv, 'tenant') ?? null,
    minRelevance: minArg != null && minArg.length > 0 ? Number(minArg) : DEFAULT_MIN_RELEVANCE,
  };
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v && v.length > 0)),
  );
}

/** UEIs are 12 alphanumerics; anything else is a name masquerading as an id. */
function isUeiShaped(value: string): boolean {
  return /^[A-Z0-9]{12}$/.test(value.toUpperCase());
}

function groupByClientId<T extends { clientId: string }>(rows: T[]): Map<string, T[]> {
  const byClient = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = byClient.get(row.clientId);
    if (bucket) bucket.push(row);
    else byClient.set(row.clientId, [row]);
  }
  return byClient;
}

/** Minimal Prisma slice this job touches — keeps it unit-testable with a duck-typed mock. */
export interface CandidatesPrisma {
  $transaction<T>(fn: (tx: CandidatesPrisma) => Promise<T>): Promise<T>;
  $executeRawUnsafe(sql: string): Promise<unknown>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  client: {
    findMany(args: unknown): Promise<
      Array<{
        id: string;
        sectorTag: string | null;
        capabilities: Array<{ name: string; sector: string | null; tags: unknown }>;
        facilities: Array<{ state: string | null }>;
      }>
    >;
  };
  clientIntelMapping: {
    findMany(
      args: unknown,
    ): Promise<Array<{ clientId: string; source: string; externalId: string | null; externalName: string | null }>>;
  };
  federalGrant: {
    findMany(args: unknown): Promise<
      Array<{
        id: string;
        title: string;
        agency: string;
        status: string | null;
        closeDate: Date | null;
        eligibility: string[];
        cfdaNumbers: string[];
        category: string | null;
        description: string | null;
      }>
    >;
  };
  clientGrantNexus: {
    findFirst(args: unknown): Promise<{ id: string; verificationStatus: string } | null>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
}

/**
 * RLS bypass for FORCE-RLS tables (`clients`, `client_grant_nexus`). The
 * bypass alone does not scope anything — every query run through `tx` still
 * needs its own explicit `tenantId` where/data. Same idiom as
 * diag-client-resolution.ts's `withBypass`.
 */
async function withBypass<T>(
  prisma: CandidatesPrisma,
  fn: (tx: CandidatesPrisma) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

/**
 * Tenants to evaluate. `--tenant` bypasses this lookup entirely and uses
 * exactly the given id, regardless of flag state — an operator naming a
 * tenant explicitly is presumed to know what they're doing (testing,
 * backfill). Otherwise: every tenant with an ENABLED `district_nexus_v2` row,
 * union'd with the always-on internal tenant (mirrors DistrictNexusFlagGuard's
 * own internal-tenant hardcode, so this producer's coverage matches exactly
 * what the read path will actually serve).
 */
export async function resolveTenantIds(
  prisma: CandidatesPrisma,
  explicitTenantId: string | null,
  internalTenantId: string | undefined,
): Promise<string[]> {
  if (explicitTenantId) return [explicitTenantId];
  const rows = await withBypass(prisma, (tx) =>
    tx.$queryRaw<{ tenant_id: string }>`
      SELECT DISTINCT tenant_id FROM intel_feature_flag
      WHERE feature = ${DISTRICT_NEXUS_FEATURE} AND enabled = true
    `,
  );
  const ids = new Set(rows.map((r) => r.tenant_id));
  if (internalTenantId) ids.add(internalTenantId);
  return [...ids];
}

async function buildRelevanceProfileForClient(
  prisma: CandidatesPrisma,
  client: {
    id: string;
    sectorTag: string | null;
    capabilities: Array<{ name: string; tags: unknown }>;
    facilities: Array<{ state: string | null }>;
  },
  mappingsByClient: Map<string, Array<{ source: string; externalId: string | null; externalName: string | null }>>,
) {
  const mappings = mappingsByClient.get(client.id) ?? [];
  const assistance = mappings.filter((m) => m.source === 'assistance_recipient');
  const recipientUeis = dedupe(assistance.map((m) => m.externalId)).filter(isUeiShaped);
  const recipientNames = dedupe(assistance.map((m) => m.externalName));

  let priorAssistanceListings: Array<string | null> = [];
  let priorAgencies: Array<string | null> = [];
  if (recipientUeis.length || recipientNames.length) {
    const lowerNames = recipientNames.map((n) => n.toLowerCase());
    const rows = await prisma.$queryRaw<{
      assistance_listing_number: string | null;
      awarding_agency: string | null;
    }>`
      SELECT DISTINCT assistance_listing_number, awarding_agency
      FROM federal_assistance_award
      WHERE recipient_uei = ANY(${recipientUeis}::text[])
         OR lower(recipient_name) = ANY(${lowerNames}::text[])
    `;
    priorAssistanceListings = rows.map((r) => r.assistance_listing_number);
    priorAgencies = rows.map((r) => r.awarding_agency);
  }

  const rowsIn: ClientRelevanceProfileRows = {
    sectorTag: client.sectorTag,
    capabilities: client.capabilities,
    facilityStates: client.facilities.map((f) => f.state),
    priorAssistanceListings,
    priorAgencies,
  };
  return shapeClientRelevanceProfile(rowsIn);
}

export interface GenerateOptions {
  tenantIds: string[];
  minRelevance: number;
  commit: boolean;
}

/**
 * Core evaluation loop. Reads always run (so a dry run reports REAL counts of
 * what would happen); only the final create/update/reject is gated on
 * `commit`. Per-(client, grant) failures are caught and counted as errors —
 * one bad row must not abort evaluation of the rest (sync-grants.ts precedent).
 */
export async function generateCandidates(
  prisma: CandidatesPrisma,
  options: GenerateOptions,
): Promise<RunCounts & { evaluated: number }> {
  const counts = emptyCounts();
  let evaluated = 0;

  const grants = await prisma.federalGrant.findMany({
    where: {
      status: { in: ['posted', 'forecasted'] },
      OR: [{ closeDate: null }, { closeDate: { gte: new Date() } }],
    },
    select: {
      id: true,
      title: true,
      agency: true,
      status: true,
      closeDate: true,
      eligibility: true,
      cfdaNumbers: true,
      category: true,
      description: true,
    },
  });

  for (const tenantId of options.tenantIds) {
    const { clients, mappings } = await withBypass(prisma, async (tx) => {
      const clients = await tx.client.findMany({
        where: { tenantId, status: { not: 'archived' }, profileStatus: 'ACTIVE' },
        select: {
          id: true,
          sectorTag: true,
          capabilities: { select: { name: true, sector: true, tags: true } },
          facilities: { select: { state: true } },
        },
      });
      const clientIds = clients.map((c) => c.id);
      const mappings = clientIds.length
        ? await tx.clientIntelMapping.findMany({
            where: {
              tenantId,
              clientId: { in: clientIds },
              confirmed: true,
              source: { in: ['contracting', 'assistance_recipient'] },
            },
            select: { clientId: true, source: true, externalId: true, externalName: true },
          })
        : [];
      return { clients, mappings };
    });

    const mappingsByClient = groupByClientId(mappings);

    for (const client of clients) {
      let relevance;
      try {
        relevance = await buildRelevanceProfileForClient(prisma, client, mappingsByClient);
      } catch (err) {
        console.error(`[${SOURCE}] relevance-profile build failed for client ${client.id}`, err);
        counts.errors += grants.length;
        evaluated += grants.length;
        continue;
      }

      await withBypass(prisma, async (tx) => {
        for (const grant of grants) {
          evaluated++;
          try {
            const scored = scoreOpportunityRelevance(relevance, {
              assistanceListingNumber: grant.cfdaNumbers[0] ?? null,
              agency: grant.agency,
              fundingCategory: grant.category,
              title: grant.title,
              description: grant.description,
              eligibleApplicantTypes: grant.eligibility,
              // Grants.gov's search/detail payloads carry no geographic
              // restriction field, so this is honestly empty rather than a
              // guess — computeEligibility treats empty as unrestricted.
              geographicRestrictions: [],
            });
            const clears = scored.relevanceScore >= options.minRelevance;

            // Scoped to THIS script's own rows only — a human-entered
            // relationship for the same pair is never read or touched here.
            const existing = await tx.clientGrantNexus.findFirst({
              where: {
                tenantId,
                clientId: client.id,
                grantOpportunityId: grant.id,
                relationshipType: RELATIONSHIP_TYPE,
                evidenceSourceType: EVIDENCE_SOURCE_TYPE,
              },
              select: { id: true, verificationStatus: true },
            });

            if (!clears) {
              if (existing && existing.verificationStatus !== 'rejected') {
                if (options.commit) {
                  await tx.clientGrantNexus.update({
                    where: { id: existing.id },
                    data: { verificationStatus: 'rejected' },
                  });
                }
                counts.updated++;
              } else {
                counts.skipped++;
              }
              // `continue`, NOT `return`. This loop body sits inside the
              // `async (tx) => {…}` callback handed to withBypass, so a
              // `return` exits the WHOLE per-client transaction and silently
              // abandons every remaining grant. Since ~97% of
              // (client, opportunity) pairs score 0, the first grant almost
              // always fails the floor — so the producer evaluated exactly ONE
              // grant per client and stopped. Verified live 2026-07-27: eight
              // independent dry runs all reported `evaluated=12` for
              // 12 clients × 567 grants, at every floor from 10 to 40.
              // The outer client loop (above) already uses `continue`; only
              // this inner one crossed the callback boundary.
              continue;
            }

            if (existing) {
              if (options.commit) {
                await tx.clientGrantNexus.update({
                  where: { id: existing.id },
                  data: {
                    confidence: scored.relevanceScore / 100,
                    // Un-reject a candidate that clears the floor again.
                    verificationStatus:
                      existing.verificationStatus === 'rejected' ? 'unverified' : existing.verificationStatus,
                  },
                });
              }
              counts.updated++;
            } else {
              if (options.commit) {
                await tx.clientGrantNexus.create({
                  data: {
                    tenantId,
                    clientId: client.id,
                    grantOpportunityId: grant.id,
                    relationshipType: RELATIONSHIP_TYPE,
                    evidenceSourceType: EVIDENCE_SOURCE_TYPE,
                    evidenceSourceRef: SOURCE,
                    confidence: scored.relevanceScore / 100,
                    verificationStatus: 'unverified',
                    externalUseApproved: false,
                  },
                });
              }
              counts.inserted++;
            }
          } catch (err) {
            console.error(
              `[${SOURCE}] failed for client ${client.id} / grant ${grant.id}`,
              err,
            );
            counts.errors++;
          }
        }
      });
    }
  }

  return { ...counts, evaluated };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  // The `continue` fix above is what makes withBypass's per-client transaction
  // long: it goes from ~1 query (bail at grant #1) to one per active grant.
  // Measured 2026-07-27 against capiro-internal — 567 sequential findFirst
  // inside a single transaction takes 780–960 ms per client, comfortably under
  // Prisma 5.22's 5 000 ms default. These explicit values keep ~30× headroom
  // for an Aurora latency spike without masking a real regression, and raise
  // `maxWait` because pool-acquisition timeout is the failure signature this
  // repo has actually been bitten by (2026-07-21 graph-sync P2028).
  const prisma = new PrismaClient({ transactionOptions: { timeout: 30_000, maxWait: 10_000 } });

  try {
    const tenantIds = await resolveTenantIds(
      prisma as unknown as CandidatesPrisma,
      parsed.tenantId,
      process.env.CAPIRO_INTERNAL_TENANT_ID?.trim() || undefined,
    );

    if (!tenantIds.length) {
      console.log(`[${SOURCE}] no tenant has district_nexus_v2 enabled — nothing to do.`);
      return;
    }

    console.log(
      `[${SOURCE}] evaluating ${tenantIds.length} tenant(s) at --min-relevance=${parsed.minRelevance}${
        parsed.commit ? '' : ' (DRY RUN)'
      }`,
    );

    if (!parsed.commit) {
      const result = await generateCandidates(prisma as unknown as CandidatesPrisma, {
        tenantIds,
        minRelevance: parsed.minRelevance,
        commit: false,
      });
      console.log(
        `[${SOURCE}] DRY RUN — no database writes. Would insert ${result.inserted}, update ${result.updated} (including rejections), skip ${result.skipped}, of ${result.evaluated} (client, opportunity) pairs evaluated. Pass --commit to write.`,
      );
      return;
    }

    const counts = await runWithSyncRun(
      prisma as never,
      SOURCE,
      async (): Promise<RunCounts> => {
        const result = await generateCandidates(prisma as unknown as CandidatesPrisma, {
          tenantIds,
          minRelevance: parsed.minRelevance,
          commit: true,
        });
        console.log(
          `[${SOURCE}] evaluated ${result.evaluated} (client, opportunity) pairs — inserted ${result.inserted}, updated ${result.updated}, skipped ${result.skipped}, errors ${result.errors}.`,
        );
        return { inserted: result.inserted, updated: result.updated, skipped: result.skipped, errors: result.errors };
      },
    );
    console.log(`[${SOURCE}] DONE`, JSON.stringify(counts));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[${SOURCE}] FAILED`, (error as Error).message);
    process.exit(1);
  });
}
