/**
 * Phase 6 Workstream A — stage source profile contract tests.
 *
 * Covers: valid track/stage/authority combinations, impossible combinations,
 * request-baseline ownership prohibition, profile-hash stability, companion
 * document enforcement, execution-metric requirement, and public-law enactment
 * proof requirement.
 */
import {
  DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
  defenseBudgetStageSourceProfileV1Schema,
  parseStageSourceProfileV1,
  requestOwnershipAllowedForAuthority,
  stageSourceProfileHashV1,
  validateStageSourceProfileV1,
  type DefenseBudgetStageSourceProfileV1,
} from './stage-source-profile-v1.js';
import {
  STAGE_AUTHORITY_V1_VALUES,
  STAGE_TRACK,
  STAGE_CHAMBER,
  type StageAuthorityV1,
  type StageV1,
} from './stage-vocabulary-v1.js';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

function baseProfile(
  overrides: Partial<DefenseBudgetStageSourceProfileV1> = {},
): DefenseBudgetStageSourceProfileV1 {
  return {
    schemaVersion: DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
    profileId: 'fy2026-hasc-rdte',
    profileVersion: 1,
    track: 'authorization',
    stage: 'hasc',
    authority: 'hasc_authorization',
    fiscalYear: 2026,
    vehicleClass: 'committee_report',
    chamber: 'house',
    sourceDocumentKeys: ['fy2026-hasc-report'],
    companionDocuments: [],
    requiredLineFamilies: ['rdte_pe', 'procurement_blin'],
    tableSemanticsPolicy: 'header_required',
    declaredUnits: ['millions'],
    requiredComparisonStages: ['sasc', 'ndaa_conference'],
    enactmentProofRequirement: 'not_required',
    absenceAllowed: true,
    ...overrides,
  };
}

function publicLawProfile(
  overrides: Partial<DefenseBudgetStageSourceProfileV1> = {},
): DefenseBudgetStageSourceProfileV1 {
  return baseProfile({
    profileId: 'fy2026-public-law',
    track: 'appropriations',
    stage: 'public_law',
    authority: 'enacted_public_law',
    chamber: 'none',
    vehicleClass: 'public_law',
    publicLawNumber: 'P.L. 119-50',
    billId: 'H.R. 5000',
    reportNumber: 'H. Rept. 119-200',
    requiredLineFamilies: ['rdte_pe'],
    requiredComparisonStages: ['appropriations_conference'],
    enactmentProofRequirement: 'statutory_or_incorporated',
    companionDocuments: [
      {
        companionKind: 'joint_explanatory_statement',
        manifestDocumentKey: 'fy2026-jes',
        required: true,
      },
    ],
    ...overrides,
  });
}

function executionProfile(
  overrides: Partial<DefenseBudgetStageSourceProfileV1> = {},
): DefenseBudgetStageSourceProfileV1 {
  return baseProfile({
    profileId: 'fy2026-execution-q3',
    track: 'post_enactment',
    stage: 'execution',
    authority: 'execution',
    chamber: 'none',
    vehicleClass: 'execution_report',
    requiredLineFamilies: ['rdte_pe'],
    requiredComparisonStages: [],
    executionMetricPolicy: {
      metric: 'obligations',
      requiresAsOfDate: true,
      requiresCumulativeFlag: true,
    },
    ...overrides,
  });
}

/* ------------------------------------------------------------------ */
/* valid combinations                                                  */
/* ------------------------------------------------------------------ */

