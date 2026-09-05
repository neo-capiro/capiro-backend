import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { expandFootprintRows, parseFootprintImport } from './district-nexus-economic-import.js';
import type {
  ClientEconomicDistrictSummary,
  ClientEconomicFootprintResponse,
  DistrictEconomicContextResponse,
  DistrictEconomicMetric,
  DistrictEconomicSource,
  DistrictEconomicSourceStatus,
  FootprintEvidenceDecisionRequest,
  FootprintEvidenceRecord,
  FootprintEvidenceType,
  FootprintImportPreviewRequest,
  FootprintImportPreviewResponse,
  FootprintImportSummary,
  FootprintPreviewEvidence,
  FootprintReviewStatus,
  FootprintVerificationStatus,
} from './district-nexus-economic.types.js';

const VISIBLE_CLIENT_FILTER = {
  status: { not: 'archived' },
  profileStatus: 'ACTIVE',
} as const;

const COVERAGE_DIMENSIONS = [
  ['facility', 'facilities'],
  ['employee', 'employees'],
  ['payroll', 'payroll'],
  ['capital_investment', 'capital investment'],
  ['taxes', 'taxes'],
  ['supplier', 'suppliers'],
  ['supplier_spend', 'supplier spend'],
] as const;

interface ImportDbRow {
  id: string;
  client_id: string;
  filename: string;
  format: string;
  status: string;
  content_sha256: string | null;
  row_count: number;
  accepted_count: number;
  rejected_count: number;
  preview_jsonb: unknown;
  warnings_jsonb: unknown;
  effective_date: Date | null;
  external_use_approved: boolean;
  created_at: Date;
  committed_at: Date | null;
}

interface EvidenceDbRow {
  id: string;
  import_id: string | null;
  row_ordinal: number | null;
  evidence_type: string;
  subject_id: string | null;
  subject_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  congressional_district: string | null;
  congressional_district_congress: number | null;
  district_source: string | null;
  numeric_value: Prisma.Decimal | number | string | null;
  unit: string | null;
  currency: string | null;
  source_type: string;
  source_record_id: string | null;
  verification_status: string;
  review_status: string;
  confidence: Prisma.Decimal | number | string | null;
  external_use_approved: boolean;
  effective_from: Date | null;
  effective_to: Date | null;
  observed_at: Date | null;
  metadata_jsonb: unknown;
  promoted_facility_id: string | null;
  created_at: Date;
  reviewed_at: Date | null;
}

interface EconomicFactDbRow {
  source: string;
  dataset: string;
  source_year: number;
  boundary_congress: number | null;
  metric_key: string;
  metric_value: Prisma.Decimal | number | string | null;
  unit: string | null;
  margin_of_error: Prisma.Decimal | number | string | null;
  naics_code: string | null;
  source_record_id: string | null;
  source_url: string | null;
  observed_at: Date | null;
  last_synced_at: Date;
  metadata_jsonb: unknown;
}

