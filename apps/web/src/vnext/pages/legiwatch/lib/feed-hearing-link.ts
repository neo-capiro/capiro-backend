/**
 * Bounded feed → hearing-detail deep-link resolution (PR B / §12).
 *
 * Priority (NEVER title fuzzy-match):
 *   1. evidence.hearing.hearingId          — canonical committee_hearing.id
 *   2. evidence.hearing.officialEventId    — numeric Congress.gov event id → cm-{congress}-{id}
 *   3. evidence.provenance.sourceUrl / hearing.officialPageUrl — parse congress.gov event URL
 *   4. null → honest non-linkable (packet drawer)
 *
 * Historical feed rows written before LW-QA-003 may lack hearingId; the
 * intel-api feed path also backfills via live_hearing_session.hearing_id at
 * read time. This helper is the web's last-mile resolver for any residual
 * rows that still only carry a session id or official URL.
 */
import type { FeedItem } from '../../../../pages/clients/tracker/intel-feed-api.js';

const CONGRESS_EVENT_RE =
  /congress\.gov\/event\/(\d+)(?:st|nd|rd|th)-congress\/(?:house|senate)-event\/(\d+)/i;
const CM_ID_RE = /^cm-\d+-\d+$/i;
const NUMERIC_EVENT_RE = /^\d{4,}$/;

export function parseCongressEventHearingId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = CONGRESS_EVENT_RE.exec(url);
  if (!m) return null;
  return `cm-${m[1]}-${m[2]}`;
}

export function resolveFeedHearingId(item: Pick<FeedItem, 'sourceType' | 'evidence'>): string | null {
  if (item.sourceType !== 'hearing' && item.sourceType !== 'combined') return null;
  const hearing = item.evidence?.hearing as
    | {
        hearingId?: string | null;
        officialEventId?: string | null;
        officialPageUrl?: string | null;
        congress?: number | null;
        sessionId?: string | null;
      }
    | undefined
    | null;
  if (!hearing) return null;

  const direct = (hearing.hearingId ?? '').trim();
  if (direct) {
    if (CM_ID_RE.test(direct)) return direct;
    // Some writers may already store the bare event id; only accept when we can
    // form a canonical cm- id with a known congress.
    if (NUMERIC_EVENT_RE.test(direct) && hearing.congress) {
      return `cm-${hearing.congress}-${direct}`;
    }
    // Accept any non-empty canonical-looking id the backend already resolved.
    if (direct.startsWith('cm-') || direct.startsWith('gh-')) return direct;
  }

  const officialEventId = (hearing.officialEventId ?? '').trim();
  if (officialEventId && NUMERIC_EVENT_RE.test(officialEventId) && hearing.congress) {
    return `cm-${hearing.congress}-${officialEventId}`;
  }

  const fromUrl =
    parseCongressEventHearingId(hearing.officialPageUrl) ??
    parseCongressEventHearingId(item.evidence?.provenance?.sourceUrl ?? null);
  if (fromUrl) return fromUrl;

  // sessionId alone is NOT enough on the web (detail route needs hearingId).
  // Backend read-time resolution is responsible for filling hearingId from the
  // session row; if it could not, we honestly stay non-linkable.
  return null;
}

export function feedHearingDetailHref(item: Pick<FeedItem, 'sourceType' | 'evidence'>): string | null {
  const id = resolveFeedHearingId(item);
  return id ? `/legiwatch/hearings/${encodeURIComponent(id)}` : null;
}
