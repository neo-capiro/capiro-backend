/**
 * Pure, unit-testable extraction functions for the hearing stream resolver.
 *
 * Everything here is SIDE-EFFECT-FREE: URL parsing, the Senate ISVP master.m3u8
 * URL construction from the per-committee streamId table, JSON-LD contentUrl
 * mining, YouTube `hlsManifestUrl` extraction, and congress.gov event-id parsing.
 * The fetch orchestration (StreamResolverService) is kept separate so these can
 * be tested with sample strings and no network.
 *
 * Recipes are per the P8 live-verified resolver spec.
 */

export type MediaKind = 'hls' | 'mp3' | 'mp4';

export interface ResolvedMedia {
  url: string;
  kind: MediaKind;
  provider: string;
  ipBound?: boolean;
  expiresAt?: string;
}

// ── direct-media ────────────────────────────────────────────────────────────

/**
 * Classify a URL as directly-ingestible media by extension, or return null.
 * `.m3u8`/`.m3u` → hls, `.mp3`/`.aac` → mp3 (audio), `.mp4`/`.ts` → mp4.
 * Query/hash suffixes are tolerated. Pure.
 */
export function classifyMediaUrl(rawUrl: string): MediaKind | null {
  let path: string;
  try {
    path = new URL(rawUrl).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\.(m3u8|m3u)$/.test(path)) return 'hls';
  if (/\.(mp3|aac)$/.test(path)) return 'mp3';
  if (/\.(mp4|ts)$/.test(path)) return 'mp4';
  return null;
}

// ── Senate ISVP ─────────────────────────────────────────────────────────────

/** One ISVP committee's stream coordinates (see SENATE_ISVP_COMMITTEES). */
export interface SenateIsvpCommittee {
  /** srs live streamId (Akamai /hls/live/{id}/…). Absent for legacy-only comms. */
  streamId?: string;
  /** Legacy per-committee akamaihd stream number ({file}_1@{num}). */
  streamNum?: string;
  /** msl3archive path label — often ≠ comm (armed→armedservices, govtaff→hsgac). */
  msl3: string;
}

/**
 * Per-committee ISVP stream table, transcribed VERBATIM from the senate.gov ISVP
 * player's own `streamInfo` table (fetched 2026-07-06 — the authoritative source;
 * the prior yt-dlp-derived streamId table had rotted: half the live ids were
 * shifted onto the wrong committees, and the archive labels were missing
 * entirely). Row shape upstream: [comm, streamNum, domain, streamId, msl3].
 * Table rot has precedent, so the resolver ALSO keeps probe fallbacks and
 * assisted-paste as the terminal.
 */
export const SENATE_ISVP_COMMITTEES: Readonly<Record<string, SenateIsvpCommittee>> = Object.freeze(
  {
    ag: { streamNum: '76440', streamId: '2036803', msl3: 'agriculture' },
    aging: { streamNum: '76442', streamId: '2036801', msl3: 'aging' },
    approps: { streamNum: '76441', streamId: '2036802', msl3: 'appropriations' },
    armed: { streamNum: '76445', streamId: '2036800', msl3: 'armedservices' },
    banking: { streamNum: '76446', streamId: '2036799', msl3: 'banking' },
    budget: { streamNum: '76447', streamId: '2036798', msl3: 'budget' },
    cecc: { streamNum: '76486', streamId: '2036782', msl3: 'srs_cecc' },
    commerce: { streamNum: '80177', streamId: '2036779', msl3: 'commerce' },
    csce: { streamNum: '75229', streamId: '2036777', msl3: 'srs_srs' },
    dpc: { streamNum: '76590', msl3: 'dpc' },
    energy: { streamNum: '76448', streamId: '2036797', msl3: 'energy' },
    epw: { streamNum: '76478', streamId: '2036783', msl3: 'environment' },
    ethics: { streamNum: '76449', streamId: '2036796', msl3: 'ethics' },
    finance: { streamNum: '76450', streamId: '2036795', msl3: 'finance_finance' },
    foreign: { streamNum: '76451', streamId: '2036794', msl3: 'foreignrelations' },
    govtaff: { streamNum: '76453', streamId: '2036792', msl3: 'hsgac' },
    help: { streamNum: '76452', streamId: '2036793', msl3: 'help' },
    indian: { streamNum: '76455', streamId: '2036791', msl3: 'indianaffairs' },
    intel: { streamNum: '76456', streamId: '2036790', msl3: 'intelligence' },
    intlnarc: { streamNum: '76457', msl3: 'internationalnarcoticscaucus' },
    jccic: { streamNum: '85180', streamId: '2036778', msl3: 'jccic' },
    jec: { streamNum: '76458', streamId: '2036789', msl3: 'jointeconomic' },
    judiciary: { streamNum: '76459', streamId: '2036788', msl3: 'judiciary' },
    rpc: { streamNum: '76591', msl3: 'rpc' },
    rules: { streamNum: '76460', streamId: '2036787', msl3: 'rules' },
    saa: { streamNum: '76489', streamId: '2036780', msl3: 'srs_saa' },
    smbiz: { streamNum: '76461', streamId: '2036786', msl3: 'smallbusiness' },
    srs: { streamNum: '75229', streamId: '2031966', msl3: 'srs_srs' },
    uscc: { streamNum: '76487', streamId: '2036781', msl3: 'srs_uscc' },
    vetaff: { streamNum: '76462', streamId: '2036785', msl3: 'veteransaffairs' },
  },
);

