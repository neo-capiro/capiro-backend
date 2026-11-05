import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { FundingOpportunityV2DetailService } from '../../funding-opportunities/funding-opportunity-v2-detail.service.js';
import { wholeWordHit } from '../../tracker/tracker-relevance.util.js';
import { ClientCapabilityFitService } from '../client-capability-fit.service.js';
import {
  PortfolioProposalStore,
  history,
  json,
  type PortfolioTx,
} from './portfolio-proposal.store.js';
import { portfolioEvidenceVisible } from './portfolio-source-access.js';
import {
  parsePortfolio,
  trackingSchema,
  proposalSchema,
  normalized,
} from './portfolio.contracts.js';

export interface PortfolioTrackingSource {
  itemKind: string;
  itemId: string;
  title: string;
  url: string;
  occurredAt: string;
  dateKind: 'published' | 'scheduled' | 'observed';
  searchText: string;
  context?: string;
}
export interface PortfolioTrackingTerm {
  id: string;
  kind: string;
  value: string;
}
export function matchingApprovedTerms(
  source: PortfolioTrackingSource,
  terms: PortfolioTrackingTerm[],
) {
  return terms.filter((term) =>
    term.kind === 'pe' && source.itemKind === 'budget'
      ? normalized(source.itemId) === normalized(term.value)
      : wholeWordHit(source.searchText.toLowerCase(), term.value),
  );
}

@Injectable()
export class PortfolioTrackingService {
  constructor(
    private readonly store: PortfolioProposalStore,
    private readonly fit: ClientCapabilityFitService,
    private readonly opportunities: FundingOpportunityV2DetailService,
  ) {}

