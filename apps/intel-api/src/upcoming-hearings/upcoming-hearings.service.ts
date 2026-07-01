import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface UpcomingHearing {
  id: string;
  title: string;
  committee: string;
  chamber: string;
  scheduledAt: string;
  url?: string | null;
  location?: string | null;
}

/**
 * Upcoming public hearings feed (H-C). Pulls scheduled committee meetings from
 * the Congress.gov API (v3 committee-meeting endpoint). Requires CONGRESS_API_KEY;
 * without it the service returns an empty list (the UI shows a graceful empty
 * state) rather than erroring — the rest of Hearing Watch stays functional.
 *
 * Results are cached in-process for 30 minutes to stay well within the API's
 * rate limits; the feed changes slowly.
 */
@Injectable()
export class UpcomingHearingsService {
  private readonly logger = new Logger(UpcomingHearingsService.name);
  private readonly apiKey: string | undefined;
  private readonly root = 'https://api.congress.gov/v3/';
  private cache: { at: number; data: UpcomingHearing[] } | null = null;
  private readonly ttlMs = 30 * 60 * 1000;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('CONGRESS_API_KEY');
  }

  async list(): Promise<UpcomingHearing[]> {
    if (!this.apiKey) {
      this.logger.warn('CONGRESS_API_KEY unset — upcoming hearings feed returns empty');
      return [];
    }
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) {
      return this.cache.data;
    }
    try {
      const data = await this.fetchScheduled();
      this.cache = { at: Date.now(), data };
      return data;
    } catch (err) {
      this.logger.error(`upcoming hearings fetch failed: ${(err as Error).message}`);
      // Serve stale cache if present, else empty.
      return this.cache?.data ?? [];
    }
  }

  private async fetchScheduled(): Promise<UpcomingHearing[]> {
    const url = new URL('committee-meeting', this.root);
    url.searchParams.set('api_key', this.apiKey as string);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '40');
    url.searchParams.set('sort', 'updateDate+desc');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    let raw: Record<string, unknown>;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Congress.gov ${res.status}`);
      raw = (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }

    const meetings = Array.isArray(raw.committeeMeetings)
      ? (raw.committeeMeetings as Array<Record<string, unknown>>)
      : [];

    const now = Date.now();
    const out: UpcomingHearing[] = [];
    for (const m of meetings) {
      const scheduled = str(m.date) ?? str(m.meetingDate);
      const when = scheduled ? Date.parse(scheduled) : NaN;
      // keep only future or undated (some entries lack a parseable date)
      if (!Number.isNaN(when) && when < now) continue;
      const chamber = str(m.chamber) ?? '';
      out.push({
        id: str(m.eventId) ?? str(m.url) ?? `${out.length}`,
        title: str(m.title) ?? 'Committee meeting',
        committee: extractCommittee(m),
        chamber,
        scheduledAt: scheduled ?? new Date().toISOString(),
        url: str(m.url) ?? null,
        location: extractLocation(m),
      });
    }
    // soonest first
    out.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
    return out.slice(0, 25);
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function extractCommittee(m: Record<string, unknown>): string {
  const c = m.committees;
  if (Array.isArray(c) && c[0] && typeof c[0] === 'object') {
    const name = (c[0] as Record<string, unknown>).name;
    if (typeof name === 'string') return name;
  }
  return str(m.committee) ?? 'Committee';
}

function extractLocation(m: Record<string, unknown>): string | null {
  const loc = m.location;
  if (loc && typeof loc === 'object') {
    const room = (loc as Record<string, unknown>).room;
    const building = (loc as Record<string, unknown>).building;
    return [building, room].filter((x) => typeof x === 'string').join(' ') || null;
  }
  return null;
}
