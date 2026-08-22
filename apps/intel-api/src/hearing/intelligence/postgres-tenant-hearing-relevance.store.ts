import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type {
  TenantHearingRelevance,
  TenantHearingRelevanceSink,
} from './public-hearing-intelligence.types.js';

/**
 * FORCE-RLS tenant relevance store. Public insights are immutable inputs here;
 * every write is tenant-scoped and contains only a relevance explanation, never
 * a mutation of the global public record.
 */
export class PostgresTenantHearingRelevanceStore implements TenantHearingRelevanceSink {
  constructor(private readonly prisma: PrismaService) {}

  async upsertMany(matches: readonly TenantHearingRelevance[]): Promise<void> {
    const byTenant = new Map<string, TenantHearingRelevance[]>();
    for (const match of matches) {
      const list = byTenant.get(match.tenantId) ?? [];
      list.push(match);
      byTenant.set(match.tenantId, list);
    }
    for (const [tenantId, tenantMatches] of byTenant) {
      await this.prisma.withTenantRetry(tenantId, async (tx) => {
        for (const match of tenantMatches) await upsertOne(tx, match);
      });
    }
  }

  /** Replace the tenant's matches for the exact public-insight batch. */
  async replaceForInsights(input: {
    tenantId: string;
    hearingId: string;
    insightIds: readonly string[];
    matches: readonly TenantHearingRelevance[];
  }): Promise<void> {
    if (
      input.matches.some(
        (match) =>
          match.tenantId !== input.tenantId ||
          match.hearingId !== input.hearingId ||
          !input.insightIds.includes(match.insightId),
      )
    ) {
      throw new Error('Tenant relevance replacement contains an out-of-scope match');
    }

    await this.prisma.withTenantRetry(
      input.tenantId,
      async (tx) => {
        await tx.$executeRawUnsafe(
          `DELETE FROM tenant_hearing_relevance
           WHERE tenant_id=$1::uuid
             AND hearing_id=$2
             AND insight_id = ANY($3::text[])`,
          input.tenantId,
          input.hearingId,
          [...input.insightIds],
        );
        for (const match of input.matches) await upsertOne(tx, match);
      },
      { timeoutMs: 30_000, retries: 3 },
    );
  }
}

async function upsertOne(
  tx: Prisma.TransactionClient,
  match: TenantHearingRelevance,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO tenant_hearing_relevance (
       id, tenant_id, client_id, client_name, hearing_id, insight_id,
       score, matched_on, rationale, created_at, updated_at
     ) VALUES (
       $1, $2::uuid, $3::uuid, $4, $5, $6,
       $7, $8::jsonb, $9, $10::timestamptz, now()
     )
     ON CONFLICT (tenant_id, client_id, insight_id) DO UPDATE SET
       id=EXCLUDED.id,
       client_name=EXCLUDED.client_name,
       hearing_id=EXCLUDED.hearing_id,
       score=EXCLUDED.score,
       matched_on=EXCLUDED.matched_on,
       rationale=EXCLUDED.rationale,
       updated_at=now()`,
    match.id,
    match.tenantId,
    match.clientId,
    match.clientName ?? null,
    match.hearingId,
    match.insightId,
    match.score,
    JSON.stringify(match.matchedOn),
    match.rationale,
    match.createdAt,
  );
}
