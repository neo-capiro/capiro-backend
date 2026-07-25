/*
 * P0-2 reconciliation RULES. PURE module (no Nest/Prisma) so every detection is
 * unit-testable against plain row shapes — run-recovery.spec.ts.
 *
 * The audit's required reconciliation job must "detect and repair":
 *   1. runs inactive beyond a threshold           -> STRANDED_NO_HEARTBEAT   (repairable)
 *   2. reservation without artifact               -> RESERVATION_WITHOUT_ARTIFACT (human)
 *   3. artifact without node back-link            -> same as (2): in this schema the
 *                                                    back-link row IS the artifact
 *                                                    record, so a missing link shows
 *                                                    up as a surviving reservation
 *   4. artifact created but run not completed     -> ARTIFACT_NOT_ADVANCED    (repairable)
 *   5. run completed with missing artifact        -> COMPLETED_WITHOUT_ARTIFACT (human)
 *   6. duplicate external references              -> DUPLICATE_ARTIFACT_REF   (human; detected
 *                                                    by a cross-run query in the service,
 *                                                    not per-run here)
 *   7. target deleted after staging               -> TARGET_MISSING           (human)
 *   8. version drift after approval               -> VERSION_DRIFT            (repairable: park)
 * plus, from the P0-1 interaction:
 *      the run's step was archived by a restore   -> NODE_NOT_LIVE            (repairable)
 *
 * HONEST LIMIT, stated here because it shapes the design: ExecutionArtifactClient
 * is CREATE-ONLY by explicit safety design ("the only two URLs it will ever
 * touch" are the two POSTs plus one PATCH). There is therefore NO way from this
 * service to ask Workspace or engagement "did a draft/record for run X get
 * created?". So case (2) — the genuinely stranded reservation — cannot be
 * auto-repaired without guessing, and guessing either duplicates an external
 * artifact or discards a real one. It is detected, surfaced, and given two
 * EXPLICIT operator resolutions instead (adopt a known ref / release the
 * reservation). Full automation needs a lookup endpoint in apps/api; that is
 * outside this phase.
 */

import { isPendingRef, isRealRef } from './artifact-ref.js';
import { RUN_STATE_POLICY, isStranded, type RunStateValue } from './run-state.js';

export const RECOVERY_CODES = [
  'STRANDED_NO_HEARTBEAT',
  'RESERVATION_WITHOUT_ARTIFACT',
  'ARTIFACT_NOT_ADVANCED',
  'COMPLETED_WITHOUT_ARTIFACT',
  'DUPLICATE_ARTIFACT_REF',
  'TARGET_MISSING',
  'VERSION_DRIFT',
  'NODE_NOT_LIVE',
] as const;
export type RecoveryCode = (typeof RECOVERY_CODES)[number];

/**
 * `auto` findings carry a repair the reconciler applies itself. `human` findings
 * are surfaced with explicit resolutions and never auto-applied — the reconciler
 * would have to guess about external state to fix them.
 */
export type RecoverySeverity = 'auto' | 'human';

/** The only repair shape the reconciler applies on its own: a state transition. */
export interface RecoveryTransition {
  to: RunStateValue;
  /** Goes into waitingReason/error so the user reads WHY, never a bare state. */
  reason: string;
}

export interface RecoveryFinding {
  code: RecoveryCode;
  severity: RecoverySeverity;
  /** Plain-words explanation for the user-facing surface. */
  detail: string;
  /** Present iff severity === 'auto'. */
  transition: RecoveryTransition | null;
  /** Operator resolutions for a `human` finding (labels the UI offers). */
  resolutions?: readonly string[];
}

/** One sp_node_artifact row as the rules need it. */
export interface RecoveryArtifactRow {
  artifactType: string;
  artifactRef: string;
  detachedAt: Date | string | null;
}

/** The run fields the rules read (a subset of SpAgentRun). */
export interface RecoveryRunRow {
  id: string;
  state: string;
  heartbeatAt: Date | string | null;
  startedAt: Date | string | null;
  createdAt: Date | string;
  reconcileAttempts: number;
}

