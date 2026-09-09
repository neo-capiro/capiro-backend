export const LW_MERI_CONTEXT_KEY = 'lw:meri-context';

export interface LegiwatchHandoffRequest {
  hearingId: string;
  clientId: string | null;
}

export interface LegiwatchHandoffPacket {
  hearingId: string;
  hearingTitle?: string;
  packet: unknown;
  createdAt?: number;
}

/**
 * Read the LegiWatch → Meri handoff identifiers from the route query.
 *
 * HearingActions deep-links `/meri?source=legiwatch&hearingId=…&client=…`.
 * Anything short of both `source=legiwatch` and a non-empty `hearingId` is not
 * a handoff and must fall through to the ordinary root-route behavior.
 */
export function legiwatchHandoffRequest(search: string): LegiwatchHandoffRequest | null {
  const params = new URLSearchParams(search);
  if (params.get('source') !== 'legiwatch') return null;
  const hearingId = params.get('hearingId')?.trim() ?? '';
  if (!hearingId) return null;
  return { hearingId, clientId: params.get('client')?.trim() || null };
}

/**
 * Same-origin, same-tab transport for the grounded hearing packet. Written by
 * HearingActions on ask-meri success and consumed exactly once by the Meri
 * workspace boot. A storage failure on write is tolerated there (the deep link
 * still carries the identifiers), but a missing packet on read is a loud
 * failure in the workspace — silence would fall back to an unrelated thread.
 */
export function writeMeriHandoffPacket(payload: LegiwatchHandoffPacket): void {
  try {
    sessionStorage.setItem(LW_MERI_CONTEXT_KEY, JSON.stringify(payload));
  } catch {
    // Private-mode storage failure: the deep link still carries the
    // identifiers; the workspace will fail loudly on the missing packet
    // rather than silently opening an unrelated thread.
  }
}

/** Remove one-time LegiWatch handoff params while preserving unrelated state. */
export function withoutLegiwatchParams(search: string): string {
  const outgoing = new URLSearchParams(search);
  outgoing.delete('source');
  outgoing.delete('hearingId');
  outgoing.delete('insightId');
  outgoing.delete('segmentId');
  outgoing.delete('client');
  const query = outgoing.toString();
  return query ? `?${query}` : '';
}

/**
 * Consume the packet for exactly this hearing. Reading removes the entry, so a
 * reload or a second handoff can never attach a stale hearing's context. A
 * mismatched or unparseable payload reads as absent — the caller must fail
 * loudly instead of hydrating the newest thread.
 */
export function consumeMeriHandoffPacket(hearingId: string): LegiwatchHandoffPacket | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(LW_MERI_CONTEXT_KEY);
    if (raw) sessionStorage.removeItem(LW_MERI_CONTEXT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LegiwatchHandoffPacket | null;
    if (!parsed || typeof parsed !== 'object' || parsed.hearingId !== hearingId) return null;
    return parsed;
  } catch {
    return null;
  }
}
