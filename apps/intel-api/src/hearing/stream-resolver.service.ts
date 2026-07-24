import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SourceDataRepository,
  type UpcomingCommitteeHearing,
} from '../sourcedata/source-data.repository.js';
import { assertUrlAllowed, guardedFetchText, guardedProbe, SsrfError } from './net-guard.js';
import {
  classifyMediaUrl,
  congressMeetingApiUrl,
  constructSenateIsvpUrl,
  cspanManifestForId,
  extractCongressVideoUrls,
  extractCspanLdJson,
  extractYoutubeHlsManifest,
  findIsvpInHtml,
  findLiteralMediaInHtml,
  findYoutubeIdInHtml,
  parseCongressEventUrl,
  parseCspanProgramId,
  parseCspanSearchResults,
  parseGooglevideoExpiry,
  parseHearingRowId,
  parseIsvpParams,
  senateIsvpFallbackUrls,
  youtubeWatchUrl,
  type ResolvedMedia,
} from './stream-extractors.js';

/**
 * Hearing stream RESOLVER — the one-click "turn a hearing/page into a
 * watchable media URL" service behind POST /intel-api/hearings/resolve-stream.
 * The resolved URL is embedded (or linked) in the Live Hearing Room so the
 * analyst can play it and share that tab's audio — there is no server-side
 * stream ingestion; Deepgram only ever transcribes browser-captured audio.
 *
 * Provider adapters are tried in order (see the P8 live-verified spec):
 *   1. direct-media    — a URL that already IS media (validate via probe).
 *   2. senate-isvp     — parse comm+filename → construct Akamai master.m3u8 +
 *                        probe (404 ⇒ pending/postponed). DEFAULT ON (gov,
 *                        public-domain, no ToS wall — best legal posture).
 *   3. cspan           — JSON-LD contentUrl or deterministic m3u8 from program
 *                        id; hearingId-only ⇒ search ⇒ candidates.
 *   4. youtube-live    — require isLiveNow, regex hlsManifestUrl, mark
 *                        ipBound + expiresAt (IP-bound, ~6h TTL → re-resolve at
 *                        ingest time; never persist the googlevideo URL).
 *   5. committee-page  — generic allowlisted page scan (isvp / yt embed /
 *                        literal .m3u8) → recurse into the found lead.
 *   6. congress-event  — NEVER fetch the (Cloudflare-403) page; parse ids →
 *                        api.congress.gov videos[] → recurse. Needs
 *                        CONGRESS_API_KEY else returns the page as `reference`.
 *
 * ── COUNSEL GATING (see spec §"Gating decision") ──
 * senate-isvp and congress-event(as reference) are DEFAULT ON: Senate video is
 * federally-produced, public-domain, no ToS wall; the congress-event adapter only
 * ever hands back a gov page URL or a videos[] link.
 *
 * C-SPAN stream EXTRACTION and YouTube-LIVE extraction carry commercial-licensing
 * / Terms-of-Service risk (C-SPAN copyright + non-commercial policy; extracting a
 * YouTube stream outside the player violates YouTube ToS even for public-domain
 * content). Each is gated behind an env flag DEFAULT OFF:
 *     RESOLVER_ENABLE_CSPAN          (default false)
 *     RESOLVER_ENABLE_YOUTUBE_LIVE   (default false)
 * When OFF, the adapter does NOT auto-extract: it returns the page URL as a
 * `reference` (with a note) so the UI shows assisted-paste. Flip to true only
 * after counsel sign-off.
 *
 * ── SSRF ──
 * Every server-side fetch/probe goes through net-guard (host allowlist + private-
 * IP deny + capped redirects/size/timeout + browser UA). Redirects are followed
 * MANUALLY, re-validating each hop, and `guardedProbe` returns the FINAL,
 * post-redirect URL — every `media.url` this resolver returns is that validated
 * URL (never the original, which could 302 off-allowlist), so ingestion points
 * ffmpeg at a validated endpoint. `googlevideo.com` is on the allowlist only when
 * RESOLVER_ENABLE_YOUTUBE_LIVE is set. See net-guard.ts (incl. the RESIDUAL RISK
 * note re: allowlisted-manifest segment URIs → TODO(infra) egress deny).
 *
 * Tenant scoping: intel-api has NO RLS. resolve-stream reads only GLOBAL
 * reference data (committee_hearing) and public origins — no tenant-owned rows —
 * so it is safe to serve to any hearing_watch tenant; the controller still runs
 * TenantGuard + HearingWatchFeatureGuard.
 */

