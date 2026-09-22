import { normalizeOfficialUrl, type HearingVideoReference } from './hearing-video-reference.js';
import { isFloridaStatePublisherUrl, stateCaptureEnabled } from '../state-capture-policy.js';
import {
  classifyStreamResolution,
  type ClassifiedStreamResolution,
  type ResolverResultLike,
  type StreamResolutionContext,
} from './stream-resolution-policy.js';

export type StreamResolutionTargetKind = 'OFFICIAL_PAGE' | 'MEDIA_REFERENCE';

export interface StreamResolutionTarget {
  url: string;
  kind: StreamResolutionTargetKind;
  priority: number;
  providerHint?: string;
  automaticProbeAllowed: boolean;
  policyHint:
    | 'FIRST_PARTY_CANDIDATE'
    | 'BROWSER_ONLY'
    | 'LICENSE_REQUIRED'
    | 'REVIEW_REQUIRED';
}

export interface AutomaticStreamResolverPort {
  resolve(input: { pageUrl?: string; hearingId?: string }): Promise<ResolverResultLike>;
}

export interface AutomaticStreamResolutionAttempt {
  target: StreamResolutionTarget;
  rawResult: ResolverResultLike;
  outcome: ClassifiedStreamResolution;
  skipped: boolean;
}

export interface AutomaticStreamResolutionResult {
  selected: ClassifiedStreamResolution;
  /** Raw provider result selected by the ranking pass. Kept in memory only. */
  rawResult: ResolverResultLike;
  selectedTarget?: StreamResolutionTarget;
  attempts: AutomaticStreamResolutionAttempt[];
}

export interface AutomaticStreamResolverOptions {
  maxAttempts?: number;
}

/**
 * Resolve the official event page and every source-provided video reference in
 * priority order. Browser-only/licensed candidates do not stop the search for a
 * first-party stream. Unknown media hosts are retained as review evidence but
 * are not fetched automatically.
 */
export class AutomaticStreamResolver {
  private readonly maxAttempts: number;

  constructor(
    private readonly resolver: AutomaticStreamResolverPort,
    options: AutomaticStreamResolverOptions = {},
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 12);
  }

  async resolve(input: {
    hearingId: string;
    officialPageUrl?: string;
    videos?: readonly HearingVideoReference[];
    context: StreamResolutionContext;
  }): Promise<AutomaticStreamResolutionResult> {
    const targets = buildStreamResolutionTargets(input).slice(0, this.maxAttempts);
    const attempts: AutomaticStreamResolutionAttempt[] = [];
    let best:
      | {
          target?: StreamResolutionTarget;
          rawResult: ResolverResultLike;
          outcome: ClassifiedStreamResolution;
        }
      | undefined;

    for (const target of targets) {
      if (!target.automaticProbeAllowed) {
        const rawResult: ResolverResultLike =
          target.policyHint === 'BROWSER_ONLY'
            ? {
                status: 'unresolvable',
                reference: target.url,
                note: 'YouTube browser-only source',
              }
            : target.policyHint === 'LICENSE_REQUIRED'
              ? {
                  status: 'unresolvable',
                  reference: target.url,
                  note: 'C-SPAN license required',
                }
              : {
                  status: 'unresolvable',
                  reference: target.url,
                  note: 'Unknown provider review required',
                };
        const outcome = classifyStreamResolution(rawResult, input.context);
        attempts.push({ target, rawResult, outcome, skipped: true });
        best = chooseBetter(best, { target, rawResult, outcome });
        continue;
      }

      let rawResult: ResolverResultLike;
      try {
        rawResult = await this.resolver.resolve({
          pageUrl: target.url,
          hearingId: input.hearingId,
        });
      } catch (error) {
        rawResult = {
          status: 'unresolvable',
          reference: target.url,
          note: `Could not resolve via automatic target: ${boundedError(error)}`,
        };
      }
      const outcome = classifyStreamResolution(rawResult, input.context);
      attempts.push({ target, rawResult, outcome, skipped: false });
      if (outcome.state === 'READY_FOR_SERVER_CAPTURE') {
        return { selected: outcome, rawResult, selectedTarget: target, attempts };
      }
      best = chooseBetter(best, { target, rawResult, outcome });
    }

    if (best) {
      return {
        selected: best.outcome,
        rawResult: best.rawResult,
        selectedTarget: best.target,
        attempts,
      };
    }
    const rawResult: ResolverResultLike = {
      status: 'unresolvable',
      reference: input.officialPageUrl,
      note: 'No stream found on the committee page',
    };
    return {
      selected: classifyStreamResolution(rawResult, input.context),
      rawResult,
      attempts,
    };
  }
}

