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
import { samNoticeKind } from '../src/funding-opportunities/opportunity-kind.js';
import { sourceRecordIdentityColumns } from '../src/funding-opportunities/funding-opportunity-identity.js';
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

/**
 * Page size for BOTH keyset walks. Not a coverage boundary — see
 * producer-pagination.ts. Replaces OPPORTUNITY_SCAN_CAP / CLIENT_CAP, which were
 * coverage boundaries: measured on capiro-dev 2026-07-29 there were 17,915 active
 * in-deadline notices, so the 4,000 notice bound evaluated 22% of them.
 */
export const PAGE_SIZE = DEFAULT_PAGE_SIZE;
/** Runaway guard per walk. Reaching it is INCOMPLETE, never a clean success. */
export const MAX_PAGES = DEFAULT_MAX_PAGES;

/** Fields the SAM scorer and the workflow snapshot need. */
const NOTICE_SELECT = {
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
} as const;

type SamNoticeRow = {
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
  /** Resume point from a prior INCOMPLETE run's reported cursor. */
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
  /** Resume point from a prior INCOMPLETE run's reported cursor. */
  resumeClientCursor?: string | null;
}

export interface GenerateResult extends RunCounts {
  evaluated: number;
  created: number;
  refreshed: number;
  markedStale: number;
  humanDecisionsPreserved: number;
  /** Shared completion vocabulary — identical words in the grant producer. */
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
 * Query shape (P04): nested keyset walks, clients outer and notices inner. Per
 * client page: one client read, one mapping read, one contractor-UEI resolution,
 * and one award-history read per client per rail. Per (client page x notice page):
 * one notice read and one workflow read. There is still NO query per
 * (client, notice) pair — scoring is a pure function over rows already in memory.
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
  let clientsRead = 0;
  let noticeCorpus = 0;
  let pursuableCorpus = 0;
  let noticeWalkIncomplete = false;
  let clientWalkOutcome: KeysetWalkOutcome | null = null;

  const now = new Date();
  // Active, in-deadline notices. The predicate is unchanged; what changed is that
  // the walk visits ALL of them instead of the first 4,000 by response deadline.
  const activeNoticeWhere = {
    active: true,
    OR: [{ responseDeadline: null }, { responseDeadline: { gte: now } }],
  };