export interface IsvpParams {
  comm: string;
  filename: string;
  /** Poster image URL from the embed (informational only — NEVER a path label;
   *  modern embeds carry a full https image URL here). */
  poster?: string;
  streamType?: string;
}

/**
 * Parse the `comm` + `filename` from a Senate ISVP embed URL or a raw senate.gov
 * page's ISVP query string. Accepts either a full `…/isvp/?comm=judiciary&filename=judiciary051926`
 * URL or a bare query string. Returns null when the required params are absent.
 * Pure.
 */
export function parseIsvpParams(input: string): IsvpParams | null {
  // Committee pages entity-encode iframe srcs (`?comm=armed&amp;filename=…`) —
  // URLSearchParams would then produce keys like `amp;filename` and the parse
  // silently fails for EVERY senate.gov page. Decode ampersand entities first.
  const decoded = input
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&');
  let qs: URLSearchParams;
  try {
    // Full URL form.
    const u = new URL(decoded);
    qs = u.searchParams;
  } catch {
    // Bare query-string / fragment form.
    const q = decoded.includes('?') ? decoded.slice(decoded.indexOf('?') + 1) : decoded;
    qs = new URLSearchParams(q);
  }
  const comm = qs.get('comm')?.trim().toLowerCase();
  const filename = qs.get('filename')?.trim();
  if (!comm || !filename) return null;
  return {
    comm,
    filename,
    poster: qs.get('poster')?.trim() || undefined,
    streamType: qs.get('stt')?.trim() || qs.get('type')?.trim() || undefined,
  };
}

/**
 * Find a Senate ISVP embed in a committee page's HTML. Committee pages embed a
 * raw-HTML iframe `…/isvp/?comm={code}&filename={file}`; this pulls the first
 * such src (present BEFORE a hearing starts → resolve-ahead). Pure.
 */
export function findIsvpInHtml(html: string): IsvpParams | null {
  // Match an isvp URL in an iframe src, data attr, or inline script.
  const m = html.match(/\/isvp\/?\?[^"'\s<>]*comm=[^"'\s<>]+/i);
  if (!m) return null;
  return parseIsvpParams(m[0]);
}

/**
 * Construct the Akamai master.m3u8 for a Senate ISVP stream from the streamId
 * table. Same URL serves live AND the archived VOD (proven: judiciary051926 →
 * 200 master playlist). Returns null when the committee has no known streamId.
 * Pure — the caller probes the result (404 ⇒ pending/postponed).
 */
export function constructSenateIsvpUrl(params: IsvpParams): string | null {
  const streamId = SENATE_ISVP_COMMITTEES[params.comm]?.streamId;
  if (!streamId) return null;
  return `https://www-senate-gov-media-srs.akamaized.net/hls/live/${streamId}/${params.comm}/${params.filename}/master.m3u8`;
}

/**
 * Fallback probe URLs for a Senate ISVP stream when the primary streamId path
 * 404s or the committee isn't in the table: the msl3archive form, then the
 * legacy per-committee Akamai HD host. All allowlisted (*.akamaized.net /
 * *.akamaihd.net). Pure.
 */
export function senateIsvpFallbackUrls(params: IsvpParams): string[] {
  const info = SENATE_ISVP_COMMITTEES[params.comm];
  const urls: string[] = [];
  // Archived VOD lives under the committee's msl3 LABEL, which often differs
  // from the comm code (armed→armedservices — proven live: armedC051226 → 200).
  // The old code used `poster` here, but modern embeds carry a full image URL
  // in poster, which produced a garbage path; never use it.
  urls.push(
    `https://www-senate-gov-msl3archive.akamaized.net/${info?.msl3 ?? params.comm}/${params.filename}_1/master.m3u8`,
  );
  urls.push(
    `https://${params.comm}-f.akamaihd.net/i/${params.filename}_1@${info?.streamNum ?? '1'}/master.m3u8`,
  );
  return urls;
}

// ── C-SPAN ──────────────────────────────────────────────────────────────────

/**
 * Extract a C-SPAN program id from a program page URL
 * (`c-span.org/program/{type}/{slug}/{id}` or the older `…/video/?id={id}`).
 * Pure. Returns null when no numeric id is present.
 */
export function parseCspanProgramId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (!/(^|\.)c-span\.org$/i.test(u.hostname) && !/(^|\.)c-spanvideo\.org$/i.test(u.hostname)) {
      return null;
    }
    // /program/.../{id} — trailing numeric path segment.
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg && /^\d+$/.test(seg)) return seg;
    const qid = u.searchParams.get('id');
    if (qid && /^\d+$/.test(qid)) return qid;
    // Legacy `/video/?{id}-{part}` form — the id is the leading digits of the
    // (value-less) query key, e.g. `?12345-1`.
    const rawQuery = u.search.replace(/^\?/, '');
    const legacy = rawQuery.match(/^(\d{4,})(?:-\d+)?/);
    if (legacy) return legacy[1]!;
    // Sometimes the id is the second-to-last segment (trailing slug).
    const parts = u.pathname.split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^\d{4,}$/.test(parts[i]!)) return parts[i]!;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The deterministic C-SPAN HLS manifest for a program id (CloudFront VOD, no
 * token/UA/referer required per spec). Pure.
 */
