/**
 * Pure Congress.gov committee-meeting parsing helpers.
 *
 * Extracted verbatim (behaviour-for-behaviour) from `apps/api/scripts/sync-hearings.ts`
 * so the Phase 3 `congress-gov` discovery adapter and the pre-existing daily sync
 * share ONE parser instead of forking two that can drift. The originals carried
 * hard-won correctness notes — the api_key-bearing URL trap, the nested
 * `{ bill: [...] }` envelope, the "Room X" location shape — and those comments
 * travel with the code rather than being paraphrased.
 *
 * `sync-hearings.ts` now imports from here; its behaviour is unchanged.
 */

export interface MeetingLocation {
  building?: string | null;
  room?: string | null;
}

export interface MeetingWitness {
  name?: string | null;
  position?: string | null;
  organization?: string | null;
}

export interface MeetingVideo {
  name?: string | null;
  url?: string | null;
}

export interface RelatedItemsBills {
  bills?:
    | Array<{
        type?: string | null;
        number?: number | string | null;
        congress?: number | null;
        url?: string | null;
      }>
    | { bill?: unknown[] }
    | null;
}

/** An explicit complete envelope may withdraw links only if every row parsed.
 * Duplicates are harmless; malformed entries make the observation partial. */
export function relatedAgendaComplete(detail: {
  relatedItems?: RelatedItemsBills | null;
}): boolean {
  const raw = detail.relatedItems?.bills;
  const rows = Array.isArray(raw) ? raw : raw?.bill;
  return (
    Array.isArray(rows) &&
    rows.every(
      (row) => relatedAgendaBills({ relatedItems: { bills: [row as never] } }).length === 1,
    )
  );
}

/**
 * Canonical congress_bill ids for the bills on a meeting agenda, from the
 * detail's relatedItems.bills[]. "HR"/"H.R." → "hr", so a
 * {congress:119,type:"HR",number:8800} becomes "119-hr-8800" (soft ref — the
 * bill may be untracked). Tolerant of the nested `{ bill: [...] }` envelope
 * Congress.gov sometimes uses; skips rows missing any of the three keys.
 */
export function relatedAgendaBills(detail: {
  relatedItems?: RelatedItemsBills | null;
}): Array<{ billId: string; congress: number }> {
  const raw: unknown = detail.relatedItems?.bills;
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { bill?: unknown[] } | null)?.bill)
      ? ((raw as { bill: unknown[] }).bill ?? [])
      : [];
  const out: Array<{ billId: string; congress: number }> = [];
  const seen = new Set<string>();
  for (const b of arr as Array<{ type?: unknown; number?: unknown; congress?: unknown }>) {
    const congress = Number(b?.congress);
    const type = String(b?.type ?? '')
      .toLowerCase()
      .replace(/[.\s]/g, '');
    const number = String(b?.number ?? '').trim();
    if (
      !Number.isInteger(congress) ||
      congress <= 0 ||
      !['hr', 's', 'hres', 'sres', 'hjres', 'sjres', 'hconres', 'sconres'].includes(type) ||
      !/^\d+$/.test(number) ||
      Number(number) <= 0
    )
      continue;
    const billId = `${congress}-${type}-${number}`;
    if (seen.has(billId)) continue;
    seen.add(billId);
    out.push({ billId, congress });
  }
  return out;
}

/** "Rayburn House Office Building, Room 2141" from the nested location object. */
export function formatLocation(loc: MeetingLocation | null | undefined): string | null {
  if (!loc) return null;
  const parts = [loc.building?.trim(), loc.room ? `Room ${loc.room.trim()}` : null].filter(
    (p): p is string => !!p,
  );
  return parts.length ? parts.join(', ') : null;
}

/**
 * Public-facing congress.gov event page for a committee meeting. The API also
 * returns this in videos[].url; we prefer that when present and otherwise
 * construct the canonical form:
 *   https://www.congress.gov/event/{congress}th-Congress/{chamber}-event/{eventId}
 * NEVER store the api.congress.gov URL — it requires an api_key and renders an
 * API_KEY_MISSING error in the browser.
 */
export function meetingPublicUrl(
  detail: { videos?: MeetingVideo[] | null },
  congress: number,
  chamber: string,
  eventId: string,
): string | null {
  const fromVideo = detail.videos?.find((v) => v.url && v.url.includes('congress.gov/event'))?.url;
  if (fromVideo) return fromVideo;
  const chamberSlug = chamber.toLowerCase();
  if (chamberSlug !== 'house' && chamberSlug !== 'senate') return null;
  return `https://www.congress.gov/event/${congress}th-Congress/${chamberSlug}-event/${eventId}`;
}

/** Normalize a witnesses[] payload to "Name, Position, Organization" strings. */
export function formatWitnesses(witnesses: MeetingWitness[] | null | undefined): string[] {
  return (witnesses ?? [])
    .map((w) =>
      [w.name?.trim(), w.position?.trim(), w.organization?.trim()]
        .filter((p): p is string => !!p)
        .join(', '),
    )
    .filter((s) => s.length > 0);
}

/**
 * Stream candidates a committee-meeting record ADVERTISES. Congress.gov's
 * `videos[]` mixes two very different things: the event landing page
 * (congress.gov/event/...) and, for some chambers, an actual player URL. Only
 * the latter is a media candidate; the former is the official PAGE, which is
 * why the two are kept in separate fields all the way down to
 * hearing_stream_candidate.
 *
 * Nothing here probes a URL or decides capturability — see
 * `stream-candidate.repository.ts` for why that boundary is strict.
 */
export function advertisedVideoCandidates(
  detail: { videos?: MeetingVideo[] | null },
  officialPageUrl: string | null,
): Array<{ provider: string; officialPageUrl: string; mediaUrl: string | null }> {
  const out: Array<{ provider: string; officialPageUrl: string; mediaUrl: string | null }> = [];
  for (const v of detail.videos ?? []) {
    const url = v.url?.trim();
    if (!url) continue;
    const isEventPage = url.includes('congress.gov/event');
    if (isEventPage) {
      out.push({ provider: 'congress-gov', officialPageUrl: url, mediaUrl: null });
      continue;
    }
    out.push({
      provider: 'unknown',
      officialPageUrl: officialPageUrl ?? url,
      mediaUrl: url,
    });
  }
  return out;
}
