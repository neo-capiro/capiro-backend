import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

export type BillMemberKind = 'federal_bill' | 'state_bill';

/** A material legislative change the source ingestion already detected. */
export interface ResearchPortfolioBillChangeNotice {
  /** Known tenant scope. Omitted only for cross-tenant maintenance runs. */
  tenantId?: string;
  targetKind: BillMemberKind;
  targetId: string;
  changeType: string;
  label: string;
  detail: string;
  actionDate: string | null;
  sourceUrl: string | null;
  sourceLabel: string;
  detectedAt: Date;
  /**
   * Recipients already proven eligible by the caller (portfolio ids). Omitted for
   * the source-owner paths, which rely on the createdAt baseline alone.
   */
  eligiblePortfolioIds?: readonly string[];
}

type BillChangeClient = Pick<PrismaClient, 'researchPortfolioMember' | 'researchPortfolio' | 'researchPortfolioEvent'>;

/**
 * Fan a single material legislative change out to the Research Portfolios that
 * already track that bill, as an immutable `bill_changed` event.
 *
 * This is the *recipient* step of the existing ingestion/change pipeline: the
 * source owners (tracker-change-detector for federal bills, emit-state-changes for
 * state bills) have already decided that the change is material and deduplicated
 * it. No new scheduler, detector or notification system is introduced, and no
 * external message is sent.
 *
 * Guarantees:
 * - deduplicated by (tenant, portfolio event idempotency key) — the DB unique is
 *   `(tenantId, idempotencyKey)`, so the key MUST differ per recipient portfolio.
 *   It is derived from the change identity plus the portfolio id, which keeps it
 *   bounded (<= 128 chars, the column width) and collision-safe, and means
 *   replaying a detection cycle never duplicates an event;
 * - silent baseline — a portfolio that added the bill after the change was
 *   detected receives nothing for that historical change;
 * - the event actor is the source (`actorKind: 'system'`), never a fabricated user.
 *
 * The caller must supply a system/bypass context: `research_portfolio_member` and
 * `research_portfolio_events` are tenant-scoped tables and this reads across the
 * portfolios of one tenant (or all tenants for a maintenance run).
 */

/** Bounded per-recipient event identity: change identity digest + portfolio id. */
export function billChangeIdempotencyKey(
  notice: Pick<ResearchPortfolioBillChangeNotice, 'targetKind' | 'targetId' | 'changeType' | 'actionDate'>,
  portfolioId: string,
): string {
  const identity = [
    notice.targetKind,
    notice.targetId,
    notice.changeType,
    notice.actionDate ?? 'undated',
  ].join('|');
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32);
  const readable = notice.changeType.replace(/[^a-z0-9_]/gi, '').slice(0, 24) || 'change';
  // 12 + 11 + 1 + 24 + 1 + 32 + 1 + 36 = 118 <= 128
  return `legislation:${notice.targetKind}:${readable}:${digest}:${portfolioId}`;
}

export async function recordResearchPortfolioBillChanges(
  prisma: BillChangeClient,
  notice: ResearchPortfolioBillChangeNotice,
): Promise<number> {
  const members = await prisma.researchPortfolioMember.findMany({
    where: {
      targetKind: notice.targetKind,
      targetId: notice.targetId,
      disposition: 'included',
      ...(notice.tenantId ? { tenantId: notice.tenantId } : {}),
      ...(notice.eligiblePortfolioIds
        ? { portfolioId: { in: [...notice.eligiblePortfolioIds] } }
        : {}),
      // Silent baseline: never surface a change that predates the membership.
      // `detectedAt` must be when THIS change was detected at the source — never
      // a sweep's previous checkpoint. A checkpoint as cut-off drops memberships
      // created during the window (and all memberships when the checkpoint is the
      // epoch first run), because it predates the change being reported.
      createdAt: { lte: notice.detectedAt },
    },
    select: { tenantId: true, portfolioId: true },
  });
  const portfolios = [...new Map(members.map((row) => [`${row.tenantId}:${row.portfolioId}`, row])).values()];
  if (!portfolios.length) return 0;

  const payload: Prisma.InputJsonObject = {
    targetKind: notice.targetKind,
    targetId: notice.targetId,
    changeType: notice.changeType,
    label: notice.label,
    detail: notice.detail,
    actionDate: notice.actionDate,
    sourceUrl: notice.sourceUrl,
    sourceLabel: notice.sourceLabel,
    detectedAt: notice.detectedAt.toISOString(),
  };

  let written = 0;
  for (const member of portfolios) {
    const portfolio = await prisma.researchPortfolio.findFirst({
      where: { id: member.portfolioId, tenantId: member.tenantId },
      select: { revision: true, lifecycle: true },
    });
    if (!portfolio) continue;
    const result = await prisma.researchPortfolioEvent.createMany({
      data: [
        {
          tenantId: member.tenantId,
          portfolioId: member.portfolioId,
          eventKind: 'bill_changed',
          aggregateRevision: portfolio.revision,
          actorUserId: null,
          actorKind: 'system',
          occurredAt: notice.detectedAt,
          idempotencyKey: billChangeIdempotencyKey(notice, member.portfolioId),
          payload,
        },
      ],
      skipDuplicates: true,
    });
    written += result.count;
  }
  return written;
}
