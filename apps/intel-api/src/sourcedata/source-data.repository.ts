import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * SourceDataRepository — the single, audited home for READ-ONLY cross-schema
 * access to apps/api-owned GLOBAL tables (`congress_bill`, its children, and
 * `context_embeddings`). Phase 1 of the tracker→intel-api migration.
 *
 * Invariants (enforced by review — see plan §4 S8):
 *  - READ-ONLY. This class MUST NEVER `$executeRaw*` / insert / update / delete
 *    an apps/api-owned table (decision D2). intel-api owns only `intel_*` tables.
 *  - All scalar params are bound (`$1,$2,…`). The only value ever interpolated
 *    is the pgvector literal, which is self-generated floats from
 *    `vectorLiteral()` (no injection surface — same rationale as the upstream
 *    embedder).
 *  - GLOBAL / NULL-tenant reads only in Phase 1. No tenant context is set:
 *    `congress_bill*` are RLS-free globals, and `context_embeddings` bill rows
 *    are NULL-tenant (the RLS policy `tenant_id IS NULL OR tenant_id =
 *    current_tenant_id` admits them to a no-tenant session). Tenant-scoped
 *    reads (`clients`) are deferred to Phase 3 — see `getClient` below.
 *
 * The constructor takes `PrismaService` (a PrismaClient subclass), so Nest DI
 * injects it in the running app AND the one-off `task` runner can construct it
 * directly with `new SourceDataRepository(new PrismaService())`.
 */
export interface SourceBill {
  id: string;
  congress: number | null;
  billType: string | null;
  billNumber: string | null;
  title: string | null;
  latestActionText: string | null;
  latestActionDate: Date | null;
  policyArea: string | null;
  subjects: string[] | null;
  peCodes: string[] | null;
  url: string | null;
}

export interface SourceBillAction {
  id: string;
  billId: string;
  date: Date;
  text: string;
  type: string | null;
  chamber: string | null;
}

export interface SourceBillCommittee {
  committeeName: string;
  committeeCode: string | null;
  chamber: string | null;
}

export interface SemanticScore {
  sourceId: string;
  score: number;
}

@Injectable()
export class SourceDataRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** One `congress_bill` row (GLOBAL) by its string id (e.g. "119-hr-1234"), or null. */
  async getBillById(id: string): Promise<SourceBill | null> {
    const rows = await this.prisma.$queryRawUnsafe<SourceBill[]>(
      `SELECT id,
              congress,
              bill_type          AS "billType",
              bill_number        AS "billNumber",
              title,
              latest_action_text AS "latestActionText",
              latest_action_date AS "latestActionDate",
              policy_area        AS "policyArea",
              subjects,
              pe_codes           AS "peCodes",
              url
         FROM congress_bill
        WHERE id = $1
        LIMIT 1`,
      id,
    );
    return rows[0] ?? null;
  }

  /** All actions for a bill, newest-first (uses index [bill_id, date]). */
  async getBillActions(billId: string): Promise<SourceBillAction[]> {
    return this.prisma.$queryRawUnsafe<SourceBillAction[]>(
      `SELECT id,
              bill_id AS "billId",
              date,
              text,
              type,
              chamber
         FROM congress_bill_action
        WHERE bill_id = $1
        ORDER BY date DESC`,
      billId,
    );
  }

  /** Subject tags for a bill. */
  async getBillSubjects(billId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM congress_bill_subject WHERE bill_id = $1`,
      billId,
    );
    return rows.map((r) => r.name);
  }

  /** Committee assignments for a bill. */
  async getBillCommittees(billId: string): Promise<SourceBillCommittee[]> {
    return this.prisma.$queryRawUnsafe<SourceBillCommittee[]>(
      `SELECT committee_name AS "committeeName",
              committee_code AS "committeeCode",
              chamber
         FROM congress_bill_committee
        WHERE bill_id = $1`,
      billId,
    );
  }

  /**
   * Cosine-rank the GLOBAL bill embeddings against a query vector.
   *
   * `queryVectorLiteral` MUST be the output of `vectorLiteral(await embedText(q))`
   * (a `[v0,…,v1023]` string). It is bound as `$1` and cast to `::vector`; no
   * value is string-interpolated. Ported verbatim from the live tracker's
   * `semanticScores` (apps/api tracker.service.ts) — bills are stored under
   * `source_type = 'bill'`.
   */
  async semanticBillScores(
    queryVectorLiteral: string,
    model: string,
    floor: number,
  ): Promise<SemanticScore[]> {
    const rows = await this.prisma.$queryRawUnsafe<SemanticScore[]>(
      `SELECT ce.source_id AS "sourceId",
              (1 - (ce.embedding <=> $1::vector))::float8 AS score
         FROM context_embeddings ce
        WHERE ce.source_type = 'bill' AND ce.model = $2
          AND ce.embedding IS NOT NULL
          AND (1 - (ce.embedding <=> $1::vector)) >= $3
        ORDER BY ce.embedding <=> $1::vector
        LIMIT 400`,
      queryVectorLiteral,
      model,
      floor,
    );
    return rows;
  }

  /** Batch-read GLOBAL `congress_bill` rows by id (for the shadow change detector). */
  async getBillsByIds(ids: string[]): Promise<SourceBill[]> {
    if (!ids.length) return [];
    return this.prisma.$queryRawUnsafe<SourceBill[]>(
      `SELECT id,
              congress,
              bill_type          AS "billType",
              bill_number        AS "billNumber",
              title,
              latest_action_text AS "latestActionText",
              latest_action_date AS "latestActionDate",
              policy_area        AS "policyArea",
              subjects,
              pe_codes           AS "peCodes",
              url
         FROM congress_bill
        WHERE id = ANY($1::text[])`,
      ids,
    );
  }

  /** Batch-read GLOBAL `congress_bill_action` rows for many bills, oldest-first (catch-up). */
  async getBillActionsByIds(ids: string[]): Promise<SourceBillAction[]> {
    if (!ids.length) return [];
    return this.prisma.$queryRawUnsafe<SourceBillAction[]>(
      `SELECT id,
              bill_id AS "billId",
              date,
              text,
              type,
              chamber
         FROM congress_bill_action
        WHERE bill_id = ANY($1::text[])
        ORDER BY date ASC`,
      ids,
    );
  }

  // getClient(clientId): NOT IMPLEMENTED in Phase 1.
  //
  // `clients` is TENANT-SCOPED (Postgres RLS). The `withTenant`/`withSystem`
  // helpers are ported in Phase 1 (PrismaService) but stay inert here: without
  // a resolved tenant context, RLS returns zero rows under the capiro_app role.
  // Shipping a live method that silently returns [] would be a footgun.
  //
  // TODO(Phase 3): implement as
  //   return this.prisma.withTenant(tenantId, (tx) =>
  //     tx.$queryRawUnsafe(`SELECT id, lda_client_ids AS "ldaClientIds",
  //       issue_codes AS "issueCodes" FROM clients WHERE id = $1`, clientId));
}
