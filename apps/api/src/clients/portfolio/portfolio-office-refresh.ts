import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { OfficeRecommendation } from '../../intelligence/office-recommender.service.js';
import type { PortfolioProposalStore, PortfolioTx } from './portfolio-proposal.store.js';
import { portfolioEvidenceVisible } from './portfolio-source-access.js';
import {
  canonicalOfficeSignals,
  currentCongress,
  hitsTerms,
  officeFit,
  officialEvidence,
  type OfficeSignal,
} from './portfolio-office-signals.js';

async function clientInputs(
  tx: PortfolioTx,
  ctx: TenantContext,
  clientId: string,
  capabilityId?: string,
) {
  const rows = await tx.clientCapabilityTerm.findMany({
    where: {
      tenantId: ctx.tenantId,
      clientId,
      ...(capabilityId ? { capabilityId } : {}),
      kind: { notIn: ['naics', 'psc'] },
    },
    orderBy: { approvedAt: 'desc' },
    take: 200,
  });
  const terms: string[] = [];
  for (const row of rows)
    if (await portfolioEvidenceVisible(tx, ctx, clientId, row.evidence)) terms.push(row.value);
  if (!capabilityId) {
    const client = await tx.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId },
      select: { issueCodes: true },
    });
    if (client?.issueCodes.length) {
      const issues = await tx.ldaIssueCode.findMany({
        where: { code: { in: client.issueCodes } },
        select: { name: true },
        take: 80,
      });
      terms.push(...issues.map((issue) => issue.name));
    }
  }
  const facilities = await tx.clientFacility.findMany({
    where: {
      tenantId: ctx.tenantId,
      clientId,
      ...(capabilityId ? { capabilityLinks: { some: { capabilityId } } } : {}),
    },
    take: 80,
  });
  const owners = await tx.clientOrderedOwner.findMany({
    where: { tenantId: ctx.tenantId, clientId },
    orderBy: { rank: 'asc' },
    take: 20,
  });
  let owner: string | undefined;
  for (const row of owners) {
    if (
      await tx.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId: row.userId, status: 'active' },
      })
    ) {
      owner = row.userId;
      break;
    }
  }
  return { terms: [...new Set(terms)], facilities, owner };
}

async function stageStatements(
  tx: PortfolioTx,
  store: PortfolioProposalStore,
  ctx: TenantContext,
  clientId: string,
  memberId: string,
  congresses: number[],
  terms: string[],
  capabilityId?: string,
) {
  const since = new Date();
  since.setUTCFullYear(since.getUTCFullYear() - 1);
  const press = await tx.memberPressItem.findMany({
    where: { bioguideId: memberId, publishedAt: { gte: since, lte: new Date() } },
    orderBy: { publishedAt: 'desc' },
    take: 24,
  });
  const rows = [];
  for (const item of press) {
    if (!item.publishedAt) continue;
    const summary = (item.summary || item.title).slice(0, 4000);
    const matched = terms.filter((term) => hitsTerms(`${item.title} ${summary}`, [term]));
    const congress = currentCongress(item.publishedAt);
    if (!congresses.includes(congress) || (capabilityId && !matched.length)) continue;
    const evidence = officialEvidence(item.link, item.title, summary, item.syncedAt);
    if (!evidence) continue;
    rows.push(
      await store.propose(tx, ctx, clientId, {
        kind: 'statement',
        ...(capabilityId ? { capabilityId } : {}),
        payload: {
          memberId,
          sourceDirectory: 'congress',
          officeTerm: `congress:${congress}`,
          statementDate: item.publishedAt.toISOString(),
          summary,
          tags: matched.slice(0, 40),
          pressItemId: item.id,
        },
        evidence: [evidence],
      }),
    );
  }
  return rows;
}

