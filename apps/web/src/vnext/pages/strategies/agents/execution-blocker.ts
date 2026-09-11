/*
 * F10 (2026-09-10 remediation plan §8) — structured execution blocker.
 *
 * A small additive projection from a run's persisted findings (g0
 * eligibility reasons, verifierChainErrors, missingRequired, versionDrift,
 * openMaterialConflicts) to a stable code + readable primary message + the
 * KNOWN requirements + affected IDs + a repair target. The raw technical
 * reason is carried alongside for the collapsed Technical details section —
 * never as the main card copy.
 *
 * Design rules (plan §8):
 *  - ONE primary reason per run, then distinct requirements where necessary.
 *  - A known missing source is distinguished from an artifact-verification
 *    failure whose cause has NOT been identified: verification failure never
 *    invents a missing requirement.
 *  - Unrecognized legacy failures degrade to honest "needs attention" copy
 *    with only server-authorized recovery — never a fabricated diagnosis.
 *  - This is presentation-layer projection over EXISTING persisted findings;
 *    no new storage, no migration, no second gating logic. The server's run
 *    policy remains the sole authority for which actions are offered.
 */

/** Stable blocker codes (the wire contract; internal-only, never displayed raw). */
export type ExecutionBlockerCode =
  | 'owner_missing'
  | 'date_missing'
  | 'kind_subject_invalid'
  | 'required_source_missing'
  | 'material_conflict'
  | 'plan_version_changed'
  | 'verification_failed_unknown'
  | 'interactive_session'
  | 'strategy_unavailable'
  | 'other';

/** A distinct, known repair requirement (never invented from an unknown cause). */
export interface ExecutionRequirement {
  kind: string;
  label: string;
}

/** Where the repair action navigates. */
export type ExecutionRepairTarget =
  | 'open_step'
  | 'review_step'
  | 'add_context'
  | 'review_context'
  | 'inspect_findings'
  | 'session_recovery';

/** The wire projection attached to list/get run responses. */
export interface ExecutionBlocker {
  code: ExecutionBlockerCode;
  /** The one primary human message. */
  primary: string;
  /** Known, distinct requirements (empty when the cause is unknown). */
  requirements: ExecutionRequirement[];
  nodeId?: string | null;
  strategyId?: string | null;
  repair: ExecutionRepairTarget;
  /** Raw diagnostics for the collapsed Technical details section. */
  raw: {
    waitingReason?: string | null;
    error?: string | null;
    eligibilityReasons?: string[];
    verifierChainErrors?: string[];
    missingRequired?: string[];
  };
}

/** Known missing-context document types → their readable labels. */
const MISSING_SOURCE_LABELS: Record<string, string> = {
  strategy_brief: 'Strategy brief',
  client_constraints: 'Client constraints',
};

function sourceLabel(kind: string): string {
  return MISSING_SOURCE_LABELS[kind] ?? kind.replace(/_/g, ' ');
}

interface G0Findings {
  eligibility?: { eligible?: boolean; reasons?: unknown } | null;
  verifierChainErrors?: unknown;
  missingRequired?: unknown;
  versionDrift?: unknown;
  openMaterialConflicts?: unknown;
}

/** Narrow unknown findings.g0 to the shape this projection reads. */
function asG0(value: unknown): G0Findings | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as G0Findings;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];
}

/**
 * Project a run's persisted state into the structured blocker, or null when
 * nothing blocks. Pure: same findings → same blocker.
 */
