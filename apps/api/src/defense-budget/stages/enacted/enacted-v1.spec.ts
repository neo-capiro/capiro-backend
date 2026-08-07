import type {
  BudgetLineIdentityV1,
  ExtractionSourceV1,
  SourceEvidenceV1,
} from '../../contracts/extraction-artifact-v1.js';
import { stageSourceProfileHashV1 } from '../stage-source-profile-v1.js';
import { createEnactedPublicLawSourceProfileV1 } from './enacted-source-profile-v1.js';
import {
  composeEnactedStageV1,
  continuingResolutionPeriodRecordV1,
} from './enacted-composer-v1.js';
import {
  defenseBudgetEnactmentProofV1Schema,
  type DefenseBudgetEnactmentProofV1,
  type EnactedLineCandidateV1,
} from './enactment-proof-v1.js';

const FY = 2027;
const PL_SHA = 'a'.repeat(64);
const LINE_SHA = 'b'.repeat(64);
const PE: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0605053A' };
const profile = createEnactedPublicLawSourceProfileV1({
  fiscalYear: FY,
  publicLawNumber: 'P.L. 119-99',
  billId: 'H.R. 5001',
  publicLawDocumentKey: 'pl',
  lineDetailDocumentKey: 'jes',
});

function source(input: {
  manifestDocumentKey: string;
  sourceDocumentId: string;
  sha: string;
  locator: string;
  documentType: string;
}): ExtractionSourceV1 {
  return {
    manifestDocumentKey: input.manifestDocumentKey,
    sourceDocumentId: input.sourceDocumentId,
    sourcePdfSha256: input.sha,
    sourceLocator: input.locator,
    fiscalYear: FY,
    family: 'public_law',
    exhibit: 'public_law',
    authority: 'public_law',
    component: 'DW',
    budgetCycle: 'fy2027',
    documentType: input.documentType,
  };
}
const publicLawSource = source({
  manifestDocumentKey: 'pl',
  sourceDocumentId: 'pl-source',
  sha: PL_SHA,
  locator: 'fixture://pl',
  documentType: 'public_law',
});
const lineDetailSource = source({
  manifestDocumentKey: 'jes',
  sourceDocumentId: 'jes-source',
  sha: LINE_SHA,
  locator: 'fixture://jes',
  documentType: 'incorporated_explanatory_statement',
});
function evidenceFor(sha: string): SourceEvidenceV1[] {
  return [
    {
      evidenceId: 'line-e1',
      sourcePdfSha256: sha,
      parserRunId: 'input-run-id-is-rebound-for-manual-composition',
      granularity: 'page_only',
      page: 10,
    },
  ];
}
const candidate: EnactedLineCandidateV1 = {
  candidateId: 'c1',
  identity: PE,
  bindingStatus: 'accepted',
  fiscalYear: FY,
  money: { originalValue: '125', originalUnit: 'millions', valueMillions: '125' },
  sourceDocumentId: 'jes-source',
  sourceSha256: LINE_SHA,
  evidenceIds: ['line-e1'],
  division: 'Division A',
};
function proof(overrides: Partial<DefenseBudgetEnactmentProofV1> = {}): DefenseBudgetEnactmentProofV1 {
  return defenseBudgetEnactmentProofV1Schema.parse({
    schemaVersion: 'defense_budget_enactment_proof_v1',
    proofId: 'proof-1',
    fiscalYear: FY,
    publicLawNumber: 'P.L. 119-99',
    enactmentDate: '2027-09-30',
    billId: 'H.R. 5001',
    vehicleKind: 'full_year',
    division: 'Division A',
    publicLawSource: {
      manifestDocumentKey: 'pl',
      sourceDocumentId: 'pl-source',
      sourceSha256: PL_SHA,
      status: 'current',
    },
    lineDetailSource: {
      manifestDocumentKey: 'jes',
      sourceDocumentId: 'jes-source',
      sourceSha256: LINE_SHA,
      status: 'current',
    },
    proofType: 'incorporated_explanatory_statement',
    incorporationEvidence: {
      citation: 'Sec. 4 incorporates the explanatory statement',
      sourceDocumentId: 'pl-source',
      sourceSha256: PL_SHA,
      evidenceIds: ['inc-e1'],
    },
    vehicleProfileHash: stageSourceProfileHashV1(profile),
    reviewerStatus: 'verified',
    explicitLineAuthority: false,
    ...overrides,
  });
}
function compose(
  p: DefenseBudgetEnactmentProofV1,
  c: EnactedLineCandidateV1 = candidate,
  sources: {
    publicLawSource?: ExtractionSourceV1;
    lineDetailSource?: ExtractionSourceV1;
    lineDetailEvidence?: SourceEvidenceV1[];
  } = {},
) {
  return composeEnactedStageV1({
    profile,
    publicLawSource: sources.publicLawSource ?? publicLawSource,
    lineDetailSource: sources.lineDetailSource ?? lineDetailSource,
    parserRuns: [],
    lineDetailEvidence: sources.lineDetailEvidence ?? evidenceFor(LINE_SHA),
    proof: p,
    candidates: [c],
  });
}