export interface RecoveryInput {
  run: RecoveryRunRow;
  /** The execution intent parsed off run.findings.execution (null for a check run). */
  execution: { kind: string; nodeId: string; pinnedVersionId: string | null } | null;
  /** Whether run.findings carries an approval (findings.sendApproval). */
  hasApproval: boolean;
  /** sp_node_artifact rows for this run's node, both types. */
  artifacts: readonly RecoveryArtifactRow[];
  /** Live version head for the run's strategy; null when it cannot be resolved. */
  headVersionId: string | null;
  /** False when the node is gone or was archived by a P0-1 restore. */
  nodeLive: boolean;
  /** False when the node no longer carries a targetRef (proxy for a lost recipient). */
  nodeHasTarget: boolean;
  nowMs: number;
}

/** How many automatic reconcile passes a single run gets before escalating. */
export const MAX_RECONCILE_ATTEMPTS = 3;

function terminal(state: string): boolean {
  return !!(RUN_STATE_POLICY as Record<string, { terminal: boolean } | undefined>)[state]?.terminal;
}

/**
 * The artifact row for this run's kind, if any. kind -> artifactType is 1:1
 * (workspace -> workspace_draft, outreach -> outreach_record), matching
 * ExecutionService.ARTIFACT_TYPE_BY_KIND.
 */
function artifactForKind(
  artifacts: readonly RecoveryArtifactRow[],
  kind: string,
): RecoveryArtifactRow | null {
  const type = kind === 'outreach' ? 'outreach_record' : 'workspace_draft';
  return artifacts.find((a) => a.artifactType === type) ?? null;
}

/**
 * Classify one run. Returns every finding that applies, most actionable first;
 * the caller applies at most ONE auto transition per pass (the first), because
 * two repairs in one pass would race each other's state assumptions.
 */
