import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';
import { federalHearingWhere } from '../hearing-discovery/hearing-geography.js';
import { dateBoundsInZone } from './time-bounds.js';
import type { TrackedBillsResult } from './intelligence-bill-discovery.shared.js';
import type { ClientContextV1Health } from './client-context-v1-health.js';

export interface ClientContextV1OutreachPorts {
  confirmedLdaIds(clientId: string, tenantId: string): Promise<number[]>;
  issueCodesForLdaIds(ldaClientIds: number[]): Promise<string[]>;
  getTrackedBills(clientId: string, tenantId: string): Promise<TrackedBillsResult>;
  computeEngagementHealth(
    clientId: string,
    tenantId: string,
  ): ReturnType<ClientContextV1Health['computeEngagementHealth']>;
}
type Hearing = Prisma.CommitteeHearingGetPayload<{}>;
type Change = Prisma.IntelligenceChangeGetPayload<{}>;
type CommentPeriod = Prisma.FederalRegisterDocumentGetPayload<{
  select: { title: true; commentEndDate: true; agencyNames: true };
}>;

export class ClientContextV1Outreach {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientContextV1OutreachPorts,
  ) {}

  async getOutreachContext(clientId: string, tenantId: string, recipientOffice?: string) {
    const now = new Date();

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const fourteenDaysOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Phase 4c: union issue codes across the client's FULL confirmed LDA id set.
    const ldaClientIds = await this.ports.confirmedLdaIds(clientId, tenantId);

    const issueCodes = await this.ports.issueCodesForLdaIds(ldaClientIds);

    // Tracked bills + upcoming hearings + recent changes + comment deadlines in parallel.
    // Comment-period emitters now populate `relatedIssues` via SECTOR_TO_LDA_CODES;
    // other sync emitters (emit-changes, compute-health-scores) still leave it empty,
    // so the hasSome branch surfaces sector-mapped events but not source-summary rows.
    const changeOrConditions: Record<string, unknown>[] = [{ relatedClientIds: { has: clientId } }];

    if (issueCodes.length) changeOrConditions.push({ relatedIssues: { hasSome: issueCodes } });

    const [trackedBills, hearings, recentChanges, commentPeriods, healthScore] =
      await this.readOutreachSnapshot(
        clientId,
        tenantId,
        now,
        sevenDaysAgo,
        fourteenDaysOut,
        changeOrConditions,
      );

    const parts: string[] = [];

    this.appendOutreachSections(parts, trackedBills, hearings, recentChanges, commentPeriods, now);

    // Lobbyist coverage check for recipientOffice
    if (recipientOffice && ldaClientIds.length) {
      const regRows = await this.prisma.$queryRaw<Array<{ registrant_id: number }>>`
        SELECT DISTINCT registrant_id FROM lda_filing
        WHERE client_id = ANY(${ldaClientIds}::int[]) AND registrant_id IS NOT NULL
      `;
      const registrantIds = regRows.map((r) => r.registrant_id);
      if (registrantIds.length) {
        const lobbyists = await this.prisma.$queryRaw<
          Array<{ first_name: string; last_name: string; covered_positions: unknown }>
        >`
          SELECT first_name, last_name, covered_positions FROM lda_lobbyist
          WHERE registrant_ids && ${registrantIds}::int[]
            AND covered_positions::text != '[]'
          LIMIT 20
        `;
        const officeLower = recipientOffice.toLowerCase();
        const matched = lobbyists.filter((l) => {
          const positions = Array.isArray(l.covered_positions) ? l.covered_positions : [];
          return (positions as unknown[]).some((p) => {
            const pos = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
            const posTitle = typeof pos.position === 'string' ? pos.position.toLowerCase() : '';
            const posDept = typeof pos.department === 'string' ? pos.department.toLowerCase() : '';
            return posTitle.includes(officeLower) || posDept.includes(officeLower);
          });
        });
        if (matched.length) {
          const names = matched.slice(0, 3).map((l) => `${l.first_name} ${l.last_name}`.trim());
          parts.push(
            `LOBBYIST CONNECTIONS TO "${recipientOffice}":\n${names.map((n) => `- ${n}`).join('\n')}`,
          );
        }
      }
    }

    parts.push(`ENGAGEMENT HEALTH: ${healthScore.score}/100 (${healthScore.trend})`);

    return { context: parts.join('\n\n') };
  }

  private readOutreachSnapshot(
    clientId: string,
    tenantId: string,
    now: Date,
    sevenDaysAgo: Date,
    fourteenDaysOut: Date,
    changeOrConditions: Record<string, unknown>[],
  ) {
    return Promise.all([
      this.ports.getTrackedBills(clientId, tenantId),
      this.prisma.committeeHearing.findMany({
        // Start-of-Eastern-day, not `now` — a UTC-midnight @db.Date compared
        // against a mid-day instant silently excluded today. Same fix as above.
        where: federalHearingWhere({
          date: { gte: dateBoundsInZone(now, 'America/New_York').start, lte: fourteenDaysOut },
        }),
        orderBy: { date: 'asc' },
        take: 5,
      }),
      this.prisma.intelligenceChange.findMany({
        where: { OR: changeOrConditions, detectedAt: { gte: sevenDaysAgo } },
        orderBy: { detectedAt: 'desc' },
        take: 5,
      }),
      this.prisma.federalRegisterDocument.findMany({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gt: now, lte: fourteenDaysOut },
        },
        orderBy: { commentEndDate: 'asc' },
        take: 5,
        select: { title: true, commentEndDate: true, agencyNames: true },
      }),
      this.ports.computeEngagementHealth(clientId, tenantId),
    ]);
  }

  private appendOutreachSections(
    parts: string[],
    trackedBills: TrackedBillsResult,
    hearings: Hearing[],
    recentChanges: Change[],
    commentPeriods: CommentPeriod[],
    now: Date,
  ) {
    if (trackedBills.bills.length) {
      const billList = trackedBills.bills
        .slice(0, 5)
        .map(
          (b) =>
            `- ${b.identifier}: ${b.title.slice(0, 60)}${b.latestActionText ? ` [${b.latestActionText.slice(0, 40)}]` : ''}`,
        )
        .join('\n');
      parts.push(`TRACKED BILLS:\n${billList}`);
    }

    if (hearings.length) {
      const hearingList = hearings
        .map((h) => {
          const daysOut = Math.ceil(
            (new Date(h.date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          );
          return `- ${h.committeeName}: "${h.title.slice(0, 60)}" (in ${daysOut}d, ${h.chamber})`;
        })
        .join('\n');
      parts.push(`UPCOMING HEARINGS (14d):\n${hearingList}`);
    }

    if (recentChanges.length) {
      const changeList = recentChanges.map((c) => `- [${c.changeType}] ${c.title}`).join('\n');
      parts.push(`RECENT INTELLIGENCE (7d):\n${changeList}`);
    }

    if (commentPeriods.length) {
      const deadlineList = commentPeriods
        .map((d) => {
          const days = Math.ceil(
            (d.commentEndDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          );
          return `- "${d.title.slice(0, 60)}", ${days}d left (${(d.agencyNames as string[]).slice(0, 2).join('/')})`;
        })
        .join('\n');
      parts.push(`COMMENT PERIOD DEADLINES:\n${deadlineList}`);
    }
  }
}
