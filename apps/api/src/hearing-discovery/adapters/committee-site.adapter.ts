/**
 * Generic committee-site adapter (`committee-site`).
 *
 * Covers the long tail: per-committee `.house.gov` / `.senate.gov` sites, which
 * publish witnesses, testimony, memos, postponement notices and player embeds
 * days before any central feed does. There are ~46 congressional bodies and no
 * shared CMS, so this adapter is deliberately CONSERVATIVE rather than clever:
 * it extracts only what it can identify with a hard rule, and reports the rest
 * as "needs a custom adapter" for the coverage audit to escalate.
 *
 * WHY IT REFUSES TO GUESS: a discovery layer that invents a hearing from an
 * ambiguous link poisons the master calendar with events that do not exist, and
 * a fabricated date is worse than a missing one. So:
 *   - an announcement link is only emitted when a real date can be parsed from
 *     it or its text;
 *   - a document is only emitted when its href is a document and its text
 *     matches a known category;
 *   - a stream candidate is only emitted when the page actually references a
 *     player, and it is recorded UNPROBED at REVIEW_REQUIRED (see
 *     `stream-candidate.repository.ts` for why that ceiling is absolute).
 *
 * Per the plan's §8.3 hierarchy this is rung 3 (static HTML + ETag/Last-Modified
 * + content hash). Committees whose schedule is JavaScript-rendered cannot be
 * read here at all; they surface as CUSTOM_ADAPTER_REQUIRED rather than as a
 * silent zero.
 */
import { contentHash } from '../hearing-identity.js';
import { cleanText, fetchText, type ConditionalState } from './source-http.js';
import type {
  CanonicalHearingRef,
  CommitteeSourceAdapter,
  CommitteeUpdateObservation,
  DiscoveryContext,
  EventEnrichment,
  ObservedStreamCandidate,
  SiteUpdateType,
  SourceDescriptor,
  SourceEvent,
  SourceHealth,
} from '../hearing-discovery.types.js';

/** Anchor tags with their href and inner text. */
interface Anchor {
  href: string;
  text: string;
  newsIndex?: boolean;
}

const ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

/** Document categories we can name from link text with a hard rule. */
const DOCUMENT_CATEGORIES: Array<{ pattern: RegExp; updateType: SiteUpdateType }> = [
  {
    pattern: /\btestimony\b|\bstatement of\b|\bwritten statement\b/i,
    updateType: 'witness_testimony_published',
  },
  {
    pattern: /\bmemo(randum)?\b|\bbriefing (memo|paper)\b/i,
    updateType: 'committee_memo_published',
  },
  { pattern: /\btranscript\b/i, updateType: 'official_transcript_posted' },
];

const HEARING_LINK_RE =
  /\bhearing\b|\bmark\s?-?up\b|\bbusiness meeting\b|\bfull committee\b|\bsubcommittee\b/i;
const POSTPONE_RE = /\bpostponed\b|\brescheduled\b/i;
const CANCEL_RE = /\bcancell?ed\b/i;
const DOC_HREF_RE = /\.(pdf|docx?|htm|html)(\?|$)/i;

