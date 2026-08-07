import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { assertRequestSourceRecordId } from '../funding-opportunity-identity.js';
import {
  describeTextAvailability,
  type TextStatus,
} from '../opportunity-document-text.service.js';
import type { RequirementReviewStatus } from './opportunity-requirement.schema.js';

/**
 * Reading a solicitation's extracted requirements (Funding Opportunities P31).
 *
 * ── Read-only, and every row carries its citation ────────────────────────────
 *
 * There is no shape in this file that returns a statement without its excerpt,
 * its span and the document it came from. A compliance list nobody can check
 * against the source invites a team to build a proposal against Capiro's
 * paraphrase, which is the specific harm this phase's evidence binding exists
 * to prevent.
 *
 * ── Four kinds of empty, and only one is about the solicitation ──────────────
 *
 *   `no_documents`      nothing archived. Capiro has read nothing.
 *   `no_text`           documents archived but unread. P30's own per-document
 *                       status is carried through VERBATIM rather than
 *                       re-summarised, because "the account's plan excludes
 *                       extracted text" and "this file is a scan with no text
 *                       layer" are different facts and only P30 knows which.
 *   `read_none_found`   documents read, no requirement of a kind Capiro
 *                       extracts was found. The ONLY one that is a fact about
 *                       the solicitation — and even it says "of a kind Capiro
 *                       extracts", not "none".
 *   `available`         requirements found.
 *
 * ── The review is the TENANT's, the requirement is not ───────────────────────
 *
 * `opportunity_requirement` is global (a fact about a public document);
 * `opportunity_requirement_review` is tenant-scoped with FORCED RLS. So the
 * requirement read runs under `withSystem` and the review read under
 * `withTenant`, and a requirement with no review for THIS tenant reads as
 * `pending` — never as another tenant's decision.
 */

export interface RequirementView {
  id: string;
  requirementType: string;
  statement: string;
  sourceExcerpt: string;
  excerptStart: number;
  excerptEnd: number;
  sourcePage: number | null;
  fileName: string | null;
  extractionMethod: string;
  extractionModel: string;
  confidence: string;
  reviewStatus: RequirementReviewStatus;
  supersededAt: string | null;
}

export interface RequirementsResponse {
  source: 'sam_gov';
  sourceRecordId: string;
  requirements: RequirementView[];
  coverage: 'available' | 'no_documents' | 'no_text' | 'read_none_found';
  coverageExplanation: string;
  documentTextStatus: Array<{ fileName: string | null; status: string; explanation: string }>;
  generatedAt: string;
}

export interface RequirementPort {
  /** Requirements bound to any CURRENTLY-archived document of this solicitation. */
  readRequirements(samOpportunityId: string): Promise<
    Array<{
      id: string;
      requirementType: string;
      statement: string;
      sourceExcerpt: string;
      excerptStart: number;
      excerptEnd: number;
      sourcePage: number | null;
      fileName: string | null;
      extractionMethod: string;
      extractionModel: string;
      confidence: string;
      supersededAt: Date | null;
    }>
  >;
  /** THIS tenant's review status per requirement id. */
  readReviews(tenantId: string, requirementIds: string[]): Promise<Map<string, RequirementReviewStatus>>;
  /** How many documents are archived for this solicitation. */
  countArchivedDocuments(samOpportunityId: string): Promise<number>;
  /** P30's per-document text status. */
  readTextStatus(
    samOpportunityId: string,
  ): Promise<Array<{ fileName: string | null; status: TextStatus }>>;
}

@Injectable()
export class OpportunityRequirementService {
  private port: RequirementPort;

  constructor(private readonly prisma: PrismaService) {
    this.port = this.buildPort();
  }

  /** Replace the reader wholesale. Test seam only. */
  withPort(port: RequirementPort): this {
    (this as unknown as { port: RequirementPort }).port = port;
    return this;
  }

