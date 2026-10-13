import type { PrismaService } from '../prisma/prisma.service.js';
import { decToNumber } from './client-intelligence-values.js';

export class ClientMappingV1Catalog {
  constructor(private readonly prisma: PrismaService) {}

  async searchLdaClients(query: string) {
    const q = query.trim();
    if (!q) return [];
    const asId = Number(q);
    const idMatch = Number.isInteger(asId) && asId > 0 ? asId : -1;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: number;
        name: string;
        state: string | null;
        total_filings: number;
        latest_filing_year: number | null;
        total_spending: number | null;
        issue_codes: string[];
        similarity: number;
      }>
    >`
      SELECT id, name, state,
             total_filings,
             latest_filing_year,
             total_spending::float AS total_spending,
             COALESCE(issue_codes, '{}') AS issue_codes,
             GREATEST(
               similarity(name, ${q}),
               CASE WHEN id = ${idMatch} THEN 1 ELSE 0 END
             ) AS similarity
      FROM lda_client
      WHERE similarity(name, ${q}) > 0.2 OR id = ${idMatch}
      ORDER BY similarity DESC, total_filings DESC
      LIMIT 25
    `;
    return rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      state: r.state,
      totalFilings: Number(r.total_filings ?? 0),
      latestFilingYear: r.latest_filing_year,
      totalSpending: r.total_spending,
      issueCodes: r.issue_codes ?? [],
      similarity: Number(r.similarity ?? 0),
    }));
  }

  async searchFecEmployers(query: string) {
    const q = query.trim();
    if (!q) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{
        employer: string;
        contribution_count: number;
        total_amount: number | null;
        latest_year: number | null;
        similarity: number;
      }>
    >`
      SELECT contributor_employer AS employer,
             COUNT(*)::int AS contribution_count,
             COALESCE(SUM(amount), 0)::float AS total_amount,
             MAX(EXTRACT(YEAR FROM contribution_date))::int AS latest_year,
             similarity(contributor_employer, ${q}) AS similarity
      FROM fec_contribution
      WHERE contributor_employer IS NOT NULL
        AND similarity(contributor_employer, ${q}) > 0.2
      GROUP BY contributor_employer
      ORDER BY similarity DESC, total_amount DESC
      LIMIT 25
    `;
    return rows.map((r) => ({
      // For fec_employer the employer string is both the id and the name.
      id: r.employer,
      name: r.employer,
      contributionCount: Number(r.contribution_count ?? 0),
      totalAmount: r.total_amount,
      latestYear: r.latest_year,
      similarity: Number(r.similarity ?? 0),
    }));
  }

  async searchFecCommittees(query: string) {
    const q = query.trim();
    if (!q) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        committee_type: string | null;
        cycles: number[];
        last_synced_at: Date | null;
      }>
    >`
      SELECT id, name, committee_type, cycles, last_synced_at
      FROM fec_committee
      WHERE committee_type IN ('Q', 'N', 'O', 'V', 'W')
        AND (id = ${q.toUpperCase()} OR similarity(name, ${q}) > 0.2)
      ORDER BY (id = ${q.toUpperCase()}) DESC, similarity(name, ${q}) DESC, name
      LIMIT 25
    `;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      committeeType: row.committee_type,
      // The catalog does not currently store official active/terminated status.
      active: null,
      cycle: row.cycles.length ? Math.max(...row.cycles) : null,
      sourceSyncedAt: row.last_synced_at?.toISOString() ?? null,
    }));
  }

  async searchContractors(query: string) {
    const q = query.trim();
    if (!q) return { results: [], unsupportedIdentifier: null as null | string };
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
    const upper = q.toUpperCase();
    const isUei = /^[A-Z0-9]{12}$/.test(upper);
    // A CAGE code is 5 alphanumerics. Detected so the caller can be TOLD that
    // `federal_contractor` carries no CAGE column — its source does not publish
    // one (sync-openspending.ts writes only uei/recipientId). A CAGE search that
    // silently returned zero rows would read as "this CAGE is not a federal
    // contractor", which is a claim the data cannot support.
    const isCage = !isUei && /^[A-Z0-9]{5}$/.test(upper) && /\d/.test(upper);

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        uei: string | null;
        category: string | null;
        total_contracts: number | null;
        rank_by_contracts: number | null;
        last_synced_at: Date | null;
        similarity: number;
      }>
    >`
      SELECT id, name, uei, category,
             total_contracts::float AS total_contracts,
             rank_by_contracts,
             last_synced_at,
             GREATEST(
               similarity(name, ${q}),
               CASE WHEN ${isUuid} AND id::text = ${q} THEN 1 ELSE 0 END,
               -- An exact UEI is a verified identifier, so it must outrank every
               -- name score — and it must be searchable at all, which it was not:
               -- "RTX CORPORATION" and "RAYTHEON TECHNOLOGIES CORPORATION" share
               -- no trigram overlap, so the only way to reach the right row is by
               -- its identifier.
               CASE WHEN ${isUei} AND uei = ${isUei ? upper : null} THEN 1 ELSE 0 END
             ) AS similarity
      FROM federal_contractor
      WHERE similarity(name, ${q}) > 0.2
         OR (${isUuid} AND id::text = ${q})
         OR (${isUei} AND uei = ${isUei ? upper : null})
      ORDER BY similarity DESC, total_contracts DESC NULLS LAST
      LIMIT 25
    `;
    return {
      results: rows.map((r) => ({
        id: r.id,
        name: r.name,
        uei: r.uei,
        category: r.category,
        totalContracts: decToNumber(r.total_contracts),
        rankByContracts: r.rank_by_contracts,
        sourceSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
        similarity: Number(r.similarity ?? 0),
        matchedOnIdentifier: isUei && r.uei != null && r.uei.toUpperCase() === upper,
      })),
      unsupportedIdentifier: isCage
        ? 'That looks like a CAGE code. The federal contractor catalog Capiro holds carries UEI but no CAGE code, so a CAGE cannot be looked up here — search by name or UEI instead.'
        : null,
    };
  }

  async searchAssistanceRecipients(query: string) {
    const q = query.trim();
    if (!q) return [];
    const isUei = /^[A-Z0-9]{12}$/i.test(q);
    const rows = await this.prisma.$queryRaw<
      Array<{
        uei: string | null;
        name: string | null;
        state: string | null;
        award_count: number;
        total_obligated: number;
        similarity: number;
      }>
    >`
      SELECT
        MAX(recipient_uei) AS uei,
        MAX(recipient_name) AS name,
        MAX(recipient_state) AS state,
        COUNT(*)::int AS award_count,
        COALESCE(SUM(total_obligated_amount), 0)::float AS total_obligated,
        MAX(sim) AS similarity
      FROM (
        SELECT recipient_uei, recipient_name, recipient_state, total_obligated_amount,
               GREATEST(
                 similarity(lower(recipient_name), lower(${q})),
                 word_similarity(lower(${q}), lower(recipient_name)),
                 CASE WHEN ${isUei} AND recipient_uei = upper(${q}) THEN 1 ELSE 0 END
               ) AS sim
        FROM federal_assistance_award
        WHERE recipient_name IS NOT NULL
          -- Both predicates below are index-driven; the previous form was not.
          -- % reaches faa_recipient_name_trgm_idx (gin on lower(recipient_name));
          -- a bare similarity(...) > c is a plain function call and seq-scans
          -- the largest new table. The expression must be spelled
          -- lower(recipient_name) to match the functional index.
          --
          -- % alone would raise the floor from the old 0.2 to pg_trgm's default
          -- similarity_threshold of 0.3, which silently drops short-query
          -- recall ("MIT" against "MASSACHUSETTS INSTITUTE OF TECHNOLOGY").
          -- %> is the commutator of <% (word_similarity): it asks whether the
          -- query matches a continuous extent of the name rather than the whole
          -- string, which is what restores those short queries. It is also
          -- gin_trgm_ops-supported, so recall comes back without the seq-scan.
          --
          -- recipient_uei is compared bare, not upper(recipient_uei): the column
          -- has a plain btree (faa_recipient_uei_idx) and wrapping it in upper()
          -- makes that index unusable. UEIs are uppercase alphanumeric by SAM
          -- definition and the writer shape-checks 12 alphanumeric on ingest, so
          -- normalising only the parameter side is sufficient.
          AND (
            lower(recipient_name) % lower(${q})
            OR lower(recipient_name) %> lower(${q})
            OR (${isUei} AND recipient_uei = upper(${q}))
          )
      ) matched
      GROUP BY COALESCE(recipient_uei, recipient_name)
      ORDER BY similarity DESC, total_obligated DESC
      LIMIT 25
    `;
    return rows.map((r) => ({
      // Stable pin identifier: UEI when the recipient has one on file, else
      // the recipient name — mirrors the SQL's own COALESCE(uei, name) group
      // key so a pin always lands back on the exact group it was picked from.
      id: r.uei ?? r.name ?? '',
      uei: r.uei,
      name: r.name,
      state: r.state,
      awardCount: r.award_count,
      totalObligated: r.total_obligated,
      similarity: Number(r.similarity ?? 0),
    }));
  }
}