interface SourceRunDbRow {
  source: string;
  dataset: string;
  source_year: number | null;
  boundary_congress: number | null;
  status: string;
  attempted_at: Date;
  completed_at: Date | null;
  rows_seen: number;
  rows_written: number;
  rows_rejected: number;
  error: string | null;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayOrEmpty(value).filter((item): item is string => typeof item === 'string');
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateOnly(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function requestDate(value: string | null | undefined, label: string): Date | null {
  if (!value?.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${label} must be a valid date`);
  }
  return date;
}

function normalizeState(value: string): string {
  const state = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) throw new BadRequestException('state must be a two-letter code');
  return state;
}

function normalizeDistrict(value: string): string {
  const district = value.trim().toUpperCase();
  const tail = district.includes('-') ? district.split('-').at(-1)! : district;
  if (tail === 'AL') return '00';
  if (!/^\d{1,2}$/.test(tail)) throw new BadRequestException('district must be numeric or AL');
  const numeric = Number(tail);
  if (numeric >= 90)
    throw new BadRequestException('district is a source sentinel, not a congressional district');
  return String(numeric).padStart(2, '0');
}

function districtKey(state: string, district: string): string {
  return `${state}-${district}`;
}

function sumOrNull(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value != null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

/** Warnings containing this phrase are deliberately non-committable. */
function blockingWarnings(evidence: FootprintPreviewEvidence): string[] {
  return evidence.warnings.filter(
    (warning) =>
      warning.includes('requires a numeric value') || warning.includes('requires review'),
  );
}

function asEvidenceType(value: string): FootprintEvidenceType {
  return value as FootprintEvidenceType;
}

function asReviewStatus(value: string): FootprintReviewStatus {
  return value as FootprintReviewStatus;
}

function asVerificationStatus(value: string): FootprintVerificationStatus {
  return value as FootprintVerificationStatus;
}

/**
 * Release 3 economic-footprint read/write service.
 *
 * Tenant-owned reads and writes always run in a short withTenant transaction
 * AND explicitly filter tenant_id in every raw query. The explicit predicate is
 * load-bearing because the runtime role can bypass table-owner RLS. Public
 * district facts remain global and are read outside tenant transactions.
 */
@Injectable()
export class DistrictNexusEconomicService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertClient(tenantId: string, clientId: string): Promise<void> {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, ...VISIBLE_CLIENT_FILTER },
        select: { id: true },
      }),
    );
    if (!client) throw new NotFoundException('Client not found');
  }

  async previewImport(
    tenantId: string,
    userId: string | null,
    clientId: string,
    request: FootprintImportPreviewRequest,
  ): Promise<FootprintImportPreviewResponse> {
    await this.assertClient(tenantId, clientId);
    const effectiveDate = requestDate(request.effectiveDate, 'effectiveDate');
    const parsed = await parseFootprintImport(request).catch((error: unknown) => {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Unable to parse footprint import',
      );
    });
    const sourceType = request.format === 'meri_structured' ? 'meri_structured' : 'client_import';
    let evidence = expandFootprintRows(parsed.rows, {
      effectiveDate: request.effectiveDate,
      sourceType,
    });
    evidence = await this.geocodePreview(evidence);

    const rejectedCount = evidence.filter((row) => blockingWarnings(row).length > 0).length;
    const acceptedCount = evidence.length - rejectedCount;
    const warnings = [
      ...new Set([
        ...parsed.warnings,
        ...evidence.flatMap((row) => row.warnings),
        ...(request.externalUseApproved
          ? [
              'External-use approval is applied only after an administrator reviews each evidence record.',
            ]
          : []),
      ]),
    ];
    const now = new Date();

    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<ImportDbRow[]>(Prisma.sql`
        INSERT INTO client_footprint_import (
          tenant_id, client_id, filename, format, status, source_type,
          content_sha256, row_count, accepted_count, rejected_count,
          mapping_jsonb, preview_jsonb, warnings_jsonb, effective_date,
          external_use_approved, created_by_user_id, created_at, updated_at
        ) VALUES (
          ${tenantId}::uuid,
          ${clientId}::uuid,
          ${request.filename.trim()},
          ${request.format},
          'preview',
          ${sourceType},
          ${parsed.contentSha256},
          ${parsed.rows.length},
          ${acceptedCount},
          ${rejectedCount},
          ${JSON.stringify(request.columnMap ?? {})}::jsonb,
          ${JSON.stringify(evidence)}::jsonb,
          ${JSON.stringify(warnings)}::jsonb,
          ${effectiveDate}::date,
          false,
          ${userId}::uuid,
          ${now},
          ${now}
        )
        RETURNING *
      `),
    );
    const saved = rows[0];
    if (!saved) throw new ConflictException('Footprint preview could not be persisted');
    return {
      importId: saved.id,
      clientId,
      filename: saved.filename,
      format: request.format,
      status: 'preview',
      rowCount: saved.row_count,
      evidenceCount: evidence.length,
      acceptedCount: saved.accepted_count,
      rejectedCount: saved.rejected_count,
      warnings,
      evidence,
      createdAt: saved.created_at.toISOString(),
    };
  }

  async commitImport(
    tenantId: string,
    userId: string | null,
    clientId: string,
    importId: string,
  ): Promise<FootprintImportSummary> {
    await this.assertClient(tenantId, clientId);
    return this.prisma.withTenant(
      tenantId,
      async (tx) => {
        const imports = await tx.$queryRaw<ImportDbRow[]>(Prisma.sql`
          SELECT *
          FROM client_footprint_import
          WHERE id = ${importId}::uuid
            AND tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid
          FOR UPDATE
        `);
        const row = imports[0];
        if (!row) throw new NotFoundException('Footprint import not found');
        if (row.status === 'committed') return this.importSummary(row);
        if (row.status !== 'preview')
          throw new ConflictException('Only a preview can be committed');

        if (row.content_sha256) {
          const duplicates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT id::text AS id
            FROM client_footprint_import
            WHERE tenant_id = ${tenantId}::uuid
              AND client_id = ${clientId}::uuid
              AND content_sha256 = ${row.content_sha256}
              AND status = 'committed'
              AND id <> ${importId}::uuid
            LIMIT 1
          `);
          if (duplicates.length) {
            throw new ConflictException(
              'This footprint file has already been committed for this client',
            );
          }
        }

        const preview = arrayOrEmpty(row.preview_jsonb) as unknown as FootprintPreviewEvidence[];
        const accepted = preview.filter((item) => blockingWarnings(item).length === 0);
        if (!accepted.length) {
          throw new BadRequestException('No valid footprint evidence is available to commit');
        }

        for (const item of accepted) {
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO client_geographic_evidence (
              tenant_id, client_id, import_id, row_ordinal, evidence_type,
              subject_type, subject_id, subject_name,
              address_line1, address_line2, city, state, postal_code, country,
              latitude, longitude, congressional_district,
              congressional_district_congress, district_source,
              numeric_value, unit, currency, source_type, source_record_id,
              verification_status, review_status, confidence,
              external_use_approved, effective_from, effective_to, observed_at,
              metadata_jsonb, created_by_user_id, created_at, updated_at
            ) VALUES (
              ${tenantId}::uuid,
              ${clientId}::uuid,
              ${importId}::uuid,
              ${item.rowOrdinal},
              ${item.evidenceType},
              ${this.subjectTypeFor(item.evidenceType)},
              ${item.subjectId},
              ${item.subjectName},
              ${item.address.line1},
              ${item.address.line2},
              ${item.address.city},
              ${item.geography.state},
              ${item.address.postalCode},
              ${item.address.country},
              ${item.geography.latitude},
              ${item.geography.longitude},
              ${item.geography.congressionalDistrict},
              ${item.geography.boundaryCongress},
              ${item.geography.districtSource},
              ${item.numericValue},
              ${item.unit},
              ${item.currency},
              ${row.format === 'meri_structured' ? 'meri_structured' : 'client_import'},
              ${item.sourceRecordId},
              ${item.verificationStatus},
              'pending_review',
              ${item.verificationStatus === 'geocode_verified' ? 1 : null},
              false,
              ${item.effectiveFrom ? new Date(item.effectiveFrom) : null}::date,
              ${item.effectiveTo ? new Date(item.effectiveTo) : null}::date,
              ${item.observedAt ? new Date(item.observedAt) : null},
              ${JSON.stringify(item.metadata ?? {})}::jsonb,
              ${userId}::uuid,
              now(),
              now()
            )
          `);
        }

        const updated = await tx.$queryRaw<ImportDbRow[]>(Prisma.sql`
          UPDATE client_footprint_import
          SET status = 'committed',
              committed_by_user_id = ${userId}::uuid,
              committed_at = now(),
              updated_at = now(),
              accepted_count = ${accepted.length},
              rejected_count = ${preview.length - accepted.length}
          WHERE id = ${importId}::uuid
            AND tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid
          RETURNING *
        `);
        return this.importSummary(updated[0] ?? row);
      },
      { timeoutMs: 30_000 },
    );
  }

  async decideEvidence(
    tenantId: string,
    userId: string | null,
    clientId: string,
    evidenceId: string,
    decision: 'approve' | 'reject',
    request: FootprintEvidenceDecisionRequest,
  ): Promise<FootprintEvidenceRecord> {
    await this.assertClient(tenantId, clientId);
    return this.prisma.withTenant(
      tenantId,
      async (tx) => {
        const rows = await tx.$queryRaw<EvidenceDbRow[]>(Prisma.sql`
          SELECT *
          FROM client_geographic_evidence
          WHERE id = ${evidenceId}::uuid
            AND tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid
          FOR UPDATE
        `);
        const evidence = rows[0];
        if (!evidence) throw new NotFoundException('Footprint evidence not found');

        const reviewStatus = decision === 'approve' ? 'approved' : 'rejected';
        if (evidence.review_status === reviewStatus) return this.evidenceRecord(evidence);
        if (evidence.review_status !== 'pending_review') {
          throw new ConflictException('Footprint evidence review is final');
        }

        const updated = await tx.$queryRaw<EvidenceDbRow[]>(Prisma.sql`
          UPDATE client_geographic_evidence
          SET review_status = ${reviewStatus},
              external_use_approved = CASE
                WHEN ${decision} = 'approve' THEN ${request.externalUseApproved === true}
                ELSE false
              END,
              reviewed_by_user_id = ${userId}::uuid,
              reviewed_at = now(),
              updated_at = now()
          WHERE id = ${evidenceId}::uuid
            AND tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid
            AND review_status = 'pending_review'
          RETURNING *
        `);
        const changed = updated[0];
        if (!changed) throw new ConflictException('Footprint evidence was reviewed concurrently');
        let finalRow = changed;
        if (decision === 'approve') {
          finalRow = await this.promoteApprovedEvidence(tx, tenantId, clientId, finalRow);
        }
        return this.evidenceRecord(finalRow);
      },
      { timeoutMs: 20_000 },
    );
  }

  async getClientFootprint(
    tenantId: string,
    clientId: string,
  ): Promise<ClientEconomicFootprintResponse> {
    await this.assertClient(tenantId, clientId);
    const { imports, evidence } = await this.prisma.withTenant(tenantId, async (tx) => {
      const [importRows, evidenceRows] = await Promise.all([
        tx.$queryRaw<ImportDbRow[]>(Prisma.sql`
          SELECT *
          FROM client_footprint_import
          WHERE tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid
          ORDER BY created_at DESC
          LIMIT 50
        `),
        tx.$queryRaw<EvidenceDbRow[]>(Prisma.sql`
          SELECT *
          FROM client_geographic_evidence
          WHERE tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid
          ORDER BY created_at DESC
          LIMIT 1000
        `),
      ]);
      return { imports: importRows, evidence: evidenceRows };
    });

    const records = evidence.map((row) => this.evidenceRecord(row));
    const approved = records.filter((row) => row.reviewStatus === 'approved');
    const pending = records.filter((row) => row.reviewStatus === 'pending_review');
    const active = [...approved, ...pending];
    const districtMap = new Map<string, FootprintEvidenceRecord[]>();
    for (const row of active) {
      if (!row.state || !row.congressionalDistrict) continue;
      const key = districtKey(row.state, row.congressionalDistrict);
      const bucket = districtMap.get(key);
      if (bucket) bucket.push(row);
      else districtMap.set(key, [row]);
    }

    const districts = [...districtMap.entries()]
      .map(([key, rows]) => this.districtSummary(key, rows))
      .sort(
        (a, b) =>
          b.approvedEvidenceCount - a.approvedEvidenceCount ||
          a.districtKey.localeCompare(b.districtKey),
      );

    const measuredTypes = new Set(approved.map((row) => row.evidenceType));
    const measured = COVERAGE_DIMENSIONS.filter(([type]) => measuredTypes.has(type)).map(
      ([, label]) => label,
    );
    const missing = COVERAGE_DIMENSIONS.filter(([type]) => !measuredTypes.has(type)).map(
      ([, label]) => label,
    );
    const unresolved = active.filter((row) => !row.state || !row.congressionalDistrict).length;
    const warnings: string[] = [];
    if (pending.length) {
      warnings.push(
        `${pending.length} evidence record${pending.length === 1 ? '' : 's'} await review.`,
      );
    }
    if (unresolved) {
      warnings.push(
        `${unresolved} active evidence record${unresolved === 1 ? '' : 's'} cannot yet be placed in a congressional district.`,
      );
    }
    if (!approved.length) warnings.push('No imported economic evidence has been approved yet.');

    return {
      clientId,
      districts,
      imports: imports.map((row) => this.importSummary(row)),
      evidence: records,
      coverage: {
        percent: Math.round((measured.length / COVERAGE_DIMENSIONS.length) * 100),
        measured,
        missing,
      },
      totals: this.totals(approved, pending),
      warnings,
      generatedAt: new Date().toISOString(),
    };
  }

  async getDistrictContext(
    stateInput: string,
    districtInput: string,
  ): Promise<DistrictEconomicContextResponse> {
    const state = normalizeState(stateInput);
    const district = normalizeDistrict(districtInput);
    const [facts, sourceRuns] = await Promise.all([
      this.prisma.$queryRaw<EconomicFactDbRow[]>(Prisma.sql`
        SELECT source, dataset, source_year, boundary_congress, metric_key,
               metric_value, unit, margin_of_error, naics_code,
               source_record_id, source_url, observed_at, last_synced_at,
               metadata_jsonb
        FROM district_economic_fact
        WHERE state = ${state}
          AND district_code = ${district}
        ORDER BY source_year DESC, source, metric_key, naics_code NULLS FIRST
        LIMIT 1000
      `),
      this.prisma.$queryRaw<SourceRunDbRow[]>(Prisma.sql`
        SELECT DISTINCT ON (source, dataset)
               source, dataset, source_year, boundary_congress, status,
               attempted_at, completed_at, rows_seen, rows_written,
               rows_rejected, error
        FROM district_economic_source_run
        WHERE dry_run = false
        ORDER BY source, dataset, attempted_at DESC
      `),
    ]);

    const metrics: DistrictEconomicMetric[] = facts.map((row) => ({
      source: row.source as DistrictEconomicSource,
      dataset: row.dataset,
      sourceYear: row.source_year,
      boundaryCongress: row.boundary_congress,
      metricKey: row.metric_key,
      value: numberOrNull(row.metric_value),
      unit: row.unit,
      marginOfError: numberOrNull(row.margin_of_error),
      naicsCode: row.naics_code,
      sourceRecordId: row.source_record_id,
      sourceUrl: row.source_url,
      observedAt: iso(row.observed_at),
      lastSyncedAt: row.last_synced_at.toISOString(),
      metadata: objectOrEmpty(row.metadata_jsonb),
    }));
    const sources: DistrictEconomicSourceStatus[] = sourceRuns.map((row) => ({
      source: row.source as DistrictEconomicSource,
      dataset: row.dataset,
      sourceYear: row.source_year,
      boundaryCongress: row.boundary_congress,
      status: row.status as DistrictEconomicSourceStatus['status'],
      lastAttemptAt: row.attempted_at.toISOString(),
      lastCompletedAt: iso(row.completed_at),
      rowsSeen: row.rows_seen,
      rowsWritten: row.rows_written,
      rowsRejected: row.rows_rejected,
      error: row.error,
      annual: true,
    }));
    const warnings: string[] = [];
    if (!metrics.length) {
      warnings.push(
        'No ACS, County Business Patterns, or LODES facts have been loaded for this district yet.',
      );
    }
    for (const source of sources) {
      if (source.status === 'unavailable') {
        warnings.push(`${source.source.toUpperCase()} is configured but unavailable.`);
      }
      if (source.status === 'failed') {
        warnings.push(`${source.source.toUpperCase()} last failed to refresh.`);
      }
    }
    return {
      districtKey: districtKey(state, district),
      state,
      districtCode: district,
      metrics,
      sources,
      warnings,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Honest supplier/subaward availability (Release 4 repair).
   *
   * Previously this returned a hard-coded `available: true`, which reported
   * false availability for tenants whose Federal Market rails have never
   * synchronized or whose client has no attributable subaward records.
   *
   * Now reflects:
   *  - feature availability (flag ON is required to even reach this route, but
   *    the economic types still gate the semantic),
   *  - actual source coverage: does the tenant's Federal Market subaward rail
   *    hold ANY rows (synced), and how fresh is the newest row,
   *  - last successful refresh vs last failure (tango sync checkpoints when
   *    present, otherwise row freshness),
   *  - client identity basis: confirmed contracting mappings / UEI — without a
   *    reviewed identity, no subaward can be attributed,
   *  - whether any attributable subaward/subawardee rows exist for the client.
   *
   * "No matching records" (source loaded, client has nothing attributable) and
   * "source unavailable/not populated" (no synced rows at all) are DIFFERENT
   * states. No new subaward store: tango_subaward stays the source of truth.
   */
  async getSupplierFootprintStatus(tenantId: string, clientId: string) {
    await this.assertClient(tenantId, clientId);

    // 1) Source coverage: how many synced subaward rows exist, and how fresh?
    const coverageRows = await this.prisma.$queryRaw<
      Array<{ n: bigint; last_synced_at: Date | null }>
    >`
      SELECT count(*)::bigint AS n, max(last_synced_at) AS last_synced_at
      FROM tango_subaward
      WHERE active = true
    `;
    const totalRows = Number(coverageRows[0]?.n ?? 0);
    const lastSyncedAt = coverageRows[0]?.last_synced_at ?? null;

    // 2) Client identity basis: reviewed contracting mappings or the client UEI.
    const identity = await this.prisma.withTenant(tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId },
        select: { uei: true, name: true },
      });
      const mappings = await tx.clientIntelMapping.findMany({
        where: { clientId, source: 'contracting', reviewStatus: 'confirmed' },
        select: { externalId: true, externalName: true },
      });
      return { client, mappings };
    });
    const hasUei = Boolean(identity.client?.uei);
    const hasConfirmedMappings = identity.mappings.length > 0;
    const identityBasis: 'confirmed_uei_or_mappings' | 'none' =
      hasUei || hasConfirmedMappings ? 'confirmed_uei_or_mappings' : 'none';

    // 3) Attributable rows: does the client's confirmed identity match any
    //    subaward prime/subawardee UEI? Only exact confirmed UEIs count.
    let attributableRows = 0;
    const ueis = new Set<string>();
    if (identity.client?.uei) ueis.add(identity.client.uei.trim().toUpperCase());
    for (const m of identity.mappings) {
      const id = m.externalId?.trim().toUpperCase();
      if (id && /^[A-Z0-9]{12}$/.test(id)) ueis.add(id);
    }
    if (ueis.size > 0 && totalRows > 0) {
      const ueiList = [...ueis];
      const matchRows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n
        FROM tango_subaward
        WHERE active = true
          AND (
            UPPER(subawardee_uei) IN (${Prisma.join(ueiList)})
            OR UPPER(prime_recipient_uei) IN (${Prisma.join(ueiList)})
          )
      `;
      attributableRows = Number(matchRows[0]?.n ?? 0);
    }

    // 4) Honest status resolution. unavailable ≠ empty ≠ zero.
    const sourcePopulated = totalRows > 0;
    const hasIdentity = identityBasis === 'confirmed_uei_or_mappings';

    let status:
      | 'unavailable'
      | 'not_populated'
      | 'no_identity'
      | 'no_matching_records'
      | 'available';
    let note: string;
    if (!sourcePopulated) {
      status = 'not_populated';
      note =
        'Federal Market subaward sync has never populated any rows in this environment. This is a missing-source state, not an empty client result.';
    } else if (lastSyncedAt == null) {
      status = 'unavailable';
      note = 'Subaward rows exist but carry no successful sync timestamp; freshness is unknown.';
    } else if (!hasIdentity) {
      status = 'no_identity';
      note =
        'Subaward source is populated, but this client has no confirmed contracting identity (UEI or reviewed mapping) — attribution is impossible, not zero.';
    } else if (attributableRows === 0) {
      status = 'no_matching_records';
      note =
        'Source is populated and the client identity is confirmed, but no subaward rows match. This is a real empty result, distinct from a missing source.';
    } else {
      status = 'available';
      note =
        'Subaward place of performance is preferred; subawardee-location fallback remains explicitly weaker.';
    }

    const stalenessDays = lastSyncedAt
      ? Math.floor((Date.now() - lastSyncedAt.getTime()) / 86_400_000)
      : null;

    return {
      clientId,
      status,
      available: status === 'available',
      source: 'federal_market',
      sourcePopulated,
      totalSubawardRows: totalRows,
      attributableSubawardRows: attributableRows,
      clientIdentityBasis: identityBasis,
      confirmedMappingCount: identity.mappings.length,
      lastSuccessfulSyncAt: lastSyncedAt ? lastSyncedAt.toISOString() : null,
      /** Days since the last successful sync; null when never synced. */
      stalenessDays,
      endpoint: `/api/federal-market/clients/${encodeURIComponent(clientId)}/market/geography`,
      note,
    };
  }

