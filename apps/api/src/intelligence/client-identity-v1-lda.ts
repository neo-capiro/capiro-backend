import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientIdentityLdaPorts } from './client-identity-v1.types.js';

/** Canonical LDA id selection, tenant resolution and global LDA catalog reads. */
export class ClientIdentityV1Lda {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientIdentityLdaPorts,
  ) {}

  pickLdaClientIds(cached: number[] | null | undefined, confirmedExternalIds: string[]): number[] {
    const c = (cached ?? []).filter((n) => Number.isInteger(n));
    if (c.length) return Array.from(new Set(c));
    return Array.from(
      new Set(confirmedExternalIds.map((e) => Number(e)).filter((n) => Number.isInteger(n))),
    );
  }

  async resolveLdaClientIds(clientId: string, tenantId: string): Promise<number[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId },
        select: { ldaClientIds: true },
      });
      if (!client) return [];
      if ((client.ldaClientIds ?? []).length)
        return this.ports.pickLdaClientIds(client.ldaClientIds, []);
      const confirmed = await tx.clientIntelMapping.findMany({
        where: { clientId, source: 'lda', confirmed: true },
        select: { externalId: true },
      });
      return this.ports.pickLdaClientIds(
        [],
        confirmed.map((m) => m.externalId),
      );
    });
  }

  async confirmedLdaIds(clientId: string, tenantId: string): Promise<number[]> {
    const mappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source: 'lda', confirmed: true },
        select: { externalId: true },
      }),
    );
    return this.ports.pickLdaClientIds(
      [],
      mappings.map((m) => m.externalId),
    );
  }

  async issueCodesForLdaIds(ldaClientIds: number[]): Promise<string[]> {
    if (!ldaClientIds.length) return [];
    const codeRows = await this.prisma.$queryRaw<Array<{ code: string }>>`
      SELECT DISTINCT unnest(issue_codes) AS code
      FROM lda_client WHERE id = ANY(${ldaClientIds}::int[]) AND issue_codes IS NOT NULL
    `;
    return codeRows.map((r) => r.code).filter(Boolean);
  }

  async fetchLdaByIds(ldaClientIds: number[]) {
    if (!ldaClientIds.length) return null;
    const agg = await this.prisma.$queryRaw<
      Array<{ total_filings: number; total_spending: number | null }>
    >`
      SELECT COALESCE(SUM(total_filings), 0)::int AS total_filings,
             SUM(total_spending)::float AS total_spending
      FROM lda_client WHERE id = ANY(${ldaClientIds}::int[])
    `;
    const filings = await this.prisma.ldaFiling.findMany({
      where: { clientId: { in: ldaClientIds } },
      orderBy: { dtPosted: 'desc' },
      take: 10,
    });
    // Stale/unknown ids (no lda_client rows and no filings) → treat as unmatched.
    if ((agg[0]?.total_filings ?? 0) === 0 && filings.length === 0) return null;

    const codeRows = await this.prisma.$queryRaw<Array<{ code: string }>>`
      SELECT DISTINCT unnest(issue_codes) AS code
      FROM lda_client WHERE id = ANY(${ldaClientIds}::int[]) AND issue_codes IS NOT NULL
    `;
    const yearlySpend = await this.prisma.$queryRaw<Array<{ year: number; amount: number }>>`
      SELECT filing_year as year, COALESCE(SUM(income), 0)::float as amount
      FROM lda_filing WHERE client_id = ANY(${ldaClientIds}::int[])
      GROUP BY filing_year ORDER BY filing_year
    `;

    return {
      matched: true,
      ldaClientId: ldaClientIds[0]!, // representative scalar (frontend back-compat)
      ldaClientIds, // the full set
      confidence: 1.0,
      totalFilings: agg[0]?.total_filings ?? 0,
      totalSpending: agg[0]?.total_spending ?? null,
      issueCodes: codeRows.map((r) => r.code).filter(Boolean),
      recentFilings: filings,
      yearlySpend,
    };
  }

  async fuzzyMatchLda(clientName: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: number;
        name: string;
        total_filings: number;
        total_spending: number | null;
        issue_codes: string[];
        similarity: number;
      }>
    >`
      SELECT c.id, c.name, c.total_filings, c.total_spending,
             COALESCE(c.issue_codes, '{}') as issue_codes,
             similarity(c.name, ${clientName}) as similarity
      FROM lda_client c
      WHERE similarity(c.name, ${clientName}) > 0.3
      ORDER BY similarity DESC
      LIMIT 1
    `;
    if (!rows.length) return null;

    const match = rows[0]!;
    // Get recent filings
    const filings = await this.prisma.ldaFiling.findMany({
      where: { clientId: match.id },
      orderBy: { dtPosted: 'desc' },
      take: 10,
    });
    // Get yearly spend trend
    const yearlySpend = await this.prisma.$queryRaw<Array<{ year: number; amount: number }>>`
      SELECT filing_year as year, COALESCE(SUM(income), 0)::float as amount
      FROM lda_filing WHERE client_id = ${match.id}
      GROUP BY filing_year ORDER BY filing_year
    `;

    return {
      matched: true,
      ldaClientId: match.id,
      ldaClientIds: [match.id],
      confidence: match.similarity,
      totalFilings: match.total_filings,
      totalSpending: match.total_spending,
      issueCodes: match.issue_codes,
      recentFilings: filings,
      yearlySpend,
    };
  }

  async findCompetitors(clientName: string, issueCodes: string[], ldaClientIds: number[]) {
    if (!issueCodes.length) return { topBySpend: [], newEntrants: [] };

    // Self-exclusion (AC-9.2): a RESOLVED client excludes its own LDA ids
    // (c.id <> ALL(ids)) so its other-registrant filings never surface as its
    // own competitor. An UNRESOLVED client (empty id set) has no ids to exclude,
    // so we fall back to a name-similarity guard (< 0.6) — otherwise the client
    // would appear as its own top competitor. Both branches are expressed in
    // parameterized SQL (no dynamic string building); cardinality(ids) picks
    // the active branch per-row.
    const ids = ldaClientIds;

    // Find top spenders on the same issues (excluding the client itself)
    const topBySpend = await this.prisma.$queryRaw<
      Array<{ name: string; total_spending: number; shared_issues: string[] }>
    >`
      SELECT c.name, c.total_spending::float as total_spending,
             c.issue_codes as shared_issues
      FROM lda_client c
      WHERE c.issue_codes && ${issueCodes}::text[]
        AND (
          (cardinality(${ids}::int[]) > 0 AND c.id <> ALL(${ids}::int[]))
          OR (cardinality(${ids}::int[]) = 0 AND similarity(c.name, ${clientName}) < 0.6)
        )
        AND c.total_spending IS NOT NULL
      ORDER BY c.total_spending DESC
      LIMIT 10
    `;

    // Find new entrants (first filing in last 90 days)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const newEntrants = await this.prisma.$queryRaw<
      Array<{ name: string; first_filing_date: string; issues: string[] }>
    >`
      SELECT c.name, MIN(f.dt_posted)::text as first_filing_date,
             c.issue_codes as issues
      FROM lda_client c
      JOIN lda_filing f ON f.client_id = c.id
      WHERE c.issue_codes && ${issueCodes}::text[]
        AND (
          (cardinality(${ids}::int[]) > 0 AND c.id <> ALL(${ids}::int[]))
          OR (cardinality(${ids}::int[]) = 0 AND similarity(c.name, ${clientName}) < 0.6)
        )
      GROUP BY c.id, c.name, c.issue_codes
      HAVING MIN(f.dt_posted) >= ${ninetyDaysAgo}
      ORDER BY MIN(f.dt_posted) DESC
      LIMIT 5
    `;

    return {
      topBySpend: topBySpend.map((r) => ({
        name: r.name,
        totalSpending: r.total_spending,
        sharedIssues: r.shared_issues,
      })),
      newEntrants: newEntrants.map((r) => ({
        name: r.name,
        firstFilingDate: r.first_filing_date,
        issues: r.issues,
      })),
    };
  }
}
