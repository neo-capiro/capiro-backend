import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { StreamResolverService } from '../stream-resolver.service.js';
import {
  approvedPublicCapture,
  publicAudioEnabled,
} from './public-capture-permission.js';
import {
  AutomaticStreamResolver,
  type AutomaticStreamResolutionResult,
} from './automatic-stream-resolver.js';
import type { HearingVideoReference } from './hearing-video-reference.js';
import type { PublicStreamResolverPort } from './public-capture.orchestrator.js';
import {
  classifyStreamResolution,
  type ResolverResultLike,
  type StreamResolutionState,
} from './stream-resolution-policy.js';
import {
  capturableHearingView,
  isFloridaStatePublisherUrl,
  STATE_CAPTURE_LINK_ONLY,
  stateCaptureEnabled,
} from '../state-capture-policy.js';

interface HearingContextRow {
  id: string;
  eventStatus: string;
  publicAccess: string;
  /** Timed start when present; otherwise the calendar date (UTC midnight). */
  scheduledStart: Date | null;
  officialPageUrl: string | null;
}

interface CandidateRow {
  provider: string;
  officialPageUrl: string;
  mediaUrl: string | null;
  expiresAt: Date | null;
}

/**
 * Phase 5 resolver used by both scheduler preflight and the capture worker.
 *
 * It loads every currently-known source candidate for the canonical hearing,
 * applies the automatic policy/ranking layer, and invokes the existing guarded
 * provider resolver only for approved first-party targets. The worker calls the
 * same adapter again in its own egress environment, so an URL selected by
 * scheduler preflight is never trusted as the runtime ingest URL.
 */
