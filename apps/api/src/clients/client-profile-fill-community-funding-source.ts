import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { PublicAdvocacyDiscoveryPorts } from './client-profile-fill-advocacy-discovery.shared.js';

// Bounded page for the CPF/CDS canonical-request KEYSET SCAN. Distinct from
// MAX_ADVOCACY_FINDINGS (which caps FINDINGS emitted). community_funding_request
// is global and can hold thousands of rows per FY; the scan must be a real
// bounded, resumable page that advances even when a page yields zero matches.
export const COMMUNITY_FUNDING_SCAN_BATCH_SIZE = 500;

export interface FundingRow {
  id: string;
  chamber: string;
  requestType: string;
  fiscalYear: number;
  requesterName: string;
  recipientName: string;
  recipientNormalized: string;
  state: string | null;
  city: string | null;
  projectTitle: string;
  projectDescription: string | null;
  requestedAmountUsd: string;
  finalAmountUsd: string | null;
  amountStageRaw: string;
  appropriationsAccountRaw: string | null;
  subcommittee: string | null;
  createdAt: Date;
  recipientSimilarity: number;
  provenanceCount: number;
  provenanceDocs: Array<{
    sourceDocumentId: string;
    sourcePage: number | null;
    sourceRow: number;
    sourceUrl: string | null;
    title: string | null;
  }> | null;
}

/** Canonical CPF/CDS reads, tenant geography and best-effort provenance/coverage. */
export class ClientProfileFillCommunityFundingSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reporter: Pick<PublicAdvocacyDiscoveryPorts, 'warn' | 'safeError'>,
  ) {}

  async loadClientStates(ctx: TenantContext, clientId: string): Promise<Set<string>> {
    // Facility states for geography corroboration of fuzzy matches.
    let clientStates = new Set<string>();
    try {
      const facilities = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clientFacility.findMany({
          where: { clientId },
          select: { state: true },
        }),
      );
      clientStates = new Set(
        facilities.map((f) => (f.state ?? '').trim().toUpperCase()).filter((s) => s.length === 2),
      );
    } catch (error) {
      this.reporter.warn(
        `Community funding facility geography unavailable: ${this.reporter.safeError(error)}`,
      );
    }

    return clientStates;
  }

  async loadProvenance(requestIds: string[]) {
    if (!requestIds.length) return new Map<string, FundingRow['provenanceDocs']>();
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        Array<{
          requestId: string;
          sourceDocumentId: string;
          sourcePage: number | null;
          sourceRow: number;
          sourceUrl: string | null;
          title: string | null;
        }>
      >(
        `SELECT s.request_id AS "requestId",
                  s.source_document_id AS "sourceDocumentId",
                  s.source_page AS "sourcePage",
                  s.source_row AS "sourceRow",
                  sd.source_url AS "sourceUrl",
                  sd.title AS title
             FROM community_funding_request_source s
             LEFT JOIN source_document sd ON sd.id = s.source_document_id
            WHERE s.request_id = ANY($1::uuid[])
            ORDER BY s.request_id, s.source_page NULLS FIRST, s.source_row`,
        requestIds,
      );
      const map = new Map<string, NonNullable<FundingRow['provenanceDocs']>>();
      for (const r of rows) {
        const list = map.get(r.requestId) ?? [];
        list.push({
          sourceDocumentId: r.sourceDocumentId,
          sourcePage: r.sourcePage,
          sourceRow: r.sourceRow,
          sourceUrl: r.sourceUrl,
          title: r.title,
        });
        map.set(r.requestId, list);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  loadConfirmed(confirmedRequestIds: Set<string>): Promise<FundingRow[]> {
    return this.prisma.$queryRawUnsafe<FundingRow[]>(
      `SELECT r.id, r.chamber, r.request_type AS "requestType", r.fiscal_year AS "fiscalYear",
                  r.requester_name AS "requesterName", r.recipient_name AS "recipientName",
                  r.recipient_normalized AS "recipientNormalized", r.state, r.city,
                  r.project_title AS "projectTitle", r.project_description AS "projectDescription",
                  r.requested_amount_usd::text AS "requestedAmountUsd",
                  r.final_amount_usd::text AS "finalAmountUsd",
                  r.amount_stage_raw AS "amountStageRaw",
                  r.appropriations_account_raw AS "appropriationsAccountRaw",
                  r.subcommittee, r.created_at AS "createdAt",
                  1::float AS "recipientSimilarity",
                  (SELECT COUNT(*)::int FROM community_funding_request_source s WHERE s.request_id = r.id) AS "provenanceCount"
             FROM community_funding_request r
            WHERE r.id = ANY($1::uuid[])
            ORDER BY r.created_at ASC, r.id ASC
            LIMIT 200`,
      [...confirmedRequestIds],
    );
  }

  loadScan(
    clientName: string,
    checkpointAt: string | null,
    checkpointKey: string | null,
  ): Promise<FundingRow[]> {
    return this.prisma.$queryRawUnsafe<FundingRow[]>(
      `SELECT r.id, r.chamber, r.request_type AS "requestType", r.fiscal_year AS "fiscalYear",
                r.requester_name AS "requesterName", r.recipient_name AS "recipientName",
                r.recipient_normalized AS "recipientNormalized", r.state, r.city,
                r.project_title AS "projectTitle", r.project_description AS "projectDescription",
                r.requested_amount_usd::text AS "requestedAmountUsd",
                r.final_amount_usd::text AS "finalAmountUsd",
                r.amount_stage_raw AS "amountStageRaw",
                r.appropriations_account_raw AS "appropriationsAccountRaw",
                r.subcommittee, r.created_at AS "createdAt",
                GREATEST(
                  similarity(r.recipient_normalized, $1),
                  word_similarity($1, r.recipient_normalized),
                  similarity(r.recipient_name, $1),
                  word_similarity($1, r.recipient_name)
                )::float AS "recipientSimilarity",
                (SELECT COUNT(*)::int FROM community_funding_request_source s WHERE s.request_id = r.id) AS "provenanceCount"
           FROM community_funding_request r
          WHERE (($2::timestamptz IS NULL)
             OR (r.created_at > $2::timestamptz)
             OR (r.created_at = $2::timestamptz AND r.id > $3::uuid))
          ORDER BY r.created_at ASC, r.id ASC
          LIMIT $4`,
      clientName,
      checkpointAt,
      checkpointKey || '00000000-0000-0000-0000-000000000000',
      COMMUNITY_FUNDING_SCAN_BATCH_SIZE,
    );
  }

  async loadCoverage(priorLimitation: string | null): Promise<string | null> {
    // Coverage honesty: surface FY/chamber counts when available.
    let limitation = priorLimitation;
    try {
      const coverage = await this.prisma.$queryRawUnsafe<
        Array<{ chamber: string; fiscalYear: number; n: number }>
      >(
        `SELECT chamber, fiscal_year AS "fiscalYear", COUNT(*)::int AS n
           FROM community_funding_request
          GROUP BY chamber, fiscal_year
          ORDER BY fiscal_year DESC, chamber
          LIMIT 20`,
      );
      if (coverage.length) {
        const bits = coverage.map((c) => `${c.chamber} FY${c.fiscalYear}:${c.n}`);
        limitation = `Canonical coverage present for ${bits.join(', ')}. Match is recipient-primary; requester is never treated as the client.`;
      } else {
        limitation =
          'Canonical community_funding_request table is empty — run CPF/CDS ingestion before expecting matches.';
      }
    } catch {
      // leave prior limitation
    }

    return limitation;
  }
}
