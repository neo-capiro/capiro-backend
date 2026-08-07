/**
 * Phase 7 Workstream K — the governed manual-override overlay.
 *
 * The collision *policy* is Workstream C's and is tested in
 * `promotion-planner-v1.spec.ts`. What is tested here is the governance around
 * an override: that it cannot be self-approved, that expiry is derived rather
 * than remembered, that revocation beats dates, and that a correction
 * supersedes rather than edits.
 */
import {
  DEFENSE_BUDGET_MANUAL_OVERRIDE_SCHEMA_VERSION,
  defenseBudgetManualOverrideV1Schema,
  effectiveOverrideStatusV1,
  manualOverrideHashV1,
  manualOverrideTargetKeyV1,
  parseManualOverrideV1,
  toManualOverlayV1,
  type DefenseBudgetManualOverrideV1,
} from './manual-override-v1.js';

const AT = (iso: string) => new Date(iso);

function override(o: Record<string, unknown> = {}): DefenseBudgetManualOverrideV1 {
  return parseManualOverrideV1({
    schemaVersion: DEFENSE_BUDGET_MANUAL_OVERRIDE_SCHEMA_VERSION,
    overrideId: 'ovr-1',
    canonicalEntity: 'canonical_om_sag_year',
    naturalKey: 'ARMY|OMA|SAG-111',
    fiscalYear: 2027,
    fundingField: 'request',
    value: { originalValue: '1250', originalUnit: 'thousands', valueMillions: '1.25' },
    governance: {
      authorActorId: 'analyst-1',
      approverActorId: 'admin-1',
      approverRole: 'capiro_admin',
      reason: 'OP-5 line was transposed in the published PDF',
      evidenceIds: ['issue-42', 'doc-corrected'],
    },
    status: 'approved',
    version: 1,
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    effectiveTo: null,
    approvedAt: '2026-08-01T00:00:00.000Z',
    ...o,
  });
}

/** Zod refusals, asserted on the issue rather than on a thrown string. */
function refusalPaths(input: Record<string, unknown>): string[] {
  const result = defenseBudgetManualOverrideV1Schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}

function raw(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: DEFENSE_BUDGET_MANUAL_OVERRIDE_SCHEMA_VERSION,
    overrideId: 'ovr-1',
    canonicalEntity: 'canonical_om_sag_year',
    naturalKey: 'ARMY|OMA|SAG-111',
    fiscalYear: 2027,
    fundingField: 'request',
    value: { originalValue: '1250', originalUnit: 'thousands', valueMillions: '1.25' },
    governance: {
      authorActorId: 'analyst-1',
      approverActorId: 'admin-1',
      approverRole: 'capiro_admin',
      reason: 'OP-5 line was transposed in the published PDF',
      evidenceIds: ['issue-42'],
    },
    status: 'approved',
    version: 1,
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    approvedAt: '2026-08-01T00:00:00.000Z',
    ...o,
  };
}

describe('Phase 7 WS K — segregation of duties', () => {
  it('refuses an override approved by its own author', () => {
    expect(
      refusalPaths(
        raw({
          governance: {
            authorActorId: 'analyst-1',
            approverActorId: 'analyst-1',
            approverRole: 'capiro_admin',
            reason: 'looks wrong',
            evidenceIds: ['issue-42'],
          },
        }),
      ),
    ).toContain('governance.approverActorId');
  });

  it('accepts an override approved by someone else', () => {
    expect(override().governance.approverActorId).toBe('admin-1');
  });

  it('refuses an approver who is not a capiro_admin', () => {
    expect(
      refusalPaths(
        raw({
          governance: {
            authorActorId: 'analyst-1',
            approverActorId: 'analyst-2',
            approverRole: 'capiro_user',
            reason: 'looks wrong',
            evidenceIds: ['issue-42'],
          },
        }),
      ),
    ).toContain('governance.approverRole');
  });

  it('refuses an override with no stated reason and no evidence', () => {
    const noReason = refusalPaths(
      raw({
        governance: {
          authorActorId: 'analyst-1',
          approverActorId: 'admin-1',
          approverRole: 'capiro_admin',
          reason: '   ',
          evidenceIds: ['issue-42'],
        },
      }),
    );
    expect(noReason).toContain('governance.reason');

    const noEvidence = refusalPaths(
      raw({
        governance: {
          authorActorId: 'analyst-1',
          approverActorId: 'admin-1',
          approverRole: 'capiro_admin',
          reason: 'looks wrong',
          evidenceIds: [],
        },
      }),
    );
    expect(noEvidence).toContain('governance.evidenceIds');
  });
});

describe('Phase 7 WS K — money is never a float', () => {
  it('refuses a non-canonical decimal string', () => {
    expect(
      refusalPaths(
        raw({
          value: { originalValue: '1,250', originalUnit: 'thousands', valueMillions: '1.25' },
        }),
      ),
    ).toContain('value.originalValue');
  });

  it('refuses a JavaScript number where an exact decimal is required', () => {
    expect(
      refusalPaths(
        raw({ value: { originalValue: 1250, originalUnit: 'thousands', valueMillions: '1.25' } }),
      ),
    ).toContain('value.originalValue');
  });

  it('keeps the printed value, its unit, and the millions figure together', () => {
    const value = override().value;
    expect(value).toEqual({
      originalValue: '1250',
      originalUnit: 'thousands',
      valueMillions: '1.25',
    });
  });
});

