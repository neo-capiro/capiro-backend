/**
 * Funding Opportunities — deterministic producer for client ↔ SAM.gov contract
 * opportunity suggestions (`client_funding_opportunity`, source 'sam_gov').
 *
 *   tsx scripts/generate-sam-opportunity-candidates.ts                        # dry run
 *   tsx scripts/generate-sam-opportunity-candidates.ts --commit
 *   tsx scripts/generate-sam-opportunity-candidates.ts --commit --tenant <id>
 *   tsx scripts/generate-sam-opportunity-candidates.ts --commit --client <id>
 *   tsx scripts/generate-sam-opportunity-candidates.ts --commit --min-relevance=25
 *
 * DRY-RUN BY DEFAULT. Nothing is written without `--commit`.
 *
 * ── What this producer is FOR, now that the read path does not need it ───────
 *
 * The Funding Opportunities read path scores at request time, so a client's page
 * works whether or not this job has ever run — that was the point of the
 * read-time path. This producer therefore exists for the two things a request
 * cannot do:
 *
 *   1. PERSISTENCE, so a suggestion has an id that alerts, notes, owners and
 *      deadline-change detection can hang off;
 *   2. CHANGE DETECTION, because a diff needs a previous value, and a stateless
 *      read has none.
 *
 * It is not, and must never become, a prerequisite for visibility.
 *
 * ── What it must never do ───────────────────────────────────────────────────
 *
 * It NEVER overwrites a human decision. A row whose status is saved, pursuing,
 * dismissed, won or lost — or any row with `userCreated` — is read for counting
 * and then left completely alone: no status change, no owner change, no note
 * deletion, no facility unlink, no stale flag. Re-running a nightly job is not a
 * reason to forget that somebody is actively bidding something.
 *
 * A producer-created 'suggested' row that no longer clears the floor is marked
 * `staleAt`, never deleted: deleting it would lose the fact that we once
 * suggested it, which is exactly what a change-detection substrate needs.
 *
 * ── RLS ─────────────────────────────────────────────────────────────────────
 * `clients`, `client_intel_mapping` and `client_funding_opportunity` are all
 * FORCE-RLS. This script has no NestJS tenant-scope extension, so every
 * read/write against them runs inside `withBypass` (which sets
 * `app.bypass_rls`) AND carries an explicit `tenantId` filter/data field — the
 * bypass only satisfies the RLS predicate, the explicit tenantId is what
 * actually SCOPES the query. Omitting either half is a real cross-tenant bug,
 * not a style choice. Same idiom as generate-grant-opportunity-candidates.ts.
 * `sam_opportunity` is global (no tenantId) and is read directly.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun, emptyCounts, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import { FUNDING_OPPORTUNITIES_FEATURE } from '../src/funding-opportunities/funding-opportunities-flag.guard.js';
import {
  scoreSamOpportunityRelevance,
  computeSamEligibility,
  type SamClientProfile,
  type SamOpportunityProfile,
} from '../src/funding-opportunities/sam-opportunity-relevance.js';
import { samNoticeKind } from '../src/funding-opportunities/opportunity-kind.js';
import { NON_PURSUABLE_KINDS } from '../src/funding-opportunities/funding-opportunities.types.js';
import {
  decideProducerAction,
  HUMAN_DECISION_STATUSES,
  type ProducerAction,
} from '../src/funding-opportunities/producer-decision.js';

dotenvConfig();

const SOURCE = 'generate-sam-opportunity-candidates';
const EVIDENCE_SOURCE_TYPE = 'deterministic_relevance_v1';

/**
 * Default floor. Lower than the grant producer's, and deliberately so: the SAM
 * scorer's denominator excludes weak signals and its strongest single signal
 * (exact NAICS, weight 30 of a ~136 non-weak total) lands around 22, so a
 * grant-style floor in the high twenties would reject the single strongest piece
 * of contract evidence there is.
 *
 * The real gate is not this number anyway — it is `meetsSuggestionFloor`, which
 * requires a strong signal or two independent moderate ones. This is a secondary
 * threshold on top of that.
 */
export const DEFAULT_MIN_RELEVANCE = 15;

/** Bound on notices evaluated per run. Mirrors the read path's own scan cap. */
export const OPPORTUNITY_SCAN_CAP = 4000;
/** Bound on clients evaluated per tenant per run. */
export const CLIENT_CAP = 500;

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
}

