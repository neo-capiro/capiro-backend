/**
 * Senate committee official-site discovery adapter (`senate-committee-calendar`).
 *
 * Some Senate committees publish richer event records on their own sites than
 * anywhere upstream: Budget and Judiciary both list business meetings and
 * hearings that Congress.gov's committee-meeting API does not carry (verified
 * 2026-09-01 — three canonical hearings existed only here). This adapter reads
 * the committee's own hearings index pages so those events can be observed
 * through the SAME observation ledger and reconciler as every other source.
 *
 * Two real page shapes (transcribed from live fetches 2026-09-01; the parser
 * is generic — per-site selectors only, no hardcoded hearing identifiers):
 *
 * 1. hCalendar microformat (`<tr class="vevent">`, e.g. budget.senate.gov):
 *
 *   <tr class="vevent">
 *     <td><a href="/hearings/<slug>" class="url summary">Title</a></td>
 *     <td><span class="location">SD-608</span></td>
 *     <td><time class="dtstart" title="2026-07-22T10:00"
 *         datetime="2026-07-22T10:00">07.22.26</time></td>
 *   </tr>
 *
 *   The datetime is NAIVE — no offset — and the site publishes Eastern wall
 *   clock, so it is interpreted through `etWallClockToInstant`.
 *
 * 2. Bootstrap list (`div.LegislationList__item`, e.g. judiciary.senate.gov):
 *
 *   <a class="LegislationList__title" href="…/hearings/<slug>">
 *     <span class="prefix">POSTPONED: </span> Full Title
 *   </a>
 *   … <div class="LegislationList__colType…">Full Committee Hearing</div>
 *   … <div class="LegislationList__colLocation…">Hart Senate Office Building Room 216</div>
 *   … <time datetime="2026-08-05T14:15:00Z">08/05/26 at 10:15am</time>
 *
 *   The datetime carries `Z` — already an instant — so it is parsed directly.
 *   Status prefixes ("CANCELLED:", "POSTPONED:", "CANCELED:", "TIME CHANGE:")
 *   live in `span.prefix`; they are carried through HONESTLY: `normalizeEventStatus`
 *   maps them to canceled/postponed and they are never rewritten to scheduled.
 *
 * The slug (`/hearings/<slug>`) is the stable per-event external id. Rescheduled
 * events keep the original slug; a re-notice gets a new one, which reconciles to
 * the same canonical row via the identity ladder rather than forking a duplicate.
 *
 * Status semantics note: a CANCELLED page entry for a past canonical row is the
 * official record of that row's fate. The event STILL gains provenance — the
 * observation records the page truth, and the reconciler's additive projection
 * updates `event_status` while the identity guard keeps the link on the right row.
 */
import { etWallClockToInstant } from '../hearing-time.js';
import { cleanText, fetchText } from './source-http.js';
import type {
  CommitteeSourceAdapter,
  DiscoveryContext,
  SourceDescriptor,
  SourceEvent,
  SourceHealth,
} from '../hearing-discovery.types.js';

/** Match the lowercase chamber shape of the SourceEvent contract. */
const UPPER_CHAMBER = 'senate';

export interface SenateCommitteeCalendarAdapterOptions {
  congress: number;
  /** Overrides the source row's page (tests inject fixtures this way). */
  url?: string;
}

export interface SenateCommitteeEventRow {
  slug: string;
  title: string;
  /** Status prefix exactly as published, before the title (may be empty). */
  statusPrefix: string | null;
  eventType: string | null;
  location: string | null;
  /** Raw datetime attribute from the page. */
  datetimeRaw: string;
  startsAt: Date;
  calendarDate: Date;
  officialPageUrl: string;
}

export class SenateCommitteeCalendarAdapter implements CommitteeSourceAdapter {
  readonly adapterKey = 'senate-committee-calendar';
  readonly parserVersion = 'senate-committee-calendar/2026-09-01';

  constructor(private readonly options: SenateCommitteeCalendarAdapterOptions) {}

  async discoverEvents(source: SourceDescriptor, ctx: DiscoveryContext): Promise<SourceEvent[]> {
    const url = this.options.url ?? source.sourceUrl;
    const res = await fetchText(url, { accept: 'text/html' });
    if (!res.ok || res.body == null) {
      throw new Error(`senate committee calendar fetch failed: ${res.error ?? `HTTP ${res.status}`}`);
    }
    const rows = parseSenateCommitteePage(res.body, url);
    return rows.map((row) => this.toSourceEvent(row, source, ctx));
  }

  async healthCheck(source: SourceDescriptor): Promise<SourceHealth> {
    const url = this.options.url ?? source.sourceUrl;
    const res = await fetchText(url, { accept: 'text/html', timeoutMs: 15_000 });
    return {
      ok: res.ok,
      status: res.status,
      durationMs: res.durationMs,
      error: res.error,
      observedEvents: res.body ? parseSenateCommitteePage(res.body, url).length : null,
    };
  }

  private toSourceEvent(
    row: SenateCommitteeEventRow,
    source: SourceDescriptor,
    ctx: DiscoveryContext,
  ): SourceEvent {
    return {
      externalEventId: row.slug,
      congress: this.options.congress,
      chamber: UPPER_CHAMBER,
      committeeSystemCode: source.committeeSystemCode ?? null,
      subcommitteeSystemCode: null,
      committeeName: source.committeeSystemCode
        ? `Senate Committee on ${source.committeeSystemCode}`
        : null,
      title: row.title,
      eventType: row.eventType,
      eventStatus: normalizePageStatus(row.statusPrefix),
      visibility: /closed|executive/i.test(`${row.statusPrefix ?? ''} ${row.title}`)
        ? 'private'
        : 'public',
      startsAt: row.startsAt,
      calendarDate: row.calendarDate,
      displayTime: null,
      location: row.location,
      officialPageUrl: row.officialPageUrl,
      witnesses: [],
      agendaBillIds: [],
      sourceUpdatedAt: null,
      streamCandidates: [],
      raw: {
        source: 'senate-committee-calendar',
        statusPrefix: row.statusPrefix,
        datetimeRaw: row.datetimeRaw,
      },
    };
  }
}