describe('Phase 7 WS K — effective status is derived, never remembered', () => {
  const windowed = () =>
    override({
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      effectiveTo: '2026-09-01T00:00:00.000Z',
    });

  it('is active inside its window', () => {
    expect(effectiveOverrideStatusV1(windowed(), AT('2026-08-15T00:00:00.000Z'))).toBe('active');
  });

  it('is expired once the window closes, with nothing having to flip a flag', () => {
    expect(effectiveOverrideStatusV1(windowed(), AT('2026-09-02T00:00:00.000Z'))).toBe('expired');
  });

  it('expires exactly at the boundary, not after it', () => {
    expect(effectiveOverrideStatusV1(windowed(), AT('2026-09-01T00:00:00.000Z'))).toBe('expired');
  });

  it('is pending before it takes effect, which is not the same as expired', () => {
    expect(effectiveOverrideStatusV1(windowed(), AT('2026-07-01T00:00:00.000Z'))).toBe('pending');
  });

  it('stays active indefinitely when the window is open-ended', () => {
    expect(effectiveOverrideStatusV1(override(), AT('2099-01-01T00:00:00.000Z'))).toBe('active');
  });

  it('treats revocation as beating the dates', () => {
    const revoked = override({
      status: 'revoked',
      revokedAt: '2026-08-10T00:00:00.000Z',
      effectiveTo: '2026-09-01T00:00:00.000Z',
    });
    expect(effectiveOverrideStatusV1(revoked, AT('2026-08-15T00:00:00.000Z'))).toBe('revoked');
  });

  it('refuses a revoked override that does not say when it was revoked', () => {
    expect(refusalPaths(raw({ status: 'revoked' }))).toContain('revokedAt');
  });

  it('refuses a revocation timestamp on an override that is not revoked', () => {
    expect(refusalPaths(raw({ revokedAt: '2026-08-10T00:00:00.000Z' }))).toContain('revokedAt');
  });

  it('refuses a window that closes before it opens', () => {
    expect(refusalPaths(raw({ effectiveTo: '2026-07-01T00:00:00.000Z' }))).toContain('effectiveTo');
  });
});

describe('Phase 7 WS K — corrections supersede, never edit', () => {
  it('refuses a first version that claims to supersede something', () => {
    expect(refusalPaths(raw({ version: 1, priorOverrideId: 'ovr-0' }))).toContain(
      'priorOverrideId',
    );
  });

  it('refuses a later version that links no predecessor', () => {
    expect(refusalPaths(raw({ version: 2 }))).toContain('priorOverrideId');
  });

  it('accepts a version chain that links back', () => {
    const v2 = override({ overrideId: 'ovr-2', version: 2, priorOverrideId: 'ovr-1' });
    expect(v2.priorOverrideId).toBe('ovr-1');
    expect(v2.version).toBe(2);
  });

  it('gives a superseding version a different hash from the one it replaces', () => {
    const v1 = override();
    const v2 = override({ overrideId: 'ovr-2', version: 2, priorOverrideId: 'ovr-1' });
    expect(manualOverrideHashV1(v1)).not.toBe(manualOverrideHashV1(v2));
  });

  it('hashes deterministically regardless of evidence order', () => {
    const a = override({
      governance: {
        authorActorId: 'analyst-1',
        approverActorId: 'admin-1',
        approverRole: 'capiro_admin',
        reason: 'OP-5 line was transposed in the published PDF',
        evidenceIds: ['issue-42', 'doc-corrected'],
      },
    });
    const b = override({
      governance: {
        authorActorId: 'analyst-1',
        approverActorId: 'admin-1',
        approverRole: 'capiro_admin',
        reason: 'OP-5 line was transposed in the published PDF',
        evidenceIds: ['doc-corrected', 'issue-42', 'doc-corrected'],
      },
    });
    expect(manualOverrideHashV1(a)).toBe(manualOverrideHashV1(b));
  });
});

describe('Phase 7 WS K — the overlay handed to the planner', () => {
  it('presents an in-force override as active, so the planner defends it', () => {
    expect(toManualOverlayV1(override(), AT('2026-08-15T00:00:00.000Z'))).toEqual({
      canonicalEntity: 'canonical_om_sag_year',
      naturalKey: 'ARMY|OMA|SAG-111',
      fiscalYear: 2027,
      fundingField: 'request',
      status: 'active',
    });
  });

  it('presents a revoked override as revoked', () => {
    const revoked = override({ status: 'revoked', revokedAt: '2026-08-10T00:00:00.000Z' });
    expect(toManualOverlayV1(revoked, AT('2026-08-15T00:00:00.000Z')).status).toBe('revoked');
  });

  it('collapses pending to expired, because neither is in force', () => {
    const future = override({ effectiveFrom: '2027-01-01T00:00:00.000Z' });
    expect(toManualOverlayV1(future, AT('2026-08-15T00:00:00.000Z')).status).toBe('expired');
  });

  it('targets a canonical identity, never a legacy peCode', () => {
    expect(refusalPaths(raw({ canonicalEntity: 'program_element' }))).toContain('canonicalEntity');
  });

  it('keys a target unambiguously even though natural keys contain pipes', () => {
    const a = manualOverrideTargetKeyV1({
      canonicalEntity: 'canonical_om_sag_year',
      naturalKey: 'ARMY|OMA',
      fiscalYear: null,
      fundingField: null,
    });
    const b = manualOverrideTargetKeyV1({
      canonicalEntity: 'canonical_om_sag_year',
      naturalKey: 'ARMY',
      fiscalYear: null,
      fundingField: 'request',
    });
    expect(a).not.toBe(b);
  });
});