export function cspanManifestForId(programId: string): string {
  return `https://m3u8-0.c-spanvideo.org/program/program.${programId}.tsc.m3u8`;
}

export interface CspanLdMeta {
  contentUrl?: string;
  title?: string;
  durationSec?: number;
  uploadDate?: string;
}

/**
 * Mine the <script type="application/ld+json"> VideoObject from a C-SPAN program
 * page: contentUrl (the m3u8), name, ISO-8601 duration, uploadDate. Tolerates an
 * array of LD objects or a single object. Pure.
 */
export function extractCspanLdJson(html: string): CspanLdMeta | null {
  const blocks = [
    ...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi),
  ];
  for (const b of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(b[1]!.trim());
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const c of candidates) {
      const obj = c as Record<string, unknown>;
      const type = String(obj['@type'] ?? '');
      if (!/video/i.test(type) && !obj.contentUrl) continue;
      const meta: CspanLdMeta = {};
      if (typeof obj.contentUrl === 'string') meta.contentUrl = obj.contentUrl;
      if (typeof obj.name === 'string') meta.title = obj.name;
      if (typeof obj.uploadDate === 'string') meta.uploadDate = obj.uploadDate;
      if (typeof obj.duration === 'string') {
        const sec = parseIso8601DurationSec(obj.duration);
        if (sec != null) meta.durationSec = sec;
      }
      if (meta.contentUrl || meta.title) return meta;
    }
  }
  return null;
}

/** Parse an ISO-8601 duration (PT1H2M3S) → seconds, or null. Pure. */
export function parseIso8601DurationSec(iso: string): number | null {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  const total = h * 3600 + min * 60 + s;
  return total > 0 ? total : null;
}

export interface CspanSearchCandidate {
  title: string;
  pageUrl: string;
  programId: string;
}

/**
 * Parse C-SPAN video-search result HTML into candidates: /program/ hrefs +
 * their link text. De-duplicates by program id. Pure.
 */
export function parseCspanSearchResults(html: string, limit = 8): CspanSearchCandidate[] {
  const out: CspanSearchCandidate[] = [];
  const seen = new Set<string>();
  const re =
    /<a[^>]+href="(https?:\/\/(?:www\.)?c-span\.org\/program\/[^"]+?\/(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < limit) {
    const pageUrl = m[1]!;
    const programId = m[2]!;
    if (seen.has(programId)) continue;
    seen.add(programId);
    const title = stripTags(m[3]!).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    out.push({ title, pageUrl, programId });
  }
  return out;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

// ── YouTube live ────────────────────────────────────────────────────────────

export interface YoutubeLiveInfo {
  hlsManifestUrl: string;
  isLive: boolean;
}

/**
 * Extract the live HLS manifest from a YouTube watch-page HTML. The page carries
 * `ytInitialPlayerResponse` with `"hlsManifestUrl":"…"` and `"isLiveNow":true`.
 * We require isLiveNow (VOD needs the signature cipher → not feasible here).
 * Unescapes `&`/`\/`. Returns null when not live or no manifest. Pure.
 *
 * The returned googlevideo manifest is IP-BOUND (/ip/<client-ip>/) and expires
 * (~6h) → the caller marks ipBound+expiresAt and re-resolves at ingest time.
 */
export function extractYoutubeHlsManifest(html: string): YoutubeLiveInfo | null {
  const liveMatch = html.match(/"isLiveNow"\s*:\s*(true|false)/);
  const isLive = liveMatch ? liveMatch[1] === 'true' : false;
  const m = html.match(/"hlsManifestUrl"\s*:\s*"([^"]+)"/);
  if (!m) return null;
  const url = m[1]!.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  if (!/^https?:\/\//.test(url)) return null;
  return { hlsManifestUrl: url, isLive };
}