export type ResolveStatus = 'resolved' | 'candidates' | 'pending' | 'unresolvable';

export interface ResolveCandidate {
  title: string;
  pageUrl: string;
  programId?: string;
}

export interface ResolveResult {
  status: ResolveStatus;
  media?: ResolvedMedia;
  meta?: { title?: string; date?: string; durationSec?: number };
  candidates?: ResolveCandidate[];
  reference?: string;
  /** Human-readable provenance / next-step note for the UI. */
  note?: string;
}

@Injectable()
export class StreamResolverService {
  private readonly logger = new Logger(StreamResolverService.name);
  private readonly enableCspan: boolean;
  private readonly enableYoutubeLive: boolean;
  private readonly congressApiKey?: string;

  constructor(
    config: ConfigService,
    private readonly source: SourceDataRepository,
  ) {
    this.enableCspan = envFlag(config.get<string>('RESOLVER_ENABLE_CSPAN'));
    this.enableYoutubeLive = envFlag(config.get<string>('RESOLVER_ENABLE_YOUTUBE_LIVE'));
    this.congressApiKey = config.get<string>('CONGRESS_API_KEY')?.trim() || undefined;
  }

  /**
   * Resolve a hearing/page into an ingestible media URL. `depth` guards the
   * committee-page/congress-event recursion.
   */
  async resolve(
    input: { pageUrl?: string; hearingId?: string },
    depth = 0,
  ): Promise<ResolveResult> {
    if (depth > 3) return { status: 'unresolvable', note: 'Resolution recursion limit reached' };

    // A hearingId with no pageUrl: look it up (row id → event/url + cspan search).
    if (!input.pageUrl && input.hearingId) {
      return this.resolveByHearingId(input.hearingId);
    }

    const pageUrl = input.pageUrl?.trim();
    if (!pageUrl) return { status: 'unresolvable', note: 'Provide a page URL or hearing id' };

    // (1) direct-media passthrough — validate before accepting.
    const kind = classifyMediaUrl(pageUrl);
    if (kind) {
      try {
        await assertUrlAllowed(pageUrl); // host allowlist + IP deny
        const probe = await guardedProbe(pageUrl);
        if (probe.ok) {
          // Hand ffmpeg the FINAL post-redirect URL (guardedProbe re-validated
          // every hop) — NOT the original, which may 302 off-allowlist.
          return {
            status: 'resolved',
            media: { url: probe.url, kind, provider: 'direct-media' },
            note: 'Direct media URL validated',
          };
        }
        return {
          status: 'pending',
          reference: pageUrl,
          note: `Media URL not reachable yet (HTTP ${probe.status})`,
        };
      } catch (err) {
        return this.unresolvableFrom(err, pageUrl, 'direct-media');
      }
    }

    // Route by host.
    let host: string;
    try {
      host = new URL(pageUrl).hostname.toLowerCase();
    } catch {
      return { status: 'unresolvable', note: 'Invalid page URL' };
    }

    // (6) congress.gov event — NEVER fetch the page.
    if (/(^|\.)congress\.gov$/i.test(host)) {
      return this.resolveCongressEvent(pageUrl, depth);
    }
    // (2) senate.gov ISVP.
    if (/(^|\.)senate\.gov$/i.test(host)) {
      return this.resolveSenate(pageUrl);
    }
    // (3) C-SPAN.
    if (/(^|\.)c-span\.org$/i.test(host) || /(^|\.)c-spanvideo\.org$/i.test(host)) {
      return this.resolveCspan(pageUrl);
    }
    // (4) YouTube watch/live page.
    if (/(^|\.)youtube\.com$/i.test(host) || /(^|\.)youtu\.be$/i.test(host)) {
      return this.resolveYoutubeLive(pageUrl);
    }
    // (5) house.gov + other allowlisted committee pages → generic scan.
    if (/(^|\.)house\.gov$/i.test(host)) {
      return this.resolveCommitteePage(pageUrl, depth);
    }

    return {
      status: 'unresolvable',
      reference: pageUrl,
      note: `No resolver adapter for host ${host}`,
    };
  }

  // ── hearingId path ─────────────────────────────────────────────────────────