export function buildStreamResolutionTargets(input: {
  officialPageUrl?: string;
  videos?: readonly HearingVideoReference[];
}): StreamResolutionTarget[] {
  const output = new Map<string, StreamResolutionTarget>();
  const add = (rawUrl: string | undefined, kind: StreamResolutionTargetKind, providerHint?: string) => {
    const url = safeHttpsUrl(rawUrl);
    if (!url) return;
    const classified = classifyTarget(url, kind, providerHint);
    const previous = output.get(url);
    if (!previous || classified.priority > previous.priority) output.set(url, classified);
  };

  add(input.officialPageUrl, 'OFFICIAL_PAGE');
  for (const video of input.videos ?? []) add(video.url, 'MEDIA_REFERENCE', video.providerHint);
  return [...output.values()].sort(
    (left, right) => right.priority - left.priority || left.url.localeCompare(right.url),
  );
}

function classifyTarget(
  url: string,
  kind: StreamResolutionTargetKind,
  providerHint?: string,
): StreamResolutionTarget {
  const host = new URL(url).hostname.toLowerCase();
  const hint = providerHint?.trim().toLowerCase();
  if (isYoutubeHost(host)) {
    return {
      url,
      kind,
      priority: 70,
      providerHint: hint ?? host,
      automaticProbeAllowed: false,
      policyHint: 'BROWSER_ONLY',
    };
  }
  if (isCspanHost(host)) {
    return {
      url,
      kind,
      priority: 60,
      providerHint: hint ?? host,
      automaticProbeAllowed: false,
      policyHint: 'LICENSE_REQUIRED',
    };
  }
  if (isApprovedOfficialHost(host) || (stateCaptureEnabled() && isFloridaStatePublisherUrl(url))) {
    return {
      url,
      kind,
      priority: kind === 'MEDIA_REFERENCE' ? 130 : 110,
      providerHint: hint ?? host,
      automaticProbeAllowed: true,
      policyHint: 'FIRST_PARTY_CANDIDATE',
    };
  }
  return {
    url,
    kind,
    priority: 30,
    providerHint: hint ?? host,
    automaticProbeAllowed: false,
    policyHint: 'REVIEW_REQUIRED',
  };
}

function chooseBetter(
  current:
    | {
        target?: StreamResolutionTarget;
        rawResult: ResolverResultLike;
        outcome: ClassifiedStreamResolution;
      }
    | undefined,
  candidate: {
    target?: StreamResolutionTarget;
    rawResult: ResolverResultLike;
    outcome: ClassifiedStreamResolution;
  },
) {
  if (!current) return candidate;
  const rank = (outcome: ClassifiedStreamResolution): number => {
    switch (outcome.state) {
      case 'READY_FOR_SERVER_CAPTURE':
        return 100;
      case 'WAITING_FOR_STREAM':
        return 90;
      case 'BROWSER_CAPTURE_ONLY':
        return 80;
      case 'NO_PUBLIC_STREAM':
        return 70;
      case 'SOURCE_ERROR':
        return 60;
      case 'POLICY_BLOCKED':
        return 50;
      case 'CANCELED':
        return 40;
      case 'NOT_CHECKED':
        return 0;
    }
  };
  const currentRank = rank(current.outcome);
  const candidateRank = rank(candidate.outcome);
  if (candidateRank !== currentRank) return candidateRank > currentRank ? candidate : current;
  const currentPriority = current.target?.priority ?? 0;
  const candidatePriority = candidate.target?.priority ?? 0;
  return candidatePriority > currentPriority ? candidate : current;
}

function safeHttpsUrl(value: string | undefined): string | undefined {
  const normalized = normalizeOfficialUrl(value);
  if (!normalized) return undefined;
  const url = new URL(normalized);
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  return url.toString();
}

function isApprovedOfficialHost(host: string): boolean {
  return (
    host === 'senate.gov' ||
    host.endsWith('.senate.gov') ||
    host === 'house.gov' ||
    host.endsWith('.house.gov') ||
    host === 'congress.gov' ||
    host.endsWith('.congress.gov') ||
    host === 'www-senate-gov-media-srs.akamaized.net' ||
    host === 'www-senate-gov-msl3archive.akamaized.net'
  );
}

function isYoutubeHost(host: string): boolean {
  return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
}

function isCspanHost(host: string): boolean {
  return (
    host === 'c-span.org' ||
    host.endsWith('.c-span.org') ||
    host === 'c-spanvideo.org' ||
    host.endsWith('.c-spanvideo.org')
  );
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 500);
}
