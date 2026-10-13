import {
  AGENCY_SECTOR_MAP,
  ldaCodesForSectors,
  normalizeSector,
  type SectorTag,
} from '@capiro/shared';
import type { FederalRegisterDocument, StateRule } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { commentDeadlineDedupeKey } from './comment-deadline.util.js';
import { addCapabilityKeywords } from './client-alerts-v1.shared.js';
import type {
  AlertLoggerPorts,
  AlertClient,
  CommentPeriodAlert,
  CommentPeriodChange,
} from './client-alerts-v1.shared.js';

/** Upcoming federal/state comment deadlines and their idempotent change-ledger emission. */
export class ClientCommentDeadlineAlertsV1 {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: AlertLoggerPorts,
  ) {}

  async getCommentPeriodAlerts(tenantId: string) {
    const now = new Date();
    const fourteenDaysOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const [clientsWithCaps, docs, stateRules] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findMany({
          // Exclude soft-archived ("deleted") clients: archiving sets
          // status='archived' but leaves profileStatus untouched, so filtering
          // on profileStatus alone would still surface a deleted client's alerts.
          where: { status: { not: 'archived' }, profileStatus: 'ACTIVE' },
          select: {
            id: true,
            name: true,
            sectorTag: true,
            capabilities: { select: { sector: true, tags: true, name: true } },
          },
        }),
      ),
      this.prisma.federalRegisterDocument.findMany({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gt: now, lte: fourteenDaysOut },
        },
        orderBy: { commentEndDate: 'asc' },
      }),
      // W4.5 (M3-D): state_rule is a GLOBAL public table (R1) — read WITHOUT
      // withTenant, exactly like federalRegisterDocument above and
      // check-comment-periods.ts.
      this.prisma.stateRule.findMany({
        where: { commentEndDate: { gt: now, lte: fourteenDaysOut } },
        orderBy: { commentEndDate: 'asc' },
      }),
    ]);
    if ((!docs.length && !stateRules.length) || !clientsWithCaps.length) return { alerts: [] };
    const alerts: CommentPeriodAlert[] = [];
    const changesToCreate: CommentPeriodChange[] = [];
    this.appendFederalDeadlines(docs, clientsWithCaps, now, alerts, changesToCreate);
    this.appendStateDeadlines(stateRules, clientsWithCaps, now, alerts, changesToCreate);
    await Promise.all(
      changesToCreate.map((c) =>
        this.prisma.intelligenceChange
          .upsert({ where: { dedupeKey: c.dedupeKey }, create: c, update: c })
          .catch((err) => {
            this.ports.logger().warn(`Failed to emit comment-period change: ${err.message}`);
          }),
      ),
    );
    alerts.sort((a, b) => a.daysToDeadline - b.daysToDeadline);
    return { alerts };
  }

  private appendFederalDeadlines(
    docs: FederalRegisterDocument[],
    clientsWithCaps: AlertClient[],
    now: Date,
    alerts: CommentPeriodAlert[],
    changesToCreate: CommentPeriodChange[],
  ) {
    for (const doc of docs) {
      const daysToDeadline = Math.ceil(
        (doc.commentEndDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      const urgencyMultiplier = daysToDeadline < 3 ? 2.0 : daysToDeadline <= 7 ? 1.5 : 1.0;
      const severity = daysToDeadline < 3 ? 'critical' : daysToDeadline <= 7 ? 'notable' : 'info';
      const agencies = doc.agencyNames as string[];
      const docSectors = new Set<SectorTag>();
      for (const agency of agencies) {
        for (const sector of AGENCY_SECTOR_MAP[agency] ?? []) {
          docSectors.add(sector);
        }
      }
      const docLdaCodes = ldaCodesForSectors([...docSectors]);
      for (const client of clientsWithCaps) {
        const { baseRelevance, matchedSectors } = this.federalClientRelevance(
          client,
          doc,
          docSectors,
        );
        const finalScore = baseRelevance * urgencyMultiplier;
        if (finalScore <= 0.3) continue;
        alerts.push({
          documentId: doc.id,
          title: doc.title,
          type: doc.type,
          commentEndDate: doc.commentEndDate!,
          daysToDeadline,
          severity,
          agencies,
          clientId: client.id,
          clientName: client.name,
          relevanceScore: Math.round(finalScore * 100) / 100,
        });
        const matchedLdaCodes = matchedSectors.size
          ? ldaCodesForSectors([...matchedSectors])
          : docLdaCodes;
        changesToCreate.push({
          dedupeKey: commentDeadlineDedupeKey('federal_register', doc.id, client.id),
          source: 'federal_register',
          changeType: 'comment_deadline_approaching',
          severity,
          title: `Comment period closing in ${daysToDeadline}d: ${doc.title.slice(0, 80)}`,
          description: `${doc.type} from ${agencies.slice(0, 2).join('/')} has a comment deadline in ${daysToDeadline} days. Relevant to ${client.name}.`,
          relatedClientIds: [client.id],
          relatedIssues: matchedLdaCodes,
          data: { documentId: doc.id, daysToDeadline, relevanceScore: finalScore },
        });
      }
    }
  }

  private federalClientRelevance(
    client: AlertClient,
    doc: FederalRegisterDocument,
    docSectors: Set<SectorTag>,
  ) {
    let baseRelevance = 0;
    const matchedSectors = new Set<SectorTag>();
    if (client.sectorTag && docSectors.has(client.sectorTag as SectorTag)) {
      baseRelevance = Math.max(baseRelevance, 0.5);
      matchedSectors.add(client.sectorTag as SectorTag);
    }
    for (const cap of client.capabilities) {
      const normalized = normalizeSector(cap.sector);
      if (normalized && docSectors.has(normalized)) {
        baseRelevance = Math.max(baseRelevance, 0.5);
        matchedSectors.add(normalized);
      }
    }
    if (baseRelevance < 0.7) {
      const capKeywords = new Set<string>();
      addCapabilityKeywords(capKeywords, client.capabilities);

      for (const topic of doc.topics as string[]) {
        const topicLower = topic.toLowerCase();
        for (const kw of capKeywords) {
          if (topicLower.includes(kw) || kw.includes(topicLower)) {
            baseRelevance = Math.max(baseRelevance, 0.7);
            break;
          }
        }
      }
    }
    return { baseRelevance, matchedSectors };
  }

  private appendStateDeadlines(
    stateRules: StateRule[],
    clientsWithCaps: AlertClient[],
    now: Date,
    alerts: CommentPeriodAlert[],
    changesToCreate: CommentPeriodChange[],
  ) {
    for (const rule of stateRules) {
      const daysToDeadline = Math.ceil(
        (rule.commentEndDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      const urgencyMultiplier = daysToDeadline < 3 ? 2.0 : daysToDeadline <= 7 ? 1.5 : 1.0;
      const severity = daysToDeadline < 3 ? 'critical' : daysToDeadline <= 7 ? 'notable' : 'info';
      const haystack = `${rule.title} ${rule.abstract ?? ''}`.toLowerCase();

      for (const client of clientsWithCaps) {
        let baseRelevance = 0;
        const capKeywords = new Set<string>();
        addCapabilityKeywords(capKeywords, client.capabilities);
        for (const kw of capKeywords) {
          if (haystack.includes(kw)) {
            baseRelevance = 0.7;
            break;
          }
        }

        const finalScore = baseRelevance * urgencyMultiplier;
        if (finalScore <= 0.3) continue;

        alerts.push({
          documentId: rule.id,
          title: rule.title,
          type: rule.ruleType,
          commentEndDate: rule.commentEndDate!,
          daysToDeadline,
          severity,
          agencies: [rule.agency],
          clientId: client.id,
          clientName: client.name,
          relevanceScore: Math.round(finalScore * 100) / 100,
        });
        changesToCreate.push({
          dedupeKey: commentDeadlineDedupeKey('state_register', rule.id, client.id),
          source: 'state_register',
          changeType: 'comment_deadline_approaching',
          severity,
          title: `Comment period closing in ${daysToDeadline}d: ${rule.title.slice(0, 80)}`,
          description: `${rule.ruleType} from ${rule.state} ${rule.agency} has a comment deadline in ${daysToDeadline} days. Relevant to ${client.name} (relevance: ${Math.round(finalScore * 100)}%).`,
          relatedClientIds: [client.id],
          // State agencies have no LDA-code mapping yet — empty, never a guess.
          relatedIssues: [],
          data: { documentId: rule.id, daysToDeadline, relevanceScore: finalScore },
        });
      }
    }
  }
}
