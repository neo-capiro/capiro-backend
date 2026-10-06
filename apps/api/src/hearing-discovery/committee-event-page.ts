import type { CanonicalHearingRef, SourceDescriptor } from './hearing-discovery.types.js';

type Observation = { sourceMetadata: unknown; source: { adapterKey: string; sourceUrl: string } };
export type ScopedHearingRef = CanonicalHearingRef & { subcommitteeSystemCode?: string | null };
const OFFICIAL_ADAPTERS = new Set([
  'congress-gov',
  'senate-schedule',
  'senate-committee-calendar',
  'committee-site',
  'house-repository',
]);

/** Reject shared indexes and day/channel players even when hosted by the committee. */
export function isCommitteeEventPage(value: unknown, sourceUrl: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value),
      source = new URL(sourceUrl);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.hostname.replace(/^www\./, '') !== source.hostname.replace(/^www\./, '')
    )
      return false;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || /\.(?:xml|json|pdf)$/i.test(url.pathname)) return false;
    const last = parts.at(-1)!;
    if (
      /^(?:hearings?|events?|calendar|archive|search|index(?:\.html?)?|live|video|webcast|\d{4}-\d{2}-\d{2})$/i.test(
        last,
      )
    )
      return false;
    // CMS event IDs are allowed; a generic index with only date/filter parameters is not.
    if (/\.(?:aspx|cfm|php)$/i.test(last))
      return [...url.searchParams.keys()].some((key) => /^(?:eventid|hearingid|id)$/i.test(key));
    return true;
  } catch {
    return false;
  }
}

/** Only already-associated official observations qualify; shared media is never identity proof. */
export class CommitteeEventPageResolver {
  async resolve(
    source: SourceDescriptor,
    hearing: ScopedHearingRef,
    observations: Observation[],
  ): Promise<string | null> {
    if (isCommitteeEventPage(hearing.officialPageUrl, source.sourceUrl))
      return hearing.officialPageUrl;
    const direct = new Set<string>();
    for (const row of observations) {
      const event = (row.sourceMetadata as { event?: Record<string, unknown> } | null)?.event;
      if (
        !OFFICIAL_ADAPTERS.has(row.source.adapterKey) ||
        !event ||
        event.committeeSystemCode !== hearing.committeeSystemCode ||
        (event.subcommitteeSystemCode ?? null) !== (hearing.subcommitteeSystemCode ?? null) ||
        event.congress !== hearing.congress ||
        String(event.chamber).toLowerCase() !== hearing.chamber.toLowerCase() ||
        String(event.calendarDate).slice(0, 10) !== hearing.calendarDate.toISOString().slice(0, 10)
      )
        continue;
      if (
        hearing.startsAt &&
        new Date(String(event.startsAt)).getTime() !== hearing.startsAt.getTime()
      )
        continue;
      if (isCommitteeEventPage(event.officialPageUrl, source.sourceUrl))
        direct.add(event.officialPageUrl);
    }
    return direct.size === 1 ? [...direct][0]! : null;
  }
}