  async source(
    tx: PortfolioTx,
    ctx: TenantContext,
    clientId: string,
    kind: string,
    id: string,
  ): Promise<PortfolioTrackingSource | null> {
    if (kind === 'bill') {
      const row = await tx.congressBill.findUnique({ where: { id } });
      const date = row?.latestActionDate ?? row?.introducedDate;
      if (row?.url && date)
        return {
          itemKind: kind,
          itemId: id,
          title: row.title,
          url: row.url,
          occurredAt: date.toISOString(),
          dateKind: 'published',
          searchText: [
            row.title,
            ...row.subjects,
            ...row.peCodes,
            row.policyArea ?? '',
            row.latestActionText ?? '',
          ].join(' '),
        };
    } else if (kind === 'hearing') {
      const row = await tx.committeeHearing.findFirst({ where: { id, visibility: 'public' } });
      if (row?.url) {
        const [linked, agenda, committee] = await Promise.all([
          tx.committeeHearingBill.findMany({
            where: { hearingId: id },
            select: { billId: true },
            take: 100,
          }),
          tx.legislativeAgendaItem.findMany({
            where: { hearingId: id, active: true, federalBillId: { not: null } },
            select: { federalBillId: true },
            take: 100,
          }),
          row.committeeSystemCode
            ? tx.congressCommittee.findFirst({
                where: {
                  systemCode: row.committeeSystemCode,
                  isCurrent: true,
                  urlSource: 'congress_gov',
                  urlVerifiedAt: { not: null },
                },
              })
            : null,
        ]);
        const billIds = [
          ...new Set([
            ...linked.map((link) => link.billId),
            ...agenda.flatMap((item) => (item.federalBillId ? [item.federalBillId] : [])),
          ]),
        ];
        const bills = billIds.length
          ? await tx.congressBill.findMany({
              where: { id: { in: billIds } },
              select: { title: true, subjects: true },
            })
          : [];
        return {
          itemKind: kind,
          itemId: id,
          title: row.title,
          url: row.url,
          occurredAt: (row.startsAt ?? row.date).toISOString(),
          dateKind: 'scheduled',
          searchText: [
            row.title,
            row.committeeName,
            committee?.jurisdiction ?? '',
            ...bills.flatMap((bill) => [bill.title, ...bill.subjects]),
          ].join(' '),
          context: bills.length
            ? 'Official hearing agenda or bill linkage'
            : committee?.jurisdiction
              ? 'Official committee jurisdiction and hearing topic'
              : 'Hearing topic',
        };
      }
    } else if (kind === 'budget') {
      const row = await tx.programElement.findFirst({
        where: { peCode: id, retiredAt: null },
        include: { sources: { orderBy: { observedAt: 'desc' }, take: 1 } },
      });
      const source = row?.sources[0];
      if (row && source)
        return {
          itemKind: kind,
          itemId: id,
          title: row.title,
          url: source.sourceUrl,
          occurredAt: source.observedAt.toISOString(),
          dateKind: 'observed',
          searchText: `${row.peCode} ${row.title} ${row.description ?? ''}`,
        };
    } else if (kind === 'news') {
      const row = await tx.intelArticle.findUnique({ where: { id } });
      if (row)
        return {
          itemKind: kind,
          itemId: id,
          title: row.title,
          url: row.url,
          occurredAt: row.publishedAt.toISOString(),
          dateKind: 'published',
          searchText: `${row.title} ${row.summary ?? ''} ${row.topics.join(' ')}`,
        };
    } else if (kind === 'statement') {
      const row = await tx.clientPortfolioProposal.findFirst({
        where: { id, tenantId: ctx.tenantId, clientId, kind: 'statement', status: 'approved' },
      });
      if (row && (await portfolioEvidenceVisible(tx, ctx, clientId, row.evidence))) {
        const input = this.store.input(row);
        await this.store.validateEvidence(tx, ctx, clientId, input);
        if (input.kind === 'statement' && input.evidence[0]?.url)
          return {
            itemKind: kind,
            itemId: id,
            title: input.payload.summary,
            url: input.evidence[0].url,
            occurredAt: input.payload.statementDate,
            dateKind: 'published',
            searchText: `${input.payload.summary} ${input.payload.tags.join(' ')}`,
          };
      }
    } else if (kind === 'grant') {
      const colon = id.indexOf(':');
      if (colon < 1) return null;
      // Canonical detail applies source entitlement, current client access and current source identity.
      const detail = await this.opportunities.readDetail(
        ctx,
        id.slice(0, colon),
        id.slice(colon + 1),
        clientId,
      );
      const row = detail.opportunity;
      if (row.sourceUrl && row.postedDate)
        return {
          itemKind: kind,
          itemId: id,
          title: row.title,
          url: row.sourceUrl,
          occurredAt: row.postedDate,
          dateKind: 'published',
          searchText: `${row.title} ${row.summary ?? ''}`,
        };
    }
    return null;
  }

