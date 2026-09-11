/*
 * F10 (2026-09-10 remediation plan §8) — structured execution blocker
 * projection, server-side. Additive presentation-layer projection over the
 * PERSISTED run findings (g0 eligibility/verifierChainErrors/missingRequired/
 * versionDrift/openMaterialConflicts): stable code, ONE primary readable
 * reason, the KNOWN requirements, affected IDs, and a repair target. Raw
 * diagnostics stay attached for the collapsed Technical details section.
 *
 * No new storage, no migration, no second gating logic — the run policy
 * remains the sole authority for which actions are offered. The web's
 * execution-blocker.ts mirrors this shape; when the server projection is
 * present the web consumes it verbatim.
 */
import type { Prisma } from '../../generated/prisma-client/index.js';

/** Stable blocker codes (wire contract; never displayed raw). */
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

export interface ExecutionRequirement {
  kind: string;
  label: string;
}

export type ExecutionRepairTarget =
  | 'open_step'
  | 'review_step'
  | 'add_context'
  | 'review_context'
  | 'inspect_findings'
  | 'session_recovery';

export interface ExecutionBlocker {
  code: ExecutionBlockerCode;
  primary: string;
  requirements: ExecutionRequirement[];
  nodeId?: string | null;
  strategyId?: string | null;
  repair: ExecutionRepairTarget;
  raw: {
    waitingReason?: string | null;
    error?: string | null;
    eligibilityReasons?: string[];
    verifierChainErrors?: string[];
    missingRequired?: string[];
  };
}

const MISSING_SOURCE_LABELS: Record<string, string> = {
  strategy_brief: 'Strategy brief',
  client_constraints: 'Client constraints',
};

function sourceLabel(kind: string): string {
  return MISSING_SOURCE_LABELS[kind] ?? kind.replace(/_/g, ' ');
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];
}

/** The Prisma run row shape this projection reads (subset). */
interface RunRow {
  state: string;
  waitingReason?: string | null;
  error?: string | null;
  strategyId?: string | null;
  findings?: Prisma.JsonValue | null;
}

export function projectExecutionBlocker(run: RunRow): ExecutionBlocker | null {
  const findings =
    typeof run.findings === 'object' && run.findings !== null && !Array.isArray(run.findings)
      ? (run.findings as { g0?: unknown; execution?: unknown })
      : {};
  const g0 =
    typeof findings.g0 === 'object' && findings.g0 !== null
      ? (findings.g0 as Record<string, unknown>)
      : null;
  const execution =
    typeof findings.execution === 'object' && findings.execution !== null
      ? (findings.execution as { nodeId?: unknown; strategyId?: unknown })
      : {};
  const nodeId = typeof execution.nodeId === 'string' ? execution.nodeId : null;

  const waitingReason = run.waitingReason ?? null;
  const errorText = run.error ?? null;
  const eligibility = g0?.eligibility as { reasons?: unknown } | null | undefined;
  const eligibilityReasons = strArray(eligibility?.reasons);
  const verifierChainErrors = strArray(
    Array.isArray(g0?.verifierChainErrors)
      ? (g0?.verifierChainErrors as Array<{ message?: unknown }>).map((e) =>
          typeof e === 'object' && e !== null && 'message' in e ? e.message : e,
        )
      : [],
  );
  const missingRequired = strArray(g0?.missingRequired);
  const versionDrift = g0?.versionDrift === true;
  const openConflicts = Array.isArray(g0?.openMaterialConflicts)
    ? (g0?.openMaterialConflicts as unknown[]).length
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

  const lc = `${waitingReason ?? ''}\n${errorText ?? ''}`.toLowerCase();
  const has = (needle: string) => lc.includes(needle);

  if (has('awaiting send approval')) return null; // send-approval park renders its own surface

  if (has('interactive session') || has('no bearer') || has('bearerless')) {
    return {
      code: 'interactive_session',
      primary: 'Reconnect your session to continue this run.',
      requirements: [],
      nodeId,
      strategyId: run.strategyId ?? null,
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
      strategyId: run.strategyId ?? null,
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
      strategyId: run.strategyId ?? null,
      repair: 'review_context',
      raw,
    };
  }

  if (missingRequired.length > 0 || has('required client context is missing')) {
    const kinds = missingRequired.length
      ? missingRequired
      : extractMissingKinds(waitingReason ?? '');
    return {
      code: 'required_source_missing',
      primary: 'Add the missing context material before preparing grounded work.',
      requirements: kinds.map((kind) => ({ kind, label: sourceLabel(kind) })),
      nodeId,
      strategyId: run.strategyId ?? null,
      repair: 'add_context',
      raw,
    };
  }

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
      strategyId: run.strategyId ?? null,
      repair: 'inspect_findings',
      raw,
    };
  }

  if (eligibilityReasons.length > 0 || has('no longer eligible') || has('not eligible')) {
    return projectEligibility(eligibilityReasons, waitingReason ?? '', {
      nodeId,
      strategyId: run.strategyId ?? null,
      raw,
    });
  }

  if (run.state === 'waiting_for_input' || errorText || waitingReason) {
    return {
      code: 'other',
      primary: 'This run needs attention. Review its details before retrying.',
      requirements: [],
      nodeId,
      strategyId: run.strategyId ?? null,
      repair: 'inspect_findings',
      raw,
    };
  }

  return null;
}

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

function extractMissingKinds(reason: string): string[] {
  const match = /required client context is missing:\s*(.+)$/i.exec(reason);
  if (!match || match.length < 2) return [];
  const listed = match[1] ?? '';
  return listed
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}
