import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  FundingExecutionFact,
  FundingExecutionReadRepository,
  FundingExecutionRepositoryPage,
  FundingExecutionRepositoryQuery,
} from '../program-element/funding-execution/funding-execution-read.service.js';
import type {
  CertifiedFundingExecutionPublication,
  FundingExecutionCheckpoint,
  FundingExecutionPublicationPort,
  FundingExecutionWorkerPage,
} from './funding-execution-worker.types.js';

export type FundingAmountBasis = 'snapshot' | 'period_delta' | 'transaction_delta';
export type FundingMeasureStatus = 'draft' | 'introduced' | 'enacted' | 'active' | 'superseded' | 'withdrawn' | 'expired';
export type FundingExecutionMetric = 'obligations' | 'outlays';

export interface FundingSourceEventInput {
  sourceEventKey: string;
  sourceSystem: string;
  sourceRecordId: string;
  sourceDocumentId: string;
  eventType: string;
  measureId?: string | null;
  occurredAt?: string | null;
  sourceObservedAt?: string | null;
  sourceUrl?: string | null;
  sourceVersion?: string | null;
  amountBasis?: FundingAmountBasis | null;
  executionMetric?: FundingExecutionMetric | null;
  asOfDate?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  sourceAmountUsd?: string | null;
  signedObligationDelta?: string | null;
  signedOutlayDelta?: string | null;
  correctionOfEventKey?: string | null;
  transferPairKey?: string | null;
  transferSide?: 'out' | 'in' | null;
  raw?: Record<string, unknown>;
}

export interface FundingResidualInput {
  scopeKey: string;
  scope: Record<string, unknown>;
  basis: FundingAmountBasis;
  residualAmountUsd: string;
  reason: string;
  coverageState: 'complete' | 'partial' | 'unknown' | 'unavailable' | 'unsupported';
  freshness?: Record<string, unknown>;
  evidenceSourceDocumentId?: string | null;
  evidenceSha256?: string | null;
}

export interface PublishFundingCertificationInput {
  certificationKey: string;
  revision: number;
  measureId: string;
  sourceEvents: readonly FundingSourceEventInput[];
  allocationIds: readonly string[];
  residuals: readonly FundingResidualInput[];
  scope: Record<string, unknown>;
  certifiedBy?: string | null;
  sourceEventWatermark?: string | null;
}

