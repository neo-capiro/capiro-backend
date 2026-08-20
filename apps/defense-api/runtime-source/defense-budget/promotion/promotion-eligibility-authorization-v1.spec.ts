/** Phase 7 Workstream A — eligibility and authorization are two independent gates. */
import {
  defenseBudgetPromotionEligibilityV1Schema,
  evaluatePromotionEligibilityV1,
  isHighRiskExtractionMethodV1,
  promotionEligibilityHashV1,
  type DefenseBudgetPromotionEligibilityV1,
} from './promotion-eligibility-v1.js';
import {
  defenseBudgetPromotionAuthorizationV1Schema,
  deriveSegregationEvidenceV1,
  evaluatePromotionAuthorizationV1,
  type PromotionRedemptionContextV1,
} from './promotion-authorization-v1.js';

const FY = 2027;
const SHA = (c: string) => c.repeat(64);
const PLAN_HASH = SHA('1');
const ELIG_ID = 'elig-1';
const PLAN_ID = 'plan-1';
const NOW = new Date('2027-10-01T00:00:00.000Z');

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: 'cand-1',
    status: 'VERIFICATION_PASSED',
    terminalVerificationRunId: 'run-1',
    extractionMethod: 'deterministic_pdfplumber',
    family: 'committee',
    sourceProfileSha256: SHA('2'),
    extractorActorId: 'actor-extractor',
    acceptedAssertionIds: ['a-2', 'a-1'],
    artifactSha256: SHA('a'),
    sourceSha256: SHA('b'),
    ...overrides,
  };
}

function eligibilityRaw(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'defense_budget_promotion_eligibility_v2',
    eligibilityId: ELIG_ID,
    cycleId: 'cycle-fy2027',
    scope: { cycleId: 'cycle-fy2027', fiscalYear: FY, families: ['rdte'], stages: ['public_law'] },
    projectionPlanIds: ['pp-1'],
    projectionPlanHashes: [SHA('c')],
    mappingRegistryVersion: 'defense_budget_canonical_mapping_registry_v1',
    mappingRegistryHash: SHA('d'),
    candidates: [candidate()],
    sourceDocumentHashes: [SHA('e')],
    artifactHashes: [SHA('f')],
    manifestHash: SHA('0'),
    sourceProfileHashes: [SHA('2')],
    verificationPolicyHashes: [SHA('3')],
    cycleCertificationIds: ['cert-1'],
    cycleCertificationHashes: [SHA('4')],
    expectedActiveSnapshotId: 'snap-prev',
    expectedActiveSnapshotHash: SHA('5'),
    openConflictCount: 0,
    unsupportedItemCount: 0,
    generatedAt: '2027-09-30T00:00:00.000Z',
    ...overrides,
  };
}

function eligibility(overrides: Record<string, unknown> = {}): DefenseBudgetPromotionEligibilityV1 {
  return defenseBudgetPromotionEligibilityV1Schema.parse(eligibilityRaw(overrides));
}

/* ------------------------------------------------------------------ */
/* Gap 5 decision 2 — source profiles are required per family, and     */
/* absence is valid only where no governed profile artifact exists.    */
/* ------------------------------------------------------------------ */

describe('source profile requirement is family-aware', () => {
  it('accepts a Phase 1-5 promotion carrying no source profile at all', () => {
    // The state `.min(1)` used to make unrepresentable, and the reason earlier
    // attempts reached for a synthetic stand-in.
    expect(() =>
      eligibility({
        candidates: [candidate({ family: 'rdte', sourceProfileSha256: null })],
        sourceProfileHashes: [],
      }),
    ).not.toThrow();
  });

  it('refuses a governed family that carries no source profile', () => {
    expect(() =>
      eligibility({
        candidates: [candidate({ family: 'committee', sourceProfileSha256: null })],
        sourceProfileHashes: [],
      }),
    ).toThrow(/governed by a stage source profile/);
  });

  it('refuses an ungoverned family that carries one anyway', () => {
    // The fabrication direction. A stand-in hash for an RDT&E candidate is
    // exactly what decision 2 exists to prevent, and it is rejected structurally
    // rather than by review.
    expect(() =>
      eligibility({
        candidates: [candidate({ family: 'om', sourceProfileSha256: SHA('2') })],
        sourceProfileHashes: [SHA('2')],
      }),
    ).toThrow(/must carry null rather than a substitute hash/);
  });

  it('treats public_law as governed, not just committee', () => {
    expect(() =>
      eligibility({
        candidates: [candidate({ family: 'public_law', sourceProfileSha256: null })],
        sourceProfileHashes: [],
      }),
    ).toThrow(/governed by a stage source profile/);
  });

  it('refuses a record-level profile hash no candidate was extracted under', () => {
    expect(() =>
      eligibility({
        candidates: [candidate({ family: 'rdte', sourceProfileSha256: null })],
        sourceProfileHashes: [SHA('9')],
      }),
    ).toThrow(/which no candidate was extracted under/);
  });

  it('refuses a candidate profile the record-level set omits', () => {
    expect(() =>
      eligibility({
        candidates: [candidate({ family: 'committee', sourceProfileSha256: SHA('2') })],
        sourceProfileHashes: [],
      }),
    ).toThrow(/which sourceProfileHashes omits/);
  });

  it('still hashes deterministically with an empty profile set', () => {
    const a = eligibility({
      candidates: [candidate({ family: 'rdte', sourceProfileSha256: null })],
      sourceProfileHashes: [],
    });
    const b = eligibility({
      candidates: [candidate({ family: 'rdte', sourceProfileSha256: null })],
      sourceProfileHashes: [],
    });
    expect(promotionEligibilityHashV1(a)).toBe(promotionEligibilityHashV1(b));
  });

  it('hashes a profile-carrying record differently from a profile-free one', () => {
    const governed = eligibility();
    const ungoverned = eligibility({
      candidates: [candidate({ family: 'rdte', sourceProfileSha256: null })],
      sourceProfileHashes: [],
    });
    expect(promotionEligibilityHashV1(governed)).not.toBe(promotionEligibilityHashV1(ungoverned));
  });
});

