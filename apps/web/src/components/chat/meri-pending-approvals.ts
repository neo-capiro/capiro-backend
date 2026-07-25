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

/**
 * Human-readable detail for an executed action, pulled from the tool's own
 * return value.
 *
 * This exists for the create→enrich chain. `create_client` mints a UUID that
 * only the server knows; the model then needs it to propose the matching
 * `update_client_profile`, because an unfocused conversation has no client to
 * fall back on. Putting "Name (id …)" into the completion message keeps the id
 * in conversation history where the model will actually read it, instead of
 * making it re-derive one — which is how "BryceTech" ended up proposed as a
 * clientId in the first place.
 */
export function describeApprovalResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const client = r.client;
  if (client && typeof client === 'object') {
    const c = client as Record<string, unknown>;
    const name = typeof c.name === 'string' ? c.name : null;
    const id = typeof c.id === 'string' ? c.id : null;
    if (name && id) return `${name} (id ${id})`;
    if (name) return name;
  }
  // update_client_profile reports what it actually wrote — worth echoing so
  // "approved" is never mistaken for "and it did what I described".
  const written = Array.isArray(r.fieldsWritten) ? r.fieldsWritten.length : 0;
  const people = Array.isArray(r.peopleCreated) ? r.peopleCreated.length : 0;
  const caps = Array.isArray(r.capabilitiesCreated) ? r.capabilitiesCreated.length : 0;
  const facilities = Array.isArray(r.facilitiesCreated) ? r.facilitiesCreated.length : 0;
  const parts: string[] = [];
  if (typeof r.clientName === 'string' && r.clientName) parts.push(r.clientName);
  const counts: string[] = [];
  if (written) counts.push(`${written} field${written === 1 ? '' : 's'}`);
  if (people) counts.push(`${people} ${people === 1 ? 'person' : 'people'}`);
  if (caps) counts.push(`${caps} capabilit${caps === 1 ? 'y' : 'ies'}`);
  if (facilities) counts.push(`${facilities} facilit${facilities === 1 ? 'y' : 'ies'}`);
  if (counts.length) parts.push(counts.join(', '));
  return parts.length ? parts.join(' — ') : null;
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
