/**
 * Pure policy boundary between the existing browser-oriented resolver and the
 * future background capture orchestrator. It makes every outcome explicit and
 * prevents a resolved URL from being treated as permission to server-capture.
 */

export const STREAM_RESOLUTION_STATES = [
  'NOT_CHECKED',
  'WAITING_FOR_STREAM',
  'READY_FOR_SERVER_CAPTURE',
  'BROWSER_CAPTURE_ONLY',
  'NO_PUBLIC_STREAM',
  'POLICY_BLOCKED',
  'CANCELED',
  'SOURCE_ERROR',
] as const;
export type StreamResolutionState = (typeof STREAM_RESOLUTION_STATES)[number];

export const STREAM_CAPTURE_POLICIES = [
  'SERVER_CAPTURE_ALLOWED',
  'BROWSER_CAPTURE_ONLY',
  'LICENSE_REQUIRED',
  'BLOCKED',
  'REVIEW_REQUIRED',
] as const;
export type StreamCapturePolicy = (typeof STREAM_CAPTURE_POLICIES)[number];

export type StreamCoverageReasonCode =
  | 'SOURCE_PERMISSION_REVIEWED'
  | 'FIRST_PARTY_STREAM_READY'
  | 'STREAM_NOT_LIVE_YET'
  | 'DELAYED_START_GRACE_EXPIRED'
  | 'NO_MEDIA_DISCOVERED'
  | 'CLOSED_PROCEEDING'
  | 'CLASSIFIED_PROCEEDING'
  | 'EVENT_CANCELED'
  | 'EVENT_POSTPONED'
  | 'OFFICIAL_NOTICE_NO_STREAM'
  | 'YOUTUBE_BROWSER_ONLY'
  | 'CSPAN_LICENSE_REQUIRED'
  | 'UNKNOWN_PROVIDER_REVIEW_REQUIRED'
  | 'RESOLVER_NETWORK_POLICY_BLOCK'
  | 'RESOLVER_SOURCE_ERROR'
  | 'INVALID_RESOLVER_RESULT';

export interface ResolverMediaLike {
  url: string;
  kind: 'hls' | 'mp3' | 'mp4';
  provider: string;
  ipBound?: boolean;
  expiresAt?: string;
}

export interface ResolverResultLike {
  /** Set only by the internal canonical-event adapter after current grant checks. */
  reviewedSourcePermission?: boolean;
  status: 'resolved' | 'candidates' | 'pending' | 'unresolvable';
  media?: ResolverMediaLike;
  candidates?: Array<{ title: string; pageUrl: string; programId?: string }>;
  reference?: string;
  note?: string;
}

export interface StreamResolutionContext {
  now: Date;
  scheduledStart?: Date;
  delayedStartGraceMs?: number;
  eventStatus?: string;
  publicAccess?: string;
}

export interface ClassifiedStreamResolution {
  state: StreamResolutionState;
  capturePolicy: StreamCapturePolicy;
  reasonCode: StreamCoverageReasonCode;
  terminal: boolean;
  retryable: boolean;
  provider?: string;
  media?: ResolverMediaLike;
  reference?: string;
  note?: string;
  /** Worker must resolve again in its own egress environment before ingestion. */
  requiresJustInTimeReresolution: boolean;
  /** Short-lived/IP-bound media URLs must never become durable source truth. */
  mayPersistResolvedMediaUrl: boolean;
}