/**
 * Parse the `expire=` epoch param out of a googlevideo HLS manifest URL → an ISO
 * timestamp, or null. Used to stamp `media.expiresAt`. Pure.
 */
export function parseGooglevideoExpiry(manifestUrl: string): string | null {
  const m = manifestUrl.match(/[/?&](?:expire|expires)[/=](\d{9,11})/);
  if (!m) return null;
  const epoch = Number(m[1]);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch * 1000).toISOString();
}

// ── YouTube generic embed (House pages) ─────────────────────────────────────

/**
 * Extract a YouTube video id from a committee/House page's embedded player
 * (`youtube.com/embed/{id}`, `youtu.be/{id}`, or `watch?v={id}`). Pure.
 */
export function findYoutubeIdInHtml(html: string): string | null {
  const patterns = [
    /youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})/i,
    /youtu\.be\/([A-Za-z0-9_-]{11})/i,
    /youtube\.com\/watch\?[^"'<>]*v=([A-Za-z0-9_-]{11})/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1]!;
  }
  return null;
}

/** Canonical watch URL for a YouTube video id. Pure. */
export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// ── committee-page generic scan ─────────────────────────────────────────────

/**
 * Scan an arbitrary allowlisted committee page's HTML for the first literal
 * media URL (`.m3u8`/`.mp4`) or a `data-videofile='<url>'` attribute (C-SPAN
 * classic live template). Returns the URL or null. Pure.
 */
export function findLiteralMediaInHtml(html: string): string | null {
  const dataFile = html.match(/data-videofile=["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
  if (dataFile) return dataFile[1]!;
  const literal = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
  if (literal) return literal[0];
  const mp4 = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
  if (mp4) return mp4[0];
  return null;
}

// ── congress.gov event ──────────────────────────────────────────────────────

export interface CongressEventRef {
  congress: number;
  chamber: 'house' | 'senate';
  eventId: string;
}

/**
 * Parse a congress.gov event page URL into { congress, chamber, eventId } WITHOUT
 * fetching it (the page is Cloudflare-403 to all fetchers). Also accepts our own
 * `cm-{congress}-{eventId}` hearing-row id (chamber inferred later). The parsed
 * ids drive an api.congress.gov `videos[]` lookup. Pure. Returns null on no match.
 *
 * Recognized forms:
 *   https://www.congress.gov/event/119th-Congress/house-event/119385
 *   https://www.congress.gov/event/119th-congress/senate-event/12345
 */
export function parseCongressEventUrl(rawUrl: string): CongressEventRef | null {
  const m = rawUrl.match(/congress\.gov\/event\/(\d+)th-congress\/(house|senate)-event\/(\d+)/i);
  if (!m) return null;
  return {
    congress: Number(m[1]),
    chamber: m[2]!.toLowerCase() as 'house' | 'senate',
    eventId: m[3]!,
  };
}

/**
 * Parse our internal committee-hearing row id `cm-{congress}-{eventId}` into the
 * congress + eventId (chamber unknown — the caller supplies it or probes both).
 * Pure. Returns null on no match.
 */
export function parseHearingRowId(id: string): { congress: number; eventId: string } | null {
  const m = /^cm-(\d+)-(\d+)$/.exec(id.trim());
  if (!m) return null;
  return { congress: Number(m[1]), eventId: m[2]! };
}

/** The api.congress.gov committee-meeting detail endpoint for an event. Pure. */
export function congressMeetingApiUrl(
  ref: { congress: number; chamber: string; eventId: string },
  apiKey: string,
): string {
  return `https://api.congress.gov/v3/committee-meeting/${ref.congress}/${ref.chamber.toLowerCase()}/${ref.eventId}?api_key=${encodeURIComponent(apiKey)}&format=json`;
}

/**
 * Pull video links from an api.congress.gov committee-meeting JSON payload's
 * `videos[]`. Skips the congress.gov/event self-link (not media) and returns the
 * external links (YouTube etc). Pure.
 */
export function extractCongressVideoUrls(payload: unknown): string[] {
  const cm = (payload as { committeeMeeting?: { videos?: Array<{ url?: string | null }> } })
    ?.committeeMeeting;
  const videos = cm?.videos ?? [];
  return videos
    .map((v) => v?.url?.trim())
    .filter((u): u is string => Boolean(u) && !/congress\.gov\/event/i.test(u!));
}

// ── Florida House notice → VideoPlayer pairing ──────────────────────────────

/**
 * Parse a Florida House meeting notice URL for its MeetingId.
 * Requires http(s), an official *.flhouse.gov host, the meetingnotice path, and
 * an exact numeric MeetingId query value (case-insensitive key). The notice page
 * itself carries the meeting date; the daily schedule page pairs the same
 * MeetingId with a VideoPlayer link. Pure.
 */
export function parseFloridaHouseNoticeUrl(rawUrl: string): { meetingId: string; date: string | null } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!/(^|\.)flhouse\.gov$/i.test(u.hostname)) return null;
  if (!/\/Sections\/Committees\/meetingnotice\.aspx$/i.test(u.pathname)) return null;
  const meetingId = queryValueCaseInsensitive(u, 'meetingid');
  if (!meetingId || !/^\d+$/.test(meetingId)) return null;
  return { meetingId, date: null };
}

