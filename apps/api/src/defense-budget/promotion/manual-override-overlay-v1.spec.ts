/**
 * Phase 7 Workstream M — the read-time override overlay.
 *
 * Workstream K's last piece. K made a governed correction exist; this makes one
 * visible without letting it become a canonical fact.
 */
import {
  applyOverrideOverlayV1,
  inForceOverridesV1,
  overlayTargetKeyV1,
} from './manual-override-overlay-v1.js';
import type { DefenseBudgetManualOverrideV1 } from './manual-override-v1.js';
import type { SnapshotCanonicalRowV1 } from './snapshot-read-repository-v1.js';

const NOW = new Date('2026-08-07T12:00:00.000Z');
const SNAP = 'aaaaaaaa-0000-0000-0000-000000000001';
const KEY = 'ARMY|OMA|SAG-1|2027|request';

function override(
  overrides: Partial<DefenseBudgetManualOverrideV1> = {},
): DefenseBudgetManualOverrideV1 {
  return {
    schemaVersion: 'defense_budget_manual_override_v1',
    overrideId: 'ovr-1',
    canonicalEntity: 'canonical_om_sag_year',
    naturalKey: KEY,
    fiscalYear: 2027,
    fundingField: 'request',
    value: { originalValue: '9000', originalUnit: 'thousands', valueMillions: '9' },
    governance: {
      authorActorId: 'author-1',
      approverActorId: 'approver-1',
      approverRole: 'capiro_admin',
      reason: 'OCR read 1250 where the document says 9000',
      evidenceIds: ['issue-42'],
    },
    status: 'approved',
    version: 1,
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    proposedAt: '2026-07-31T00:00:00.000Z',
    approvedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as DefenseBudgetManualOverrideV1;
}

function row(overrides: Partial<SnapshotCanonicalRowV1> = {}): SnapshotCanonicalRowV1 {
  return {
    snapshotId: SNAP,
    canonicalEntity: 'canonical_om_sag_year',
    canonicalNaturalKey: KEY,
    parentNaturalKey: null,
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

describe('Phase 7 WS M — which overrides are in force', () => {
  it('applies an approved override inside its window', () => {
    expect(inForceOverridesV1([override()], NOW)).toHaveLength(1);
  });

  it('does not apply a proposal', () => {
    // The whole point of the two-step flow: one admin's opinion changes nothing
    // until a second approves it.
    const proposal = override({ status: 'proposed', approverActorId: undefined } as never);
    expect(inForceOverridesV1([proposal], NOW)).toEqual([]);
  });

  it('does not apply a revoked, expired, or future-dated override', () => {
    expect(inForceOverridesV1([override({ status: 'revoked' })], NOW)).toEqual([]);
    expect(
      inForceOverridesV1([override({ effectiveTo: '2026-08-05T00:00:00.000Z' })], NOW),
    ).toEqual([]);
    expect(
      inForceOverridesV1([override({ effectiveFrom: '2026-09-01T00:00:00.000Z' })], NOW),
    ).toEqual([]);
  });

  it('takes the highest version when a correction supersedes a correction', () => {
    const applied = inForceOverridesV1(
      [
        override({ overrideId: 'ovr-1', version: 1 }),
        override({
          overrideId: 'ovr-2',
          version: 2,
          value: { originalValue: '9500', originalUnit: 'thousands', valueMillions: '9.5' },
        }),
      ],
      NOW,
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]?.provenance.overrideId).toBe('ovr-2');
    expect(applied[0]?.value.valueMillions).toBe('9.5');
  });

  it('lets a revoked newest version end the chain rather than reviving the older one', () => {
    // Evaluating status per record and then taking the highest surviving version
    // would let a revocation resurrect the correction it replaced. The highest
    // version wins first, and if it is revoked nothing is in force.
    const applied = inForceOverridesV1(
      [
        override({ overrideId: 'ovr-1', version: 1, status: 'approved' }),
        override({ overrideId: 'ovr-2', version: 2, status: 'revoked' }),
      ],
      NOW,
    );
    expect(applied).toEqual([]);
  });

  it('keeps fiscal year and funding field in the target identity', () => {
    // An override of FY2027 request must not shadow FY2028 enacted on the same
    // line.
    expect(
      overlayTargetKeyV1({ canonicalEntity: 'e', naturalKey: 'k', fiscalYear: 2027 }),
    ).not.toBe(overlayTargetKeyV1({ canonicalEntity: 'e', naturalKey: 'k', fiscalYear: 2028 }));
    // Null and absent are the same target.
    expect(overlayTargetKeyV1({ canonicalEntity: 'e', naturalKey: 'k' })).toBe(
      overlayTargetKeyV1({ canonicalEntity: 'e', naturalKey: 'k', fiscalYear: null }),
    );
  });
});

describe('Phase 7 WS M — applying the overlay', () => {
  it('shows the corrected value and keeps the official one', () => {
    const result = applyOverrideOverlayV1([row()], inForceOverridesV1([override()], NOW));
    expect(result.applied).toBe(1);
    expect(result.rows[0]?.money?.valueMillions).toBe('9');
    // A correction that hides what it corrected is a rewrite.
    expect(result.rows[0]?.officialMoney?.valueMillions).toBe('1.25');
  });

  it('labels the corrected value with who approved it and why', () => {
    const result = applyOverrideOverlayV1([row()], inForceOverridesV1([override()], NOW));
    expect(result.rows[0]?.override).toMatchObject({
      label: 'manual_override',
      overrideId: 'ovr-1',
      version: 1,
      approverActorId: 'approver-1',
      reason: 'OCR read 1250 where the document says 9000',
    });
  });

  it('leaves the canonical row hash alone', () => {
    // The hash identifies the government fact this row is. An override does not
    // make it a different fact; it makes it a fact someone has corrected.
    const result = applyOverrideOverlayV1([row()], inForceOverridesV1([override()], NOW));
    expect(result.rows[0]?.canonicalRowHash).toBe('a'.repeat(64));
  });

  it('does not mutate the rows it was given', () => {
    // Read results are cached and shared, and an override is global rather than
    // tenant-scoped, so an in-place edit would leak into the next reader and
    // stay invisible in a single-tenant test.
    const original = row();
    applyOverrideOverlayV1([original], inForceOverridesV1([override()], NOW));
    expect(original.money?.valueMillions).toBe('1.25');
    expect(original).not.toHaveProperty('override');
  });

  it('leaves an unmatched row untouched and unlabelled', () => {
    const other = row({ canonicalNaturalKey: 'ARMY|OMA|SAG-9|2027|request' });
    const result = applyOverrideOverlayV1([other], inForceOverridesV1([override()], NOW));
    expect(result.applied).toBe(0);
    expect(result.rows[0]?.override).toBeNull();
    expect(result.rows[0]?.money?.valueMillions).toBe('1.25');
  });

  it('surfaces an in-force override whose target the snapshot does not contain', () => {
    // Dropping it silently is the "active override silently overwritten by a new
    // snapshot" that plan §K.5 forbids, moved to the read path. Synthesizing a
    // row would invent canonical lineage no document asserts. So it comes back
    // as data the caller can alert on.
    const result = applyOverrideOverlayV1([], inForceOverridesV1([override()], NOW));
    expect(result.rows).toEqual([]);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]?.provenance.overrideId).toBe('ovr-1');
  });

  it('applies nothing when nothing is in force', () => {
    const result = applyOverrideOverlayV1([row()], []);
    expect(result.applied).toBe(0);
    expect(result.unmatched).toEqual([]);
    expect(result.rows[0]?.officialMoney).toBeNull();
  });
});