export function detectRecovery(input: RecoveryInput): RecoveryFinding[] {
  const { run, execution, artifacts, nowMs } = input;
  const findings: RecoveryFinding[] = [];
  const isTerminal = terminal(run.state);
  const artifact = execution ? artifactForKind(artifacts, execution.kind) : null;
  const hasRealArtifact = isRealRef(artifact?.artifactRef);
  const hasReservation = isPendingRef(artifact?.artifactRef);

  // (P0-1 interaction) The step this run targets left the live plan. Nothing can
  // be executed against plan history, so a non-terminal run is dead — but its
  // record, and any artifact it staged, are preserved.
  if (!input.nodeLive && !isTerminal && execution) {
    findings.push({
      code: 'NODE_NOT_LIVE',
      severity: 'auto',
      detail:
        'The plan step this run targets is no longer in the live plan (deleted, or archived by a version restore). The run cannot continue.',
      transition: {
        to: 'failed_terminal',
        reason: 'the plan step this run targets is no longer in the live plan',
      },
    });
  }

  // (4) The artifact EXISTS and is linked, but the run never advanced to say so.
  // This is the "artifact created but run not completed" repair — and the reason
  // the audit wants reconciliation to "finish steps 3-5 after partial failure".
  if (
    hasRealArtifact &&
    !isTerminal &&
    input.nodeLive &&
    (run.state === 'executing' ||
      run.state === 'failed_recoverable' ||
      run.state === 'waiting_for_input')
  ) {
    findings.push({
      code: 'ARTIFACT_NOT_ADVANCED',
      severity: 'auto',
      detail: `The ${
        execution?.kind === 'outreach' ? 'Outreach record' : 'Workspace draft'
      } was created and linked to the step, but the run never recorded it. Nothing was sent.`,
      transition: {
        to: 'staged',
        reason: 'reconciliation found the created artifact already linked to the step',
      },
    });
  }

  // (1) Inactive beyond this state's timeout. Measured off heartbeatAt, falling
  // back to startedAt then createdAt so runs written before P0-2 (heartbeatAt
  // NULL) are still detectable — that is the whole population of already-stuck
  // runs.
  const lastSeen = run.heartbeatAt ?? run.startedAt ?? run.createdAt;
  if (isStranded(run.state, lastSeen, nowMs) && !hasRealArtifact) {
    const mins = RUN_STATE_POLICY[run.state as RunStateValue]?.timeoutMinutes;
    findings.push({
      code: 'STRANDED_NO_HEARTBEAT',
      severity: 'auto',
      detail: `No progress for over ${mins} minutes while ${run.state}. The agent worker is gone; the run is recoverable.`,
      transition: {
        to: 'failed_recoverable',
        reason: `no agent progress for over ${mins} minutes while ${run.state}`,
      },
    });
  }

  // (2)+(3) A surviving write-ahead reservation with no real ref. The external
  // artifact MAY exist upstream and MAY not; see this module's header for why
  // that cannot be resolved from here. Never auto-repaired.
  if (hasReservation) {
    findings.push({
      code: 'RESERVATION_WITHOUT_ARTIFACT',
      severity: 'human',
      detail:
        'Staging reserved its slot but never recorded a created artifact. A draft or record may or may not exist upstream, so this cannot be resolved automatically without risking either a duplicate or a lost document.',
      transition: null,
      resolutions: [
        'Check Workspace/Outreach for a document from this run, then adopt its id',
        'Confirm nothing was created and release the reservation so a retry can proceed',
      ],
    });
  }

  // (5) The run says it finished but there is no artifact to show for it.
  if ((run.state === 'completed' || run.state === 'staged') && !hasRealArtifact && execution) {
    findings.push({
      code: 'COMPLETED_WITHOUT_ARTIFACT',
      severity: 'human',
      detail:
        'The run is recorded as finished but no linked artifact exists. Its outcome cannot be verified from here.',
      transition: null,
      resolutions: ['Adopt the created artifact id if you can find it', 'Re-run the step'],
    });
  }

  // (7) Local proxy for "target deleted after staging": the node no longer
  // carries a target, so the recipient the payload was built for is unverifiable.
  if (execution?.kind === 'outreach' && !input.nodeHasTarget && !isTerminal && input.nodeLive) {
    findings.push({
      code: 'TARGET_MISSING',
      severity: 'human',
      detail:
        'This outreach run has no target on its step any more, so its recipient cannot be confirmed. Nothing was sent.',
      transition: null,
      resolutions: ['Re-select a target on the step, then retry', 'Cancel the run'],
    });
  }

  // (8) The plan moved after the payload was approved. Park rather than proceed —
  // P0-3 makes approval invalidation a first-class binding; this is the run-level
  // safety net for a run that is already past review.
  if (
    input.hasApproval &&
    execution?.pinnedVersionId != null &&
    input.headVersionId != null &&
    execution.pinnedVersionId !== input.headVersionId &&
    (run.state === 'approved' || run.state === 'executing' || run.state === 'ready_for_review')
  ) {
    findings.push({
      code: 'VERSION_DRIFT',
      severity: 'auto',
      detail:
        'The plan changed after this payload was approved, so the approval no longer describes the current plan.',
      transition: {
        to: 'waiting_for_input',
        reason: 'plan changed since approval — re-review before staging',
      },
    });
  }

  return findings;
}

/**
 * The ONE repair to apply this pass: the first auto finding, and only while the
 * run still has automatic attempts left. Past the cap a run stops being swept and
 * is left for a human — the audit's requirement that reconciliation not loop.
 */
export function repairFor(
  findings: readonly RecoveryFinding[],
  attempts: number,
): RecoveryFinding | null {
  if (attempts >= MAX_RECONCILE_ATTEMPTS) return null;
  return findings.find((f) => f.severity === 'auto' && f.transition) ?? null;
}

/** True when a run needs a human: findings exist but none can be auto-applied. */
export function needsHuman(findings: readonly RecoveryFinding[], attempts: number): boolean {
  if (findings.length === 0) return false;
  return repairFor(findings, attempts) === null;
}