  async getRequirements(
    tenantId: string,
    source: string,
    sourceRecordId: string,
    asOf: Date = new Date(),
  ): Promise<RequirementsResponse> {
    if (source !== 'sam_gov') {
      // Grants.gov publishes its terms in the notice body, not as separate
      // attachments Capiro archives. Refusing beats an empty list that reads as
      // "this grant has no requirements".
      throw new BadRequestException(
        'Requirement extraction runs on SAM.gov solicitation documents. Grants.gov states its terms in the notice itself.',
      );
    }
    assertRequestSourceRecordId(source, sourceRecordId);

    const rows = await this.port.readRequirements(sourceRecordId);
    const reviews = await this.port.readReviews(
      tenantId,
      rows.map((r) => r.id),
    );

    const requirements: RequirementView[] = rows.map((row) => ({
      id: row.id,
      requirementType: row.requirementType,
      statement: row.statement,
      sourceExcerpt: row.sourceExcerpt,
      excerptStart: row.excerptStart,
      excerptEnd: row.excerptEnd,
      sourcePage: row.sourcePage,
      fileName: row.fileName,
      extractionMethod: row.extractionMethod,
      extractionModel: row.extractionModel,
      confidence: row.confidence,
      // A requirement with no review FOR THIS TENANT is pending. It is never
      // another tenant's decision, and RLS makes that structural rather than a
      // filter this code has to remember.
      reviewStatus: reviews.get(row.id) ?? 'pending',
      supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
    }));

    const textStatus = await this.port.readTextStatus(sourceRecordId);
    const documentTextStatus = textStatus.map((d) => ({
      fileName: d.fileName,
      status: d.status,
      // P30's own sentence, carried through verbatim. Re-summarising it here
      // would be a second place that has to know a billing gap from a scan.
      explanation: describeTextAvailability({ status: d.status }),
    }));

    if (requirements.length > 0) {
      return {
        source: 'sam_gov',
        sourceRecordId,
        requirements,
        coverage: 'available',
        coverageExplanation: `${requirements.length} requirement${requirements.length === 1 ? '' : 's'} extracted, each quoting the document it came from.`,
        documentTextStatus,
        generatedAt: asOf.toISOString(),
      };
    }

    const archived = await this.port.countArchivedDocuments(sourceRecordId);
    const readable = textStatus.filter((d) => d.status === 'available').length;

    const [coverage, explanation]: [RequirementsResponse['coverage'], string] =
      archived === 0
        ? [
            'no_documents',
            'No documents have been archived for this solicitation, so nothing has been read. This is not a statement that it has no requirements.',
          ]
        : readable === 0
          ? [
              'no_text',
              'Documents are archived but their text is not available, so nothing has been read. The per-document reason is listed below.',
            ]
          : [
              'read_none_found',
              'The documents were read and no requirement of a kind Capiro extracts was found. Requirements stated in a form Capiro does not yet recognise would not appear here.',
            ];

    return {
      source: 'sam_gov',
      sourceRecordId,
      requirements: [],
      coverage,
      coverageExplanation: explanation,
      documentTextStatus,
      generatedAt: asOf.toISOString(),
    };
  }

  private buildPort(): RequirementPort {
    return {
      // tenant-scope-exempt: opportunity_requirement, opportunity_attachment and
      // opportunity_document_text are GLOBAL provider/source tables with no
      // tenant_id and no RLS.
      readRequirements: async (samOpportunityId) => {
        const rows = await this.prisma.withSystem((tx) =>
          tx.$queryRaw<
            Array<{
              id: string;
              requirement_type: string;
              statement: string;
              source_excerpt: string;
              excerpt_start: number;
              excerpt_end: number;
              source_page: number | null;
              file_name: string | null;
              extraction_method: string;
              extraction_model: string;
              confidence: string;
              superseded_at: Date | null;
            }>
          >`
            SELECT r.id::text AS id, r.requirement_type, r.statement, r.source_excerpt,
                   r.excerpt_start, r.excerpt_end, r.source_page,
                   a.file_name, r.extraction_method, r.extraction_model, r.confidence,
                   r.superseded_at
            FROM opportunity_requirement r
            JOIN opportunity_attachment a ON a.id = r.attachment_id
            WHERE r.sam_opportunity_id = ${samOpportunityId}::uuid
            ORDER BY r.requirement_type ASC, r.excerpt_start ASC
            LIMIT 500
          `,
        );
        return rows.map((r) => ({
          id: r.id,
          requirementType: r.requirement_type,
          statement: r.statement,
          sourceExcerpt: r.source_excerpt,
          excerptStart: r.excerpt_start,
          excerptEnd: r.excerpt_end,
          sourcePage: r.source_page,
          fileName: r.file_name,
          extractionMethod: r.extraction_method,
          extractionModel: r.extraction_model,
          confidence: r.confidence,
          supersededAt: r.superseded_at,
        }));
      },

      // withTenant, because the review IS tenant data and RLS is FORCED on it.
      readReviews: async (tenantId, requirementIds) => {
        if (requirementIds.length === 0) return new Map();
        const rows = await this.prisma.withTenant(tenantId, (tx) =>
          tx.opportunityRequirementReview.findMany({
            where: { tenantId, requirementId: { in: requirementIds } },
            select: { requirementId: true, status: true },
          }),
        );
        return new Map(rows.map((r) => [r.requirementId, r.status as RequirementReviewStatus]));
      },

      countArchivedDocuments: (samOpportunityId) =>
        this.prisma.withSystem((tx) =>
          tx.opportunityAttachment.count({
            where: { samOpportunityId, status: 'archived' },
          }),
        ),

      readTextStatus: async (samOpportunityId) => {
        const rows = await this.prisma.withSystem((tx) =>
          tx.$queryRaw<Array<{ file_name: string | null; status: string }>>`
            SELECT a.file_name, t.status
            FROM opportunity_document_text t
            JOIN opportunity_attachment a ON a.id = t.attachment_id
            WHERE a.sam_opportunity_id = ${samOpportunityId}::uuid
              AND t.attachment_content_sha256 = a.content_sha256
            ORDER BY a.file_name NULLS LAST
            LIMIT 200
          `,
        );
        return rows.map((r) => ({ fileName: r.file_name, status: r.status as TextStatus }));
      },
    };
  }
}
