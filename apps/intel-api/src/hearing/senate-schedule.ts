/**
 * Pure, unit-testable parsing of the U.S. Senate committee schedule feed:
 *   https://www.senate.gov/general/committee_schedules/hearings.xml
 *
 * This is the PRIMARY discovery source for automatic Senate hearing capture
 * (superseding the daily `committee_hearing` snapshot for the trigger). The feed
 * publishes each scheduled meeting IN ADVANCE, including a `<video_url>` ISVP
 * embed (`…/isvp/?comm={comm}&filename={filename}`) — exactly the shape
 * `parseIsvpParams`/`constructSenateIsvpUrl` (stream-extractors.ts) consume — so
 * we can construct the Akamai `master.m3u8` before the hearing airs and probe it
 * for go-live.
 *
 * Everything here is SIDE-EFFECT-FREE (parse + classify + coordinate extraction);
 * the fetch/probe/DB orchestration lives in SenateScheduleService, so these can
 * be tested with sample strings and no network — same split as
 * stream-extractors.ts vs stream-resolver.service.ts.
 */

import { constructSenateIsvpUrl, parseIsvpParams, type IsvpParams } from './stream-extractors.js';

/** One `<meeting>` element from the Senate committee schedule feed. */
export interface SenateScheduleEntry {
  /** `<identifier>` — the feed's stable per-meeting id; our capture-once key. */
  identifier: string;
  /** `<cmte_code>` e.g. "SSGA00" (Senate systemCode-ish), or null. */
  committeeCode: string | null;
  /** `<committee>` display name, or null. */
  committee: string | null;
  /** `<sub_cmte>` subcommittee display name, or null. */
  subCommittee: string | null;
  /** `<type>` e.g. "Open Hearing", "Closed Hearing", "Markup", "Business Meeting". */
  type: string | null;
  /** `<date_iso_8601>` (ISO date/datetime string) or null. */
  dateIso: string | null;
  /** `<time_iso_8601>` (ISO time/datetime string) or null. */
  timeIso: string | null;
  /** `<room>` e.g. "SD-342", or null. */
  room: string | null;
  /** `<video_url>` — the ISVP embed URL, or null. */
  videoUrl: string | null;
  /** `<matter>` — the hearing subject/description (our title), or null. */
  matter: string | null;
}

/** A discovered hearing enriched with its precomputed ISVP stream coordinates. */
export interface DiscoveredSenateHearing {
  entry: SenateScheduleEntry;
  /** ISVP `comm` parsed from `<video_url>` (lower-cased). */
  comm: string;
  /** ISVP `filename` parsed from `<video_url>` (verbatim — handles suffixes). */
  filename: string;
  /** The constructed Akamai `master.m3u8`, or null when the committee has no
   *  known streamId (SENATE_ISVP_COMMITTEES) — caller falls back to probes. */
  isvpUrl: string | null;
  /** Best-effort scheduled start (UTC) from date/time ISO fields, or null. */
  scheduledAt: Date | null;
}

// ── XML parsing (feed is a flat list of <meeting> scalar-child elements) ──────

/**
 * Extract every `<meeting>…</meeting>` block's fields into a SenateScheduleEntry.
 * The feed is shallow and well-formed (no nested meetings), so a scoped regex
 * scan is robust and dependency-free — we deliberately avoid pulling in an XML
 * parser for a frozen, simple schema. Entries without an `<identifier>` are
 * skipped (they cannot be de-duplicated / claimed).
 */
export function parseSenateScheduleXml(xml: string): SenateScheduleEntry[] {
  if (!xml) return [];
  const out: SenateScheduleEntry[] = [];
  const blockRe = /<meeting\b[^>]*>([\s\S]*?)<\/meeting>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const body = m[1] ?? '';
    const identifier = tag(body, 'identifier');
    if (!identifier) continue; // no stable key → cannot capture-once
    out.push({
      identifier,
      committeeCode: tag(body, 'cmte_code'),
      committee: tag(body, 'committee'),
      subCommittee: tag(body, 'sub_cmte'),
      type: tag(body, 'type'),
      dateIso: tag(body, 'date_iso_8601'),
      timeIso: tag(body, 'time_iso_8601'),
      room: tag(body, 'room'),
      videoUrl: tag(body, 'video_url'),
      matter: tag(body, 'matter'),
    });
  }
  return out;
}

