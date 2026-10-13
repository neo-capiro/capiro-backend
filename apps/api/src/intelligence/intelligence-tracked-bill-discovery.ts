import type { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '@prisma/client';
import { EMBEDDING_MODEL, embedText, normalize, vectorLiteral } from '../embeddings/embedder.js';
import { buildKeywordMatchTerms, matchingBillIdsSql } from './bill-keyword-match.helpers.js';
import { withBillKeywordSqlDeadline } from './bill-keyword-deadline.js';
import {
  projectBillDetail,
  type BillDetailRow,
  type ManualMergeInput,
  type TrackedBillMatch,
  type TrackedBillsResult,
  type TrackedBillPorts,
} from './intelligence-bill-discovery.shared.js';

export class IntelligenceTrackedBillDiscovery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: TrackedBillPorts,
  ) {}

  async getTrackedBills(clientId: string, tenantId?: string): Promise<TrackedBillsResult> {
    // Union across ALL confirmed LDA registrants, not just one. A large client
    // (e.g. RTX) files its lobbying under several registrant-name variants —
    // "RTX CORPORATION", "RTX CORPORATION AND AFFILIATES", "RAYTHEON TECHNOLOGIES
    // CORPORATION", various FKA forms — and each is a distinct lda_client. Picking
    // a single one left big clients matching on a thin slice of their footprint.
    // Manually pinned bills (explicit human picks) — always included regardless
    // of embedding similarity, and flagged so the UI can mark them. Tenant-scoped.
    const manualBillIds = tenantId
      ? await this.ports.getManualTrackedBillIds(clientId, tenantId)
      : [];
    const manualSet = new Set(manualBillIds);

    // Relevance term sets (issue codes + acronym-expanded capability keywords +
    // semantic prose), extracted into getClientRelevanceTerms so the Tracker
    // Recommendations matcher feeds the embeddings/keyword matchers IDENTICAL
    // inputs without re-deriving (or drifting from) this logic.
    const { issueCodes, keywordTermsExpanded, embeddingPartsClean, hasCapabilitySignal } = tenantId
      ? await this.ports.getClientRelevanceTerms(clientId, tenantId)
      : {
          issueCodes: [] as string[],
          keywordTermsExpanded: [] as string[],
          embeddingPartsClean: [] as string[],
          hasCapabilitySignal: false,
        };

    // Merge auto-matched bills with manually pinned ones. Manual picks are
    // ALWAYS included (even with no terms / no embedding match) and flagged
    // isManual so the UI can mark + pin them. Auto matches that are also
    // manually tracked get isManual:true too.
    const mergeManual = async (auto: ManualMergeInput) => {
      const flagged = auto.bills.map((b) => ({ ...b, isManual: manualSet.has(b.identifier) }));
      const presentIds = new Set(flagged.map((b) => b.identifier));
      const missingManual = manualBillIds.filter((id) => !presentIds.has(id));
      const manualBills = missingManual.length
        ? await this.ports.fetchBillsByIds(missingManual)
        : [];
      const merged = [...manualBills.map((b) => ({ ...b, isManual: true })), ...flagged];
      // total counts the distinct universe of tracked bills (auto + manual).
      return { total: merged.length, issueCodes, bills: merged };
    };

    if (!keywordTermsExpanded.length && !embeddingPartsClean.length) {
      // No relevance signal, but manual picks may still exist — surface them.
      return mergeManual({ total: 0, bills: [] });
    }

    // Thin-signal guard: a client with no capabilities matches on broad LDA
    // issue-code names alone, which produces semantic false positives at the
    // default floor. Require a tighter similarity for those clients.
    const embedded = await this.ports.findTrackedBillsByEmbeddings(
      embeddingPartsClean,
      this.ports.embeddingSimilarityFloor(hasCapabilitySignal),
    );
    if (embedded) {
      return mergeManual(embedded);
    }

    const keyword = await this.ports.findTrackedBillsByKeyword(keywordTermsExpanded);
    return mergeManual(keyword);
  }

  async findTrackedBillsByEmbeddings(
    allTerms: string[],
    similarityFloor: number,
  ): Promise<TrackedBillMatch | null> {
    const query = normalize(allTerms.join('. '));
    if (query.length < 10) return null;

    try {
      const vector = await embedText(query);
      const vecLiteral = vectorLiteral(vector);
      // Relevance floor: cosine similarity (1 - distance) must clear this to count
      // as a tracked bill. Without it the vector search returns its top-N nearest
      // regardless of how weakly related, inflating the "tracked" count with noise.
      // The floor is supplied by the caller (see embeddingSimilarityFloor): the
      // default keeps genuinely on-topic bills while dropping tangential matches,
      // and a tighter floor is used for thin-signal (no-capability) clients.
      const SIMILARITY_FLOOR = similarityFloor;
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
          LIMIT 200`,
        vecLiteral,
        EMBEDDING_MODEL,
        SIMILARITY_FLOOR,
      );

      const rankedIds = Array.from(
        new Set(
          candidateRows
            .filter((r) => typeof r.source_id === 'string' && r.source_id.trim().length > 0)
            .map((r) => r.source_id.trim()),
        ),
      );
      if (!rankedIds.length) return null;

      const bills = await this.prisma.$queryRaw<BillDetailRow[]>`
        SELECT cb.id, cb.title, cb.latest_action_date, cb.latest_action_text, cb.status,
               ARRAY(SELECT a.text FROM congress_bill_action a WHERE a.bill_id = cb.id) AS action_texts,
               cb.sponsor_name, cb.sponsor_party, cb.subjects
        FROM congress_bill cb
        WHERE cb.id = ANY(${rankedIds}::text[])
        ORDER BY cb.latest_action_date DESC NULLS LAST
        LIMIT 50
      `;
      if (!bills.length) return null;

      return {
        total: rankedIds.length,
        bills: bills.map(projectBillDetail),
      };
    } catch (error) {
      this.ports.warn(
        `Tracked-bills embeddings lookup failed, falling back to keyword matcher: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async findTrackedBillsByKeyword(allTerms: string[]): Promise<TrackedBillMatch> {
    // Index-backed via matchingBillIdsSql (UNION of per-table trigram branches);
    // see bill-keyword-match.helpers.ts. Identical result set to the prior
    // cross-table-OR query, ~350x faster.
    const { lowerTerms, wordPatterns } = buildKeywordMatchTerms(allTerms);
    const matchingIds = matchingBillIdsSql(lowerTerms, wordPatterns);

    return withBillKeywordSqlDeadline(this.prisma, async (query) => {
      const countRows = await query<Array<{ total: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS total FROM ${matchingIds} AS m
    `);

      const bills = await query<BillDetailRow[]>(Prisma.sql`
      SELECT cb.id, cb.title, cb.latest_action_date, cb.latest_action_text, cb.status,
             ARRAY(SELECT a.text FROM congress_bill_action a WHERE a.bill_id = cb.id) AS action_texts,
             cb.sponsor_name, cb.sponsor_party, cb.subjects
      FROM congress_bill cb
      WHERE cb.id IN (SELECT id FROM ${matchingIds} AS m)
      ORDER BY cb.latest_action_date DESC NULLS LAST, cb.id
      LIMIT 50
    `);

      return {
        total: Number(countRows[0]?.total ?? 0),
        bills: bills.map(projectBillDetail),
      };
    });
  }
}