function authorizationRaw(
  elig: DefenseBudgetPromotionEligibilityV1,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 'defense_budget_promotion_authorization_v1',
    authorizationId: 'auth-1',
    eligibilityHash: promotionEligibilityHashV1(elig),
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    scope: elig.scope,
    expectedActiveSnapshotId: elig.expectedActiveSnapshotId,
    authorizerActorId: 'actor-admin',
    reason: 'FY2027 enacted cycle promotion',
    issuedAt: '2027-09-30T12:00:00.000Z',
    expiresAt: '2027-10-02T12:00:00.000Z',
    segregation: deriveSegregationEvidenceV1(elig, 'actor-admin'),
    ...overrides,
  };
}

function redemption(
  elig: DefenseBudgetPromotionEligibilityV1,
  overrides: Partial<PromotionRedemptionContextV1> = {},
): PromotionRedemptionContextV1 {
  return {
    eligibility: elig,
    eligibilityHash: promotionEligibilityHashV1(elig),
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    actualActiveSnapshotId: elig.expectedActiveSnapshotId,
    alreadyUsed: false,
    now: NOW,
    ...overrides,
  };
}

describe('Phase 7 Workstream A — promotion eligibility', () => {
  it('accepts a machine-passed candidate', () => {
    const decision = evaluatePromotionEligibilityV1(eligibility());
    expect(decision.eligible).toBe(true);
    expect(decision.eligibilityHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts a review-accepted candidate that names its review decision', () => {
    const elig = eligibility({
      candidates: [
        candidate({
          status: 'REVIEW_ACCEPTED',
          reviewDecisionId: 'rev-1',
          reviewerActorId: 'actor-reviewer',
        }),
      ],
    });
    expect(evaluatePromotionEligibilityV1(elig).eligible).toBe(true);
  });

  it('refuses a REVIEW_ACCEPTED candidate with no review decision', () => {
    expect(() =>
      defenseBudgetPromotionEligibilityV1Schema.parse(
        eligibilityRaw({ candidates: [candidate({ status: 'REVIEW_ACCEPTED' })] }),
      ),
    ).toThrow();
  });

  it('refuses a superseded candidate', () => {
    expect(() =>
      defenseBudgetPromotionEligibilityV1Schema.parse(
        eligibilityRaw({ candidates: [candidate({ status: 'SUPERSEDED' })] }),
      ),
    ).toThrow();
  });

  it('refuses NEEDS_REVIEW and REJECTED candidates', () => {
    for (const status of ['NEEDS_REVIEW', 'REJECTED', 'EXTRACTED', 'STRUCTURALLY_VALIDATED']) {
      expect(() =>
        defenseBudgetPromotionEligibilityV1Schema.parse(
          eligibilityRaw({ candidates: [candidate({ status })] }),
        ),
      ).toThrow();
    }
  });

  it('blocks when the cycle certification is missing', () => {
    expect(() =>
      defenseBudgetPromotionEligibilityV1Schema.parse(
        eligibilityRaw({ cycleCertificationIds: [] }),
      ),
    ).toThrow();
  });

  it('blocks an open blocking conflict', () => {
    const decision = evaluatePromotionEligibilityV1(eligibility({ openConflictCount: 2 }));
    expect(decision.eligible).toBe(false);
    expect(decision.eligibilityHash).toBeNull();
    expect(decision.blocks.map((b) => b.reason)).toContain('open_blocking_conflict');
  });

  it('blocks an unsupported mapping instead of dropping it', () => {
    const decision = evaluatePromotionEligibilityV1(eligibility({ unsupportedItemCount: 1 }));
    expect(decision.eligible).toBe(false);
    expect(decision.blocks.map((b) => b.reason)).toContain('unsupported_mapping');
  });

  it('requires every projection plan to carry exactly one hash', () => {
    expect(() =>
      defenseBudgetPromotionEligibilityV1Schema.parse(
        eligibilityRaw({ projectionPlanIds: ['pp-1', 'pp-2'], projectionPlanHashes: [SHA('c')] }),
      ),
    ).toThrow();
  });

  it('refuses a half-stated active-snapshot expectation', () => {
    expect(() =>
      defenseBudgetPromotionEligibilityV1Schema.parse(
        eligibilityRaw({ expectedActiveSnapshotHash: null }),
      ),
    ).toThrow();
  });

  it('allows a baseline promotion with no predecessor snapshot', () => {
    const elig = eligibility({ expectedActiveSnapshotId: null, expectedActiveSnapshotHash: null });
    expect(evaluatePromotionEligibilityV1(elig).eligible).toBe(true);
  });

  it('produces the same hash when the inputs are reordered', () => {
    const a = eligibility();
    const b = eligibility({
      projectionPlanIds: ['pp-1'],
      cycleCertificationIds: ['cert-1'],
      candidates: [candidate({ acceptedAssertionIds: ['a-1', 'a-2'] })],
      sourceDocumentHashes: [SHA('e'), SHA('e')],
    });
    expect(promotionEligibilityHashV1(b)).toBe(promotionEligibilityHashV1(a));
  });

  it('produces a different hash when an accepted assertion list actually differs', () => {
    const a = eligibility();
    const b = eligibility({ candidates: [candidate({ acceptedAssertionIds: ['a-1', 'a-3'] })] });
    expect(promotionEligibilityHashV1(b)).not.toBe(promotionEligibilityHashV1(a));
  });

  it('classifies manual and OCR extraction as high risk', () => {
    expect(isHighRiskExtractionMethodV1('manual')).toBe(true);
    expect(isHighRiskExtractionMethodV1('paddleocr')).toBe(true);
    expect(isHighRiskExtractionMethodV1('llamaparse')).toBe(true);
    expect(isHighRiskExtractionMethodV1('deterministic_pdfplumber')).toBe(false);
  });
});

describe('Phase 7 Workstream A — promotion authorization', () => {
  it('authorizes an exact, unexpired, unused authorization', () => {
    const elig = eligibility();
    const auth = defenseBudgetPromotionAuthorizationV1Schema.parse(authorizationRaw(elig));
    const decision = evaluatePromotionAuthorizationV1(auth, redemption(elig));
    expect(decision.authorized).toBe(true);
    expect(decision.refusals).toEqual([]);
  });

  it('verification passing does not by itself authorize promotion', () => {
    // The eligibility record is fully eligible, yet nothing here can promote:
    // redemption requires an authorization object that eligibility never produces.
    const elig = eligibility();
    expect(evaluatePromotionEligibilityV1(elig).eligible).toBe(true);
    expect(Object.keys(elig)).not.toContain('authorizationId');
  });

  it('review acceptance does not by itself authorize promotion', () => {
    const elig = eligibility({
      candidates: [
        candidate({
          status: 'REVIEW_ACCEPTED',
          reviewDecisionId: 'rev-1',
          reviewerActorId: 'actor-reviewer',
        }),
      ],
    });
    expect(evaluatePromotionEligibilityV1(elig).eligible).toBe(true);
    expect(Object.keys(elig)).not.toContain('authorizationId');
  });

  it('refuses when the authorizer reviewed the same scope', () => {
    const elig = eligibility({
      candidates: [
        candidate({
          status: 'REVIEW_ACCEPTED',
          reviewDecisionId: 'rev-1',
          reviewerActorId: 'actor-admin',
        }),
      ],
    });
    expect(() => defenseBudgetPromotionAuthorizationV1Schema.parse(authorizationRaw(elig))).toThrow(
      /may not be a reviewer/,
    );
  });

  it('refuses when the authorizer extracted high-risk content in the same scope', () => {
    const elig = eligibility({
      candidates: [candidate({ extractionMethod: 'manual', extractorActorId: 'actor-admin' })],
    });
    expect(() => defenseBudgetPromotionAuthorizationV1Schema.parse(authorizationRaw(elig))).toThrow(
      /may not be the extractor/,
    );
  });

  it('allows the authorizer to be the extractor when the method is not high risk', () => {
    const elig = eligibility({
      candidates: [
        candidate({
          extractionMethod: 'deterministic_pdfplumber',
          family: 'committee',
          sourceProfileSha256: SHA('2'),
          extractorActorId: 'actor-admin',
        }),
      ],
    });
    expect(() =>
      defenseBudgetPromotionAuthorizationV1Schema.parse(authorizationRaw(elig)),
    ).not.toThrow();
  });

  it('refuses an expired authorization', () => {
    const elig = eligibility();
    const auth = defenseBudgetPromotionAuthorizationV1Schema.parse(
      authorizationRaw(elig, {
        issuedAt: '2027-09-01T00:00:00.000Z',
        expiresAt: '2027-09-02T00:00:00.000Z',
      }),
    );
    const decision = evaluatePromotionAuthorizationV1(auth, redemption(elig));
    expect(decision.authorized).toBe(false);
    expect(decision.refusals.map((r) => r.reason)).toContain('authorization_expired');
  });

  it('refuses an authorization that expires before it is issued', () => {
    const elig = eligibility();
    expect(() =>
      defenseBudgetPromotionAuthorizationV1Schema.parse(
        authorizationRaw(elig, { expiresAt: '2027-09-01T00:00:00.000Z' }),
      ),
    ).toThrow(/expire after/);
  });

  it('refuses a reused authorization', () => {
    const elig = eligibility();
    const auth = defenseBudgetPromotionAuthorizationV1Schema.parse(authorizationRaw(elig));
    const decision = evaluatePromotionAuthorizationV1(
      auth,
      redemption(elig, { alreadyUsed: true }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.refusals.map((r) => r.reason)).toContain('authorization_already_used');
  });

  it('refuses a plan hash mismatch', () => {
    const elig = eligibility();
    const auth = defenseBudgetPromotionAuthorizationV1Schema.parse(authorizationRaw(elig));
    const decision = evaluatePromotionAuthorizationV1(
      auth,
      redemption(elig, { planHash: SHA('9') }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.refusals.map((r) => r.reason)).toContain('plan_hash_mismatch');
  });

  it('refuses an eligibility hash mismatch', () => {
    const elig = eligibility();
    const auth = defenseBudgetPromotionAuthorizationV1Schema.parse(authorizationRaw(elig));
    const decision = evaluatePromotionAuthorizationV1(
      auth,
      redemption(elig, { eligibilityHash: SHA('8') }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.refusals.map((r) => r.reason)).toContain('eligibility_hash_mismatch');
  });

  it('refuses a stale expected-active-snapshot expectation', () => {
    const elig = eligibility();
    const auth = defenseBudgetPromotionAuthorizationV1Schema.parse(authorizationRaw(elig));
    const decision = evaluatePromotionAuthorizationV1(
      auth,
      redemption(elig, { actualActiveSnapshotId: 'snap-someone-else-activated' }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.refusals.map((r) => r.reason)).toContain('expected_active_snapshot_mismatch');
  });

  it('refuses a scope that does not equal the eligibility scope', () => {
    const elig = eligibility();
    const auth = defenseBudgetPromotionAuthorizationV1Schema.parse(
      authorizationRaw(elig, {
        scope: {
          cycleId: 'cycle-fy2027',
          fiscalYear: FY,
          families: ['rdte', 'procurement'],
          stages: ['public_law'],
        },
      }),
    );
    const decision = evaluatePromotionAuthorizationV1(auth, redemption(elig));
    expect(decision.authorized).toBe(false);
    expect(decision.refusals.map((r) => r.reason)).toContain('scope_mismatch');
  });

  it('reports every refusal, not just the first', () => {
    const elig = eligibility();
    const auth = defenseBudgetPromotionAuthorizationV1Schema.parse(authorizationRaw(elig));
    const decision = evaluatePromotionAuthorizationV1(
      auth,
      redemption(elig, {
        planHash: SHA('9'),
        alreadyUsed: true,
        actualActiveSnapshotId: 'snap-other',
      }),
    );
    expect(decision.refusals.map((r) => r.reason).sort()).toEqual(
      [
        'authorization_already_used',
        'expected_active_snapshot_mismatch',
        'plan_hash_mismatch',
      ].sort(),
    );
  });

  it('is immutable once parsed: an altered copy no longer matches its own hash binding', () => {
    const elig = eligibility();
    const auth = defenseBudgetPromotionAuthorizationV1Schema.parse(authorizationRaw(elig));
    const tampered = { ...auth, planHash: SHA('9') };
    const decision = evaluatePromotionAuthorizationV1(tampered, redemption(elig));
    expect(decision.authorized).toBe(false);
  });
});
