import { Injectable, Logger } from '@nestjs/common';
import {
  SourceDataRepository,
  type UpcomingCommitteeHearing,
} from '../sourcedata/source-data.repository.js';

export interface UpcomingHearing {
  id: string;
  title: string;
  committee: string;
  chamber: string;
  scheduledAt: string; // date-only ISO 'YYYY-MM-DD' (committee_hearing.date has no time)
  time?: string | null; // display string, e.g. "10:00 AM"
  type?: string | null; // hearing, markup, meeting
  location?: string | null;
  url?: string | null;
}

/**
 * Upcoming public hearings feed (H-C). Reads the ENRICHED, forward-looking
 * committee-meeting schedule from the GLOBAL `committee_hearing` table
 * (populated daily by apps/api `sync-hearings`, cron 06:45 UTC) via the
 * read-only SourceDataRepository.
 *
 * Why not fetch Congress.gov directly: the v3 `committee-meeting` LIST endpoint
 * is minimal (eventId, chamber, url only) — it carries NO title/committee/date.
 * The prior implementation read those absent fields off the list stub, so every
 * row collapsed to title="Committee meeting", committee="Committee",
 * scheduledAt=now(). Real values require a per-meeting detail fan-out, which
 * apps/api already does daily and stores here. Sourcing from `committee_hearing`
 * gives distinct, accurate rows and drops the CONGRESS_API_KEY dependency for
 * this feed.
 *
 * Results are cached in-process for 15 minutes; the schedule changes slowly.
 */
@Injectable()
export class UpcomingHearingsService {
  private readonly logger = new Logger(UpcomingHearingsService.name);
  private cache: { at: number; data: UpcomingHearing[] } | null = null;
  private readonly ttlMs = 15 * 60 * 1000;
  private readonly limit = 50;

  constructor(private readonly source: SourceDataRepository) {}

  async list(): Promise<UpcomingHearing[]> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) {
      return this.cache.data;
    }
    try {
      const rows = await this.source.getUpcomingCommitteeHearings(this.limit);
      const data = rows.map((r) => toUpcoming(r));
      this.cache = { at: Date.now(), data };
      return data;
    } catch (err) {
      this.logger.error(`upcoming hearings read failed: ${(err as Error).message}`);
      // Serve stale cache if present, else empty (UI shows a graceful empty state).
      return this.cache?.data ?? [];
    }
  }
}

function toUpcoming(r: UpcomingCommitteeHearing): UpcomingHearing {
  return {
    id: r.id,
    title: robustTitle(r),
    committee: r.committeeName?.trim() || 'Committee',
    chamber: r.chamber?.trim() || '',
    scheduledAt: dateOnly(r.date),
    time: r.time ?? null,
    type: r.type ?? null,
    location: r.location ?? null,
    url: r.url ?? null,
  };
}

/** committee_hearing.date is a DATE (UTC midnight); render as 'YYYY-MM-DD' so the
 *  client formats a plain date without a spurious/timezone-shifted midnight time. */
function dateOnly(d: Date): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

/** Build a distinctive title. sync-hearings stores '(untitled)' for meetings with
 *  no title and may prefix a non-scheduled status like '[Postponed]'. When the
 *  body is missing/placeholder, synthesize "<Type>: <Committee>" so rows never
 *  collapse to an identical generic label. Any status prefix is preserved. */
function robustTitle(r: UpcomingCommitteeHearing): string {
  const raw = (r.title ?? '').trim();
  const statusMatch = raw.match(/^(\[[^\]]+\]\s*)/);
  const statusPrefix = statusMatch?.[1] ?? '';
  const body = raw.slice(statusPrefix.length).trim();
  if (body && body.toLowerCase() !== '(untitled)') return raw;
  const committee = r.committeeName?.trim() || 'Committee';
  return `${statusPrefix}${prettyType(r.type)}: ${committee}`.trim();
}

function prettyType(type: string | null): string {
  const t = (type ?? '').trim().toLowerCase();
  if (t.includes('markup')) return 'Markup';
  if (t.includes('hearing')) return 'Hearing';
  if (t.includes('meeting')) return 'Meeting';
  return 'Meeting';
}
