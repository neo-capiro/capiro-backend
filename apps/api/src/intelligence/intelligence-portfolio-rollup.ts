import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';

type PeCapability = Prisma.ClientCapabilityGetPayload<{
  select: { clientId: true; peNumber: true; peNumbers: true };
}>;

export class IntelligencePortfolioRollup {
  constructor(private readonly prisma: PrismaService) {}

  async getPortfolioRollup(tenantId: string): Promise<{
    rollup: Record<
      string,
      {
        attentionCount: number;
        intelCount: number;
        nextTouch: { id: string; startsAt: string; subject: string } | null;
        /** Item 5: count of in_progress engagement tasks (work/readiness signal). */
        workCount: number;
      }
    >;
  }> {
    const now = new Date();

    const [taskCounts, billCounts, meetings, workCounts] = await this.readRollupSnapshot(
      tenantId,
      now,
    );

    const rollup: Record<
      string,
      {
        attentionCount: number;
        intelCount: number;
        nextTouch: { id: string; startsAt: string; subject: string } | null;
        workCount: number;
      }
    > = {};

    // Initialize from task counts (these have the client set).
    for (const row of taskCounts) {
      const cid = row.clientId as string;
      rollup[cid] = { attentionCount: row._count.id, intelCount: 0, nextTouch: null, workCount: 0 };
    }

    // Merge in bill counts.
    for (const row of billCounts) {
      const cid = row.clientId;
      if (!rollup[cid])
        rollup[cid] = { attentionCount: 0, intelCount: 0, nextTouch: null, workCount: 0 };
      rollup[cid].intelCount = row._count.id;
    }

    // Merge in earliest meeting per client (meetings are ordered by startsAt asc,
    // so the first one we encounter for each client is the earliest).
    for (const meeting of meetings) {
      const cid = meeting.clientId as string;
      if (!rollup[cid])
        rollup[cid] = { attentionCount: 0, intelCount: 0, nextTouch: null, workCount: 0 };
      if (!rollup[cid].nextTouch) {
        rollup[cid].nextTouch = {
          id: meeting.id,
          startsAt: meeting.startsAt.toISOString(),
          subject: meeting.subject,
        };
      }
    }

    // Merge in work counts (in_progress tasks).
    for (const row of workCounts) {
      const cid = row.clientId as string;
      if (!rollup[cid])
        rollup[cid] = { attentionCount: 0, intelCount: 0, nextTouch: null, workCount: 0 };
      rollup[cid].workCount = row._count.id;
    }

    return { rollup };
  }

  async getPortfolioPeSummary(
    tenantId: string,
    _userId: string | undefined,
  ): Promise<{
    netDeltaPct: number | null;
    peAttribution: Record<string, string[]>;
    watchedCount: number;
  }> {
    // 1. Fetch watched PE codes for this tenant (all users in tenant — the
    //    portfolio surface is tenant-wide, not per-user).
    const watches = await this.prisma.withTenant(tenantId, (tx) =>
      tx.programElementWatch.findMany({
        where: { tenantId },
        select: { peCode: true },
      }),
    );

    const peCodes = [...new Set(watches.map((w) => w.peCode))];
    if (peCodes.length === 0) {
      return { netDeltaPct: null, peAttribution: {}, watchedCount: 0 };
    }

    // 2. Fetch the most-material live delta per watched PE (supersededAt IS NULL).
    //    Use the deltaPct from the row with the highest materialityScore per PE.
    const deltas = await this.readPeDeltas(peCodes);

    // 3. Average the delta percentages for the net figure. Only count PEs with a
    //    non-null deltaPct — a null means "no comparable delta" and is not zero.
    const validDeltas = deltas.filter((d) => d.delta_pct != null && Number.isFinite(d.delta_pct));
    const netDeltaPct =
      validDeltas.length > 0
        ? validDeltas.reduce((sum, d) => sum + (d.delta_pct as number), 0) / validDeltas.length
        : null;

    // 4. Client attribution: find clients whose ClientCapability.peNumbers
    //    includes any of the watched PE codes. This is the join from watched
    //    PEs → clients who fund them.
    const capabilities = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientCapability.findMany({
        where: {
          OR: [{ peNumber: { in: peCodes } }, { peNumbers: { hasSome: peCodes } }],
        },
        select: {
          clientId: true,
          peNumber: true,
          peNumbers: true,
        },
      }),
    );

