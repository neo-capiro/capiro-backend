/**
 * Phase 7 Workstream M — the read port, the resolver, and the one-snapshot
 * invariant.
 *
 * The invariant is the reason this file exists. "One response never mixes
 * snapshots" is a claim about assembly, not about any single query, so it has to
 * be tested where assembly happens.
 */
import {
  assertOneSnapshotV1,
  createActiveSnapshotResolverV1,
  snapshotProvenanceV1,
  SnapshotMixError,
  type ActiveSnapshotV1,
  type SnapshotCanonicalRowV1,
  type SnapshotReadPortV1,
} from './snapshot-read-repository-v1.js';
import { buildSnapshotRowSqlV1 } from './snapshot-read-repository-prisma-v1.js';

const SNAP_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SNAP_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function row(overrides: Partial<SnapshotCanonicalRowV1> = {}): SnapshotCanonicalRowV1 {
  return {
    snapshotId: SNAP_A,
    canonicalEntity: 'canonical_om_sag_year',
    canonicalNaturalKey: 'ARMY|OMA|SAG-1|2027|request',
    parentNaturalKey: 'ARMY|OMA|SAG-1',
    family: 'om',
    fiscalYear: 2027,
    fundingField: 'request',
    stage: null,
    canonicalRowHash: 'a'.repeat(64),
    money: { originalValue: '1250', originalUnit: 'thousands', valueMillions: '1.25' },
    quantity: null,
    unitCostDollars: null,
    textValue: null,
    dateValue: null,
    attributes: {},
    directOrDerived: 'direct',
    lineage: {
      sourceProjectionId: 'proj-1',
      verificationCandidateId: 'cand-1',
      verificationRunId: 'run-1',
      artifactId: 'artifact-1',
      sourceDocumentId: 'doc-1',
      enactmentProofId: null,
    },
    ...overrides,
  };
}

function active(overrides: Partial<ActiveSnapshotV1> = {}): ActiveSnapshotV1 {
  return {
    snapshotId: SNAP_A,
    domain: 'defense_budget',
    environment: 'prod',
    status: 'ACTIVE',
    activatedAt: '2026-08-07T12:00:00.000Z',
    snapshotHash: 'b'.repeat(64),
    ...overrides,
  };
}

