/**
 * Engagement Phase 0 — server-side draft lifecycle contracts.
 *
 * These literal unions are the AUTHORITATIVE vocabulary for an outreach draft
 * version's sendability. They are deliberately plain strings in the database
 * (see OutreachDraftVersion in schema.prisma) so a future status can ship
 * without a PostgreSQL enum migration; this module is where the meaning lives.
 *
 * The one rule everything else derives from: sendability is a property of an
 * IMMUTABLE VERSION, never of a recipient, a content hash, or a caller-supplied
 * body. `isDraftVersionSendable()` is the single gate — the send-intent service,
 * the web wizard's projection, and the tests all read it rather than
 * re-implementing the policy.
 */

/** How the version's text came to exist. */
export type DraftGenerationStatus = 'generated' | 'manually_authored' | 'generation_failed';

/**
 * Grounding-auditor state for this EXACT version's text.
 *
 * - `not_required` — auditor mode is off for this tenant; nothing to verify.
 * - `pending`      — the version is committed but its audit has not finished.
 * - `passed`       — audited clean.
 * - `warning`      — findings exist but the mode is non-blocking (shadow/annotate),
 *                    OR a control failed in a non-blocking mode (auditDecision
 *                    then reads 'audit_unavailable').
 * - `held`         — enforce mode + findings: a ReviewRequest exists and a
 *                    reviewer must approve THIS version before it can be sent.
 * - `unavailable`  — a control itself failed under enforce (auditor threw, ledger
 *                    write failed, or review-row write failed). FAIL CLOSED.
 */
export type DraftAuditStatus =
  | 'not_required'
  | 'pending'
  | 'passed'
  | 'warning'
  | 'held'
  | 'unavailable';

/** Human review state for this exact version. */
export type DraftApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

/** Lifecycle of a durable send intent. */
export type SendIntentStatus =
  | 'queued'
  | 'running'
  | 'partial'
  | 'complete'
  | 'failed'
  | 'canceled';

/**
 * Lifecycle of one logical delivery. `unknown` is terminal-for-automation: the
 * provider outcome could not be determined, so the human must verify Sent Items.
 * It is NEVER moved back to `pending` and never automatically retried.
 */
export type OutreachDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'skipped'
  | 'held';

/** The minimum a caller must know to decide sendability. */
export interface DraftVersionSendability {
  auditStatus: DraftAuditStatus;
  approvalStatus: DraftApprovalStatus;
}

/**
 * THE send gate. A version may leave for a provider only when both its audit
 * state and its approval state say so.
 *
 * Policy (Phase 0 plan §3.a3):
 *   - `not_required` audit → sendable.
 *   - `passed` audit → sendable.
 *   - `warning` audit → sendable ONLY while approval is not 'rejected' (the
 *     finding is advisory in shadow/annotate, but an explicit rejection wins).
 *   - `held` / `pending` / `unavailable` audit → NOT sendable, ever, regardless
 *     of approval. A held version becomes sendable only when the approval
 *     operation moves BOTH approvalStatus → 'approved' AND auditStatus →
 *     'passed' on that exact immutable row.
 *   - `pending` or `rejected` approval → NOT sendable, regardless of audit.
 *
 * Note the asymmetry is deliberate: audit state can veto on its own, and
 * approval state can veto on its own. There is no combination where a held,
 * pending or unavailable audit is overridden by an approval flag alone.
 */
export function isDraftVersionSendable(version: DraftVersionSendability): boolean {
  const { auditStatus, approvalStatus } = version;

  // Approval vetoes on its own: an outstanding or refused review blocks every
  // audit state. This is also what makes 'warning' below unconditional — a
  // rejected warning has already been refused here.
  if (approvalStatus === 'pending' || approvalStatus === 'rejected') return false;

  // Audit vetoes on its own: held / pending / unavailable can never be released
  // by an approval flag alone. A held version becomes sendable only once the
  // approval operation rewrites BOTH fields on that exact immutable row
  // (approvalStatus='approved' AND auditStatus='passed'), landing in 'passed'.
  switch (auditStatus) {
    case 'not_required':
    case 'passed':
    case 'warning':
      return true;
    case 'pending':
    case 'held':
    case 'unavailable':
      return false;
    default: {
      // Fail CLOSED on an unrecognized status — a future status added to the
      // database must be explicitly allowed here, never implicitly sendable.
      const exhaustive: never = auditStatus;
      void exhaustive;
      return false;
    }
  }
}

/** Delivery statuses that no longer move on their own. */
export const TERMINAL_DELIVERY_STATUSES: readonly OutreachDeliveryStatus[] = [
  'sent',
  'failed',
  'unknown',
  'skipped',
  'held',
] as const;

/**
 * Whether a delivery may be reset and re-attempted by the WORKER. Only `failed`
 * is eligible for an explicit, user-initiated NEW intent; `unknown` never is,
 * because the provider may already have accepted the message.
 */
export function isDeliveryAutoRetryable(status: OutreachDeliveryStatus): boolean {
  void status;
  return false;
}

/** review_request.subjectType for a held IMMUTABLE draft version (Phase 0). */
export const OUTREACH_DRAFT_VERSION_SUBJECT_TYPE = 'outreach-draft-version';