  private importSummary(row: ImportDbRow): FootprintImportSummary {
    return {
      id: row.id,
      filename: row.filename,
      format: row.format as FootprintImportSummary['format'],
      status: row.status as FootprintImportSummary['status'],
      rowCount: row.row_count,
      acceptedCount: row.accepted_count,
      rejectedCount: row.rejected_count,
      effectiveDate: dateOnly(row.effective_date),
      externalUseApproved: row.external_use_approved,
      createdAt: row.created_at.toISOString(),
      committedAt: iso(row.committed_at),
      warnings: stringArray(row.warnings_jsonb),
    };
  }

  private evidenceRecord(row: EvidenceDbRow): FootprintEvidenceRecord {
    return {
      id: row.id,
      importId: row.import_id,
      rowOrdinal: row.row_ordinal,
      evidenceType: asEvidenceType(row.evidence_type),
      subjectName: row.subject_name,
      subjectId: row.subject_id,
      state: row.state,
      congressionalDistrict: row.congressional_district,
      boundaryCongress: row.congressional_district_congress,
      numericValue: numberOrNull(row.numeric_value),
      unit: row.unit,
      currency: row.currency,
      verificationStatus: asVerificationStatus(row.verification_status),
      reviewStatus: asReviewStatus(row.review_status),
      externalUseApproved: row.external_use_approved,
      effectiveFrom: dateOnly(row.effective_from),
      effectiveTo: dateOnly(row.effective_to),
      observedAt: iso(row.observed_at),
      promotedFacilityId: row.promoted_facility_id,
      createdAt: row.created_at.toISOString(),
      reviewedAt: iso(row.reviewed_at),
      metadata: objectOrEmpty(row.metadata_jsonb),
    };
  }

