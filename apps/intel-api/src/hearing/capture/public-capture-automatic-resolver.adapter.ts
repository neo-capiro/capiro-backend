import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { StreamResolverService } from '../stream-resolver.service.js';
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

interface HearingContextRow {
  id: string;
  eventStatus: string;
  publicAccess: string;
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
    resolver: StreamResolverService,
  ) {
    this.automatic = new AutomaticStreamResolver(resolver);
  }

  async resolve(input: {
    pageUrl?: string;
    hearingId?: string;
  }): Promise<ResolverResultLike> {
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
    if (!hearingId) {
      return unresolvedShell({
        status: 'unresolvable',
        reference: safeReference(input.pageUrl),
        note: 'Canonical hearing id is required for automatic capture resolution',
      });
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
    const rows = await this.prisma.$queryRawUnsafe<HearingContextRow[]>(
      `SELECT id,
              event_status AS "eventStatus",
              CASE WHEN visibility='private' THEN 'CLOSED' ELSE 'PUBLIC' END AS "publicAccess",
              starts_at AS "scheduledStart",
              url AS "officialPageUrl"
       FROM committee_hearing
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
      await this.prisma.$executeRawUnsafe(
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
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
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
