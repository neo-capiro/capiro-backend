/**
 * District Nexus Release 4 — GSA FRPP ingestion service.
 *
 * Deterministic, idempotent upsert of FRPP public-dataset asset rows plus an
 * append-only source-run audit. Dry runs validate every row and record the run
 * but write ZERO fact rows (DB CHECK `gsa_real_property_source_run_dry_run_zero_writes`
 * enforces the same invariant at the storage layer).
 *
 * Identity: SHA-256 over canonical JSON of
 * (sourceDocumentSha256, rpUid, fiscalYear, boundaryCongress, assetStatusCode).
 * Re-running the same document = no-op (rows_skipped_duplicate). A corrected
 * re-publication carries a new document SHA → new rows (history preserved);
 * change detection runs off the (rp_uid, fiscal_year) window, not off row count.
 *
 * Change ledger (Release 4): when a DistrictNexusChangeWriter is provided,
 * every committed run also feeds district_nexus_change:
 *  - Each newly created fact row gets its gsa_property_added ledger row written
 *    in the SAME chunk transaction (atomic — the ledger can never gain a row
 *    whose fact row did not commit).
 *  - Material changes (same rp_uid, changed sqft/interest/status/use) and
 *    removals (prior persisted rows absent from the current publication) are
 *    computed against the PRE-RUN persisted snapshot and written after all
 *    chunks commit. Residual window, documented honestly: a crash after the
 *    last chunk but before that final ledger write would lose those rows until
 *    the next publication of the same fiscal year re-detects them (dedupe keys
 *    keep the retry idempotent). Dry runs write zero facts and zero ledger rows.
 *
 * No recurring schedule exists for this rail; the only entrypoint is the
 * bounded manual runner script (`sync-gsa-frpp.ts`).
 */

import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { FrppRawRow } from './priority-intelligence-gsa-frpp-parser.js';
import { frppIdentityPreimage } from './priority-intelligence-gsa-frpp-parser.js';
import {
  detectGsaChanges,
  DistrictNexusChangeWriter,
  type ChangeDetectionSummary,
  type DetectedChange,
} from './priority-intelligence-changes.js';
import {
  decideChangeSeverity,
  DISTRICT_NEXUS_CHANGE_POLICY_VERSION,
} from './priority-intelligence-change-policy.js';

/** Minimal prior-snapshot projection used for change detection. */
interface GsaPriorRow {
  rpUid: string;
  fiscalYear: number;
  stateCode: string | null;
  congressionalDistrict: string | null;
  boundaryCongress: number | null;
  squareFeet: string | null;
  legalInterest: string | null;
  assetStatus: string | null;
  realPropertyUse: string | null;
}

export interface GsaIngestOptions {
  sourceDataset: string;
  fiscalYear: number;
  sourceDocumentSha256: string;
  sourceUrl: string | null;
  dryRun: boolean;
  rows: FrppRawRow[];
  warnings: string[];
  metadata?: Record<string, unknown>;
}

export interface GsaIngestResult {
  runId: string;
  dryRun: boolean;
  status: 'success' | 'success_with_errors' | 'failed' | 'unavailable';
  rowsSeen: number;
  rowsWritten: number;
  rowsRejected: number;
  rowsSkippedDuplicate: number;
  /** Ledger summary when change detection ran; null for dry runs / no writer. */
  changes: ChangeDetectionSummary | null;
}

export function gsaSourceHash(parts: {
  sourceDocumentSha256: string;
  rpUid: string;
  fiscalYear: number;
  boundaryCongress: number | null;
  assetStatusCode: string | null;
}): string {
  return createHash('sha256').update(frppIdentityPreimage(parts), 'utf8').digest('hex');
}

