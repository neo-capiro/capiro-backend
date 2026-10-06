import { buildStreamResolutionTargets } from './automatic-stream-resolver.js';
import type { ClassifiedStreamResolution } from './stream-resolution-policy.js';

export interface BlockedRecoveryCandidate {
  id: string;
  hearingId: string;
  sourceId: string;
  officialPageUrl: string;
  mediaUrl: string | null;
  /** Exact database timestamp text: JS Date would discard PostgreSQL microseconds. */
  firstSeenAt: string;
  updatedAt: string;
}

export interface BlockedRecoveryProbe {
  candidate: BlockedRecoveryCandidate;
  classified: ClassifiedStreamResolution;
  attemptedAt: Date;
}

/** Reuse the ordinary first-party target boundary, never an approval override. */
export function blockedRecoveryTarget(candidate: BlockedRecoveryCandidate): string | undefined {
  const url = candidate.mediaUrl ?? candidate.officialPageUrl;
  const target = buildStreamResolutionTargets({ officialPageUrl: url })[0];
  return target?.automaticProbeAllowed && target.policyHint === 'FIRST_PARTY_CANDIDATE'
    ? target.url
    : undefined;
}

// h/c/sc/src are fixed internal aliases; callers supply only a fixed SQL parameter.
// These predicates are reused at discovery, before probing, and under row locks.
export function blockedRecoveryCaptureSql(now: string): string {
  return `c.domain_status='BLOCKED' AND c.terminal_reason_code='CAPTURE_BLOCKED'
    AND c.resolution_state IN ('BROWSER_CAPTURE_ONLY','POLICY_BLOCKED','NO_PUBLIC_STREAM')
    AND c.resolution_reason_code IN ('YOUTUBE_BROWSER_ONLY','CSPAN_LICENSE_REQUIRED',
      'UNKNOWN_PROVIDER_REVIEW_REQUIRED','RESOLVER_NETWORK_POLICY_BLOCK','NO_MEDIA_DISCOVERED')
    AND c.last_resolution_at IS NOT NULL AND c.last_resolution_at < ${now}
    AND c.failure_code IS NULL AND c.failure_detail IS NULL
    AND c.actual_start IS NULL AND c.actual_end IS NULL
    AND c.captured_ms=0 AND c.captured_seconds=0 AND c.transcript_gap_seconds=0
    AND c.reconnect_count=0 AND c.fencing_token=0 AND c.gaps='[]'::jsonb
    AND c.worker_lease_owner IS NULL AND c.lease_acquired_at IS NULL
    AND c.deepgram_session_ref IS NULL
    AND h.visibility='public' AND h.canonical_hearing_id IS NULL
    AND h.event_status IN ('scheduled','in_progress')
    AND h.starts_at BETWEEN ${now} - interval '90 minutes' AND ${now} + interval '24 hours'
    AND NOT EXISTS (SELECT 1 FROM public_hearing_capture_attempt a WHERE a.capture_id=c.id)
    AND NOT EXISTS (SELECT 1 FROM public_hearing_transcript_segment t WHERE t.capture_id=c.id)
    AND NOT EXISTS (SELECT 1 FROM intel_public_hearing_audio_epoch e WHERE e.hearing_id=h.id)
    AND NOT EXISTS (SELECT 1 FROM public_hearing_capture_job j WHERE j.hearing_id=h.id AND j.job_type='capture')`;
}

export function blockedRecoveryCandidateSql(now: string): string {
  // An actual newly observed identity is required; updated_at refreshes cannot trigger recovery.
  // HTTPS official-source provenance and advertised target are checked independently.
  const officialHost =
    'https://([a-z0-9-]+[.])*(senate[.]gov|house[.]gov|congress[.]gov|flsenate[.]gov|flhouse[.]gov)(/|$)';
  const targetHost =
    'https://(([a-z0-9-]+[.])*(senate[.]gov|house[.]gov|congress[.]gov|flsenate[.]gov|flhouse[.]gov)|www-senate-gov-media-srs[.]akamaized[.]net|www-senate-gov-msl3archive[.]akamaized[.]net)(/|$)';
  return `sc.hearing_id=h.id AND sc.first_seen_at > c.last_resolution_at
    AND sc.first_seen_at <= ${now} AND (sc.expires_at IS NULL OR sc.expires_at > ${now})
    AND src.id=sc.source_id AND src.enabled
    AND src.source_url ~* '^${officialHost}'
    AND sc.official_page_url ~* '^${officialHost}'
    AND COALESCE(sc.media_url,sc.official_page_url) ~* '^${targetHost}'
    AND sc.capture_policy IN ('REVIEW_REQUIRED','SERVER_CAPTURE_ALLOWED')
    AND sc.resolution_state IN ('NOT_CHECKED','WAITING_FOR_STREAM','SOURCE_ERROR','READY')
    AND EXISTS (SELECT 1 FROM hearing_source_observation o
      WHERE o.hearing_id=h.id AND o.source_id=src.id AND o.last_seen_at >= sc.first_seen_at)`;
}

export function blockedRecoveryProbeDueSql(now: string): string {
  // The first new identity gets one immediate probe. Unready future sources
  // then follow the existing preflight checkpoints, so old blocked rows cannot
  // consume every bounded scan slot every minute before their next preflight checkpoint.
  return `(sc.last_probe_at IS NULL OR (
    sc.last_probe_at <= ${now} - interval '1 minute' AND (
      sc.resolution_state='READY' OR h.starts_at <= ${now} + interval '5 minutes' OR
      EXISTS (SELECT 1 FROM unnest(ARRAY[interval '24 hours',interval '1 hour',interval '15 minutes',interval '5 minutes']) lead_time
        WHERE h.starts_at-lead_time <= ${now} AND h.starts_at-lead_time > sc.last_probe_at)
    )))`;
}
