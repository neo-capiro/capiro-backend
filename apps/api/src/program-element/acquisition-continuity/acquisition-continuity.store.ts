import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  buildAcquisitionIdentity,
  buildAcquisitionRelationship,
} from './acquisition-identity.js';
import type {
  AcquisitionIdentityInput,
  AcquisitionRelationshipClass,
  AcquisitionRelationshipInput,
  AcquisitionRecordKind,
  CoverageState,
} from './acquisition-continuity.types.js';
import type {
  AcquisitionContinuityCoverage,
  AcquisitionContinuityEvidence,
  AcquisitionContinuityReadRepository,
  AcquisitionContinuityRelationshipRow,
  AcquisitionContinuityRepositoryPage,
  AcquisitionContinuityRepositoryQuery,
  AcquisitionContinuityRelationshipStatus,
  AcquisitionFinancialClass,
} from './acquisition-continuity-read.service.js';

type JsonObject = Record<string, unknown>;

export interface AcquisitionRecordInput extends AcquisitionIdentityInput {
  sourceRecordId: string;
  title?: string | null;
  status?: string | null;
  buyerOffice?: string | null;
  postedAt?: string | null;
  responseDeadline?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  sourceUrl?: string | null;
  sourceVersion?: string | null;
  sourceObservedAt?: string | null;
  recordedAt?: string | null;
  raw?: JsonObject;
}

export interface AcquisitionTransactionInput {
  source: string;
  sourceTransactionId: string;
  awardIdentityKey: string;
  parentAwardIdentityKey?: string | null;
  piid?: string | null;
  modificationNumber?: string | null;
  actionDate?: string | null;
  signedObligationDelta?: string | null;
  signedOutlayDelta?: string | null;
  correctsIdentityKey?: string | null;
  sourceUrl?: string | null;
  sourceObservedAt?: string | null;
  recordedAt?: string | null;
  raw?: JsonObject;
}

export interface ProgramAcquisitionRelationshipInput {
  subjectKind: 'program' | 'pe' | 'pe_project' | 'procurement_line';
  subjectKey: string;
  acquisitionIdentityKey: string;
  relationshipClass: AcquisitionRelationshipClass;
  sourceSystem: string;
  sourceRecordId: string;
  validFromFy?: number | null;
  validToFy?: number | null;
  reviewStatus: 'accepted' | 'candidate' | 'rejected' | 'quarantined' | 'unresolved';
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  sourceUrl?: string | null;
  sourceVersion?: string | null;
  sourceObservedAt?: string | null;
  evidence?: JsonObject | unknown[];
  confidence?: number;
  allocatedAmountUsd?: string | null;
  unresolvedReason?: string | null;
  coverageState?: CoverageState | 'unsupported';
  recordedAt?: string | null;
}

export interface AcquisitionCoverageGapInput {
  subjectKind: ProgramAcquisitionRelationshipInput['subjectKind'];
  subjectKey: string;
  sourceSystem: string;
  relationshipKind: string;
  reason: string;
  detail?: string | null;
  coverageState: 'partial' | 'unknown' | 'unavailable' | 'unsupported';
  sourceAsOf?: string | null;
  observedAt?: string | null;
}