export function classifyStreamResolution(
  result: ResolverResultLike,
  context: StreamResolutionContext,
): ClassifiedStreamResolution {
  const eventStatus = (context.eventStatus ?? '').trim().toUpperCase();
  const publicAccess = (context.publicAccess ?? '').trim().toUpperCase();

  if (eventStatus === 'CANCELED' || eventStatus === 'CANCELLED') {
    return terminal('CANCELED', 'BLOCKED', 'EVENT_CANCELED', result);
  }
  if (eventStatus === 'POSTPONED') {
    return paused('WAITING_FOR_STREAM', 'BLOCKED', 'EVENT_POSTPONED', result);
  }
  if (publicAccess === 'CLASSIFIED') {
    return terminal('POLICY_BLOCKED', 'BLOCKED', 'CLASSIFIED_PROCEEDING', result);
  }
  if (publicAccess === 'CLOSED') {
    return terminal('POLICY_BLOCKED', 'BLOCKED', 'CLOSED_PROCEEDING', result);
  }
  if (publicAccess === 'NOT_STREAMED') {
    return terminal('NO_PUBLIC_STREAM', 'BLOCKED', 'OFFICIAL_NOTICE_NO_STREAM', result);
  }

  if (result.status === 'resolved' && result.media) {
    if (result.reviewedSourcePermission === true)
      return ready(result, result.media, 'SOURCE_PERMISSION_REVIEWED');
    const provider = result.media.provider.trim().toLowerCase();
    if (provider === 'cspan' || provider === 'c-span') {
      return terminal('POLICY_BLOCKED', 'LICENSE_REQUIRED', 'CSPAN_LICENSE_REQUIRED', result);
    }
    if (provider === 'youtube-live' || isYoutubeUrl(result.media.url)) {
      return terminal(
        'BROWSER_CAPTURE_ONLY',
        'BROWSER_CAPTURE_ONLY',
        'YOUTUBE_BROWSER_ONLY',
        result,
      );
    }
    if (provider === 'senate-isvp' || isApprovedCongressionalMediaUrl(result.media.url)) {
      return ready(result, result.media, 'FIRST_PARTY_STREAM_READY');
    }
    return terminal(
      'POLICY_BLOCKED',
      'REVIEW_REQUIRED',
      'UNKNOWN_PROVIDER_REVIEW_REQUIRED',
      result,
    );
  }

  if (result.status === 'pending') {
    if (delayedStartGraceExpired(context)) {
      return terminal('NO_PUBLIC_STREAM', 'BLOCKED', 'DELAYED_START_GRACE_EXPIRED', result);
    }
    return retryable(
      'WAITING_FOR_STREAM',
      capturePolicyForReference(result.reference),
      'STREAM_NOT_LIVE_YET',
      result,
    );
  }

  if (result.status === 'candidates') {
    const candidateUrls = result.candidates?.map((candidate) => candidate.pageUrl) ?? [];
    if (candidateUrls.length > 0 && candidateUrls.every(isCspanUrl)) {
      return terminal('POLICY_BLOCKED', 'LICENSE_REQUIRED', 'CSPAN_LICENSE_REQUIRED', result);
    }
    if (candidateUrls.length > 0 && candidateUrls.every(isYoutubeUrl)) {
      return terminal(
        'BROWSER_CAPTURE_ONLY',
        'BROWSER_CAPTURE_ONLY',
        'YOUTUBE_BROWSER_ONLY',
        result,
      );
    }
    return terminal(
      'POLICY_BLOCKED',
      'REVIEW_REQUIRED',
      'UNKNOWN_PROVIDER_REVIEW_REQUIRED',
      result,
    );
  }

  const combined = `${result.note ?? ''} ${result.reference ?? ''}`.toLowerCase();
  if (combined.includes('c-span') || combined.includes('cspan')) {
    return terminal('POLICY_BLOCKED', 'LICENSE_REQUIRED', 'CSPAN_LICENSE_REQUIRED', result);
  }
  if (combined.includes('youtube') || (result.reference && isYoutubeUrl(result.reference))) {
    return terminal('BROWSER_CAPTURE_ONLY', 'BROWSER_CAPTURE_ONLY', 'YOUTUBE_BROWSER_ONLY', result);
  }
  if (combined.includes('blocked by network policy')) {
    return retryable('SOURCE_ERROR', 'BLOCKED', 'RESOLVER_NETWORK_POLICY_BLOCK', result);
  }
  if (delayedStartGraceExpired(context)) {
    return terminal('NO_PUBLIC_STREAM', 'BLOCKED', 'NO_MEDIA_DISCOVERED', result);
  }
  if (result.status === 'unresolvable') {
    if (looksLikeResolverFailure(combined)) {
      return retryable('SOURCE_ERROR', 'REVIEW_REQUIRED', 'RESOLVER_SOURCE_ERROR', result);
    }
    return retryable(
      'WAITING_FOR_STREAM',
      capturePolicyForReference(result.reference),
      'NO_MEDIA_DISCOVERED',
      result,
    );
  }
  return terminal('SOURCE_ERROR', 'BLOCKED', 'INVALID_RESOLVER_RESULT', result);
}