@Injectable()
export class PublicCaptureAutomaticResolverAdapter implements PublicStreamResolverPort {
  private readonly logger = new Logger(PublicCaptureAutomaticResolverAdapter.name);
  private readonly automatic: AutomaticStreamResolver;

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StreamResolverService,
  ) {
    this.automatic = new AutomaticStreamResolver(resolver);
  }

  async resolve(input: { pageUrl?: string; hearingId?: string }): Promise<ResolverResultLike> {
    const result = await this.resolveInternal(input);
    return result.rawResult;
  }

  /**
   * Same resolution/persistence path as {@link resolve}, but returns the full
   * classified result (state/reasonCode/terminal) instead of just the raw
   * provider payload. Used by callers that need to report WHICH terminal
   * disposition was reached (e.g. the historical disposition backfill) —
   * this does not fork or duplicate the policy: it is the identical
   * automatic.resolve() + persistAudit() call `resolve()` already makes,
   * just returning more of what that call already computed.
   */
  async resolveClassified(input: {
    pageUrl?: string;
    hearingId?: string;
  }): Promise<AutomaticStreamResolutionResult> {
    return this.resolveInternal(input);
  }

  private async resolveInternal(input: {
    pageUrl?: string;
    hearingId?: string;
  }): Promise<AutomaticStreamResolutionResult> {
    const hearingId = input.hearingId?.trim();
    const stateCapture = stateCaptureEnabled();
    if (!stateCapture && isFloridaStatePublisherUrl(input.pageUrl)) {
      return unresolvedShell({
        status: 'unresolvable',
        reference: safeReference(input.pageUrl),
        note: STATE_CAPTURE_LINK_ONLY,
      });
    }
    if (!hearingId) {
      return unresolvedShell({
        status: 'unresolvable',
        reference: safeReference(input.pageUrl),
        note: 'Canonical hearing id is required for automatic capture resolution',
      });
    }

    if (!stateCapture) {
      const state = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM committee_hearing
         WHERE id=$1 AND geographic_jurisdiction IS NOT NULL
           AND geographic_jurisdiction<>'US'
         LIMIT 1`,
        hearingId,
      );
      if (state.length) {
        return unresolvedShell({
          status: 'unresolvable',
          reference: safeReference(input.pageUrl),
          note: STATE_CAPTURE_LINK_ONLY,
        });
      }
    }

    const hearing = await this.loadHearing(hearingId);
    if (!hearing) {
      return unresolvedShell({
        status: 'unresolvable',
        reference: safeReference(input.pageUrl),
        note: `Canonical hearing not found: ${hearingId}`,
      });
    }
    const videos = await this.loadVideoReferences(hearingId, new Date());
    if (publicAudioEnabled() && (await approvedPublicCapture(this.prisma, hearingId)).length) {
      const attempts: AutomaticStreamResolutionResult['attempts'] = [];
      // Existing guarded provider resolution still validates every fetch/redirect.
      // With state capture off, state hearings have already returned above and
      // approvedPublicCapture() independently refuses every non-US jurisdiction.
      for (const url of [
        ...new Set(
          [hearing.officialPageUrl, ...videos.map((v) => v.url)].filter((v): v is string =>
            Boolean(v),
          ),
        ),
      ].slice(0, 12)) {
        const raw = await this.resolver.resolve({ pageUrl: url });
        const rawResult = { ...raw, reviewedSourcePermission: raw.status === 'resolved' };
        const outcome = classifyStreamResolution(rawResult, {
          now: new Date(),
          scheduledStart: hearing.scheduledStart ?? undefined,
          eventStatus: hearing.eventStatus,
          publicAccess: hearing.publicAccess,
        });
        const target = {
          url,
          kind: 'OFFICIAL_PAGE' as const,
          priority: attempts.length,
          automaticProbeAllowed: true,
          policyHint: 'FIRST_PARTY_CANDIDATE' as const,
        };
        attempts.push({ target, rawResult, outcome, skipped: false });
        if (outcome.state === 'READY_FOR_SERVER_CAPTURE') {
          const result = { selected: outcome, rawResult, selectedTarget: target, attempts };
          await this.persistAudit(hearingId, result, new Date());
          return result;
        }
      }
      if (attempts.length) {
        const last = attempts.at(-1)!;
        const result = { selected: last.outcome, rawResult: last.rawResult, attempts };
        await this.persistAudit(hearingId, result, new Date());
        return result;
      }
    }
    const result = await this.automatic.resolve({
      hearingId,
      officialPageUrl: input.pageUrl ?? hearing.officialPageUrl ?? undefined,
      videos,
      context: {
        now: new Date(),
        scheduledStart: hearing.scheduledStart ?? undefined,
        eventStatus: hearing.eventStatus,
        publicAccess: hearing.publicAccess,
      },
    });

    try {
      await this.persistAudit(hearingId, result, new Date());
    } catch (error) {
      // Capture resolution remains usable, but the missing audit write is loud
      // in logs and the next preflight will try again.
      this.logger.warn(
        `could not persist stream-resolution audit hearing=${hearingId}: ${boundedError(error)}`,
      );
    }
    return result;
  }

  private async loadHearing(hearingId: string): Promise<HearingContextRow | null> {
    // COALESCE starts_at → date so delayed-start grace can expire for the large
    // class of historical congress.gov rows that only carry a calendar date
    // (starts_at IS NULL). Without this, classifyStreamResolution() leaves
    // NO_MEDIA_DISCOVERED as non-terminal WAITING_FOR_STREAM forever, and the
    // disposition-backfill re-selects the same rows on every batch.
    const rows = await this.prisma.$queryRawUnsafe<HearingContextRow[]>(
      `SELECT id,
              event_status AS "eventStatus",
              CASE WHEN visibility='private' THEN 'CLOSED' ELSE 'PUBLIC' END AS "publicAccess",
              COALESCE(starts_at, date::timestamptz) AS "scheduledStart",
              url AS "officialPageUrl"
       FROM ${capturableHearingView()}
       WHERE id=$1
       LIMIT 1`,
      hearingId,
    );
    return rows[0] ?? null;
  }

  private async loadVideoReferences(
    hearingId: string,
    now: Date,
  ): Promise<HearingVideoReference[]> {
    const rows = await this.prisma.$queryRawUnsafe<CandidateRow[]>(
      `SELECT provider,
              official_page_url AS "officialPageUrl",
              media_url AS "mediaUrl",
              expires_at AS "expiresAt"
       FROM hearing_stream_candidate
       WHERE hearing_id=$1
       ORDER BY priority ASC, updated_at DESC, id ASC`,
      hearingId,
    );
    const output = new Map<string, HearingVideoReference>();
    for (const row of rows) {
      const official = safeReference(row.officialPageUrl);
      if (official) output.set(official, { url: official, providerHint: row.provider });
      const media = safeReference(row.mediaUrl ?? undefined);
      if (media && (!row.expiresAt || row.expiresAt.getTime() > now.getTime())) {
        output.set(media, { url: media, providerHint: row.provider });
      }
    }
    return [...output.values()];
  }

  private async persistAudit(
    hearingId: string,
    result: AutomaticStreamResolutionResult,
    now: Date,
  ): Promise<void> {
    for (const attempt of result.attempts) {
      const candidateState = candidateResolutionState(attempt.outcome.state);
      const updated = await this.prisma.$executeRawUnsafe(
        `UPDATE hearing_stream_candidate
         SET resolution_state=$3,
             capture_policy=$4,
             last_probe_at=$5,
             failure_reason=$6,
             updated_at=$5
         WHERE hearing_id=$1
           AND (official_page_url=$2 OR media_url=$2)`,
        hearingId,
        attempt.target.url,
        candidateState,
        attempt.outcome.capturePolicy,
        now,
        attempt.outcome.state === 'READY_FOR_SERVER_CAPTURE'
          ? null
          : bounded(
              `${attempt.outcome.reasonCode}${attempt.outcome.note ? `: ${attempt.outcome.note}` : ''}`,
              1_000,
            ),
      );
      // UPDATE alone is a no-op when no prior candidate row exists (the common
      // case for demand-free disposition / historical backfill). READINESS
      // STREAM_PATH_EXPLICIT treats coverage_status='stream_ready' as
      // NON-terminal, so a READY_FOR_SERVER_CAPTURE result with zero candidate
      // rows still increments unresolvedEvents and is re-selected forever by
      // disposition-backfill. Persist the real selected first-party target as
      // a candidate only when the resolver actually found one — never invent
      // a synthetic candidate from thin air.
      if (
        Number(updated) === 0 &&
        attempt.outcome.state === 'READY_FOR_SERVER_CAPTURE' &&
        !attempt.skipped
      ) {
        await this.insertReadyCandidate(hearingId, attempt, result, now);
      }
    }

    // Also ensure the selected READY outcome leaves a durable candidate even
    // when attempts[] was empty or only contained skipped browser-only rows
    // (selected can still be READY via a direct first-party probe).
    if (result.selected.state === 'READY_FOR_SERVER_CAPTURE') {
      const existing = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM hearing_stream_candidate WHERE hearing_id=$1`,
        hearingId,
      );
      if ((existing[0]?.count ?? 0) === 0 && result.selectedTarget) {
        await this.insertReadyCandidate(
          hearingId,
          {
            target: result.selectedTarget,
            rawResult: result.rawResult,
            outcome: result.selected,
            skipped: false,
          },
          result,
          now,
        );
      }
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE committee_hearing
       SET coverage_status=$2,
           stream_availability=$3,
           synced_at=$4
       WHERE id=$1`,
      hearingId,
      hearingCoverageStatus(result.selected.state),
      hearingStreamAvailability(result.selected.state),
      now,
    );
  }

  /**
   * Insert one real hearing_stream_candidate for a READY first-party result.
   * official_page_url is required by schema; media_url is optional and only
   * written when the resolver returned durable (non-IP-bound) media.
   */
  private async insertReadyCandidate(
    hearingId: string,
    attempt: AutomaticStreamResolutionResult['attempts'][number],
    result: AutomaticStreamResolutionResult,
    now: Date,
  ): Promise<void> {
    const officialPageUrl =
      attempt.target.kind === 'OFFICIAL_PAGE'
        ? attempt.target.url
        : (safeReference(result.rawResult.reference) ?? safeReference(attempt.target.url) ?? null);
    if (!officialPageUrl) return;

    const media = attempt.outcome.media ?? result.selected.media;
    const mediaUrl =
      media && attempt.outcome.mayPersistResolvedMediaUrl
        ? (safeReference(media.url) ?? null)
        : attempt.target.kind === 'MEDIA_REFERENCE'
          ? (safeReference(attempt.target.url) ?? null)
          : null;
    const provider =
      (media?.provider || attempt.target.providerHint || 'unknown').trim() || 'unknown';
    const mediaType = media?.kind ?? null;

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO hearing_stream_candidate (
         id, hearing_id, provider, official_page_url, media_url, media_type,
         priority, resolution_state, capture_policy,
         first_seen_at, last_probe_at, created_at, updated_at
       )
       SELECT gen_random_uuid()::text, $1, $2, $3, $4, $5,
              100, 'READY', 'SERVER_CAPTURE_ALLOWED',
              $6, $6, $6, $6
       WHERE NOT EXISTS (
         SELECT 1 FROM hearing_stream_candidate
         WHERE hearing_id=$1
           AND (official_page_url=$3 OR ($4::text IS NOT NULL AND media_url=$4))
       )`,
      hearingId,
      bounded(provider, 120),
      officialPageUrl,
      mediaUrl,
      mediaType,
      now,
    );
  }
}

