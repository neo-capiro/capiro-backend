import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { guardedFetchText } from './net-guard.js';
import { discoverFromXml, type DiscoveredSenateHearing } from './senate-schedule.js';

/**
 * SenateScheduleService — fetches the U.S. Senate committee schedule feed and
 * returns the streamable proceedings discovered in it. This is the PRIMARY
 * discovery source for automatic Senate hearing capture.
 *
 * The feed host (www.senate.gov) is already on the net-guard allowlist
 * (senate.gov), so `guardedFetchText` fetches it under the same SSRF policy as
 * every other server-side fetch. Parsing/scoping is delegated to the pure
 * `senate-schedule.ts` functions (unit-tested with sample strings); this service
 * only does the network I/O + logging, mirroring the
 * stream-extractors ↔ stream-resolver split.
 */
@Injectable()
export class SenateScheduleService {
  private readonly logger = new Logger(SenateScheduleService.name);
  static readonly DEFAULT_FEED_URL =
    'https://www.senate.gov/general/committee_schedules/hearings.xml';

  private readonly feedUrl: string;

  constructor(config: ConfigService) {
    this.feedUrl =
      config.get<string>('SENATE_SCHEDULE_XML_URL')?.trim() ||
      SenateScheduleService.DEFAULT_FEED_URL;
  }

  /**
   * Fetch + parse the live schedule feed into discovered streamable hearings
   * (hearings, markups, business meetings — anything with a parseable ISVP
   * `<video_url>`). Returns [] resiliently on a non-200 or a fetch/parse failure
   * so the poller never crashes on a transient feed hiccup or an empty recess
   * schedule.
   */
  async discover(): Promise<DiscoveredSenateHearing[]> {
    let text: string;
    let status: number;
    try {
      ({ text, status } = await guardedFetchText(this.feedUrl, { timeoutMs: 15_000 }));
    } catch (err) {
      this.logger.warn(`senate schedule fetch failed: ${(err as Error).message}`);
      return [];
    }
    if (status !== 200) {
      this.logger.warn(`senate schedule feed returned HTTP ${status}`);
      return [];
    }
    const found = discoverFromXml(text);
    this.logger.log(`senate schedule: ${found.length} streamable proceeding(s) discovered`);
    return found;
  }
}