/** Third-party players and first-party embeds a committee page might carry. */
const EMBED_RE =
  /<iframe\b[^>]*src=["']([^"']+)["']|<video\b[^>]*src=["']([^"']+)["']|["'](https?:\/\/[^"']*\.m3u8[^"']*)["']/gi;

export interface CommitteeSiteAdapterOptions {
  /** Required for explicit state namespace news attribution. */
  stateCommitteeName?: (key: string) => string | undefined;
  committeeName?: (key: string) => string | undefined;
  /** Prior conditional-GET state per URL, so an unchanged page costs a 304. */
  priorState?: (url: string) => ConditionalState | undefined;
  /** Persist the new conditional state after a successful fetch. */
  saveState?: (url: string, state: ConditionalState) => void;
}

export class CommitteeSiteAdapter implements CommitteeSourceAdapter {
  readonly adapterKey = 'committee-site';
  readonly parserVersion = 'committee-site/2026-10-06';
  updateErrors: string[] = [];

  constructor(private readonly options: CommitteeSiteAdapterOptions = {}) {}

  /**
   * A generic committee landing page cannot be trusted to yield full events
   * (date + time + committee + title) — that is what the central feeds are for.
   * Returning [] here is the honest answer, and keeps this adapter from
   * inventing calendar entries. Its real value is `discoverUpdates` and
   * `enrichEvent`.
   */
  async discoverEvents(_source: SourceDescriptor, _ctx: DiscoveryContext): Promise<SourceEvent[]> {
    return [];
  }

  async discoverUpdates(
    source: SourceDescriptor,
    ctx: DiscoveryContext,
  ): Promise<CommitteeUpdateObservation[]> {
    this.updateErrors = [];
    const systemCode = source.committeeSystemCode;
    if (!systemCode) return [];
    const requiresAttribution =
      systemCode.startsWith('state:') ||
      new URL(source.sourceUrl).hostname === 'clerk.house.gov' ||
      (/^(www\.)?cha\.house\.gov$/.test(new URL(source.sourceUrl).hostname) &&
        systemCode !== 'hsha00');
    const stateName = requiresAttribution
      ? (this.options.committeeName?.(systemCode) ?? this.options.stateCommitteeName?.(systemCode))
      : null;
    if (requiresAttribution && !stateName)
      throw new Error('Shared committee source has no verified committee identity');
    const prior = this.options.priorState?.(source.sourceUrl);
    const res = await fetchText(source.sourceUrl, { prior, accept: 'text/html' });
    if (!res.ok) {
      throw new Error(`committee site fetch failed: ${res.error ?? `HTTP ${res.status}`}`);
    }
    this.options.saveState?.(source.sourceUrl, {
      etag: res.etag,
      lastModified: res.lastModified,
      contentHash: res.contentHash,
    });
    // Unchanged page: nothing to say. This is the branch that keeps a 15-minute
    // watcher from re-emitting the same facts 96 times a day.
    if (res.notModified || res.body == null) return [];

    const anchors = extractAnchors(res.body, source.sourceUrl);
    // Follow only news indexes actually linked by the official landing page.
    // Never invent endpoints or crawl an unbounded archive. A failed linked
    // index is a source failure, not a successful empty feed.
    const newsIndexes = [
      ...new Set(
        anchors
          .filter(
            (a) =>
              sameHost(a.href, source.sourceUrl) &&
              (isNewsIndex(a.href) ||
                (systemCode.startsWith('state:') &&
                  /^\/media\/?$/i.test(new URL(a.href).pathname))),
          )
          .map((a) => a.href),
      ),
    ]
      .filter((url) => url !== source.sourceUrl)
      .slice(0, 4);
    for (const url of newsIndexes) {
      const page = await fetchText(url, { accept: 'text/html' });
      if (!page.ok) {
        this.updateErrors.push(
          `committee news index fetch failed: ${url}: ${page.error ?? `HTTP ${page.status}`}`,
        );
        continue;
      }
      if (page.body)
        anchors.push(...extractAnchors(page.body, url).map((a) => ({ ...a, newsIndex: true })));
    }
    const updates: CommitteeUpdateObservation[] = [];
    const seen = new Set<string>();

    for (const a of anchors) {
      const text = a.text;
      if (!text || text.length < 8) continue;

      if (
        sameHost(a.href, source.sourceUrl) &&
        (isNewsArticle(a.href) ||
          ((a.newsIndex || newsIndexes.length > 0) && isDatedArticle(a.href)) ||
          (stateName && /press[_-]?release.*\.pdf$/i.test(a.href)))
      ) {
        if (
          (stateName && !headlineNamesCommittee(text, stateName)) ||
          /^(read more|learn more|view all|continue reading|accessibility|news|press releases?|latest news)$/i.test(
            text,
          )
        )
          continue;
        pushUnique(updates, seen, {
          committeeSystemCode: systemCode,
          updateType: 'committee_news_published',
          normalizedTitle: text.slice(0, 500),
          normalizedSummary: null,
          sourceUrl: a.href,
          officialPublishedAt: null,
          previousValue: null,
          newValue: null,
          parserVersion: this.parserVersion,
          contentHash: contentHash({
            systemCode,
            type: 'committee_news_published',
            href: newsIdentityUrl(a.href),
          }),
        });
        continue;
      }

      const category = DOCUMENT_CATEGORIES.find(
        (c) => c.pattern.test(text) && DOC_HREF_RE.test(a.href),
      );
      if (category) {
        pushUnique(updates, seen, {
          committeeSystemCode: systemCode,
          updateType: category.updateType,
          normalizedTitle: text.slice(0, 500),
          normalizedSummary: null,
          sourceUrl: a.href,
          officialPublishedAt: null,
          previousValue: null,
          newValue: null,
          parserVersion: this.parserVersion,
          contentHash: contentHash({ systemCode, type: category.updateType, href: a.href, text }),
        });
        continue;
      }

      if (!HEARING_LINK_RE.test(text)) continue;
      const status: SiteUpdateType | null = CANCEL_RE.test(text)
        ? 'canceled'
        : POSTPONE_RE.test(text)
          ? 'postponed'
          : null;
      const date = extractDate(text) ?? extractDate(a.href);
      // No date and no status wording: not enough to assert anything. Skipped
      // rather than filed as an announcement with a guessed day.
      if (!date && !status) continue;
      pushUnique(updates, seen, {
        committeeSystemCode: systemCode,
        updateType: status ?? 'hearing_announced',
        normalizedTitle: text.slice(0, 500),
        normalizedSummary: date ? `Official notice dated ${date}.` : null,
        sourceUrl: a.href,
        officialPublishedAt: null,
        previousValue: null,
        newValue: date ?? null,
        parserVersion: this.parserVersion,
        contentHash: contentHash({
          systemCode,
          type: status ?? 'hearing_announced',
          href: a.href,
          date: date ?? null,
        }),
      });
    }
    if (this.updateErrors.length && !updates.length) throw new Error(this.updateErrors.join('; '));
    ctx.log(
      `[committee-site] ${systemCode}: ${anchors.length} anchors, ${updates.length} normalized updates`,
    );
    return updates;
  }

  /**
   * Enrich a known canonical hearing from its official event page. Only fetches
   * a page on the SAME host as the registered committee source, so a
   * hearing whose `url` points at congress.gov or a third party is never
   * fetched by this adapter under a committee's identity.
   */
  async enrichEvent(
    source: SourceDescriptor,
    hearing: CanonicalHearingRef,
    ctx: DiscoveryContext,
  ): Promise<EventEnrichment | null> {
    const pageUrl = hearing.officialPageUrl;
    if (!pageUrl || !sameHost(pageUrl, source.sourceUrl)) return null;
    const res = await fetchText(pageUrl, {
      prior: this.options.priorState?.(pageUrl),
      accept: 'text/html',
    });
    if (!res.ok) {
      throw new Error(`event page fetch failed: ${res.error ?? `HTTP ${res.status}`}`);
    }
    this.options.saveState?.(pageUrl, {
      etag: res.etag,
      lastModified: res.lastModified,
      contentHash: res.contentHash,
    });
    if (res.notModified || res.body == null) return null;

    const anchors = extractAnchors(res.body, pageUrl);
    const documents = anchors
      .filter((a) => DOC_HREF_RE.test(a.href) && a.text.length >= 8)
      .slice(0, 50)
      .map((a) => ({ title: a.text.slice(0, 300), url: a.href, publishedAt: null }));

    const witnesses = extractWitnesses(res.body);
    const streamCandidates = extractEmbeds(res.body, pageUrl);
    ctx.log(
      `[committee-site] enrich ${hearing.id}: ${witnesses.length} witnesses, ` +
        `${documents.length} documents, ${streamCandidates.length} stream candidates`,
    );
    return {
      witnesses: witnesses.length ? witnesses : undefined,
      documents: documents.length ? documents : undefined,
      streamCandidates: streamCandidates.length ? streamCandidates : undefined,
      officialPageUrl: pageUrl,
      raw: { parser: this.parserVersion },
    };
  }

  async healthCheck(source: SourceDescriptor): Promise<SourceHealth> {
    const res = await fetchText(source.sourceUrl, { accept: 'text/html', timeoutMs: 15_000 });
    return {
      ok: res.ok,
      status: res.status,
      durationMs: res.durationMs,
      error: res.error,
      observedEvents: res.body ? extractAnchors(res.body, source.sourceUrl).length : null,
    };
  }
}

function pushUnique(
  out: CommitteeUpdateObservation[],
  seen: Set<string>,
  update: CommitteeUpdateObservation,
): void {
  if (seen.has(update.contentHash)) return;
  seen.add(update.contentHash);
  out.push(update);
}

/** Anchors with absolute hrefs; javascript:/mailto:/# are dropped. */
export function extractAnchors(html: string, baseUrl: string): Anchor[] {
  const out: Anchor[] = [];
  ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const rawHref = m[1] ?? '';
    const text = cleanText(m[2] ?? '');
    if (!rawHref || /^(javascript:|mailto:|tel:|#)/i.test(rawHref)) continue;
    const href = absolutize(rawHref, baseUrl);
    if (!href) continue;
    out.push({ href, text });
  }
  return out;
}

function absolutize(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

// These patterns identify CMS publication paths, not political keywords in a
// headline. Landing/category/archive links are excluded from article records.
const NEWS_SEGMENT =
  /^(news|newsroom|press|press-?releases?(?:-republican|-democratic)?|releases?|majority-news|minority-news|(?:republican|democratic)pressreleases(?:-redirect)?)$/i;
const NEWS_CATEGORY =
  /^(all|archive|archives|page|pages|majority|minority|republican|democrat|republican-news|democratic-news|press-contacts|press-releases?|releases?|news|newsroom|media|statements)$/i;
function newsPath(url: string): { parts: string[]; query: URLSearchParams } | null {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    return { parts: parsed.pathname.split('/').filter(Boolean), query: parsed.searchParams };
  } catch {
    return null;
  }
}
export function isNewsIndex(url: string): boolean {
  const path = newsPath(url);
  if (!path || path.query.size) return false;
  const index = path.parts.findIndex((part) => NEWS_SEGMENT.test(part));
  return index >= 0 && path.parts.slice(index + 1).every((part) => NEWS_CATEGORY.test(part));
}
export function isNewsArticle(url: string): boolean {
  const path = newsPath(url);
  if (!path) return false;
  // House CMS uses /news/documentsingle.aspx?DocumentID=12345.
  if (
    path.parts.some((part) => NEWS_SEGMENT.test(part)) &&
    (NEWS_SEGMENT.test(path.parts.at(-1) ?? '') ||
      /^documentsingle\.aspx$/i.test(path.parts.at(-1) ?? '')) &&
    [...path.query].some(
      ([key, value]) => /^(documentid|contentid|id)$/i.test(key) && /^[a-z0-9-]+$/i.test(value),
    )
  )
    return true;
  const index = path.parts.findIndex((part) => NEWS_SEGMENT.test(part));
  if (index < 0 || index === path.parts.length - 1) return false;
  const last = path.parts.at(-1)!;
  return (
    !NEWS_CATEGORY.test(last) &&
    !/^(\d{1,4}|index(?:\.html?|\.aspx)?|documentsingle\.aspx|pressreleases\.aspx|feed|rss(?:\.xml)?)$/i.test(
      last,
    ) &&
    !/\.(pdf|docx?|xml|aspx)$/i.test(last) &&
    last.length >= 8
  );
}

export function headlineNamesCommittee(headline: string, name: string): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const fullName = normalize(name);
  // Single topic words such as "Agriculture" are not evidence of attribution.
  const candidates = /\bcommittee\b/.test(fullName)
    ? [fullName]
    : [`${fullName} committee`, `committee on ${fullName}`];
  const text = ` ${normalize(headline)} `;
  return candidates.some((candidate) => text.includes(` ${candidate} `));
}
function newsIdentityUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = 'https:';
  parsed.hostname = parsed.hostname.replace(/^www\./, '');
  parsed.hash = '';
  const identifiers = [...parsed.searchParams].filter(([key]) =>
    /^(id|documentid|contentid)$/i.test(key),
  );
  parsed.search = '';
  for (const [key, value] of identifiers)
    parsed.searchParams.set(key.toLowerCase(), value.toLowerCase());
  return parsed.toString();
}
function isDatedArticle(url: string): boolean {
  const path = newsPath(url);
  return Boolean(
    path &&
    /^\d{4}$/.test(path.parts[0] ?? '') &&
    /^\d{1,2}$/.test(path.parts[1] ?? '') &&
    ((/^\d{1,2}$/.test(path.parts[2] ?? '') && (path.parts[3]?.length ?? 0) >= 8) ||
      (path.parts.length === 3 && (path.parts[2]?.length ?? 0) >= 8)),
  );
}

