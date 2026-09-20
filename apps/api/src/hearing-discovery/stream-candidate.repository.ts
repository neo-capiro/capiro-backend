/**
 * `hearing_stream_candidate` persistence — Phase 3 scope only.
 *
 * SCOPE BOUNDARY, deliberate: this file records the stream candidates an
 * OFFICIAL SOURCE ADVERTISES (the video link on a Congress.gov event record, the
 * player on a committee page). It never probes a URL, never follows a redirect,
 * never extracts a media manifest, and never asserts
 * `capture_policy = SERVER_CAPTURE_ALLOWED`. Every row it writes lands as
 * `resolution_state = NOT_CHECKED` with a conservative policy.
 *
 * Actual resolution — Senate ISVP extraction, direct-media validation, the SSRF
 * net-guard, and the YouTube / C-SPAN legal gates — already exists and works in
 * `apps/intel-api/src/hearing/stream-resolver.service.ts` +
 * `net-guard.ts`. Phase 4 wires THAT resolver to these rows. Re-implementing any
 * of it here would fork the security boundary, so this module only ever
 * DOWNGRADES a candidate's policy, never upgrades one.
 *
 * Page origin and media origin stay separate columns: a `.gov` page embedding
 * YouTube is not a first-party media transport, and conflating the two is how a
 * third-party stream gets mistaken for a capturable one.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { CapturePolicy, ObservedStreamCandidate } from './hearing-discovery.types.js';

/**
 * Media hosts that must never be auto-promoted to server capture. The authority
 * for the live decision is intel-api's net-guard; this list exists so a
 * discovery-time row is not written in a state that LOOKS capturable before the
 * resolver has ever run.
 */
const THIRD_PARTY_MEDIA_HOSTS: Array<{ pattern: RegExp; provider: string; policy: CapturePolicy }> =
  [
    {
      pattern: /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i,
      provider: 'youtube',
      policy: 'BROWSER_CAPTURE_ONLY',
    },
    { pattern: /(^|\.)c-span\.org$|(^|\.)cspan\.org$/i, provider: 'c-span', policy: 'BLOCKED' },
    { pattern: /(^|\.)facebook\.com$/i, provider: 'facebook', policy: 'BLOCKED' },
    { pattern: /(^|\.)x\.com$|(^|\.)twitter\.com$/i, provider: 'x', policy: 'BLOCKED' },
    { pattern: /(^|\.)vimeo\.com$/i, provider: 'vimeo', policy: 'BROWSER_CAPTURE_ONLY' },
  ];

/** First-party congressional media hosts. Still only REVIEW_REQUIRED here. */
const FIRST_PARTY_HOSTS = /(^|\.)senate\.gov$|(^|\.)house\.gov$|(^|\.)congress\.gov$/i;

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Conservative discovery-time classification. Returns the provider label and the
 * strictest policy consistent with what we can see WITHOUT fetching anything.
 * `REVIEW_REQUIRED` is the ceiling: nothing in Phase 3 may declare a stream
 * server-capturable.
 */
export function classifyObservedCandidate(candidate: ObservedStreamCandidate): {
  provider: string;
  capturePolicy: CapturePolicy;
  mediaType: string | null;
} {
  const mediaHost = hostOf(candidate.mediaUrl ?? null);
  const pageHost = hostOf(candidate.officialPageUrl);
  // Media host decides policy when there is one; otherwise the page host, since
  // an embed's transport is whatever the page loads.
  const decidingHost = mediaHost ?? pageHost;

  for (const entry of THIRD_PARTY_MEDIA_HOSTS) {
    if (decidingHost && entry.pattern.test(decidingHost)) {
      return {
        provider: candidate.provider || entry.provider,
        capturePolicy: strictest(entry.policy, candidate.capturePolicy),
        mediaType: candidate.mediaType ?? 'third_party_embed',
      };
    }
  }

  const mediaType =
    candidate.mediaType ??
    (candidate.mediaUrl && /\.m3u8(\?|$)/i.test(candidate.mediaUrl)
      ? 'hls'
      : candidate.mediaUrl && /\.mp4(\?|$)/i.test(candidate.mediaUrl)
        ? 'mp4'
        : candidate.mediaUrl
          ? 'unknown'
          : null);

  const provider =
    candidate.provider ||
    (decidingHost && FIRST_PARTY_HOSTS.test(decidingHost)
      ? firstPartyProvider(decidingHost)
      : 'unknown');

  return {
    provider,
    capturePolicy: strictest('REVIEW_REQUIRED', candidate.capturePolicy),
    mediaType,
  };
}