describe('stage source profile — valid combinations', () => {
  it('accepts the HASC authorization profile', () => {
    const result = validateStageSourceProfileV1(baseProfile());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.ownedField).toBe('hascMark');
  });

  it('accepts SASC, HAC-D, SAC-D, NDAA conference, and appropriations conference', () => {
    const cases: Array<{
      stage: StageV1;
      authority: StageAuthorityV1;
      track: DefenseBudgetStageSourceProfileV1['track'];
      chamber: DefenseBudgetStageSourceProfileV1['chamber'];
      vehicles: DefenseBudgetStageSourceProfileV1['vehicleClass'][];
      field: string;
      ids?: Partial<DefenseBudgetStageSourceProfileV1>;
    }> = [
      {
        stage: 'sasc',
        authority: 'sasc_authorization',
        track: 'authorization',
        chamber: 'senate',
        vehicles: ['committee_report'],
        field: 'sascMark',
      },
      {
        stage: 'ndaa_conference',
        authority: 'ndaa_conference_authorization',
        track: 'authorization',
        chamber: 'joint',
        vehicles: ['conference_report', 'joint_explanatory_statement'],
        field: 'ndaaConference',
        ids: { billId: 'S. 2500', reportNumber: 'S. Rept. 119-45' },
      },
      {
        stage: 'hac_d',
        authority: 'hacd_appropriations',
        track: 'appropriations',
        chamber: 'house',
        vehicles: ['committee_report'],
        field: 'hacDMark',
      },
      {
        stage: 'sac_d',
        authority: 'sacd_appropriations',
        track: 'appropriations',
        chamber: 'senate',
        vehicles: ['committee_report'],
        field: 'sacDMark',
      },
      {
        stage: 'appropriations_conference',
        authority: 'appropriations_conference',
        track: 'appropriations',
        chamber: 'joint',
        vehicles: ['conference_report', 'joint_explanatory_statement'],
        field: 'conference',
        ids: { billId: 'H.R. 5000', reportNumber: 'H. Rept. 119-200' },
      },
    ];

    for (const c of cases) {
      const profile = baseProfile({
        profileId: `test-${c.stage}`,
        stage: c.stage,
        authority: c.authority,
        track: c.track,
        chamber: c.chamber,
        ...(c.ids ?? {}),
      });
      for (const vehicle of c.vehicles) {
        const result = validateStageSourceProfileV1({ ...profile, vehicleClass: vehicle });
        expect({ stage: c.stage, vehicle, ok: result.ok, errors: result.errors }).toEqual({
          stage: c.stage,
          vehicle,
          ok: true,
          errors: [],
        });
        expect(result.ownedField).toBe(c.field);
      }
    }
  });

  it('accepts a valid public-law profile with enactment proof', () => {
    const result = validateStageSourceProfileV1(publicLawProfile());
    expect(result.ok).toBe(true);
    expect(result.ownedField).toBe('enacted');
  });

  it('accepts a continuing-resolution profile with totals-only semantics', () => {
    const profile = baseProfile({
      profileId: 'fy2026-cr1',
      track: 'appropriations',
      stage: 'continuing_resolution',
      authority: 'continuing_resolution',
      chamber: 'none',
      vehicleClass: 'continuing_resolution',
      tableSemanticsPolicy: 'totals_only',
      requiredLineFamilies: ['classified'],
      enactmentProofRequirement: 'statutory_or_incorporated',
    });
    const result = validateStageSourceProfileV1(profile);
    expect(result.ok).toBe(true);
    expect(result.ownedField).toBe('enacted');
  });

  it('accepts a reprogramming profile', () => {
    const profile = baseProfile({
      profileId: 'fy2026-rp-001',
      track: 'post_enactment',
      stage: 'reprogramming',
      authority: 'reprogramming',
      chamber: 'none',
      vehicleClass: 'reprogramming_action',
      requiredLineFamilies: ['rdte_pe'],
      requiredComparisonStages: [],
    });
    const result = validateStageSourceProfileV1(profile);
    expect(result.ok).toBe(true);
    expect(result.ownedField).toBe('reprogrammed');
  });

  it('accepts an execution profile with an explicit metric', () => {
    const result = validateStageSourceProfileV1(executionProfile());
    expect(result.ok).toBe(true);
    expect(result.ownedField).toBe('executed');
  });
});

/* ------------------------------------------------------------------ */
/* impossible combinations                                             */
/* ------------------------------------------------------------------ */