/**
 * Read a query parameter whose KEY matches case-insensitively (ASP.NET query
 * keys are case-insensitive; URLSearchParams is not — it lowercases nothing,
 * so `?meetingid=` and `?MeetingId=` are different keys to it). Pure.
 */
function queryValueCaseInsensitive(u: URL, key: string): string | null {
  const wanted = key.toLowerCase();
  for (const pair of u.search.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    let decodedKey: string;
    try {
      decodedKey = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      continue;
    }
    if (decodedKey.toLowerCase() !== wanted) continue;
    const rawVal = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      return decodeURIComponent(rawVal.replace(/\+/g, ' '));
    } catch {
      return rawVal;
    }
  }
  return null;
}

const FL_MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** True when (y, m, d) is a REAL calendar date (rejects February 30 etc). Pure. */
function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Strip tags + decode the few entities a notice dd can carry. Pure. */
function flText(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the meeting date from a Florida House notice page's HTML, from the
 * notice's OWN "Start Date and Time" dt/dd pair (NEVER the End Date dd — a
 * midnight-crossing meeting would otherwise resolve the wrong schedule day).
 *
 * The REAL notice markup nests a <time> element inside a classed dd, with
 * whitespace/newlines between the tags:
 *
 *   <dt class="textBold label">Start Date and Time:</dt>
 *   <dd class="value">
 *       <time datetime="2026-02-26T08:00:00-05:00">
 *       Thursday, February 26, 2026 8:00 AM</time>
 *   </dd>
 *
 * Strategy, in order:
 *   1. the nested <time datetime="YYYY-MM-DD…"> attribute (authoritative);
 *   2. the dd's rendered text ("Thursday, February 26, 2026 8:00 AM" or a
 *      "2/26/2026 …" slash form).
 * The result is ALWAYS calendar-validated (February 30 is rejected). Pure.
 */
