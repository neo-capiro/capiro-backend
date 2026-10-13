import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  OfficeRecommendation,
  OfficeRecommenderService,
} from './office-recommender.service.js';
import type { TrackedBillsResult } from './intelligence-bill-discovery.shared.js';

export interface ClientRelationshipsV1Ports {
  confirmedLdaIds(clientId: string, tenantId: string): Promise<number[]>;
  getTrackedBills(clientId: string, tenantId: string): Promise<TrackedBillsResult>;
  getIssueLeaderboard(issueCode: string): ReturnType<ClientRelationshipsV1['getIssueLeaderboard']>;
  officeRecommender(): OfficeRecommenderService | undefined;
}

export class ClientRelationshipsV1 {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientRelationshipsV1Ports,
  ) {}

  async getCompetitorBoard(clientId: string, tenantId: string) {
    // Resolve the client's FULL LDA id set (all firm relationships), tenant-scoped.
    const ldaClientIds = await this.ports.confirmedLdaIds(clientId, tenantId);
    if (!ldaClientIds.length) return { competitors: [], leaderboards: [] };

    const codeRows = await this.prisma.$queryRaw<Array<{ code: string }>>`
      SELECT DISTINCT unnest(issue_codes) AS code
      FROM lda_client WHERE id = ANY(${ldaClientIds}::int[]) AND issue_codes IS NOT NULL
    `;
    const issueCodes = codeRows.map((r) => r.code).filter(Boolean);
    if (!issueCodes.length) return { competitors: [], leaderboards: [] };

    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [rows, leaderboards] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          registrant_name: string;
          filing_count: number;
          all_time_first: Date | null;
          shared_issues: string[];
        }>
      >`
        SELECT
          f.registrant_name,
          COUNT(*)::int AS filing_count,
          (SELECT MIN(f2.dt_posted) FROM lda_filing f2 WHERE f2.registrant_name = f.registrant_name) AS all_time_first,
          array_agg(DISTINCT ic) FILTER (WHERE ic IS NOT NULL) AS shared_issues
        FROM lda_filing f,
             LATERAL unnest(f.issue_codes) ic
        WHERE f.dt_posted >= ${ninetyDaysAgo}
          AND f.client_id != ALL(${ldaClientIds}::int[])
          AND f.issue_codes && ${issueCodes}::text[]
          AND ic = ANY(${issueCodes}::text[])
        GROUP BY f.registrant_name
        ORDER BY filing_count DESC
        LIMIT 20
      `,
      Promise.all(issueCodes.slice(0, 5).map((code) => this.ports.getIssueLeaderboard(code))),
    ]);

    return {
      competitors: rows.map((r) => ({
        registrantName: r.registrant_name,
        filingCount: r.filing_count,
        isNewEntrant: r.all_time_first !== null && r.all_time_first >= ninetyDaysAgo,
        issueOverlap: r.shared_issues ?? [],
      })),
      leaderboards,
    };
  }

  async getExStaffers(clientId: string, tenantId: string) {
    // confirmedLdaIds is tenant-scoped (client_intel_mapping now has tenant_id + RLS),
    // so a foreign clientId yields an empty set — no separate belongs-check needed.
    const ldaClientIds = await this.ports.confirmedLdaIds(clientId, tenantId);
    if (!ldaClientIds.length) return { lobbyists: [] };

    const regRows = await this.prisma.$queryRaw<Array<{ registrant_id: number }>>`
      SELECT DISTINCT registrant_id FROM lda_filing
      WHERE client_id = ANY(${ldaClientIds}::int[]) AND registrant_id IS NOT NULL
    `;
    const registrantIds = regRows.map((r) => r.registrant_id);
    if (!registrantIds.length) return { lobbyists: [] };

    const lobbyists = await this.prisma.$queryRaw<
      Array<{
        id: number;
        first_name: string;
        last_name: string;
        covered_positions: unknown;
      }>
    >`
      SELECT id, first_name, last_name, covered_positions
      FROM lda_lobbyist
      WHERE registrant_ids && ${registrantIds}::int[]
        AND covered_positions::text != '[]'
      ORDER BY last_name, first_name
      LIMIT 50
    `;

    return {
      lobbyists: lobbyists.map((l) => ({
        name: `${l.first_name} ${l.last_name}`.trim(),
        coveredPositions: Array.isArray(l.covered_positions) ? l.covered_positions : [],
      })),
    };
  }

  async computeOfficeRecommendations(
    clientId: string,
    tenantId: string,
  ): Promise<OfficeRecommendation[]> {
    if (!this.ports.officeRecommender()) return [];
    const tracked = await this.ports.getTrackedBills(clientId, tenantId);
    const trackedBillIds = tracked.bills
      .map((b) => b.identifier)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    return this.ports.officeRecommender()!.recommend({
      clientId,
      tenantId,
      trackedBillIds,
      trackedBills: tracked.bills.map((b) => ({
        identifier: b.identifier,
        subjectNames: b.subjectNames ?? [],
      })),
      issueCodes: tracked.issueCodes ?? [],
    });
  }

  async getIssueLeaderboard(issueCode: string) {
    const issueRows = await this.prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM lda_issue_code WHERE code = ${issueCode}
    `;
    const issueName = issueRows[0]?.name ?? issueCode;

    const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [totalRows, registrantRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: string }>>`
        SELECT COUNT(*)::text AS total FROM lda_filing
        WHERE dt_posted >= ${twoYearsAgo} AND ${issueCode} = ANY(issue_codes)
      `,
      this.prisma.$queryRaw<
        Array<{
          registrant_id: number | null;
          registrant_name: string;
          filing_count: number;
          total_income: number | null;
          first_filing_date: Date | null;
        }>
      >`
        SELECT
          registrant_id,
          registrant_name,
          COUNT(*)::int AS filing_count,
          COALESCE(SUM(income), 0)::float AS total_income,
          MIN(dt_posted) AS first_filing_date
        FROM lda_filing
        WHERE dt_posted >= ${twoYearsAgo}
          AND ${issueCode} = ANY(issue_codes)
          AND registrant_name != ''
        GROUP BY registrant_id, registrant_name
        ORDER BY filing_count DESC, total_income DESC
        LIMIT 20
      `,
    ]);

    const totalFilings = parseInt(totalRows[0]?.total ?? '0', 10);

    // Find lobbyists who work for multiple registrants on this issue (potential conflicts)
    const registrantIds = registrantRows
      .map((r) => r.registrant_id)
      .filter((id): id is number => id !== null);

    const sharedByRegistrantId = new Map<number, string[]>();

    if (registrantIds.length > 1) {
      const sharedRows = await this.readSharedLobbyists(registrantIds);

      for (const row of sharedRows) {
        for (const regId of row.shared_registrant_ids ?? []) {
          if (!sharedByRegistrantId.has(regId)) sharedByRegistrantId.set(regId, []);
          sharedByRegistrantId.get(regId)!.push(row.lobbyist_name);
        }
      }
    }

    return {
      issueCode,
      issueName,
      totalFilings,
      registrants: registrantRows.map((r) => ({
        name: r.registrant_name,
        filingCount: r.filing_count,
        totalIncome: r.total_income ?? 0,
        isNewEntrant: r.first_filing_date !== null && r.first_filing_date >= ninetyDaysAgo,
        firstFilingDate: r.first_filing_date?.toISOString() ?? null,
        sharedLobbyists:
          r.registrant_id != null ? (sharedByRegistrantId.get(r.registrant_id) ?? []) : [],
      })),
    };
  }

  private readSharedLobbyists(registrantIds: number[]) {
    return this.prisma.$queryRaw<Array<{ lobbyist_name: string; shared_registrant_ids: number[] }>>`
        SELECT
          TRIM(CONCAT(first_name, ' ', last_name)) AS lobbyist_name,
          ARRAY(
            SELECT r FROM unnest(registrant_ids) r WHERE r = ANY(${registrantIds}::int[])
          ) AS shared_registrant_ids
        FROM lda_lobbyist
        WHERE registrant_ids && ${registrantIds}::int[]
          AND (
            SELECT COUNT(*) FROM unnest(registrant_ids) r WHERE r = ANY(${registrantIds}::int[])
          ) > 1
        ORDER BY (
          SELECT COUNT(*) FROM unnest(registrant_ids) r WHERE r = ANY(${registrantIds}::int[])
        ) DESC
        LIMIT 30
      `;
  }
}
