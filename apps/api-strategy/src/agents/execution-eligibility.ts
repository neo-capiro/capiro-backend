/*
 * Stage G Execution-Agent eligibility. PURE module (no Nest imports, no I/O):
 * given a plan node + the strategy's Steward health + a workspace-access signal,
 * decide whether the Execution Agent may STAGE an artifact (a Workspace draft or
 * an outreach record) for that node — and return EVERY failing reason, not just
 * the first, so the run's waitingReason can name all the gaps at once.
 *
 * This is the layer where Steward health becomes BLOCKING. The schema note on
 * SpContextConflict is explicit: an OPEN MATERIAL conflict blocks Execution-Agent
 * eligibility (Stage G), whereas for a draft (Stage E/A8) it only annotates. So
 * `strategyHealth.openMaterialConflicts > 0` is a hard gate here — unlike the
 * Meri draft path, where the same signal is advisory.
 *
 * Kinds:
 *  - 'workspace' stages a deliverable/submission draft (WsDraft). It needs an
 *    action node with a deliverable/submission subject, an owner, a target date,
 *    NO open material conflict, and workspace access.
 *  - 'outreach' stages an engagement record for a member/committee/agency. It
 *    needs one of those subjects, an owner, a target date, and NO open material
 *    conflict. (A coalition ask is modelled today as a 'member'-subject node with
 *    a coalition marker; widening the outreach subject set to a first-class
 *    coalition subject is a documented future step — for now outreach subjects
 *    stay member/committee/agency, and workspace access is not an outreach gate.)
 */

export type ExecutionKind = 'workspace' | 'outreach';

/** The node fields eligibility reasons over. Dates are normalized to
 *  YYYY-MM-DD | null by the caller (isoDate) before they reach this module. */
export interface EligibilityNode {
  kind: string; // sp_node_kind: action | decision | gate | milestone | risk
  subject: string; // sp_node_subject
  ownerUserId: string | null;
  startsOn: string | null;
  endsOn: string | null;
}

export interface EligibilityInput {
  node: EligibilityNode;
  strategyHealth: { openMaterialConflicts: number };
  hasWorkspaceAccess: boolean;
  kind: ExecutionKind;
}

export interface EligibilityResult {
  eligible: boolean;
  /** Every failing gate, in a stable order. Empty iff eligible. */
  reasons: string[];
}

/** Workspace drafts are for concrete work products only. */
export const WORKSPACE_SUBJECTS = ['deliverable', 'submission'] as const;
/** Outreach engages an external counterparty. */
export const OUTREACH_SUBJECTS = ['member', 'committee', 'agency'] as const;

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const { node, strategyHealth, hasWorkspaceAccess, kind } = input;
  const reasons: string[] = [];

  const hasOwner = typeof node.ownerUserId === 'string' && node.ownerUserId.trim().length > 0;
  // A target date is either bound (endsOn) or, failing that, a start (startsOn).
  const hasTargetDate = Boolean(node.endsOn) || Boolean(node.startsOn);
  const openConflicts = strategyHealth?.openMaterialConflicts ?? 0;

  if (kind === 'workspace') {
    if (node.kind !== 'action') {
      reasons.push(`node kind must be 'action' for workspace execution (is '${node.kind}')`);
    }
    if (!(WORKSPACE_SUBJECTS as readonly string[]).includes(node.subject)) {
      reasons.push(
        `node subject must be one of ${WORKSPACE_SUBJECTS.join(', ')} for workspace execution (is '${node.subject}')`,
      );
    }
    if (!hasWorkspaceAccess) {
      reasons.push('caller has no workspace access');
    }
  } else {
    if (!(OUTREACH_SUBJECTS as readonly string[]).includes(node.subject)) {
      reasons.push(
        `node subject must be one of ${OUTREACH_SUBJECTS.join(', ')} for outreach execution (is '${node.subject}')`,
      );
    }
  }

  // Common gates (both kinds).
  if (!hasOwner) {
    reasons.push('node has no owner (ownerUserId is required)');
  }
  if (!hasTargetDate) {
    reasons.push('node has no target date (startsOn or endsOn is required)');
  }
  // Stage-E BLOCKER (SpContextConflict schema note): an open material conflict
  // blocks execution eligibility. Reported here AND surfaced as its own precise
  // G0 waitingReason by the service.
  if (openConflicts > 0) {
    reasons.push(
      `strategy has ${openConflicts} open material conflict${openConflicts === 1 ? '' : 's'} (blocks execution)`,
    );
  }

  return { eligible: reasons.length === 0, reasons };
}