export function extractFloridaHouseNoticeDate(html: string): string | null {
  // Isolate the dd that FOLLOWS the Start Date and Time dt. [\s\S]*? tolerates
  // the newline + nested <time> tag the old `([^<]+)` capture choked on.
  const m = html.match(
    /<dt[^>]*>\s*Start Date and Time:?\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i,
  );
  if (!m) return null;
  const dd = m[1]!;

  // (1) Nested <time datetime="2026-02-26T08:00:00-05:00"> — authoritative.
  const dt = dd.match(/<time[^>]+datetime=["'](\d{4})-(\d{1,2})-(\d{1,2})/i);
  if (dt) {
    const y = Number(dt[1]);
    const mo = Number(dt[2]);
    const d = Number(dt[3]);
    if (isValidCalendarDate(y, mo, d)) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    // An invalid datetime attribute falls through to the rendered text.
  }

  // (2) Rendered text fallback ("Thursday, February 26, 2026 8:00 AM").
  const raw = flText(dd);
  const named = new RegExp(
    `\\b(${FL_MONTHS.join('|')})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`,
    'i',
  ).exec(raw);
  if (named) {
    const month = FL_MONTHS.indexOf(named[1]!.toLowerCase()) + 1;
    const d = Number(named[2]);
    const y = Number(named[3]);
    if (isValidCalendarDate(y, month, d)) {
      return `${y}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return null;
  }
  const slash = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw);
  if (slash) {
    const mo = Number(slash[1]);
    const d = Number(slash[2]);
    const y = Number(slash[3]);
    if (isValidCalendarDate(y, mo, d)) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return null;
}

/**
 * The Florida House daily schedule URL for a given ISO date. Pure.
 */
export function floridaHouseDailyScheduleUrl(date: string): string {
  const [y, m, d] = date.split('-');
  return `https://www.flhouse.gov/Sections/HouseSchedule/houseschedule.aspx?date=${Number(m)}-${Number(d)}-${y}`;
}

/**
 * Slice every top-level `<div …schedule-event…>` block out of a Florida House
 * daily schedule page using a BALANCED div scan (the page has no declared HTML
 * parser dependency, so we scan tags and count depth). Each returned block ends
 * at the div that closes the schedule-event element itself — nested inner divs
 * (col-12, meeting-info, …) can no longer truncate the block early, and the
 * scan never crosses into a preceding or following neighbor event. Pure.
 */
function extractScheduleEventBlocks(html: string): string[] {
  const blocks: string[] = [];
  const tagRe = /<\/?div\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let openIdx = -1;
  let depth = 0;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const isClose = /^<\//.test(tag);
    const isSelfClose = /\/>$/.test(tag);
    if (openIdx < 0) {
      if (!isClose && /class\s*=\s*["'][^"']*\bschedule-event\b/i.test(tag)) {
        openIdx = m.index;
        depth = 1;
      }
      continue;
    }
    if (isClose) depth--;
    else if (!isSelfClose) depth++;
    if (depth === 0) {
      blocks.push(html.slice(openIdx, m.index + tag.length));
      openIdx = -1;
    }
  }
  return blocks;
}

/** The official first-party Florida House VideoPlayer URL for an event id, or null. */
function parseFloridaHouseVideoPlayerUrl(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!/(^|\.)flhouse\.gov$/i.test(u.hostname)) return null;
  if (!/\/VideoPlayer\.aspx$/i.test(u.pathname)) return null;
  const eventId = u.searchParams.get('eventID');
  if (!eventId || !/^\d+$/.test(eventId)) return null;
  return u.toString();
}

/**
 * Validate a direct Florida House VideoPlayer page URL and return its exact
 * numeric event id. Same structural rules as the schedule-pairing path:
 * http(s), official *.flhouse.gov host, VideoPlayer path, exact numeric
 * eventID, no credentials. Pure.
 */
export function parseFloridaHouseVideoPlayerPageUrl(rawUrl: string): { eventId: string } | null {
  const normalized = parseFloridaHouseVideoPlayerUrl(rawUrl);
  if (!normalized) return null;
  return { eventId: new URL(normalized).searchParams.get('eventID')! };
}

/**
 * Find the VideoPlayer URL paired with a specific MeetingId on a Florida House
 * daily schedule page. The schedule-event block that carries the notice link
 * also carries the player link — and ONLY that block is searched, so a player
 * from a preceding or following neighbor event is never returned.
 *
 * Both links are URL-VALIDATED, not substring-matched:
 *  - the notice anchor must be http(s) on an official *.flhouse.gov host, on
 *    the meetingnotice path, with an EXACT numeric MeetingId (case-insensitive
 *    key) — so `MeetingId=151930` never satisfies a lookup for `15193`;
 *  - the player anchor must be http(s) on the same official host, on the
 *    VideoPlayer path, with a numeric eventID and no credentials.
 * Pure.
 */
export function findFloridaHouseVideoPlayerForMeeting(html: string, meetingId: string): string | null {
  const id = meetingId.trim();
  if (!id || !/^\d+$/.test(id)) return null;
  for (const block of extractScheduleEventBlocks(html)) {
    let ownsNotice = false;
    let playerUrl: string | null = null;
    const anchorRe = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
    let a: RegExpExecArray | null;
    while ((a = anchorRe.exec(block))) {
      const href = a[1] ?? a[2] ?? '';
      if (!href) continue;
      let abs: URL;
      try {
        abs = new URL(href, 'https://www.flhouse.gov');
      } catch {
        continue;
      }
      if (/\/Sections\/Committees\/meetingnotice\.aspx$/i.test(abs.pathname)) {
        const mid = queryValueCaseInsensitive(abs, 'meetingid');
        if (
          (abs.protocol === 'http:' || abs.protocol === 'https:') &&
          !abs.username &&
          !abs.password &&
          /(^|\.)flhouse\.gov$/i.test(abs.hostname) &&
          mid !== null &&
          /^\d+$/.test(mid) &&
          mid.toLowerCase() === id.toLowerCase()
        ) {
          ownsNotice = true;
        }
        continue;
      }
      if (playerUrl === null && /\/VideoPlayer\.aspx$/i.test(abs.pathname)) {
        playerUrl = parseFloridaHouseVideoPlayerUrl(abs.toString());
      }
    }
    // Only accept the player when THIS block owns the exact notice link.
    if (ownsNotice) return playerUrl;
  }
  return null;
}

/**
 * True when a fetched page is the publisher's own bot/WAF rejection rather
 * than real content. The Florida House site answers the guarded default
 * browser UA with `HTTP 200` + a ~244-byte "Request Rejected" page — treating
 * that as content would misreport a rejected fetch as a missing date. Pure.
 */
export function isRequestRejectedPage(html: string, status?: number): boolean {
  if (status !== undefined && (status === 401 || status === 403 || status === 429)) return true;
  if (html.length > 4096) return false; // a real notice/schedule page is far larger
  return /request rejected/i.test(html);
}

// ── Florida Senate media player ─────────────────────────────────────────────

/**
 * Parse a Florida Senate media player URL
 * (`https://www.flsenate.gov/media/VideoPlayer/6382`) into its exact numeric
 * event id. Requires http(s), an official *.flsenate.gov host, the
 * /media/VideoPlayer/ path, an exact numeric final segment (so 63820 never
 * satisfies a lookup for 6382), and no credentials. Pure.
 */
export function parseFloridaSenateVideoPlayerUrl(rawUrl: string): { eventId: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!/(^|\.)flsenate\.gov$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/media\/VideoPlayer\/(\d+)\/?$/i);
  if (!m) return null;
  return { eventId: m[1]! };
}

// ── The Florida Channel (Kaltura) HLS manifest ───────────────────────────────

/** The Florida Channel's Kaltura partner id (both flsenate.gov and flhouse.gov players embed it). */
export const FLORIDA_CHANNEL_KALTURA_PARTNER_ID = '2593311';

/** Kaltura API hosts that serve The Florida Channel's `playManifest` HLS masters. */
export const FLORIDA_CHANNEL_KALTURA_HOSTS: readonly string[] = Object.freeze([
  'cdnapi.kaltura.com',
  'cdnapisec.kaltura.com',
]);

/**
 * True for an https Kaltura `playManifest` HLS master owned by The Florida
 * Channel's partner account: `https://cdnapi(sec).kaltura.com/p/2593311/…/
 * playManifest/…/format/applehttp/…/a.m3u8`. Segment order after playManifest
 * varies between the Senate and House players, so segments are matched as
 * pairs, not by position. Any other partner id, format or host is rejected. Pure.
 */
export function isKalturaFloridaChannelMediaUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (!FLORIDA_CHANNEL_KALTURA_HOSTS.includes(u.hostname.toLowerCase())) return false;
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'p' || segments[1] !== FLORIDA_CHANNEL_KALTURA_PARTNER_ID) return false;
  const manifestIdx = segments.indexOf('playManifest');
  if (manifestIdx < 2) return false;
  const formatIdx = segments.indexOf('format', manifestIdx);
  if (formatIdx < 0 || segments[formatIdx + 1]?.toLowerCase() !== 'applehttp') return false;
  return segments.at(-1)?.toLowerCase() === 'a.m3u8';
}

