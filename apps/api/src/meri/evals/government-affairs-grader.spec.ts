import {
  GOVERNMENT_AFFAIRS_FIXTURES,
  governmentAffairsFixtureInput,
} from './government-affairs-fixtures.js';
import {
  gradeGovernmentAffairsAnswer,
  scoreGovernmentAffairsHumanReview,
  type GovernmentAffairsHumanReview,
} from './government-affairs-grader.js';

describe('government-affairs professional evaluation contract', () => {
  it('covers all six requested tasks with client context and source-specific review checks', () => {
    expect(GOVERNMENT_AFFAIRS_FIXTURES.map((row) => row.skill)).toEqual([
      'appropriations',
      'funding',
      'meeting',
      'hearing',
      'legislation',
      'executive',
    ]);
    for (const fixture of GOVERNMENT_AFFAIRS_FIXTURES) {
      expect(fixture.sources[0]!.text).toContain('Strategy AS-7');
      expect(fixture.sources[0]!.text).toContain('2 of 3');
      expect(fixture.reviewChecks).toHaveLength(4);
      expect(fixture.requiredSourceIds).toContain(1);
    }
  });

  it.each(GOVERNMENT_AFFAIRS_FIXTURES)(
    'accepts the authored reference contract for $id without claiming measured quality',
    (fixture) => {
      expect(gradeGovernmentAffairsAnswer(fixture, fixture.referenceAnswer)).toMatchObject({
        pass: true,
        failures: [],
        professionalQualityScore: null,
        groundingVerified: false,
        humanReviewRequired: true,
      });
    },
  );

  it('rejects a plausible budget answer that loses the client constraint/source, even if table identifiers survive', () => {
    const fixture = GOVERNMENT_AFFAIRS_FIXTURES[0]!;
    const missingClient = fixture.referenceAnswer.replace(/\[1\]/g, '');
    expect(gradeGovernmentAffairsAnswer(fixture, missingClient).failures).toContain(
      'required client/task evidence [1] was not cited',
    );
  });

  it('rejects invented source numbers and incomplete executive deliverables', () => {
    const fixture = GOVERNMENT_AFFAIRS_FIXTURES[5]!;
    const result = gradeGovernmentAffairsAnswer(
      fixture,
      `${fixture.referenceAnswer}\nBudget approved. [99]\nTODO`,
    );
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'citation [99] has no supplied source',
        'deliverable contains an unfinished placeholder',
      ]),
    );
  });

  it('catches seeded funding and budget stage regressions using the existing Meri grader', () => {
    const funding = GOVERNMENT_AFFAIRS_FIXTURES[1]!;
    expect(
      gradeGovernmentAffairsAnswer(funding, `${funding.referenceAnswer} FF-3 is open`).pass,
    ).toBe(false);
    const budget = GOVERNMENT_AFFAIRS_FIXTURES[0]!;
    expect(
      gradeGovernmentAffairsAnswer(budget, budget.referenceAnswer.replace('25%', '30%')).pass,
    ).toBe(false);
  });

  it('never sends golden answers or scoring keys to the provider', () => {
    const fixture = GOVERNMENT_AFFAIRS_FIXTURES[0]!;
    const input = governmentAffairsFixtureInput(fixture);
    expect(input).toContain(fixture.question);
    expect(input).toContain(fixture.sources[0]!.text);
    expect(input).not.toContain(fixture.referenceAnswer);
    expect(input).not.toContain(fixture.reviewChecks[0]);
  });

  const review = (): GovernmentAffairsHumanReview => ({
    reviewer: 'Independent evaluator',
    reviewedAt: '2026-09-06T12:00:00Z',
    scores: {
      clientImplication: 4,
      verifiedEvidence: 4,
      judgment: 4,
      practicalAction: 4,
      missingInformation: 4,
    },
    criticalErrors: [],
    notes: 'Each material claim checked against supplied records.',
  });
  it('scores only explicit human review and fails critical errors despite a high score', () => {
    expect(scoreGovernmentAffairsHumanReview(review())).toEqual({
      total: 20,
      possible: 20,
      criticalErrorCount: 0,
      acceptable: true,
    });
    expect(
      scoreGovernmentAffairsHumanReview({
        ...review(),
        criticalErrors: ['Changed a witness recommendation to adopted policy.'],
      }).acceptable,
    ).toBe(false);
  });
  it('requires every dimension rather than allowing averages to hide omitted gaps', () => {
    const row = review();
    row.scores.missingInformation = 0;
    expect(scoreGovernmentAffairsHumanReview(row)).toMatchObject({ total: 16, acceptable: false });
    row.scores.judgment = Number.NaN;
    expect(() => scoreGovernmentAffairsHumanReview(row)).toThrow('five professional dimensions');
  });
});
