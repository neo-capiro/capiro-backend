import type { PrismaService } from '../prisma/prisma.service.js';
import { decToNumber } from './client-intelligence-values.js';
import type { ClientIdentityCatalogPorts } from './client-identity-v1.types.js';

/** UUID/name-safe contractor and lobbying-intelligence catalog resolution. */
export class ClientIdentityV1Catalog {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientIdentityCatalogPorts,
  ) {}

  isUuid(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
  }

  async fetchContractorById(id: string) {
    const raw = (id ?? '').trim();
    if (!raw) return null;

    // Prefer catalog uuid. Fall back to exact name (and award-name: prefix) so a
    // non-uuid external_id never 500s the profile — it either resolves or nulls.
    // IMPORTANT: never embed a non-uuid into `${x}::uuid` even under a false
    // AND branch — Postgres still type-checks the cast and throws 22P02.
    const nameFromSynthetic = raw.startsWith('award-name:')
      ? raw.slice('award-name:'.length).trim()
      : null;
    const nameKey = nameFromSynthetic || (!this.ports.isUuid(raw) ? raw : null);

    const rows = this.ports.isUuid(raw)
      ? await this.prisma.$queryRaw<
          Array<{
            id: string;
            name: string;
            total_contracts: number | null;
            rank_by_contracts: number | null;
            no_bid_total: number | null;
            yearly_spend_jsonb: object[];
            top_agencies_jsonb: object[];
          }>
        >`
          SELECT id, name, total_contracts, rank_by_contracts, no_bid_total,
                 COALESCE(yearly_spend_jsonb, '[]')::jsonb as yearly_spend_jsonb,
                 COALESCE(top_agencies_jsonb, '[]')::jsonb as top_agencies_jsonb
          FROM federal_contractor
          WHERE id = ${raw}::uuid
          LIMIT 1
        `
      : nameKey
        ? await this.prisma.$queryRaw<
            Array<{
              id: string;
              name: string;
              total_contracts: number | null;
              rank_by_contracts: number | null;
              no_bid_total: number | null;
              yearly_spend_jsonb: object[];
              top_agencies_jsonb: object[];
            }>
          >`
            SELECT id, name, total_contracts, rank_by_contracts, no_bid_total,
                   COALESCE(yearly_spend_jsonb, '[]')::jsonb as yearly_spend_jsonb,
                   COALESCE(top_agencies_jsonb, '[]')::jsonb as top_agencies_jsonb
            FROM federal_contractor
            WHERE name = ${nameKey}
            LIMIT 1
          `
        : [];
    if (!rows.length) return null;

    const match = rows[0]!;
    return {
      matched: true,
      contractorName: match.name,
      totalContracts: decToNumber(match.total_contracts),
      rankByContracts: match.rank_by_contracts,
      noBidTotal: decToNumber(match.no_bid_total),
      topAgencies: match.top_agencies_jsonb as { name: string; amount: number }[],
      yearlySpend: match.yearly_spend_jsonb as { year: number; amount: number }[],
    };
  }

  async fetchLobbyIntelById(id: string) {
    const raw = (id ?? '').trim();
    // lobby_intel_mv.id is uuid-only; a non-uuid confirmed mapping must not 500.
    if (!this.ports.isUuid(raw)) return null;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        trajectory: string | null;
        growth_rate: number | null;
        total_spending: number | null;
      }>
    >`
      SELECT id, name, trajectory, growth_rate, total_spending
      FROM lobby_intel_mv WHERE id = ${raw}::uuid
    `;
    if (!rows.length) return null;

    const match = rows[0]!;
    return {
      matched: true,
      trajectory: match.trajectory,
      growthRate: match.growth_rate,
      totalSpending: match.total_spending,
    };
  }

  async fuzzyMatchContractor(clientName: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        total_contracts: number | null;
        rank_by_contracts: number | null;
        no_bid_total: number | null;
        yearly_spend_jsonb: object[];
        top_agencies_jsonb: object[];
        similarity: number;
      }>
    >`
      SELECT id, name, total_contracts, rank_by_contracts, no_bid_total,
             COALESCE(yearly_spend_jsonb, '[]')::jsonb as yearly_spend_jsonb,
             COALESCE(top_agencies_jsonb, '[]')::jsonb as top_agencies_jsonb,
             similarity(name, ${clientName}) as similarity
      FROM federal_contractor
      WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC
      LIMIT 1
    `;
    if (!rows.length) return null;

    const match = rows[0]!;
    return {
      matched: true,
      contractorName: match.name,
      totalContracts: decToNumber(match.total_contracts),
      rankByContracts: match.rank_by_contracts,
      noBidTotal: decToNumber(match.no_bid_total),
      topAgencies: match.top_agencies_jsonb as { name: string; amount: number }[],
      yearlySpend: match.yearly_spend_jsonb as { year: number; amount: number }[],
    };
  }

  async fuzzyMatchLobbyIntel(clientName: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        trajectory: string | null;
        growth_rate: number | null;
        total_spending: number | null;
        similarity: number;
      }>
    >`
      SELECT id, name, trajectory, growth_rate, total_spending,
             similarity(name, ${clientName}) as similarity
      FROM lobby_intel_mv
      WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC
      LIMIT 1
    `;
    if (!rows.length) return null;

    const match = rows[0]!;
    return {
      matched: true,
      trajectory: match.trajectory,
      growthRate: match.growth_rate,
      totalSpending: match.total_spending,
    };
  }
}
