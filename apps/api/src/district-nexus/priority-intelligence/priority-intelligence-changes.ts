/**
 * District Nexus Release 4 — deterministic change detector + ledger writer.
 *
 * Compares PERSISTED FACTS against their prior persisted state and writes
 * district_nexus_change rows. Rules:
 *
 *  - Deterministic identity: dedupe_key = sha256(changeKind|source|recordId|
 *    district|boundaryCongress|observedBucket). Re-running the same detection
 *    window is a no-op (idempotent replays).
 *  - Old/new values come from persisted fact rows only — never from "synced_at
 *    changed" or wall-clock heuristics. If only a sync timestamp changed, NO
 *    change is emitted (mission §7 hard rule).
 *  - Old evidence stays explainable: the change row carries the source version,
 *    fiscal year, and geography vintage of BOTH sides in provenance.
 *  - Severity comes from the centrally versioned policy module. No LLM anywhere:
 *    AI may summarize an already-determined change, never create one.
 *  - Global public rows: no tenant fields. Client association happens only at
 *    read time through tenant-scoped evidence.
 *
 * Wired commit entrypoints (Release 4):
 *  - GSA: GsaRealPropertyIngestService.ingest() detects against the prior
 *    persisted FY snapshot and writes ledger rows transactionally after facts
 *    commit (dry runs write zero facts and zero ledger rows).
 *  - CPF/CDS: CommunityFundingUpsertService.upsertMany() emits prior/current
 *    events inside its real ingest transaction; the district-nexus bridge
 *    (createDistrictNexusChangeSink) runs detectCpfCdsChange and persists
 *    through the same transaction — the ledger can never diverge from facts.
 *  - Economic: writeEconomicFacts() (apps/api/scripts/district-economic-source.ts)
 *    looks up the fact's most recent prior-year value inside the same upsert
 *    statement, calls detectEconomicFactChange, and persists any resulting
 *    change through the same transaction as the fact write — same
 *    same-transaction discipline as GSA and CPF/CDS above.
 */

import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  decideChangeSeverity,
  relativeDelta,
  DISTRICT_NEXUS_CHANGE_POLICY_VERSION,
  type DistrictNexusChangeSeverity,
} from './priority-intelligence-change-policy.js';

/** Detection window bucket: daily (UTC) — replays within a bucket dedupe. */
function observedBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function changeDedupeKey(parts: {
  changeKind: string;
  source: string;
  sourceRecordId: string;
  stateCode: string | null;
  districtCode: string | null;
  boundaryCongress: number | null;
  observedBucket: string;
}): string {
  const preimage = [
    parts.changeKind,
    parts.source,
    parts.sourceRecordId,
    parts.stateCode ?? '',
    parts.districtCode ?? '',
    parts.boundaryCongress == null ? '' : String(parts.boundaryCongress),
    parts.observedBucket,
  ].join('|');
  return createHash('sha256').update(preimage, 'utf8').digest('hex').slice(0, 120);
}

export type ChangeObservationKind = 'baseline' | 'change';

export interface DetectedChange {
  changeKind: string;
  source: string;
  sourceDataset: string | null;
  sourceRecordId: string;
  sourceFiscalYear: number | null;
  sourceVersion: string | null;
  stateCode: string | null;
  districtCode: string | null;
  boundaryCongress: number | null;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  oldState: string | null;
  newState: string | null;
  observedAt: Date;
  effectiveAt: Date | null;
  sourceYear: number | null;
  geographyVintage: string | null;
  severity: DistrictNexusChangeSeverity;
  /**
   * 'baseline' marks the first-ever observation of an entire source/year
   * publication (e.g. a fiscal year's whole GSA FRPP file loaded against an
   * empty prior snapshot) — real, source-backed, auditable, but NOT a
   * "recent intelligence change" a user should see crowding out genuine
   * later additions/removals/corrections. 'change' is everything else,
   * including the default for sources with no baseline-flood risk.
   */
  observationKind: ChangeObservationKind;
  provenance: Record<string, unknown>;
}

export interface ChangeDetectionSummary {
  detected: number;
  written: number;
  duplicates: number;
  policyVersion: string;
}

