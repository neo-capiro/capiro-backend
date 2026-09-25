import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Prisma as PrismaTag } from '@prisma/client';
import { normalizeCompanyName } from '../vendor-reference/vendor-name.util.js';
import type {
  BizDevSourceObservation,
  BizDevWatchBaseline,
  BizDevAlertDraft,
  BizDevSuppressionReasonCode,
  BizDevWatchDiffResult,
} from './bizdev-watch.types.js';
import { diffObservationAgainstBaseline as diffFn } from './bizdev-watch-diff.js';

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
 *   4. read bounded source rows from the EXISTING projection; an incomplete
 *      (over-bound) or errored read marks the state partial/error, sets
 *      lastAttemptAt/lastError/consecutiveFailures, does NOT advance the
 *      baseline/watermark, inserts/delivers NOTHING, and never blocks other
 *      families;
 *   5. only a COMPLETE, error-free, review-free read participates in ONE
 *      per-source transaction: conflict-safe alert insert (createMany
 *      skipDuplicates + exact unique re-lookup so a duplicate replay does NOT
 *      abort the transaction and never double-delivers), and only a NEWLY
 *      inserted alert gets its delivery + alert-created activity; then
 *      baseline update, advance lastSuccessfulCompleteCheckAt / health /
 *      watermark, release the lease. A partial or error outcome NEVER
 *      advances the complete baseline/watermark.
 *   6. EVERY finalize/release write predicates on tenantId + id +
 *      leaseToken=claimToken (checked updateMany) so an expired task can
 *      never clear or overwrite a newer worker's lease.
 *   7. LDA reads use the existing normalized-company-name path: a bounded
 *      candidate read on contains-matches then an EXACT
 *      normalizeCompanyName post-filter (the dossier's lobbyingSection
 *      pattern). Contains-only/fuzzy candidates never become observations;
 *      an exact result over-bound means partial.
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
  /** Max records read per watch per family. */
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
  if (config.maxWatchesPerRun < 1 || config.maxWatchesPerRun > 500) {
    throw new Error('BIZDEV_WATCH_MAX_PER_RUN must be an integer between 1 and 500');
  }
  if (config.maxRecordsPerSource < 1 || config.maxRecordsPerSource > 500) {
    throw new Error('BIZDEV_WATCH_MAX_RECORDS_PER_SOURCE must be an integer between 1 and 500');
  }
  if (config.leaseSeconds < 30 || config.leaseSeconds > 3600) {
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
  const exactNames = [entity.canonicalName, ...entity.aliases.map((a) => a.alias)]
    .filter((n): n is string => Boolean(n) && n.length > 0);
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
      .then((rows) => rows ?? []),
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
  const candidateStates = await discoverClaimCandidates(
    db,
    families,
    config.maxWatchesPerRun * 2,
  );

  const claimed: BizDevWatchClaimCandidate[] = [];

  for (const state of candidateStates) {
    if (claimed.length >= config.maxWatchesPerRun) break;
    // Transactional lease claim (per tenant, withTenant): only an
    // unclaimed/expired row flips to our token; a concurrent worker's claim
    // makes this update match zero rows.
    const ok = await db.withTenant(state.tenantId, (tx) =>
      tx
        .$executeRaw`UPDATE "business_development_watch_source_states"
          SET "lease_token" = ${claimToken}, "lease_until" = ${leaseUntil},
              "last_attempt_at" = ${now}, "updated_at" = ${now}
          WHERE "id" = ${state.id}::uuid
            AND "tenant_id" = ${state.tenantId}::uuid
            AND ("lease_until" IS NULL OR "lease_until" <= now())`
        .then((n: number) => n === 1),
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
        if (!anchor.resolved) {
          // Unresolved/ambiguous identity stays pending: no baseline, no
          // alert — never a confident alert on a weak identity. A zero-count
          // finalize means the lease was lost: skipped, NOT a pending result.
          const n = await finalizeState({
            health: 'pending',
            lastError:
              'Identity not resolved yet — waiting for a confirmed canonical organization with an exact identifier',
            leaseToken: null,
            leaseUntil: null,
          });
          if (n === 0) return 'skipped' as const;
          return 'pending' as const;
        }

        // ── Read bounded source rows from the EXISTING projection ───────
        let observations: BizDevSourceObservation[];
        let complete: boolean;
        try {
          const read = await readFamilyObservations(
            projections,
            state.sourceFamily as Exclude<BizDevWatchSourceFamilyName, 'acquisition_revision'>,
            anchor,
            config.maxRecordsPerSource,
          );
          observations = read.observations;
          complete = read.complete;
        } catch (readError) {
          // Source read error: mark error, do NOT advance baseline/watermark,
          // deliver nothing. A zero-count finalize means the lease was lost
          // before the release: skipped, NOT an error result.
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

        if (!complete) {
          // Over-bound read: partial. Insert/deliver NOTHING (a partial read
          // must not produce misleading or repeating deliveries) and preserve
          // the prior baseline/watermark. A zero-count finalize means the
          // lease was lost before the release: skipped, NOT a partial result.
          const n = await finalizeState({
            health: 'partial',
            lastError: `Source read exceeded the complete bound (${config.maxRecordsPerSource} records) — rerun with a higher bound before advancing the baseline`,
            leaseToken: null,
            leaseUntil: null,
          });
          if (n === 0) return 'skipped' as const;
          metrics.partial += 1;
          return 'partial' as const;
        }

        // ── Diff against the baseline (complete read only) ────────────────
        const baseline = (stateRow.baselineState as unknown as BizDevWatchBaseline | null) ?? null;
        const established = baseline?.initialized === true;

        // Suppression (clock-injected for testability): paused watch, muted
        // now, conflict-excluded prospect, dismissed prospect. Baseline still
        // refreshes (a later resume cannot emit accumulated changes); the
        // delivery is suppressed with a persisted safe reason.
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

        const records: Record<string, unknown> = {};
        const drafts: BizDevAlertDraft[] = [];
        let review = false;
        // Per-state BUFFERED commit-dependent counters: applied to the run
        // metrics ONLY after the checked finalization proves this worker
        // still owns the lease (finalized === 1). If finalization matches
        // zero rows the transaction throws and rolls back — the run metrics
        // must never claim rolled-back work.
        let suppressedDelta = 0;
        let diffFailures = 0;
        for (const observation of observations) {
          metrics.candidates += 1;
          let result: BizDevWatchDiffResult;
          try {
            result = diffFn(observation, baseline);
          } catch {
            diffFailures += 1;
            review = true;
            continue;
          }
          if (result.outcome === 'review' || result.outcome === 'skip') {
            // Unresolved/ambiguous identity or an unusable observation: never
            // a confident alert, and NEVER a trusted baseline fact — the
            // whole pass is partial and inserts/delivers nothing.
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

        // A review/skip anywhere makes the pass PARTIAL: no baseline advance,
        // no alert insert, no delivery — only this lease is released. A
        // zero-count finalize means the lease was lost before the release:
        // skipped, NOT a partial result.
        if (review) {
          const n = await finalizeState({
            health: 'partial',
            lastError:
              'Diff returned review/skip for at least one observation — no baseline advance, no alert',
            leaseToken: null,
            leaseUntil: null,
          });
          if (n === 0) return 'skipped' as const;
          metrics.partial += 1;
          metrics.failed += diffFailures;
          return 'partial' as const;
        }

        const baselinedDelta = established ? 0 : 1;

        // ── ONE per-source transaction ────────────────────────────────────
        // Alerts + deliveries + activity + baseline + health + lease release
        // commit together; any failure rolls back ALL of them.
        const newBaseline: BizDevWatchBaseline = {
          initialized: true,
          establishedAt: baseline?.establishedAt ?? clock().toISOString(),
          effectiveFloorAt: baseline?.effectiveFloorAt ?? null,
          records: { ...(baseline?.records ?? {}), ...records } as BizDevWatchBaseline['records'],
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
                  beforeState: (draft.beforeState ?? undefined) as Prisma.InputJsonValue | undefined,
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
              // replay still finalizes the baseline successfully — no
              // duplicate delivery, no duplicate activity.
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

        // Healthy finalize: the alert/delivery/activity inserts above are
        // part of THIS tenant transaction. A ZERO-count finalize means final
        // ownership was lost — the healthy write CANNOT be attributed to this
        // worker, so THROW inside the transaction: ALL prior inserts
        // (alerts, deliveries, activities) roll back and nothing commits.
        const finalized = await finalizeState({
          baselineState: newBaseline as unknown as Prisma.InputJsonValue,
          baselinedAt: clock(),
          lastSuccessfulCompleteCheckAt: clock(),
          sourceWatermark: clock(),
          consecutiveFailures: 0,
          lastError: suppressionReason,
          health: 'healthy',
          leaseToken: null,
          leaseUntil: null,
        });
        if (finalized === 0) {
          throw new Error(
            'Lost the source-state lease before healthy finalization — rolling back all alert/delivery/activity inserts',
          );
        }
        // Committed: only NOW do the run metrics claim the work (a rolled-
        // back transaction must never be reported as delivered/baselined).
        metrics.baselined += baselinedDelta;
        metrics.delivered += delivered;
        metrics.duplicates += duplicates;
        metrics.suppressed += suppressedDelta;
        return 'healthy' as const;
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
 * Read bounded observations for ONE family from the EXISTING projections.
 * Identity linkage is EXACT (exact UEI or exact normalized canonical/alias
 * name); `complete=false` when the bound was hit (partial, no baseline
 * advance, no delivery).
 */
async function readFamilyObservations(
  projections: BizDevProjectionDb,
  family: Exclude<BizDevWatchSourceFamilyName, 'acquisition_revision'>,
  anchor: BizDevWatchIdentityAnchor,
  maxRecords: number,
): Promise<{ observations: BizDevSourceObservation[]; complete: boolean }> {
  const hasUei = anchor.uei != null;
  const names = anchor.exactNames;

  if (family === 'federal_award') {
    if (!hasUei) return { observations: [], complete: true };
    const rows = await projections.federalAward.findMany({
      where: { recipientUei: anchor.uei! },
      orderBy: { actionDate: 'desc' },
      take: maxRecords + 1,
      select: awardSelect,
    });
    return {
      observations: rows.slice(0, maxRecords).map((r) => federalAwardObservation(r)),
      complete: rows.length <= maxRecords,
    };
  }
  if (family === 'federal_assistance_award') {
    if (!hasUei) return { observations: [], complete: true };
    const rows = await projections.federalAssistanceAward.findMany({
      where: { recipientUei: anchor.uei! },
      orderBy: { lastModifiedDate: 'desc' },
      take: maxRecords + 1,
      select: assistanceSelect,
    });
    return {
      observations: rows.slice(0, maxRecords).map((r) => assistanceObservation(r)),
      complete: rows.length <= maxRecords,
    };
  }
  if (family === 'sam_opportunity') {
    // SAM opportunities use the EXISTING narrow agency-exposure relationship:
    // only agencies the company's exact-UEI awards already expose. The link
    // is THEMATIC/CONDITIONAL — an exposed-agency opportunity never asserts
    // the prospect will bid or win, and identityConfidence is deliberately
    // NOT 1: the record's agency matches the exposure set, nothing more.
    if (!hasUei) return { observations: [], complete: true };
    const exposure = await projections.federalAward.findMany({
      where: { recipientUei: anchor.uei!, awardingAgency: { not: null } },
      orderBy: { actionDate: 'desc' },
      take: 100,
      select: { awardingAgency: true },
    });
    const agencies = Array.from(
      new Set(exposure.map((r) => r.awardingAgency).filter((a): a is string => !!a)),
    );
    if (agencies.length === 0) return { observations: [], complete: true };
    const rows = await projections.samOpportunity.findMany({
      where: { agency: { in: agencies } },
      orderBy: { postedDate: 'desc' },
      take: maxRecords + 1,
      select: opportunitySelect,
    });
    return {
      observations: rows.slice(0, maxRecords).map((r) => opportunityObservation(r)),
      complete: rows.length <= maxRecords,
    };
  }
  if (family === 'tango_resource') {
    if (!hasUei) return { observations: [], complete: true };
    const rows = await projections.tangoResourceSnapshot.findMany({
      where: { resourceType: 'entity', externalId: anchor.uei!, active: true },
      orderBy: { version: 'desc' },
      take: maxRecords + 1,
      select: tangoSelect,
    });
    return {
      observations: rows.slice(0, maxRecords).map((r) => tangoObservation(r)),
      complete: rows.length <= maxRecords,
    };
  }
  // lda_filing — the dossier's bounded candidate-read + exact-normalized
  // post-filter pattern. A bounded CONTAINS candidate read over the RAW
  // canonical/alias names (raw-with-punctuation rows can never contain a
  // stripped normalized string), then normalizeCompanyName post-filters to
  // EXACT matches on BOTH sides. A contains-only/fuzzy candidate NEVER
  // becomes an observation. Completeness is honest: if the CANDIDATE window
  // itself saturates its cap, exact rows may exist beyond it — the read is
  // partial. An exact result set exceeding maxRecords is also partial.
  if (names.length === 0) return { observations: [], complete: true };
  const candidateCap = maxRecords * 4;
  const candidateRows = await projections.ldaFiling.findMany({
    where: {
      OR: names.flatMap((n) => [
        { clientName: { equals: n, mode: 'insensitive' as const } },
        { clientName: { contains: n, mode: 'insensitive' as const } },
      ]),
    },
    orderBy: { dtPosted: 'desc' },
    take: candidateCap + 1,
    select: ldaSelect,
  });
  if (candidateRows.length > candidateCap) {
    // Candidate window saturated: exact matches may exist beyond it — this
    // is NOT a complete read. Partial, no baseline advance, no delivery.
    return { observations: [], complete: false };
  }
  const exact = candidateRows.filter((r) =>
    names.some((n) => normalizeCompanyName(r.clientName ?? '') === normalizeCompanyName(n)),
  );
  if (exact.length > maxRecords) {
    return { observations: [], complete: false };
  }
  return {
    observations: exact.map((r) => ldaObservation(r)),
    complete: true,
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

type AwardRow = { [K in keyof typeof awardSelect]: unknown };
type AssistanceRow = { [K in keyof typeof assistanceSelect]: unknown };
type OpportunityRow = { [K in keyof typeof opportunitySelect]: unknown };
type TangoRow = { [K in keyof typeof tangoSelect]: unknown };
type LdaRow = { [K in keyof typeof ldaSelect]: unknown };

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
