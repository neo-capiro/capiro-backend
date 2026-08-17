/**
 * Phase 7 Workstream M — reading the active snapshot.
 *
 * Ports, the one-snapshot invariant, and the resolver. No Prisma and no Nest, so
 * Phase 8 can move the read path into its own service without touching any of
 * this and so the invariant below is testable without a database.
 */
import type { DefenseBudgetManualOverrideV1 } from './manual-override-v1.js';

/** The activation pointer, as a read needs it. */
export interface ActiveSnapshotV1 {
  snapshotId: string;
  domain: string;
  environment: string;
  status: string;
  activatedAt: string | null;
  snapshotHash: string | null;
}

/** Money as the read path carries it: exact, and never a JavaScript number. */
export interface SnapshotMoneyV1 {
  originalValue: string;
  originalUnit: string;
  valueMillions: string;
}

/** One canonical row, projected for reading. */
export interface SnapshotCanonicalRowV1 {
  snapshotId: string;
  canonicalEntity: string;
  canonicalNaturalKey: string;
  parentNaturalKey: string | null;
  family: string;
  fiscalYear: number | null;
  fundingField: string | null;
  stage: string | null;
  canonicalRowHash: string;
  money: SnapshotMoneyV1 | null;
  quantity: string | null;
  unitCostDollars: string | null;
  textValue: string | null;
  dateValue: string | null;
  attributes: Record<string, unknown>;
  directOrDerived: string;
  lineage: {
    sourceProjectionId: string;
    verificationCandidateId: string;
    verificationRunId: string;
    artifactId: string;
    sourceDocumentId: string;
    enactmentProofId: string | null;
  };
}

export interface SnapshotRowQueryV1 {
  snapshotId: string;
  canonicalEntity?: string;
  canonicalEntities?: readonly string[];
  family?: string;
  naturalKeys?: readonly string[];
  parentNaturalKey?: string;
  fiscalYears?: readonly number[];
  fundingFields?: readonly string[];
  limit?: number;
}

export interface SnapshotReadPortV1 {
  loadActiveSnapshot(domain: string, environment: string): Promise<ActiveSnapshotV1 | null>;
  loadRows(query: SnapshotRowQueryV1): Promise<SnapshotCanonicalRowV1[]>;
  /**
   * Load every governed override version whose target exactly matches one of
   * these already-selected canonical rows. Optional only for narrow test/Phase8
   * adapters; the production Prisma port implements it. Keeping this beside the
   * row port prevents each product endpoint from inventing its own override
   * query and, critically, avoids a broad entity/FY query that could mix an
   * override for a different PE into this response.
   */
  loadManualOverridesForRows?(
    rows: readonly SnapshotCanonicalRowV1[],
  ): Promise<DefenseBudgetManualOverrideV1[]>;
}

/** A response was about to carry rows from more than one snapshot. */
export class SnapshotMixError extends Error {
  constructor(
    readonly expectedSnapshotId: string,
    readonly foundSnapshotIds: string[],
  ) {
    super(
      `snapshot mix: expected every row in ${expectedSnapshotId}, found ${foundSnapshotIds.join(', ')}`,
    );
    this.name = 'SnapshotMixError';
  }
}

export function assertOneSnapshotV1(
  rows: readonly SnapshotCanonicalRowV1[],
  expectedSnapshotId: string,
): readonly SnapshotCanonicalRowV1[] {
  const foreign = new Set<string>();
  for (const row of rows) {
    if (row.snapshotId !== expectedSnapshotId) foreign.add(row.snapshotId);
  }
  if (foreign.size > 0) throw new SnapshotMixError(expectedSnapshotId, [...foreign].sort());
  return rows;
}

export interface SnapshotProvenanceV1 {
  activeSnapshotId: string;
  lastActivatedAt: string | null;
  snapshotHash: string | null;
  overridesApplied: number;
}

export function snapshotProvenanceV1(
  active: ActiveSnapshotV1,
  overridesApplied = 0,
): SnapshotProvenanceV1 {
  return {
    activeSnapshotId: active.snapshotId,
    lastActivatedAt: active.activatedAt,
    snapshotHash: active.snapshotHash,
    overridesApplied,
  };
}

export interface ActiveSnapshotResolverV1 {
  resolve(): Promise<ActiveSnapshotV1 | null>;
  resolved(): boolean;
}

export function createActiveSnapshotResolverV1(
  port: SnapshotReadPortV1,
  domain: string,
  environment: string,
): ActiveSnapshotResolverV1 {
  let pending: Promise<ActiveSnapshotV1 | null> | null = null;
  let seen = false;
  return {
    async resolve() {
      pending ??= port.loadActiveSnapshot(domain, environment).then((value) => {
        seen = value != null;
        return value;
      });
      return pending;
    },
    resolved() {
      return seen;
    },
  };
}
