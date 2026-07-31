/**
 * PE trust diagnostics — pure fail-closed evaluation (Phase K / closeout Phase 8).
 *
 * The live SELECT-only CLI (`diag-program-element-trust-baseline.ts`) gathers facts.
 * This module decides whether those facts are PUBLICLY healthy. When any blocker is
 * present, evaluatePeTrustDiagnostics().ok === false so CI / ops can fail closed.
 *
 * Conditions covered (plan Phase 8):
 *   late sources, null source-document observations, duplicate observations,
 *   stale reconciliation, old/pending outbox, partial SAM runs, stale cache,
 *   coverage gaps.
 */
export type PeTrustSeverity = 'blocker' | 'warning';

export interface PeTrustFinding {
  code: string;
  severity: PeTrustSeverity;
  message: string;
  count?: number;
}

export interface PeTrustDiagnosticInput {
  /** Source last-seen age in seconds, keyed by source id. */
  sourceAgeSeconds?: Record<string, number | null | undefined>;
  /** Max age before a fixed PE source is "late". Default 7d. */
  lateSourceThresholdSeconds?: number;
  sourcesRequiredFresh?: readonly string[];

  observationsWithoutSourceDocument?: number;
  duplicateObservationGroups?: number;
  /** Open / pending reconciliation items. */
  openReconciliationCount?: number;
  /** Age of oldest open reconciliation in seconds. */
  oldestOpenReconciliationAgeSeconds?: number | null;
  staleReconciliationThresholdSeconds?: number;

  pendingOutboxCount?: number;
  oldestPendingOutboxAgeSeconds?: number | null;
  oldOutboxThresholdSeconds?: number;

  /** SAM complete-window / partial-run flags. */
  samPartialRunCount?: number;
  samIncompleteWindowCount?: number;

  /** Stale PE-related cache entries (derive / intel cache). */
  staleCacheEntryCount?: number;

  /**
   * Coverage gap count from honest coverage matrix / panel working set.
   * Gaps are warnings by default unless forceCoverageGapsBlocker.
   */
  coverageGapCount?: number;
  forceCoverageGapsBlocker?: boolean;
}

export interface PeTrustDiagnosticResult {
  ok: boolean;
  blockers: PeTrustFinding[];
  warnings: PeTrustFinding[];
  findings: PeTrustFinding[];
}

const DAY = 86_400;

const DEFAULTS = {
  lateSourceThresholdSeconds: 7 * DAY,
  staleReconciliationThresholdSeconds: 2 * DAY,
  oldOutboxThresholdSeconds: DAY,
  sourcesRequiredFresh: [
    'pe-derive-chain',
    'sync-sam-opportunities',
    'send-pe-alert-emails',
  ] as const,
};

function push(
  list: PeTrustFinding[],
  finding: PeTrustFinding,
): void {
  list.push(finding);
}

/**
 * Evaluate PE trust health. Pure; no I/O.
 * `ok` is false when any blocker exists — warnings alone do not fail the gate.
 */
export function evaluatePeTrustDiagnostics(
  input: PeTrustDiagnosticInput,
): PeTrustDiagnosticResult {
  const blockers: PeTrustFinding[] = [];
  const warnings: PeTrustFinding[] = [];

  const lateThreshold =
    input.lateSourceThresholdSeconds ?? DEFAULTS.lateSourceThresholdSeconds;
  const required = input.sourcesRequiredFresh ?? DEFAULTS.sourcesRequiredFresh;
  const ages = input.sourceAgeSeconds ?? {};

  for (const source of required) {
    const age = ages[source];
    if (age === null || age === undefined) {
      push(blockers, {
        code: 'late_source_unobserved',
        severity: 'blocker',
        message: `Required PE source "${source}" has never been observed (UNOBSERVED).`,
        count: 1,
      });
    } else if (age > lateThreshold) {
      push(blockers, {
        code: 'late_source',
        severity: 'blocker',
        message: `Required PE source "${source}" is late (ageSeconds=${age} > ${lateThreshold}).`,
        count: 1,
      });
    }
  }

  const nullObs = input.observationsWithoutSourceDocument ?? 0;
  if (nullObs > 0) {
    push(blockers, {
      code: 'null_source_document_observation',
      severity: 'blocker',
      message: `${nullObs} observation(s) lack a source document id.`,
      count: nullObs,
    });
  }

  const dup = input.duplicateObservationGroups ?? 0;
  if (dup > 0) {
    push(blockers, {
      code: 'duplicate_observations',
      severity: 'blocker',
      message: `${dup} duplicate observation group(s) detected.`,
      count: dup,
    });
  }

  const openRec = input.openReconciliationCount ?? 0;
  const recAge = input.oldestOpenReconciliationAgeSeconds;
  const recThreshold =
    input.staleReconciliationThresholdSeconds ??
    DEFAULTS.staleReconciliationThresholdSeconds;
  if (openRec > 0 && recAge !== null && recAge !== undefined && recAge > recThreshold) {
    push(blockers, {
      code: 'stale_reconciliation',
      severity: 'blocker',
      message: `${openRec} open reconciliation item(s); oldest ageSeconds=${recAge} exceeds ${recThreshold}.`,
      count: openRec,
    });
  } else if (openRec > 0) {
    push(warnings, {
      code: 'open_reconciliation',
      severity: 'warning',
      message: `${openRec} open reconciliation item(s) (not yet past stale threshold).`,
      count: openRec,
    });
  }

  const pendingOutbox = input.pendingOutboxCount ?? 0;
  const outboxAge = input.oldestPendingOutboxAgeSeconds;
  const outboxThreshold =
    input.oldOutboxThresholdSeconds ?? DEFAULTS.oldOutboxThresholdSeconds;
  if (pendingOutbox > 0) {
    if (
      outboxAge !== null &&
      outboxAge !== undefined &&
      outboxAge > outboxThreshold
    ) {
      push(blockers, {
        code: 'old_pending_outbox',
        severity: 'blocker',
        message: `${pendingOutbox} pending outbox row(s); oldest ageSeconds=${outboxAge} exceeds ${outboxThreshold}.`,
        count: pendingOutbox,
      });
    } else {
      push(warnings, {
        code: 'pending_outbox',
        severity: 'warning',
        message: `${pendingOutbox} pending outbox row(s).`,
        count: pendingOutbox,
      });
    }
  }

  const samPartial = (input.samPartialRunCount ?? 0) + (input.samIncompleteWindowCount ?? 0);
  if (samPartial > 0) {
    push(blockers, {
      code: 'partial_sam_run',
      severity: 'blocker',
      message: `${samPartial} partial/incomplete SAM run or window flag(s).`,
      count: samPartial,
    });
  }

  const staleCache = input.staleCacheEntryCount ?? 0;
  if (staleCache > 0) {
    push(blockers, {
      code: 'stale_cache',
      severity: 'blocker',
      message: `${staleCache} stale PE cache entr${staleCache === 1 ? 'y' : 'ies'}.`,
      count: staleCache,
    });
  }

  const gaps = input.coverageGapCount ?? 0;
  if (gaps > 0) {
    const sev: PeTrustSeverity = input.forceCoverageGapsBlocker ? 'blocker' : 'warning';
    push(sev === 'blocker' ? blockers : warnings, {
      code: 'coverage_gap',
      severity: sev,
      message: `${gaps} coverage gap(s) reported by the honest coverage matrix.`,
      count: gaps,
    });
  }

  const findings = [...blockers, ...warnings];
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    findings,
  };
}
