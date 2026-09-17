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
  extractDocsHouseEventLinks,
  extractFloridaHouseNoticeDate,
  extractHouseCommitteeEventLinks,
  findFloridaHouseVideoPlayerForMeeting,
  floridaHouseDailyScheduleUrl,
  houseDocsEventUrl,
  houseEventIdMatches,
  extractYoutubeHlsManifest,
  findIsvpInHtml,
  findLiteralMediaInHtml,
  findYoutubeIdInHtml,
  isRequestRejectedPage,
  parseCongressEventUrl,
  parseCspanProgramId,
  parseCspanSearchResults,
  parseFloridaHouseNoticeUrl,
  parseFloridaHouseVideoPlayerPageUrl,
  parseFloridaSenateVideoPlayerUrl,
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
 * URL (never the original, which could 302 off-allowlist). The server does not
 * ingest that URL: it is handed to the analyst's browser to PLAY, and
 * transcription comes from the tab audio they then share. `googlevideo.com` is on
 * the allowlist only when
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
          // Return the FINAL post-redirect URL (guardedProbe re-validated every
          // hop) — NOT the original, which may 302 off-allowlist.
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
      // A DIRECT docs.house.gov repository event link carries the exact
      // EventID in its query — enter the same bounded fallback chain instead
      // of a blind generic scan (the docs page itself never embeds media).
      if (
        host === 'docs.house.gov' &&
        /\/Committee\/Calendar\/ByEvent\.aspx$/i.test(new URL(pageUrl).pathname)
      ) {
        const ev = new URL(pageUrl).searchParams.get('EventID');
        if (ev && /^\d+$/.test(ev)) {
          const fallback = await this.tryHouseDocsFallback(ev, depth);
          if (fallback) return fallback;
          return {
            status: 'unresolvable',
            reference: pageUrl,
            note: `No verified committee video for House repository event ${ev} — open the docs page`,
          };
        }
      }
      return this.resolveCommitteePage(pageUrl, depth);
    }
    // (7) Florida House notice → daily schedule VideoPlayer pairing.
    if (/(^|\.)flhouse\.gov$/i.test(host)) {
      return this.resolveFloridaHouseNotice(pageUrl, depth);
    }
    // (8) Florida Senate media player — the page itself is the stable
    // first-party reference; no network needed and no media URL is invented.
    if (/(^|\.)flsenate\.gov$/i.test(host)) {
      return this.resolveFloridaSenatePlayer(pageUrl);
    }
    // (9) The Florida Channel per-event page — same browser-capture posture:
    // the exact /videos/<slug>/ page is the stable publisher reference. TFC is
    // never server-captured and no media URL is extracted here.
    if (host === 'thefloridachannel.org') {
      return this.resolveFloridaChannelVideo(pageUrl);
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

  private async resolveCommitteePage(
    pageUrl: string,
    depth: number,
    preFetchedHtml?: string,
  ): Promise<ResolveResult> {
    let text: string;
    if (preFetchedHtml !== undefined) {
      // REUSE HTML the caller already fetched + verified (e.g. the House docs
      // fallback's exact-id check) — refetching would spend network calls
      // OUTSIDE that caller's deadline/page budget.
      text = preFetchedHtml;
    } else {
      try {
        ({ text } = await guardedFetchText(pageUrl));
      } catch (err) {
        return this.unresolvableFrom(err, pageUrl, 'committee-page');
      }
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
      // For House events, still run the bounded docs.house.gov fallback — the
      // official record usually still has video even when the API is absent.
      if (ref.chamber === 'house') {
        const fallback = await this.tryHouseDocsFallback(ref.eventId, depth);
        if (fallback) return fallback;
      }
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'CONGRESS_API_KEY not set — cannot read congress.gov videos; open the event page',
      };
    }
    const r = await this.tryCongressVideos(ref, depth);
    if (r) return r;
    // Bounded first-party House fallback: a Congress.gov House event with an
    // empty videos[] used to dead-end at "No video links". The official record
    // usually still has video: docs.house.gov links the owning committee, and
    // the committee's own event page embeds the player. Every hop is keyed on
    // the EXACT Congress event id — never a title match, never a hardcoded id.
    if (ref.chamber === 'house') {
      const fallback = await this.tryHouseDocsFallback(ref.eventId, depth);
      if (fallback) return fallback;
    }
    return {
      status: 'unresolvable',
      reference: pageUrl,
      note: 'No video links on the congress.gov event',
    };
  }

  /**
   * Bounded first-party House fallback for a Congress event id with no
   * videos[] entry. Chain: docs.house.gov event page → committee source linked
   * there → that committee's hearing/event links → accept ONLY the event page
   * whose outgoing official repository/Congress event id EXACTLY matches.
   * Returns a verified committee/video reference even when YouTube server
   * extraction is disabled, so the frontend Open Source upgrade works.
   *
   * Bounded by a hard deadline and a page budget: at most `maxPages` fetches
   * and `deadlineMs` wall-clock across the whole chain.
   */
  private async tryHouseDocsFallback(
    eventId: string,
    depth: number,
    opts: { deadlineMs?: number; maxPages?: number } = {},
  ): Promise<ResolveResult | null> {
    if (depth > 3) return null;
    const deadlineMs = opts.deadlineMs ?? 20_000;
    const maxPages = opts.maxPages ?? 8;
    const started = Date.now();
    let pages = 0;
    let exhausted = false;

    // Cache lookup BEFORE any discovery: a previously verified, stable
    // first-party reference for this exact event id short-circuits the whole
    // chain (zero network calls). Never media — only official pages and exact
    // YouTube watch/embed references land in this cache.
    const cached = this.cachedHouseFallbackRef(eventId);
    if (cached) {
      return {
        status: 'unresolvable',
        reference: cached,
        note: `Verified House committee reference for Congress event ${eventId} (cached) — open the official player and share its tab audio`,
      };
    }

    /**
     * Budgeted fetch. EVERY network call this fallback makes goes through here,
     * and every call carries the SHARED ABSOLUTE DEADLINE (deadlineAt) so the
     * bound spans redirects and response reads — not just the first hop. Page
     * HTML is used in place (never refetched). Once the page budget or
     * deadline is exhausted, `exhausted` latches and the chain STOPS — no
     * further attempts are made.
     */
    const deadlineAt = started + deadlineMs;
    const fetchPage = async (url: string) => {
      if (exhausted) throw new Error('house docs fallback budget already exhausted');
      if (pages >= maxPages) {
        exhausted = true;
        throw new Error(`house docs fallback page budget exceeded (${maxPages})`);
      }
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        exhausted = true;
        throw new Error(`house docs fallback deadline exceeded (${deadlineMs}ms)`);
      }
      pages++;
      return guardedFetchText(url, {
        timeoutMs: Math.min(10_000, remaining),
        deadlineAt,
      });
    };

    const docsUrl = houseDocsEventUrl(eventId);
    let docsHtml: string;
    try {
      ({ text: docsHtml } = await fetchPage(docsUrl));
    } catch (err) {
      this.logger.warn(`house docs fallback fetch failed for ${docsUrl}: ${(err as Error).message}`);
      return null;
    }
    const committeeLinks = extractDocsHouseEventLinks(docsHtml);
    for (const committeeUrl of committeeLinks) {
      if (exhausted) break;
      let committeeHtml: string;
      try {
        ({ text: committeeHtml } = await fetchPage(committeeUrl));
      } catch (err) {
        if (exhausted) break;
        this.logger.warn(`house docs fallback committee fetch failed for ${committeeUrl}: ${(err as Error).message}`);
        continue;
      }
      // The docs page may link directly to the event page (not just the
      // committee homepage). Accept it immediately when the exact id matches.
      if (houseEventIdMatches(committeeHtml, eventId)) {
        // Use the ALREADY-FETCHED, verified HTML in place — no recursion and
        // no refetch outside the budget. The reference is the exact YouTube
        // watch URL when the page embeds that video, else the official page.
        const ytId = findYoutubeIdInHtml(committeeHtml);
        const reference = ytId ? youtubeWatchUrl(ytId) : committeeUrl;
        this.rememberHouseFallbackRef(eventId, reference);
        return {
          status: 'unresolvable',
          reference,
          note: `Verified House committee video for Congress event ${eventId} — open the official player and share its tab audio`,
        };
      }
      const origin = new URL(committeeUrl).origin;
      const eventLinks = extractHouseCommitteeEventLinks(committeeHtml, origin);
      for (const eventUrl of eventLinks) {
        if (exhausted) break;
        let eventHtml: string;
        try {
          ({ text: eventHtml } = await fetchPage(eventUrl));
        } catch (err) {
          if (exhausted) break;
          this.logger.warn(`house docs fallback event fetch failed for ${eventUrl}: ${(err as Error).message}`);
          continue;
        }
        if (!houseEventIdMatches(eventHtml, eventId)) continue;
        // Verified exact-id match. Use the SAME fetched HTML in place — no
        // recursion, no refetch. The reference is the exact YouTube watch URL
        // when the page embeds that video, else the official committee event
        // page itself. The browser opens the actual official/player URL — no
        // unprobed media is ever claimed resolved.
        const ytId = findYoutubeIdInHtml(eventHtml);
        const reference = ytId ? youtubeWatchUrl(ytId) : eventUrl;
        this.rememberHouseFallbackRef(eventId, reference);
        return {
          status: 'unresolvable',
          reference,
          note: `Verified House committee video for Congress event ${eventId} — open the official player and share its tab audio`,
        };
      }
    }
    return null;
  }

  /**
   * Small bounded TTL cache of VERIFIED committee references keyed by the
   * EXACT Congress event id. Only successful, exact-id-verified STABLE
   * references are cached — official committee pages or exact YouTube
   * watch/embed URLs — never media URLs (YouTube googlevideo manifests are
   * IP-bound and expire; senate probes 404 until gavel; CDN/signed URLs are
   * never cached). Bounded size, FIFO eviction.
   */
  private readonly houseFallbackRefCache = new Map<string, { ref: string; expiresAt: number }>();
  private static readonly HOUSE_FALLBACK_REF_TTL_MS = 6 * 60 * 60 * 1000; // 6h
  private static readonly HOUSE_FALLBACK_REF_MAX = 64;

  private rememberHouseFallbackRef(eventId: string, ref: string): void {
    const cache = this.houseFallbackRefCache;
    if (cache.has(eventId)) cache.delete(eventId);
    while (cache.size >= StreamResolverService.HOUSE_FALLBACK_REF_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(eventId, {
      ref,
      expiresAt: Date.now() + StreamResolverService.HOUSE_FALLBACK_REF_TTL_MS,
    });
  }

  /** A cached verified reference for an event id, or null when absent/expired. */
  cachedHouseFallbackRef(eventId: string): string | null {
    const entry = this.houseFallbackRefCache.get(eventId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.houseFallbackRefCache.delete(eventId);
      return null;
    }
    return entry.ref;
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

  // ── (7) Florida House notice → VideoPlayer pairing ─────────────────────────

  /**
   * The flhouse.gov WAF answers the guarded default Chrome UA with a 200 +
   * ~244-byte "Request Rejected" page, while the same guarded fetch with a
   * plain `node` UA returns the real notice (matching hearing discovery's
   * native fetch). This is a NARROW, honest per-host header — not a guard
   * bypass: host allowlist, IP deny, redirects, size and timeout all still
   * apply unchanged.
   */
  private fetchFloridaGovText(url: string) {
    return guardedFetchText(url, { headers: { 'user-agent': 'node' } });
  }

  /**
   * Resolve a Florida House meeting notice to its official VideoPlayer page.
   * The notice itself does not carry the player link; the daily schedule page
   * for the same date pairs the exact MeetingId with a VideoPlayer link.
   * Bounded: one notice fetch + one daily schedule fetch, keyed on the exact
   * MeetingId — never a title or neighbor match.
   */
  private async resolveFloridaHouseNotice(pageUrl: string, depth: number): Promise<ResolveResult> {
    if (depth > 3) return { status: 'unresolvable', note: 'Resolution recursion limit reached' };
    // A direct VideoPlayer page URL is itself the stable first-party
    // reference — validated structurally, no network, no invented media.
    const directPlayer = parseFloridaHouseVideoPlayerPageUrl(pageUrl);
    if (directPlayer) {
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: `Verified Florida House VideoPlayer event ${directPlayer.eventId} — open the official player and share its tab audio`,
      };
    }
    const notice = parseFloridaHouseNoticeUrl(pageUrl);
    if (!notice) {
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'Unrecognized Florida House meeting notice URL',
      };
    }
    let noticeRes: { status: number; url: string; text: string };
    try {
      noticeRes = await this.fetchFloridaGovText(pageUrl);
    } catch (err) {
      return this.unresolvableFrom(err, pageUrl, 'florida-house-notice');
    }
    if (isRequestRejectedPage(noticeRes.text, noticeRes.status)) {
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'Florida House rejected the automated fetch (publisher bot policy) — open the notice page directly',
      };
    }
    const date = extractFloridaHouseNoticeDate(noticeRes.text);
    if (!date) {
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'Florida House notice lacks a qualified calendar date',
      };
    }
    const scheduleUrl = floridaHouseDailyScheduleUrl(date);
    let scheduleRes: { status: number; url: string; text: string };
    try {
      scheduleRes = await this.fetchFloridaGovText(scheduleUrl);
    } catch (err) {
      return this.unresolvableFrom(err, scheduleUrl, 'florida-house-schedule');
    }
    if (isRequestRejectedPage(scheduleRes.text, scheduleRes.status)) {
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'Florida House rejected the automated schedule fetch (publisher bot policy) — open the daily schedule directly',
      };
    }
    const playerUrl = findFloridaHouseVideoPlayerForMeeting(scheduleRes.text, notice.meetingId);
    if (!playerUrl) {
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: `No VideoPlayer paired with Florida House notice ${notice.meetingId} on ${date}`,
      };
    }
    // The player page is a browser playback page; return it as a verified
    // reference so the frontend can open it directly and share its tab audio
    // (direct HLS extraction is not available from the Florida House player).
    return {
      status: 'unresolvable',
      reference: playerUrl,
      note: `Verified Florida House VideoPlayer for notice ${notice.meetingId} — open the official player and share its tab audio`,
    };
  }

  // ── (8) Florida Senate media player ────────────────────────────────────────

  /**
   * A known Florida Senate media player URL (`/media/VideoPlayer/{id}`) is
   * itself the stable first-party reference. The exact numeric id is validated
   * structurally; no network is needed and no media URL is invented — the
   * analyst opens the official player and shares its tab audio.
   */
  private resolveFloridaSenatePlayer(pageUrl: string): ResolveResult {
    const player = parseFloridaSenateVideoPlayerUrl(pageUrl);
    if (!player) {
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'Unrecognized Florida Senate media player URL',
      };
    }
    return {
      status: 'unresolvable',
      reference: pageUrl,
      note: `Verified Florida Senate VideoPlayer event ${player.eventId} — open the official player and share its tab audio`,
    };
  }

  // ── (9) The Florida Channel per-event page ─────────────────────────────────

  /**
   * An exact The Florida Channel per-event page (`/videos/<slug>/`) is itself
   * the stable publisher reference — the same posture as the Florida Senate
   * player: validated structurally, no network, no invented media, no
   * server-side capture. The analyst opens the publisher player in a browser
   * tab and records that tab's audio; Deepgram only ever transcribes the
   * browser capture.
   *
   * Strictly scoped: HTTPS only, exact host, no credentials, no non-standard
   * port, and a slug matching the capture guard's policy
   * (`/^[a-z0-9][a-z0-9-]*$/`) so the resolver and the guard accept exactly
   * the same pages. The /videos/ index, other TFC paths, and other
   * hosts/subdomains are NOT accepted — they fall through to the generic
   * no-adapter outcome.
   */
  private resolveFloridaChannelVideo(pageUrl: string): ResolveResult {
    let url: URL;
    try {
      url = new URL(pageUrl);
    } catch {
      return { status: 'unresolvable', note: 'Invalid page URL' };
    }
    const slugMatch = /^\/videos\/([a-z0-9][a-z0-9-]*)\/?$/i.exec(url.pathname);
    const isExactEventPage =
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'thefloridachannel.org' &&
      !url.username &&
      !url.password &&
      (url.port === '' || url.port === '443') &&
      Boolean(slugMatch);
    if (!isExactEventPage) {
      return {
        status: 'unresolvable',
        reference: pageUrl,
        note: 'Not an exact The Florida Channel event page — open the event’s /videos/<slug>/ page in a browser tab and record that tab’s audio',
      };
    }
    return {
      status: 'unresolvable',
      reference: pageUrl,
      note: 'The Florida Channel event page — open the publisher player in a browser tab and record that tab’s audio (browser capture only; no server capture)',
    };
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
