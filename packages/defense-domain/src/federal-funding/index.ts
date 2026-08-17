/**
 * Canonical snapshot values, live external observations, and legacy compatibility
 * values may coexist in one response only when separately typed and attributed.
 * They may not be silently aggregated.
 */
export type FundingMeasureProvenanceKind =
  | 'canonical_snapshot'
  | 'live_external'
  | 'legacy_compatibility';

export interface CanonicalSnapshotFundingProvenance {
  readonly kind: 'canonical_snapshot';
  readonly source: string;
  readonly snapshotId: string;
  readonly asOf: string;
}

export interface LiveExternalFundingProvenance {
  readonly kind: 'live_external';
  readonly source: string;
  readonly asOf: string;
  readonly windowMonths?: number;
}

export interface LegacyCompatibilityFundingProvenance {
  readonly kind: 'legacy_compatibility';
  readonly source: string;
  readonly table: string;
  readonly reason: string;
}

export type FundingMeasureProvenance =
  | CanonicalSnapshotFundingProvenance
  | LiveExternalFundingProvenance
  | LegacyCompatibilityFundingProvenance;

export interface AttributedFundingMeasure {
  readonly amountM: number;
  readonly count: number;
  readonly unit: 'USD millions';
  readonly label: string;
  readonly provenance: FundingMeasureProvenance;
}

export class MixedFundingProvenanceError extends Error {
  constructor(readonly kinds: readonly FundingMeasureProvenanceKind[]) {
    super(
      `Refusing to aggregate funding measures across provenance kinds [${[
        ...kinds,
      ].sort().join(', ')}].`,
    );
    this.name = 'MixedFundingProvenanceError';
  }
}

export function sumCompatibleFundingMeasures(
  measures: readonly AttributedFundingMeasure[],
): number {
  const kinds = new Set(measures.map((measure) => measure.provenance.kind));
  if (kinds.size > 1) throw new MixedFundingProvenanceError([...kinds]);
  return measures.reduce((sum, measure) => sum + measure.amountM, 0);
}

export function groupFundingMeasuresByProvenance(
  measures: readonly AttributedFundingMeasure[],
): Readonly<Record<FundingMeasureProvenanceKind, readonly AttributedFundingMeasure[]>> {
  return {
    canonical_snapshot: measures.filter(
      (measure) => measure.provenance.kind === 'canonical_snapshot',
    ),
    live_external: measures.filter((measure) => measure.provenance.kind === 'live_external'),
    legacy_compatibility: measures.filter(
      (measure) => measure.provenance.kind === 'legacy_compatibility',
    ),
  };
}