/**
 * Pure change computation for GSA rows: prior persisted snapshot vs current.
 * Exposed for unit tests; the service method persists through writeChanges().
 */
export function detectGsaChanges(params: {
  currentRows: Array<{
    rpUid: string;
    fiscalYear: number;
    stateCode: string | null;
    congressionalDistrict: string | null;
    boundaryCongress: number | null;
    squareFeet: string | null;
    legalInterest: string | null;
    assetStatus: string | null;
    realPropertyUse: string | null;
  }>;
  priorRows: Array<{
    rpUid: string;
    fiscalYear: number;
    stateCode: string | null;
    congressionalDistrict: string | null;
    boundaryCongress: number | null;
    squareFeet: string | null;
    legalInterest: string | null;
    assetStatus: string | null;
    realPropertyUse: string | null;
  }>;
  observedAt: Date;
  sourceDocumentSha256: string;
  fiscalYear: number;
}): DetectedChange[] {
  const changes: DetectedChange[] = [];
  const priorByRpUid = new Map(params.priorRows.map((r) => [r.rpUid, r]));
  // An empty prior snapshot means this publication is the first-ever
  // observation of the whole source/year — every "addition" detected below is
  // baseline population, not a discrete later change. Removals/material
  // changes can only be detected against a NON-empty prior snapshot by
  // construction (they require a prior row to compare against), so they are
  // never baseline.
  const isBaselinePublication = params.priorRows.length === 0;

  for (const current of params.currentRows) {
    const prior = priorByRpUid.get(current.rpUid) as (typeof params.priorRows)[number] | undefined;
    const district = current.congressionalDistrict;
    const vintage =
      current.boundaryCongress == null ? 'source_unknown' : `cd${current.boundaryCongress}`;

    if (!prior) {
      changes.push({
        changeKind: 'gsa_property_added',
        source: 'gsa',
        sourceDataset: 'frpp_public_detailed',
        sourceRecordId: current.rpUid,
        sourceFiscalYear: params.fiscalYear,
        sourceVersion: `frpp_fy${params.fiscalYear}:${params.sourceDocumentSha256.slice(0, 12)}`,
        stateCode: current.stateCode,
        districtCode: district,
        boundaryCongress: current.boundaryCongress,
        oldValue: null,
        newValue: {
          squareFeet: current.squareFeet,
          legalInterest: current.legalInterest,
          assetStatus: current.assetStatus,
          realPropertyUse: current.realPropertyUse,
        },
        oldState: null,
        newState: 'present',
        observedAt: params.observedAt,
        effectiveAt: null,
        sourceYear: params.fiscalYear,
        geographyVintage: vintage,
        severity: decideChangeSeverity('gsa', {
          relativeDelta: null,
          absoluteDelta: null,
          structuralChange: true,
        }).severity,
        observationKind: isBaselinePublication ? 'baseline' : 'change',
        provenance: {
          policyVersion: DISTRICT_NEXUS_CHANGE_POLICY_VERSION,
          sourceDocumentSha256: params.sourceDocumentSha256,
          detection: 'prior persisted snapshot had no row for this rp_uid',
        },
      });
      continue;
    }

    // Material change: square footage delta through the central policy.
    // A change requires an ACTUAL old/new difference: identical values (rel 0)
    // with unchanged legal interest emit nothing — re-published identical
    // content, row-order shuffles and synced_at-only updates are not changes.
    const oldSqft = prior.squareFeet == null ? null : Number(prior.squareFeet);
    const newSqft = current.squareFeet == null ? null : Number(current.squareFeet);
    const sqftChanged = oldSqft != null && newSqft != null && oldSqft !== newSqft;
    const legalChanged = (prior.legalInterest ?? '') !== (current.legalInterest ?? '');
    const statusChanged = (prior.assetStatus ?? '') !== (current.assetStatus ?? '');
    const useChanged = (prior.realPropertyUse ?? '') !== (current.realPropertyUse ?? '');
    if (sqftChanged || legalChanged || statusChanged || useChanged) {
      const rel = relativeDelta(oldSqft, newSqft);
      const decision = decideChangeSeverity('gsa', {
        relativeDelta: rel,
        absoluteDelta: oldSqft != null && newSqft != null ? newSqft - oldSqft : null,
        structuralChange: false,
      });
      changes.push({
        changeKind: 'gsa_property_material_change',
        source: 'gsa',
        sourceDataset: 'frpp_public_detailed',
        sourceRecordId: current.rpUid,
        sourceFiscalYear: params.fiscalYear,
        sourceVersion: `frpp_fy${params.fiscalYear}:${params.sourceDocumentSha256.slice(0, 12)}`,
        stateCode: current.stateCode,
        districtCode: district,
        boundaryCongress: current.boundaryCongress,
        oldValue: {
          squareFeet: prior.squareFeet,
          legalInterest: prior.legalInterest,
          assetStatus: prior.assetStatus,
          realPropertyUse: prior.realPropertyUse,
        },
        newValue: {
          squareFeet: current.squareFeet,
          legalInterest: current.legalInterest,
          assetStatus: current.assetStatus,
          realPropertyUse: current.realPropertyUse,
        },
        oldState: 'present',
        newState: 'present',
        observedAt: params.observedAt,
        effectiveAt: null,
        sourceYear: params.fiscalYear,
        geographyVintage: vintage,
        severity: decision.severity,
        observationKind: 'change',
        provenance: {
          policyVersion: DISTRICT_NEXUS_CHANGE_POLICY_VERSION,
          severityReason: decision.reason,
          sourceDocumentSha256: params.sourceDocumentSha256,
        },
      });
    }
  }

  // Removals: prior snapshot rows absent from the current publication.
  const currentRpUids = new Set(params.currentRows.map((r) => r.rpUid));
  for (const prior of params.priorRows) {
    if (!currentRpUids.has(prior.rpUid)) {
      changes.push({
        changeKind: 'gsa_property_removed',
        source: 'gsa',
        sourceDataset: 'frpp_public_detailed',
        sourceRecordId: prior.rpUid,
        sourceFiscalYear: params.fiscalYear,
        sourceVersion: `frpp_fy${params.fiscalYear}:${params.sourceDocumentSha256.slice(0, 12)}`,
        stateCode: prior.stateCode,
        districtCode: prior.congressionalDistrict,
        boundaryCongress: prior.boundaryCongress,
        oldValue: {
          squareFeet: prior.squareFeet,
          legalInterest: prior.legalInterest,
          assetStatus: prior.assetStatus,
          realPropertyUse: prior.realPropertyUse,
        },
        newValue: null,
        oldState: 'present',
        newState: 'absent',
        observedAt: params.observedAt,
        effectiveAt: null,
        sourceYear: params.fiscalYear,
        geographyVintage:
          prior.boundaryCongress == null ? 'source_unknown' : `cd${prior.boundaryCongress}`,
        severity: decideChangeSeverity('gsa', {
          relativeDelta: null,
          absoluteDelta: null,
          structuralChange: true,
        }).severity,
        observationKind: 'change',
        provenance: {
          policyVersion: DISTRICT_NEXUS_CHANGE_POLICY_VERSION,
          sourceDocumentSha256: params.sourceDocumentSha256,
          detection: 'prior persisted row absent from current publication',
        },
      });
    }
  }

  return changes;
}

