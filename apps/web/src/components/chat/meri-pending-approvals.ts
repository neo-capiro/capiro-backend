import type { PendingApproval } from './useMeriChatController.js';

/**
 * Pure state transitions for the held-write cards.
 *
 * Extracted from the controller because the two rules here are the ones with
 * teeth — get either wrong and you either lose a user's approval or double-run
 * a real write (creating a duplicate client, sending an email twice) — and
 * neither is reachable from a DOM test without stubbing ~90 controller fields.
 */

/** Cards still waiting on the user. Resolved rows stay visible but don't count. */
export function outstandingApprovals(cards: PendingApproval[]): PendingApproval[] {
  return cards.filter((c) => c.status === 'pending');
}

/**
 * Fold a `pending_approval` SSE frame into the current card set.
 *
 * The fingerprint is a hash of (tenant, user, tool, canonicalized input), so an
 * identical re-proposal arrives with an identical fingerprint. That gives the
 * dedupe its meaning:
 *   - unseen fingerprint  → a genuinely new proposal, append it
 *   - already RAN         → the model re-proposed something already executed
 *                           (it cannot see the approval). Approving again would
 *                           write it twice, so leave the run row alone.
 *   - already FAILED      → the user fixed whatever broke and the model is
 *                           re-offering it. Make it actionable again.
 *   - PENDING / RUNNING   → already on screen or in flight; nothing to do.
 */
export function mergePendingApproval(
  prev: PendingApproval[],
  event: { tool: string; label?: string; fingerprint: string; reason?: string },
): PendingApproval[] {
  const existing = prev.find((p) => p.fingerprint === event.fingerprint);
  if (!existing) {
    return [
      ...prev,
      {
        tool: event.tool,
        label: event.label,
        fingerprint: event.fingerprint,
        reason: event.reason,
        status: 'pending',
      },
    ];
  }
  if (existing.status !== 'failed') return prev;
  return prev.map((p) =>
    p.fingerprint === event.fingerprint
      ? { ...p, status: 'pending' as const, detail: undefined, reason: event.reason ?? p.reason }
      : p,
  );
}

/** Record the outcome of an approval attempt against one card. */
export function applyApprovalOutcome(
  prev: PendingApproval[],
  fingerprint: string,
  status: PendingApproval['status'],
  detail?: string,
): PendingApproval[] {
  return prev.map((p) => (p.fingerprint === fingerprint ? { ...p, status, detail } : p));
}