  private districtSummary(
    key: string,
    rows: FootprintEvidenceRecord[],
  ): ClientEconomicDistrictSummary {
    const parts = key.split('-');
    const state = parts[0] ?? '';
    const districtCode = parts[1] ?? '';
    const approved = rows.filter((row) => row.reviewStatus === 'approved');
    const pending = rows.filter((row) => row.reviewStatus === 'pending_review');
    const values = (type: FootprintEvidenceType) =>
      approved.filter((row) => row.evidenceType === type).map((row) => row.numericValue);
    const names = (types: FootprintEvidenceType[]) =>
      new Set(
        approved
          .filter((row) => types.includes(row.evidenceType))
          .map((row) => row.subjectName?.trim().toLowerCase())
          .filter((name): name is string => Boolean(name)),
      ).size;
    return {
      districtKey: key,
      state,
      districtCode,
      approvedEvidenceCount: approved.length,
      pendingEvidenceCount: pending.length,
      facilityCount: approved.filter((row) => row.evidenceType === 'facility').length,
      employeeCount: sumOrNull(values('employee')),
      payroll: sumOrNull(values('payroll')),
      capitalInvestment: sumOrNull(values('capital_investment')),
      taxes: sumOrNull(values('taxes')),
      supplierCount: names(['supplier', 'supplier_spend']),
      supplierSpend: sumOrNull(values('supplier_spend')),
      partnerCount: names(['partner']),
      beneficiaryCount: sumOrNull(values('beneficiary_count')),
      projectSiteCount: approved.filter((row) => row.evidenceType === 'project_site').length,
      boundaryCongresses: [
        ...new Set(
          approved
            .map((row) => row.boundaryCongress)
            .filter((value): value is number => value != null),
        ),
      ].sort((a, b) => a - b),
      externalUseApprovedCount: approved.filter((row) => row.externalUseApproved).length,
    };
  }

