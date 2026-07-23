import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Read access to the auto-captured Senate hearing corpus.
 *
 * The intel_senate_* tables are GLOBAL and RLS-free (public-domain transcripts),
 * so — unlike the tenant-private intel_live_hearing_* tables — these are PLAIN
 * prisma reads with NO tenant filter and NO withSystem/RLS-bypass boundary
 * crossing. Access is gated purely by the hearing_watch feature flag on the
 * controller: any enabled tenant sees the same shared corpus; a tenant without
 * the flag gets a 404 from the guard. Per-tenant relevance (watchlist matching)
 * is layered on top of this read at a later stage — never written onto the rows.
 */

export interface SenateCaptureSummary {
  id: string;
  hearingKey: string;
  committeeName: string | null;
  title: string | null;
  hearingType: string | null;
  status: string;
  scheduledAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  segmentCount: number;
}

export interface SenateTranscriptSegmentView {
  startMs: number;
  endMs: number;
  speakerLabel: string | null;
  text: string;
}

export interface SenateTranscriptView extends SenateCaptureSummary {
  segments: SenateTranscriptSegmentView[];
}

type CaptureRowWithCount = {
  id: string;
  hearingKey: string;
  committeeName: string | null;
  title: string | null;
  hearingType: string | null;
  status: string;
  scheduledAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  _count: { segments: number };
};

@Injectable()
export class SenateTranscriptReadService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List captured Senate hearings. `scope`:
   *   live   → currently live/capturing
   *   recent → live/capturing/ended (the useful feed)
   *   all    → everything incl. pending/discovered/skipped (default)
   */
  async list(opts: { scope?: string; limit?: number }): Promise<SenateCaptureSummary[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const scope = opts.scope ?? 'all';
    const where =
      scope === 'live'
        ? { status: { in: ['live', 'capturing'] } }
        : scope === 'recent'
          ? { status: { in: ['live', 'capturing', 'ended'] } }
          : {};
    const rows = await this.prisma.senateHearingCapture.findMany({
      where,
      orderBy: [
        { startedAt: { sort: 'desc', nulls: 'last' } },
        { scheduledAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      take: limit,
      include: { _count: { select: { segments: true } } },
    });
    return rows.map(toSummary);
  }

  /** One captured hearing + its full transcript (segments ordered by start). */
  async get(id: string): Promise<SenateTranscriptView | null> {
    const row = await this.prisma.senateHearingCapture.findUnique({
      where: { id },
      include: {
        _count: { select: { segments: true } },
        segments: {
          orderBy: { startMs: 'asc' },
          select: { startMs: true, endMs: true, speakerLabel: true, textPlain: true },
        },
      },
    });
    if (!row) return null;
    return {
      ...toSummary(row),
      segments: row.segments.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        speakerLabel: s.speakerLabel,
        text: s.textPlain,
      })),
    };
  }
}

function toSummary(row: CaptureRowWithCount): SenateCaptureSummary {
  return {
    id: row.id,
    hearingKey: row.hearingKey,
    committeeName: row.committeeName,
    title: row.title,
    hearingType: row.hearingType,
    status: row.status,
    scheduledAt: row.scheduledAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    segmentCount: row._count.segments,
  };
}