  private async resolveByHearingId(hearingId: string): Promise<ResolveResult> {
    // A bare C-SPAN program id?
    if (/^\d{4,}$/.test(hearingId.trim())) {
      return this.resolveCspan(`https://www.c-span.org/program/x/x/${hearingId.trim()}`);
    }

    // Our committee-hearing row id → look up the stored url + committee/title.
    const rowId = parseHearingRowId(hearingId);
    let row: UpcomingCommitteeHearing | undefined;
    try {
      row = await this.findHearingRow(hearingId);
    } catch (err) {
      this.logger.warn(`hearing row lookup failed for ${hearingId}: ${(err as Error).message}`);
    }

    // If we have a stored page URL, resolve through it (usually a congress.gov event).
    if (row?.url) {
      const r = await this.resolve({ pageUrl: row.url });
      if (r.status !== 'unresolvable') return r;
    }

    // Fall back: parse the event ids off the row id and try congress videos[].
    if (rowId && this.congressApiKey) {
      for (const chamber of ['house', 'senate'] as const) {
        const r = await this.tryCongressVideos({ ...rowId, chamber });
        if (r) return r;
      }
    }

    // Terminal: try to produce a REAL C-SPAN candidate shortlist for the analyst.
    if (row) {
      const q = [row.committeeName, row.title].filter(Boolean).join(' ').slice(0, 160);
      const searchRef = `https://www.c-span.org/search/?searchtype=Videos&query=${encodeURIComponent(q)}`;
      if (q) {
        // searchCspan returns real candidates when RESOLVER_ENABLE_CSPAN is on;
        // otherwise (or on no results) it returns unresolvable + the search URL as
        // `reference`. Never emit status:'candidates' with an empty array — that
        // renders as nothing in the UI. Guarantee a reference either way.
        const searched = await this.searchCspan(q);
        if (searched.status === 'candidates' && searched.candidates?.length) return searched;
        return {
          status: 'unresolvable',
          reference: searched.reference ?? searchRef,
          note:
            searched.note ??
            'No direct stream resolved — search C-SPAN or paste the stream URL',
        };
      }
      // No committee/title to search on — hand back the generic C-SPAN search.
      return {
        status: 'unresolvable',
        reference: searchRef,
        note: 'No direct stream resolved — search C-SPAN or paste the stream URL',
      };
    }
    return {
      status: 'unresolvable',
      reference: 'https://www.c-span.org/search/?searchtype=Videos',
      note: `Unknown hearing id ${hearingId} — search C-SPAN or paste the stream URL`,
    };
  }

  /** Find a committee-hearing row by id via the (read-only, global) repo. */
  private async findHearingRow(id: string): Promise<UpcomingCommitteeHearing | undefined> {
    // Direct by-id PK lookup (bound param). Works for ANY hearing in the corpus,
    // not just the ~100 most-recent — the old top-100 date-DESC scan missed
    // everything else.
    return (await this.source.getCommitteeHearingById(id)) ?? undefined;
  }

  // ── (2) Senate ISVP ────────────────────────────────────────────────────────

  private async resolveSenate(pageUrl: string): Promise<ResolveResult> {
    // If the URL is itself an isvp embed, parse it directly; else fetch the page.
    let isvp = parseIsvpParams(pageUrl);
    let title: string | undefined;
    if (!isvp) {
      try {
        const { text } = await guardedFetchText(pageUrl);
        isvp = findIsvpInHtml(text);
        title = firstTitle(text);
      } catch (err) {
        return this.unresolvableFrom(err, pageUrl, 'senate-isvp');
      }
    }
    if (!isvp) {
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'No Senate ISVP embed found on the page',
      };
    }