  private totals(
    approved: FootprintEvidenceRecord[],
    pending: FootprintEvidenceRecord[],
  ): ClientEconomicFootprintResponse['totals'] {
    const values = (type: FootprintEvidenceType) =>
      approved.filter((row) => row.evidenceType === type).map((row) => row.numericValue);
    const names = (types: FootprintEvidenceType[]) =>
      new Set(
        approved
          .filter((row) => types.includes(row.evidenceType))
          .map((row) => row.subjectName?.trim().toLowerCase())
          .filter((name): name is string => Boolean(name)),
      ).size;
    return {
      approvedEvidenceCount: approved.length,
      pendingEvidenceCount: pending.length,
      facilityCount: approved.filter((row) => row.evidenceType === 'facility').length,
      employeeCount: sumOrNull(values('employee')),
      payroll: sumOrNull(values('payroll')),
      capitalInvestment: sumOrNull(values('capital_investment')),
      taxes: sumOrNull(values('taxes')),
      supplierCount: names(['supplier', 'supplier_spend']),
      supplierSpend: sumOrNull(values('supplier_spend')),
      partnerCount: names(['partner']),
      beneficiaryCount: sumOrNull(values('beneficiary_count')),
      projectSiteCount: approved.filter((row) => row.evidenceType === 'project_site').length,
    };
  }