function ready(
  result: ResolverResultLike,
  media: ResolverMediaLike,
  reasonCode: StreamCoverageReasonCode,
): ClassifiedStreamResolution {
  const shortLived = Boolean(media.ipBound || media.expiresAt);
  return {
    state: 'READY_FOR_SERVER_CAPTURE',
    capturePolicy: 'SERVER_CAPTURE_ALLOWED',
    reasonCode,
    terminal: false,
    retryable: false,
    provider: media.provider,
    media,
    reference: result.reference,
    note: result.note,
    requiresJustInTimeReresolution: true,
    mayPersistResolvedMediaUrl: !shortLived,
  };
}

function retryable(
  state: StreamResolutionState,
  capturePolicy: StreamCapturePolicy,
  reasonCode: StreamCoverageReasonCode,
  result: ResolverResultLike,
): ClassifiedStreamResolution {
  return {
    state,
    capturePolicy,
    reasonCode,
    terminal: false,
    retryable: true,
    reference: result.reference,
    note: result.note,
    requiresJustInTimeReresolution: true,
    mayPersistResolvedMediaUrl: false,
  };
}

function paused(
  state: StreamResolutionState,
  capturePolicy: StreamCapturePolicy,
  reasonCode: StreamCoverageReasonCode,
  result: ResolverResultLike,
): ClassifiedStreamResolution {
  return {
    state,
    capturePolicy,
    reasonCode,
    terminal: false,
    retryable: false,
    reference: result.reference,
    note: result.note,
    requiresJustInTimeReresolution: false,
    mayPersistResolvedMediaUrl: false,
  };
}

function terminal(
  state: StreamResolutionState,
  capturePolicy: StreamCapturePolicy,
  reasonCode: StreamCoverageReasonCode,
  result: ResolverResultLike,
): ClassifiedStreamResolution {
  return {
    state,
    capturePolicy,
    reasonCode,
    terminal: true,
    retryable: false,
    provider: result.media?.provider,
    reference: result.reference,
    note: result.note,
    requiresJustInTimeReresolution: false,
    mayPersistResolvedMediaUrl: false,
  };
}

function delayedStartGraceExpired(context: StreamResolutionContext): boolean {
  if (!context.scheduledStart) return false;
  const graceMs = Math.max(0, context.delayedStartGraceMs ?? 90 * 60 * 1000);
  return context.now.getTime() > context.scheduledStart.getTime() + graceMs;
}

function capturePolicyForReference(reference: string | undefined): StreamCapturePolicy {
  return reference && isApprovedCongressionalPageUrl(reference)
    ? 'SERVER_CAPTURE_ALLOWED'
    : 'REVIEW_REQUIRED';
}

function looksLikeResolverFailure(combinedMessage: string): boolean {
  return /could not resolve|resolution recursion limit|invalid page url|lookup failed|fetch failed|source error|http 5\d\d|timeout|timed out|dns|econn|network error|socket|aborted/.test(
    combinedMessage,
  );
}

function isApprovedCongressionalPageUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return (
      hostname === 'senate.gov' ||
      hostname.endsWith('.senate.gov') ||
      hostname === 'house.gov' ||
      hostname.endsWith('.house.gov') ||
      hostname === 'congress.gov' ||
      hostname.endsWith('.congress.gov') ||
      hostname === 'docs.house.gov'
    );
  } catch {
    return false;
  }
}

function isApprovedCongressionalMediaUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return (
      hostname === 'senate.gov' ||
      hostname.endsWith('.senate.gov') ||
      hostname === 'house.gov' ||
      hostname.endsWith('.house.gov') ||
      hostname === 'congress.gov' ||
      hostname.endsWith('.congress.gov') ||
      hostname === 'www-senate-gov-media-srs.akamaized.net' ||
      hostname === 'www-senate-gov-msl3archive.akamaized.net'
    );
  } catch {
    return false;
  }
}

function isYoutubeUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return (
      hostname === 'youtu.be' || hostname === 'youtube.com' || hostname.endsWith('.youtube.com')
    );
  } catch {
    return false;
  }
}

function isCspanUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return (
      hostname === 'c-span.org' ||
      hostname.endsWith('.c-span.org') ||
      hostname === 'c-spanvideo.org' ||
      hostname.endsWith('.c-spanvideo.org')
    );
  } catch {
    return false;
  }
}