export class GsaRealPropertyIngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changeWriter?: DistrictNexusChangeWriter,
  ) {}

  async ingest(options: GsaIngestOptions): Promise<GsaIngestResult> {
    const run = await this.prisma.gsaRealPropertySourceRun.create({
      data: {
        sourceDataset: options.sourceDataset,
        fiscalYear: options.fiscalYear,
        sourceDocumentSha256: options.sourceDocumentSha256,
        sourceUrl: options.sourceUrl,
        dryRun: options.dryRun,
        status: 'running',
        metadataJsonb: {
          warnings: options.warnings,
          row_count_input: options.rows.length,
          ...(options.metadata ?? {}),
        },
      },
    });

    try {
      let written = 0;
      let rejected = 0;
      let skipped = 0;
      // Aggregated ledger summary across ALL writeChanges calls (chunk
      // additions AND post-loop material/removals) so callers see one honest
      // total. Null for dry runs / when no writer is configured.
      const changeRailActive = this.changeWriter != null && !options.dryRun;
      let changes: ChangeDetectionSummary | null = changeRailActive
        ? {
            detected: 0,
            written: 0,
            duplicates: 0,
            policyVersion: DISTRICT_NEXUS_CHANGE_POLICY_VERSION,
          }
        : null;
      const mergeSummary = (summary: ChangeDetectionSummary): void => {
        changes = {
          detected: changes!.detected + summary.detected,
          written: changes!.written + summary.written,
          duplicates: changes!.duplicates + summary.duplicates,
          policyVersion: summary.policyVersion,
        };
      };

      // Change-detection baseline: the persisted FY snapshot BEFORE this run's
      // writes. Additions are detected per-row during ingest; material changes
      // and removals are computed after all chunks commit.
      const priorByRpUid = options.dryRun
        ? new Map<string, GsaPriorRow>()
        : await this.loadPriorSnapshot(options.fiscalYear);

      // Chunked deterministic processing; each row's identity is content-derived.
      const CHUNK = 500;
      for (let i = 0; i < options.rows.length; i += CHUNK) {
        const chunk = options.rows.slice(i, i + CHUNK);
        const prepared: Array<{ hash: string; row: FrppRawRow }> = [];
        for (const row of chunk) {
          const hash = gsaSourceHash({
            sourceDocumentSha256: options.sourceDocumentSha256,
            rpUid: row.rpUid,
            fiscalYear: options.fiscalYear,
            boundaryCongress: row.boundaryCongress,
            assetStatusCode: row.assetStatusCode,
          });
          prepared.push({ hash, row });
        }

        if (options.dryRun) {
          // Validate-only: nothing written by construction.
          continue;
        }

        // Per-chunk ledger rows accumulate here and are written in the SAME
        // transaction as the chunk's fact rows (atomic commit or rollback).
        const chunkAdditions: DetectedChange[] = [];

        await this.prisma.$transaction(async (tx) => {
          for (const { hash, row } of prepared) {
            const existing = await tx.gsaRealProperty.findUnique({ where: { sourceHash: hash } });
            if (existing) {
              skipped += 1;
              continue;
            }
            await tx.gsaRealProperty.create({
              data: {
                sourceHash: hash,
                sourceDocumentSha256: options.sourceDocumentSha256,
                sourceDataset: options.sourceDataset,
                fiscalYear: options.fiscalYear,
                retrievedAt: new Date(),
                rpUid: row.rpUid,
                reportingAgency: row.reportingAgency,
                reportingAgencyCode: row.reportingAgencyCode,
                usingAgency: row.usingAgency,
                bureau: row.bureau,
                installationName: row.installationName,
                installationId: row.installationId,
                grain: row.grain,
                isDefense: row.isDefense,
                usOrForeign: row.usOrForeign,
                countryName: row.countryName,
                stateCode: row.stateCode,
                stateName: row.stateName,
                countyName: row.countyName,
                cityName: row.cityName,
                zipCode: row.zipCode,
                streetAddress: row.streetAddress,
                latitude: row.latitude,
                longitude: row.longitude,
                geographyBasis: row.geographyBasis,
                legalInterest: row.legalInterest,
                realPropertyType: row.realPropertyType,
                realPropertyUse: row.realPropertyUse,
                utilization: row.utilization,
                assetStatus: row.assetStatus,
                assetStatusCode: row.assetStatusCode,
                historicalStatus: row.historicalStatus,
                squareFeet: row.squareFeet,
                squareFeetUom: row.squareFeetUom,
                congressionalDistrict: row.congressionalDistrict,
                boundaryCongress: row.boundaryCongress,
                districtSource: row.congressionalDistrict ? 'source_reported' : 'unresolved',
                congressionalDistrictSourceUrl: options.sourceUrl,
                congressSession: row.congressSession,
                leaseExpirationDate: row.leaseExpirationDate,
                leaseStartDate: row.leaseStartDate,
                annualRentUsd: row.annualRentUsd,
                federalEmployeesCount:
                  row.federalEmployeesCount == null ? null : Math.trunc(row.federalEmployeesCount),
                federalContractorsCount:
                  row.federalContractorsCount == null
                    ? null
                    : Math.trunc(row.federalContractorsCount),
              },
            });
            written += 1;
            // Release 4 change rail: this row is genuinely NEW (no prior
            // persisted row for the rp_uid) → gsa_property_added, written in
            // the same chunk transaction. Rows whose rp_uid existed before are
            // NOT changes (corrected re-publication adds a new fact row with a
            // new document SHA; the VALUE diff is handled post-commit below).
            if (this.changeWriter && !priorByRpUid.has(row.rpUid)) {
              chunkAdditions.push({
                changeKind: 'gsa_property_added',
                source: 'gsa',
                sourceDataset: options.sourceDataset,
                sourceRecordId: row.rpUid,
                sourceFiscalYear: options.fiscalYear,
                sourceVersion: `frpp_fy${options.fiscalYear}:${options.sourceDocumentSha256.slice(0, 12)}`,
                stateCode: row.stateCode,
                districtCode: row.congressionalDistrict,
                boundaryCongress: row.boundaryCongress,
                oldValue: null,
                newValue: {
                  squareFeet: row.squareFeet == null ? null : String(row.squareFeet),
                  legalInterest: row.legalInterest,
                  assetStatus: row.assetStatus,
                  realPropertyUse: row.realPropertyUse,
                },
                oldState: null,
                newState: 'present',
                observedAt: new Date(),
                effectiveAt: null,
                sourceYear: options.fiscalYear,
                geographyVintage:
                  row.boundaryCongress == null ? 'source_unknown' : `cd${row.boundaryCongress}`,
                severity: decideChangeSeverity('gsa', {
                  relativeDelta: null,
                  absoluteDelta: null,
                  structuralChange: true,
                }).severity,
                provenance: {
                  policyVersion: DISTRICT_NEXUS_CHANGE_POLICY_VERSION,
                  sourceDocumentSha256: options.sourceDocumentSha256,
                  detection: 'prior persisted snapshot had no row for this rp_uid',
                  sourceRunId: run.id,
                },
              });
            }
          }
          if (chunkAdditions.length > 0) {
            if (!this.changeWriter) {
              throw new Error(
                'change-writer invariant violated: additions detected without a DistrictNexusChangeWriter',
              );
            }
            mergeSummary(await this.changeWriter.writeChanges(chunkAdditions, tx));
          }
        });
      }

      // Material changes + removals: computed against the pre-run snapshot for
      // rp_uids that ALREADY existed. Identical re-publication emits nothing.
      if (this.changeWriter && !options.dryRun && priorByRpUid.size > 0) {
        const currentRows = options.rows.map((row) => ({
          rpUid: row.rpUid,
          fiscalYear: options.fiscalYear,
          stateCode: row.stateCode,
          congressionalDistrict: row.congressionalDistrict,
          boundaryCongress: row.boundaryCongress,
          squareFeet: row.squareFeet == null ? null : String(row.squareFeet),
          legalInterest: row.legalInterest,
          assetStatus: row.assetStatus,
          realPropertyUse: row.realPropertyUse,
        }));
        const detected = detectGsaChanges({
          currentRows,
          priorRows: [...priorByRpUid.values()],
          observedAt: new Date(),
          sourceDocumentSha256: options.sourceDocumentSha256,
          fiscalYear: options.fiscalYear,
        }).filter((change) => change.changeKind !== 'gsa_property_added');
        if (detected.length > 0) {
          mergeSummary(await this.changeWriter.writeChanges(detected));
        }
      }

      // Parse-level rejections arrive via metadata.rejectionCount (the parser
      // owns rejection reasons); they are real source rows that never became
      // facts, so the run row must record them as rows_rejected — never 0.
      const parseRejections =
        typeof options.metadata?.['rejectionCount'] === 'number'
          ? (options.metadata['rejectionCount'] as number)
          : 0;
      const status: GsaIngestResult['status'] =
        options.warnings.length || parseRejections > 0 ? 'success_with_errors' : 'success';

      await this.prisma.gsaRealPropertySourceRun.update({
        where: { id: run.id },
        data: {
          status,
          completedAt: new Date(),
          rowsSeen: options.rows.length + parseRejections,
          rowsWritten: options.dryRun ? 0 : written,
          rowsRejected: parseRejections,
          rowsSkippedDuplicate: options.dryRun ? 0 : skipped,
        },
      });

      return {
        runId: run.id,
        dryRun: options.dryRun,
        status,
        rowsSeen: options.rows.length + parseRejections,
        rowsWritten: options.dryRun ? 0 : written,
        rowsRejected: rejected,
        rowsSkippedDuplicate: options.dryRun ? 0 : skipped,
        changes,
      };
    } catch (error) {
      await this.prisma.gsaRealPropertySourceRun
        .update({
          where: { id: run.id },
          data: {
            status: 'failed',
            completedAt: new Date(),
            error:
              error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
          },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * Persisted FY snapshot BEFORE this run's writes — the detection baseline.
   * When a corrected re-publication left multiple fact rows for one rp_uid
   * (history is preserved), the LATEST row wins deterministically (retrievedAt
   * DESC, then id DESC) — otherwise a re-run of an identical document could
   * compare against a stale row and emit a spurious change on a later day.
   */
  private async loadPriorSnapshot(fiscalYear: number): Promise<Map<string, GsaPriorRow>> {
    const rows = await this.prisma.gsaRealProperty.findMany({
      where: { fiscalYear },
      orderBy: [{ retrievedAt: 'desc' }, { id: 'desc' }],
      select: {
        rpUid: true,
        fiscalYear: true,
        stateCode: true,
        congressionalDistrict: true,
        boundaryCongress: true,
        squareFeet: true,
        legalInterest: true,
        assetStatus: true,
        realPropertyUse: true,
      },
    });
    const map = new Map<string, GsaPriorRow>();
    for (const row of rows) {
      if (map.has(row.rpUid)) continue; // latest row already captured
      map.set(row.rpUid, {
        rpUid: row.rpUid,
        fiscalYear: row.fiscalYear,
        stateCode: row.stateCode,
        congressionalDistrict: row.congressionalDistrict,
        boundaryCongress: row.boundaryCongress,
        squareFeet: row.squareFeet == null ? null : String(row.squareFeet),
        legalInterest: row.legalInterest,
        assetStatus: row.assetStatus,
        realPropertyUse: row.realPropertyUse,
      });
    }
    return map;
  }
}