describe('stage source profile — impossible combinations rejected', () => {
  it('rejects HASC on an appropriations vehicle', () => {
    const result = validateStageSourceProfileV1(
      baseProfile({ vehicleClass: 'committee_report', track: 'appropriations' }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/track/);
  });

  it('rejects HAC-D mapped to an authorization field', () => {
    const result = validateStageSourceProfileV1(
      baseProfile({
        stage: 'hac_d',
        authority: 'hasc_authorization',
        track: 'authorization',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/requires authority 'hacd_appropriations'/);
  });

  it('rejects a public law with committee-report authority', () => {
    const result = validateStageSourceProfileV1(
      publicLawProfile({ authority: 'hasc_authorization' }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/enacted_public_law/);
  });

  it('rejects NDAA conference mapped to the appropriations conference stage', () => {
    // NDAA conference authority cannot govern appropriations_conference stage.
    const result = validateStageSourceProfileV1(
      publicLawProfile({
        stage: 'appropriations_conference',
        authority: 'ndaa_conference_authorization',
        chamber: 'joint',
        track: 'appropriations',
        billId: 'H.R. 5000',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/requires authority 'appropriations_conference'/);
  });

  it('rejects an execution source with no metric policy', () => {
    const profile = executionProfile();
    delete (profile as Partial<DefenseBudgetStageSourceProfileV1>).executionMetricPolicy;
    const result = validateStageSourceProfileV1(profile);
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/executionMetricPolicy/);
  });

  it('rejects wrong chamber for a stage', () => {
    const result = validateStageSourceProfileV1(baseProfile({ chamber: 'senate' }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/chamber/);
  });

  it('rejects a committee report vehicle for the public-law stage', () => {
    const result = validateStageSourceProfileV1(
      publicLawProfile({ vehicleClass: 'committee_report' }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/forbids vehicle class/);
  });

  it('rejects a public law without publicLawNumber', () => {
    const result = validateStageSourceProfileV1(publicLawProfile({ publicLawNumber: undefined }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/publicLawNumber/);
  });

  it('rejects a continuing resolution with header_required semantics', () => {
    const profile = baseProfile({
      profileId: 'fy2026-cr-bad',
      track: 'appropriations',
      stage: 'continuing_resolution',
      authority: 'continuing_resolution',
      chamber: 'none',
      vehicleClass: 'continuing_resolution',
      tableSemanticsPolicy: 'header_required',
      requiredLineFamilies: ['classified'],
      enactmentProofRequirement: 'statutory_or_incorporated',
    });
    const result = validateStageSourceProfileV1(profile);
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/totals_only/);
  });

  it('rejects an executionMetricPolicy on a non-execution stage', () => {
    const result = validateStageSourceProfileV1(
      baseProfile({
        executionMetricPolicy: {
          metric: 'outlays',
          requiresAsOfDate: true,
          requiresCumulativeFlag: true,
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/only valid for the execution stage/);
  });

  it('rejects a profile with an empty sourceDocumentKeys list', () => {
    const result = validateStageSourceProfileV1(baseProfile({ sourceDocumentKeys: [] }));
    expect(result.ok).toBe(false);
  });

  it('rejects a profile with no declared units', () => {
    const result = validateStageSourceProfileV1(baseProfile({ declaredUnits: [] }));
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* request ownership prohibition                                       */
/* ------------------------------------------------------------------ */

describe('stage source profile — request ownership', () => {
  it('never allows request ownership for any Phase 6 authority', () => {
    for (const authority of STAGE_AUTHORITY_V1_VALUES) {
      expect(requestOwnershipAllowedForAuthority(authority)).toBe(false);
    }
  });

  it('no stage authority owns the request field', () => {
    const stages = Object.keys(STAGE_TRACK) as StageV1[];
    for (const stage of stages) {
      const profile = validateStageSourceProfileV1(baseProfile({ stage }));
      if (profile.ok && profile.ownedField !== undefined) {
        expect({ stage, field: profile.ownedField }).not.toEqual({
          stage,
          field: 'request',
        });
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* profile hash                                                        */
/* ------------------------------------------------------------------ */

describe('stage source profile — hash', () => {
  it('is stable under key-order variation', () => {
    const a = baseProfile();
    const b = Object.fromEntries(Object.entries(a).reverse());
    expect(stageSourceProfileHashV1(a)).toBe(
      stageSourceProfileHashV1(defenseBudgetStageSourceProfileV1Schema.parse(b)),
    );
  });

  it('changes when the fiscal year changes', () => {
    const a = baseProfile();
    const b = baseProfile({ fiscalYear: 2027 });
    expect(stageSourceProfileHashV1(a)).not.toBe(stageSourceProfileHashV1(b));
  });

  it('is a 64-char lowercase hex digest', () => {
    expect(stageSourceProfileHashV1(baseProfile())).toMatch(/^[a-f0-9]{64}$/);
  });
});

/* ------------------------------------------------------------------ */
/* companion documents                                                 */
/* ------------------------------------------------------------------ */

describe('stage source profile — companion documents', () => {
  it('validates companion document structure', () => {
    const profile = publicLawProfile();
    expect(profile.companionDocuments).toHaveLength(1);
    expect(profile.companionDocuments[0]!.required).toBe(true);
  });

  it('rejects companion documents with blank manifest keys', () => {
    const result = validateStageSourceProfileV1(
      publicLawProfile({
        companionDocuments: [
          { companionKind: 'joint_explanatory_statement', manifestDocumentKey: '', required: true },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/companionDocuments/);
  });
});

/* ------------------------------------------------------------------ */
/* enactment proof requirement                                         */
/* ------------------------------------------------------------------ */

describe('stage source profile — enactment proof', () => {
  it('requires enactment proof for public-law profiles', () => {
    const result = validateStageSourceProfileV1(
      publicLawProfile({ enactmentProofRequirement: 'not_required' }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/statutory_or_incorporated/);
  });

  it('does not require enactment proof for committee stages', () => {
    const result = validateStageSourceProfileV1(baseProfile());
    expect(result.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* parse helper                                                        */
/* ------------------------------------------------------------------ */

describe('parseStageSourceProfileV1', () => {
  it('returns the parsed profile when valid', () => {
    const profile = parseStageSourceProfileV1(baseProfile());
    expect(profile.stage).toBe('hasc');
    expect(profile.authority).toBe('hasc_authorization');
  });

  it('throws with semantic errors when invalid', () => {
    expect(() => parseStageSourceProfileV1(baseProfile({ track: 'appropriations' }))).toThrow(
      /invalid stage source profile/,
    );
  });
});