  private subjectTypeFor(type: FootprintEvidenceType): string {
    if (
      type === 'facility' ||
      type === 'employee' ||
      type === 'payroll' ||
      type === 'capital_investment' ||
      type === 'taxes'
    ) {
      return 'facility';
    }
    if (type === 'supplier' || type === 'supplier_spend') return 'supplier';
    if (type === 'partner') return 'partner';
    if (type === 'project_site') return 'project';
    if (type === 'beneficiary' || type === 'beneficiary_count') return 'beneficiary';
    return 'other';
  }

  private async geocodePreview(
    evidence: FootprintPreviewEvidence[],
  ): Promise<FootprintPreviewEvidence[]> {
    const byRow = new Map<number, FootprintPreviewEvidence[]>();
    for (const row of evidence) {
      const bucket = byRow.get(row.rowOrdinal);
      if (bucket) bucket.push(row);
      else byRow.set(row.rowOrdinal, [row]);
    }
    for (const rows of byRow.values()) {
      const first = rows[0];
      if (!first || first.geography.congressionalDistrict) continue;
      if (!first.address.line1 || !first.address.city || !first.address.state) continue;
      const result = await this.censusGeocode(first).catch(() => null);
      if (!result) {
        for (const row of rows) {
          if (
            !row.warnings.some((warning) => warning.startsWith('Address could not be resolved'))
          ) {
            row.warnings.push(
              'Address could not be resolved by the Census geocoder; requires review.',
            );
          }
        }
        continue;
      }
      for (const row of rows) {
        row.geography = result;
        row.verificationStatus = 'geocode_verified';
        row.warnings = row.warnings.filter(
          (warning) => !warning.startsWith('No district or complete'),
        );
      }
    }
    return evidence;
  }