export function projectExecutionBlocker(run: {
  state: string;
  waitingReason?: string | null;
  error?: string | null;
  findings?: unknown;
}): ExecutionBlocker | null {
  const findings =
    typeof run.findings === 'object' && run.findings !== null
      ? (run.findings as { g0?: unknown; execution?: unknown })
      : {};
  const g0 = asG0(findings.g0);
  const execution =
    typeof findings.execution === 'object' && findings.execution !== null
      ? (findings.execution as { nodeId?: unknown; strategyId?: unknown })
      : {};
  const nodeId = typeof execution.nodeId === 'string' ? execution.nodeId : null;
  const strategyId = typeof execution.strategyId === 'string' ? execution.strategyId : null;

  const waitingReason = run.waitingReason ?? null;
  const errorText = run.error ?? null;
  const eligibilityReasons = strArray(g0?.eligibility?.reasons);
  const verifierChainErrors = strArray(
    Array.isArray(g0?.verifierChainErrors)
      ? g0?.verifierChainErrors.map((e) =>
          typeof e === 'object' && e !== null && 'message' in e
            ? (e as { message?: unknown }).message
            : e,
        )
      : [],
  );
  const missingRequired = strArray(g0?.missingRequired);
  const versionDrift = g0?.versionDrift === true;
  const openConflicts = Array.isArray(g0?.openMaterialConflicts)
    ? g0?.openMaterialConflicts.length
    : 0;

  const raw: ExecutionBlocker['raw'] = {
    waitingReason,
    error: errorText,
    eligibilityReasons,
    verifierChainErrors,
    missingRequired,
  };

  const blocked =
    run.state === 'waiting_for_input' ||
    run.state === 'failed' ||
    run.state === 'failed_recoverable' ||
    run.state === 'failed_terminal';
  if (!blocked) return null;

  const lc = `${waitingReason ?? ''}
${errorText ?? ''}`.toLowerCase();
  const has = (needle: string) => lc.includes(needle);

  // The send-approval park renders its OWN dedicated read-only surface
  // (staged preview + no approval control) — never a generic blocker card.
  if (has('awaiting send approval')) return null;

  // Precedence follows evaluateG0's own blockReason precedence (most specific
  // precise reason first), then the legacy phrase classes.
  if (has('interactive session') || has('no bearer') || has('bearerless')) {
    return {
      code: 'interactive_session',
      primary: 'Reconnect your session to continue this run.',
      requirements: [],
      nodeId,
      strategyId,
      repair: 'session_recovery',
      raw,
    };
  }

  if (versionDrift || has('plan changed since') || has('version drift')) {
    return {
      code: 'plan_version_changed',
      primary: 'The plan changed after this run was prepared.',
      requirements: [],
      nodeId,
      strategyId,
      repair: 'review_step',
      raw,
    };
  }

  if (openConflicts > 0 || has('material conflict') || has('unresolved material conflict')) {
    return {
      code: 'material_conflict',
      primary: 'Resolve the conflicting client information before continuing.',
      requirements: [],
      nodeId,
      strategyId,
      repair: 'review_context',
      raw,
    };
  }

  // A KNOWN missing source — prescribes only the known missing types.
  if (missingRequired.length > 0 || has('required client context is missing')) {
    const kinds = missingRequired.length
      ? missingRequired
      : extractMissingKinds(waitingReason ?? '');
    return {
      code: 'required_source_missing',
      // The named types render in the requirements list — the primary stays
      // generic so the source is named exactly once on the card.
      primary: 'Add the missing context material before preparing grounded work.',
      requirements: kinds.map((kind) => ({ kind, label: sourceLabel(kind) })),
      nodeId,
      strategyId,
      repair: 'add_context',
      raw,
    };
  }

  /*
   * An artifact-verification failure WITHOUT a known missing requirement is
   * its own condition: the content could not be verified, the CAUSE is
   * unknown, and no requirement is invented.
   */
  const verificationFailed =
    has('generated artifact verification did not pass') ||
    has('plan verification failed') ||
    (verifierChainErrors.length > 0 &&
      eligibilityReasons.length === 0 &&
      missingRequired.length === 0);
  if (verificationFailed) {
    return {
      code: 'verification_failed_unknown',
      primary: 'The generated content could not be verified.',
      requirements: [],
      nodeId,
      strategyId,
      repair: 'inspect_findings',
      raw,
    };
  }

  if (eligibilityReasons.length > 0 || has('no longer eligible') || has('not eligible')) {
    return projectEligibility(eligibilityReasons, waitingReason ?? '', {
      nodeId,
      strategyId,
      raw,
    });
  }

  // Unrecognized legacy failure — honest, unhurried, no fabricated diagnosis.
  if (run.state === 'waiting_for_input' || errorText || waitingReason) {
    return {
      code: 'other',
      primary: 'This run needs attention. Review its details before retrying.',
      requirements: [],
      nodeId,
      strategyId,
      repair: 'inspect_findings',
      raw,
    };
  }

  return null;
}

/** Map raw eligibility reasons to the readable owner/date/kind-subject classes. */
function projectEligibility(
  reasons: string[],
  waitingReason: string,
  ids: { nodeId: string | null; strategyId: string | null; raw: ExecutionBlocker['raw'] },
): ExecutionBlocker {
  const joined = [...reasons, waitingReason].join('; ').toLowerCase();

  if (joined.includes('no owner')) {
    return {
      code: 'owner_missing',
      primary: 'Assign an owner to this step before preparing work.',
      requirements: [{ kind: 'owner', label: 'Step owner' }],
      nodeId: ids.nodeId,
      strategyId: ids.strategyId,
      repair: 'open_step',
      raw: ids.raw,
    };
  }
  if (joined.includes('no target date')) {
    return {
      code: 'date_missing',
      primary: 'Add a target date to this step.',
      requirements: [{ kind: 'target_date', label: 'Target date' }],
      nodeId: ids.nodeId,
      strategyId: ids.strategyId,
      repair: 'open_step',
      raw: ids.raw,
    };
  }
  if (joined.includes('kind must be') || joined.includes('subject must be')) {
    return {
      code: 'kind_subject_invalid',
      primary: 'Workspace preparation requires an Action with a Deliverable or Submission subject.',
      requirements: [{ kind: 'kind_subject', label: 'Step type and subject' }],
      nodeId: ids.nodeId,
      strategyId: ids.strategyId,
      repair: 'review_step',
      raw: ids.raw,
    };
  }
  if (joined.includes('no workspace access')) {
    return {
      code: 'other',
      primary: 'Your role does not include Workspace preparation for this step.',
      requirements: [],
      nodeId: ids.nodeId,
      strategyId: ids.strategyId,
      repair: 'inspect_findings',
      raw: ids.raw,
    };
  }
  if (joined.includes('completed')) {
    return {
      code: 'other',
      primary: 'This step is completed — reopen it before preparing more work.',
      requirements: [],
      nodeId: ids.nodeId,
      strategyId: ids.strategyId,
      repair: 'review_step',
      raw: ids.raw,
    };
  }
  return {
    code: 'other',
    primary: 'This run needs attention. Review its details before retrying.',
    requirements: [],
    nodeId: ids.nodeId,
    strategyId: ids.strategyId,
    repair: 'inspect_findings',
    raw: ids.raw,
  };
}

/** "required client context is missing: strategy_brief, client_constraints" → the kinds. */
function extractMissingKinds(reason: string): string[] {
  const match = /required client context is missing:\s*(.+)$/i.exec(reason);
  if (!match || match.length < 2) return [];
  const listed = match[1] ?? '';
  return listed
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}