export interface AppendResult {
  id: string;
  inserted: boolean;
  identityKey?: string;
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalized(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function date(value: string | null | undefined, field: string): Date | null {
  if (value == null || value.trim() === '') return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid date/time`);
  return parsed;
}

function exactFy(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1900 || value > 2200) {
    throw new Error(`${field} must be a fiscal year between 1900 and 2200`);
  }
  return value;
}

function nonEmpty(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return normalized(value ?? {}) as Prisma.InputJsonValue;
}

interface RelationshipSqlRow {
  id: string;
  subjectKind: string;
  subjectKey: string;
  acquisitionIdentityKey: string;
  relationshipClass: string;
  validFromFy: number | null;
  validToFy: number | null;
  recordedAt: Date;
  reviewStatus: string;
  sourceSystem: string;
  sourceRecordId: string;
  sourceUrl: string | null;
  sourceVersion: string | null;
  sourceObservedAt: Date | null;
  evidence: unknown;
  allocatedAmountUsd: Prisma.Decimal | null;
  unresolvedReason: string | null;
  coverageState: string;
  recordKind: string | null;
  parentIdentityKey: string | null;
  recordTitle: string | null;
  recordStatus: string | null;
}

interface GapSqlRow {
  sourceSystem: string;
  relationshipKind: string;
  reason: string;
  detail: string | null;
  coverageState: string;
  sourceAsOf: Date | null;
  firstObservedAt: Date;
  lastObservedAt: Date | null;
  resolvedAt: Date | null;
}

interface CoverageSqlRow {
  relationshipClass: string;
  sourceSystem: string;
  sourceAsOf: string | null;
  lastObservedAt: Date | null;
}

/** Persistence boundary shared by fixture qualification and dark source adapters. */
@Injectable()
export class AcquisitionContinuityStore implements AcquisitionContinuityReadRepository {
  constructor(private readonly prisma: PrismaService) {}

  async appendRecord(input: AcquisitionRecordInput): Promise<AppendResult> {
    const built = buildAcquisitionIdentity(input);
    if (!built.ok) throw new Error(built.reason);
    const identityKey = built.identity.key;
    const semantic = {
      identityKey,
      sourceSystem: built.identity.source,
      sourceRecordId: nonEmpty(input.sourceRecordId, 'sourceRecordId'),
      recordKind: input.recordKind,
      parentIdentityKey: built.identity.parentIdentityKey,
      title: input.title ?? null,
      status: input.status ?? null,
      buyerOffice: input.buyerOffice ?? null,
      postedAt: input.postedAt ?? null,
      responseDeadline: input.responseDeadline ?? null,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      sourceUrl: input.sourceUrl ?? null,
      sourceVersion: input.sourceVersion ?? null,
      sourceObservedAt: input.sourceObservedAt ?? null,
      raw: input.raw ?? {},
    };
    const contentHash = sha256(semantic);
    const existing = await this.prisma.acquisitionRecordRevision.findUnique({
      where: { identityKey_contentHash: { identityKey, contentHash } },
      select: { id: true },
    });
    if (existing) return { id: existing.id, inserted: false, identityKey };
    const created = await this.prisma.acquisitionRecordRevision.create({
      data: {
        identityKey,
        sourceSystem: built.identity.source,
        sourceRecordId: semantic.sourceRecordId,
        recordKind: input.recordKind,
        parentIdentityKey: built.identity.parentIdentityKey,
        title: input.title ?? null,
        status: input.status ?? null,
        buyerOffice: input.buyerOffice ?? null,
        postedAt: date(input.postedAt, 'postedAt'),
        responseDeadline: date(input.responseDeadline, 'responseDeadline'),
        validFrom: date(input.validFrom, 'validFrom'),
        validTo: date(input.validTo, 'validTo'),
        contentHash,
        sourceUrl: input.sourceUrl ?? null,
        sourceVersion: input.sourceVersion ?? null,
        sourceObservedAt: date(input.sourceObservedAt, 'sourceObservedAt'),
        recordedAt: date(input.recordedAt, 'recordedAt') ?? new Date(),
        raw: asInputJson(input.raw),
      },
      select: { id: true },
    });
    return { id: created.id, inserted: true, identityKey };
  }

  async appendTransaction(input: AcquisitionTransactionInput): Promise<AppendResult> {
    nonEmpty(input.awardIdentityKey, 'awardIdentityKey');
    const built = buildAcquisitionIdentity({
      source: input.source,
      recordKind: 'modification',
      transactionId: input.sourceTransactionId,
      parentIdentityKey: input.parentAwardIdentityKey,
      piid: input.piid,
      modificationNumber: input.modificationNumber,
    });
    if (!built.ok) throw new Error(built.reason);
    if (input.signedObligationDelta == null && input.signedOutlayDelta == null) {
      throw new Error('a transaction requires a signed obligation or outlay delta');
    }
    const semantic = {
      transactionIdentityKey: built.identity.key,
      awardIdentityKey: input.awardIdentityKey,
      parentAwardIdentityKey: input.parentAwardIdentityKey ?? null,
      sourceSystem: built.identity.source,
      sourceTransactionId: nonEmpty(input.sourceTransactionId, 'sourceTransactionId'),
      piid: input.piid ?? null,
      modificationNumber: input.modificationNumber ?? null,
      actionDate: input.actionDate ?? null,
      signedObligationDelta: input.signedObligationDelta ?? null,
      signedOutlayDelta: input.signedOutlayDelta ?? null,
      correctsIdentityKey: input.correctsIdentityKey ?? null,
      sourceUrl: input.sourceUrl ?? null,
      sourceObservedAt: input.sourceObservedAt ?? null,
      raw: input.raw ?? {},
    };
    const contentHash = sha256(semantic);
    const existing = await this.prisma.acquisitionAwardTransactionRevision.findUnique({
      where: { transactionIdentityKey_contentHash: { transactionIdentityKey: built.identity.key, contentHash } },
      select: { id: true },
    });
    if (existing) return { id: existing.id, inserted: false, identityKey: built.identity.key };
    const head = await this.prisma.acquisitionAwardTransactionRevision.findFirst({
      where: { transactionIdentityKey: built.identity.key, revisions: { none: {} } },
      select: { id: true, revision: true, recordedAt: true },
      orderBy: [{ revision: 'desc' }, { recordedAt: 'desc' }],
    });
    let recordedAt = date(input.recordedAt, 'recordedAt') ?? new Date();
    if (head && recordedAt <= head.recordedAt) recordedAt = new Date(head.recordedAt.getTime() + 1);
    const created = await this.prisma.acquisitionAwardTransactionRevision.create({
      data: {
        transactionIdentityKey: built.identity.key,
        awardIdentityKey: input.awardIdentityKey,
        parentAwardIdentityKey: input.parentAwardIdentityKey ?? null,
        sourceSystem: built.identity.source,
        sourceTransactionId: semantic.sourceTransactionId,
        piid: input.piid ?? null,
        modificationNumber: input.modificationNumber ?? null,
        actionDate: date(input.actionDate, 'actionDate'),
        signedObligationDelta: input.signedObligationDelta ?? null,
        signedOutlayDelta: input.signedOutlayDelta ?? null,
        correctsIdentityKey: input.correctsIdentityKey ?? null,
        revision: (head?.revision ?? 0) + 1,
        contentHash,
        supersedesId: head?.id ?? null,
        sourceUrl: input.sourceUrl ?? null,
        sourceObservedAt: date(input.sourceObservedAt, 'sourceObservedAt'),
        recordedAt,
        raw: asInputJson(input.raw),
      },
      select: { id: true },
    });
    return { id: created.id, inserted: true, identityKey: built.identity.key };
  }

  async appendRelationship(input: ProgramAcquisitionRelationshipInput): Promise<AppendResult> {
    const validFromFy = exactFy(input.validFromFy, 'validFromFy');
    const validToFy = exactFy(input.validToFy, 'validToFy');
    if (validFromFy != null && validToFy != null && validToFy < validFromFy) {
      throw new Error('validToFy must be on or after validFromFy');
    }
    const subjectKey = nonEmpty(input.subjectKey, 'subjectKey');
    const acquisitionIdentityKey = nonEmpty(input.acquisitionIdentityKey, 'acquisitionIdentityKey');
    const relationshipForValidation: AcquisitionRelationshipInput = {
      source: input.sourceSystem,
      sourceRecordId: input.sourceRecordId,
      fromIdentityKey: `${input.subjectKind}:${subjectKey}`,
      toIdentityKey: acquisitionIdentityKey,
      relationshipClass: input.relationshipClass,
      evidenceReference: input.sourceUrl ?? null,
      allocatedAmountUsd: input.allocatedAmountUsd ?? null,
      unresolvedReason: input.unresolvedReason ?? null,
      sourceFreshness: { observedAt: input.sourceObservedAt ?? null, sourceAsOf: input.sourceVersion ?? null },
      coverage: {
        state: input.coverageState === 'unsupported' ? 'unavailable' : (input.coverageState ?? 'unknown'),
        note: input.unresolvedReason ?? 'source-qualified relationship',
      },
    };
    const validated = buildAcquisitionRelationship(relationshipForValidation);
    if (!validated.ok) throw new Error(validated.reason);
    if (input.reviewStatus === 'unresolved' && input.relationshipClass !== 'unresolved') {
      throw new Error('unresolved review status requires unresolved relationship class');
    }
    const logicalKey = sha256({
      subjectKind: input.subjectKind,
      subjectKey,
      acquisitionIdentityKey,
      relationshipClass: input.relationshipClass,
      sourceSystem: input.sourceSystem.trim().toLowerCase(),
      sourceRecordId: input.sourceRecordId.trim(),
    });
    const semantic = {
      logicalKey,
      validFromFy,
      validToFy,
      reviewStatus: input.reviewStatus,
      sourceVersion: input.sourceVersion ?? null,
      evidence: input.evidence ?? {},
      confidence: input.confidence ?? 0.5,
      allocatedAmountUsd: input.allocatedAmountUsd ?? null,
      unresolvedReason: input.unresolvedReason ?? null,
      coverageState: input.coverageState ?? 'unknown',
    };
    const contentHash = sha256(semantic);
    const existing = await this.prisma.programAcquisitionRelationship.findUnique({
      where: { logicalKey_contentHash: { logicalKey, contentHash } },
      select: { id: true },
    });
    if (existing) return { id: existing.id, inserted: false };
    const head = await this.prisma.programAcquisitionRelationship.findFirst({
      where: { logicalKey, revisions: { none: {} } },
      select: { id: true, recordedAt: true },
      orderBy: { recordedAt: 'desc' },
    });
    let recordedAt = date(input.recordedAt, 'recordedAt') ?? new Date();
    if (head && recordedAt <= head.recordedAt) recordedAt = new Date(head.recordedAt.getTime() + 1);
    const reviewedAt = input.reviewStatus === 'accepted'
      ? date(input.reviewedAt, 'reviewedAt') ?? recordedAt
      : date(input.reviewedAt, 'reviewedAt');
    const created = await this.prisma.programAcquisitionRelationship.create({
      data: {
        logicalKey,
        subjectKind: input.subjectKind,
        subjectKey,
        acquisitionIdentityKey,
        relationshipClass: input.relationshipClass,
        validFromFy,
        validToFy,
        recordedAt,
        supersedesId: head?.id ?? null,
        reviewStatus: input.reviewStatus,
        reviewedBy: input.reviewedBy ?? null,
        reviewedAt,
        sourceSystem: input.sourceSystem.trim().toLowerCase(),
        sourceRecordId: input.sourceRecordId.trim(),
        sourceUrl: input.sourceUrl ?? null,
        sourceVersion: input.sourceVersion ?? null,
        sourceObservedAt: date(input.sourceObservedAt, 'sourceObservedAt'),
        evidence: asInputJson(input.evidence),
        confidence: input.confidence ?? 0.5,
        allocatedAmountUsd: input.allocatedAmountUsd ?? null,
        unresolvedReason: input.unresolvedReason ?? null,
        coverageState: input.coverageState ?? 'unknown',
        contentHash,
      },
      select: { id: true },
    });
    return { id: created.id, inserted: true };
  }

  async upsertCoverageGap(input: AcquisitionCoverageGapInput): Promise<AppendResult> {
    const observedAt = date(input.observedAt, 'observedAt') ?? new Date();
    const row = await this.prisma.acquisitionCoverageGap.upsert({
      where: {
        subjectKind_subjectKey_sourceSystem_relationshipKind_reason: {
          subjectKind: input.subjectKind,
          subjectKey: nonEmpty(input.subjectKey, 'subjectKey'),
          sourceSystem: nonEmpty(input.sourceSystem, 'sourceSystem').toLowerCase(),
          relationshipKind: nonEmpty(input.relationshipKind, 'relationshipKind'),
          reason: nonEmpty(input.reason, 'reason'),
        },
      },
      create: {
        subjectKind: input.subjectKind,
        subjectKey: input.subjectKey.trim(),
        sourceSystem: input.sourceSystem.trim().toLowerCase(),
        relationshipKind: input.relationshipKind.trim(),
        reason: input.reason.trim(),
        detail: input.detail ?? null,
        coverageState: input.coverageState,
        sourceAsOf: date(input.sourceAsOf, 'sourceAsOf'),
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
      },
      update: {
        detail: input.detail ?? null,
        coverageState: input.coverageState,
        sourceAsOf: date(input.sourceAsOf, 'sourceAsOf'),
        lastObservedAt: observedAt,
        resolvedAt: null,
      },
      select: { id: true, firstObservedAt: true, lastObservedAt: true },
    });
    return { id: row.id, inserted: row.firstObservedAt.getTime() === row.lastObservedAt.getTime() };
  }

  async readPage(query: AcquisitionContinuityRepositoryQuery): Promise<AcquisitionContinuityRepositoryPage> {
    const statuses = query.statuses;
    const after = query.afterStableKey
      ? Prisma.sql`AND r.id::text > ${query.afterStableKey}`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<RelationshipSqlRow[]>(Prisma.sql`
      SELECT r.id, r.subject_kind AS "subjectKind", r.subject_key AS "subjectKey",
             r.acquisition_identity_key AS "acquisitionIdentityKey",
             r.relationship_class AS "relationshipClass", r.valid_from_fy AS "validFromFy",
             r.valid_to_fy AS "validToFy", r.recorded_at AS "recordedAt",
             r.review_status AS "reviewStatus", r.source_system AS "sourceSystem",
             r.source_record_id AS "sourceRecordId", r.source_url AS "sourceUrl",
             r.source_version AS "sourceVersion", r.source_observed_at AS "sourceObservedAt",
             r.evidence_jsonb AS evidence, r.allocated_amount_usd AS "allocatedAmountUsd",
             r.unresolved_reason AS "unresolvedReason", r.coverage_state AS "coverageState",
             a.record_kind AS "recordKind", a.parent_identity_key AS "parentIdentityKey",
             a.title AS "recordTitle", a.status AS "recordStatus"
      FROM program_acquisition_relationship r
      LEFT JOIN LATERAL (
        SELECT a.record_kind, a.parent_identity_key, a.title, a.status
        FROM acquisition_record_revision a
        WHERE a.identity_key = r.acquisition_identity_key AND a.recorded_at <= ${query.knownAt}
        ORDER BY a.recorded_at DESC, a.id DESC LIMIT 1
      ) a ON true
      WHERE r.subject_kind = ${query.subject.type}
        AND r.subject_key = ${query.subject.id}
        AND r.recorded_at <= ${query.knownAt}
        AND (r.valid_from_fy IS NULL OR r.valid_from_fy <= ${query.asOfFy})
        AND (r.valid_to_fy IS NULL OR r.valid_to_fy >= ${query.asOfFy})
        AND r.review_status = ANY(${statuses}::text[])
        AND NOT EXISTS (
          SELECT 1 FROM program_acquisition_relationship newer
          WHERE newer.supersedes_id = r.id AND newer.recorded_at <= ${query.knownAt}
        )
        ${after}
      ORDER BY r.id ASC
      LIMIT ${query.take}
    `);

    // Coverage is query-wide, not page-wide: a page boundary must not make a
    // source look complete or hide relationship classes on later pages.
    const coverageRows = await this.prisma.$queryRaw<CoverageSqlRow[]>(Prisma.sql`
      SELECT r.relationship_class AS "relationshipClass", r.source_system AS "sourceSystem",
             (array_agg(r.source_version ORDER BY r.source_observed_at DESC NULLS LAST, r.id DESC))[1] AS "sourceAsOf",
             MAX(r.source_observed_at) AS "lastObservedAt"
      FROM program_acquisition_relationship r
      WHERE r.subject_kind = ${query.subject.type}
        AND r.subject_key = ${query.subject.id}
        AND r.recorded_at <= ${query.knownAt}
        AND (r.valid_from_fy IS NULL OR r.valid_from_fy <= ${query.asOfFy})
        AND (r.valid_to_fy IS NULL OR r.valid_to_fy >= ${query.asOfFy})
        AND NOT EXISTS (
          SELECT 1 FROM program_acquisition_relationship newer
          WHERE newer.supersedes_id = r.id AND newer.recorded_at <= ${query.knownAt}
        )
      GROUP BY r.relationship_class, r.source_system
      ORDER BY r.source_system, r.relationship_class
    `);

    const gapRows = await this.prisma.$queryRaw<GapSqlRow[]>(Prisma.sql`
      SELECT source_system AS "sourceSystem", relationship_kind AS "relationshipKind",
             reason, detail, coverage_state AS "coverageState", source_as_of AS "sourceAsOf",
             first_observed_at AS "firstObservedAt", last_observed_at AS "lastObservedAt",
             resolved_at AS "resolvedAt"
      FROM acquisition_coverage_gap
      WHERE subject_kind = ${query.subject.type} AND subject_key = ${query.subject.id}
      ORDER BY source_system, relationship_kind, reason
    `);
    const gaps = coverageGapsAt(gapRows, query.knownAt);
    return {
      rows: rows.map((row) => this.toReadRow(row)),
      coverage: this.toCoverage(coverageRows, gaps),
    };
  }

  private toReadRow(row: RelationshipSqlRow): AcquisitionContinuityRelationshipRow {
    const status = (row.reviewStatus === 'accepted' || row.reviewStatus === 'candidate'
      ? row.reviewStatus
      : 'unresolved') as AcquisitionContinuityRelationshipStatus;
    const evidence = normalizeEvidence(row.evidence, row);
    const classification = row.relationshipClass as AcquisitionFinancialClass;
    const sourceAmountUsd = row.allocatedAmountUsd?.toFixed(2) ?? null;
    const from = {
      entityType: row.subjectKind,
      id: row.subjectKey,
      sourceNativeId: row.subjectKey,
      label: null,
    };
    const to = {
      entityType: row.recordKind ?? 'acquisition_record',
      id: row.acquisitionIdentityKey,
      sourceNativeId: row.sourceRecordId,
      label: row.recordTitle,
    };
    const parent = row.parentIdentityKey
      ? { entityType: 'acquisition_parent', id: row.parentIdentityKey, sourceNativeId: row.parentIdentityKey, label: null }
      : null;
    return {
      stableKey: row.id,
      relationshipId: row.id,
      relationshipKind: row.relationshipClass,
      status,
      from,
      to,
      sourceNativeIds: {
        sourceSystem: row.sourceSystem,
        sourceRecordId: row.sourceRecordId,
        acquisitionIdentityKey: row.acquisitionIdentityKey,
      },
      path: parent ? [from, parent, to] : [from, to],
      parent,
      validity: {
        validFromFy: row.validFromFy,
        validToFy: row.validToFy,
        knownFrom: row.recordedAt.toISOString(),
        knownTo: null,
      },
      evidence,
      unresolvedReasons: row.unresolvedReason ? [row.unresolvedReason] : [],
      financialFact: {
        classification,
        reviewState: status === 'accepted' ? 'verified' : status === 'candidate' ? 'candidate' : 'unreviewed',
        sourceAmountUsd,
        actionEffect: sourceAmountUsd?.startsWith('-') ? 'negative' : 'ordinary',
        evidencePresent: evidence.length > 0,
      },
      authoritativeAmountUsd: null,
    };
  }

  private toCoverage(rows: CoverageSqlRow[], gaps: GapSqlRow[]): AcquisitionContinuityCoverage {
    const unsupported = gaps.some((gap) => gap.coverageState === 'unsupported');
    const sourceFreshness = new Map<string, { sourceAsOf: string | null; lastObservedAt: string | null }>();
    for (const row of rows) {
      const current = sourceFreshness.get(row.sourceSystem);
      const observed = row.lastObservedAt?.toISOString() ?? null;
      if (!current || (observed && (!current.lastObservedAt || observed > current.lastObservedAt))) {
        sourceFreshness.set(row.sourceSystem, { sourceAsOf: row.sourceAsOf, lastObservedAt: observed });
      }
    }
    for (const gap of gaps) {
      const observed = gap.lastObservedAt?.toISOString() ?? null;
      const current = sourceFreshness.get(gap.sourceSystem);
      if (!current || (!current.lastObservedAt && observed) || (observed && observed > current.lastObservedAt!)) {
        sourceFreshness.set(gap.sourceSystem, { sourceAsOf: gap.sourceAsOf?.toISOString() ?? null, lastObservedAt: observed });
      }
    }
    const noFreshness = sourceFreshness.size === 0;
    const hasUnknownFreshness = [...sourceFreshness.values()].some((freshness) => freshness.lastObservedAt === null);
    const unresolvedReasons = gaps.map((gap) => ({ code: gap.reason, count: null, detail: gap.detail }));
    if (noFreshness) {
      unresolvedReasons.push({ code: 'source_coverage_unknown', count: null, detail: 'No source observation establishes coverage for this subject and time scope.' });
    } else if (hasUnknownFreshness) {
      unresolvedReasons.push({ code: 'source_freshness_unknown', count: null, detail: 'At least one contributing source has no observation timestamp.' });
    }
    return {
      state: unsupported ? 'unsupported' : gaps.length > 0 || noFreshness || hasUnknownFreshness ? 'partial' : 'complete',
      supportedRelationshipKinds: [...new Set(rows.map((row) => row.relationshipClass))].sort(),
      unsupportedRelationshipKinds: [...new Set(gaps.filter((gap) => gap.coverageState === 'unsupported').map((gap) => gap.relationshipKind))].sort(),
      unresolvedReasons,
      sourceFreshness: [...sourceFreshness.entries()].map(([source, freshness]) => ({
        source,
        ...freshness,
        state: freshness.lastObservedAt ? 'current' : 'unknown',
      })),
    };
  }
}

/**
 * Coverage gaps are currently mutable records, not temporal revisions. If a
 * gap changed after knownAt, its exact historical state cannot be reconstructed;
 * surface an explicit conservative gap instead of silently hiding it or
 * presenting today's reason/state as historical fact.
 */
function coverageGapsAt(gaps: GapSqlRow[], knownAt: Date): GapSqlRow[] {
  return gaps.flatMap((gap) => {
    if (gap.firstObservedAt > knownAt) return [];
    if (gap.lastObservedAt && gap.lastObservedAt > knownAt) {
      return [{
        ...gap,
        reason: 'coverage_history_unavailable',
        detail: 'Coverage gap state changed after knownAt; historical gap state is unavailable.',
        coverageState: gap.coverageState === 'unsupported' ? 'unsupported' : 'partial',
        sourceAsOf: null,
        lastObservedAt: null,
        resolvedAt: null,
      }];
    }
    if (gap.resolvedAt && gap.resolvedAt <= knownAt) return [];
    return [gap];
  });
}

function normalizeEvidence(value: unknown, row: RelationshipSqlRow): AcquisitionContinuityEvidence[] {
  const items = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  return items.map((item) => {
    const record = item && typeof item === 'object' ? item as JsonObject : {};
    return {
      kind: typeof record.kind === 'string' ? record.kind : 'source_record',
      sourceUrl: typeof record.sourceUrl === 'string' ? record.sourceUrl : row.sourceUrl,
      sourceNativeId: typeof record.sourceNativeId === 'string' ? record.sourceNativeId : row.sourceRecordId,
      sourceVersion: typeof record.sourceVersion === 'string' ? record.sourceVersion : row.sourceVersion,
      pageNumber: typeof record.pageNumber === 'number' ? record.pageNumber : null,
      quote: typeof record.quote === 'string' ? record.quote : null,
      contentHash: typeof record.contentHash === 'string' ? record.contentHash : null,
    };
  });
}

export function acquisitionRecordKindFromNoticeType(noticeType: string | null | undefined): AcquisitionRecordKind {
  const value = noticeType?.toLowerCase() ?? '';
  if (value.includes('award')) return 'award';
  if (value.includes('solicitation') || value.includes('presolicitation')) return 'solicitation';
  if (value.includes('modification') || value.includes('amendment')) return 'modification';
  return 'notice';
}