  async feed(ctx: TenantContext, clientId: string, capabilityId: string, refresh = false) {
    await this.store.withClient(ctx, clientId, false, async (tx) => {
      if (
        !(await tx.clientCapability.findFirst({
          where: { id: capabilityId, tenantId: ctx.tenantId, clientId },
        }))
      )
        throw new NotFoundException('Capability not found');
    });
    const fit = await this.fit.getFit(ctx, clientId, { refresh });
    return this.store.withClient(ctx, clientId, false, async (tx) => {
      const [termRows, pendingRows, dispositions] = await Promise.all([
        tx.clientCapabilityTerm.findMany({
          where: { tenantId: ctx.tenantId, clientId, capabilityId },
        }),
        tx.clientPortfolioProposal.findMany({
          where: {
            tenantId: ctx.tenantId,
            clientId,
            capabilityId,
            kind: 'alignment',
            status: 'proposed',
          },
        }),
        tx.clientCapabilityTracking.findMany({
          where: { tenantId: ctx.tenantId, clientId, capabilityId },
        }),
      ]);
      const terms = [];
      for (const term of termRows) {
        try {
          await this.store.validateEvidence(
            tx,
            ctx,
            clientId,
            parsePortfolio(proposalSchema, {
              kind: 'case_field',
              capabilityId,
              payload: { field: 'priorities', text: term.value },
              evidence: term.evidence,
            }),
          );
          terms.push(term);
        } catch {
          /* Revoked or missing evidence cannot drive active feeds. */
        }
      }
      const visiblePending = [];
      for (const row of pendingRows) {
        try {
          await this.store.validateEvidence(tx, ctx, clientId, this.store.input(row));
          visiblePending.push(row);
        } catch {
          /* A pending explanation must not expose revoked source text. */
        }
      }
      const pendingTerms = visiblePending
        .map((row) => ({ row, input: this.store.input(row) }))
        .flatMap(({ row, input }) =>
          input.kind === 'alignment' && !['naics', 'psc'].includes(input.payload.targetType)
            ? [
                {
                  id: row.id,
                  kind: input.payload.targetType === 'tag' ? 'keyword' : input.payload.targetType,
                  value: input.payload.value,
                },
              ]
            : [],
        );
      const keys = new Map<string, { kind: string; id: string }>();
      for (const match of fit.matches.filter((match) =>
        match.capabilityIds.includes(capabilityId),
      )) {
        const kind = match.kind === 'pe' ? 'budget' : match.kind === 'fo' ? 'grant' : 'bill';
        const id = match.kind === 'fo' ? match.id.slice(3) : match.targetId;
        keys.set(`${kind}:${id}`, { kind, id });
      }
      for (const row of dispositions)
        keys.set(`${row.itemKind}:${row.itemId}`, { kind: row.itemKind, id: row.itemId });
      const vocabulary = [...terms, ...pendingTerms]
        .filter((term) => ['keyword', 'program'].includes(term.kind))
        .slice(0, 40);
      const since = new Date();
      since.setUTCFullYear(since.getUTCFullYear() - 1);
      if (vocabulary.length) {
        const needles = vocabulary.map((term) => ({
          contains: term.value,
          mode: 'insensitive' as const,
        }));
        const committees = await tx.congressCommittee.findMany({
          where: {
            isCurrent: true,
            urlSource: 'congress_gov',
            urlVerifiedAt: { not: null },
            OR: needles.map((jurisdiction) => ({ jurisdiction })),
          },
          select: { systemCode: true },
          take: 100,
        });
        const [hearings, articles, statements, bills] = await Promise.all([
          tx.committeeHearing.findMany({
            where: {
              visibility: 'public',
              date: { gte: since },
              OR: [
                ...needles.map((title) => ({ title })),
                ...(committees.length
                  ? [
                      {
                        committeeSystemCode: {
                          in: committees.map((committee) => committee.systemCode),
                        },
                      },
                    ]
                  : []),
              ],
            },
            select: { id: true },
            take: 100,
            orderBy: { date: 'desc' },
          }),
          tx.intelArticle.findMany({
            where: {
              publishedAt: { gte: since, lte: new Date() },
              OR: needles.map((title) => ({ title })),
            },
            select: { id: true },
            take: 100,
            orderBy: { publishedAt: 'desc' },
          }),
          tx.clientPortfolioProposal.findMany({
            where: { tenantId: ctx.tenantId, clientId, kind: 'statement', status: 'approved' },
            select: { id: true },
            take: 100,
            orderBy: { createdAt: 'desc' },
          }),
          tx.congressBill.findMany({
            where: { OR: needles.map((title) => ({ title })) },
            select: { id: true },
            take: 100,
            orderBy: { latestActionDate: 'desc' },
          }),
        ]);
        for (const [kind, rows] of [
          ['hearing', hearings],
          ['news', articles],
          ['statement', statements],
          ['bill', bills],
        ] as const)
          for (const row of rows) keys.set(`${kind}:${row.id}`, { kind, id: row.id });
        const billIds = [...keys.values()]
          .filter((key) => key.kind === 'bill')
          .map((key) => key.id);
        if (billIds.length) {
          const [linked, agenda] = await Promise.all([
            tx.committeeHearingBill.findMany({
              where: { billId: { in: billIds } },
              select: { hearingId: true },
              take: 100,
            }),
            tx.legislativeAgendaItem.findMany({
              where: { active: true, federalBillId: { in: billIds } },
              select: { hearingId: true },
              take: 100,
            }),
          ]);
          for (const row of [...linked, ...agenda])
            keys.set(`hearing:${row.hearingId}`, { kind: 'hearing', id: row.hearingId });
        }
      }
      for (const term of [...terms, ...pendingTerms].filter((term) => term.kind === 'pe'))
        keys.set(`budget:${term.value.toUpperCase()}`, {
          kind: 'budget',
          id: term.value.toUpperCase(),
        });
      const items = [];
      const pending = [];
      const gaps: string[] = [];
      for (const key of [...keys.values()].slice(0, 240)) {
        let source: PortfolioTrackingSource | null;
        try {
          source = await this.source(tx, ctx, clientId, key.kind, key.id);
        } catch {
          gaps.push(`${key.kind}: source unavailable`);
          continue;
        }
        if (!source) {
          gaps.push(`${key.kind}: missing source or date`);
          continue;
        }
        const matched = matchingApprovedTerms(source, terms);
        const waiting = matchingApprovedTerms(source, pendingTerms);
        const saved = dispositions.find(
          (row) => row.itemKind === key.kind && row.itemId === key.id,
        );
        const { searchText: _text, ...visible } = source;
        if (matched.length)
          items.push({
            ...visible,
            id: saved?.id ?? `${key.kind}:${key.id}`,
            capabilityId,
            status: saved?.status ?? 'active',
            termIds: matched.map((term) => term.id),
            explanation: `${source.context ? `${source.context}; ` : ''}matches approved terms: ${matched.map((term) => term.value).join(', ')}`,
          });
        else if (waiting.length)
          pending.push({
            ...visible,
            id: `${key.kind}:${key.id}`,
            capabilityId,
            status: 'pending',
            termIds: waiting.map((term) => term.id),
            explanation: `Waiting on approval: ${waiting.map((term) => term.value).join(', ')}`,
          });
      }
      return {
        items,
        pending,
        terms,
        clientTrackingPreserved: true,
        sourceStatus: fit.status,
        gaps: [...new Set(gaps)],
        truncated: keys.size > 240,
      };
    });
  }