function candidateResolutionState(state: StreamResolutionState): string {
  switch (state) {
    case 'READY_FOR_SERVER_CAPTURE':
      return 'READY';
    case 'WAITING_FOR_STREAM':
      return 'WAITING_FOR_STREAM';
    case 'NO_PUBLIC_STREAM':
      return 'NO_PUBLIC_STREAM';
    case 'SOURCE_ERROR':
      return 'SOURCE_ERROR';
    case 'BROWSER_CAPTURE_ONLY':
    case 'POLICY_BLOCKED':
    case 'CANCELED':
      return 'POLICY_BLOCKED';
    case 'NOT_CHECKED':
      return 'NOT_CHECKED';
  }
}

function hearingCoverageStatus(state: StreamResolutionState): string {
  switch (state) {
    case 'READY_FOR_SERVER_CAPTURE':
      return 'stream_ready';
    case 'NO_PUBLIC_STREAM':
      return 'no_public_stream';
    case 'BROWSER_CAPTURE_ONLY':
    case 'POLICY_BLOCKED':
    case 'CANCELED':
      return 'blocked';
    case 'WAITING_FOR_STREAM':
    case 'SOURCE_ERROR':
    case 'NOT_CHECKED':
      return 'discovered';
  }
}

function hearingStreamAvailability(state: StreamResolutionState): string {
  switch (state) {
    case 'READY_FOR_SERVER_CAPTURE':
      return 'live_only';
    case 'NO_PUBLIC_STREAM':
      return 'none';
    case 'BROWSER_CAPTURE_ONLY':
      return 'embedded_third_party';
    case 'POLICY_BLOCKED':
    case 'CANCELED':
    case 'WAITING_FOR_STREAM':
    case 'SOURCE_ERROR':
    case 'NOT_CHECKED':
      return 'unknown';
  }
}

function safeReference(value?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function bounded(value: string, max: number): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function boundedError(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error), 1_000);
}

/// Builds a full AutomaticStreamResolutionResult shell for the two early-exit
/// cases (no hearingId supplied / hearing not found) that never reach
/// AutomaticStreamResolver.resolve(). Runs the raw result through the SAME
/// classifyStreamResolution() policy every other path uses, so a caller
/// reading `.selected.state` never has to special-case these shells versus a
/// normal resolution outcome.
function unresolvedShell(rawResult: ResolverResultLike): AutomaticStreamResolutionResult {
  return {
    selected: classifyStreamResolution(rawResult, { now: new Date() }),
    rawResult,
    attempts: [],
  };
}
