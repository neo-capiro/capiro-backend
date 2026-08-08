import type { MoneyValueV1 } from '../contracts/extraction-artifact-v1.js';
import { nativeIdentityHashV1 } from '../stages/budget-line-reference-v1.js';
import type { DefenseBudgetStageActionV1 } from '../stages/appropriations/actions/defense-budget-stage-action-v1.js';
import type { StagePositionV1 } from '../stages/stage-row-emitter-v1.js';
import { phase6NativeProjectionV1Schema } from './phase6-native-projection-v1.js';
import {
  buildStageActionProjectionV1,
  buildStagePositionProjectionV1,
  type Phase6ProjectionProvenanceV1,
} from './phase6-projection-builder-v1.js';

const SHA = (c: string) => c.repeat(64);

const PROVENANCE: Phase6ProjectionProvenanceV1 = {
  verificationCandidateId: 'vc-1',
  verificationRunId: 'vr-1',
  artifactId: 'artifact-1',
  artifactContentSha256: SHA('a'),
  sourceDocumentId: 'doc-1',
  sourcePdfSha256: SHA('b'),
  sourceProfileHash: SHA('c'),
  evidenceIds: ['ev-2', 'ev-1'],
};

const PE_IDENTITY = { lineKind: 'RDTE_PE' as const, peCode: '0605053A' };

function position(overrides: Partial<StagePositionV1> = {}): StagePositionV1 {
  return {
    identity: PE_IDENTITY,
    field: 'hacDMark',
    fiscalYear: 2027,
    value: '125',
    unit: 'millions',
    provenance: 'direct',
    rowIndex: 3,
    page: 12,
    ...overrides,
  };
}