describe('Phase 6 Workstream L enactment proof', () => {
  it('allows a direct statutory line from the public-law bytes', () => {
    const p = proof({
      proofType: 'statutory_line_item',
      lineDetailSource: {
        manifestDocumentKey: 'pl',
        sourceDocumentId: 'pl-source',
        sourceSha256: PL_SHA,
        status: 'current',
      },
      incorporationEvidence: undefined,
    });
    const c = {
      ...candidate,
      sourceDocumentId: 'pl-source',
      sourceSha256: PL_SHA,
    };
    const result = compose(p, c, {
      lineDetailSource: publicLawSource,
      lineDetailEvidence: evidenceFor(PL_SHA),
    });
    expect(
      result.artifact.assertions.some(
        (a) => a.assertionKind === 'funding' && a.field === 'enacted',
      ),
    ).toBe(true);
    expect(result.artifact.source.sourcePdfSha256).toBe(PL_SHA);
  });

  it('allows a valid incorporated explanatory statement with independent hashes', () => {
    const result = compose(proof());
    expect(result.coverage.incorporatedStatement).toBe(1);
    expect(result.artifact.source.sourcePdfSha256).toBe(LINE_SHA);
    expect(
      result.artifact.assertions.some(
        (a) => a.assertionKind === 'funding' && a.field === 'enacted',
      ),
    ).toBe(true);
    const proofFact = result.artifact.assertions.find(
      (a) =>
        a.assertionKind === 'document_fact' &&
        a.fieldName === 'defense_budget_enactment_proof_v1',
    );
    expect(proofFact?.evidenceIds).toEqual([]);
  });

  it('rejects missing incorporation evidence', () => {
    expect(() =>
      defenseBudgetEnactmentProofV1Schema.parse({ ...proof(), incorporationEvidence: undefined }),
    ).toThrow();
  });

  it('blocks wrong companion-document SHA', () => {
    const bad = { ...candidate, sourceSha256: 'd'.repeat(64) };
    const result = compose(proof(), bad);
    expect(result.artifact.assertions.some((a) => a.assertionKind === 'funding')).toBe(false);
    expect(result.coverage.blocked).toBe(1);
  });

  it('does not accept a conference-only amount without incorporation proof', () => {
    expect(() =>
      defenseBudgetEnactmentProofV1Schema.parse({
        ...proof(),
        proofType: 'incorporated_table',
        incorporationEvidence: undefined,
      }),
    ).toThrow();
  });

  it('keeps a continuing resolution as an interim package record', () => {
    const cr = proof({ vehicleKind: 'continuing_resolution', explicitLineAuthority: false });
    expect(() => compose(cr)).toThrow(/continuing resolution/);
    expect(continuingResolutionPeriodRecordV1(cr).fullYearEnacted).toBe(false);
  });

  it('blocks omnibus division mismatch', () => {
    const result = compose(proof({ division: 'Division B' }));
    expect(result.coverage.blocked).toBe(1);
  });

  it('blocks public-law number mismatch', () => {
    expect(() => compose(proof({ publicLawNumber: 'P.L. 119-100' }))).toThrow(
      /public-law number mismatch/,
    );
  });

  it('keeps rescission actions separate from the enacted total', () => {
    const result = composeEnactedStageV1({
      profile,
      publicLawSource,
      lineDetailSource,
      parserRuns: [],
      lineDetailEvidence: evidenceFor(LINE_SHA),
      proof: proof(),
      candidates: [candidate],
      actions: [
        {
          schemaVersion: 'defense_budget_stage_action_v1',
          actionId: 'r1',
          track: 'appropriations',
          stage: 'public_law',
          authority: 'enacted_public_law',
          vehicleClass: 'public_law',
          actionType: 'rescission',
          identity: PE,
          fiscalYear: FY,
          amount: { originalValue: '5', originalUnit: 'millions', valueMillions: '5' },
          signedValueMillions: '-5',
          direction: 'decrease',
          evidenceIds: ['line-e1'],
          languageEvidenceIds: [],
          directOrDerived: 'direct',
        },
      ],
    });
    expect(result.actions).toHaveLength(1);
    const enacted = result.artifact.assertions.find((a) => a.assertionKind === 'funding');
    expect(enacted?.assertionKind === 'funding' ? enacted.money.valueMillions : null).toBe('125');
  });

  it('blocks candidate identity', () => {
    expect(compose(proof(), { ...candidate, bindingStatus: 'candidate' }).coverage.blocked).toBe(1);
  });

  it('blocks stale or superseded source documents', () => {
    expect(() =>
      compose(
        proof({
          lineDetailSource: { ...proof().lineDetailSource, status: 'superseded' },
        }),
      ),
    ).toThrow(/stale\/superseded/);
  });
});
