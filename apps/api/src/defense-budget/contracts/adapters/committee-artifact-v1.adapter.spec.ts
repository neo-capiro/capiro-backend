import {
  adaptCommitteeArtifactToArtifactV1,
  COMMITTEE_ADAPTER_MODE_VALUES,
  COMMITTEE_MODE_AUTHORITY,
  COMMITTEE_MODE_FUNDING_FIELD,
  type CommitteeAdapterMode,
  type CommitteeArtifactV1Input,
} from './committee-artifact-v1.adapter.js';
import { adapterTestContext as baseAdapterTestContext } from './testing-helpers.js';
import type { DefenseBudgetAssertionV1, FundingFieldV1 } from '../extraction-artifact-v1.js';

type FundingAssertion = Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }>;

function fundingAssertions(assertions: DefenseBudgetAssertionV1[]): FundingAssertion[] {
  return assertions.filter((a): a is FundingAssertion => a.assertionKind === 'funding');
}

function adapterTestContext(mode: CommitteeAdapterMode = 'HASC') {
  return baseAdapterTestContext({
    family: mode === 'PUBLIC_LAW' ? 'public_law' : 'committee',
    exhibit:
      mode === 'PUBLIC_LAW'
        ? 'public_law'
        : mode === 'NDAA_CONFERENCE' || mode === 'APPROPRIATIONS_CONFERENCE'
          ? 'conference_report'
          : 'committee_report',
    authority: COMMITTEE_MODE_AUTHORITY[mode],
    documentType: 'committee_test',
  });
}

function committeeInput(
  overrides: Partial<CommitteeArtifactV1Input> = {},
): CommitteeArtifactV1Input {
  return {
    chamber: 'HASC',
    fy: 2099,
    source: 'fy99_test_mark.pdf',
    rows: [
      {
        peCode: '0601102A',
        fy: 2099,
        request: 215322000,
        mark: 215322000,
        explanation: 'DEFENSE RESEARCH SCIENCES',
      },
    ],
    ...overrides,
  };
}

const ALL_MODES: Array<{ mode: CommitteeAdapterMode; field: FundingFieldV1 }> = [
  { mode: 'HASC', field: 'hascMark' },
  { mode: 'SASC', field: 'sascMark' },
  { mode: 'HAC-D', field: 'hacDMark' },
  { mode: 'SAC-D', field: 'sacDMark' },
  { mode: 'NDAA_CONFERENCE', field: 'ndaaConference' },
  { mode: 'APPROPRIATIONS_CONFERENCE', field: 'conference' },
  { mode: 'PUBLIC_LAW', field: 'enacted' },
];