  for (const tenantId of options.tenantIds) {
    // Outer walk: tenant clients, keyset on client id.
    clientWalkOutcome = await walkKeyset<ClientProfileFacts>({
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
      startCursor: options.resumeClientCursor ?? null,
      key: (client) => client.clientId,
      shouldStop: () => noticeWalkIncomplete,
      // Tenant-scoped read: bypass + EXPLICIT tenantId, always both.
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

        // Per PAGE, not per client.
        const contractorUeis = await resolveContractorUeis(
          prisma,
          contractorIdsToResolve(clientPage),
        );

        // One award-history read per client per rail, built ONCE and reused across
        // every notice page below. Throws rather than degrading to empty history: a
        // run that scored every client against no award history would mark real
        // suggestions stale.
        const profileByClient = new Map<string, SamClientProfile>();
        for (const client of clientPage) {
          const history = await readAwardHistoryByBasis(
            prisma,
            buildAwardHistoryIdentity(client, contractorUeis),
          );
          profileByClient.set(client.clientId, buildClientOpportunityProfile(client, history).sam);
        }

        let pursuableThisWalk = 0;

        // Inner walk: global SAM notices, keyset on notice id.
        const noticeWalk = await walkKeyset<SamNoticeRow>({
          pageSize: PAGE_SIZE,
          maxPages: MAX_PAGES,
          key: (notice) => notice.id,
          read: (cursor, take) =>
            prisma.samOpportunity.findMany({
              where: { ...activeNoticeWhere, ...(cursor ? { id: { gt: cursor } } : {}) },
              select: NOTICE_SELECT,
              // Keyset order, NOT responseDeadline order. responseDeadline is
              // nullable, non-unique and mutable, so paging on it can show a row
              // twice or never.
              orderBy: { id: 'asc' },
              take,
            }) as Promise<SamNoticeRow[]>,
          onPage: async (noticePage) => {
            // Award notices and special notices are not pursuits, so they are never
            // suggested — filtered here rather than in the SQL so the notice-type
            // vocabulary lives in exactly one place (opportunity-kind.ts). They are
            // excluded from the scored set entirely, not merely down-ranked.
            const pursuable = noticePage.filter(
              (n) => !NON_PURSUABLE_KINDS.has(samNoticeKind(n.noticeType)),
            );
            pursuableThisWalk += pursuable.length;
            if (pursuable.length === 0) return;

            const noticeProfiles = pursuable.map((n) => ({
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
              } satisfies SamOpportunityProfile,
            }));

            // Existing rows for this (client page x notice page) only. Scoping to
            // the notice page keeps memory bounded regardless of how many
            // suggestions a client already has, and it is ONE query for the whole
            // block rather than one per pair.
            const existingRows = await withBypass(prisma, (tx) =>
              tx.clientFundingOpportunity.findMany({
                where: {
                  tenantId,
                  clientId: { in: clientIds },
                  source: 'sam_gov',
                  samOpportunityId: { in: noticeProfiles.map((n) => n.id) },
                },
                select: {
                  id: true,
                  clientId: true,
                  samOpportunityId: true,
                  workflowStatus: true,
                  userCreated: true,
                  evidenceSourceType: true,
                  staleAt: true,
                },
              }),
            );
            const existingByKey = new Map<string, (typeof existingRows)[number]>();
            for (const r of existingRows) {
              if (r.samOpportunityId) existingByKey.set(`${r.clientId}:${r.samOpportunityId}`, r);
            }

            for (const client of clientPage) {
              const profile = profileByClient.get(client.clientId)!;
              for (const notice of noticeProfiles) {
                evaluated += 1;
                try {
                  const scored = scoreSamOpportunityRelevance(profile, notice.profile);
                  const existing = existingByKey.get(`${client.clientId}:${notice.id}`) ?? null;
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
                              clientId: client.clientId,
                              source: 'sam_gov',
                              // DUAL-WRITE (P13): legacy pointer AND generic
                              // identity, from one helper so a producer cannot
                              // emit a row the generic index does not see.
                              ...sourceRecordIdentityColumns('sam_gov', notice.id),
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
                            // staleAt only. NOT a status change and NOT a delete:
                            // the row is what change detection diffs against, and
                            // "we stopped suggesting this" is itself the signal.
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
                    `[sam-candidates] failed ${client.clientId} x ${notice.id}: ${
                      (err as Error).message
                    }`,
                  );
                }
              }
            }
          },
        });

        if (noticeWalk.completion === 'INCOMPLETE') noticeWalkIncomplete = true;
        // Every notice walk covers the same corpus, so the largest is the corpus
        // size rather than a sum across client pages.
        noticeCorpus = Math.max(noticeCorpus, noticeWalk.rowsRead);
        pursuableCorpus = Math.max(pursuableCorpus, pursuableThisWalk);
      },
    });
  }

  console.log(
    `[sam-candidates] ${noticeCorpus} active notices scanned, ${pursuableCorpus} pursuable`,
  );

  const coverage =
    noticeWalkIncomplete || clientWalkOutcome?.completion === 'INCOMPLETE'
      ? incompleteCoverage({
          clientsRead,
          opportunitiesRead: noticeCorpus,
          resumeClientCursor: clientWalkOutcome?.resumeCursor ?? null,
          guard: noticeWalkIncomplete ? 'opportunity_pages' : 'client_pages',
          resumeFlag: '--resume-client',
        })
      : completeCoverage(clientsRead, noticeCorpus);

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
    pursuableRead: pursuableCorpus,
    resumeClientCursor: coverage.resumeClientCursor,
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
        resumeClientCursor: args.resumeClient,
      });
      if (result.completion === 'INCOMPLETE') {
        // Deliberately does NOT say "raise the cap" — there is no cap. It names
        // the guard that tripped and the exact flag needed to finish the walk.
        console.warn(
          `[sam-candidates] ⚠️ INCOMPLETE: ${result.incompleteReason ?? 'coverage is partial'}`,
        );
      }
      console.log(
        `[sam-candidates] evaluated=${result.evaluated} created=${result.created} ` +
          `refreshed=${result.refreshed} markedStale=${result.markedStale} ` +
          `humanDecisionsPreserved=${result.humanDecisionsPreserved} errors=${result.errors} ` +
          `coverage=${result.completion} clients=${result.clientsRead} ` +
          `notices=${result.opportunitiesRead} pursuable=${result.pursuableRead} ` +
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