    const primary = constructSenateIsvpUrl(isvp);
    const probes = [primary, ...senateIsvpFallbackUrls(isvp)].filter((u): u is string =>
      Boolean(u),
    );
    for (const url of probes) {
      try {
        const probe = await guardedProbe(url);
        if (probe.ok) {
          // Use the final validated URL from the probe (redirect-safe).
          return {
            status: 'resolved',
            media: { url: probe.url, kind: 'hls', provider: 'senate-isvp' },
            meta: { title },
            note: `via Senate ISVP (${isvp.comm})`,
          };
        }
      } catch {
        // try next probe (SsrfError on a bad redirect hop lands here too)
      }
    }
    // 404 across all probes = a real signal: scheduled but not started.
    return {
      status: 'pending',
      reference: pageUrl,
      note: `Senate ISVP stream for ${isvp.comm} not live yet (scheduled — not started)`,
    };
  }

  // ── (3) C-SPAN ─────────────────────────────────────────────────────────────

  private async resolveCspan(pageUrl: string): Promise<ResolveResult> {
    const programId = parseCspanProgramId(pageUrl);

    // GATE: extraction is counsel-gated. When OFF, hand back a reference so the UI
    // shows assisted-paste; NEVER auto-extract the C-SPAN stream.
    if (!this.enableCspan) {
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'C-SPAN extraction disabled (RESOLVER_ENABLE_CSPAN) — commercial-licensing review pending. Open C-SPAN and paste the stream URL.',
      };
    }

    if (programId) {
      // Deterministic manifest, then confirm via LD-JSON if the shortcut 404s.
      const manifest = cspanManifestForId(programId);
      try {
        const probe = await guardedProbe(manifest);
        if (probe.ok) {
          return {
            status: 'resolved',
            media: { url: probe.url, kind: 'hls', provider: 'cspan' },
            note: `C-SPAN program ${programId}`,
          };
        }
      } catch {
        // fall through to page scrape
      }
    }

    // Scrape the program page's JSON-LD contentUrl.
    try {
      const { text } = await guardedFetchText(pageUrl);
      const ld = extractCspanLdJson(text);
      if (ld?.contentUrl) {
        return {
          status: 'resolved',
          media: { url: ld.contentUrl, kind: 'hls', provider: 'cspan' },
          meta: { title: ld.title, date: ld.uploadDate, durationSec: ld.durationSec },
          note: programId ? `C-SPAN program ${programId}` : 'via C-SPAN',
        };
      }
    } catch (err) {
      return this.unresolvableFrom(err, pageUrl, 'cspan');
    }
    return {
      status: 'unresolvable',
      reference: pageUrl,
      note: 'No C-SPAN media URL found on the page',
    };
  }

  /** C-SPAN video search → candidate shortlist (used by the hearingId path). */
  async searchCspan(query: string): Promise<ResolveResult> {
    if (!this.enableCspan) {
      return {
        status: 'unresolvable',
        reference: `https://www.c-span.org/search/?searchtype=Videos&query=${encodeURIComponent(query)}`,
        note: 'C-SPAN extraction disabled (RESOLVER_ENABLE_CSPAN)',
      };
    }
    const searchUrl = `https://www.c-span.org/search/?searchtype=Videos&query=${encodeURIComponent(query)}`;
    try {
      const { text } = await guardedFetchText(searchUrl);
      const candidates = parseCspanSearchResults(text);
      if (candidates.length)
        return { status: 'candidates', candidates, note: 'C-SPAN search results' };
    } catch (err) {
      this.logger.warn(`cspan search failed: ${(err as Error).message}`);
    }
    return { status: 'unresolvable', reference: searchUrl, note: 'No C-SPAN search results' };
  }

  // ── (4) YouTube live ───────────────────────────────────────────────────────

  private async resolveYoutubeLive(pageUrl: string): Promise<ResolveResult> {
    // GATE: YouTube-live extraction is counsel-gated (ToS). When OFF, reference.
    if (!this.enableYoutubeLive) {
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'YouTube-live extraction disabled (RESOLVER_ENABLE_YOUTUBE_LIVE) — Terms-of-Service review pending. Open the video and paste the stream URL.',
      };
    }
    try {
      const { text } = await guardedFetchText(pageUrl);
      const info = extractYoutubeHlsManifest(text);
      if (!info) {
        return {
          status: 'unresolvable',
          reference: pageUrl,
          note: 'No YouTube HLS manifest on the page',
        };
      }
      if (!info.isLive) {
        // VOD needs the signature cipher → not feasible; send to C-SPAN instead.
        return {
          status: 'unresolvable',
          reference: pageUrl,
          note: 'YouTube video is not live (VOD extraction not supported) — use C-SPAN',
        };
      }
      return {
        status: 'resolved',
        media: {
          url: info.hlsManifestUrl,
          kind: 'hls',
          provider: 'youtube-live',
          ipBound: true,
          expiresAt: parseGooglevideoExpiry(info.hlsManifestUrl) ?? undefined,
        },
        note: 'via YouTube live (IP-bound, short-lived — re-resolve at ingest)',
      };
    } catch (err) {
      return this.unresolvableFrom(err, pageUrl, 'youtube-live');
    }
  }

  // ── (5) committee-page generic scan ────────────────────────────────────────

  private async resolveCommitteePage(pageUrl: string, depth: number): Promise<ResolveResult> {
    let text: string;
    try {
      ({ text } = await guardedFetchText(pageUrl));
    } catch (err) {
      return this.unresolvableFrom(err, pageUrl, 'committee-page');
    }

    // ISVP embed (a House-hosted Senate-style embed is rare, but check).
    const isvp = findIsvpInHtml(text);
    if (isvp)
      return this.resolveSenate(
        `https://www.senate.gov/isvp/?comm=${isvp.comm}&filename=${isvp.filename}`,
      );

    // YouTube embed → recurse into the watch page (gated inside resolveYoutubeLive).
    const ytId = findYoutubeIdInHtml(text);
    if (ytId) return this.resolve({ pageUrl: youtubeWatchUrl(ytId) }, depth + 1);

    // A literal media URL on the page.
    const literal = findLiteralMediaInHtml(text);
    if (literal) {
      const kind = classifyMediaUrl(literal) ?? 'hls';
      try {
        const probe = await guardedProbe(literal);
        if (probe.ok) {
          return {
            status: 'resolved',
            media: { url: probe.url, kind, provider: 'committee-page' },
            note: 'Media URL scanned from the committee page',
          };
        }
      } catch {
        /* fall through */
      }
    }
    return {
      status: 'unresolvable',
      reference: pageUrl,
      note: 'No stream found on the committee page',
    };
  }

  // ── (6) congress.gov event ─────────────────────────────────────────────────

  private async resolveCongressEvent(pageUrl: string, depth: number): Promise<ResolveResult> {
    const ref = parseCongressEventUrl(pageUrl);
    if (!ref) {
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'Unrecognized congress.gov event URL',
      };
    }
    if (!this.congressApiKey) {
      // No key in intel-api → we can't read videos[]; hand back the page.
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'CONGRESS_API_KEY not set — cannot read congress.gov videos; open the event page',
      };
    }
    const r = await this.tryCongressVideos(ref, depth);
    return (
      r ?? {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'No video links on the congress.gov event',
      }
    );
  }

  private async tryCongressVideos(
    ref: { congress: number; chamber: string; eventId: string },
    depth = 0,
  ): Promise<ResolveResult | null> {
    if (!this.congressApiKey) return null;
    const apiUrl = congressMeetingApiUrl(ref, this.congressApiKey);
    try {
      const { status, text } = await guardedFetchText(apiUrl);
      if (status !== 200) return null;
      const payload = JSON.parse(text);
      const videoUrls = extractCongressVideoUrls(payload);
      for (const v of videoUrls) {
        // YouTube link from videos[] → pass as REFERENCE unless the YT flag is on.
        if (/youtube\.com|youtu\.be/i.test(v) && !this.enableYoutubeLive) {
          return {
            status: 'unresolvable',
            reference: v,
            note: 'Congress.gov links a YouTube video; YouTube extraction disabled (RESOLVER_ENABLE_YOUTUBE_LIVE) — open it and paste the stream URL',
          };
        }
        const r = await this.resolve({ pageUrl: v }, depth + 1);
        if (r.status !== 'unresolvable') return r;
      }
      return null;
    } catch (err) {
      this.logger.warn(`congress videos lookup failed: ${(err as Error).message}`);
      return null;
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private unresolvableFrom(err: unknown, pageUrl: string, provider: string): ResolveResult {
    if (err instanceof SsrfError) {
      this.logger.warn(`resolve blocked (${provider}): ${err.message}`);
      return { status: 'unresolvable', note: `Blocked by network policy: ${err.message}` };
    }
    this.logger.warn(`resolve failed (${provider}) for ${pageUrl}: ${(err as Error).message}`);
    return {
      status: 'unresolvable',
      reference: pageUrl,
      note: `Could not resolve via ${provider}`,
    };
  }
}

/** Parse a boolean env flag: only "1"/"true"/"yes"/"on" (case-insensitive) enable. */
function envFlag(v: string | undefined): boolean {
  const s = (v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** Best-effort <title>/og:title from a page's HTML (for meta.title). */
function firstTitle(html: string): string | undefined {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return og[1]!.trim();
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return t ? t[1]!.trim() : undefined;
}
