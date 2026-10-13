import type { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '@prisma/client';
import { EMBEDDING_MODEL, embedText, normalize, vectorLiteral } from '../embeddings/embedder.js';
import { expandTerms } from './term-expansion.js';
import { buildKeywordMatchTerms, matchingBillIdsSql } from './bill-keyword-match.helpers.js';
import { withBillKeywordSqlDeadline } from './bill-keyword-deadline.js';
import {
  projectRelevantBill,
  type RelevantBillRow,
  type RelevantBillsResult,
  type RelevantBillPorts,
} from './intelligence-bill-discovery.shared.js';

export class IntelligenceRelevantBillDiscovery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: RelevantBillPorts,
  ) {}

  async findRelevantBills(
    issueCodes: string[],
    fallbackTerms: string[],
  ): Promise<RelevantBillsResult> {
    // Resolve LDA issue codes -> English issue names once, then run
    // embeddings-first bill retrieval with transparent keyword fallback.
    const issueNames: string[] = [];
    if (issueCodes.length) {
      const nameRows = await this.prisma.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM lda_issue_code WHERE code = ANY(${issueCodes}::text[])
      `;
      issueNames.push(...nameRows.map((r) => r.name));
    }

    const allTerms = expandTerms([...issueNames, ...fallbackTerms])
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (!allTerms.length) return { total: 0, bills: [] };

    const embedded = await this.ports.findRelevantBillsByEmbeddings(allTerms);
    if (embedded) return embedded;

    return this.ports.findRelevantBillsByKeyword(allTerms);
  }

  async findRelevantBillsByEmbeddings(allTerms: string[]): Promise<RelevantBillsResult | null> {
    const query = normalize(allTerms.join('. '));
    if (query.length < 10) return null;

    try {
      const vector = await embedText(query);
      const vecLiteral = vectorLiteral(vector);
      // Relevance floor (cosine similarity): drop weakly-related bills so the
      // linker doesn't surface tangential matches. Mirrors the tracked-bills floor.
      const SIMILARITY_FLOOR = 0.65;
      const candidateRows = await this.prisma.$queryRawUnsafe<
        Array<{ source_id: string; score: number }>
      >(
        `SELECT ce.source_id,
                (1 - (ce.embedding <=> $1::vector))::float8 AS score
           FROM context_embeddings ce
          WHERE ce.source_type = 'bill'
            AND ce.model = $2
            AND ce.embedding IS NOT NULL
            AND (1 - (ce.embedding <=> $1::vector)) >= $3
          ORDER BY ce.embedding <=> $1::vector
          LIMIT 150`,
        vecLiteral,
        EMBEDDING_MODEL,
        SIMILARITY_FLOOR,
      );

      const candidateIds = Array.from(
        new Set(
          candidateRows
            .filter((r) => typeof r.source_id === 'string' && r.source_id.trim().length > 0)
            .map((r) => r.source_id.trim()),
        ),
      );
      if (!candidateIds.length) return null;

      const rows = await this.prisma.$queryRaw<RelevantBillRow[]>`
        SELECT cb.id, cb.congress, cb.bill_type, cb.bill_number, cb.title,
               cb.introduced_date, cb.sponsor_name, cb.sponsor_party, cb.sponsor_state,
               cb.latest_action_text, cb.latest_action_date, cb.policy_area, cb.subjects
        FROM congress_bill cb
        WHERE cb.id = ANY(${candidateIds}::text[])
        ORDER BY cb.latest_action_date DESC NULLS LAST
        LIMIT 25
      `;

      if (!rows.length) return null;

      const bills = rows.map(projectRelevantBill);

      return { total: candidateIds.length, bills };
    } catch (error) {
      this.ports.warn(
        `Issue-bill embeddings lookup failed, falling back to keyword matcher: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async findRelevantBillsByKeyword(allTerms: string[]): Promise<RelevantBillsResult> {
    // Whole-word keyword fallback (legacy source). Keeps behavior stable when
    // embeddings are unavailable or backfill has not populated bill vectors.
    // Matching is index-backed via matchingBillIdsSql (UNION of per-table trigram
    // branches); see bill-keyword-match.helpers.ts for the why + parity proof.
    const { lowerTerms, wordPatterns } = buildKeywordMatchTerms(allTerms);
    const matchingIds = matchingBillIdsSql(lowerTerms, wordPatterns);

    return withBillKeywordSqlDeadline(this.prisma, async (query) => {
      const countRows = await query<Array<{ total: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS total FROM ${matchingIds} AS m
    `);

      const rows = await query<RelevantBillRow[]>(Prisma.sql`
      SELECT cb.id, cb.congress, cb.bill_type, cb.bill_number, cb.title,
             cb.introduced_date, cb.sponsor_name, cb.sponsor_party, cb.sponsor_state,
             cb.latest_action_text, cb.latest_action_date, cb.policy_area, cb.subjects
      FROM congress_bill cb
      WHERE cb.id IN (SELECT id FROM ${matchingIds} AS m)
      ORDER BY cb.latest_action_date DESC NULLS LAST, cb.id
      LIMIT 25
    `);

      const bills = rows.map(projectRelevantBill);

      return { total: Number(countRows[0]?.total ?? 0), bills };
    });
  }

  async getClientBills(clientId: string, tenantId: string): Promise<RelevantBillsResult> {
    // Phase 4c: read issue codes across the client's FULL confirmed LDA id set
    // (one real company = a SET of lda_client ids), not a single firm relationship.
    const ldaClientIds = await this.ports.confirmedLdaIds(clientId, tenantId);
    const issueCodes = await this.ports.issueCodesForLdaIds(ldaClientIds);
    return this.ports.findRelevantBills(issueCodes);
  }
}
