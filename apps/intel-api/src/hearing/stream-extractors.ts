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

/**
 * Per-committee Akamai streamId table (from yt-dlp senategov.py). Maps an ISVP
 * `comm` code → the numeric streamId in the Akamai HLS path. Kept as a frozen
 * literal; table rot has precedent (June 2022), so the resolver ALSO keeps the
 * msl3archive + legacy probes as fallbacks and assisted-paste as the terminal.
 */
export const SENATE_ISVP_STREAM_IDS: Readonly<Record<string, string>> = Object.freeze({
  ag: '2036785',
  aging: '2036787',
  approps: '2036786',
  armed: '2036800',
  banking: '2036799',
  budget: '2036801',
  cecc: '2036796',
  commerce: '2036803',
  csce: '2036805',
  dpc: '2036807',
  energy: '2036782',
  epw: '2036783',
  ethics: '2036803',
  finance: '2036795',
  foreign: '2036799',
  govtaff: '2036792',
  help: '2036797',
  indian: '2036803',
  intel: '2036805',
  jccic: '2036807',
  jec: '2036807',
  judiciary: '2036788',
  rules: '2036790',
  saa: '2036807',
  scpc: '2036807',
  smbiz: '2036794',
  vetaff: '2036803',
});

export interface IsvpParams {
  comm: string;
  filename: string;
  /** Only present on the archive form; used for the msl3archive fallback. */
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
  let qs: URLSearchParams;
  try {
    // Full URL form.
    const u = new URL(input);
    qs = u.searchParams;
  } catch {
    // Bare query-string / fragment form.
    const q = input.includes('?') ? input.slice(input.indexOf('?') + 1) : input;
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
  const streamId = SENATE_ISVP_STREAM_IDS[params.comm];
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
  const urls: string[] = [];
  const label = params.poster || params.comm;
  urls.push(
    `https://www-senate-gov-msl3archive.akamaized.net/${label}/${params.filename}_1/master.m3u8`,
  );
  urls.push(`https://${params.comm}-f.akamaihd.net/i/${params.filename}_1@1/master.m3u8`);
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
