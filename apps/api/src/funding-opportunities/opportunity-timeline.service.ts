import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  buildNoticeTimeline,
  type NoticeObservation,
  type NoticeTimeline,
} from './opportunity-change-classifier.js';
import { assertRequestSourceRecordId } from './funding-opportunity-identity.js';
import type { OpportunitySource } from './funding-opportunities.types.js';

/**
 * The read-only notice timeline (Funding Opportunities P28).
 *
 * ── Read-only, and it emits nothing ──────────────────────────────────────────
 *
 * No writes, no alerts, no tasks. The plan is explicit that P28 stops at
 * "explainable timeline" and that alerting is P48's — so this service has no
 * dependency through which a notification could be sent, and
 * `opportunity-change-classifier.spec.ts` pins that structurally.
 *
 * ── Derived on read ──────────────────────────────────────────────────────────
 *
 * The timeline is computed from `tango_opportunity_notice` rows on every
 * request rather than stored. It is cheap — one indexed query returning the
 * notices under one opportunity, then a sort and a linear pass — and it means
 * there is exactly one representation of "what changed", not a stored one and
 * a computed one that can disagree.
 *
 * ── Why it is keyed on the LOCAL notice, not the provider's ──────────────────
 *
 * Callers hold a `sam_opportunity.id` (that is what the inbox row, the detail
 * route and every deep link carry). P27's shadow sync stamps
 * `sam_opportunity_id` on each notice when the crosswalk resolved its parent,
 * so this reads by the identifier the caller actually has. A notice whose
 * parent was never crosswalked is simply not reachable from the local side yet,
 * and the response says so through `coverage` rather than by returning an empty
 * timeline that reads as "nothing ever happened".
 */

export interface OpportunityTimelineResponse extends NoticeTimeline {
  source: OpportunitySource;
  sourceRecordId: string;
  /**
   * Why the timeline is the length it is. Distinguishes the three states an
   * empty timeline can be in, which a bare `entries: []` cannot:
   *
   *   `no_notices_synced`   the notice sync has never run for this opportunity.
   *   `not_crosswalked`     notices exist, but none is stamped with this local
   *                         notice's id — P27's crosswalk has not linked the
   *                         parent, so Capiro cannot say they are the same
   *                         solicitation.
   *   `available`           notices were found.
   */
  coverage: 'available' | 'no_notices_synced' | 'not_crosswalked';
  coverageExplanation: string;
  generatedAt: string;
}

/** The reads this service needs. Injected as a closure; replaced wholesale in tests. */
export interface TimelinePort {
  readNoticesForSamOpportunity(samOpportunityId: string): Promise<NoticeObservation[]>;
  /** Any notice at all, for any opportunity. Distinguishes "never synced" from "not linked". */
  countAllNotices(): Promise<number>;
}

@Injectable()
export class OpportunityTimelineService {
  private port: TimelinePort;

  constructor(private readonly prisma: PrismaService) {
    this.port = this.buildPort();
  }

  /** Replace the reader wholesale. Test seam only. */
  withPort(port: TimelinePort): this {
    (this as unknown as { port: TimelinePort }).port = port;
    return this;
  }

  async getTimeline(
    source: string,
    sourceRecordId: string,
    asOf: Date = new Date(),
  ): Promise<OpportunityTimelineResponse> {
    // Grants.gov publishes no notice history of any kind, and the provider's
    // notice resource is a SAM.gov construct. Refusing rather than returning an
    // empty timeline is the honest answer: an empty grant timeline would read
    // as "this grant was never amended", which nothing here can support.
    if (source !== 'sam_gov') {
      throw new BadRequestException(
        'Notice history exists only for SAM.gov contract opportunities. Grants.gov publishes no notice history.',
      );
    }
    assertRequestSourceRecordId(source, sourceRecordId);

    const notices = await this.port.readNoticesForSamOpportunity(sourceRecordId);
    const timeline = buildNoticeTimeline(notices);

    let coverage: OpportunityTimelineResponse['coverage'] = 'available';
    let coverageExplanation = `${timeline.entries.length} notice${timeline.entries.length === 1 ? '' : 's'} observed for this solicitation.`;
    if (notices.length === 0) {
      // Two very different reasons for an empty result, and a reader has to be
      // able to tell them apart before concluding anything about the notice.
      const anyNotices = await this.port.countAllNotices();
      coverage = anyNotices === 0 ? 'no_notices_synced' : 'not_crosswalked';
      coverageExplanation =
        coverage === 'no_notices_synced'
          ? 'Notice history has not been synchronised yet. This is not a statement that the solicitation was never amended.'
          : 'No synchronised notice is linked to this solicitation. The provider\'s record of it has not been crosswalked to Capiro\'s own, so its amendment history cannot be shown.';
    }

    return {
      ...timeline,
      source: 'sam_gov',
      sourceRecordId,
      coverage,
      coverageExplanation,
      generatedAt: asOf.toISOString(),
    };
  }

  private buildPort(): TimelinePort {
    return {
      // tenant-scope-exempt: `tango_opportunity_notice` is a GLOBAL provider
      // table with no tenant_id and no RLS (P28), the same category as
      // sam_opportunity and tango_resource_snapshot.
      readNoticesForSamOpportunity: async (samOpportunityId) => {
        const rows = await this.prisma.withSystem((tx) =>
          tx.tangoOpportunityNotice.findMany({
            where: { samOpportunityId },
            // Ordered here too, even though buildNoticeTimeline sorts: a
            // bounded query wants a deterministic page, and the index makes it
            // free.
            orderBy: [{ postedDate: 'asc' }, { tangoNoticeId: 'asc' }],
            // A solicitation with more than 500 notices is a data-quality
            // problem, not a timeline. Bounded so one pathological record
            // cannot make a detail page unresponsive.
            take: 500,
            select: {
              tangoNoticeId: true,
              title: true,
              // The HASH, never the body. Selecting `description` here would
              // make a detail page read megabytes across 500 notices to answer
              // "did the text change".
              descriptionSha256: true,
              postedDate: true,
              providerUpdatedAt: true,
              responseDeadline: true,
              active: true,
              setAside: true,
              naicsCode: true,
              pscCode: true,
              attachmentCount: true,
              sourceUrl: true,
              contentHash: true,
            },
          }),
        );
        // Prisma returns `descriptionSha256`; the classifier's own field is
        // `descriptionHash`. Renamed here rather than in the model, because the
        // column name mirrors the SQL and the classifier's name says what the
        // value MEANS to a comparison.
        return rows.map(({ descriptionSha256, ...rest }) => ({
          ...rest,
          descriptionHash: descriptionSha256,
        }));
      },
      countAllNotices: () => this.prisma.withSystem((tx) => tx.tangoOpportunityNotice.count()),
    };
  }
}