describe('buildStagePositionProjectionV1', () => {
  it('builds a schema-valid, verified stage_position projection', () => {
    const result = buildStagePositionProjectionV1(position(), 'hac_d', PROVENANCE, 'verified');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => phase6NativeProjectionV1Schema.parse(result.projection)).not.toThrow();
    expect(result.projection.fundingField).toBe('hacDMark');
    expect(result.projection.track).toBe('appropriations');
    expect(result.projection.bindingStatus).toBe('accepted');
    expect(result.projection.money).toEqual<MoneyValueV1>({
      originalValue: '125',
      originalUnit: 'millions',
      valueMillions: '125',
    });
  });

  it('computes nativeIdentityHash as sha256 of the deterministic identity key, not a placeholder', () => {
    const result = buildStagePositionProjectionV1(position(), 'hac_d', PROVENANCE, 'verified');
    if (!result.ok) throw new Error('expected ok');
    expect(result.projection.nativeIdentityHash).toBe(nativeIdentityHashV1(PE_IDENTITY));
    expect(result.projection.nativeIdentityHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('leads the natural key with the native identity hash, in registry order', () => {
    const result = buildStagePositionProjectionV1(position(), 'hac_d', PROVENANCE, 'verified');
    if (!result.ok) throw new Error('expected ok');
    const hash = nativeIdentityHashV1(PE_IDENTITY);
    expect(result.projection.naturalKey).toBe(`${hash}|2027|hac_d|hacDMark`);
  });

  it('gives the same source row the same idempotency key on replay', () => {
    const a = buildStagePositionProjectionV1(position(), 'hac_d', PROVENANCE, 'verified');
    const b = buildStagePositionProjectionV1(position(), 'hac_d', PROVENANCE, 'verified');
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.projection.idempotencyKey).toBe(b.projection.idempotencyKey);
    expect(a.projection.projectionId).toBe(b.projection.projectionId);
  });

  it('gives two different source rows different idempotency keys even at the same natural key', () => {
    const a = buildStagePositionProjectionV1(
      position({ rowIndex: 3 }),
      'hac_d',
      PROVENANCE,
      'verified',
    );
    const b = buildStagePositionProjectionV1(
      position({ rowIndex: 4 }),
      'hac_d',
      PROVENANCE,
      'verified',
    );
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.projection.naturalKey).toBe(b.projection.naturalKey);
    expect(a.projection.idempotencyKey).not.toBe(b.projection.idempotencyKey);
  });

  it('two different native identities never collide on nativeIdentityHash', () => {
    const blin = buildStagePositionProjectionV1(
      position({
        identity: { lineKind: 'PROCUREMENT_BLIN', code: '12', account: 'APAF', component: 'AF' },
      }),
      'hac_d',
      PROVENANCE,
      'verified',
    );
    const pe = buildStagePositionProjectionV1(position(), 'hac_d', PROVENANCE, 'verified');
    if (!blin.ok || !pe.ok) throw new Error('expected ok');
    expect(blin.projection.nativeIdentityHash).not.toBe(pe.projection.nativeIdentityHash);
  });

  it('base and advance procurement produce distinct hashes under the same code/account', () => {
    const base = buildStagePositionProjectionV1(
      position({
        identity: {
          lineKind: 'PROCUREMENT_BLIN',
          code: '12',
          account: 'APAF',
          component: 'AF',
          advanceProcurement: false,
        },
      }),
      'hac_d',
      PROVENANCE,
      'verified',
    );
    const advance = buildStagePositionProjectionV1(
      position({
        identity: {
          lineKind: 'PROCUREMENT_BLIN',
          code: '12',
          account: 'APAF',
          component: 'AF',
          advanceProcurement: true,
        },
      }),
      'hac_d',
      PROVENANCE,
      'verified',
    );
    if (!base.ok || !advance.ok) throw new Error('expected ok');
    expect(base.projection.nativeIdentityHash).not.toBe(advance.projection.nativeIdentityHash);
  });

  it('refuses a missing fiscal year rather than inventing one', () => {
    const result = buildStagePositionProjectionV1(
      position({ fiscalYear: undefined }),
      'hac_d',
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('missing_fiscal_year');
  });

  it('refuses a stage this pass does not build, rather than guessing at enactment proof/execution semantics', () => {
    for (const stage of [
      'public_law',
      'continuing_resolution',
      'reprogramming',
      'execution',
    ] as const) {
      const result = buildStagePositionProjectionV1(position(), stage, PROVENANCE, 'verified');
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.refusal.reason).toBe('stage_not_supported');
    }
  });

  it('preserves the caller-declared projection status verbatim (this module makes no verification decision)', () => {
    for (const status of ['candidate', 'verified', 'blocked', 'superseded'] as const) {
      const result = buildStagePositionProjectionV1(position(), 'hac_d', PROVENANCE, status);
      if (!result.ok) throw new Error('expected ok');
      expect(result.projection.projectionStatus).toBe(status);
    }
  });

  it('preserves direct-versus-derived provenance', () => {
    const derived = buildStagePositionProjectionV1(
      position({ provenance: 'derived', derivation: { baseline: '100', change: '25' } }),
      'hac_d',
      PROVENANCE,
      'verified',
    );
    if (!derived.ok) throw new Error('expected ok');
    expect(derived.projection.directOrDerived).toBe('derived');
  });

  it('sorts evidence IDs deterministically regardless of input order', () => {
    const a = buildStagePositionProjectionV1(position(), 'hac_d', PROVENANCE, 'verified');
    const b = buildStagePositionProjectionV1(
      position(),
      'hac_d',
      { ...PROVENANCE, evidenceIds: ['ev-1', 'ev-2'] },
      'verified',
    );
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.projection.evidenceIds).toEqual(b.projection.evidenceIds);
    expect(a.projection.evidenceIds).toEqual(['ev-1', 'ev-2']);
  });

  it('maps every stage this pass supports to a schema-accepted stage/track/field combination', () => {
    const table: Array<{
      stage: 'hasc' | 'sasc' | 'hac_d' | 'sac_d' | 'ndaa_conference' | 'appropriations_conference';
      field: 'hascMark' | 'sascMark' | 'hacDMark' | 'sacDMark' | 'ndaaConference' | 'conference';
    }> = [
      { stage: 'hasc', field: 'hascMark' },
      { stage: 'sasc', field: 'sascMark' },
      { stage: 'hac_d', field: 'hacDMark' },
      { stage: 'sac_d', field: 'sacDMark' },
      { stage: 'ndaa_conference', field: 'ndaaConference' },
      { stage: 'appropriations_conference', field: 'conference' },
    ];
    for (const { stage, field } of table) {
      const result = buildStagePositionProjectionV1(
        position({ field }),
        stage,
        PROVENANCE,
        'verified',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(() => phase6NativeProjectionV1Schema.parse(result.projection)).not.toThrow();
    }
  });
});

