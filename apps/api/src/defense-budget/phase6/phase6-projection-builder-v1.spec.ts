import type { MoneyValueV1 } from '../contracts/extraction-artifact-v1.js';
import { nativeIdentityHashV1 } from '../stages/budget-line-reference-v1.js';
import type { DefenseBudgetStageActionV1 } from '../stages/appropriations/actions/defense-budget-stage-action-v1.js';
import type { StagePositionV1 } from '../stages/stage-row-emitter-v1.js';
import type {
  EnactedLineCandidateV1,
  DefenseBudgetEnactmentProofV1,
} from '../stages/enacted/enactment-proof-v1.js';
import type { ExecutionCompositionV1 } from '../stages/post-enactment/reprogramming-execution-v1.js';
import { phase6ActionScopeIdentityHashV1 } from './phase6-action-scope-identity-v1.js';
import { phase6NativeProjectionV1Schema } from './phase6-native-projection-v1.js';
import {
  buildEnactedStagePositionProjectionV1,
  buildExecutionStagePositionProjectionV1,
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

  it('B3: projects a package-scoped action via its derived scope identity, not a refusal', () => {
    const result = buildStageActionProjectionV1(
      action({ identity: undefined, packageScope: 'defense-wide' }),
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => phase6NativeProjectionV1Schema.parse(result.projection)).not.toThrow();
    expect(result.projection.nativeIdentityHash).toBe(
      phase6ActionScopeIdentityHashV1({
        kind: 'PACKAGE',
        packageScope: 'defense-wide',
        vehicleClass: 'committee_report',
        fiscalYear: 2027,
        stage: 'hac_d',
      }),
    );
    expect(result.projection.payload.identityScopeKind).toBe('PACKAGE');
  });

  it('B3: projects an account-scoped action via its derived scope identity', () => {
    const result = buildStageActionProjectionV1(
      action({ identity: undefined, accountScope: 'ARMY-RDTE' }),
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.nativeIdentityHash).toBe(
      phase6ActionScopeIdentityHashV1({
        kind: 'ACCOUNT',
        accountScope: 'ARMY-RDTE',
        fiscalYear: 2027,
        stage: 'hac_d',
      }),
    );
    expect(result.projection.payload.identityScopeKind).toBe('ACCOUNT');
  });

  it('B3: projects a two-sided transfer via its derived pair identity, direction-sensitive', () => {
    const destination = { lineKind: 'RDTE_PE' as const, peCode: '0605054A' };
    const result = buildStageActionProjectionV1(
      action({
        identity: undefined,
        sourceIdentity: PE_IDENTITY,
        destinationIdentity: destination,
      }),
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.nativeIdentityHash).toBe(
      phase6ActionScopeIdentityHashV1({
        kind: 'TRANSFER_PAIR',
        from: PE_IDENTITY,
        to: destination,
        fiscalYear: 2027,
        stage: 'hac_d',
      }),
    );
    // Swapping the endpoints must not hash the same — direction matters.
    expect(result.projection.nativeIdentityHash).not.toBe(
      phase6ActionScopeIdentityHashV1({
        kind: 'TRANSFER_PAIR',
        from: destination,
        to: PE_IDENTITY,
        fiscalYear: 2027,
        stage: 'hac_d',
      }),
    );
    expect(result.projection.payload.identityScopeKind).toBe('TRANSFER_PAIR');
  });

  it('B3: a native-line-identity action records identityScopeKind NATIVE_LINE', () => {
    const result = buildStageActionProjectionV1(action(), PROVENANCE, 'verified');
    if (!result.ok) throw new Error('expected ok');
    expect(result.projection.payload.identityScopeKind).toBe('NATIVE_LINE');
  });

  it('B3: still refuses a transfer naming only one endpoint, rather than inferring the other', () => {
    const result = buildStageActionProjectionV1(
      action({ identity: undefined, sourceIdentity: PE_IDENTITY }),
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('incomplete_transfer_endpoint');
  });

  it('B3: still refuses an action with no scope of any kind', () => {
    const result = buildStageActionProjectionV1(
      action({ identity: undefined }),
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('no_scope_present');
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

/* ------------------------------------------------------------------ */
/* B1 — enacted positions                                              */
/* ------------------------------------------------------------------ */

function enactedCandidate(overrides: Partial<EnactedLineCandidateV1> = {}): EnactedLineCandidateV1 {
  return {
    candidateId: 'enacted-1',
    identity: PE_IDENTITY,
    bindingStatus: 'accepted',
    fiscalYear: 2027,
    money: { originalValue: '200', originalUnit: 'millions', valueMillions: '200' },
    sourceDocumentId: 'doc-plaw',
    sourceSha256: SHA('e'),
    evidenceIds: ['ev-plaw-2', 'ev-plaw-1'],
    ...overrides,
  };
}

function enactmentProof(
  overrides: Partial<DefenseBudgetEnactmentProofV1> = {},
): DefenseBudgetEnactmentProofV1 {
  return {
    schemaVersion: 'defense_budget_enactment_proof_v1',
    proofId: 'proof-1',
    fiscalYear: 2027,
    publicLawNumber: '118-31',
    enactmentDate: '2027-12-15',
    billId: 'hr-1234',
    vehicleKind: 'full_year',
    publicLawSource: {
      manifestDocumentKey: 'plaw-doc',
      sourceDocumentId: 'doc-plaw',
      sourceSha256: SHA('f'),
      status: 'current',
    },
    lineDetailSource: {
      manifestDocumentKey: 'line-detail-doc',
      sourceDocumentId: 'doc-line',
      sourceSha256: SHA('9'),
      status: 'current',
    },
    proofType: 'statutory_line_item',
    vehicleProfileHash: SHA('1'),
    reviewerStatus: 'verified',
    explicitLineAuthority: false,
    ...overrides,
  };
}

describe('buildEnactedStagePositionProjectionV1 (Gap 5 decision B1)', () => {
  it('builds a schema-valid enacted stage_position, carrying the real proof', () => {
    const result = buildEnactedStagePositionProjectionV1(
      enactedCandidate(),
      'public_law',
      enactmentProof(),
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => phase6NativeProjectionV1Schema.parse(result.projection)).not.toThrow();
    expect(result.projection.fundingField).toBe('enacted');
    expect(result.projection.enactmentProofId).toBe('proof-1');
    expect(result.projection.payload.publicLawNumber).toBe('118-31');
    expect(result.projection.payload.enactmentProofType).toBe('statutory_line_item');
    expect(result.projection.payload.publicLawSourceSha256).toBe(SHA('f'));
    expect(result.projection.payload.lineDetailSourceSha256).toBe(SHA('9'));
  });

  it('refuses a candidate that is not accepted, rather than promoting an unverified enacted value', () => {
    const result = buildEnactedStagePositionProjectionV1(
      enactedCandidate({ bindingStatus: 'unresolved' }),
      'public_law',
      enactmentProof(),
      PROVENANCE,
      'candidate',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('candidate_not_accepted');
  });

  it('refuses a fiscal-year mismatch between proof and candidate', () => {
    const result = buildEnactedStagePositionProjectionV1(
      enactedCandidate({ fiscalYear: 2028 }),
      'public_law',
      enactmentProof({ fiscalYear: 2027 }),
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('proof_fiscal_year_mismatch');
  });

  it('refuses a continuing-resolution position whose proof has no explicit line authority', () => {
    const result = buildEnactedStagePositionProjectionV1(
      enactedCandidate(),
      'continuing_resolution',
      enactmentProof({ vehicleKind: 'continuing_resolution', explicitLineAuthority: false }),
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('continuing_resolution_without_explicit_line_authority');
  });

  it('accepts a continuing-resolution position when explicit line authority is proven', () => {
    const result = buildEnactedStagePositionProjectionV1(
      enactedCandidate(),
      'continuing_resolution',
      enactmentProof({ vehicleKind: 'continuing_resolution', explicitLineAuthority: true }),
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => phase6NativeProjectionV1Schema.parse(result.projection)).not.toThrow();
    expect(result.projection.payload.explicitLineAuthority).toBe(true);
  });

  it('does not invent a second proof model: the payload carries the same proof fields, nothing synthesized', () => {
    const proof = enactmentProof({ proofType: 'incorporated_table', publicLawNumber: '118-99' });
    const result = buildEnactedStagePositionProjectionV1(
      enactedCandidate(),
      'public_law',
      proof,
      PROVENANCE,
      'verified',
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.projection.payload.enactmentProofType).toBe(proof.proofType);
    expect(result.projection.payload.publicLawNumber).toBe(proof.publicLawNumber);
  });
});

/* ------------------------------------------------------------------ */
/* B2 — execution positions                                            */
/* ------------------------------------------------------------------ */

function executionComposition(
  overrides: Partial<NonNullable<ExecutionCompositionV1['executedPosition']>> = {},
): ExecutionCompositionV1 {
  const record: ExecutionCompositionV1['record'] = {
    schemaVersion: 'execution_record_v1',
    recordId: 'exec-rec-1',
    identity: PE_IDENTITY,
    metric: 'obligations',
    asOfDate: '2027-06-30',
    budgetFiscalYear: 2027,
    amount: { originalValue: '50', originalUnit: 'millions', valueMillions: '50' },
    sourceSystem: 'DAI',
    sourceDocumentId: 'doc-exec',
    sourceSha256: SHA('2'),
    evidenceIds: ['ev-exec-2', 'ev-exec-1'],
    cumulative: true,
  };
  return {
    schemaVersion: 'execution_composition_v1',
    record,
    metricFact: record,
    executedPosition: {
      projectionId: 'executed_test',
      field: 'executed',
      identity: PE_IDENTITY,
      fiscalYear: 2027,
      metric: 'obligations',
      money: record.amount,
      asOfDate: '2027-06-30',
      cumulative: true,
      canonicalWriteAllowed: false,
      ...overrides,
    },
  };
}

describe('buildExecutionStagePositionProjectionV1 (Gap 5 decision B2)', () => {
  it('builds a schema-valid execution stage_position, threading metric/asOfDate/cumulative', () => {
    const result = buildExecutionStagePositionProjectionV1(
      executionComposition(),
      PROVENANCE,
      'verified',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => phase6NativeProjectionV1Schema.parse(result.projection)).not.toThrow();
    expect(result.projection.stage).toBe('execution');
    expect(result.projection.track).toBe('post_enactment');
    expect(result.projection.payload.executionMetric).toBe('obligations');
    expect(result.projection.payload.asOfDate).toBe('2027-06-30');
    expect(result.projection.payload.cumulative).toBe(true);
  });

  it('carries the evidence from the underlying execution record, not an empty list', () => {
    const result = buildExecutionStagePositionProjectionV1(
      executionComposition(),
      PROVENANCE,
      'verified',
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.projection.evidenceIds).toEqual(['ev-exec-1', 'ev-exec-2']);
  });

  it('refuses when the composition has no executed position, rather than fabricating one', () => {
    const composition = executionComposition();
    composition.executedPosition = undefined;
    const result = buildExecutionStagePositionProjectionV1(composition, PROVENANCE, 'verified');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('no_executed_position');
  });

  it('uses no synonym for the existing metric vocabulary — the payload value is exactly the enum member', () => {
    const result = buildExecutionStagePositionProjectionV1(
      executionComposition({ metric: 'disbursements' }),
      PROVENANCE,
      'verified',
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.projection.payload.executionMetric).toBe('disbursements');
  });
});