async function approvedStatementSignals(
  tx: PortfolioTx,
  store: PortfolioProposalStore,
  ctx: TenantContext,
  clientId: string,
  memberId: string,
  terms: string[],
  capabilityId?: string,
): Promise<OfficeSignal[]> {
  const rows = await tx.clientPortfolioProposal.findMany({
    where: { tenantId: ctx.tenantId, clientId, kind: 'statement', status: 'approved' },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  const signals: OfficeSignal[] = [];
  for (const row of rows) {
    if (!(await portfolioEvidenceVisible(tx, ctx, clientId, row.evidence))) continue;
    const input = store.input(row);
    if (
      input.kind !== 'statement' ||
      input.payload.sourceDirectory !== 'congress' ||
      input.payload.memberId !== memberId ||
      input.payload.officeTerm !== `congress:${currentCongress()}` ||
      (capabilityId &&
        !hitsTerms(`${input.payload.summary} ${input.payload.tags.join(' ')}`, terms))
    )
      continue;
    for (const evidence of input.evidence)
      signals.push({
        kind: 'statement',
        rationale: `Reviewed statement dated ${input.payload.statementDate.slice(0, 10)}: ${input.payload.summary}`,
        evidence,
      });
  }
  return signals.slice(0, 8);
}

async function relationshipContext(
  tx: PortfolioTx,
  ctx: TenantContext,
  clientId: string,
  memberId: string,
) {
  const existing = await tx.clientTarget.findFirst({
    where: {
      tenantId: ctx.tenantId,
      clientId,
      memberId,
      sourceDirectory: 'congress',
      officeTerm: `congress:${currentCongress()}`,
    },
  });
  if (!existing) return { caution: '', entryPoint: undefined, owner: undefined };
  const owner =
    existing.ownerUserId &&
    (await tx.tenantMembership.findFirst({
      where: { tenantId: ctx.tenantId, userId: existing.ownerUserId, status: 'active' },
    }))
      ? existing.ownerUserId
      : undefined;
  return {
    owner,
    entryPoint: existing.nextStep
      ? `Existing relationship next step: ${existing.nextStep}`.slice(0, 4000)
      : undefined,
    caution: ` Existing relationship: ${existing.relationshipStatus}; stance: ${existing.stance}.${existing.lastContactAt ? ` Last contact ${existing.lastContactAt.toISOString().slice(0, 10)}.` : ' No last-contact date is recorded.'}${existing.relationshipStatus === 'declined' || existing.stance === 'declined' ? ' Do not treat this recommendation as permission to resume outreach after a decline.' : ''}`,
  };
}

export async function refreshSourcedOffices(
  tx: PortfolioTx,
  store: PortfolioProposalStore,
  ctx: TenantContext,
  clientId: string,
  ranked: OfficeRecommendation[],
  capabilityId?: string,
) {
  const { terms, facilities, owner } = await clientInputs(tx, ctx, clientId, capabilityId);
  const proposals = [],
    statementProposals = [];
  for (const candidate of ranked.slice(0, 12)) {
    const member = await tx.congressMember.findUnique({
      where: { bioguideId: candidate.memberId },
    });
    if (!member?.isCurrent || !member.congresses.includes(currentCongress())) continue;
    if (capabilityId && !terms.length) continue;
    statementProposals.push(
      ...(await stageStatements(
        tx,
        store,
        ctx,
        clientId,
        member.bioguideId,
        member.congresses,
        terms,
        capabilityId,
      )),
    );
    const signals = [
      ...(await approvedStatementSignals(
        tx,
        store,
        ctx,
        clientId,
        member.bioguideId,
        terms,
        capabilityId,
      )),
      ...(await canonicalOfficeSignals(tx, member, terms, facilities)),
    ];
    if (!signals.some((signal) => signal.evidence.sourceType === 'official')) continue;
    const evidence = [
      ...new Map(
        signals.map((signal) => [JSON.stringify(signal.evidence), signal.evidence]),
      ).values(),
    ].slice(0, 24);
    const relationship = await relationshipContext(tx, ctx, clientId, member.bioguideId);
    const suggestedOwner = relationship.owner ?? owner;
    const recent = evidence.some(
      (item) => Date.parse(item.observedAt) >= Date.now() - 180 * 86_400_000,
    );
    const input = {
      kind: 'office_recommendation',
      ...(capabilityId ? { capabilityId } : {}),
      payload: {
        memberId: member.bioguideId,
        sourceDirectory: 'congress',
        officeTerm: `congress:${currentCongress()}`,
        rationale: signals
          .map((signal) => signal.rationale)
          .join('\n')
          .slice(0, 4000),
        entryPoint:
          relationship.entryPoint ??
          (candidate.committee
            ? `Review the ${candidate.committee} committee connection and confirm the responsible staff contact.`
            : 'Review the official office contact page and confirm the relevant policy staff.'),
        whyNot: `Fit reflects ${new Set(signals.map((signal) => signal.kind)).size} sourced signal types, not promised support. Confirm current priorities, staff responsibility, and the ask.${signals.some((signal) => signal.kind === 'geography') ? '' : ' No verified current facility constituency match was established.'}${recent ? '' : ' No evidence was observed in the past 180 days; verify recency.'}${relationship.caution}`,
        ...(suggestedOwner ? { suggestedOwnerUserId: suggestedOwner } : {}),
        fitRating: officeFit(signals),
        stance: 'unknown',
      },
      evidence,
    };
    const sourceRevision = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    proposals.push(await store.refreshGeneratedOffice(tx, ctx, clientId, input, sourceRevision));
  }
  return {
    proposals,
    statementProposals,
    gaps: proposals.length
      ? []
      : [
          'No ranked current office has visible, dated official evidence matching approved client terms or a reviewed statement.',
        ],
  };
}