  private async censusGeocode(
    row: FootprintPreviewEvidence,
  ): Promise<FootprintPreviewEvidence['geography'] | null> {
    const address = [
      row.address.line1,
      row.address.line2,
      row.address.city,
      row.address.state,
      row.address.postalCode,
    ]
      .filter(Boolean)
      .join(', ');
    const url = new URL('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress');
    url.searchParams.set('address', address);
    url.searchParams.set('benchmark', 'Public_AR_Current');
    url.searchParams.set('vintage', 'Current_Current');
    url.searchParams.set('format', 'json');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      const payload = (await response.json()) as {
        result?: {
          addressMatches?: Array<{
            coordinates?: { x?: number; y?: number };
            geographies?: Record<string, Array<Record<string, unknown>>>;
          }>;
        };
      };
      const match = payload.result?.addressMatches?.[0];
      if (!match) return null;
      let district: string | null = null;
      let congress: number | null = null;
      for (const [layerName, layerRows] of Object.entries(match.geographies ?? {})) {
        if (!/congressional district/i.test(layerName)) continue;
        const layer = layerRows[0] ?? {};
        for (const [key, value] of Object.entries(layer)) {
          const parsed = /^CD(\d+)$/.exec(key);
          if (!parsed) continue;
          const raw = String(value ?? '').trim();
          if (/^\d{1,2}$/.test(raw)) {
            district = String(Number(raw)).padStart(2, '0');
            congress = Number(parsed[1]);
            break;
          }
        }
        if (!district) {
          const fallback = String(layer.BASENAME ?? layer.NAME ?? '').match(/\d{1,2}/)?.[0];
          if (fallback) district = String(Number(fallback)).padStart(2, '0');
        }
        if (district) break;
      }
      if (!district) return null;
      return {
        state: row.address.state,
        congressionalDistrict: district,
        boundaryCongress: congress,
        latitude: numberOrNull(match.coordinates?.y),
        longitude: numberOrNull(match.coordinates?.x),
        districtSource: 'census_geocoder',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async promoteApprovedEvidence(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clientId: string,
    evidence: EvidenceDbRow,
  ): Promise<EvidenceDbRow> {
    if (evidence.evidence_type === 'facility' && !evidence.promoted_facility_id) {
      const columns = await tx.$queryRaw<Array<{ column_name: string }>>(Prisma.sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'client_facilities'
      `);
      const available = new Set(columns.map((row) => row.column_name));
      const optionalAddress1 = ['address_1', 'address1', 'address_line1'].find((name) =>
        available.has(name),
      );
      const optionalAddress2 = ['address_2', 'address2', 'address_line2'].find((name) =>
        available.has(name),
      );
      const employee =
        evidence.import_id && evidence.row_ordinal != null
          ? await tx.$queryRaw<Array<{ numeric_value: Prisma.Decimal | null }>>(Prisma.sql`
              SELECT numeric_value
              FROM client_geographic_evidence
              WHERE tenant_id = ${tenantId}::uuid
                AND client_id = ${clientId}::uuid
                AND import_id = ${evidence.import_id}::uuid
                AND row_ordinal = ${evidence.row_ordinal}
                AND evidence_type = 'employee'
                AND review_status = 'approved'
              ORDER BY reviewed_at DESC NULLS LAST
              LIMIT 1
            `)
          : [];
      const employeeCount = numberOrNull(employee[0]?.numeric_value);
      const names: string[] = [
        'tenant_id',
        'client_id',
        'name',
        'city',
        'state',
        'postal_code',
        'country',
        'latitude',
        'longitude',
        'congressional_district',
        'congressional_district_congress',
        'employee_count',
        'district_source',
        'geocode_status',
        'geocoded_at',
        'created_at',
        'updated_at',
      ].filter((name) => available.has(name));
      if (optionalAddress1) names.push(optionalAddress1);
      if (optionalAddress2) names.push(optionalAddress2);
      const valueByColumn: Record<string, unknown> = {
        tenant_id: tenantId,
        client_id: clientId,
        name: evidence.subject_name ?? `Imported facility row ${evidence.row_ordinal ?? ''}`.trim(),
        city: evidence.city,
        state: evidence.state,
        postal_code: evidence.postal_code,
        country: evidence.country ?? 'US',
        latitude: evidence.latitude,
        longitude: evidence.longitude,
        congressional_district: evidence.congressional_district,
        congressional_district_congress: evidence.congressional_district_congress,
        employee_count: employeeCount == null ? null : Math.round(employeeCount),
        district_source: evidence.district_source === 'census_geocoder' ? 'geocoded' : 'user',
        geocode_status: evidence.district_source === 'census_geocoder' ? 'matched' : null,
        geocoded_at: evidence.district_source === 'census_geocoder' ? new Date() : null,
        created_at: new Date(),
        updated_at: new Date(),
        ...(optionalAddress1 ? { [optionalAddress1]: evidence.address_line1 } : {}),
        ...(optionalAddress2 ? { [optionalAddress2]: evidence.address_line2 } : {}),
      };
      const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO client_facilities (
          ${Prisma.join(names.map((name) => Prisma.raw(`"${name}"`)))}
        ) VALUES (
          ${Prisma.join(names.map((name) => Prisma.sql`${valueByColumn[name]}`))}
        )
        RETURNING id::text AS id
      `);
      const facilityId = inserted[0]?.id;
      if (facilityId) {
        const rows = await tx.$queryRaw<EvidenceDbRow[]>(Prisma.sql`
          UPDATE client_geographic_evidence
          SET promoted_facility_id = ${facilityId}::uuid,
              updated_at = now()
          WHERE id = ${evidence.id}::uuid
            AND tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid
          RETURNING *
        `);
        return rows[0] ?? evidence;
      }
    }

    if (
      evidence.evidence_type === 'employee' &&
      evidence.import_id &&
      evidence.row_ordinal != null
    ) {
      const facilityRows = await tx.$queryRaw<Array<{ promoted_facility_id: string | null }>>(
        Prisma.sql`
          SELECT promoted_facility_id::text AS promoted_facility_id
          FROM client_geographic_evidence
          WHERE tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid
            AND import_id = ${evidence.import_id}::uuid
            AND row_ordinal = ${evidence.row_ordinal}
            AND evidence_type = 'facility'
            AND review_status = 'approved'
            AND promoted_facility_id IS NOT NULL
          LIMIT 1
        `,
      );
      const facilityId = facilityRows[0]?.promoted_facility_id;
      const employeeCount = numberOrNull(evidence.numeric_value);
      if (facilityId && employeeCount != null) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE client_facilities
          SET employee_count = ${Math.round(employeeCount)}, updated_at = now()
          WHERE id = ${facilityId}::uuid
            AND tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid
        `);
      }
    }
    return evidence;
  }
}