function firstPartyProvider(host: string): string {
  if (/senate\.gov$/i.test(host)) return 'senate-isvp';
  if (/house\.gov$/i.test(host)) return 'house-live';
  return 'congress-gov';
}

/** Policy lattice, strict-wins. Never returns SERVER_CAPTURE_ALLOWED from here. */
const POLICY_RANK: Record<CapturePolicy, number> = {
  BLOCKED: 0,
  LICENSE_REQUIRED: 1,
  BROWSER_CAPTURE_ONLY: 2,
  REVIEW_REQUIRED: 3,
  SERVER_CAPTURE_ALLOWED: 4,
};

function strictest(a: CapturePolicy, b: CapturePolicy | undefined): CapturePolicy {
  const candidate = b && POLICY_RANK[b] < POLICY_RANK[a] ? b : a;
  // Hard ceiling: discovery may not grant server capture, whatever an adapter says.
  return candidate === 'SERVER_CAPTURE_ALLOWED' ? 'REVIEW_REQUIRED' : candidate;
}

export class StreamCandidateRepository {
  constructor(private readonly prisma: PrismaClient | Prisma.TransactionClient) {}

  /**
   * Record advertised candidates for a hearing. Idempotent on (hearing,
   * provider, media-or-page URL) — the table has no natural unique key, so the
   * repository enforces one rather than letting every discovery run append a
   * duplicate candidate.
   *
   * An existing row's `resolution_state` and `capture_policy` are NOT reset: once
   * Phase 4's resolver has probed a candidate, a re-run of discovery must not
   * knock it back to NOT_CHECKED and cause a re-probe storm.
   */
  async recordCandidates(
    hearingId: string,
    candidates: ObservedStreamCandidate[],
    opts: { now: Date; sourceId?: string | null },
  ): Promise<{ created: number; refreshed: number }> {
    let created = 0;
    let refreshed = 0;
    for (const raw of candidates) {
      if (!raw.officialPageUrl) continue;
      const cls = classifyObservedCandidate(raw);
      const existing = await this.prisma.hearingStreamCandidate.findFirst({
        where: {
          hearingId,
          provider: cls.provider,
          ...(raw.mediaUrl
            ? { mediaUrl: raw.mediaUrl }
            : { officialPageUrl: raw.officialPageUrl, mediaUrl: null }),
        },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.hearingStreamCandidate.update({
          where: { id: existing.id },
          data: {
            officialPageUrl: raw.officialPageUrl,
            mediaType: cls.mediaType,
            ...(raw.mediaUrl ? { mediaUrl: raw.mediaUrl } : {}),
          },
        });
        refreshed += 1;
        continue;
      }
      await this.prisma.hearingStreamCandidate.create({
        data: {
          hearingId,
          provider: cls.provider,
          officialPageUrl: raw.officialPageUrl,
          mediaUrl: raw.mediaUrl ?? null,
          mediaType: cls.mediaType,
          priority: raw.priority ?? defaultPriority(cls.provider),
          resolutionState: 'NOT_CHECKED',
          capturePolicy: cls.capturePolicy,
          sourceId: opts.sourceId ?? null,
          firstSeenAt: opts.now,
        },
      });
      created += 1;
    }
    return { created, refreshed };
  }

  async countForHearing(hearingId: string): Promise<number> {
    return this.prisma.hearingStreamCandidate.count({ where: { hearingId } });
  }
}

/**
 * Priority ordering: first-party congressional transports outrank third-party
 * embeds, so Phase 4's resolver reaches for a `.gov` stream before it ever
 * considers a hosted player it may not legally capture.
 */
function defaultPriority(provider: string): number {
  if (provider === 'senate-isvp' || provider === 'house-live') return 10;
  if (provider === 'congress-gov') return 20;
  if (provider === 'unknown') return 80;
  return 60;
}
