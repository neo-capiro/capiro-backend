/**
 * Phase 7 Workstream M — reading the active snapshot.
 *
 * Ports, the one-snapshot invariant, and the resolver. No Prisma and no Nest, so
 * Phase 8 can move the read path into its own service without touching any of
 * this and so the invariant below is testable without a database.
 *
 * ---------------------------------------------------------------------------
 * The resolver caches, and that is the guarantee
 * ---------------------------------------------------------------------------
 *
 * "One response never mixes snapshots" (cross-workstream invariant 22) is not
 * satisfied by writing careful queries. A PE profile issues several reads —
 * identity, funding positions, projects, performers, sources — and an activation
 * committing between the first and the last would hand the caller half of one
 * annual cycle and half of another, each read individually correct.
 *
 * So the pointer is resolved **once per request** and every subsequent read is
 * scoped to that snapshot id. The activation transaction is a single small
 * commit, so this closes the window entirely rather than narrowing it: a read
 * either sees the whole old snapshot or the whole new one.
 *
 * `assertOneSnapshotV1` is the belt to that braces. Scoping by snapshot id
 * should make a foreign row impossible; if one appears anyway — a mistaken join,
 * a future family repository that forgets the scope — it must fail loudly rather
 * than be served, because a silently mixed response is indistinguishable from a
 * correct one to the person reading it.
 */

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

/**
 * Refuse a row set that is not wholly inside one snapshot.
 *
 * Returns the rows so it can be used inline at the point of assembly, which is
 * where it is worth the call — a guard sitting somewhere a developer has to
 * remember to invoke is not a guard.
 */
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

/**
 * The additive provenance a snapshot-served response may carry (plan §M.6).
 *
 * Additive only: no existing field changes shape, so an existing client that
 * ignores this object sees the contract it already had. It exists because
 * "which annual cycle is this number from" is otherwise unanswerable from a
 * response, and after cutover that question has a real answer worth exposing.
 */
export interface SnapshotProvenanceV1 {
  activeSnapshotId: string;
  lastActivatedAt: string | null;
  snapshotHash: string | null;
  /** How many values in this response are a governed human override. */
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

/**
 * Resolves the active pointer once and remembers the answer.
 *
 * Construct one per request. Deliberately not a singleton: a process-lifetime
 * cache would keep serving a superseded snapshot after an activation, which is
 * the opposite failure — stale rather than mixed, and much harder to notice.
 */
export interface ActiveSnapshotResolverV1 {
  resolve(): Promise<ActiveSnapshotV1 | null>;
  /** True once `resolve` has been called and returned a pointer. */
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
      // The promise is cached, not the value, so concurrent reads inside one
      // request share a single round trip and therefore a single answer.
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
