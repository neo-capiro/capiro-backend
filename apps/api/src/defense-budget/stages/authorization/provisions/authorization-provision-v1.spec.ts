import type { BudgetLineIdentityV1 } from '../../../contracts/extraction-artifact-v1.js';
import {
  authorizationProvisionV1Schema,
  parseAuthorizationProvisionProjectionPlanV1,
  type AuthorizationProvisionExtractionResultV1,
  type AuthorizationProvisionNativeIndexV1,
  type AuthorizationProvisionV1,
  type ProvisionReferenceV1,
} from './authorization-provision-v1.js';
import { composeAuthorizationProvisionProjectionV1 } from './authorization-provision-linker-v1.js';

const SHA = 'a'.repeat(64);
const PE: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0605053A' };
const PROCUREMENT: BudgetLineIdentityV1 = {
  lineKind: 'PROCUREMENT_BLIN',
  code: 'W12002',
  account: '2035A',
  component: 'ARMY',
};
const OM: BudgetLineIdentityV1 = {
  lineKind: 'OM_SAG',
  code: '121',
  account: '2020A',
  component: 'ARMY',
};
const MILCON: BudgetLineIdentityV1 = {
  lineKind: 'MILCON_PROJECT',
  projectCode: 'PN12345',
  component: 'AF',
  location: 'Eglin AFB',
};

const INDEX: AuthorizationProvisionNativeIndexV1 = {
  budgetLines: [
    { identity: PE, title: 'Ground Robotics' },
    { identity: PROCUREMENT, title: 'Robotics and Applique Systems' },
    { identity: OM, title: 'Operating Forces' },
    { identity: MILCON, title: 'Advanced Test Facility' },
  ],
  projects: [
    {
      parentPeCode: '0605053A',
      projectCode: 'TRX-01',
      title: 'Autonomy Integration',
    },
  ],
  reviewedAliases: [],
};

function provision(
  references: ProvisionReferenceV1[],
  overrides: Partial<AuthorizationProvisionV1> = {},
): AuthorizationProvisionV1 {
  return authorizationProvisionV1Schema.parse({
    schemaVersion: 'authorization_provision_v1',
    provisionId: 'provision-1',
    track: 'authorization',
    stage: 'hasc',
    committee: 'HASC',
    authority: 'hasc_authorization',
    fiscalYear: 2027,
    profileId: 'fy2027-hasc-authorization-report',
    sourceDocumentId: 'source-hasc-fy2027',
    sourceSha256: SHA,
    heading: 'Ground Robotics',
    fullText: 'The committee directs the Secretary to provide a briefing.',
    pageRange: { startPage: 40, endPage: 40, printedStart: 'p. 40', printedEnd: 'p. 40' },
    actionType: 'directs_briefing',
    references,
    scope: 'line_specific',
    evidenceIds: ['evidence-1'],
    ...overrides,
  });
}

function extraction(
  provisions: AuthorizationProvisionV1[],
  overrides: Partial<AuthorizationProvisionExtractionResultV1> = {},
): AuthorizationProvisionExtractionResultV1 {
  const ids = [...new Set(provisions.flatMap((item) => item.evidenceIds))];
  return {
    schemaVersion: 'authorization_provision_extraction_result_v1',
    stage: 'hasc',
    profileId: 'fy2027-hasc-authorization-report',
    sourceDocumentId: 'source-hasc-fy2027',
    sourceSha256: SHA,
    provisions,
    evidence: ids.map((evidenceId, index) => ({
      evidenceId,
      sourceSha256: SHA,
      page: index === 0 ? 40 : 41,
      blockIndex: index,
      granularity: 'page_only',
      excerpt: `evidence ${index}`,
    })),
    warnings: [],
    omittedPages: [],
    ...overrides,
  };
}