/** Read the text of the first `<name>…</name>` child, CDATA- and entity-aware. */
function tag(body: string, name: string): string | null {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i');
  const m = re.exec(body);
  if (!m) return null;
  let v = m[1] ?? '';
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(v);
  if (cdata) v = cdata[1] ?? '';
  v = decodeEntities(v).trim();
  return v.length ? v : null;
}

/** Decode the handful of XML entities the feed uses. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'");
}

// ── scope / scheduling ────────────────────────────────────────────────────────

/**
 * Combine the feed's `<date_iso_8601>` + `<time_iso_8601>` into a single UTC
 * Date, or null when unparseable. The feed's iso fields are already ISO-8601;
 * when the time field is a bare time we splice it onto the date. Best-effort —
 * used only to decide "start probing soon", never for correctness.
 */
export function scheduledAtFrom(entry: SenateScheduleEntry): Date | null {
  const { dateIso, timeIso } = entry;
  if (!dateIso) return null;
  const candidates: string[] = [];
  if (timeIso && /t/i.test(timeIso)) candidates.push(timeIso); // full datetime
  if (timeIso && /^\d{2}:\d{2}/.test(timeIso)) {
    const datePart = dateIso.slice(0, 10);
    candidates.push(`${datePart}T${timeIso}`);
  }
  candidates.push(dateIso);
  for (const c of candidates) {
    const d = parseAsUtc(c);
    if (d) return d;
  }
  return null;
}

/**
 * Parse an ISO-ish string deterministically. When it carries NO timezone
 * (Z or ±hh:mm), the wall-clock is interpreted as UTC so parsing is stable
 * regardless of server TZ (`new Date('…T08:30:00')` would otherwise be LOCAL).
 * The Senate feed publishes Eastern wall-clock with no zone; we do NOT convert
 * ET→UTC here because `scheduledAt` is APPROXIMATE — it only orders/gates when
 * to begin probing; the m3u8 200/404 probe is the authoritative go-live signal
 * (mirrors the committee_hearing UTC-wall-clock convention).
 */
function parseAsUtc(s: string): Date | null {
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  let iso: string;
  if (hasZone) iso = s;
  else if (/\d{2}:\d{2}/.test(s)) iso = `${s}Z`;
  else iso = `${s.slice(0, 10)}T00:00:00Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Turn a raw schedule entry into a DiscoveredSenateHearing with precomputed ISVP
 * coordinates, or null when it does not stream.
 *
 * SCOPE (Neo, 2026-07-23): capture EVERY streamable Senate committee proceeding —
 * hearings, markups, AND business meetings alike (markups/business meetings are
 * where amendments, votes, and nomination reports happen). We therefore do NOT
 * gate on `<type>`; the scope signal is simply a parseable ISVP `<video_url>`
 * (the thing that proves the proceeding is publicly streamed). The `<type>` is
 * kept as metadata (`entry.type` → capture.hearingType). A listed proceeding
 * that never actually airs is discarded cheaply by the liveness probe +
 * pending-window cap, not by a fragile type allowlist.
 *
 * Reuses parseIsvpParams (handles &amp;-encoding + session suffixes like
 * `armedC051226`) and constructSenateIsvpUrl — the SAME extractors the one-click
 * resolver uses, so auto-discovery and manual paste stay consistent.
 */
export function discoverFromEntry(entry: SenateScheduleEntry): DiscoveredSenateHearing | null {
  if (!entry.videoUrl) return null;
  const isvp: IsvpParams | null = parseIsvpParams(entry.videoUrl);
  if (!isvp) return null;
  return {
    entry,
    comm: isvp.comm,
    filename: isvp.filename,
    isvpUrl: constructSenateIsvpUrl(isvp),
    scheduledAt: scheduledAtFrom(entry),
  };
}

/** Parse + scope-filter a whole feed into discovered hearings. */
export function discoverFromXml(xml: string): DiscoveredSenateHearing[] {
  return parseSenateScheduleXml(xml)
    .map(discoverFromEntry)
    .filter((d): d is DiscoveredSenateHearing => d !== null);
}