/**
 * First literal The Florida Channel Kaltura HLS master in a player page's HTML
 * (the flsenate.gov and flhouse.gov VideoPlayer pages carry it verbatim), or
 * null. Every match is re-validated by isKalturaFloridaChannelMediaUrl so a
 * foreign partner id or a non-HLS playManifest never resolves. Pure.
 */
export function parseKalturaHlsManifestUrl(html: string): string | null {
  const re = /https:\/\/cdnapi(?:sec)?\.kaltura\.com\/p\/\d+\/[^"'\s<>\\]*?\/a\.m3u8(?:\?[^"'\s<>\\]*)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const candidate = m[0].replace(/&amp;/gi, '&');
    if (isKalturaFloridaChannelMediaUrl(candidate)) return candidate;
  }
  return null;
}

// ── Bounded first-party House fallback (event119529 regression) ─────────────
//
// A Congress.gov House event with an empty videos[] used to dead-end at
// "No video links". The official record usually still has video: the House
// repository (docs.house.gov) event page links the owning committee, and the
// committee's own event page embeds the player. Every hop below is keyed on
// the EXACT Congress event id — never a title match, never a hardcoded id.

/** The docs.house.gov repository event page for a Congress event id. Pure. */
export function houseDocsEventUrl(eventId: string): string {
  return `https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=${encodeURIComponent(
    eventId,
  )}`;
}

/**
 * Pull committee links off a docs.house.gov event page. Every anchor href is
 * entity-decoded, then PARSED AS A URL (never a raw regex capture): only
 * http(s) links on a real *.house.gov host with no credentials survive. An
 * official HTTP link is normalized to HTTPS (same host + exact path/query
 * identity preserved — the live docs page links
 * `http://naturalresources.house.gov/` and the redirect to https is safe to
 * pre-empt). Pure.
 *
 * Priority order:
 *   1. The validated "Visit Committee Site" anchor
 *      (`MainContent_HyperLinKCommittee`) — the repository's OWN pointer to
 *      the owning committee, honored FIRST for ANY official house.gov target,
 *      including a Rules Committee owner and even a bare-origin homepage
 *      (`http://naturalresources.house.gov/` — no character after the final
 *      slash, which the old `house\.gov/[^"']+` regex could never capture);
 *   2. Any other first-party *.house.gov anchor that is NOT generic chrome:
 *      www.house.gov / clerk.house.gov / rules.house.gov / docs.house.gov
 *      links are navigation UNLESS carried by the authoritative anchor above
 *      (Rules is a real owning committee — only its generic NAV is dropped).
 */
