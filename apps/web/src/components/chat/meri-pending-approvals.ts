import type { PendingApproval } from './useMeriChatController.js';

/**
 * Pure state transitions for the held-write cards.
 *
 * Extracted from the controller because these are the rules with teeth — get
 * them wrong and either a user's approval is lost or a real write runs twice
 * — and neither is reachable from a DOM test without stubbing ~90 controller
 * fields.
 */

/** Cards still waiting on the user. Resolved/executing rows stay visible but don't count. */
export function outstandingApprovals(cards: PendingApproval[]): PendingApproval[] {
  return cards.filter((c) => c.status === 'proposed');
}

/**
 * Insert-or-replace a proposal by its opaque proposalId. Used for the live
 * `pending_approval` SSE frame, the approve/dismiss response, and the
 * recovery list fetch alike — the server is always the sole source of the
 * card's identity and state, so there is nothing to merge or infer.
 */
export function upsertProposal(prev: PendingApproval[], next: PendingApproval): PendingApproval[] {
  const index = prev.findIndex((p) => p.proposalId === next.proposalId);
  if (index === -1) return [...prev, next];
  const copy = [...prev];
  copy[index] = next;
  return copy;
}

/**
 * Human-readable detail for a succeeded action, pulled from the proposal's
 * bounded `resultSummary` (never the tool's raw result — the server redacts
 * and bounds it before it ever reaches the browser).
 *
 * This exists for the create→enrich chain. `create_client` mints a UUID that
 * only the server knows; the model then needs it to propose the matching
 * `update_client_profile`, because an unfocused conversation has no client to
 * fall back on. Putting "Name (id …)" into the completion message keeps the id
 * in conversation history where the model will actually read it, instead of
 * making it re-derive one — which is how "BryceTech" ended up proposed as a
 * clientId in the first place.
 */
export function describeApprovalResult(resultSummary: unknown): string | null {
  if (!resultSummary || typeof resultSummary !== 'object') return null;
  const r = resultSummary as Record<string, unknown>;
  const client = r.client;
  if (client && typeof client === 'object') {
    const c = client as Record<string, unknown>;
    const name = typeof c.name === 'string' ? c.name : null;
    const id = typeof c.id === 'string' ? c.id : null;
    if (name && id) return `${name} (id ${id})`;
    if (name) return name;
  }
  // update_client_profile's summary reports counts of what it actually wrote
  // — worth echoing so "approved" is never mistaken for "and it did what I
  // described".
  const counts = r.counts && typeof r.counts === 'object' ? (r.counts as Record<string, unknown>) : {};
  const written = typeof counts.fieldsWritten === 'number' ? counts.fieldsWritten : 0;
  const people = typeof counts.peopleCreated === 'number' ? counts.peopleCreated : 0;
  const caps = typeof counts.capabilitiesCreated === 'number' ? counts.capabilitiesCreated : 0;
  const facilities = typeof counts.facilitiesCreated === 'number' ? counts.facilitiesCreated : 0;
  const parts: string[] = [];
  if (typeof r.clientName === 'string' && r.clientName) parts.push(r.clientName);
  const countParts: string[] = [];
  if (written) countParts.push(`${written} field${written === 1 ? '' : 's'}`);
  if (people) countParts.push(`${people} ${people === 1 ? 'person' : 'people'}`);
  if (caps) countParts.push(`${caps} capabilit${caps === 1 ? 'y' : 'ies'}`);
  if (facilities) countParts.push(`${facilities} facilit${facilities === 1 ? 'y' : 'ies'}`);
  if (countParts.length) parts.push(countParts.join(', '));
  return parts.length ? parts.join(' — ') : null;
}

/**
 * One-line, honest description of a resolved proposal's outcome — the single
 * source of phrasing shared by the card UI and the post-round chat summary.
 * `outcome_unknown` and `blocked`/`expired` are deliberately never phrased as
 * success, and `outcome_unknown` explicitly warns against retrying (an
 * external send may have already happened).
 */
export function describeApprovalOutcome(p: PendingApproval): string {
  switch (p.status) {
    case 'succeeded': {
      const detail = describeApprovalResult(p.resultSummary);
      return detail ? `succeeded — ${detail}` : 'succeeded';
    }
    case 'failed_retryable':
      return `failed, can retry${p.error?.message ? ` — ${p.error.message}` : ''}`;
    case 'failed_terminal':
      return `failed${p.error?.message ? ` — ${p.error.message}` : ''}`;
    case 'outcome_unknown':
      return 'outcome unknown — do not retry, this may have already happened';
    case 'blocked':
      return `blocked — ${p.reason}`;
    case 'expired':
      return 'expired before it could run';
    case 'dismissed':
      return 'dismissed';
    default:
      return p.status;
  }
}