export function parseArgs(argv: string[]): ParsedArgs {
  const minArg = flagValue(argv, 'min-relevance');
  return {
    commit: hasFlag(argv, 'commit'),
    tenantId: flagValue(argv, 'tenant') ?? null,
    clientId: flagValue(argv, 'client') ?? null,
    minRelevance: minArg != null && minArg.length > 0 ? Number(minArg) : DEFAULT_MIN_RELEVANCE,
  };
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v && v.length > 0)),
  );
}

function isUeiShaped(value: string): boolean {
  return /^[A-Z0-9]{12}$/.test(value.toUpperCase());
}

function stringTags(tags: unknown): string[] {
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

/** Minimal Prisma slice this job touches — duck-typed so it is unit-testable. */
export interface SamCandidatesPrisma {
  $transaction<T>(fn: (tx: SamCandidatesPrisma) => Promise<T>): Promise<T>;
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
  samOpportunity: {
    findMany(args: unknown): Promise<
      Array<{
        id: string;
        title: string;
        description: string | null;
        noticeType: string;
        agency: string | null;
        subAgency: string | null;
        office: string | null;
        naicsCode: string | null;
        pscCode: string | null;
        setAside: string | null;
        setAsideCode: string | null;
        placeOfPerformance: unknown;
        active: boolean;
        responseDeadline: Date | null;
        updatedAt: Date;
        lastSyncedAt: Date;
        matches: Array<{ peCode: string | null }>;
      }>
    >;
  };
  clientFundingOpportunity: {
    // `args` is `unknown`, so this shape is NOT derived from the `select` — it is
    // asserted by hand and is the only thing the compiler believes. Keep it in
    // step with the select in generateSamCandidates whenever a field is added:
    // `clientId` was originally missing here, which made the existing-row lookup
    // key silently unsound (caught by tsconfig.funding-opportunities.json, which
    // exists because apps/api/tsconfig.json excludes `scripts`).
    findMany(args: unknown): Promise<
      Array<{
        id: string;
        clientId: string;
        samOpportunityId: string | null;
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

/**
 * RLS bypass for the FORCE-RLS tables. The bypass alone scopes NOTHING — every
 * query run through `tx` still needs its own explicit `tenantId`.
 */
async function withBypass<T>(
  prisma: SamCandidatesPrisma,
  fn: (tx: SamCandidatesPrisma) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

/**
 * Tenants to evaluate.
 *
 * `--tenant` uses exactly the given id regardless of flag state: an operator
 * naming a tenant is presumed to know why (testing, backfill).
 *
 * Otherwise: every tenant with an ENABLED `funding_opportunities` row, and
 * NOTHING else. Deliberately no internal-tenant hardcode — unlike the grant
 * producer, which mirrors DistrictNexusFlagGuard's implicit internal-tenant
 * fallback. FundingOpportunitiesFlagGuard has no such fallback, so a hardcode
 * here would make this job write rows for a tenant whose read path 404s.
 */
export async function resolveTenantIds(
  prisma: SamCandidatesPrisma,
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

// Shared producer decision policy lives in funding-opportunities/producer-decision.ts.

export interface GenerateOptions {
  tenantIds: string[];
  clientId: string | null;
  minRelevance: number;
  commit: boolean;
}

export interface GenerateResult extends RunCounts {
  evaluated: number;
  created: number;
  refreshed: number;
  markedStale: number;
  humanDecisionsPreserved: number;
  /** True when the notice scan or the client list hit its cap. */
  capped: boolean;
}

/**
 * Core loop. Reads ALWAYS run, so a dry run reports the REAL counts of what
 * would happen; only the create/update is gated on `commit`.
 *
 * Query shape: one notice scan for the whole run, then per tenant one client
 * read, one mapping read, one award-history read and one workflow read. There is
 * NO query per (client, notice) pair — scoring is a pure function over rows
 * already in memory.
 */
export async function generateSamCandidates(
  prisma: SamCandidatesPrisma,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const counts = emptyCounts();
  let evaluated = 0;
  let created = 0;
  let refreshed = 0;
  let markedStale = 0;
  let humanDecisionsPreserved = 0;
  let capped = false;

  // ── ONE global notice scan for the entire run ────────────────────────────
  const now = new Date();
  const notices = await prisma.samOpportunity.findMany({
    where: {
      active: true,
      OR: [{ responseDeadline: null }, { responseDeadline: { gte: now } }],
    },
    select: {
      id: true,
      title: true,
      description: true,
      noticeType: true,
      agency: true,
      subAgency: true,
      office: true,
      naicsCode: true,
      pscCode: true,
      setAside: true,
      setAsideCode: true,
      placeOfPerformance: true,
      active: true,
      responseDeadline: true,
      updatedAt: true,
      lastSyncedAt: true,
      matches: { where: { reviewStatus: 'accepted' }, select: { peCode: true } },
    },
    orderBy: [{ responseDeadline: 'asc' }, { id: 'asc' }],
    take: OPPORTUNITY_SCAN_CAP,
  });
  if (notices.length >= OPPORTUNITY_SCAN_CAP) capped = true;

  // Award notices and special notices are not pursuits, so they are never
  // suggested — filtered here rather than in the SQL so the notice-type
  // vocabulary lives in exactly one place (opportunity-kind.ts).
  const pursuable = notices.filter((n) => !NON_PURSUABLE_KINDS.has(samNoticeKind(n.noticeType)));

  const noticeProfiles: Array<{
    id: string;
    profile: SamOpportunityProfile;
    status: string;
    deadline: Date | null;
    updatedAt: Date;
  }> = pursuable.map((n) => ({
    id: n.id,
    status: n.active ? 'active' : 'archived',
    deadline: n.responseDeadline,
    updatedAt: n.updatedAt ?? n.lastSyncedAt,
    profile: {
      title: n.title,
      description: n.description,
      agency: n.agency,
      subAgency: n.subAgency,
      office: n.office,
      naicsCode: n.naicsCode,
      pscCode: n.pscCode,
      setAside: n.setAside,
      setAsideCode: n.setAsideCode,
      placeOfPerformance: readPlaceOfPerformance(n.placeOfPerformance),
      acceptedProgramElementCodes: dedupe(n.matches.map((m) => m.peCode)),
    },
  }));

  console.log(
    `[sam-candidates] ${notices.length} active notices scanned, ${pursuable.length} pursuable`,
  );

  for (const tenantId of options.tenantIds) {
    // ── Tenant-scoped reads: bypass + EXPLICIT tenantId, always both ────────
    const { clients, mappings, existingRows } = await withBypass(prisma, async (tx) => {
      const clients = await tx.client.findMany({
        where: {
          tenantId,
          status: { not: 'archived' },
          profileStatus: 'ACTIVE',
          ...(options.clientId ? { id: options.clientId } : {}),
        },
        select: {
          id: true,
          naicsCodes: true,
          pscCodes: true,
          applicantTypes: true,
          setAsideCertifications: true,
          sectorTag: true,
          capabilities: { select: { name: true, tags: true, keywords: true, peNumbers: true } },
          facilities: { select: { city: true, state: true, zip: true } },
        },
        take: CLIENT_CAP,
      });
      const clientIds = clients.map((c) => c.id);
      const mappings = clientIds.length
        ? await tx.clientIntelMapping.findMany({
            where: {
              tenantId,
              clientId: { in: clientIds },
              confirmed: true,
              reviewStatus: 'confirmed',
              rollUpAwards: true,
              source: 'contracting',
            },
            select: {
              clientId: true,
              source: true,
              externalId: true,
              externalName: true,
              rollUpAwards: true,
            },
          })
        : [];
      const existingRows = clientIds.length
        ? await tx.clientFundingOpportunity.findMany({
            where: { tenantId, clientId: { in: clientIds }, source: 'sam_gov' },
            select: {
              id: true,
              clientId: true,
              samOpportunityId: true,
              workflowStatus: true,
              userCreated: true,
              evidenceSourceType: true,
              staleAt: true,
            },
          })
        : [];
      return { clients, mappings, existingRows };
    });

    if (clients.length >= CLIENT_CAP) capped = true;

    const mappingsByClient = new Map<string, typeof mappings>();
    for (const m of mappings) {
      const list = mappingsByClient.get(m.clientId) ?? [];
      list.push(m);
      mappingsByClient.set(m.clientId, list);
    }
    const existingByKey = new Map<string, (typeof existingRows)[number]>();
    for (const r of existingRows) {
      if (r.samOpportunityId) existingByKey.set(`${r.clientId}:${r.samOpportunityId}`, r);
    }

    for (const client of clients) {
      const profile = await buildSamProfileForClient(prisma, client, mappingsByClient.get(client.id) ?? []);

      for (const notice of noticeProfiles) {
        evaluated += 1;
        try {
          const scored = scoreSamOpportunityRelevance(profile, notice.profile);
          const existing = existingByKey.get(`${client.id}:${notice.id}`) ?? null;
          const decision = decideProducerAction({
            existing,
            relevanceScore: scored.relevanceScore,
            meetsSuggestionFloor: scored.meetsSuggestionFloor,
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
              const eligibility = computeSamEligibility(profile, notice.profile);
              created += 1;
              counts.inserted += 1;
              if (options.commit) {
                await withBypass(prisma, (tx) =>
                  tx.clientFundingOpportunity.create({
                    data: {
                      tenantId,
                      clientId: client.id,
                      source: 'sam_gov',
                      samOpportunityId: notice.id,
                      grantOpportunityId: null,
                      workflowStatus: 'suggested',
                      evidenceSourceType: EVIDENCE_SOURCE_TYPE,
                      userCreated: false,
                      relevanceScore: scored.relevanceScore,
                      matchSignals: scored.matchedSignals,
                      eligibilityState: eligibility.state,
                      eligibilityReason: eligibility.reason,
                      sourceStatusSnapshot: notice.status,
                      responseDeadlineSnapshot: notice.deadline,
                      sourceUpdatedAtSnapshot: notice.updatedAt,
                    },
                  }),
                );
              }
              break;
            }
            case 'refresh': {
              const eligibility = computeSamEligibility(profile, notice.profile);
              refreshed += 1;
              counts.updated += 1;
              if (options.commit) {
                await withBypass(prisma, (tx) =>
                  tx.clientFundingOpportunity.update({
                    where: { id: decision.id },
                    data: {
                      relevanceScore: scored.relevanceScore,
                      matchSignals: scored.matchedSignals,
                      eligibilityState: eligibility.state,
                      eligibilityReason: eligibility.reason,
                      sourceStatusSnapshot: notice.status,
                      responseDeadlineSnapshot: notice.deadline,
                      sourceUpdatedAtSnapshot: notice.updatedAt,
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
                    // staleAt only. NOT a status change and NOT a delete: the row
                    // is what change detection diffs against, and "we stopped
                    // suggesting this" is itself the signal.
                    data: { staleAt: new Date() },
                  }),
                );
              }
              break;
          }
        } catch (err) {
          // One bad pair must not abort the rest (sync-grants.ts precedent).
          counts.errors += 1;
          console.warn(
            `[sam-candidates] failed ${client.id} × ${notice.id}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  if (capped) counts.errors += 1;
  return { ...counts, evaluated, created, refreshed, markedStale, humanDecisionsPreserved, capped };
}

/**
 * The client half of SAM scoring. One award-history query per client, never one
 * per notice.
 */
async function buildSamProfileForClient(
  prisma: SamCandidatesPrisma,
  client: {
    id: string;
    naicsCodes: string[];
    pscCodes: string[];
    applicantTypes: string[];
    setAsideCertifications: string[];
    sectorTag: string | null;
    capabilities: Array<{ name: string; tags: unknown; keywords: string[]; peNumbers: string[] }>;
    facilities: Array<{ city: string | null; state: string | null; zip: string | null }>;
  },
  mappings: Array<{ source: string; externalId: string | null; externalName: string | null; rollUpAwards: boolean | null }>,
): Promise<SamClientProfile> {
  // A parent/subsidiary mapping only contributes when a reviewer said its awards
  // roll up. The relationship existing is not the same as the money being the
  // client's.
  const usable = mappings.filter((m) => m.source === 'contracting' && m.rollUpAwards === true);
  const ueis = dedupe(usable.map((m) => m.externalId)).filter(isUeiShaped).map((u) => u.toUpperCase());
  const names = dedupe(usable.map((m) => m.externalName)).map((n) => n.toLowerCase());

  let priorAgencies: string[] = [];
  let priorOffices: string[] = [];
  if (ueis.length || names.length) {
    const rows = await prisma.$queryRaw<{
      awarding_agency: string | null;
      awarding_sub_tier: string | null;
    }>`
      SELECT DISTINCT awarding_agency, awarding_sub_tier
      FROM federal_award
      WHERE recipient_uei = ANY(${ueis}::text[])
         OR lower(contractor_name) = ANY(${names}::text[])
      LIMIT 5000
    `;
    priorAgencies = dedupe(rows.map((r) => r.awarding_agency));
    // KNOWN GAP: federal_award has no contracting-office column at all, so the
    // closest available value is the sub-tier. Measured on capiro-dev, that
    // yields agency-shaped strings ('Department of the Navy', 'Defense
    // Logistics Agency') while sam_opportunity.office holds office codes
    // ('0413 AQ HQ     RCO-HI'). scoreOpportunityRelevance compares these by
    // exact normalized equality, so the priorOffices signal cannot fire until
    // an office-granularity column exists on federal_award. Populated anyway
    // rather than hardcoded empty so the shape stays honest for whoever adds
    // that column; do not read a match here as evidence the signal works.
    priorOffices = dedupe(rows.map((r) => r.awarding_sub_tier));
  }

  return {
    naicsCodes: client.naicsCodes,
    pscCodes: client.pscCodes,
    capabilityKeywords: dedupe([
      ...client.capabilities.map((c) => c.name),
      ...client.capabilities.flatMap((c) => c.keywords ?? []),
      ...client.capabilities.flatMap((c) => stringTags(c.tags)),
    ]),
    programElementCodes: dedupe(client.capabilities.flatMap((c) => c.peNumbers ?? [])),
    priorAgencies,
    priorOffices,
    facilityStates: dedupe(client.facilities.map((f) => f.state)),
    facilitySites: client.facilities.map((f) => ({ city: f.city, state: f.state, zip: f.zip })),
    sector: client.sectorTag,
    applicantTypes: client.applicantTypes,
    setAsideCertifications: client.setAsideCertifications,
  };
}

/** Never assume the vendor JSON shape. */
export function readPlaceOfPerformance(
  value: unknown,
): { city: string | null; state: string | null; zip: string | null } | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const nested = (key: string, inner: string): string | null => {
    const obj = v[key];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const got = (obj as Record<string, unknown>)[inner];
      return typeof got === 'string' && got.trim() ? got.trim() : null;
    }
    return null;
  };
  const flat = (key: string): string | null => {
    const got = v[key];
    return typeof got === 'string' && got.trim() ? got.trim() : null;
  };
  const city = nested('city', 'name') ?? flat('city');
  const state = nested('state', 'code') ?? nested('state', 'name') ?? flat('state');
  const zip = flat('zip');
  if (!city && !state && !zip) return null;
  return { city, state, zip };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log(
    `[sam-candidates] starting (${args.commit ? 'COMMIT' : 'DRY-RUN'}) minRelevance=${args.minRelevance}` +
      (args.tenantId ? ` tenant=${args.tenantId}` : '') +
      (args.clientId ? ` client=${args.clientId}` : ''),
  );
  try {
    const duck = prisma as unknown as SamCandidatesPrisma;
    const tenantIds = await resolveTenantIds(duck, args.tenantId);
    if (tenantIds.length === 0) {
      // Honest, and loud: no enabled tenant is the EXPECTED state while the
      // feature is dark, and it must not look like a successful pass over
      // everybody.
      console.warn(
        `[sam-candidates] no tenant has an enabled '${FUNDING_OPPORTUNITIES_FEATURE}' flag — nothing to do. ` +
          `Pass --tenant <id> to evaluate a specific tenant regardless of flag state.`,
      );
    }
    console.log(`[sam-candidates] ${tenantIds.length} tenant(s) in scope`);

    const execute = async () => {
      const result = await generateSamCandidates(duck, {
        tenantIds,
        clientId: args.clientId,
        minRelevance: args.minRelevance,
        commit: args.commit,
      });
      if (result.capped) {
        console.warn(
          `[sam-candidates] ⚠️ CAPPED: the notice scan or client list hit its bound ` +
            `(notices=${OPPORTUNITY_SCAN_CAP}, clients=${CLIENT_CAP}). Coverage for this run is PARTIAL.`,
        );
      }
      console.log(
        `[sam-candidates] evaluated=${result.evaluated} created=${result.created} ` +
          `refreshed=${result.refreshed} markedStale=${result.markedStale} ` +
          `humanDecisionsPreserved=${result.humanDecisionsPreserved} errors=${result.errors} ` +
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

// Guarded entrypoint: only runs when invoked directly, never on import (the spec
// imports the pure helpers).
const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /generate-sam-opportunity-candidates(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error('[sam-candidates] FAILED', err);
    process.exit(1);
  });
}

export { main };