describe('adaptCommitteeArtifactToArtifactV1', () => {
  it('defines an authority for every adapter mode', () => {
    expect(Object.keys(COMMITTEE_MODE_AUTHORITY).sort()).toEqual(
      [...COMMITTEE_ADAPTER_MODE_VALUES].sort(),
    );
  });

  it('maps every mode to its exact owned funding field', () => {
    for (const { mode, field } of ALL_MODES) {
      const artifact = adaptCommitteeArtifactToArtifactV1(
        committeeInput(),
        adapterTestContext(mode),
        {
          mode,
          legacyDeclaredUnit: 'dollars',
          defaultFiscalYear: 2099,
        },
      );
      const funding = fundingAssertions(artifact.assertions);
      const mark = funding.find((a) => a.field !== 'request');
      expect(mark).toBeDefined();
      expect(mark!.field).toBe(field);
      expect(COMMITTEE_MODE_FUNDING_FIELD[mode]).toBe(field);
    }
  });

  it('rejects a caller-selected mode that disagrees with source authority', () => {
    expect(() =>
      adaptCommitteeArtifactToArtifactV1(
        committeeInput(),
        baseAdapterTestContext({
          family: 'public_law',
          exhibit: 'public_law',
          authority: 'public_law',
        }),
        {
          mode: 'HASC',
          legacyDeclaredUnit: 'dollars',
          defaultFiscalYear: 2099,
        },
      ),
    ).toThrow(/mode HASC owns authority hasc.*declares public_law/);
  });

  it('keeps authorization and appropriations conference marks separate', () => {
    const ndaa = adaptCommitteeArtifactToArtifactV1(
      committeeInput(),
      adapterTestContext('NDAA_CONFERENCE'),
      {
        mode: 'NDAA_CONFERENCE',
        legacyDeclaredUnit: 'dollars',
        defaultFiscalYear: 2099,
      },
    );
    const approps = adaptCommitteeArtifactToArtifactV1(
      committeeInput(),
      adapterTestContext('APPROPRIATIONS_CONFERENCE'),
      {
        mode: 'APPROPRIATIONS_CONFERENCE',
        legacyDeclaredUnit: 'dollars',
        defaultFiscalYear: 2099,
      },
    );
    expect(
      ndaa.assertions.some((a) => a.assertionKind === 'funding' && a.field === 'ndaaConference'),
    ).toBe(true);
    expect(
      approps.assertions.some((a) => a.assertionKind === 'funding' && a.field === 'conference'),
    ).toBe(true);
    expect(
      approps.assertions.some((a) => a.assertionKind === 'funding' && a.field === 'ndaaConference'),
    ).toBe(false);
  });

  it('maps PUBLIC_LAW only to enacted, never to conference', () => {
    const artifact = adaptCommitteeArtifactToArtifactV1(
      committeeInput(),
      adapterTestContext('PUBLIC_LAW'),
      {
        mode: 'PUBLIC_LAW',
        legacyDeclaredUnit: 'dollars',
        defaultFiscalYear: 2099,
      },
    );
    const fields = fundingAssertions(artifact.assertions).map((a) => a.field);
    expect(fields).toContain('enacted');
    expect(fields).not.toContain('conference');
    expect(fields).not.toContain('ndaaConference');
  });

  it('keeps request and mark as independent facts and assertions', () => {
    const artifact = adaptCommitteeArtifactToArtifactV1(committeeInput(), adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    const paths = artifact.sourceFacts.map((f) => f.sourcePath);
    expect(paths).toContain('rows[0].request');
    expect(paths).toContain('rows[0].mark');
    const funding = fundingAssertions(artifact.assertions);
    expect(funding.filter((a) => a.field === 'request')).toHaveLength(1);
    expect(funding.filter((a) => a.field === 'hascMark')).toHaveLength(1);
    expect(artifact.summary.completenessStatus).toBe('complete');
  });

  it('preserves duplicate PE rows as duplicate assertions (no last-wins dedupe)', () => {
    const dup = committeeInput({
      rows: [
        { peCode: '0601102A', fy: 2099, request: 100, mark: 200, explanation: 'first' },
        { peCode: '0601102A', fy: 2099, request: 300, mark: 400, explanation: 'second' },
      ],
    });
    const artifact = adaptCommitteeArtifactToArtifactV1(dup, adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    const marks = fundingAssertions(artifact.assertions).filter((a) => a.field === 'hascMark');
    expect(marks).toHaveLength(2);
    const markValues = marks.map((a) => a.money.originalValue).sort();
    expect(markValues).toEqual(['200', '400']);
  });

  it('emits document_only evidence and a review warning when pages are absent', () => {
    const artifact = adaptCommitteeArtifactToArtifactV1(committeeInput(), adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    expect(artifact.warnings.some((w) => w.code === 'legacy_committee_artifact_missing_page')).toBe(
      true,
    );
    const rowEvidence = artifact.evidence.filter((e) => e.granularity !== 'document_only');
    expect(rowEvidence).toHaveLength(0);
  });

  it('uses page_only evidence when the row carries a page', () => {
    const paged = committeeInput({
      rows: [
        {
          peCode: '0601102A',
          fy: 2099,
          request: 100,
          mark: 200,
          explanation: 'x',
          page: 42,
          printedPage: '41',
        },
      ],
    });
    const artifact = adaptCommitteeArtifactToArtifactV1(paged, adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    const pageEvidence = artifact.evidence.find((e) => e.page === 42);
    expect(pageEvidence).toBeDefined();
    expect(pageEvidence!.granularity).toBe('page_only');
    expect(pageEvidence!.printedPage).toBe('41');
    expect(artifact.warnings.some((w) => w.code === 'legacy_committee_artifact_missing_page')).toBe(
      false,
    );
  });

  it('creates a blocking unsupported_unit omission when no unit can be proven', () => {
    const artifact = adaptCommitteeArtifactToArtifactV1(committeeInput(), adapterTestContext(), {
      mode: 'HASC',
      defaultFiscalYear: 2099,
    });
    const unitOmissions = artifact.omissions.filter((o) => o.reason === 'unsupported_unit');
    expect(unitOmissions.length).toBe(2);
    expect(unitOmissions.every((o) => o.severity === 'blocking')).toBe(true);
    expect(fundingAssertions(artifact.assertions)).toHaveLength(0);
    expect(artifact.summary.completenessStatus).toBe('incomplete');
  });

  it('prefers row-level units over the legacy declared convention', () => {
    const rowUnits = committeeInput({
      rows: [
        {
          peCode: '0601102A',
          fy: 2099,
          request: 1250,
          mark: 1.5,
          explanation: 'x',
          requestUnit: 'thousands',
          markUnit: 'millions',
        },
      ],
    });
    const artifact = adaptCommitteeArtifactToArtifactV1(rowUnits, adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    const funding = fundingAssertions(artifact.assertions);
    const request = funding.find((a) => a.field === 'request')!;
    const mark = funding.find((a) => a.field === 'hascMark')!;
    expect(request.money).toEqual({
      originalValue: '1250',
      originalUnit: 'thousands',
      valueMillions: '1.25',
    });
    expect(mark.money).toEqual({
      originalValue: '1.5',
      originalUnit: 'millions',
      valueMillions: '1.5',
    });
    expect(request.metadata?.['requestUnitSource']).toBe('row');
  });

  it('records the declared unit source in metadata for legacy-convention units', () => {
    const artifact = adaptCommitteeArtifactToArtifactV1(committeeInput(), adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    const funding = fundingAssertions(artifact.assertions);
    expect(
      funding.every(
        (a) =>
          a.metadata?.['requestUnitSource'] === 'adapter_context' ||
          a.metadata?.['markUnitSource'] === 'adapter_context',
      ),
    ).toBe(true);
  });

  it('scales dollar units exactly (no float drift)', () => {
    const artifact = adaptCommitteeArtifactToArtifactV1(committeeInput(), adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    const request = fundingAssertions(artifact.assertions).find((a) => a.field === 'request')!;
    expect(request.money).toEqual({
      originalValue: '215322000',
      originalUnit: 'dollars',
      valueMillions: '215.322',
    });
  });

  it('maps explanation to a rationale narrative assertion tied to the PE identity', () => {
    const artifact = adaptCommitteeArtifactToArtifactV1(committeeInput(), adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    const narrative = artifact.assertions.find((a) => a.assertionKind === 'narrative');
    expect(narrative).toMatchObject({
      narrativeType: 'rationale',
      text: 'DEFENSE RESEARCH SCIENCES',
      identity: { lineKind: 'RDTE_PE', peCode: '0601102A' },
    });
  });

  it('blocks money and identity facts when the PE code is invalid', () => {
    const bad = committeeInput({
      rows: [{ peCode: 'not-a-pe', fy: 2099, request: 100, mark: 200, explanation: 'x' }],
    });
    const artifact = adaptCommitteeArtifactToArtifactV1(bad, adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    expect(fundingAssertions(artifact.assertions)).toHaveLength(0);
    expect(artifact.omissions.some((o) => o.reason === 'invalid_identity')).toBe(true);
    expect(artifact.summary.completenessStatus).toBe('incomplete');
  });

  it('creates an invalid_number omission for malformed money', () => {
    const bad = committeeInput({
      rows: [{ peCode: '0601102A', fy: 2099, request: 'abc', mark: 200, explanation: 'x' }],
    });
    const artifact = adaptCommitteeArtifactToArtifactV1(bad, adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    expect(artifact.omissions.some((o) => o.reason === 'invalid_number')).toBe(true);
    const fields = fundingAssertions(artifact.assertions).map((a) => a.field);
    expect(fields).not.toContain('request');
    expect(fields).toContain('hascMark');
  });

  it('keeps toplines as document facts only', () => {
    const withToplines = committeeInput({
      toplines: [{ scope: 'defense', amountMillions: 850000, sourcePage: 3 }],
    });
    const artifact = adaptCommitteeArtifactToArtifactV1(withToplines, adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    const docFacts = artifact.assertions.filter((a) => a.assertionKind === 'document_fact');
    expect(docFacts).toHaveLength(1);
    expect(docFacts[0]!.fieldName).toBe('committee_topline');
    expect(
      fundingAssertions(artifact.assertions).some((a) => a.money.valueMillions === '850000'),
    ).toBe(false);
  });

  it('falls back to the default fiscal year when the row fy is missing', () => {
    const noFy = committeeInput({
      rows: [{ peCode: '0601102A', request: 100, mark: 200, explanation: 'x' }],
    });
    const artifact = adaptCommitteeArtifactToArtifactV1(noFy, adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    const funding = fundingAssertions(artifact.assertions);
    expect(funding.every((a) => a.fiscalYear === 2099)).toBe(true);
  });

  it('invalid FY preserves request, mark, and explanation as source facts with blocking omissions', () => {
    const invalidFy = committeeInput({
      rows: [
        {
          peCode: '0601102A',
          fy: 'not-a-year',
          request: 100,
          mark: 200,
          explanation: 'DEFENSE RESEARCH SCIENCES',
          requestUnit: 'dollars',
          markUnit: 'dollars',
        },
      ],
    });
    const artifact = adaptCommitteeArtifactToArtifactV1(invalidFy, adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });

    const paths = artifact.sourceFacts.map((f) => f.sourcePath);
    expect(paths).toContain('rows[0].fy');
    expect(paths).toContain('rows[0].request');
    expect(paths).toContain('rows[0].mark');
    expect(paths).toContain('rows[0].explanation');

    const omittedFactIds = new Set(artifact.omissions.map((o) => o.sourceFactId));
    const fyFact = artifact.sourceFacts.find((f) => f.sourcePath === 'rows[0].fy')!;
    const requestFact = artifact.sourceFacts.find((f) => f.sourcePath === 'rows[0].request')!;
    const markFact = artifact.sourceFacts.find((f) => f.sourcePath === 'rows[0].mark')!;
    const explanationFact = artifact.sourceFacts.find(
      (f) => f.sourcePath === 'rows[0].explanation',
    )!;
    expect(omittedFactIds.has(fyFact.factId)).toBe(true);
    expect(omittedFactIds.has(requestFact.factId)).toBe(true);
    expect(omittedFactIds.has(markFact.factId)).toBe(true);
    expect(omittedFactIds.has(explanationFact.factId)).toBe(true);

    const fyOmission = artifact.omissions.find((o) => o.sourceFactId === fyFact.factId)!;
    expect(fyOmission.reason).toBe('invalid_number');
    expect(fyOmission.severity).toBe('blocking');

    const valueOmissions = [requestFact, markFact, explanationFact].map(
      (f) => artifact.omissions.find((o) => o.sourceFactId === f.factId)!,
    );
    expect(valueOmissions.every((o) => o.severity === 'blocking')).toBe(true);
    expect(
      valueOmissions.every(
        (o) => o.message === 'value cannot be asserted because the row fiscal year is invalid',
      ),
    ).toBe(true);

    expect(fundingAssertions(artifact.assertions)).toHaveLength(0);
    expect(artifact.assertions.some((a) => a.assertionKind === 'narrative')).toBe(false);
    const assertionsWithDefaultFy = artifact.assertions.filter(
      (a) => 'fiscalYear' in a && a.fiscalYear === 2099,
    );
    expect(assertionsWithDefaultFy).toHaveLength(0);
    expect(artifact.summary.completenessStatus).toBe('incomplete');
  });

  it('replay is deterministic', () => {
    const first = adaptCommitteeArtifactToArtifactV1(committeeInput(), adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    const second = adaptCommitteeArtifactToArtifactV1(committeeInput(), adapterTestContext(), {
      mode: 'HASC',
      legacyDeclaredUnit: 'dollars',
      defaultFiscalYear: 2099,
    });
    expect(second).toEqual(first);
    expect(second.artifactId).toBe(first.artifactId);
  });
});