  update(ctx: TenantContext, clientId: string, capabilityId: string, raw: unknown) {
    const input = parsePortfolio(trackingSchema, raw);
    return this.store.withClient(ctx, clientId, true, async (tx) => {
      if (
        !(await tx.clientCapability.findFirst({
          where: { id: capabilityId, tenantId: ctx.tenantId, clientId },
        }))
      )
        throw new NotFoundException('Capability not found');
      const terms = await tx.clientCapabilityTerm.findMany({
        where: { tenantId: ctx.tenantId, clientId, capabilityId, id: { in: input.termIds } },
      });
      if (!terms.length || terms.length !== new Set(input.termIds).size)
        throw new BadRequestException(
          'Every tracking association requires this capability’s approved terms',
        );
      for (const term of terms)
        if (!(await portfolioEvidenceVisible(tx, ctx, clientId, term.evidence)))
          throw new BadRequestException('Approved term evidence is no longer available');
      const source = await this.source(tx, ctx, clientId, input.itemKind, input.itemId);
      if (!source || matchingApprovedTerms(source, terms).length !== terms.length)
        throw new BadRequestException(
          'The dated canonical item must match every supplied approved term',
        );
      const key = {
        tenantId: ctx.tenantId,
        clientId,
        capabilityId,
        itemKind: input.itemKind,
        itemId: input.itemId,
      };
      const existing = await tx.clientCapabilityTracking.findUnique({
        where: { tenantId_clientId_capabilityId_itemKind_itemId: key },
      });
      if (input.action === 'restore' && existing?.status !== 'dismissed')
        throw new BadRequestException('Only a dismissed item can be restored');
      const data = {
        status: input.action === 'dismiss' ? 'dismissed' : 'active',
        termIds: json(terms.map((term) => term.id)),
        history: json([
          ...history(existing?.history ?? []),
          { action: input.action, actorUserId: ctx.userId, at: new Date().toISOString() },
        ]),
      };
      return tx.clientCapabilityTracking.upsert({
        where: { tenantId_clientId_capabilityId_itemKind_itemId: key },
        create: { ...key, ...data },
        update: data,
      });
    });
  }
}