    // Resolve client names for the attribution map.
    const clientIds = [...new Set(capabilities.map((c) => c.clientId))];
    const clients =
      clientIds.length > 0
        ? await this.prisma.withTenant(tenantId, (tx) =>
            tx.client.findMany({
              where: { id: { in: clientIds }, status: { not: 'archived' } },
              select: { id: true, name: true },
            }),
          )
        : [];
    const clientNameMap = new Map(clients.map((c) => [c.id, c.name]));

    // Build peAttribution: peCode → array of client names.
    const peAttribution = this.projectPeAttribution(peCodes, capabilities, clientNameMap);

    return { netDeltaPct, peAttribution, watchedCount: peCodes.length };
  }

  private readRollupSnapshot(tenantId: string, now: Date) {
    return Promise.all([
      // Attention: open (non-done/canceled) engagement tasks per client.
      this.prisma.withTenant(tenantId, (tx) =>
        tx.engagementTask.groupBy({
          by: ['clientId'],
          where: {
            status: { in: ['todo', 'in_progress', 'blocked'] },
            clientId: { not: null },
          },
          _count: { id: true },
        }),
      ),
      // Intelligence: tracked bills per client.
      this.prisma.withTenant(tenantId, (tx) =>
        tx.trackedBill.groupBy({
          by: ['clientId'],
          _count: { id: true },
        }),
      ),
      // Next touch: earliest future shared meeting per client.
      this.prisma.withTenant(tenantId, (tx) =>
        tx.meeting.findMany({
          where: {
            startsAt: { gte: now },
            visibility: 'shared',
            status: { not: 'cancelled' },
            clientId: { not: null },
          },
          select: { id: true, clientId: true, startsAt: true, subject: true },
          orderBy: { startsAt: 'asc' },
        }),
      ),
      // Item 5 — Work column: in_progress engagement tasks per client.
      this.prisma.withTenant(tenantId, (tx) =>
        tx.engagementTask.groupBy({
          by: ['clientId'],
          where: {
            status: 'in_progress',
            clientId: { not: null },
          },
          _count: { id: true },
        }),
      ),
    ]);
  }

  private readPeDeltas(peCodes: string[]) {
    return this.prisma.$queryRaw<Array<{ pe_code: string; delta_pct: number | null }>>`
      SELECT pe_code, delta_pct
      FROM (
        SELECT
          d.pe_code,
          d.delta_pct,
          d.materiality_score,
          ROW_NUMBER() OVER (PARTITION BY d.pe_code ORDER BY d.materiality_score DESC) AS rn
        FROM program_element_delta d
        WHERE d.pe_code = ANY(${peCodes}::text[])
          AND d.superseded_at IS NULL
      ) ranked
      WHERE rn = 1
    `;
  }

  private projectPeAttribution(
    peCodes: string[],
    capabilities: PeCapability[],
    clientNameMap: Map<string, string>,
  ) {
    // Build peAttribution: peCode → array of client names.
    const peAttribution: Record<string, string[]> = {};

    for (const peCode of peCodes) {
      peAttribution[peCode] = [];
    }

    for (const cap of capabilities) {
      const name = clientNameMap.get(cap.clientId);
      if (!name) continue;
      // Check both peNumber (single) and peNumbers (array).
      if (cap.peNumber && peCodes.includes(cap.peNumber)) {
        if (!peAttribution[cap.peNumber]!.includes(name)) {
          peAttribution[cap.peNumber]!.push(name);
        }
      }
      if (Array.isArray(cap.peNumbers)) {
        for (const pe of cap.peNumbers) {
          if (peCodes.includes(pe) && !peAttribution[pe]!.includes(name)) {
            peAttribution[pe]!.push(name);
          }
        }
      }
    }

    return peAttribution;
  }
}