export interface FundingPublicationRead {
  certification: {
    id: string;
    certificationKey: string;
    revision: number;
    measureId: string;
    measureStatus: FundingMeasureStatus;
    certifiedAt: string;
    contentSha256: string;
  };
  allocations: readonly Record<string, unknown>[];
  residuals: readonly {
    scopeKey: string;
    scope: Record<string, unknown>;
    basis: FundingAmountBasis;
    residualAmountUsd: string;
    reason: string;
    coverageState: string;
    freshness: Record<string, unknown>;
  }[];
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object' && !(value instanceof Date) && !Prisma.Decimal.isDecimal(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalized(item)]),
    );
  }
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function nonEmpty(value: string, name: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function date(value: string | null | undefined, field: string): Date | null {
  if (value == null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed;
}

function decimal(value: string | null | undefined, field: string): Prisma.Decimal | null {
  if (value == null) return null;
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) throw new Error(`${field} must be a signed USD decimal with at most two places`);
  return new Prisma.Decimal(value);
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return normalized(value ?? {}) as Prisma.InputJsonValue;
}

interface AppendedEvent {
  id: string;
  sourceEventKey: string;
  contentSha256: string;
  recordedAt: Date;
  inserted: boolean;
}

/**
 * Narrow write/read boundary for certified funding execution. Source-event,
 * certification, publication and residual records are append-only. Legacy
 * allocations without P6 source-event semantics remain readable, but cannot
 * enter a new certified publication until their basis/evidence is explicit.
 */
@Injectable()
export class FundingExecutionStore implements FundingExecutionReadRepository, FundingExecutionPublicationPort {
  constructor(private readonly prisma: PrismaService) {}

  async appendSourceEvent(input: FundingSourceEventInput): Promise<{ id: string; inserted: boolean }> {
    const [result] = await this.appendSourceEvents([input]);
    return result!;
  }

  async appendSourceEvents(inputs: readonly FundingSourceEventInput[]): Promise<Array<{ id: string; inserted: boolean }>> {
    for (const input of inputs) this.validateSourceEventInput(input);
    this.assertSourceEventTransferPairs(inputs);
    return this.prisma.$transaction(async (tx) => {
      const results: Array<{ id: string; inserted: boolean }> = [];
      for (const input of inputs) {
        const result = await this.appendSourceEventTx(tx, input);
        results.push({ id: result.id, inserted: result.inserted });
      }
      return results;
    });
  }

  async certifyAndPublish(input: PublishFundingCertificationInput): Promise<{ id: string; inserted: boolean; allocationCount: number; residualCount: number }> {
    nonEmpty(input.certificationKey, 'certificationKey');
    if (!Number.isInteger(input.revision) || input.revision < 1) throw new Error('revision must be a positive integer');
    if (new Set(input.allocationIds).size !== input.allocationIds.length) throw new Error('allocationIds must be unique');
    this.assertSourceEventTransferPairs(input.sourceEvents);

    return this.prisma.$transaction(async (tx) => {
      const measure = await tx.federalFundingMeasure.findUnique({
        where: { id: input.measureId },
        select: { id: true, status: true, fiscalYear: true },
      });
      if (!measure) throw new Error('funding measure not found');

      const events: AppendedEvent[] = [];
      for (const event of input.sourceEvents) {
        if (event.measureId && event.measureId !== input.measureId) throw new Error('source event measureId does not match certification measure');
        events.push(await this.appendSourceEventTx(tx, { ...event, measureId: input.measureId }));
      }

      const allocationRows = await tx.federalFundingAllocation.findMany({
        where: { id: { in: [...input.allocationIds] } },
        include: { provision: { include: { measure: { select: {
          id: true, status: true, fiscalYear: true, availabilityStart: true, availabilityEnd: true,
        } } } }, sourceEvent: true },
      });
      if (allocationRows.length !== input.allocationIds.length) throw new Error('one or more allocations were not found');
      for (const allocation of allocationRows) {
        if (allocation.provision.measure.id !== input.measureId) throw new Error('allocation belongs to a different funding measure');
        this.assertPublishableAllocation(allocation);
        this.assertAllocationEventSemantics(allocation, input.measureId);
      }
      this.assertTransferPairs(allocationRows);

      const allocationSnapshots = allocationRows
        .map((row) => this.publicationSnapshot(row, measure.status))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const residualSnapshots = input.residuals.map((residual) => this.validateResidual(residual));
      const contentSha256 = sha256({
        measureId: input.measureId,
        measureStatus: measure.status,
        eventHashes: events.map(({ sourceEventKey, contentSha256 }) => ({ sourceEventKey, contentSha256 })).sort((a, b) => a.sourceEventKey.localeCompare(b.sourceEventKey) || a.contentSha256.localeCompare(b.contentSha256)),
        allocations: allocationSnapshots,
        residuals: residualSnapshots,
        scope: input.scope,
      });

      const existing = await tx.federalFundingCertification.findUnique({
        where: { certificationKey_revision: { certificationKey: input.certificationKey, revision: input.revision } },
        select: { id: true, contentSha256: true },
      });
      if (existing) {
        if (existing.contentSha256 !== contentSha256) throw new Error('certification revision is immutable and already has different content');
        return { id: existing.id, inserted: false, allocationCount: allocationSnapshots.length, residualCount: residualSnapshots.length };
      }

      const certification = await tx.federalFundingCertification.create({
        data: {
          certificationKey: input.certificationKey,
          revision: input.revision,
          measureId: input.measureId,
          measureStatus: measure.status,
          sourceEventWatermark: date(input.sourceEventWatermark, 'sourceEventWatermark') ?? events.reduce<Date | null>((max, event) => !max || event.recordedAt > max ? event.recordedAt : max, null),
          sourceEventCount: events.length,
          scope: asJson(input.scope),
          status: 'certified',
          certifiedBy: input.certifiedBy ?? null,
          contentSha256,
        },
        select: { id: true },
      });

      for (const snapshot of allocationSnapshots) {
        await tx.federalFundingPublication.create({
          data: {
            certificationId: certification.id,
            allocationId: String(snapshot.id),
            allocationSnapshot: asJson(snapshot),
            contentSha256: sha256(snapshot),
          },
        });
      }
      for (const residual of residualSnapshots) {
        await tx.federalFundingReconciliationResidual.create({
          data: {
            certificationId: certification.id,
            scopeKey: residual.scopeKey,
            scope: asJson(residual.scope),
            basis: residual.basis,
            residualAmountUsd: decimal(residual.residualAmountUsd, 'residualAmountUsd')!,
            reason: residual.reason,
            coverageState: residual.coverageState,
            freshness: asJson(residual.freshness),
            evidenceSourceDocumentId: residual.evidenceSourceDocumentId,
            evidenceSha256: residual.evidenceSha256,
            contentSha256: sha256(residual),
          },
        });
      }
      return { id: certification.id, inserted: true, allocationCount: allocationSnapshots.length, residualCount: residualSnapshots.length };
    });
  }

  async readPublication(certificationKey: string, revision: number): Promise<FundingPublicationRead | null> {
    const record = await this.prisma.federalFundingCertification.findUnique({
      where: { certificationKey_revision: { certificationKey, revision } },
      include: { measure: { select: { status: true } }, publications: true, residuals: true },
    });
    if (!record) return null;
    return {
      certification: {
        id: record.id,
        certificationKey: record.certificationKey,
        revision: record.revision,
        measureId: record.measureId,
        measureStatus: record.measureStatus as FundingMeasureStatus,
        certifiedAt: record.certifiedAt.toISOString(),
        contentSha256: record.contentSha256,
      },
      allocations: record.publications.map((row) => row.allocationSnapshot as Record<string, unknown>),
      residuals: record.residuals.map((row) => ({
        scopeKey: row.scopeKey,
        scope: row.scope as Record<string, unknown>,
        basis: row.basis as FundingAmountBasis,
        residualAmountUsd: row.residualAmountUsd.toString(),
        reason: row.reason,
        coverageState: row.coverageState,
        freshness: row.freshness as Record<string, unknown>,
      })),
    };
  }

  /** Reads only immutable, certified allocation snapshots and scoped residuals. */
  async readPage(query: FundingExecutionRepositoryQuery): Promise<FundingExecutionRepositoryPage> {
    const targetType = query.subject.type === 'pe' ? 'program_element' : 'federal_program';
    const records = await this.prisma.$queryRaw<Array<{
      stable_key: string;
      fact_id: string;
      snapshot: Record<string, unknown>;
      measure_status: string;
      certified_at: Date;
      source_system: string | null;
      source_record_id: string | null;
      source_url: string | null;
      source_version: string | null;
      source_observed_at: Date | null;
      source_hash: string | null;
      source_raw: unknown;
      account_id: string | null;
    }>>(Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON (p.allocation_id)
          p.id, p.allocation_id, p.allocation_snapshot_jsonb AS snapshot,
          c.certified_at, c.certification_key, c.revision, c.measure_status,
          e.source_system, e.source_record_id, e.source_url, e.source_version,
          e.source_observed_at, e.content_sha256 AS source_hash, e.raw_jsonb AS source_raw,
          p.allocation_snapshot_jsonb->>'accountId' AS account_id,
          CASE WHEN p.allocation_snapshot_jsonb->>'transferPairKey' IS NOT NULL
            THEN 'transfer:' || (p.allocation_snapshot_jsonb->>'transferPairKey') || ':' ||
                 CASE p.allocation_snapshot_jsonb->>'transferSide' WHEN 'out' THEN '0' ELSE '1' END || ':' || p.allocation_id::text
            ELSE 'fact:' || c.certification_key || ':' || c.revision::text || ':' || p.allocation_id::text
          END AS stable_key
        FROM federal_funding_publication p
        JOIN federal_funding_certification c ON c.id = p.certification_id
        JOIN federal_funding_measure m ON m.id = c.measure_id
        JOIN federal_funding_allocation a ON a.id = p.allocation_id
        JOIN federal_funding_provision pr ON pr.id = a.provision_id
        LEFT JOIN federal_funding_source_event e ON e.id = a.source_event_id
        WHERE c.status = 'certified' AND c.certified_at <= ${query.knownAt}
          AND p.published_at <= ${query.knownAt}
          AND (p.allocation_snapshot_jsonb->>'fiscalYear')::integer = ${query.asOfFy}
          AND (
            (p.allocation_snapshot_jsonb->>'targetType' = ${targetType}
             AND (p.allocation_snapshot_jsonb->>'targetNativeKey' = ${query.subject.id}
                  OR p.allocation_snapshot_jsonb->>'targetId' = ${query.subject.id}))
            OR (p.allocation_snapshot_jsonb->>'transferPairKey' IS NOT NULL AND EXISTS (
              SELECT 1 FROM federal_funding_publication tp
              JOIN federal_funding_certification tc ON tc.id = tp.certification_id
              WHERE tc.status = 'certified' AND tc.certified_at <= ${query.knownAt}
                AND tp.published_at <= ${query.knownAt}
                AND tp.allocation_snapshot_jsonb->>'transferPairKey' = p.allocation_snapshot_jsonb->>'transferPairKey'
                AND tp.allocation_snapshot_jsonb->>'fiscalYear' = p.allocation_snapshot_jsonb->>'fiscalYear'
                AND tp.allocation_snapshot_jsonb->>'targetType' = ${targetType}
                AND (tp.allocation_snapshot_jsonb->>'targetNativeKey' = ${query.subject.id}
                     OR tp.allocation_snapshot_jsonb->>'targetId' = ${query.subject.id})
            ))
          )
        ORDER BY p.allocation_id, c.certified_at DESC, p.published_at DESC
      )
      SELECT stable_key, allocation_id::text AS fact_id, snapshot, measure_status, certified_at,
             source_system, source_record_id, source_url, source_version, source_observed_at,
             source_hash, source_raw, account_id
      FROM latest
      WHERE stable_key > ${query.afterStableKey ?? ''}
        AND NOT EXISTS (
          SELECT 1 FROM federal_funding_allocation newer
          JOIN federal_funding_publication np ON np.allocation_id = newer.id
          JOIN federal_funding_certification nc ON nc.id = np.certification_id
          WHERE newer.correction_of_allocation_id = latest.allocation_id
            AND nc.certified_at <= ${query.knownAt}
            AND np.published_at <= ${query.knownAt}
        )
      ORDER BY stable_key
      LIMIT ${query.take}
    `);

    const residualRows = await this.prisma.$queryRaw<Array<{
      scope_key: string;
      scope_jsonb: Record<string, unknown>;
      basis: string;
      residual_amount_usd: Prisma.Decimal;
      reason: string;
      coverage_state: string;
      freshness_jsonb: Record<string, unknown>;
      created_at: Date;
      measure_status: string;
      fiscal_year: number | null;
      evidence_source_document_id: string | null;
      evidence_sha256: string | null;
    }>>(Prisma.sql`
      SELECT DISTINCT ON (r.scope_key) r.scope_key, r.scope_jsonb, r.basis,
        r.residual_amount_usd, r.reason, r.coverage_state, r.freshness_jsonb,
        r.created_at, c.measure_status,
        (r.scope_jsonb->>'fiscalYear')::integer AS fiscal_year,
        r.evidence_source_document_id, r.evidence_sha256
      FROM federal_funding_reconciliation_residual r
      JOIN federal_funding_certification c ON c.id = r.certification_id
      WHERE c.status = 'certified' AND c.certified_at <= ${query.knownAt}
        AND r.created_at <= ${query.knownAt}
        AND ('residual:' || r.scope_key) > ${query.afterStableKey ?? ''}
        AND r.scope_jsonb->>'subjectType' = ${query.subject.type}
        AND r.scope_jsonb->>'subjectId' = ${query.subject.id}
        AND (r.scope_jsonb->>'fiscalYear')::integer = ${query.asOfFy}
      ORDER BY r.scope_key, r.created_at DESC
      LIMIT ${query.take}
    `);

    const facts: FundingExecutionFact[] = records.map((row) => this.toReadFact(row));
    const residualFacts: FundingExecutionFact[] = residualRows.map((row) => ({
      stableKey: `residual:${row.scope_key}`,
      factId: `residual:${row.scope_key}`,
      authorityState: this.authorityState(row.measure_status),
      measure: 'residual',
      fiscalYear: row.fiscal_year ?? query.asOfFy,
      validFromFy: null,
      validToFy: null,
      availabilityStart: null,
      availabilityEnd: null,
      recordedAt: row.created_at.toISOString(),
      accountId: null,
      snapshotGroupId: null,
      amountUsd: row.residual_amount_usd.toString(),
      transferGroupId: null,
      transferLeg: null,
      allocationCertification: 'certified',
      reviewState: 'unreviewed',
      exactAccountLevel: false,
      evidence: row.evidence_source_document_id && row.evidence_sha256 ? [{
        sourceFamily: 'federal_funding_residual', sourceNativeId: row.evidence_source_document_id,
        sourceUrl: null, sourceVersion: null, contentHash: row.evidence_sha256, quote: null,
      }] : [],
      unresolvedReasons: [row.reason, `coverage_${row.coverage_state}`],
      authoritativeAmountUsd: null,
    }));
    const unresolvedReasons = residualFacts.length
      ? [{ code: 'explicit_reconciliation_residual', count: residualFacts.length, detail: 'Residuals are exposed separately and are not allocations.' }]
      : facts.length === 0
        ? [{ code: 'no_certified_funding_publication', count: null, detail: 'No certified source-qualified funding rows exist for this scope.' }]
        : [];
    const sourceFreshness = [...new Map(records.map((row) => [row.source_system ?? 'unknown', {
      source: row.source_system ?? 'unknown',
      sourceAsOf: row.source_observed_at?.toISOString() ?? null,
      state: row.source_observed_at ? 'current' as const : 'unknown' as const,
    }])).values()];
    return {
      rows: [...facts, ...residualFacts].sort((a, b) => a.stableKey.localeCompare(b.stableKey)).slice(0, query.take),
      coverage: {
        state: unresolvedReasons.length ? 'partial' : 'complete',
        unresolvedReasons,
        sourceFreshness,
      },
    };
  }

  async loadCheckpoint(): Promise<FundingExecutionCheckpoint | null> {
    const row = await this.prisma.federalFundingPublicationCheckpoint.findUnique({ where: { checkpointKey: 'funding-execution' } });
    if (!row) return null;
    return { version: 1, cursor: row.cursor, throughId: row.throughId, complete: row.complete };
  }

  async readBoundedPage(input: { cursor: string | null; throughId: string | null; take: number }): Promise<FundingExecutionWorkerPage> {
    // Freeze the high-water mark while holding a SHARE lock. Package 6 also
    // changes new allocation timestamps to clock_timestamp(), so a writer that
    // was open before this transaction either commits before the watermark is
    // captured or receives a strictly later timestamp after the lock releases.
    const throughId = input.throughId ?? await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`LOCK TABLE federal_funding_allocation IN SHARE MODE`);
      return (await tx.$queryRaw<Array<{ watermark: string }>>(Prisma.sql`
        SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || id::text AS watermark
        FROM federal_funding_allocation WHERE source_event_id IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT 1
      `))[0]?.watermark ?? null;
    });
    if (!throughId) return { rows: [], throughId: null, hasMore: false, nextCursor: null };
    const through = this.parseAllocationWatermark(throughId);
    const after = input.cursor ? this.parseAllocationWatermark(input.cursor) : null;
    const limit = Math.max(1, input.take - 1);
    const boundedRows = await this.prisma.$queryRaw<Array<{ id: string; watermark: string }>>(Prisma.sql`
      SELECT id::text, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || id::text AS watermark
      FROM federal_funding_allocation
      WHERE source_event_id IS NOT NULL
        AND (created_at, id) <= (${through.createdAt}::timestamptz, ${through.id}::uuid)
        ${after ? Prisma.sql`AND (created_at, id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)` : Prisma.empty}
      ORDER BY created_at ASC, id ASC LIMIT ${limit + 1}
    `);
    const hasMore = boundedRows.length > limit;
    const bounded = boundedRows.slice(0, limit);
    const rows = bounded.length ? await this.prisma.federalFundingAllocation.findMany({
      where: { id: { in: bounded.map((row) => row.id) } },
      include: { sourceEvent: true, provision: { include: { measure: true } } },
    }) : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const orderedRows = bounded.flatMap(({ id }) => { const row = byId.get(id); return row ? [row] : []; });
    return {
      rows: orderedRows.flatMap((allocation) => {
        if (!allocation.sourceEvent || allocation.provision.measure.fiscalYear == null) return [];
        return [this.toAllocationFact(allocation)];
      }),
      throughId,
      hasMore,
      nextCursor: hasMore && bounded.length ? bounded[bounded.length - 1]!.watermark : null,
    };
  }

  private parseAllocationWatermark(value: string): { createdAt: string; id: string } {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f-]{36})$/i.exec(value);
    if (!match || !Number.isFinite(new Date(match[1]!).getTime())) throw new Error('funding execution checkpoint watermark is malformed');
    return { createdAt: match[1]!, id: match[2]! };
  }

  async publishCertified(rows: readonly CertifiedFundingExecutionPublication[]): Promise<{ published: number }> {
    if (rows.length === 0) return { published: 0 };
    return this.prisma.$transaction(async (tx) => {
      let published = 0;
      for (const candidate of rows) {
        const allocation = await tx.federalFundingAllocation.findUnique({
          where: { id: candidate.factId },
          include: { sourceEvent: true, provision: { include: { measure: true } } },
        });
        if (!allocation || !allocation.sourceEvent || allocation.provision.measure.status !== 'enacted') throw new Error('certified publication source is not an enacted source-event allocation');
        this.assertPublishableAllocation(allocation);
        this.assertAllocationEventSemantics(allocation, allocation.provision.measure.id);
        if (allocation.targetType !== 'appropriation_account' || allocation.mappingMaturity !== 'account_level' || allocation.targetNativeKey !== candidate.accountId || !allocation.authoritativeAmountUsd?.eq(candidate.amountUsd) || allocation.authoritativeAmountUsd?.isNegative()) throw new Error('worker publication does not match the verified account-level allocation');
        if (!candidate.sourceNativeIds.includes(allocation.sourceEvent.sourceRecordId)) throw new Error('worker publication source identity does not match source evidence');

        const certificationKey = `worker:${candidate.factId}`;
        const content = this.publicationSnapshot(allocation, allocation.provision.measure.status);
        const contentSha256 = sha256(content);
        const existing = await tx.federalFundingCertification.findUnique({
          where: { certificationKey_revision: { certificationKey, revision: 1 } }, select: { id: true, contentSha256: true },
        });
        if (existing) {
          if (existing.contentSha256 !== contentSha256) throw new Error('worker certification identity already contains different content');
          continue;
        }
        const certification = await tx.federalFundingCertification.create({ data: {
          certificationKey, revision: 1, measureId: allocation.provision.measure.id,
          measureStatus: allocation.provision.measure.status,
          sourceEventWatermark: allocation.sourceEvent.recordedAt, sourceEventCount: 1,
          scope: asJson({ fiscalYear: allocation.provision.measure.fiscalYear, accountId: candidate.accountId }),
          status: 'certified', certifiedBy: 'funding-execution-worker', contentSha256,
        }, select: { id: true } });
        await tx.federalFundingPublication.create({ data: {
          certificationId: certification.id, allocationId: allocation.id,
          allocationSnapshot: asJson(content), contentSha256,
        } });
        published += 1;
      }
      return { published };
    });
  }

  async saveCheckpoint(checkpoint: FundingExecutionCheckpoint): Promise<void> {
    await this.prisma.federalFundingPublicationCheckpoint.upsert({
      where: { checkpointKey: 'funding-execution' },
      create: { checkpointKey: 'funding-execution', version: checkpoint.version, cursor: checkpoint.cursor, throughId: checkpoint.throughId, complete: checkpoint.complete },
      update: { version: checkpoint.version, cursor: checkpoint.cursor, throughId: checkpoint.throughId, complete: checkpoint.complete },
    });
  }

  private toReadFact(row: {
    stable_key: string; fact_id: string; snapshot: Record<string, unknown>; measure_status: string;
    certified_at: Date; source_system: string | null; source_record_id: string | null;
    source_url: string | null; source_version: string | null; source_observed_at: Date | null;
    source_hash: string | null; source_raw: unknown; account_id: string | null;
  }): FundingExecutionFact {
    const snapshot = row.snapshot;
    const basis = snapshot.amountBasis;
    const transferSide = snapshot.transferSide;
    const exactAccountLevel = snapshot.targetType === 'appropriation_account' && snapshot.mappingMaturity === 'account_level' && snapshot.reviewState === 'verified' && snapshot.inferredRelevance === false;
    const quote = row.source_raw && typeof row.source_raw === 'object' ? (row.source_raw as Record<string, unknown>).quote : null;
    return {
      stableKey: row.stable_key,
      factId: row.fact_id,
      authorityState: this.authorityState(row.measure_status),
      measure: snapshot.transferPairKey ? 'transfer_leg' : basis === 'snapshot' ? 'cumulative_snapshot' : basis === 'transaction_delta' || basis === 'period_delta' ? 'transaction_delta' : 'allocation',
      fiscalYear: Number(snapshot.fiscalYear),
      validFromFy: typeof snapshot.availabilityStart === 'string' ? Number(snapshot.availabilityStart.slice(0, 4)) : null,
      validToFy: typeof snapshot.availabilityEnd === 'string' ? Number(snapshot.availabilityEnd.slice(0, 4)) : null,
      availabilityStart: typeof snapshot.availabilityStart === 'string' ? snapshot.availabilityStart : null,
      availabilityEnd: typeof snapshot.availabilityEnd === 'string' ? snapshot.availabilityEnd : null,
      recordedAt: row.certified_at.toISOString(),
      accountId: row.account_id,
      snapshotGroupId: typeof snapshot.snapshotGroupId === 'string' ? snapshot.snapshotGroupId : null,
      amountUsd: typeof snapshot.authoritativeAmountUsd === 'string' ? snapshot.authoritativeAmountUsd : null,
      transferGroupId: typeof snapshot.transferPairKey === 'string' ? snapshot.transferPairKey : null,
      transferLeg: transferSide === 'out' ? 'outflow' : transferSide === 'in' ? 'inflow' : null,
      allocationCertification: 'certified',
      reviewState: snapshot.reviewState === 'verified' ? 'verified' : 'unreviewed',
      exactAccountLevel,
      evidence: [{
        sourceFamily: row.source_system ?? 'unknown',
        sourceNativeId: row.source_record_id,
        sourceUrl: row.source_url,
        sourceVersion: row.source_version,
        contentHash: row.source_hash ?? (typeof snapshot.evidenceSha256 === 'string' ? snapshot.evidenceSha256 : null),
        quote: typeof quote === 'string' ? quote : null,
      }],
      unresolvedReasons: snapshot.potentialDoubleCount === true ? ['potential_double_count'] : [],
      authoritativeAmountUsd: exactAccountLevel && snapshot.potentialDoubleCount !== true && typeof snapshot.authoritativeAmountUsd === 'string' ? snapshot.authoritativeAmountUsd : null,
    };
  }

  private toAllocationFact(allocation: any): FundingExecutionFact {
    const event = allocation.sourceEvent;
    const measure = allocation.provision.measure;
    const exactAccountLevel = allocation.targetType === 'appropriation_account' && allocation.mappingMaturity === 'account_level' && allocation.reviewState === 'verified' && !allocation.inferredRelevance;
    return {
      stableKey: `${event.id}:${allocation.id}`,
      factId: allocation.id,
      authorityState: this.authorityState(measure.status),
      measure: allocation.transferPairKey ? 'transfer_leg' : allocation.amountBasis === 'snapshot' ? 'cumulative_snapshot' : allocation.amountBasis === 'transaction_delta' || allocation.amountBasis === 'period_delta' ? 'transaction_delta' : 'allocation',
      fiscalYear: measure.fiscalYear,
      validFromFy: (allocation.provision.availabilityStart ?? measure.availabilityStart)?.getUTCFullYear() ?? null,
      validToFy: (allocation.provision.availabilityEnd ?? measure.availabilityEnd)?.getUTCFullYear() ?? null,
      availabilityStart: (allocation.provision.availabilityStart ?? measure.availabilityStart)?.toISOString().slice(0, 10) ?? null,
      availabilityEnd: (allocation.provision.availabilityEnd ?? measure.availabilityEnd)?.toISOString().slice(0, 10) ?? null,
      recordedAt: event.recordedAt.toISOString(),
      accountId: allocation.targetType === 'appropriation_account' ? allocation.targetNativeKey : allocation.provision.tas,
      snapshotGroupId: allocation.amountBasis === 'snapshot' ? event.sourceEventKey : null,
      amountUsd: allocation.authoritativeAmountUsd?.toString() ?? null,
      transferGroupId: allocation.transferPairKey,
      transferLeg: allocation.transferSide === 'out' ? 'outflow' : allocation.transferSide === 'in' ? 'inflow' : null,
      allocationCertification: this.isWorkerCertifiable(allocation) ? 'certified' : 'candidate',
      reviewState: allocation.reviewState === 'verified' ? 'verified' : allocation.reviewState === 'rejected' ? 'rejected' : 'candidate',
      exactAccountLevel,
      evidence: [{
        sourceFamily: event.sourceSystem,
        sourceNativeId: event.sourceRecordId,
        sourceUrl: event.sourceUrl,
        sourceVersion: event.sourceVersion,
        contentHash: event.contentSha256,
        quote: typeof event.raw?.quote === 'string' ? event.raw.quote : null,
      }],
      unresolvedReasons: [],
      authoritativeAmountUsd: null,
    };
  }

  private authorityState(status: string): 'enacted' | 'proposed' {
    return status === 'enacted' || status === 'active' ? 'enacted' : 'proposed';
  }

  private isWorkerCertifiable(allocation: any): boolean {
    const amount = allocation.authoritativeAmountUsd?.toString();
    try {
      this.assertAllocationEventSemantics(allocation, allocation.provision.measure.id);
    } catch {
      return false;
    }
    return allocation.provision.measure.status === 'enacted' &&
      allocation.targetType === 'appropriation_account' && allocation.mappingMaturity === 'account_level' &&
      allocation.reviewState === 'verified' && allocation.inferredRelevance === false &&
      allocation.potentialDoubleCount === false && allocation.sourceEventId != null &&
      allocation.amountBasis !== 'legacy_unspecified' && allocation.evidenceSourceDocumentId != null &&
      /^[0-9a-f]{64}$/i.test(allocation.evidenceSha256) && amount != null &&
      /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount);
  }

  private assertAllocationEventSemantics(allocation: any, measureId: string): void {
    const event = allocation.sourceEvent;
    if (!event || event.measureId !== measureId) throw new Error(`allocation ${allocation.id} source event belongs to a different measure`);
    if (event.amountBasis !== allocation.amountBasis || event.executionMetric !== allocation.executionMetric) throw new Error(`allocation ${allocation.id} amount basis or metric differs from its source event`);
    const sameDate = (a: Date | null, b: Date | null) => (a?.toISOString().slice(0, 10) ?? null) === (b?.toISOString().slice(0, 10) ?? null);
    if (!sameDate(event.asOfDate, allocation.asOfDate) || !sameDate(event.periodStart, allocation.periodStart) || !sameDate(event.periodEnd, allocation.periodEnd)) {
      throw new Error(`allocation ${allocation.id} time basis differs from its source event`);
    }
    if (event.transferPairKey !== allocation.transferPairKey || event.transferSide !== allocation.transferSide) throw new Error(`allocation ${allocation.id} transfer identity differs from its source event`);
    if (allocation.correctionOfAllocationId && !event.correctionOfEventId) throw new Error(`allocation ${allocation.id} correction lacks a source-event correction reference`);
    if (allocation.authoritativeAmountUsd === null) throw new Error(`allocation ${allocation.id} has no source-supported amount`);

    let sourceAmount: Prisma.Decimal | null = null;
    if (allocation.amountBasis === 'snapshot' || event.executionMetric == null) sourceAmount = event.sourceAmountUsd;
    else if (allocation.executionMetric === 'obligations') sourceAmount = event.signedObligationDelta;
    else if (allocation.executionMetric === 'outlays') sourceAmount = event.signedOutlayDelta;
    if (!sourceAmount || !sourceAmount.eq(allocation.authoritativeAmountUsd)) {
      throw new Error(`allocation ${allocation.id} amount does not match its immutable source-event amount`);
    }
  }

  private async appendSourceEventTx(tx: Prisma.TransactionClient, input: FundingSourceEventInput): Promise<AppendedEvent> {
    nonEmpty(input.sourceEventKey, 'sourceEventKey');
    nonEmpty(input.sourceSystem, 'sourceSystem');
    nonEmpty(input.sourceRecordId, 'sourceRecordId');
    nonEmpty(input.eventType, 'eventType');
    const semantic = {
      ...input,
      raw: normalized(input.raw ?? {}),
      signedObligationDelta: input.signedObligationDelta ?? null,
      signedOutlayDelta: input.signedOutlayDelta ?? null,
    };
    const contentSha256 = sha256(semantic);
    const existing = await tx.federalFundingSourceEvent.findUnique({
      where: { sourceEventKey_contentSha256: { sourceEventKey: input.sourceEventKey, contentSha256 } },
      select: { id: true, recordedAt: true },
    });
    if (existing) return { id: existing.id, sourceEventKey: input.sourceEventKey, contentSha256, recordedAt: existing.recordedAt, inserted: false };

    let correctionOfEventId: string | null = null;
    if (input.correctionOfEventKey) {
      const corrected = await tx.federalFundingSourceEvent.findFirst({
        where: { sourceEventKey: input.correctionOfEventKey },
        orderBy: { revision: 'desc' },
        select: { id: true },
      });
      if (!corrected) throw new Error('correction target source event was not found');
      correctionOfEventId = corrected.id;
    }
    const latest = await tx.federalFundingSourceEvent.findFirst({
      where: { sourceEventKey: input.sourceEventKey },
      orderBy: { revision: 'desc' },
      select: { revision: true },
    });
    const revision = (latest?.revision ?? 0) + 1;
    const created = await tx.federalFundingSourceEvent.create({
      data: {
        sourceEventKey: input.sourceEventKey,
        sourceSystem: input.sourceSystem,
        sourceRecordId: input.sourceRecordId,
        revision,
        eventType: input.eventType,
        measureId: input.measureId ?? null,
        sourceDocumentId: input.sourceDocumentId,
      occurredAt: date(input.occurredAt, 'occurredAt'),
      sourceObservedAt: date(input.sourceObservedAt, 'sourceObservedAt'),
      sourceUrl: input.sourceUrl ?? null,
      sourceVersion: input.sourceVersion ?? null,
        amountBasis: input.amountBasis ?? null,
        executionMetric: input.executionMetric ?? null,
        asOfDate: date(input.asOfDate, 'asOfDate'),
      periodStart: date(input.periodStart, 'periodStart'),
      periodEnd: date(input.periodEnd, 'periodEnd'),
      sourceAmountUsd: decimal(input.sourceAmountUsd, 'sourceAmountUsd'),
      signedObligationDelta: decimal(input.signedObligationDelta, 'signedObligationDelta'),
        signedOutlayDelta: decimal(input.signedOutlayDelta, 'signedOutlayDelta'),
        correctionOfEventId,
        transferPairKey: input.transferPairKey ?? null,
        transferSide: input.transferSide ?? null,
        contentSha256,
        raw: asJson(input.raw),
      },
      select: { id: true, recordedAt: true },
    });
    return { id: created.id, sourceEventKey: input.sourceEventKey, contentSha256, recordedAt: created.recordedAt, inserted: true };
  }

  private assertPublishableAllocation(allocation: {
    id: string;
    reviewState: string;
    mappingMaturity: string;
    targetType: string;
    targetNativeKey: string | null;
    targetId: string | null;
    authoritativeAmountUsd: Prisma.Decimal | null;
    inferredRelevance: boolean;
    evidenceSourceDocumentId: string;
    evidenceSha256: string;
    allocationStage: string;
    obligationReference: string | null;
    sourceEventId: string | null;
    amountBasis: string;
    asOfDate: Date | null;
    periodStart: Date | null;
    periodEnd: Date | null;
  }): void {
    if (allocation.reviewState !== 'verified') throw new Error(`allocation ${allocation.id} must be verified before certification`);
    if (!allocation.evidenceSourceDocumentId || !/^[0-9a-f]{64}$/i.test(allocation.evidenceSha256)) throw new Error(`allocation ${allocation.id} is missing evidence`);
    if (!allocation.sourceEventId || allocation.amountBasis === 'legacy_unspecified') throw new Error(`allocation ${allocation.id} lacks P6 source-event amount semantics`);
    if (allocation.amountBasis === 'snapshot' && (!allocation.asOfDate || allocation.periodStart || allocation.periodEnd)) throw new Error(`allocation ${allocation.id} has invalid snapshot basis`);
    if (allocation.amountBasis === 'period_delta' && (!allocation.periodStart || !allocation.periodEnd || allocation.periodEnd < allocation.periodStart)) throw new Error(`allocation ${allocation.id} has invalid period-delta basis`);
    if (allocation.amountBasis === 'transaction_delta' && (!allocation.asOfDate || allocation.periodStart || allocation.periodEnd)) throw new Error(`allocation ${allocation.id} has invalid transaction basis`);
    if (allocation.allocationStage === 'obligated' && !allocation.obligationReference) throw new Error(`allocation ${allocation.id} requires an obligation reference`);
    if (allocation.authoritativeAmountUsd !== null) {
      if (!['exact_identifier', 'exact_line_item', 'account_level'].includes(allocation.mappingMaturity) || allocation.targetType === 'capability' || allocation.inferredRelevance || (!allocation.targetNativeKey && !allocation.targetId)) {
        throw new Error(`allocation ${allocation.id} has unsafe authoritative dollars`);
      }
    }
  }

  private assertTransferPairs(allocations: readonly {
    transferPairKey: string | null;
    transferSide: string | null;
    authoritativeAmountUsd: Prisma.Decimal | null;
    sourceEventId: string | null;
  }[]): void {
    const groups = new Map<string, typeof allocations[number][]>();
    for (const allocation of allocations) {
      if (!allocation.transferPairKey) continue;
      const rows = groups.get(allocation.transferPairKey) ?? [];
      rows.push(allocation);
      groups.set(allocation.transferPairKey, rows);
    }
    for (const [key, rows] of groups) {
      const out = rows.filter((row) => row.transferSide === 'out');
      const incoming = rows.filter((row) => row.transferSide === 'in');
      if (rows.length !== 2 || out.length !== 1 || incoming.length !== 1 || !out[0]!.sourceEventId || !incoming[0]!.sourceEventId || !out[0]!.authoritativeAmountUsd || !incoming[0]!.authoritativeAmountUsd || !out[0]!.authoritativeAmountUsd.isNegative() || !incoming[0]!.authoritativeAmountUsd.isPositive() || !out[0]!.authoritativeAmountUsd.abs().eq(incoming[0]!.authoritativeAmountUsd)) {
        throw new Error(`transfer pair ${key} must contain equal signed out/in legs`);
      }
    }
  }

  private assertSourceEventTransferPairs(events: readonly FundingSourceEventInput[]): void {
    const groups = new Map<string, FundingSourceEventInput[]>();
    for (const event of events) {
      if (!event.transferPairKey) continue;
      const group = groups.get(event.transferPairKey) ?? [];
      group.push(event);
      groups.set(event.transferPairKey, group);
    }
    for (const [key, legs] of groups) {
      const out = legs.filter((leg) => leg.transferSide === 'out');
      const incoming = legs.filter((leg) => leg.transferSide === 'in');
      const authorityBalanced = out[0]?.executionMetric == null && incoming[0]?.executionMetric == null &&
        out[0]?.sourceAmountUsd != null && incoming[0]?.sourceAmountUsd != null &&
        new Prisma.Decimal(out[0].sourceAmountUsd).plus(incoming[0].sourceAmountUsd).isZero() &&
        new Prisma.Decimal(out[0].sourceAmountUsd).isNegative() && new Prisma.Decimal(incoming[0].sourceAmountUsd).isPositive();
      const obligationBalanced = out[0]?.executionMetric === 'obligations' && incoming[0]?.executionMetric === 'obligations' && out[0]?.signedObligationDelta != null && incoming[0]?.signedObligationDelta != null &&
        new Prisma.Decimal(out[0].signedObligationDelta).plus(incoming[0].signedObligationDelta).isZero() &&
        new Prisma.Decimal(out[0].signedObligationDelta).isNegative() && new Prisma.Decimal(incoming[0].signedObligationDelta).isPositive();
      const outlayBalanced = out[0]?.executionMetric === 'outlays' && incoming[0]?.executionMetric === 'outlays' && out[0]?.signedOutlayDelta != null && incoming[0]?.signedOutlayDelta != null &&
        new Prisma.Decimal(out[0].signedOutlayDelta).plus(incoming[0].signedOutlayDelta).isZero() &&
        new Prisma.Decimal(out[0].signedOutlayDelta).isNegative() && new Prisma.Decimal(incoming[0].signedOutlayDelta).isPositive();
      if (legs.length !== 2 || out.length !== 1 || incoming.length !== 1 || out[0]!.amountBasis !== 'transaction_delta' || incoming[0]!.amountBasis !== 'transaction_delta' || out[0]!.executionMetric !== incoming[0]!.executionMetric || !(authorityBalanced || obligationBalanced || outlayBalanced)) {
        throw new Error(`source transfer pair ${key} must contain equal signed out/in legs`);
      }
    }
  }

  private validateSourceEventInput(input: FundingSourceEventInput): void {
    const obligation = input.signedObligationDelta != null;
    const outlay = input.signedOutlayDelta != null;
    if (input.amountBasis === 'snapshot') {
      if (input.sourceAmountUsd == null || obligation || outlay) throw new Error('snapshot source events require sourceAmountUsd and cannot carry delta columns');
      if (!input.asOfDate || input.periodStart || input.periodEnd) throw new Error('snapshot source events require asOfDate only');
    } else if (input.amountBasis === 'period_delta' || input.amountBasis === 'transaction_delta') {
      if (input.executionMetric) {
        if (obligation === outlay || (input.executionMetric === 'obligations') !== obligation || input.sourceAmountUsd != null) throw new Error('execution deltas require exactly one matching signed metric delta and no authority amount');
      } else if (obligation || outlay || input.sourceAmountUsd == null) {
        throw new Error('metricless authority deltas require sourceAmountUsd and cannot carry execution metric deltas');
      }
      if (input.amountBasis === 'period_delta' && (!input.periodStart || !input.periodEnd || date(input.periodEnd, 'periodEnd')! < date(input.periodStart, 'periodStart')!)) throw new Error('period deltas require an ordered periodStart/periodEnd');
      if (input.amountBasis === 'transaction_delta' && (!input.asOfDate || input.periodStart || input.periodEnd)) throw new Error('transaction deltas require asOfDate and no period range');
    }
    if (input.executionMetric && !input.asOfDate && input.amountBasis === 'snapshot') throw new Error('execution snapshots require asOfDate');
    if (/rescission/i.test(input.eventType) && (
      input.amountBasis !== 'transaction_delta' || input.sourceAmountUsd == null || !new Prisma.Decimal(input.sourceAmountUsd).isNegative()
    )) {
      throw new Error('rescission source events require a transaction_delta with explicit negative sourceAmountUsd');
    }
    decimal(input.sourceAmountUsd, 'sourceAmountUsd');
    decimal(input.signedObligationDelta, 'signedObligationDelta');
    decimal(input.signedOutlayDelta, 'signedOutlayDelta');
  }

  private publicationSnapshot(allocation: Record<string, any>, measureStatus: string): Record<string, unknown> {
    const sourceEvent = allocation.sourceEvent;
    return {
      id: allocation.id,
      provisionId: allocation.provisionId,
      measureId: allocation.provision.measure.id,
      measureStatus,
      fiscalYear: allocation.provision.measure.fiscalYear,
      availabilityStart: (allocation.provision.availabilityStart ?? allocation.provision.measure.availabilityStart)?.toISOString().slice(0, 10) ?? null,
      availabilityEnd: (allocation.provision.availabilityEnd ?? allocation.provision.measure.availabilityEnd)?.toISOString().slice(0, 10) ?? null,
      accountId: allocation.targetType === 'appropriation_account' ? allocation.targetNativeKey : allocation.provision.tas,
      sourceSystem: sourceEvent?.sourceSystem ?? null,
      sourceRecordId: sourceEvent?.sourceRecordId ?? null,
      sourceUrl: sourceEvent?.sourceUrl ?? null,
      sourceVersion: sourceEvent?.sourceVersion ?? null,
      sourceContentSha256: sourceEvent?.contentSha256 ?? null,
      sourceObservedAt: sourceEvent?.sourceObservedAt?.toISOString() ?? null,
      snapshotGroupId: allocation.amountBasis === 'snapshot' ? sourceEvent?.sourceEventKey ?? null : null,
      targetType: allocation.targetType,
      targetNativeKey: allocation.targetNativeKey,
      targetId: allocation.targetId,
      allocationStage: allocation.allocationStage,
      mappingMaturity: allocation.mappingMaturity,
      reviewState: allocation.reviewState,
      authoritativeAmountUsd: allocation.authoritativeAmountUsd?.toString() ?? null,
      inferredRelevance: allocation.inferredRelevance,
      baseRequestStatus: allocation.baseRequestStatus,
      potentialDoubleCount: allocation.potentialDoubleCount,
      fundingPosture: allocation.fundingPosture,
      evidenceSourceDocumentId: allocation.evidenceSourceDocumentId,
      evidencePage: allocation.evidencePage,
      evidenceSha256: allocation.evidenceSha256,
      obligationReference: allocation.obligationReference,
      executionReference: allocation.executionReference,
      sourceEventId: allocation.sourceEventId,
      amountBasis: allocation.amountBasis,
      asOfDate: allocation.asOfDate?.toISOString().slice(0, 10) ?? null,
      periodStart: allocation.periodStart?.toISOString().slice(0, 10) ?? null,
      periodEnd: allocation.periodEnd?.toISOString().slice(0, 10) ?? null,
      executionMetric: allocation.executionMetric,
      correctionOfAllocationId: allocation.correctionOfAllocationId,
      transferPairKey: allocation.transferPairKey,
      transferSide: allocation.transferSide,
      dedupKey: allocation.dedupKey,
    };
  }

  private validateResidual(input: FundingResidualInput): FundingResidualInput {
    nonEmpty(input.scopeKey, 'residual scopeKey');
    nonEmpty(input.reason, 'residual reason');
    decimal(input.residualAmountUsd, 'residualAmountUsd');
    if (Boolean(input.evidenceSourceDocumentId) !== Boolean(input.evidenceSha256)) throw new Error('residual evidence document and hash must be supplied together');
    if (input.evidenceSha256 && !/^[0-9a-f]{64}$/i.test(input.evidenceSha256)) throw new Error('residual evidenceSha256 must be a SHA-256 hash');
    return {
      ...input,
      evidenceSourceDocumentId: input.evidenceSourceDocumentId ?? null,
      evidenceSha256: input.evidenceSha256 ?? null,
      freshness: normalized(input.freshness ?? {}) as Record<string, unknown>,
    };
  }
}
