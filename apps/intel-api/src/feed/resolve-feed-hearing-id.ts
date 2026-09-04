/**
 * Bounded read-time resolution of evidence.hearing.hearingId for legacy feed
 * rows (PR B / §12). Writers after LW-QA-003 stamp hearingId at write time;
 * historical rows may only carry sessionId. Resolve via live_hearing_session
 * (ID-based, tenant-scoped) — NEVER title fuzzy-match.
 *
 * Pure decision helper is unit-tested; the I/O lives in FeedService.
 */
export type HearingEvidenceShape = {
  sessionId?: string | null;
  hearingId?: string | null;
  title?: string | null;
  committeeId?: string | null;
  occurredAt?: string | null;
  mentions?: unknown;
  [k: string]: unknown;
};

/** Returns the sessionIds that still need a hearingId backfill. */
export function sessionIdsNeedingHearingId(
  items: Array<{ evidence: unknown }>,
): string[] {
  const out = new Set<string>();
  for (const it of items) {
    const hearing = (it.evidence as { hearing?: HearingEvidenceShape | null } | null)?.hearing;
    if (!hearing) continue;
    const hid = typeof hearing.hearingId === 'string' ? hearing.hearingId.trim() : '';
    if (hid) continue;
    const sid = typeof hearing.sessionId === 'string' ? hearing.sessionId.trim() : '';
    if (sid) out.add(sid);
  }
  return [...out];
}

/**
 * Stamp resolved hearingIds onto evidence.hearing in place (mutates the
 * page's evidence objects after decryptQuotes, before normalizeEvidence).
 * Only fills when currently missing; never overwrites a writer-stamped id.
 */
export function applyResolvedHearingIds(
  items: Array<{ evidence: unknown }>,
  hearingIdBySession: Map<string, string>,
): number {
  let filled = 0;
  if (!hearingIdBySession.size) return 0;
  for (const it of items) {
    const root = it.evidence as { hearing?: HearingEvidenceShape | null } | null;
    const hearing = root?.hearing;
    if (!hearing) continue;
    const hid = typeof hearing.hearingId === 'string' ? hearing.hearingId.trim() : '';
    if (hid) continue;
    const sid = typeof hearing.sessionId === 'string' ? hearing.sessionId.trim() : '';
    if (!sid) continue;
    const resolved = hearingIdBySession.get(sid);
    if (!resolved) continue;
    hearing.hearingId = resolved;
    filled += 1;
  }
  return filled;
}