/**
 * Pure CPF/CDS change computation between a prior canonical row (if any) and
 * the current row. Amount corrections go through the central cpf_cds policy.
 */
export function detectCpfCdsChange(params: {
  requestId: string;
  chamber: 'house' | 'senate';
  fiscalYear: number;
  stateCode: string | null;
  districtCode: string | null;
  requesterName: string;
  prior: {
    requestedAmountUsd: string | null;
    finalAmountUsd: string | null;
    amountStageRaw: string;
  } | null;
  current: { requestedAmountUsd: string; finalAmountUsd: string | null; amountStageRaw: string };
  observedAt: Date;
}): DetectedChange[] {
  const { prior, current } = params;
  // Geography vintage must be source-backed. The CPF/CDS source publishes
  // district numbers but NEVER a boundary congress (same as the FRPP district
  // column), so the vintage is 'source_unknown' — claiming a specific congress
  // (e.g. cd119) would be an inference, and House CPF rows are DISTRICT
  // attributed, not state attributed. Senate statewide rows (districtCode
  // null) make no district geography claim at all → null vintage.
  const vintage = params.districtCode ? 'source_unknown' : null;

  if (!prior) {
    return [
      {
        changeKind: 'cpf_cds_request_new',
        source: params.chamber === 'house' ? 'cpf' : 'cds',
        sourceDataset: 'community_funding_request',
        sourceRecordId: params.requestId,
        sourceFiscalYear: params.fiscalYear,
        sourceVersion: null,
        stateCode: params.stateCode,
        districtCode: params.districtCode,
        boundaryCongress: null,
        oldValue: null,
        newValue: {
          requesterName: params.requesterName,
          requestedAmountUsd: current.requestedAmountUsd,
          finalAmountUsd: current.finalAmountUsd,
          amountStageRaw: current.amountStageRaw,
        },
        oldState: null,
        newState: 'requested',
        observedAt: params.observedAt,
        effectiveAt: null,
        sourceYear: params.fiscalYear,
        geographyVintage: vintage,
        severity: decideChangeSeverity('cpf_cds', {
          relativeDelta: null,
          absoluteDelta: null,
          structuralChange: true,
        }).severity,
        // CPF/CDS has no documented single-day bulk-backfill flood risk like
        // GSA's whole-file annual publication — every new canonical request is
        // a genuine, individually-sourced event, so it is never baseline.
        observationKind: 'change',
        provenance: {
          policyVersion: DISTRICT_NEXUS_CHANGE_POLICY_VERSION,
          chamber: params.chamber,
          amountSemantics: 'requested_not_awarded',
        },
      },
    ];
  }

  // Amount/stage correction: only when a persisted VALUE actually changed.
  const oldReq = prior.requestedAmountUsd == null ? null : Number(prior.requestedAmountUsd);
  const newReq = current.requestedAmountUsd == null ? null : Number(current.requestedAmountUsd);
  const stageChanged = prior.amountStageRaw !== current.amountStageRaw;
  const rel = relativeDelta(oldReq, newReq);
  if (oldReq === newReq && !stageChanged) {
    return []; // only synced_at-style metadata would have changed → no change
  }
  const decision = decideChangeSeverity('cpf_cds', {
    relativeDelta: rel,
    absoluteDelta: oldReq != null && newReq != null ? newReq - oldReq : null,
    structuralChange: false,
  });
  return [
    {
      changeKind: 'cpf_cds_amount_stage_correction',
      source: params.chamber === 'house' ? 'cpf' : 'cds',
      sourceDataset: 'community_funding_request',
      sourceRecordId: params.requestId,
      sourceFiscalYear: params.fiscalYear,
      sourceVersion: null,
      stateCode: params.stateCode,
      districtCode: params.districtCode,
      boundaryCongress: null,
      oldValue: {
        requestedAmountUsd: prior.requestedAmountUsd,
        finalAmountUsd: prior.finalAmountUsd,
        amountStageRaw: prior.amountStageRaw,
      },
      newValue: {
        requestedAmountUsd: current.requestedAmountUsd,
        finalAmountUsd: current.finalAmountUsd,
        amountStageRaw: current.amountStageRaw,
      },
      oldState: prior.amountStageRaw,
      newState: current.amountStageRaw,
      observedAt: params.observedAt,
      effectiveAt: null,
      sourceYear: params.fiscalYear,
      geographyVintage: vintage,
      severity: decision.severity,
      observationKind: 'change',
      provenance: {
        policyVersion: DISTRICT_NEXUS_CHANGE_POLICY_VERSION,
        severityReason: decision.reason,
        amountSemantics: 'requested_not_awarded',
      },
    },
  ];
}

