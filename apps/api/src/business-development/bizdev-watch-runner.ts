import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Prisma as PrismaTag } from '@prisma/client';
import { normalizeCompanyName } from '../vendor-reference/vendor-name.util.js';
import type {
  BizDevSourceObservation,
  BizDevAlertDraft,
  BizDevSuppressionReasonCode,
  BizDevWatchDiffResult,
  BizDevWatchBaseline,
  BizDevWatchScanCheckpoint,
  BizDevWatchScanExposureCheckpoint,
} from './bizdev-watch.types.js';
import { diffObservationAgainstBaseline as diffFn } from './bizdev-watch-diff.js';
import { resolveScanCheckpoint, scanScopeHash } from './bizdev-watch-checkpoint.js';
export { resolveScanCheckpoint, scanScopeHash } from './bizdev-watch-checkpoint.js';

/**
 * Business Development Phase 5 — DB-ONLY watch evaluator runner.
 *
 * INV-0 (binding): this module imports NOTHING from src/external/, no
 * provider client, no HTTP library. It reads ONLY existing canonical global
 * projections (FederalAward, FederalAssistanceAward, SamOpportunity,
 * TangoResourceSnapshot, LdaFiling) and writes only the Phase 5 tenant
 * tables. It creates no schedule, no polling loop, no sleep/retry: the
 * scheduler is the sole retry owner.
 *
 * Execution model per source state row:
 *   1. SYSTEM discovery (withSystem — the repo's audited RLS-bypass path)
 *      finds a bounded, deterministic set of claimable source-state rows,
 *      joining tenants and filtering BOTH businessDevelopment.enabled and
 *      businessDevelopment.watch.enabled fail-closed IN SQL, so an
 *      unenrolled tenant (e.g. a legacy watchRequested row backfilled by the
 *      migration) can never be claimed by a global-on pilot deployment. No
 *      bare cross-tenant query ever runs outside withSystem.
 *   2. claim the WatchSourceState lease transactionally per tenant
 *      (withTenant, compare-and-set on lease token/expiry) — only the lease
 *      owner may finalize;
 *   3. resolve exact identity (canonical entity identifiers → UEI / exact
 *      normalized canonical-or-alias name) under current tenant visibility
 *      rules FIRST, with an explicit result: unresolved/ambiguous identity
 *      stays pending — NO baseline is established, NO alert is produced;
 *   4. read ONE bounded keyset page from the EXISTING projection (page+1
 *      probe). A fully fetched, error-free, review-free page PERSISTS its
 *      cursor/checkpoint progress (successful bounded progress); a failed
 *      or incomplete read ROLLS BACK that page — state partial/error,
 *      lastAttemptAt/lastError/consecutiveFailures set, no cursor/baseline
 *      advance, nothing inserted/delivered, never blocks other families;
 *   5. each validated page commits in ONE per-source transaction:
 *      conflict-safe alert insert (createMany skipDuplicates + exact unique
 *      re-lookup so a duplicate replay does NOT abort the transaction and
 *      never double-delivers); only a NEWLY inserted alert gets its
 *      delivery + alert-created activity. The COMPLETE baseline/watermark
 *      (initialized, lastSuccessfulCompleteCheckAt, sourceWatermark,
 *      healthy) advances ONLY at complete-cycle end — a mid-cycle page
 *      commits progress but stays honestly partial, and a partial/error
 *      outcome NEVER advances it.
 *   6. EVERY finalize/release write predicates on tenantId + id +
 *      leaseToken=claimToken (checked updateMany) so an expired task can
 *      never clear or overwrite a newer worker's lease.
 *   7. LDA reads use the existing normalized-company-name path: a bounded
 *      candidate read on contains-matches then an EXACT
 *      normalizeCompanyName post-filter (the dossier's lobbyingSection
 *      pattern). Contains-only/fuzzy candidates never become observations;
 *      an exact result over-bound means partial. SAM reads are exposure-
 *      FIRST: the bounded agency-exposure walk finishes (and is reused)
 *      before ANY opportunity query, and the opportunity fence is captured
 *      only then, scoped to the frozen agency set.
 *
 * Deferred family: acquisition_revision is DEFERRED (excluded from the
 * default config allowlist and from watch activation). The existing ledger's
 * identityKey semantics are NOT a provable exact company link, and Phase 5
 * never weakens a link to fit (no ingestion/projection changes). A state row
 * configured for it is marked 'stale' with a safe reason and skipped.
 */

export interface BizDevWatchRunConfig {
  /** Global kill-switch (BIZDEV_WATCH_ENABLED). */
  enabled: boolean;
  /** Source-family allowlist (validated: unknown family = fatal). */
  sourceFamilies: string[];
  /** Max watches processed per run. */
  maxWatchesPerRun: number;
  /** Bounded page size per source keyset read (+1 probe); also the SAM exposure sub-walk bound. */
  maxRecordsPerSource: number;
  /** Lease duration in seconds. */
  leaseSeconds: number;
}

export interface BizDevWatchRunMetrics {
  checked: number;
  baselined: number;
  candidates: number;
  duplicates: number;
  delivered: number;
  suppressed: number;
  partial: number;
  failed: number;
  durationMs: number;
}

export const BIZDEV_WATCH_SOURCE_FAMILIES = [
  'federal_award',
  'federal_assistance_award',
  'sam_opportunity',
  'tango_resource',
  'lda_filing',
  'acquisition_revision',
] as const;

/** Families that actually scan today (acquisition_revision is deferred). */
export const BIZDEV_WATCH_ACTIVE_SOURCE_FAMILIES = [
  'federal_award',
  'federal_assistance_award',
  'sam_opportunity',
  'tango_resource',
  'lda_filing',
] as const;

export type BizDevWatchSourceFamilyName = (typeof BIZDEV_WATCH_SOURCE_FAMILIES)[number];

/**
 * Parse + fail-closed validate a comma-separated family list. An
 * UNDEFINED/absent value falls back to the SAFE ACTIVE FIVE — the same
 * default as config.schema.ts and the CLI — so acquisition_revision is
 * never activated by default anywhere. An explicitly EMPTY string means
 * "no families" (validateRunConfig then fails closed).
 */
export function parseSourceFamilies(raw: string | undefined): BizDevWatchSourceFamilyName[] {
  const known = new Set<string>(BIZDEV_WATCH_SOURCE_FAMILIES);
  const effective = raw ?? BIZDEV_WATCH_ACTIVE_SOURCE_FAMILIES.join(',');
  const parts = effective
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const p of parts) {
    if (!known.has(p)) {
      throw new Error(
        `Unknown BizDev watch source family "${p}" (allowed: ${BIZDEV_WATCH_SOURCE_FAMILIES.join(', ')})`,
      );
    }
  }
  return parts as BizDevWatchSourceFamilyName[];
}

/** Validate resolved config bounds; invalid bounds fail closed (throw). */
export function validateRunConfig(config: BizDevWatchRunConfig): void {
  if (
    !Number.isInteger(config.maxWatchesPerRun) ||
    config.maxWatchesPerRun < 1 ||
    config.maxWatchesPerRun > 500
  ) {
    throw new Error('BIZDEV_WATCH_MAX_PER_RUN must be an integer between 1 and 500');
  }
  if (
    !Number.isInteger(config.maxRecordsPerSource) ||
    config.maxRecordsPerSource < 1 ||
    config.maxRecordsPerSource > 500
  ) {
    throw new Error('BIZDEV_WATCH_MAX_RECORDS_PER_SOURCE must be an integer between 1 and 500');
  }
  if (
    !Number.isInteger(config.leaseSeconds) ||
    config.leaseSeconds < 30 ||
    config.leaseSeconds > 3600
  ) {
    throw new Error('BIZDEV_WATCH_LEASE_SECONDS must be an integer between 30 and 3600');
  }
  if (config.sourceFamilies.length === 0) {
    throw new Error('BIZDEV_WATCH_SOURCE_FAMILIES must name at least one family');
  }
  for (const family of config.sourceFamilies) {
    if (!new Set<string>(BIZDEV_WATCH_SOURCE_FAMILIES).has(family)) {
      throw new Error(`Unknown BizDev watch source family "${family}"`);
    }
  }
}