/** Status prefixes published by the committees, mapped without invention. */
export function normalizePageStatus(prefix: string | null): SourceEvent['eventStatus'] {
  const s = (prefix ?? '').trim().toLowerCase();
  if (/cancel/.test(s)) return 'canceled';
  if (/postpon|reschedul|time change|delay/.test(s)) return 'postponed';
  if (!s) return null;
  return null;
}

/**
 * Parse one committee hearings index page. Handles both observed shapes and
 * ignores anything else (nav anchors, scripts) by construction: an event row
 * exists only where a `time` element carries a real datetime next to a detail
 * link.
 */
export function parseSenateCommitteePage(html: string, baseUrl: string): SenateCommitteeEventRow[] {
  const rows: SenateCommitteeEventRow[] = [];
  const seen = new Set<string>();
  // Two structural item shapes observed on official committee pages. Parsing
  // per-ITEM (not per-<time> element) keeps every field of one entry together —
  // an entry's time element may precede or follow its anchor in document order.
  const items = [
    ...html.matchAll(/<tr[^>]*class="[^"]*\bvevent\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi),
    ...html.matchAll(/<div[^>]*class="[^"]*LegislationList__item\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*LegislationList__item\b|<div[^>]*class="[^"]*LegislationList__pagination|$)/gi),
  ];
  for (const item of items) {
    const block = item[1];
    if (!block) continue;
    const anchor = findItemAnchor(block);
    const timeMatch = /<time\b[^>]*datetime="([^"]+)"[^>]*>/i.exec(block);
    if (!anchor || !timeMatch?.[1]) continue;
    const parsed = buildRow(anchor, timeMatch[1], baseUrl);
    if (parsed && !seen.has(parsed.slug)) {
      seen.add(parsed.slug);
      rows.push(parsed);
    }
  }
  return rows;
}

interface PrecedingAnchor {
  href: string;
  text: string;
  prefix: string | null;
}

/** The entry anchor inside one structural item: a detail link with the title. */
function findItemAnchor(block: string): PrecedingAnchor | null {
  const anchors = [...block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  for (const m of anchors) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const href = /href="([^"]+)"/i.exec(attrs)?.[1];
    if (!href) continue;
    if (!/\/(hearings|business-meetings|meetings)\//i.test(href)) continue;
    if (!/LegislationList__title|url summary|summary/i.test(attrs)) continue;
    // A dedicated status prefix span (either published shape).
    const prefixSpan =
      /<span[^>]*class="(?:prefix|status)"[^>]*>([\s\S]*?)<\/span>/i.exec(inner);
    const prefix = prefixSpan?.[1] ? cleanText(prefixSpan[1]) : null;
    // Strip non-status helper spans; keep the status span so its text remains
    // available to the inline-prefix split (some pages publish the prefix as a
    // bare span, others inline).
    const text = cleanText(
      inner.replace(/<span(?![^>]*class="(?:prefix|status)")[^>]*>[\s\S]*?<\/span>/gi, ''),
    );
    if (!text) continue;
    return { href, text, prefix: prefix && prefix.length ? prefix : null };
  }
  return null;
}

function buildRow(
  anchor: PrecedingAnchor,
  datetimeRaw: string,
  baseUrl: string,
): SenateCommitteeEventRow | null {
  const instant = parsePageDatetime(datetimeRaw);
  if (!instant) return null;
  const url = new URL(anchor.href, baseUrl).toString();
  const slug = decodeURIComponent(url.split('/').filter(Boolean).pop() ?? '');
  if (!slug) return null;
  // Two published shapes for the status prefix: a dedicated span
  // (`class="prefix"` / `class="status"`) or inline text before the title
  // ("CANCELLED: Business Meeting to …"). Either way, once a prefix is
  // identified it is removed from the title — the status is carried in
  // `statusPrefix` and must not be duplicated into the canonical title.
  let title = anchor.text;
  let prefix = anchor.prefix;
  if (!prefix) {
    const inline = /^(cancelled|canceled|postponed|rescheduled|time change)\s*:\s*/i.exec(title);
    if (inline) {
      prefix = inline[0].replace(/\s+$/, '');
      title = title.slice(inline[0].length).trim();
    }
  } else {
    const lead = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i');
    title = title.replace(lead, '').trim();
  }
  const day = new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
  return {
    slug,
    title,
    statusPrefix: prefix,
    // The type/location columns are not always adjacent to the time element;
    // carry what the anchor gave us and leave deeper typing to the reconciler
    // projection.
    eventType: null,
    location: null,
    datetimeRaw,
    startsAt: instant,
    calendarDate: day,
    officialPageUrl: url,
  };
}

/**
 * `2026-08-05T14:15:00Z` → UTC instant. `2026-07-22T10:00` → NAIVE Eastern wall
 * clock (the hCalendar sites publish local time), converted via the shared
 * Eastern-time helper. Anything else is unparseable and the row is skipped.
 */
export function parsePageDatetime(raw: string): Date | null {
  const value = raw.trim();
  if (/Z$/i.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return etWallClockToInstant(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  );
}
