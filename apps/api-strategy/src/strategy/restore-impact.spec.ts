import { describe, expect, it } from '@jest/globals';
import {
  changedFieldsOf,
  diffSnapshotAgainstCurrent,
  isNoOpRestore,
  provenanceDiffers,
  stableStringify,
  type ImpactCurrentNode,
  type ImpactSnapshotNode,
} from './restore-impact.js';

/*
 * P0-1: the pure snapshot-vs-current diff. VersionService derives BOTH the impact
 * preview and the restore write plan from this module, so a bug here would make
 * the preview lie about what the restore is about to do — hence the direct tests.
 */

function snap(overrides: Partial<ImpactSnapshotNode> = {}): ImpactSnapshotNode {
  return {
    id: 'n1',
    kind: 'action',
    subject: 'deliverable',
    title: 'Draft the position paper',
    note: null,
    ownerUserId: 'u1',
    status: 'active',
    startsOn: '2027-03-01',
    endsOn: null,
    openEnded: false,
    dependsOnIds: [],
    targetRef: null,
    provenance: null,
    ...overrides,
  };
}

function cur(overrides: Partial<ImpactCurrentNode> = {}): ImpactCurrentNode {
  return {
    id: 'n1',
    kind: 'action',
    subject: 'deliverable',
    title: 'Draft the position paper',
    note: null,
    ownerUserId: 'u1',
    status: 'active',
    startsOn: new Date('2027-03-01T00:00:00.000Z'),
    endsOn: null,
    openEnded: false,
    dependsOnIds: [],
    targetRef: null,
    provenance: null,
    archivedAt: null,
    ...overrides,
  };
}