/** The runner's identity anchor: exact UEI + RAW exact candidate names. */
export interface BizDevWatchIdentityAnchor {
  resolved: boolean;
  uei: string | null;
  /**
   * RAW canonical + alias names (canonicalName / aliases.alias), NOT the
   * normalized fields. Raw names feed the LDA candidate CONTAINS query
   * (raw-with-punctuation rows can never contain a stripped normalized
   * string); normalizeCompanyName is applied to BOTH sides only in the
   * exact post-filter — the dossier's lobbyingSection pattern.
   */
  exactNames: string[];
}

/**
 * Minimal DB surface the runner needs. `withTenant` is the repo's audited
 * tenant-scoped transaction; `withSystem` is the repo's audited RLS-bypass
 * transaction, used ONLY for the bounded cross-tenant candidate +
 * tenant-settings discovery — never for a claim, read, or write.
 */
export interface BizDevWatchRunnerDb {
  withTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  withSystem<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

/** Direct (global, non-tenant-scoped) projection delegate. */
export interface BizDevProjectionDb {
  federalAward: PrismaClient['federalAward'];
  federalAssistanceAward: PrismaClient['federalAssistanceAward'];
  samOpportunity: PrismaClient['samOpportunity'];
  tangoResourceSnapshot: PrismaClient['tangoResourceSnapshot'];
  ldaFiling: PrismaClient['ldaFiling'];
}

interface WatchRow {
  id: string;
  tenantId: string;
  prospectId: string;
  ownerUserId: string | null;
  status: string;
  mutedUntil: Date | null;
  categories: string[];
  prospect: {
    id: string;
    status: string;
    dismissedAt: Date | null;
    conflictExcluded: boolean;
    canonicalEntity: {
      tenantId: string | null;
      identityScope: string;
      canonicalName: string;
      normalizedName: string;
      status: string;
      mergedIntoEntityId: string | null;
      identifiers: Array<{ identifierType: string; identifierValue: string }>;
      aliases: Array<{ alias: string; normalizedAlias: string }>;
    } | null;
  };
}

/** One claimable source-state row discovered by the system scan. */
export interface BizDevWatchClaimCandidate {
  id: string;
  tenantId: string;
  watchId: string;
  sourceFamily: string;
}

/** Resolve the exact identity anchor under current tenant visibility rules. */
export function identityAnchorFor(
  watch: Pick<WatchRow, 'tenantId' | 'prospect'>,
): BizDevWatchIdentityAnchor {
  const entity = watch.prospect.canonicalEntity;
  if (!entity) return { resolved: false, uei: null, exactNames: [] };
  const visible = entity.identityScope === 'global_public' || entity.tenantId === watch.tenantId;
  if (!visible || entity.status !== 'active' || entity.mergedIntoEntityId != null) {
    return { resolved: false, uei: null, exactNames: [] };
  }
  const uei = entity.identifiers.find((i) => i.identifierType === 'uei')?.identifierValue ?? null;
  // RAW names only: canonicalName + aliases.alias. The raw strings feed the
  // LDA candidate contains query; normalizeCompanyName runs on BOTH sides
  // in the exact post-filter (the dossier's lobbyingSection pattern).
  const exactNames = [entity.canonicalName, ...entity.aliases.map((a) => a.alias)].filter(
    (n): n is string => Boolean(n) && n.length > 0,
  );
  // Resolved = at least one exact anchor exists (a UEI or an exact name).
  return { resolved: uei != null || exactNames.length > 0, uei, exactNames };
}

/**
 * SYSTEM discovery (WITH-SYSTEM ONLY — never a bare cross-tenant query):
 * bounded, deterministic, parameterized scan of claimable source-state rows
 * whose tenant is ENROLLED — both businessDevelopment.enabled AND
 * businessDevelopment.watch.enabled must resolve true in the tenant's
 * settings_jsonb.clioFeatureFlags (fail-closed: missing/malformed settings
 * exclude the tenant). Runs inside db.withSystem so the production
 * capiro_app role (NOBYPASSRLS) sees the rows under the audited bypass.
 */
export async function discoverClaimCandidates(
  db: BizDevWatchRunnerDb,
  families: string[],
  limit: number,
): Promise<BizDevWatchClaimCandidate[]> {
  const familyList = PrismaTag.join(families);
  return db.withSystem((tx) =>
    tx
      .$queryRaw<BizDevWatchClaimCandidate[]>(
        PrismaTag.sql`
    SELECT s."id", s."tenant_id" AS "tenantId", s."watch_id" AS "watchId",
           s."source_family" AS "sourceFamily"
    FROM "business_development_watch_source_states" s
    JOIN "business_development_watches" w
      ON w."tenant_id" = s."tenant_id" AND w."id" = s."watch_id" AND w."status" <> 'ended'
    JOIN "tenants" t
      ON t."id" = s."tenant_id"
    WHERE s."source_family" IN (${familyList})
      AND (s."lease_until" IS NULL OR s."lease_until" <= now())
      -- Tenant enrollment, fail-closed in SQL: BOTH the base
      -- businessDevelopment.enabled and the Phase 5 watch flag must resolve
      -- true. Malformed / missing settings -> no match -> no claim.
      AND (t."settings_jsonb" -> 'clioFeatureFlags' ->> 'businessDevelopment.enabled') = 'true'
      AND (t."settings_jsonb" -> 'clioFeatureFlags' ->> 'businessDevelopment.watch.enabled') = 'true'
    ORDER BY s."updated_at" ASC
    LIMIT ${limit}`,
      )
      .then((rows: BizDevWatchClaimCandidate[] | null | undefined) => rows ?? []),
  );
}

/**
 * One DB-only evaluator pass. Returns structured metrics; throws ONLY on
 * invalid config / fatal setup (the caller exits nonzero then).
 */
export async function runBizDevWatchEvaluation(
  db: BizDevWatchRunnerDb,
  projections: BizDevProjectionDb,
  config: BizDevWatchRunConfig,
  clock: () => Date = () => new Date(),
): Promise<BizDevWatchRunMetrics> {
  validateRunConfig(config);
  const started = Date.now();
  const metrics: BizDevWatchRunMetrics = {
    checked: 0,
    baselined: 0,
    candidates: 0,
    duplicates: 0,
    delivered: 0,
    suppressed: 0,
    partial: 0,
    failed: 0,
    durationMs: 0,
  };
  if (!config.enabled) {
    metrics.durationMs = Date.now() - started;
    return metrics;
  }

  const families = config.sourceFamilies;
  const claimToken = randomUUID();
  const now = clock();
  const leaseUntil = new Date(now.getTime() + config.leaseSeconds * 1000);

  // ── SYSTEM discovery: bounded, enrolled-tenant-only, parameterized ─────
  // Runs EXCLUSIVELY through db.withSystem (the audited RLS-bypass
  // transaction). Unenrolled tenants produce zero candidates here, so they
  // get no claim, no baseline, and no alerts.
  const candidateStates = await discoverClaimCandidates(db, families, config.maxWatchesPerRun * 2);

  const claimed: BizDevWatchClaimCandidate[] = [];

  for (const state of candidateStates) {
    if (claimed.length >= config.maxWatchesPerRun) break;
    // Transactional lease claim (per tenant, withTenant): only an
    // unclaimed/expired row flips to our token; a concurrent worker's claim
    // makes this update match zero rows.
    const ok = await db.withTenant(state.tenantId, (tx) =>
      tx.$executeRaw`UPDATE "business_development_watch_source_states"
          SET "lease_token" = ${claimToken}, "lease_until" = ${leaseUntil},
              "last_attempt_at" = ${now}, "updated_at" = ${now}
          WHERE "id" = ${state.id}::uuid
            AND "tenant_id" = ${state.tenantId}::uuid
            AND ("lease_until" IS NULL OR "lease_until" <= now())`.then((n: number) => n === 1),
    );
    if (ok) {
      metrics.checked += 1;
      claimed.push(state);
    }
  }

  for (const state of claimed) {
    try {
      const outcome = await db.withTenant(state.tenantId, async (tx) => {
        const watch = (await tx.businessDevelopmentWatch.findFirst({
          where: { tenantId: state.tenantId, id: state.watchId },
          select: {
            id: true,
            tenantId: true,
            prospectId: true,
            ownerUserId: true,
            status: true,
            mutedUntil: true,
            categories: true,
            prospect: {
              select: {
                id: true,
                status: true,
                dismissedAt: true,
                conflictExcluded: true,
                canonicalEntity: {
                  select: {
                    tenantId: true,
                    identityScope: true,
                    canonicalName: true,
                    normalizedName: true,
                    status: true,
                    mergedIntoEntityId: true,
                    identifiers: { where: { status: 'active' } },
                    aliases: { where: { status: 'active' } },
                  },
                },
              },
            },
          },
        })) as unknown as WatchRow | null;
        if (!watch || watch.status === 'ended') return 'skipped' as const;

        const stateRow = await tx.businessDevelopmentWatchSourceState.findFirst({
          where: { tenantId: state.tenantId, id: state.id },
        });
        // Only the lease owner may finalize.
        if (!stateRow || stateRow.leaseToken !== claimToken) return 'skipped' as const;

        // EVERY state write predicates on tenant + id + LEASE TOKEN so an
        // expired task can never clear or overwrite a newer worker's lease.
        const finalizeState = async (
          data: Prisma.BusinessDevelopmentWatchSourceStateUpdateManyMutationInput,
        ): Promise<number> =>
          tx.businessDevelopmentWatchSourceState
            .updateMany({
              where: {
                tenantId: state.tenantId,
                id: state.id,
                leaseToken: claimToken,
              },
              data,
            })
            .then((r: { count: number }) => r.count);

        // ── A14 runtime recheck: owner eligibility (tenant transaction) ──
        // Activation validates the owner, but the runner NEVER trusts the
        // frozen value alone: a null ownerUserId (legacy backfill) or an
        // owner who lost ACTIVE membership must produce no alert, delivery,
        // or activity — release only this lease as pending with a safe
        // reason. Never auto-reassign in a worker.
        if (watch.ownerUserId == null) {
          const n = await finalizeState({
            health: 'pending',
            lastError:
              'Watch has no owner — waiting for an owner to be set before any alert can be delivered',
            leaseToken: null,
            leaseUntil: null,
          });
          if (n === 0) return 'skipped' as const;
          return 'pending' as const;
        }
        const ownerActive = await tx.tenantMembership.findFirst({
          where: {
            tenantId: state.tenantId,
            userId: watch.ownerUserId,
            status: 'active',
          },
          select: { id: true },
        });
        if (!ownerActive) {
          const n = await finalizeState({
            health: 'pending',
            lastError:
              'Watch owner is no longer an active member of this tenant — no alert is delivered until the watch has an eligible owner',
            leaseToken: null,
            leaseUntil: null,
          });
          if (n === 0) return 'skipped' as const;
          return 'pending' as const;
        }

        // ── Deferred family: acquisition_revision ─────────────────────────
        // The ledger's identityKey semantics are not a provable exact company
        // link; Phase 5 never weakens a link to fit. Mark stale with a safe
        // reason, no read, no baseline, no alert.
        if (state.sourceFamily === 'acquisition_revision') {
          const n = await finalizeState({
            health: 'stale',
            lastError:
              'acquisition_revision is deferred: no exact prospect-to-ledger identity linkage is provable from existing data',
            leaseToken: null,
            leaseUntil: null,
          });
          // Lost the lease before the release: NOT a deferred success.
          if (n === 0) return 'skipped' as const;
          return 'deferred' as const;
        }

        // ── Identity resolution FIRST, explicit result ─────────────────────
        const anchor = identityAnchorFor(watch);
        if (!anchor.resolved || (state.sourceFamily !== 'lda_filing' && !anchor.uei)) {
          // Unresolved/ambiguous identity stays pending: no baseline, no
          // alert — never a confident alert on a weak identity. A zero-count
          // finalize means the lease was lost: skipped, NOT a pending result.
          const n = await finalizeState({
            health: 'pending',
            lastError: anchor.resolved
              ? 'Exact UEI is required for this source — no complete comparison or absence is established'
              : 'Identity not resolved yet — waiting for a confirmed canonical organization with an exact identifier',
            leaseToken: null,
            leaseUntil: null,
          });
          if (n === 0) return 'skipped' as const;
          return 'pending' as const;
        }

        // ── Resumable bounded scan: one fully validated page per source ────
        // PAGE vs CYCLE distinction (documented deliberately):
        //   * A PAGE is one bounded keyset read that was fully fetched and
        //     validated (no read error, no review/skip). Only a fully
        //     validated page may persist its cursor + per-record progress
        //     under this lease-predicated transaction.
        //   * A CYCLE is the complete keyset walk from the beginning up to
        //     the fence. `initialized`, `establishedAt`,
        //     `lastSuccessfulCompleteCheckAt`, and `sourceWatermark` advance
        //     ONLY at cycle completion — a source mid-cycle (even with all
        //     pages healthy) is NOT "healthy complete" coverage yet.
        //   * Initial-phase pages stage fingerprints QUIETLY (zero alerts);
        //     established-cycle pages may diff/update accepted per-record
        //     baselines atomically with alerts.
        const baselineDoc =
          (stateRow.baselineState as unknown as BizDevWatchBaseline | null) ?? null;
        const established = baselineDoc?.initialized === true;
        const scopeHash = scanScopeHash(state.sourceFamily, anchor);
        // Fail-closed checkpoint resolution: legacy (no scan field), malformed,
        // or newer-version checkpoint data never crashes and never fabricates
        // success — a malformed scan fails the source as partial with a safe
        // reason; a legacy scan synthesizes a fresh checkpoint from scratch.
        let scan: BizDevWatchScanCheckpoint;
        let scopeChanged = false;
        try {
          scan = resolveScanCheckpoint(baselineDoc, scopeHash, established);
        } catch (scanError) {
          const n = await finalizeState({
            health: 'partial',
            lastError:
              scanError instanceof Error ? scanError.message : 'Stored scan checkpoint is unusable',
            leaseToken: null,
            leaseUntil: null,
          });
          if (n === 0) return 'skipped' as const;
          metrics.partial += 1;
          return 'partial' as const;
        }
        // A scope/identity change means the stored cursor indexes a DIFFERENT
        // result set. NEVER diff one entity's source records against
        // another's: invalidate the traversal and establish a QUIET baseline
        // for the newly scoped identity, keeping historical alerts as audit.
        // (For an established baseline the diff already treats
        // initialized=false as quiet — 'baseline' outcome, no alerts — so a
        // scope change cannot storm; the quiet re-baseline is deliberate.)
        if (baselineDoc?.scan != null && scan.scopeHash !== scopeHash) {
          scopeChanged = true;
          scan = {
            version: 1,
            scopeHash,
            phase: 'initial',
            cursorId: null,
            fenceId: null,
            stagedRecords: {},
            pagesDone: 0,
          };
        }

        let observations: BizDevSourceObservation[];
        let page: BizDevWatchScanPage;
        try {
          const read = await readScanPage(
            projections,
            state.sourceFamily as Exclude<BizDevWatchSourceFamilyName, 'acquisition_revision'>,
            anchor,
            config.maxRecordsPerSource,
            scan,
          );
          observations = read.observations;
          page = read.page;
        } catch (readError) {
          // Source read error: mark error, do NOT advance baseline/watermark/
          // cursor, deliver nothing. A zero-count finalize means the lease
          // was lost before the release: skipped, NOT an error result.
          const n = await finalizeState({
            health: 'error',
            lastError: readError instanceof Error ? readError.message : String(readError),
            consecutiveFailures: { increment: 1 },
            leaseToken: null,
            leaseUntil: null,
          });
          if (n === 0) return 'skipped' as const;
          metrics.failed += 1;
          return 'error' as const;
        }

        // ── Diff the page against the baseline ───────────────────────────
        // The DIFF baseline is the authoritative accepted records map — during
        // the initial phase it is deliberately UNINITIALIZED so every record
        // is quiet-staged; during a cycle it is the established baseline.
        // Suppression (clock-injected for testability): paused watch, muted
        // now, conflict-excluded prospect, dismissed prospect. Progress still
        // persists (a later resume cannot emit accumulated changes); the
        // delivery is suppressed with a persisted safe reason — suppression
        // is NEVER lost across page boundaries or replay.
        const nowTs = clock().getTime();
        const suppressionReason =
          watch.status === 'paused'
            ? 'Delivery suppressed: watch paused by owner'
            : watch.mutedUntil != null && watch.mutedUntil.getTime() > nowTs
              ? 'Delivery suppressed: watch muted by owner'
              : watch.prospect.conflictExcluded
                ? 'Delivery suppressed: prospect conflict-excluded'
                : watch.prospect.dismissedAt != null
                  ? 'Delivery suppressed: prospect dismissed'
                  : null;
        const scopeSuppressionCode: BizDevSuppressionReasonCode | null =
          watch.status === 'paused'
            ? 'watch_paused'
            : watch.mutedUntil != null && watch.mutedUntil.getTime() > nowTs
              ? 'watch_muted'
              : watch.prospect.conflictExcluded
                ? 'prospect_conflict_excluded'
                : watch.prospect.dismissedAt != null
                  ? 'prospect_dismissed'
                  : null;
        // On a scope change the traversal restarts QUIET: the new identity's
        // records must never diff against the OLD identity's accepted
        // fingerprints (that would storm catch-up alerts); the diff's
        // uninitialized-baseline path stages them silently.
        const diffBaseline: BizDevWatchBaseline | null =
          established && !scopeChanged ? baselineDoc : null;
        const records: Record<string, unknown> = {};
        const drafts: BizDevAlertDraft[] = [];
        let review = false;
        let suppressedDelta = 0;
        let diffFailures = 0;
        for (const observation of observations) {
          metrics.candidates += 1;
          let result: BizDevWatchDiffResult;
          try {
            result = diffFn(observation, diffBaseline);
          } catch {
            diffFailures += 1;
            review = true;
            continue;
          }
          if (result.outcome === 'review' || result.outcome === 'skip') {
            // Unresolved/ambiguous identity or an unusable observation: never
            // a confident alert, and NEVER a trusted baseline fact — the
            // page is incomplete: cursor does not advance past its start.
            review = true;
            continue;
          }
          let candidateSuppressionCode: BizDevSuppressionReasonCode | null = null;
          if (result.outcome === 'alert' && result.alertDraft) {
            const category = result.alertDraft.category;
            const categorySelected =
              watch.categories.length === 0 || watch.categories.includes(category);
            if (!categorySelected) {
              candidateSuppressionCode = 'category_not_selected';
              suppressedDelta += 1;
            } else if (result.alertDraft.changeKind === 'backfill') {
              // Old history surfacing after the baseline: suppressed by
              // default (counted, never a user-visible alert/delivery).
              candidateSuppressionCode = 'backfill';
              suppressedDelta += 1;
            } else if (scopeSuppressionCode != null) {
              candidateSuppressionCode = scopeSuppressionCode;
              suppressedDelta += 1;
            } else {
              drafts.push(result.alertDraft);
            }
          }
          if (result.baselineUpdate) {
            records[observation.recordId] = candidateSuppressionCode
              ? { ...result.baselineUpdate, suppressionReason: candidateSuppressionCode }
              : result.baselineUpdate;
          }
        }

        // A review/skip anywhere makes the page INCOMPLETE: no cursor advance,
        // no baseline advance, no alert insert, no delivery — only this lease
        // is released. The prior durable progress survives.
        if (review) {
          const n = await finalizeState({
            health: 'partial',
            lastError:
              'Diff returned review/skip for at least one observation — page not advanced; no alert',
            leaseToken: null,
            leaseUntil: null,
          });
          if (n === 0) return 'skipped' as const;
          metrics.partial += 1;
          metrics.failed += diffFailures;
          return 'partial' as const;
        }

        const baselinedDelta = scan.phase === 'initial' && page.cycleEnd ? 1 : 0;

        // ── ONE per-source transaction (unchanged shape) ─────────────────
        // Alerts + deliveries + activity + baseline + checkpoint + lease
        // release commit together; any failure rolls back ALL of them.
        const stagedRecords: BizDevWatchBaseline['records'] = {
          ...scan.stagedRecords,
          ...records,
        } as BizDevWatchBaseline['records'];
        const cycleEnd = page.cycleEnd;
        const nextScan: BizDevWatchScanCheckpoint = cycleEnd
          ? {
              version: 1,
              scopeHash,
              // Cycle complete: return to the beginning for the NEXT cycle.
              phase: 'cycle',
              cursorId: null,
              fenceId: null,
              stagedRecords: {},
              pagesDone: 0,
            }
          : {
              ...scan,
              pagesDone: scan.pagesDone + 1,
              stagedRecords: scan.phase === 'initial' ? stagedRecords : scan.stagedRecords,
              // Persist the page's inclusive fence and (for SAM) the
              // exposure sub-walk progress so the cycle resumes exactly.
              cursorId: page.nextCursorId,
              fenceId: page.fenceId,
              ...(page.exposure ? { exposure: page.exposure } : {}),
            };

        const newBaseline: BizDevWatchBaseline = cycleEnd
          ? scan.phase === 'initial'
            ? {
                // Initial cycle completed: atomically promote the staged
                // quiet fingerprints to the established baseline. ZERO
                // alerts exist from the initial scan by construction.
                initialized: true,
                establishedAt: clock().toISOString(),
                effectiveFloorAt: scopeChanged ? null : (baselineDoc?.effectiveFloorAt ?? null),
                records: stagedRecords as BizDevWatchBaseline['records'],
                scan: nextScan,
              }
            : {
                // Reconciliation cycle completed: merge this page's accepted
                // per-record updates into the established baseline.
                ...(baselineDoc as BizDevWatchBaseline),
                records: {
                  ...(baselineDoc?.records ?? {}),
                  ...records,
                } as BizDevWatchBaseline['records'],
                scan: nextScan,
              }
          : scan.phase === 'initial'
            ? {
                // Mid-initial-cycle: staged records stay INSIDE the scan
                // checkpoint (bounded traversal metadata, no alerts), and
                // the top-level baseline stays uninitialized/empty so zero
                // alerts can ever be produced before the cycle completes.
                initialized: false,
                establishedAt: clock().toISOString(),
                effectiveFloorAt: scopeChanged ? null : (baselineDoc?.effectiveFloorAt ?? null),
                records: {},
                scan: nextScan,
              }
            : {
                // Mid-reconciliation-cycle: the accepted records map stays
                // authoritative and merged (per-page diff updates land
                // atomically with their alerts); only the watermark waits
                // for cycle end.
                ...(baselineDoc as BizDevWatchBaseline),
                records: {
                  ...(baselineDoc?.records ?? {}),
                  ...records,
                } as BizDevWatchBaseline['records'],
                scan: nextScan,
              };

        let delivered = 0;
        let duplicates = 0;
        if (suppressionReason == null) {
          for (const draft of drafts) {
            // Conflict-safe insert: createMany skipDuplicates gives
            // INSERT ... ON CONFLICT DO NOTHING semantics inside the
            // transaction, so a duplicate replay neither aborts the
            // transaction nor produces a second alert row.
            const inserted = await tx.businessDevelopmentAlert.createMany({
              data: [
                {
                  tenantId: state.tenantId,
                  watchId: state.watchId,
                  prospectId: watch.prospectId,
                  sourceFamily: draft.sourceFamily,
                  category: draft.category,
                  changeKind: draft.changeKind,
                  materiality: draft.materiality,
                  recordId: draft.recordId,
                  sourceRevision: draft.sourceRevision ?? undefined,
                  fingerprint: draft.fingerprint,
                  dedupeKey: draft.dedupeKey,
                  beforeState: (draft.beforeState ?? undefined) as
                    Prisma.InputJsonValue | undefined,
                  afterState: draft.afterState as Prisma.InputJsonValue,
                  changesJsonb: (draft.changes ?? []) as unknown as Prisma.InputJsonValue,
                  title: draft.title,
                  summary: draft.summary,
                  implication: draft.implication,
                  sourceLocator: draft.sourceLocator,
                  eventAt: draft.eventAt ? new Date(draft.eventAt) : undefined,
                  effectiveAt: draft.effectiveAt ? new Date(draft.effectiveAt) : undefined,
                  publishedAt: draft.publishedAt ? new Date(draft.publishedAt) : undefined,
                },
              ],
              skipDuplicates: true,
            });
            if (inserted.count === 0) {
              // Exact unique replay: the alert already exists. Duplicate
              // replay still finalizes the page successfully — no duplicate
              // delivery, no duplicate activity.
              duplicates += 1;
              continue;
            }
            // Only a NEWLY inserted alert gets the in-app delivery + the
            // alert-created activity. Exact unique lookup after the
            // conflict-safe insert.
            const created = await tx.businessDevelopmentAlert.findFirst({
              where: {
                tenantId: state.tenantId,
                watchId: state.watchId,
                dedupeKey: draft.dedupeKey,
              },
              select: { id: true },
            });
            if (!created) {
              throw new Error(
                `Conflict-safe alert insert reported success but the unique row is missing (${draft.dedupeKey})`,
              );
            }
            // In-app delivery to the watch owner (recipient semantics
            // frozen at activation), created ATOMICALLY with the alert.
            if (watch.ownerUserId != null) {
              await tx.businessDevelopmentAlertDelivery.create({
                data: {
                  tenantId: state.tenantId,
                  alertId: created.id,
                  recipientUserId: watch.ownerUserId,
                  channel: 'in_app',
                },
              });
            }
            // Prospect-local activity: source-linked alert-created entry,
            // public title + exact locator only, no private data.
            await tx.businessDevelopmentProspectActivity.create({
              data: {
                tenantId: state.tenantId,
                prospectId: watch.prospectId,
                actorUserId: null,
                kind: 'watch',
                body: `New watch alert: ${draft.title}`,
                afterJsonb: { sourceLocator: draft.sourceLocator } as Prisma.InputJsonValue,
              },
            });
            delivered += 1;
          }
        }

        // Healthy page/cycle finalize: the alert/delivery/activity inserts
        // above are part of THIS tenant transaction. A ZERO-count finalize
        // means final ownership was lost — the healthy write CANNOT be
        // attributed to this worker, so THROW inside the transaction: ALL
        // prior inserts (alerts, deliveries, activities) roll back together
        // with the cursor/baseline advance, so a lost lease can never
        // advance the alert/baseline/cursor state.
        //
        // WATERMARK RULE: lastSuccessfulCompleteCheckAt / sourceWatermark
        // advance ONLY when cycleEnd — traversal-incomplete coverage is
        // never mislabeled healthy-complete. Mid-cycle healthy pages keep
        // health 'partial' with a truthful scan-in-progress reason, so ops
        // never read incomplete coverage as complete success. lastError
        // carries only real problems — normal successful suppression is NOT
        // an error condition on a mid-cycle page.
        const finalized = await finalizeState({
          baselineState: newBaseline as unknown as Prisma.InputJsonValue,
          // A new identity's quiet traversal must not retain completion
          // timestamps belonging to the old identity. Initial progress is
          // permitted by the additive scan-checkpoint shape constraint.
          baselinedAt: cycleEnd ? clock() : scan.phase === 'initial' ? null : undefined,
          lastSuccessfulCompleteCheckAt: cycleEnd
            ? clock()
            : scan.phase === 'initial'
              ? null
              : undefined,
          sourceWatermark: cycleEnd ? clock() : scan.phase === 'initial' ? null : undefined,
          consecutiveFailures: 0,
          lastError: cycleEnd
            ? suppressionReason
            : `Scan in progress (${nextScan.pagesDone} page${nextScan.pagesDone === 1 ? '' : 's'} persisted this traversal; coverage is not yet complete)`,
          health: cycleEnd ? 'healthy' : 'partial',
          leaseToken: null,
          leaseUntil: null,
        });
        if (finalized === 0) {
          throw new Error(
            'Lost the source-state lease before healthy finalization — rolling back all alert/delivery/activity inserts and the scan cursor',
          );
        }
        // Committed: only NOW do the run metrics claim the work (a rolled-
        // back transaction must never be reported as delivered/baselined).
        // A committed mid-cycle healthy page makes bounded FORWARD progress
        // (not a failure) but the traversal is honestly incomplete: count it
        // as a progressed partial so ops never read mid-cycle as complete.
        if (!cycleEnd) metrics.partial += 1;
        metrics.baselined += baselinedDelta;
        metrics.delivered += delivered;
        metrics.duplicates += duplicates;
        metrics.suppressed += suppressedDelta;
        return cycleEnd ? 'healthy' : ('partial' as const);
      });
      if (outcome === 'skipped') metrics.checked -= 1;
    } catch (familyError) {
      // One failed family never blocks others: record and continue. The
      // error-finalize ALSO predicates on the lease token — a stale worker
      // can never overwrite a newer lease with an error state.
      metrics.failed += 1;
      try {
        await db.withTenant(state.tenantId, (tx) =>
          tx.businessDevelopmentWatchSourceState.updateMany({
            where: {
              tenantId: state.tenantId,
              id: state.id,
              leaseToken: claimToken,
            },
            data: {
              health: 'error',
              lastError: familyError instanceof Error ? familyError.message : String(familyError),
              consecutiveFailures: { increment: 1 },
              leaseToken: null,
              leaseUntil: null,
            },
          }),
        );
      } catch {
        // Best-effort error marking; the lease expiry self-heals the row.
      }
    }
  }

  metrics.durationMs = Date.now() - started;
  return metrics;
}

/**
 * PAGE vs CYCLE (documented deliberately): a PAGE is one bounded keyset read
 * that was fully fetched and validated; a CYCLE is the complete keyset walk
 * from the beginning up to the inclusive fence. `initialized` /
 * `establishedAt` / `lastSuccessfulCompleteCheckAt` / `sourceWatermark`
 * advance ONLY at cycle completion; a mid-cycle source is honestly partial.
 *
 * Traversal key: the projection's IMMUTABLE primary key `id`, ASCENDING, with
 * a +1 probe. Dates (actionDate/postedDate/dtPosted/version) are SOURCE
 * SEMANTICS ONLY — never traversal keys, so equal/null dates cannot affect
 * traversal. The cycle fence is the max existing row id at cycle start and
 * is INCLUSIVE (id <= fenceId) — an exclusive fence would skip the highest
 * row forever (including a singleton source). A full cycle returns to the
 * beginning, so changes and insertions behind any cursor are eventually
 * seen: eventual reconciliation, NOT snapshot consistency or instantaneous
 * detection. No date lookback window is used as a correctness boundary.
 */
export interface BizDevWatchScanPage {
  /** IMMUTABLE id of the last row on the page (next page starts AFTER it). */
  nextCursorId: string | null;
  /** INCLUSIVE cycle fence in effect for this page (persist with cursor). */
  fenceId: string | null;
  /** True when the walk reached the inclusive fence: cycle completed. */
  cycleEnd: boolean;
  /** SAM only: exposure sub-walk progress to persist for the next run. */
  exposure: BizDevWatchScanExposureCheckpoint | null;
}

/**
 * Read ONE bounded keyset page for a family from the EXISTING projections.
 * The page query is `id > cursor AND id <= fence ORDER BY id ASC LIMIT
 * pageSize + 1`; the +1 probe distinguishes "fully fetched page with more
 * remaining" from "final page". The fence is captured at cycle start (max
 * existing id, INCLUSIVE) so an append-heavy source can always finish a
 * cycle; rows appended after fence capture are the NEXT cycle's work.
 */
async function readScanPage(
  projections: BizDevProjectionDb,
  family: Exclude<BizDevWatchSourceFamilyName, 'acquisition_revision'>,
  anchor: BizDevWatchIdentityAnchor,
  maxRecords: number,
  scan: BizDevWatchScanCheckpoint,
): Promise<{ observations: BizDevSourceObservation[]; page: BizDevWatchScanPage }> {
  const after = scan.cursorId;
  // Mid-cycle reuse the stored fence; at cycle start capture the INCLUSIVE
  // fence (current max id in scope). Persisted with the page so the cycle
  // terminates even while the source keeps appending.
  // SAM is EXCLUDED here: its fence is captured only after the exposure walk
  // completes, scoped to the frozen agency set (see the sam_opportunity branch).
  const fence =
    family === 'sam_opportunity'
      ? null
      : scan.cursorId != null && scan.fenceId != null
        ? scan.fenceId
        : await cycleFence(projections, family, anchor);
  // Ascending keyset predicate over the immutable id: after cursor, up to
  // and INCLUDING the fence.
  const idRange: Record<string, unknown> = {};
  if (after != null) idRange.gt = after;
  if (fence != null) idRange.lte = fence;
  const keyset = Object.keys(idRange).length > 0 ? { id: idRange } : {};
  const emptyPage = (cycleEnd: boolean, pageFence: string | null = fence): BizDevWatchScanPage => ({
    nextCursorId: after,
    fenceId: pageFence,
    cycleEnd,
    exposure: null,
  });
  const pageFromRows = <T extends { id?: unknown }>(
    rows: T[],
    build: (r: T) => BizDevSourceObservation,
    exposure: BizDevWatchScanExposureCheckpoint | null,
    pageFence: string | null = fence,
  ): { observations: BizDevSourceObservation[]; page: BizDevWatchScanPage } => {
    if (rows.length === 0) {
      return { observations: [], page: { ...emptyPage(true, pageFence), exposure } };
    }
    const pageRows = rows.slice(0, maxRecords);
    const lastRow = pageRows[pageRows.length - 1];
    const lastId = (lastRow?.id ?? pageFence ?? after) as string | null;
    return {
      observations: pageRows.map(build),
      page: {
        nextCursorId: lastId,
        fenceId: pageFence,
        // Inclusive fence: the cycle ends when the +1 probe found NOTHING
        // beyond this page within the fence — the walk has reached (and this
        // page includes) the fence row. This covers the singleton source and
        // the exact-page-size source: the highest row is never skipped.
        cycleEnd: rows.length <= maxRecords,
        exposure,
      },
    };
  };
  if (family === 'federal_award') {
    if (!anchor.uei) return { observations: [], page: emptyPage(true) };
    const rows = await projections.federalAward.findMany({
      where: { recipientUei: anchor.uei, ...keyset },
      orderBy: { id: 'asc' },
      take: maxRecords + 1,
      select: { ...awardSelect, id: true },
    });
    return pageFromRows(rows, (r) => federalAwardObservation(r), null);
  }
  if (family === 'federal_assistance_award') {
    if (!anchor.uei) return { observations: [], page: emptyPage(true) };
    const rows = await projections.federalAssistanceAward.findMany({
      where: { recipientUei: anchor.uei, ...keyset },
      orderBy: { id: 'asc' },
      take: maxRecords + 1,
      select: { ...assistanceSelect, id: true },
    });
    return pageFromRows(rows, (r) => assistanceObservation(r), null);
  }
  if (family === 'sam_opportunity') {
    if (!anchor.uei) return { observations: [], page: emptyPage(true) };
    // Agency exposure: a BOUNDED distinct-agency keyset walk of the UEI's
    // awards — never the hardcoded newest-100. The link stays THEMATIC/
    // CONDITIONAL (an exposed-agency opportunity never asserts the prospect
    // will bid or win; identityConfidence is deliberately NOT 1).
    const exposure = await samExposureAgencies(projections, anchor, maxRecords, scan);
    if (!exposure.complete) {
      // Exposure still walking: ZERO observations, cycle NOT complete, and
      // the opportunity cursor/baseline NEVER advances on this page. Only the
      // exposure sub-walk progress persists. An early partial agency set
      // (even with few/no opportunities) never resets the exposure walk.
      return {
        observations: [],
        page: {
          nextCursorId: after,
          fenceId: null,
          cycleEnd: false,
          exposure: exposure.checkpoint,
        },
      };
    }
    // Exposure COMPLETE (possibly an empty set): the agency set is now
    // FROZEN for the whole opportunity walk of this cycle, so a late
    // agency's lower-id opportunity is never skipped.
    if (exposure.agencies.length === 0) {
      return {
        observations: [],
        page: { ...emptyPage(true), exposure: exposure.checkpoint },
      };
    }
    // Fence captured ONLY now — scoped to the FROZEN agency set, never all
    // non-null agencies — and reused (stored in the scan) by every later
    // opportunity page of this cycle.
    const samFence =
      scan.cursorId != null && scan.fenceId != null
        ? scan.fenceId
        : ((
            await projections.samOpportunity.findMany({
              where: { agency: { in: exposure.agencies } },
              orderBy: { id: 'desc' },
              take: 1,
              select: { id: true },
            })
          )[0]?.id ?? null);
    const samRange: Record<string, unknown> = {};
    if (after != null) samRange.gt = after;
    if (samFence != null) samRange.lte = samFence;
    const samKeyset = Object.keys(samRange).length > 0 ? { id: samRange } : {};
    const rows = await projections.samOpportunity.findMany({
      where: { agency: { in: exposure.agencies }, ...samKeyset },
      orderBy: { id: 'asc' },
      take: maxRecords + 1,
      select: { ...opportunitySelect, id: true },
    });
    return pageFromRows(rows, (r) => opportunityObservation(r), exposure.checkpoint, samFence);
  }
  if (family === 'tango_resource') {
    if (!anchor.uei) return { observations: [], page: emptyPage(true) };
    const rows = await projections.tangoResourceSnapshot.findMany({
      where: { resourceType: 'entity', externalId: anchor.uei, active: true, ...keyset },
      orderBy: { id: 'asc' },
      take: maxRecords + 1,
      select: { ...tangoSelect, id: true },
    });
    return pageFromRows(rows, (r) => tangoObservation(r), null);
  }
  // lda_filing — RAW candidate rows paginated by their stable key
  // (immutable id), exact-normalize-FILTERED per page. This replaces the old
  // 4x candidate-cap dead end: a page with ZERO exact matches still
  // advances the traversal, so an exact match far behind many non-matches is
  // eventually seen.
  if (anchor.exactNames.length === 0) return { observations: [], page: emptyPage(true) };
  const names = anchor.exactNames;
  const candidateRows = await projections.ldaFiling.findMany({
    where: {
      OR: names.flatMap((n) => [{ clientName: { contains: n, mode: 'insensitive' as const } }]),
      ...keyset,
    },
    orderBy: { id: 'asc' },
    take: maxRecords + 1,
    select: { ...ldaSelect, id: true },
  });
  const result = pageFromRows(candidateRows, (r) => ldaObservation(r), null);
  // Exact-normalize post-filter AFTER page slicing: contains-only candidates
  // never become observations, but they still advance the traversal cursor.
  const exact = result.observations.filter((o) =>
    names.some(
      (n) =>
        normalizeCompanyName((o.material['clientName'] as string) ?? '') ===
        normalizeCompanyName(n),
    ),
  );
  return { observations: exact, page: result.page };
}

/**
 * Capture the INCLUSIVE cycle fence: the current max row id for the identity
 * scope. Null only when the scope has no rows at all (the walk trivially
 * completes).
 */
async function cycleFence(
  projections: BizDevProjectionDb,
  family: Exclude<BizDevWatchSourceFamilyName, 'acquisition_revision' | 'sam_opportunity'>,
  anchor: BizDevWatchIdentityAnchor,
): Promise<string | null> {
  if (family === 'federal_award') {
    if (!anchor.uei) return null;
    const rows = await projections.federalAward.findMany({
      where: { recipientUei: anchor.uei },
      orderBy: { id: 'desc' },
      take: 1,
      select: { id: true },
    });
    return rows[0]?.id ?? null;
  }
  if (family === 'federal_assistance_award') {
    if (!anchor.uei) return null;
    const rows = await projections.federalAssistanceAward.findMany({
      where: { recipientUei: anchor.uei },
      orderBy: { id: 'desc' },
      take: 1,
      select: { id: true },
    });
    return rows[0]?.id ?? null;
  }

  if (family === 'tango_resource') {
    if (!anchor.uei) return null;
    const rows = await projections.tangoResourceSnapshot.findMany({
      where: { resourceType: 'entity', externalId: anchor.uei, active: true },
      orderBy: { id: 'desc' },
      take: 1,
      select: { id: true },
    });
    return rows[0]?.id ?? null;
  }
  // lda_filing
  if (anchor.exactNames.length === 0) return null;
  const rows = await projections.ldaFiling.findMany({
    where: {
      OR: anchor.exactNames.flatMap((n) => [
        { clientName: { contains: n, mode: 'insensitive' as const } },
      ]),
    },
    orderBy: { id: 'desc' },
    take: 1,
    select: { id: true },
  });
  return rows[0]?.id ?? null;
}

/**
 * SAM agency-exposure set for one UEI: a bounded distinct-agency walk of the
 * UEI's awards by the SAME ascending immutable-id keyset (bounded page, +1
 * probe). Progress is carried inside the scan checkpoint so the walk resumes
 * across runs and restarts each cycle. An agency appearing only in award
 * #101+ is discovered — the hardcoded newest-100 hole is closed. The walk
 * reads only bounded pages; the accumulated agency set stays staged until
 * exposure completes, then is frozen for the opportunity traversal.
 */
async function samExposureAgencies(
  projections: BizDevProjectionDb,
  anchor: BizDevWatchIdentityAnchor,
  maxRecords: number,
  scan: BizDevWatchScanCheckpoint,
): Promise<{
  agencies: string[];
  complete: boolean;
  checkpoint: BizDevWatchScanExposureCheckpoint | null;
}> {
  if (!anchor.uei) return { agencies: [], complete: true, checkpoint: null };
  const prior = scan.exposure;
  // A COMPLETE exposure walk is reused verbatim — no further award reads
  // for the rest of the cycle. The agency set stays FROZEN for the whole
  // opportunity walk, so a late agency's lower-id opportunity is never
  // skipped by a re-walk that shifts the set mid-cycle.
  if (prior?.complete === true) {
    return { agencies: prior.agencies, complete: true, checkpoint: prior };
  }
  const pageSize = maxRecords; // configured bound, not a hardcoded 50
  const exposureCursor = prior?.cursorId ?? null;
  // The exposure walk lives in the FederalAward id space — its fence is the
  // max FederalAward id for this UEI, captured once at exposure-walk start
  // and reused across runs of the cycle (distinct from the SAM-opportunity
  // walk fence, which lives in the SamOpportunity id space). The fence is
  // INCLUSIVE (id <= fenceId): an exclusive fence would skip the highest
  // award row forever.
  const exposureFence =
    prior?.fenceId ??
    (
      await projections.federalAward.findMany({
        where: { recipientUei: anchor.uei, awardingAgency: { not: null } },
        orderBy: { id: 'desc' },
        take: 1,
        select: { id: true },
      })
    )[0]?.id ??
    null;
  const idRange: Record<string, unknown> = {};
  if (exposureCursor != null) idRange.gt = exposureCursor;
  if (exposureFence != null) idRange.lte = exposureFence;
  const rows = await projections.federalAward.findMany({
    where: {
      recipientUei: anchor.uei,
      awardingAgency: { not: null },
      ...(Object.keys(idRange).length > 0 ? { id: idRange } : {}),
    },
    orderBy: { id: 'asc' },
    take: pageSize + 1,
    select: { id: true, awardingAgency: true },
  });
  const pageRows = rows.slice(0, pageSize);
  const agencies = Array.from(
    new Set<string>([
      ...(prior?.agencies ?? []),
      ...pageRows
        .map((r: { awardingAgency?: unknown }) => r.awardingAgency)
        .filter((a: unknown): a is string => typeof a === 'string' && a.length > 0),
    ]),
  );
  const complete = rows.length <= pageSize;
  return {
    agencies,
    complete,
    checkpoint: {
      cursorId: complete ? null : ((pageRows[pageRows.length - 1]?.id as string) ?? exposureCursor),
      fenceId: exposureFence,
      agencies,
      complete,
    },
  };
}

// ── Field selects (allowlisted material only; NO raw / lastSyncedAt) ─────────

const awardSelect = {
  awardUniqueId: true,
  piid: true,
  fain: true,
  awardingAgency: true,
  awardingSubTier: true,
  contractorName: true,
  recipientUei: true,
  amount: true,
  peCode: true,
  dodAcqProgramCode: true,
  fundingTas: true,
  programActivityCode: true,
  popState: true,
  popCongressionalDistrict: true,
  actionDate: true,
  awardedAt: true,
  baseAwardSignedDate: true,
  latestActionDate: true,
  popStartDate: true,
  popEndDate: true,
  description: true,
} as const;

const assistanceSelect = {
  awardUniqueId: true,
  fain: true,
  recipientName: true,
  recipientUei: true,
  awardingAgency: true,
  totalObligatedAmount: true,
  lastModifiedDate: true,
  startDate: true,
  endDate: true,
  description: true,
} as const;

const opportunitySelect = {
  noticeId: true,
  solicitationNumber: true,
  title: true,
  noticeType: true,
  baseType: true,
  agency: true,
  subAgency: true,
  office: true,
  setAside: true,
  setAsideCode: true,
  pscCode: true,
  naicsCode: true,
  postedDate: true,
  responseDeadline: true,
  archiveDate: true,
  active: true,
  sourceUrl: true,
} as const;

const tangoSelect = {
  id: true,
  resourceType: true,
  externalId: true,
  sourceUpdatedAt: true,
  sourceUrl: true,
  contentSha256: true,
  normalizedJsonb: true,
} as const;

const ldaSelect = {
  filingUuid: true,
  filingType: true,
  filingYear: true,
  filingPeriod: true,
  income: true,
  expenses: true,
  dtPosted: true,
  registrantId: true,
  registrantName: true,
  clientId: true,
  clientName: true,
  clientState: true,
  issueCodes: true,
  filingDocumentUrl: true,
} as const;

// ── Observation builders (identityConfidence honest per family) ─────────────

type AwardRow = Record<string, unknown>;
type AssistanceRow = Record<string, unknown>;
type OpportunityRow = Record<string, unknown>;
type TangoRow = Record<string, unknown>;
type LdaRow = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | string | null =>
  v == null ? null : typeof v === 'number' ? v : String(v);
const dateIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null;

function federalAwardObservation(r: AwardRow): BizDevSourceObservation {
  return {
    sourceFamily: 'federal_award',
    recordId: str(r.awardUniqueId) ?? '',
    sourceLocator: `https://www.usaspending.gov/award/${str(r.awardUniqueId) ?? ''}`,
    identityConfidence: 1, // exact-UEI recipient
    publishedAt: dateIso(r.awardedAt),
    effectiveAt: dateIso(r.actionDate),
    eventAt: dateIso(r.actionDate),
    material: compact({
      awardUniqueId: r.awardUniqueId,
      piid: r.piid,
      fain: r.fain,
      awardingAgency: r.awardingAgency,
      awardingSubTier: r.awardingSubTier,
      contractorName: r.contractorName,
      recipientUei: r.recipientUei,
      amount: num(r.amount),
      peCode: r.peCode,
      dodAcqProgramCode: r.dodAcqProgramCode,
      fundingTas: r.fundingTas,
      programActivityCode: r.programActivityCode,
      popState: r.popState,
      popCongressionalDistrict: r.popCongressionalDistrict,
      actionDate: dateIso(r.actionDate),
      awardedAt: dateIso(r.awardedAt),
      baseAwardSignedDate: dateIso(r.baseAwardSignedDate),
      latestActionDate: dateIso(r.latestActionDate),
      popStartDate: dateIso(r.popStartDate),
      popEndDate: dateIso(r.popEndDate),
      description: r.description,
    }),
  };
}

function assistanceObservation(r: AssistanceRow): BizDevSourceObservation {
  return {
    sourceFamily: 'federal_assistance_award',
    recordId: str(r.awardUniqueId) ?? '',
    sourceLocator: `https://www.usaspending.gov/award/${str(r.awardUniqueId) ?? ''}`,
    identityConfidence: 1, // exact-UEI recipient
    publishedAt: dateIso(r.lastModifiedDate),
    effectiveAt: dateIso(r.lastModifiedDate),
    eventAt: dateIso(r.lastModifiedDate),
    material: compact({
      assistanceId: r.awardUniqueId,
      recipientName: r.recipientName,
      recipientUei: r.recipientUei,
      awardingAgency: r.awardingAgency,
      amount: num(r.totalObligatedAmount),
      actionDate: dateIso(r.lastModifiedDate),
      startDate: dateIso(r.startDate),
      endDate: dateIso(r.endDate),
      description: r.description,
    }),
  };
}

function opportunityObservation(r: OpportunityRow): BizDevSourceObservation {
  return {
    sourceFamily: 'sam_opportunity',
    recordId: str(r.noticeId) ?? '',
    sourceLocator: `https://sam.gov/opp/${str(r.noticeId) ?? ''}/view`,
    // THEMATIC/CONDITIONAL agency-exposure link — deliberately NOT 1: the
    // notice's agency matches the company's exact-UEI award exposure. This
    // never asserts the prospect will bid or win; the alert wording stays
    // conditional (the diff's implication text is inference, labeled so).
    identityConfidence: 0.7,
    publishedAt: dateIso(r.postedDate),
    effectiveAt: dateIso(r.postedDate),
    eventAt: dateIso(r.postedDate),
    material: compact({
      noticeId: r.noticeId,
      solicitationNumber: r.solicitationNumber,
      title: r.title,
      noticeType: r.noticeType,
      baseType: r.baseType,
      agency: r.agency,
      subAgency: r.subAgency,
      office: r.office,
      setAside: r.setAside,
      setAsideCode: r.setAsideCode,
      pscCode: r.pscCode,
      naicsCode: r.naicsCode,
      postedDate: dateIso(r.postedDate),
      responseDeadline: dateIso(r.responseDeadline),
      archiveDate: dateIso(r.archiveDate),
      active: r.active,
      sourceUrl: r.sourceUrl,
    }),
  };
}

function tangoObservation(r: TangoRow): BizDevSourceObservation {
  const normalized = (r.normalizedJsonb ?? {}) as Record<string, unknown>;
  const externalId = str(r.externalId);
  return {
    sourceFamily: 'tango_resource',
    recordId: externalId ? `${str(r.resourceType) ?? 'entity'}:${externalId}` : '',
    sourceLocator: str(r.sourceUrl) ?? str(normalized.sam_url) ?? '',
    // Tango entity externalId IS the UEI (exact).
    identityConfidence: 1,
    sourceRevision: str(r.contentSha256),
    publishedAt: dateIso(r.sourceUpdatedAt),
    effectiveAt: dateIso(r.sourceUpdatedAt),
    eventAt: dateIso(r.sourceUpdatedAt),
    material: compact({
      resourceType: r.resourceType,
      externalId: r.externalId,
      title: normalized.title ?? normalized.legalBusinessName,
      name: normalized.legalBusinessName,
      status: normalized.status,
      sourceUpdatedAt: dateIso(r.sourceUpdatedAt),
      sourceUrl: r.sourceUrl,
    }),
  };
}

function ldaObservation(r: LdaRow): BizDevSourceObservation {
  return {
    sourceFamily: 'lda_filing',
    recordId: str(r.filingUuid) ?? '',
    sourceLocator:
      str(r.filingDocumentUrl) ?? `https://lda.senate.gov/system/lod/${str(r.filingUuid) ?? ''}`,
    // Exact normalized canonical/alias NAME match — conditional, never exact.
    identityConfidence: 0.7,
    publishedAt: dateIso(r.dtPosted),
    effectiveAt: dateIso(r.dtPosted),
    eventAt: dateIso(r.dtPosted),
    material: compact({
      filingUuid: r.filingUuid,
      filingType: r.filingType,
      filingYear: r.filingYear,
      filingPeriod: r.filingPeriod,
      income: num(r.income),
      expenses: num(r.expenses),
      dtPosted: dateIso(r.dtPosted),
      registrantId: r.registrantId,
      registrantName: r.registrantName,
      clientId: r.clientId,
      clientName: r.clientName,
      clientState: r.clientState,
      issueCodes: r.issueCodes,
      filingDocumentUrl: r.filingDocumentUrl,
    }),
  };
}

/** Drop null/undefined values from a material map. */
function compact(
  map: Record<string, unknown>,
): Record<string, BizDevSourceObservation['material'][string]> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out as Record<string, BizDevSourceObservation['material'][string]>;
}