/**
 * Pure year-over-year economic-fact change computation (durable old/new values
 * for the same metric identity). Returns [] when either side is missing.
 */
export function detectEconomicFactChange(params: {
  source: string;
  dataset: string;
  stateCode: string;
  districtCode: string;
  metricKey: string;
  naicsCode: string | null;
  priorYear: number;
  priorValue: string | null;
  currentYear: number;
  currentValue: string | null;
  observedAt: Date;
}): DetectedChange[] {
  if (params.priorValue == null || params.currentValue == null) return [];
  const oldV = Number(params.priorValue);
  const newV = Number(params.currentValue);
  if (!Number.isFinite(oldV) || !Number.isFinite(newV)) return [];
  const rel = relativeDelta(oldV, newV);
  if (rel == null || Math.abs(rel) < 0.02) return []; // below minimum reportable delta
  const decision = decideChangeSeverity('sector', {
    relativeDelta: rel,
    absoluteDelta: newV - oldV,
    structuralChange: false,
  });
  return [
    {
      changeKind: 'economic_fact_material_change',
      source: params.source,
      sourceDataset: params.dataset,
      sourceRecordId: `${params.stateCode}-${params.districtCode}:${params.metricKey}${params.naicsCode ? `:${params.naicsCode}` : ''}`,
      sourceFiscalYear: params.currentYear,
      sourceVersion: null,
      stateCode: params.stateCode,
      districtCode: params.districtCode,
      boundaryCongress: null,
      oldValue: { sourceYear: params.priorYear, value: params.priorValue },
      newValue: { sourceYear: params.currentYear, value: params.currentValue },
      oldState: 'present',
      newState: 'present',
      observedAt: params.observedAt,
      effectiveAt: null,
      sourceYear: params.currentYear,
      geographyVintage: 'source_vintage_per_year',
      severity: decision.severity,
      // Year-over-year comparison requires a real prior value (line ~409
      // returns [] otherwise), so a first-ever vintage can never reach here —
      // always a genuine change, never baseline.
      observationKind: 'change',
      provenance: {
        policyVersion: DISTRICT_NEXUS_CHANGE_POLICY_VERSION,
        severityReason: decision.reason,
        metricKey: params.metricKey,
        naicsCode: params.naicsCode,
      },
    },
  ];
}