describe('stableStringify', () => {
  it('is key-order independent', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('distinguishes genuinely different values', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it('treats null and undefined alike (a JSONB column round-trips absent as null)', () => {
    expect(stableStringify(undefined)).toBe(stableStringify(null));
  });

  it('recurses into nested objects and arrays', () => {
    expect(stableStringify({ x: [{ b: 1, a: 2 }] })).toBe(stableStringify({ x: [{ a: 2, b: 1 }] }));
  });
});

describe('changedFieldsOf', () => {
  it('sees no change for an identical node', () => {
    expect(changedFieldsOf(snap(), cur())).toEqual([]);
  });

  it('does NOT report a change for a Date-vs-ISO-string startsOn (the @db.Date round-trip)', () => {
    // The snapshot stores 'YYYY-MM-DD'; the row is a Date. Naive comparison would
    // mark every single node changed on every restore.
    expect(changedFieldsOf(snap({ startsOn: '2027-03-01' }), cur())).toEqual([]);
  });

  it('reports a real date change', () => {
    expect(changedFieldsOf(snap({ startsOn: '2027-04-15' }), cur())).toEqual(['startsOn']);
  });

  it('reports title / owner / status changes', () => {
    expect(
      changedFieldsOf(
        snap({ title: 'New title', ownerUserId: 'u2', status: 'draft' }),
        cur(),
      ).sort(),
    ).toEqual(['ownerUserId', 'status', 'title']);
  });

  it('treats dependsOnIds as a SET (order is not a change)', () => {
    expect(
      changedFieldsOf(snap({ dependsOnIds: ['a', 'b'] }), cur({ dependsOnIds: ['b', 'a'] })),
    ).toEqual([]);
  });

  it('reports a real dependsOnIds membership change', () => {
    expect(
      changedFieldsOf(snap({ dependsOnIds: ['a'] }), cur({ dependsOnIds: ['a', 'b'] })),
    ).toEqual(['dependsOnIds']);
  });

  it('compares targetRef by value, not key order', () => {
    expect(
      changedFieldsOf(
        snap({ targetRef: { memberId: 'M1', memberName: 'Rep. A' } }),
        cur({ targetRef: { memberName: 'Rep. A', memberId: 'M1' } }),
      ),
    ).toEqual([]);
  });

  it('reports a changed recipient (targetRef) — a material execution difference', () => {
    expect(
      changedFieldsOf(
        snap({ targetRef: { memberId: 'M1' } }),
        cur({ targetRef: { memberId: 'M2' } }),
      ),
    ).toEqual(['targetRef']);
  });

  it('treats a MISSING dependsOnIds key on a pre-A2 snapshot as []', () => {
    const legacy = snap();
    delete legacy.dependsOnIds;
    expect(changedFieldsOf(legacy, cur({ dependsOnIds: [] }))).toEqual([]);
  });

  it('does not compare provenance (grounding is not user-visible plan content)', () => {
    expect(
      changedFieldsOf(snap({ provenance: { sources: ['a'] } }), cur({ provenance: null })),
    ).toEqual([]);
  });
});

describe('provenanceDiffers', () => {
  it('is false when the snapshot has NO provenance key (pre-P0-1 snapshot: no opinion)', () => {
    const legacy = snap();
    delete legacy.provenance;
    expect(provenanceDiffers(legacy, cur({ provenance: { sources: ['added-later'] } }))).toBe(
      false,
    );
  });

  it('is true when the snapshot carries a different provenance', () => {
    expect(
      provenanceDiffers(snap({ provenance: { sources: ['a'] } }), cur({ provenance: null })),
    ).toBe(true);
  });

  it('is false when the snapshot provenance matches (ignoring key order)', () => {
    expect(
      provenanceDiffers(
        snap({ provenance: { sources: ['a'], model: 'x' } }),
        cur({ provenance: { model: 'x', sources: ['a'] } }),
      ),
    ).toBe(false);
  });

  it('is false when both are explicitly null', () => {
    expect(provenanceDiffers(snap({ provenance: null }), cur({ provenance: null }))).toBe(false);
  });
});

describe('diffSnapshotAgainstCurrent', () => {
  it('classifies an identical plan as all-unchanged', () => {
    const d = diffSnapshotAgainstCurrent([snap()], [cur()]);
    expect(d.unchanged.map((n) => n.id)).toEqual(['n1']);
    expect(d.added).toEqual([]);
    expect(d.revived).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(isNoOpRestore(d)).toBe(true);
  });

  it('marks a live node absent from the snapshot as REMOVED (to be archived)', () => {
    const d = diffSnapshotAgainstCurrent([], [cur({ id: 'n-live' })]);
    expect(d.removed.map((n) => n.id)).toEqual(['n-live']);
    expect(isNoOpRestore(d)).toBe(false);
  });

  it('marks a snapshot node with no row at all as ADDED (to be re-created)', () => {
    const d = diffSnapshotAgainstCurrent([snap({ id: 'n-gone' })], []);
    expect(d.added.map((n) => n.id)).toEqual(['n-gone']);
  });

  it('marks a snapshot node whose row is ARCHIVED as REVIVED, not added and not unchanged', () => {
    const d = diffSnapshotAgainstCurrent(
      [snap({ id: 'n-arch' })],
      [cur({ id: 'n-arch', archivedAt: new Date('2027-07-01T00:00:00.000Z') })],
    );
    expect(d.revived.map((n) => n.id)).toEqual(['n-arch']);
    expect(d.added).toEqual([]);
    expect(d.unchanged).toEqual([]);
    expect(isNoOpRestore(d)).toBe(false);
  });

  it('reports revival even when every compared field already matches', () => {
    // Revival is itself a material change: the node re-enters the live plan.
    const d = diffSnapshotAgainstCurrent(
      [snap()],
      [cur({ archivedAt: new Date('2027-07-01T00:00:00.000Z') })],
    );
    expect(d.revived).toHaveLength(1);
    expect(d.unchanged).toEqual([]);
  });

  it('never re-archives an already-archived node the snapshot also omits', () => {
    const d = diffSnapshotAgainstCurrent(
      [],
      [cur({ id: 'n-arch', archivedAt: new Date('2027-07-01T00:00:00.000Z') })],
    );
    expect(d.removed).toEqual([]);
    expect(isNoOpRestore(d)).toBe(true);
  });

  it('reports the changed field list on a node that survives with edits', () => {
    const d = diffSnapshotAgainstCurrent(
      [snap({ title: 'Old title' })],
      [cur({ title: 'New title' })],
    );
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.id).toBe('n1');
    expect(d.changed[0]!.changedFields).toEqual(['title']);
    // The ref carries the SNAPSHOT title — the value the restore is moving to.
    expect(d.changed[0]!.title).toBe('Old title');
  });

  it('handles a mixed plan in one pass', () => {
    const d = diffSnapshotAgainstCurrent(
      [
        snap({ id: 'same' }),
        snap({ id: 'edited', title: 'Snapshot wording' }),
        snap({ id: 'revived' }),
        snap({ id: 'recreated' }),
      ],
      [
        cur({ id: 'same' }),
        cur({ id: 'edited', title: 'Live wording' }),
        cur({ id: 'revived', archivedAt: new Date('2027-07-01T00:00:00.000Z') }),
        cur({ id: 'dropped' }),
      ],
    );
    expect(d.unchanged.map((n) => n.id)).toEqual(['same']);
    expect(d.changed.map((n) => n.id)).toEqual(['edited']);
    expect(d.revived.map((n) => n.id)).toEqual(['revived']);
    expect(d.added.map((n) => n.id)).toEqual(['recreated']);
    expect(d.removed.map((n) => n.id)).toEqual(['dropped']);
  });
});