function action(overrides: Partial<DefenseBudgetStageActionV1> = {}): DefenseBudgetStageActionV1 {
  return {
    schemaVersion: 'defense_budget_stage_action_v1',
    actionId: 'act-1',
    track: 'appropriations',
    stage: 'hac_d',
    authority: 'hacd_appropriations',
    vehicleClass: 'committee_report',
    actionType: 'transfer_out',
    identity: PE_IDENTITY,
    fiscalYear: 2027,
    amount: { originalValue: '5', originalUnit: 'millions', valueMillions: '5' },
    signedValueMillions: '-5',
    direction: 'out',
    evidenceIds: ['ev-1'],
    languageEvidenceIds: [],
    directOrDerived: 'direct',
    ...overrides,
  };
}

describe('buildStageActionProjectionV1', () => {
  it('builds a schema-valid stage_action projection with no money axis', () => {
    const result = buildStageActionProjectionV1(action(), PROVENANCE, 'verified');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => phase6NativeProjectionV1Schema.parse(result.projection)).not.toThrow();
    expect(result.projection.money).toBeUndefined();
    expect(result.projection.fundingField).toBeUndefined();
  });

  it('preserves the signed amount as a payload attribute rather than dropping it', () => {
    const result = buildStageActionProjectionV1(action(), PROVENANCE, 'verified');
    if (!result.ok) throw new Error('expected ok');
    expect(result.projection.payload.signedValueMillions).toBe('-5');
    expect(result.projection.payload.originalValue).toBe('5');
    expect(result.projection.payload.originalUnit).toBe('millions');
  });

  it('leads the natural key with nativeIdentityHash and ends with the action id as disambiguator', () => {
    const result = buildStageActionProjectionV1(action(), PROVENANCE, 'verified');
    if (!result.ok) throw new Error('expected ok');
    const hash = nativeIdentityHashV1(PE_IDENTITY);
    expect(result.projection.naturalKey).toBe(`${hash}|2027|hac_d|transfer_out|act-1`);
  });

  it('promotes rationale into payload.narrative, the consumed key the projector reads', () => {
    const result = buildStageActionProjectionV1(
      action({ rationale: 'shipyard capacity shortfall' }),
      PROVENANCE,
      'verified',
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.projection.payload.narrative).toBe('shipyard capacity shortfall');
  });

  it('refuses a package-scoped action rather than inventing a pseudo-identity hash', () => {
    const result = buildStageActionProjectionV1(
      action({ identity: undefined, packageScope: 'defense-wide' }),
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('no_single_native_identity');
  });

  it('refuses a transfer-pair action with source/destination identities but no single scope', () => {
    const result = buildStageActionProjectionV1(
      action({
        identity: undefined,
        sourceIdentity: PE_IDENTITY,
        destinationIdentity: { lineKind: 'RDTE_PE', peCode: '0605054A' },
      }),
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('no_single_native_identity');
  });

  it('gives distinct action rows on the same line distinct natural keys via the action id', () => {
    const first = buildStageActionProjectionV1(
      action({ actionId: 'act-1' }),
      PROVENANCE,
      'verified',
    );
    const second = buildStageActionProjectionV1(
      action({ actionId: 'act-2' }),
      PROVENANCE,
      'verified',
    );
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.projection.naturalKey).not.toBe(second.projection.naturalKey);
  });
});
