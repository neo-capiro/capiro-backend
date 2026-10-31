import type { ObservedStreamCandidate } from '../hearing-discovery.types.js';
import type { LegislativeObservation } from '../legislative-calendar.js';
import { etCalendarDay } from '../hearing-time.js';
import {
  classifyFloridaChannelTitle,
  fetchFloridaChannelSource,
} from './florida-calendar.adapter.js';

export const FLORIDA_LIVE_SCHEDULE_URL = 'https://thefloridachannel.org/api/tfc/v1/schedule';

export type FloridaLiveStream = {
  title: string;
  chamber: 'house' | 'senate' | 'joint';
  startsAt: string;
  endsAt: string;
  watchUrl: string;
};

/** TFC's public player consumes this JSON route; TV 24/7 is a rebroadcast
 * schedule, never evidence of a new legislative meeting or its live feed. */
export function floridaLiveSchedule(payload: unknown): FloridaLiveStream[] {
  if (!payload || typeof payload !== 'object') throw new Error('Florida live schedule unavailable');
  const response = payload as { success?: unknown; data?: unknown };
  if (response.success !== true || !Array.isArray(response.data))
    throw new Error('Florida live schedule unavailable');
  const streams: FloridaLiveStream[] = [];
  for (const channel of response.data) {
    if (channel?.title !== 'Live Streams') continue;
    if (!Array.isArray(channel.schedule))
      throw new Error('Florida live schedule layout unavailable');
    for (const event of channel.schedule) {
      if (
        !event ||
        typeof event.title !== 'string' ||
        typeof event.uuid !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(event.uuid)
      )
        continue;
      const classification = classifyFloridaChannelTitle(event.title);
      if (!classification.legislative) continue;
      const instant = (value: unknown) =>
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
        Number.isFinite(Date.parse(value))
          ? new Date(value).toISOString()
          : null;
      const startsAt = instant(event.start_time_utc);
      const endsAt = instant(event.end_time_utc);
      if (!startsAt || !endsAt || endsAt <= startsAt || typeof event.url !== 'string') continue;
      let media: URL;
      try {
        media = new URL(event.url);
      } catch {
        continue;
      }
      if (
        media.protocol !== 'https:' ||
        media.hostname !== 'cdnapisec.kaltura.com' ||
        media.username ||
        media.password ||
        media.port
      )
        continue;
      const entry =
        /^\/p\/2593311\/sp\/259331100\/playManifest\/entryId\/(\d+_[a-z0-9]+)\/format\/url\/protocol\/https\/?$/i.exec(
          media.pathname,
        )?.[1];
      if (!entry) continue;
      // Use the publisher's own event-page URL pattern. Never expose its
      // manifest or embed the player: TFC's terms permit direct page links.
      streams.push({
        title: classification.body,
        chamber: classification.chamber,
        startsAt,
        endsAt,
        watchUrl: `https://thefloridachannel.org/watch/event/${entry}/?eid=${encodeURIComponent(event.uuid)}`,
      });
    }
  }
  return streams;
}

export async function fetchFloridaLiveSchedule(): Promise<FloridaLiveStream[]> {
  const { bytes } = await fetchFloridaChannelSource(FLORIDA_LIVE_SCHEDULE_URL);
  return floridaLiveSchedule(JSON.parse(new TextDecoder().decode(bytes)));
}

const bodyName = (value: string) =>
  value
    .toLowerCase()
    .replace(/^(?:florida\s+)?(?:house|senate)\s+/, '')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();

/** Associate a feed with an existing official meeting, never merge or create
 * calendar identities from a broadcast title. Ambiguous/relative-time matches
 * stay unassigned. A reused live channel expires at its published event end. */
export function floridaLiveCandidate(
  observation: LegislativeObservation,
  streams: readonly FloridaLiveStream[],
  now = new Date(),
): ObservedStreamCandidate | null {
  const time = observation.fields.time;
  if (
    observation.jurisdiction !== 'FL' ||
    observation.fields.visibility === 'private' ||
    !['scheduled', 'in_progress'].includes(observation.fields.status ?? '') ||
    !time?.startsAt ||
    time.precision !== 'instant'
  )
    return null;
  const matches = streams.filter((stream) => {
    if (
      stream.chamber !== observation.chamber ||
      stream.startsAt !== time.startsAt ||
      Date.parse(stream.endsAt) <= now.getTime() ||
      etCalendarDay(new Date(stream.startsAt)).toISOString().slice(0, 10) !== time.date
    )
      return false;
    return observation.eventType === 'floor'
      ? /^(?:house|senate)(?:\s+in\s+special\s+session\b.*|\s+session\b.*)$/i.test(stream.title)
      : bodyName(stream.title) === bodyName(observation.bodyName);
  });
  if (matches.length !== 1) return null;
  return {
    provider: 'florida-channel-live',
    officialPageUrl: matches[0]!.watchUrl,
    mediaUrl: null,
    priority: 20,
    capturePolicy: 'LICENSE_REQUIRED',
    expiresAt: new Date(matches[0]!.endsAt),
  };
}