export class DistrictNexusChangeWriter {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent write: dedupe_key conflicts are counted, not rewritten.
   *
   * `client` lets callers participate in an ALREADY-OPEN transaction (the
   * canonical CPF/CDS ingest transaction, or the GSA ingest service's chunk
   * transactions) so the ledger row commits atomically with its fact row.
   * Defaults to the service's own Prisma connection. A raw PrismaClient
   * (scripts convention) satisfies the same structural shape.
   */
  async writeChanges(
    changes: DetectedChange[],
    client: Pick<Prisma.TransactionClient, 'districtNexusChange'> = this.prisma as unknown as Pick<
      Prisma.TransactionClient,
      'districtNexusChange'
    >,
  ): Promise<ChangeDetectionSummary> {
    let written = 0;
    let duplicates = 0;
    for (const change of changes) {
      const dedupeKey = changeDedupeKey({
        changeKind: change.changeKind,
        source: change.source,
        sourceRecordId: change.sourceRecordId,
        stateCode: change.stateCode,
        districtCode: change.districtCode,
        boundaryCongress: change.boundaryCongress,
        observedBucket: observedBucket(change.observedAt),
      });
      const existing = await client.districtNexusChange.findUnique({ where: { dedupeKey } });
      if (existing) {
        duplicates += 1;
        continue;
      }
      await client.districtNexusChange.create({
        data: {
          dedupeKey,
          changeKind: change.changeKind,
          source: change.source,
          sourceDataset: change.sourceDataset,
          sourceRecordId: change.sourceRecordId,
          sourceFiscalYear: change.sourceFiscalYear,
          sourceVersion: change.sourceVersion,
          stateCode: change.stateCode,
          districtCode: change.districtCode,
          boundaryCongress: change.boundaryCongress,
          oldValue: (change.oldValue ?? undefined) as Prisma.InputJsonValue | undefined,
          newValue: (change.newValue ?? undefined) as Prisma.InputJsonValue | undefined,
          oldState: change.oldState,
          newState: change.newState,
          observedAt: change.observedAt,
          effectiveAt: change.effectiveAt,
          sourceYear: change.sourceYear,
          geographyVintage: change.geographyVintage,
          severity: change.severity,
          observationKind: change.observationKind,
          provenance: change.provenance as Prisma.InputJsonValue,
        },
      });
      written += 1;
    }
    return {
      detected: changes.length,
      written,
      duplicates,
      policyVersion: DISTRICT_NEXUS_CHANGE_POLICY_VERSION,
    };
  }
}