describe('Phase 7 WS M — one response never mixes snapshots', () => {
  it('passes a row set wholly inside the expected snapshot', () => {
    const rows = [row(), row({ canonicalNaturalKey: 'ARMY|OMA|SAG-2|2027|request' })];
    expect(assertOneSnapshotV1(rows, SNAP_A)).toBe(rows);
  });

  it('refuses a row set that straddles two snapshots', () => {
    // A silently mixed response is indistinguishable from a correct one to the
    // person reading it: half of one annual cycle and half of another, each row
    // individually valid.
    expect(() => assertOneSnapshotV1([row(), row({ snapshotId: SNAP_B })], SNAP_A)).toThrow(
      SnapshotMixError,
    );
  });

  it('names every foreign snapshot it found, deterministically', () => {
    try {
      assertOneSnapshotV1([row({ snapshotId: SNAP_B }), row({ snapshotId: SNAP_A })], SNAP_A);
      throw new Error('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotMixError);
      expect((error as SnapshotMixError).foundSnapshotIds).toEqual([SNAP_B]);
    }
  });

  it('accepts an empty row set', () => {
    // A PE with no procurement rows is a real answer, not a failure.
    expect(assertOneSnapshotV1([], SNAP_A)).toEqual([]);
  });
});

describe('Phase 7 WS M — the resolver resolves once', () => {
  function port(pointer: ActiveSnapshotV1 | null): SnapshotReadPortV1 & { calls: number } {
    const state = {
      calls: 0,
      async loadActiveSnapshot() {
        state.calls += 1;
        return pointer;
      },
      async loadRows() {
        return [];
      },
    };
    return state;
  }

  it('reads the pointer once however many times it is asked', async () => {
    const p = port(active());
    const resolver = createActiveSnapshotResolverV1(p, 'defense_budget', 'prod');
    await Promise.all([resolver.resolve(), resolver.resolve(), resolver.resolve()]);
    await resolver.resolve();
    // An activation committing between two reads in one response would hand the
    // caller two different snapshots. Caching the promise, not the value, means
    // concurrent reads share one round trip and therefore one answer.
    expect(p.calls).toBe(1);
  });

  it('reports whether a pointer exists, for the read-mode decision', async () => {
    const withPointer = createActiveSnapshotResolverV1(port(active()), 'defense_budget', 'prod');
    expect(withPointer.resolved()).toBe(false);
    await withPointer.resolve();
    expect(withPointer.resolved()).toBe(true);

    const withoutPointer = createActiveSnapshotResolverV1(port(null), 'defense_budget', 'prod');
    await withoutPointer.resolve();
    expect(withoutPointer.resolved()).toBe(false);
  });
});

describe('Phase 7 WS M — provenance is additive', () => {
  it('carries the snapshot identity and the override count', () => {
    expect(snapshotProvenanceV1(active(), 3)).toEqual({
      activeSnapshotId: SNAP_A,
      lastActivatedAt: '2026-08-07T12:00:00.000Z',
      snapshotHash: 'b'.repeat(64),
      overridesApplied: 3,
    });
  });

  it('defaults the override count rather than omitting the field', () => {
    expect(snapshotProvenanceV1(active()).overridesApplied).toBe(0);
  });
});

describe('Phase 7 WS M — the row query', () => {
  it('always scopes to one snapshot', () => {
    const { sql, params } = buildSnapshotRowSqlV1({ snapshotId: SNAP_A });
    expect(sql).toContain('"snapshot_id" = $1::uuid');
    expect(params[0]).toBe(SNAP_A);
  });

  it('parameterizes an IN list rather than passing an array', () => {
    // Nothing here should depend on how the driver serializes a JavaScript array
    // into a Postgres array literal.
    const { sql, params } = buildSnapshotRowSqlV1({
      snapshotId: SNAP_A,
      naturalKeys: ['k1', 'k2', 'k3'],
    });
    expect(sql).toContain('"canonical_natural_key" IN ($2, $3, $4)');
    expect(sql).not.toContain('ANY(');
    expect(params).toEqual([SNAP_A, 'k1', 'k2', 'k3']);
  });

  it('casts fiscal years so a string parameter cannot silently match nothing', () => {
    const { sql } = buildSnapshotRowSqlV1({ snapshotId: SNAP_A, fiscalYears: [2027, 2028] });
    expect(sql).toContain('"fiscal_year" IN ($2::int, $3::int)');
  });

  it('ignores empty filters instead of producing IN ()', () => {
    const { sql, params } = buildSnapshotRowSqlV1({
      snapshotId: SNAP_A,
      naturalKeys: [],
      fiscalYears: [],
    });
    expect(sql).not.toContain('IN ()');
    expect(params).toEqual([SNAP_A]);
  });

  it('bounds every read, and clamps a caller asking for too much', () => {
    expect(buildSnapshotRowSqlV1({ snapshotId: SNAP_A }).sql).toMatch(/LIMIT \d+/);
    expect(buildSnapshotRowSqlV1({ snapshotId: SNAP_A, limit: 10_000_000 }).sql).toContain(
      'LIMIT 50000',
    );
    expect(buildSnapshotRowSqlV1({ snapshotId: SNAP_A, limit: 0 }).sql).toContain('LIMIT 1');
  });

  it('contains no write verb at all', () => {
    // This adapter is used by the general serve role, which holds SELECT and
    // nothing more.
    const { sql } = buildSnapshotRowSqlV1({ snapshotId: SNAP_A });
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it('orders deterministically, so two identical reads digest identically', () => {
    // Shadow comparison digests whole responses; a nondeterministic row order
    // would report a mismatch on every request.
    expect(buildSnapshotRowSqlV1({ snapshotId: SNAP_A }).sql).toContain(
      'ORDER BY "canonical_entity", "canonical_natural_key"',
    );
  });
});