function compose(
  provisions: AuthorizationProvisionV1[],
  index: AuthorizationProvisionNativeIndexV1 = INDEX,
  overrides: Partial<AuthorizationProvisionExtractionResultV1> = {},
) {
  return composeAuthorizationProvisionProjectionV1({
    extraction: extraction(provisions, overrides),
    index,
  });
}

describe('authorization provision V1', () => {
  it('accepts an exact PE code link', () => {
    const result = compose([provision([{ referenceKind: 'pe_code', peCode: '0605053A' }])]);
    expect(result.verification.status).toBe('PASS');
    expect(result.acceptedLinks).toHaveLength(1);
    expect(result.acceptedLinks[0]).toMatchObject({
      status: 'accepted',
      matchBasis: 'exact_pe_code',
      target: { targetKind: 'budget_line', identity: PE },
    });
  });

  it('accepts a project only by exact project code under exact PE', () => {
    const accepted = compose([
      provision([{ referenceKind: 'rdte_project', peCode: '0605053A', projectCode: 'TRX-01' }]),
    ]);
    expect(accepted.acceptedLinks[0]).toMatchObject({
      matchBasis: 'exact_project_code',
      target: {
        targetKind: 'rdte_project',
        parentPeCode: '0605053A',
        projectCode: 'TRX-01',
      },
    });

    const rejected = compose([
      provision([{ referenceKind: 'rdte_project', peCode: '0603270A', projectCode: 'TRX-01' }]),
    ]);
    expect(rejected.verification.status).toBe('BLOCKED');
    expect(rejected.acceptedLinks).toHaveLength(0);
  });

  it('accepts exact procurement, O&M, and MILCON native references', () => {
    const result = compose([
      provision([
        {
          referenceKind: 'procurement_line',
          code: 'W12002',
          account: '2035A',
          component: 'ARMY',
        },
        {
          referenceKind: 'om_sag',
          code: '121',
          account: '2020A',
          component: 'ARMY',
        },
        {
          referenceKind: 'milcon_project',
          projectCode: 'PN12345',
          component: 'AF',
          location: 'Eglin AFB',
        },
      ]),
    ]);
    expect(result.acceptedLinks).toHaveLength(3);
    expect(result.acceptedLinks.every((link) => link.matchBasis === 'exact_native_reference')).toBe(
      true,
    );
  });

  it('keeps a title-only match candidate-only', () => {
    const result = compose([
      provision([{ referenceKind: 'title_only', title: 'Ground Robotics' }]),
    ]);
    expect(result.verification.status).toBe('REVIEW');
    expect(result.acceptedLinks).toHaveLength(0);
    expect(result.candidateLinks).toHaveLength(1);
    expect(result.candidateLinks[0]).toMatchObject({
      status: 'candidate',
      matchBasis: 'title_only',
    });
    expect(result.reviewQueue[0]?.status).toBe('candidate');
  });

  it('requires and propagates a program-wide attribution caveat', () => {
    expect(() =>
      provision([{ referenceKind: 'pe_code', peCode: '0605053A' }], {
        scope: 'program_wide',
        attributionCaveat: undefined,
      }),
    ).toThrow(/attributionCaveat/);

    const result = compose([
      provision([{ referenceKind: 'pe_code', peCode: '0605053A' }], {
        scope: 'program_wide',
        attributionCaveat: 'Program-wide language; do not attribute to one line without review.',
      }),
    ]);
    expect(result.acceptedLinks[0]?.attributionCaveat).toContain('Program-wide');
  });

  it('preserves explicit deadline and reporting-recipient fields', () => {
    const item = provision([{ referenceKind: 'pe_code', peCode: '0605053A' }], {
      deadline: {
        kind: 'date',
        rawText: 'not later than March 15, 2027',
        isoDate: '2027-03-15',
      },
      reportingRecipient: {
        rawText: 'congressional defense committees',
        normalized: 'congressional defense committees',
      },
    });
    expect(item.deadline).toMatchObject({ kind: 'date', isoDate: '2027-03-15' });
    expect(item.reportingRecipient?.normalized).toBe('congressional defense committees');
  });

  it('blocks an accepted link when a physical page is missing', () => {
    const item = provision([{ referenceKind: 'pe_code', peCode: '0605053A' }], {
      pageRange: { startPage: 40, endPage: 42 },
      evidenceIds: ['evidence-1', 'evidence-2'],
    });
    const result = compose([item], INDEX, {
      evidence: [
        {
          evidenceId: 'evidence-1',
          sourceSha256: SHA,
          page: 40,
          blockIndex: 0,
          granularity: 'page_only',
          excerpt: 'start',
        },
        {
          evidenceId: 'evidence-2',
          sourceSha256: SHA,
          page: 42,
          blockIndex: 1,
          granularity: 'page_only',
          excerpt: 'end',
        },
      ],
      omittedPages: [41],
    });
    expect(result.verification.status).toBe('BLOCKED');
    expect(result.acceptedLinks).toHaveLength(0);
    expect(result.reviewQueue[0]).toMatchObject({ reason: 'missing_evidence' });
  });

  it('composes identical duplicate provisions once', () => {
    const first = provision([{ referenceKind: 'pe_code', peCode: '0605053A' }]);
    const second = provision([{ referenceKind: 'pe_code', peCode: '0605053A' }], {
      provisionId: 'provision-2',
    });
    const result = compose([first, second]);
    expect(result.verification.status).toBe('PASS');
    expect(result.provisions).toHaveLength(1);
    expect(result.acceptedLinks).toHaveLength(1);
  });

  it('blocks conflicting duplicate provisions', () => {
    const first = provision([{ referenceKind: 'pe_code', peCode: '0605053A' }]);
    const second = provision([{ referenceKind: 'pe_code', peCode: '0605053A' }], {
      provisionId: 'provision-2',
      fullText: 'The committee prohibits obligation of funds.',
      actionType: 'restricts',
    });
    const result = compose([first, second]);
    expect(result.verification.status).toBe('BLOCKED');
    expect(result.provisions).toHaveLength(0);
    expect(result.acceptedLinks).toHaveLength(0);
    expect(result.reviewQueue).toHaveLength(2);
    expect(result.reviewQueue.every((entry) => entry.reason === 'duplicate_conflict')).toBe(true);
  });

  it('accepts only an explicitly reviewed alias target', () => {
    const result = compose(
      [
        provision([], {
          heading: 'GR autonomy',
          fullText: 'The committee encourages GR autonomy testing.',
        }),
      ],
      {
        ...INDEX,
        reviewedAliases: [
          {
            alias: 'GR autonomy',
            target: { targetKind: 'budget_line', identity: PE },
            reviewId: 'alias-review-1',
          },
        ],
      },
    );
    expect(result.acceptedLinks).toHaveLength(1);
    expect(result.acceptedLinks[0]).toMatchObject({
      matchBasis: 'reviewed_alias',
      reviewId: 'alias-review-1',
    });
  });

  it('keeps report-language output separate from funding assertions and legacy mutations', () => {
    const result = compose([provision([{ referenceKind: 'pe_code', peCode: '0605053A' }])]);
    expect(result.writeMode).toBe('projection_only');
    expect(result.canonicalWriteAllowed).toBe(false);
    expect(result.legacyProvisionMutationAllowed).toBe(false);
    const serialized = JSON.stringify(result);
    for (const fundingField of ['hascMark', 'sascMark', 'request', 'enacted']) {
      expect(serialized).not.toContain(`"field":"${fundingField}"`);
    }
    expect(parseAuthorizationProvisionProjectionPlanV1(result)).toEqual(result);
  });

  it('replays deterministically', () => {
    const input = [provision([{ referenceKind: 'pe_code', peCode: '0605053A' }])];
    expect(JSON.stringify(compose(input))).toBe(JSON.stringify(compose(input)));
  });
});
