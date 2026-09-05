/**
 * District Nexus Release 4 — deterministic change materiality policy.
 *
 * Centrally versioned (plan §7.1/§8.4 discipline): severity decisions live ONLY
 * here. The detector computes old/new pairs; this policy decides whether a
 * change is worth surfacing and at what severity. An LLM may summarize an
 * already-determined change but can never create, alter, or classify one.
 *
 * IMPORTANT: policy inputs are ONLY the deterministic old/new values and their
 * source metadata. No timestamp heuristics, no "synced_at changed" triggers.
 */

export const DISTRICT_NEXUS_CHANGE_POLICY_VERSION = 'district-nexus-change-policy-v1';

/** Valid severity vocabulary — mirrors the migration CHECK constraint. */
export type DistrictNexusChangeSeverity = 'info' | 'notable' | 'material';

export interface ChangeSeverityInput {
  /** Relative/percent magnitude of the numeric change, when both sides are numeric. */
  relativeDelta: number | null;
  /** Absolute change (source units). */
  absoluteDelta: number | null;
  /** Old and/or new state is null (addition/removal rather than modification). */
  structuralChange: boolean;
}

export interface ChangeSeverityDecision {
  severity: DistrictNexusChangeSeverity;
  /** Human-auditable reason recorded in provenance. */
  reason: string;
}

/**
 * Materiality floors by signal family. A change below the floor is still
 * recorded (deterministic identity) but marked `info` so consumers can filter.
 * Thresholds are initial test values — tune only by editing this file and
 * bumping DISTRICT_NEXUS_CHANGE_POLICY_VERSION.
 */
export const MATERIALITY_THRESHOLDS = Object.freeze({
  /** CPF/CDS: any stage correction or amount correction >= 1% is notable; >= 25% material. */
  cpfCdsAmountNotableRelative: 0.01,
  cpfCdsAmountMaterialRelative: 0.25,
  /** Sector metrics (jobs/establishments/payroll): >= 5% notable, >= 30% material. */
  sectorMetricNotableRelative: 0.05,
  sectorMetricMaterialRelative: 0.3,
  /** GSA square footage: >= 10% notable, >= 50% material. */
  gsaSquareFeetNotableRelative: 0.1,
  gsaSquareFeetMaterialRelative: 0.5,
});

/** Minimum source-relative magnitude for a sector metric to count as a change at all. */
export const SECTOR_METRIC_MIN_RELATIVE_DELTA = 0.02;

export function decideChangeSeverity(
  family: 'cpf_cds' | 'gsa' | 'sector',
  input: ChangeSeverityInput,
): ChangeSeverityDecision {
  const t = MATERIALITY_THRESHOLDS;

  if (input.structuralChange) {
    // Addition / removal of a tracked subject is inherently notable; new
    // CPF/CDS requests and GSA asset add/remove are the point of the ledger.
    return {
      severity: family === 'cpf_cds' ? 'notable' : 'material',
      reason: 'structural addition/removal of a tracked subject',
    };
  }

  const rel = input.relativeDelta;
  if (rel == null) {
    return { severity: 'info', reason: 'no comparable numeric values on both sides' };
  }

  const magnitude = Math.abs(rel);
  const [notableAt, materialAt] =
    family === 'cpf_cds'
      ? [t.cpfCdsAmountNotableRelative, t.cpfCdsAmountMaterialRelative]
      : family === 'gsa'
        ? [t.gsaSquareFeetNotableRelative, t.gsaSquareFeetMaterialRelative]
        : [t.sectorMetricNotableRelative, t.sectorMetricMaterialRelative];

  if (magnitude >= materialAt) {
    return {
      severity: 'material',
      reason: `relative change ${rel.toFixed(4)} >= material floor ${materialAt}`,
    };
  }
  if (magnitude >= notableAt) {
    return {
      severity: 'notable',
      reason: `relative change ${rel.toFixed(4)} >= notable floor ${notableAt}`,
    };
  }
  return {
    severity: 'info',
    reason: `relative change ${rel.toFixed(4)} below notable floor ${notableAt}`,
  };
}

/**
 * Relative delta helper. Returns null when a ratio cannot be honestly formed
 * (missing side, zero base). Never fabricates a percentage from a zero base.
 */
export function relativeDelta(oldValue: number | null, newValue: number | null): number | null {
  if (oldValue == null || newValue == null) return null;
  if (oldValue === 0) return null;
  return (newValue - oldValue) / Math.abs(oldValue);
}
