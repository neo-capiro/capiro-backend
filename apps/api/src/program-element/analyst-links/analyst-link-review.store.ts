import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  linkReviewHash,
  type LinkReviewKind,
  type LinkReviewStatus,
} from './analyst-link-review.types.js';

type Tx = Prisma.TransactionClient;
const link = {
  id: true,
  peCode: true,
  programId: true,
  matchBasis: true,
  confidence: true,
  reviewStatus: true,
  createdAt: true,
  updatedAt: true,
} as const;
const program = {
  select: { id: true, canonicalName: true, component: true, status: true, updatedAt: true },
} as const;
const document = {
  select: {
    id: true,
    title: true,
    sourceUrl: true,
    sha256: true,
    sourceKey: true,
    supersededByDocumentId: true,
    ingestedAt: true,
  },
} as const;
const provisionSelect = {
  ...link,
  projectCode: true,
  program,
  provision: {
    select: {
      id: true,
      heading: true,
      text: true,
      committee: true,
      fy: true,
      pageStart: true,
      pageEnd: true,
      actionType: true,
      updatedAt: true,
      sourceDocument: document,
    },
  },
} as const;
const samSelect = {
  ...link,
  program,
  opportunity: {
    select: {
      id: true,
      noticeId: true,
      title: true,
      description: true,
      noticeType: true,
      baseType: true,
      agency: true,
      office: true,
      solicitationNumber: true,
      sourceUrl: true,
      responseDeadline: true,
      postedDate: true,
      archiveDate: true,
      active: true,
      updatedAt: true,
      lastSyncedAt: true,
    },
  },
} as const;

/** Global public source rows, reachable only through the HQ review service. */
export async function readLinkReviewCandidate(tx: Tx, kind: LinkReviewKind, id: string) {
  const row =
    kind === 'provision'
      ? await tx.provisionPeLink.findUnique({ where: { id }, select: provisionSelect })
      : await tx.samOpportunityMatch.findUnique({ where: { id }, select: samSelect });
  if (!row) throw new NotFoundException('Review candidate unavailable');
  const pe = row.peCode
    ? await tx.programElement.findUnique({
        where: { peCode: row.peCode },
        select: { peCode: true, title: true, service: true, retiredAt: true },
      })
    : null;
  const source = 'provision' in row ? row.provision : row.opportunity;
  const value = {
    id: row.id,
    kind,
    reviewStatus: row.reviewStatus,
    matchBasis: row.matchBasis,
    confidence: row.confidence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    peCode: row.peCode,
    projectCode: 'projectCode' in row ? row.projectCode : null,
    programId: row.programId,
    program: row.program,
    programElement: pe,
    source,
  };
  return { ...value, version: linkReviewHash(value) };
}
export type LinkReviewCandidate = Awaited<ReturnType<typeof readLinkReviewCandidate>>;

export async function lockLinkReviewCandidate(tx: Tx, kind: LinkReviewKind, id: string) {
  const table =
    kind === 'provision' ? Prisma.sql`provision_pe_link` : Prisma.sql`sam_opportunity_match`;
  const found = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM ${table}
    WHERE id=${id}::uuid FOR UPDATE`);
  if (!found.length) throw new NotFoundException('Review candidate unavailable');
  const row = await readLinkReviewCandidate(tx, kind, id);
  if (kind === 'provision') {
    await tx.$queryRaw`SELECT id FROM committee_report_provision WHERE id=${row.source.id}::uuid FOR SHARE`;
    // A provision's source association is stable only after locking its parent.
    const current = await tx.committeeReportProvision.findUnique({
      where: { id: row.source.id },
      select: { sourceDocumentId: true },
    });
    if (current?.sourceDocumentId)
      await tx.$queryRaw`SELECT id FROM source_document WHERE id=${current.sourceDocumentId}::uuid FOR SHARE`;
  } else {
    await tx.$queryRaw`SELECT id FROM sam_opportunity WHERE id=${row.source.id}::uuid FOR SHARE`;
  }
  if (row.programId)
    await tx.$queryRaw`SELECT id FROM program WHERE id=${row.programId}::uuid FOR SHARE`;
  if (row.peCode)
    await tx.$queryRaw`SELECT pe_code FROM program_element WHERE pe_code=${row.peCode} FOR SHARE`;
  return readLinkReviewCandidate(tx, kind, id);
}

export async function listLinkReviews(
  tx: Tx,
  kind: LinkReviewKind,
  status: LinkReviewStatus,
  page: number,
  limit: number,
) {
  const where = { reviewStatus: status },
    orderBy = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
  const args = { where, orderBy, skip: (page - 1) * limit, take: limit, select: { id: true } };
  const ids =
    kind === 'provision'
      ? await tx.provisionPeLink.findMany(args)
      : await tx.samOpportunityMatch.findMany(args);
  const counts =
    kind === 'provision'
      ? await tx.provisionPeLink.groupBy({ by: ['reviewStatus'], _count: { _all: true } })
      : await tx.samOpportunityMatch.groupBy({ by: ['reviewStatus'], _count: { _all: true } });
  const data = [];
  for (const row of ids) {
    const detail = await readLinkReviewCandidate(tx, kind, row.id);
    const { source, ...entry } = detail;
    data.push({
      ...entry,
      source: { id: source.id, title: 'heading' in source ? source.heading : source.title },
    });
  }
  return {
    schemaVersion: 1 as const,
    kind,
    data,
    page,
    limit,
    total: counts.find((row) => row.reviewStatus === status)?._count._all ?? 0,
    counts: Object.fromEntries(counts.map((row) => [row.reviewStatus, row._count._all])),
    observedAt: new Date().toISOString(),
  };
}