function sameHost(a: string, b: string): boolean {
  try {
    return (
      new URL(a).hostname.toLowerCase().replace(/^www\./, '') ===
      new URL(b).hostname.toLowerCase().replace(/^www\./, '')
    );
  } catch {
    return false;
  }
}

const MONTHS =
  '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)';

/**
 * A date, only in forms that cannot be mistaken for something else:
 * `2026-09-17`, `09/17/2026`, or `September 17, 2026`. A bare `9/17` is
 * deliberately NOT accepted — without a year it would be filed against the
 * wrong one half the time.
 */
export function extractDate(text: string): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return iso[0];
  const us = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text);
  if (us && us[1] && us[2] && us[3]) {
    return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  const long = new RegExp(`\\b${MONTHS}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i').exec(text);
  if (long && long[1] && long[2] && long[3]) {
    const month = monthNumber(long[1]);
    if (month) return `${long[3]}-${String(month).padStart(2, '0')}-${long[2].padStart(2, '0')}`;
  }
  return null;
}

function monthNumber(name: string): number | null {
  const idx = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ].indexOf(name.slice(0, 3).toLowerCase());
  return idx >= 0 ? idx + 1 : null;
}

/**
 * Witness names from a page's witness block. Requires an explicit "Witness(es)"
 * heading — scraping every list item on a committee page would return navigation
 * links as witnesses. Bounded, and empty when the heading is absent.
 */
export function extractWitnesses(html: string): string[] {
  const start = /witness(es)?\s*(:|<\/)/i.exec(html);
  if (!start) return [];
  const window = html.slice(start.index, start.index + 8000);
  const items = window.match(/<li\b[^>]*>([\s\S]*?)<\/li>/gi) ?? [];
  const out: string[] = [];
  for (const item of items) {
    const text = cleanText(item);
    // A witness line is a person, not a sentence or a nav label.
    if (text.length < 6 || text.length > 200) continue;
    if (!/[A-Z][a-z]+\s+[A-Z]/.test(text)) continue;
    out.push(text);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * Player references on a page. Recorded UNPROBED — this function never fetches
 * the URL, never follows it, and never decides whether it is capturable.
 */
export function extractEmbeds(html: string, pageUrl: string): ObservedStreamCandidate[] {
  const out: ObservedStreamCandidate[] = [];
  const seen = new Set<string>();
  EMBED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMBED_RE.exec(html)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (!raw) continue;
    const url = absolutize(raw, pageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    // An .m3u8 reference is a media URL; an iframe/video src is a player page
    // unless it is itself a manifest. Keeping page origin and media origin in
    // separate fields is what stops a .gov page that embeds YouTube from looking
    // like a first-party transport.
    if (/\.m3u8(\?|$)/i.test(url)) {
      // A manifest is real media, advertised by the committee's own page.
      out.push({
        provider: 'unknown',
        officialPageUrl: pageUrl,
        mediaUrl: url,
        mediaType: 'hls',
      });
    } else {
      // A player embed: the EMBED's own URL is the page origin that matters, so
      // the resolver can see which host the player came from. No media URL is
      // claimed, because we have not looked inside the player.
      out.push({
        provider: 'unknown',
        officialPageUrl: url,
        mediaUrl: null,
        mediaType: 'third_party_embed',
        priority: 70,
      });
    }
    if (out.length >= 10) break;
  }
  return out;
}