export function extractDocsHouseEventLinks(html: string): string[] {
  const committeeSite: string[] = [];
  const other: string[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) {
    const raw = m[1] ?? m[2] ?? '';
    if (!raw) continue;
    // Decode HTML entities so `?EventID=119529&amp;foo=bar` keeps its exact
    // query identity when parsed.
    const href = raw
      .replace(/&amp;/gi, '&')
      .replace(/&#0*38;/g, '&')
      .replace(/&#x0*26;/gi, '&');
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      continue; // relative or malformed — cannot prove first-party identity
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (u.username || u.password) continue;
    const host = u.hostname.toLowerCase();
    if (!/(^|\.)house\.gov$/i.test(host)) continue;
    const authoritative = /\bMainContent_HyperLinKCommittee\b/.test(m[0]);
    if (!authoritative) {
      // Generic chrome: the House portal, Clerk, Rules, and the repository's
      // own links (event PDFs, floor docs) are never the owning committee's
      // page — unless the repository's own committee anchor (handled above)
      // carries them.
      if (host === 'house.gov' || host === 'www.house.gov') continue;
      if (host === 'clerk.house.gov' || host === 'rules.house.gov') continue;
      if (host === 'docs.house.gov') continue;
    }
    // HTTP on an official host normalizes to HTTPS; host + exact path + query
    // identity are preserved byte-for-byte.
    const normalized = `https://${host}${u.pathname}${u.search}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (authoritative) committeeSite.push(normalized);
    else other.push(normalized);
  }
  return [...committeeSite, ...other];
}

/**
 * Pull candidate hearing/event page links off a committee site's page,
 * resolving relative hrefs against the site origin. Bounded to the same
 * *.house.gov origin. Pure.
 */
export function extractHouseCommitteeEventLinks(html: string, origin: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const base = new URL(origin);
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1]!;
    if (/^(javascript:|data:|mailto:|#)/i.test(href)) continue;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    // Only http(s) links on the SAME committee origin are candidates — never
    // a neighbor committee, never an external host, never a non-http scheme.
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    if (abs.username || abs.password) continue;
    // Same-origin traversal: an official http page linking its own https
    // path (or vice versa) is still the same committee site — scheme is the
    // ONLY component allowed to differ.
    if (abs.hostname.toLowerCase() !== base.hostname.toLowerCase()) continue;
    // Only event/hearing-shaped pages are candidates.
    if (!/event|hearing|calendar/i.test(abs.pathname)) continue;
    // Normalize the scheme to https (official-host upgrade) so the same page
    // linked over both schemes de-duplicates to one candidate.
    const url = `https://${abs.hostname.toLowerCase()}${abs.pathname}${abs.search}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * True when a committee event page links back to the EXACT Congress event id.
 * This is the ONLY acceptance signal: a page that merely shares a title is NOT
 * accepted.
 *
 * Every anchor href is PARSED AS A URL (entities decoded first, so
 * `?EventID=119529&amp;foo=bar` still works) and matched on structure, never as
 * a raw substring against arbitrary text:
 *
 *   1. host EXACTLY `docs.house.gov` (not fake-docs.house.gov, not
 *      docs.house.gov.evil.example), path EXACTLY
 *      `/Committee/Calendar/ByEvent.aspx`, and an exact numeric `EventID`
 *      query value — so `EventID=119529x` or `EventID=1195290` never match
 *      `119529`; query order and key casing are irrelevant;
 *   2. host `congress.gov` (or a subdomain) with a
 *      `/event/{N}th-congress/house-event/{id}` path whose final segment is
 *      EXACTLY the id.
 *
 * Credentials-bearing and non-http(s) hrefs are ignored. Pure.
 */
export function houseEventIdMatches(html: string, eventId: string): boolean {
  const id = eventId.trim();
  if (!id || !/^\d+$/.test(id)) return false;
  // Decode HTML entities so hrefs like ?EventID=119529&amp;foo=bar parse.
  const decoded = html
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&');
  const anchorRe = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(decoded))) {
    const href = m[1] ?? m[2] ?? '';
    if (!href) continue;
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      continue; // relative or malformed href — cannot prove the id
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (u.username || u.password) continue;
    const host = u.hostname.toLowerCase();
    // (1) docs.house.gov repository link with exact EventID query value.
    if (
      host === 'docs.house.gov' &&
      u.pathname.replace(/\/+$/, '').toLowerCase() === '/committee/calendar/byevent.aspx'
    ) {
      const ev = queryValueCaseInsensitive(u, 'eventid');
      if (ev !== null && /^\d+$/.test(ev) && ev === id) return true;
      continue;
    }
    // (2) congress.gov event URL with exact numeric event id path segment.
    if (/(^|\.)congress\.gov$/.test(host)) {
      const ev = u.pathname.match(/\/event\/\d+th-congress\/house-event\/(\d+)\/?$/i);
      if (ev && ev[1] === id) return true;
    }
  }
  return false;
}
