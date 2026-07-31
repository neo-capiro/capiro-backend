import {
  TARGETS,
  FUNDING_TOLERANCE_M,
  METRIC_FAMILIES,
  peIdentityAccuracy,
  fundingValueAccuracy,
  programMatchPrecision,
  personRolePrecision,
  deltaAccuracy,
  summarize,
  groundedFieldAccuracy,
  auditGoldenReviewProvenance,
  classificationAccuracy,
  separatedBinaryMetrics,
  type R1IdentityGolden,
  type R1IdentityActual,
  type FundingGolden,
  type FundingActual,
  type LabelGolden,
  type DecisionActual,
  type DeltaGolden,
  type DeltaActual,
  type GroundedFieldGolden,
  type GroundedFieldActual,
  type BinaryClassGolden,
  type BinaryClassActual,
} from './accuracy-metrics.js';

/**
 * Step 4.1 — PURE accuracy-metric math. Each metric is exercised with a mix of
 * correct/incorrect golden-vs-actual fixtures so the fraction, target, and pass flag
 * are all asserted; empty-golden edge cases assert the documented "n/a" behaviour
 * (value null, never a pass). `summarize.allPass` is true only when every metric meets
 * its target.
 */

/** Build N identity golden rows; the first `bad` of them get a mismatched actual title. */
function identityFixtures(n: number, badTitles: number) {
  const golden: R1IdentityGolden[] = [];
  const actual: R1IdentityActual[] = [];
  for (let i = 0; i < n; i++) {
    const id = `r1-${i}`;
    golden.push({ id, peCode: `06041${i}A`, title: `Program ${i}` });
    actual.push({
      id,
      peCode: `06041${i}A`,
      title: i < badTitles ? `WRONG ${i}` : `Program ${i}`,
    });
  }
  return { golden, actual };
}

describe('peIdentityAccuracy', () => {
  test('99/100 matches → 0.99, meets the ≥0.99 target', () => {
    const { golden, actual } = identityFixtures(100, 1);
    const r = peIdentityAccuracy(golden, actual);
    expect(r.value).toBeCloseTo(0.99, 5);
    expect(r.target).toBe(TARGETS.PE_IDENTITY_ACCURACY);
    expect(r.sampleSize).toBe(100);
    expect(r.pass).toBe(true);
  });

  test('98/100 matches → 0.98, fails the ≥0.99 target', () => {
    const { golden, actual } = identityFixtures(100, 2);
    const r = peIdentityAccuracy(golden, actual);
    expect(r.value).toBeCloseTo(0.98, 5);
    expect(r.pass).toBe(false);
  });

  test('peCode compared case-insensitively; missing actual row is a miss', () => {
    const golden: R1IdentityGolden[] = [
      { id: 'a', peCode: '0604123A', title: 'Alpha' },
      { id: 'b', peCode: '0604999B', title: 'Bravo' },
    ];
    const actual: R1IdentityActual[] = [
      { id: 'a', peCode: '0604123a', title: ' Alpha ' }, // case + whitespace → still a hit
      // 'b' absent → miss
    ];
    const r = peIdentityAccuracy(golden, actual);
    expect(r.value).toBe(0.5);
  });

  test('empty golden → value null, not a pass, sampleSize 0', () => {
    const r = peIdentityAccuracy([], []);
    expect(r.value).toBeNull();
    expect(r.pass).toBe(false);
    expect(r.sampleSize).toBe(0);
  });
});

describe('fundingValueAccuracy', () => {
  test('within tolerance counts as a match; out of tolerance does not', () => {
    const golden: FundingGolden[] = [
      { id: 'a', byAmount: 100.0 },
      { id: 'b', byAmount: 250.5 },
      { id: 'c', byAmount: 12.345 },
    ];
    const actual: FundingActual[] = [
      { id: 'a', byAmount: 100.0005 }, // within default 0.001 tolerance → hit
      { id: 'b', byAmount: 250.6 }, // off by 0.1 → miss
      { id: 'c', byAmount: 12.345 }, // exact → hit
    ];
    const r = fundingValueAccuracy(golden, actual);
    expect(r.value).toBeCloseTo(2 / 3, 5);
    expect(r.target).toBe(TARGETS.FUNDING_VALUE_ACCURACY);
  });

  test('null actual amount is a miss', () => {
    const golden: FundingGolden[] = [{ id: 'a', byAmount: 5 }];
    const actual: FundingActual[] = [{ id: 'a', byAmount: null }];
    expect(fundingValueAccuracy(golden, actual).value).toBe(0);
  });

  test('custom tolerance widens the match window', () => {
    const golden: FundingGolden[] = [{ id: 'a', byAmount: 100 }];
    const actual: FundingActual[] = [{ id: 'a', byAmount: 100.4 }];
    expect(fundingValueAccuracy(golden, actual).value).toBe(0); // default tol
    expect(fundingValueAccuracy(golden, actual, 0.5).value).toBe(1); // widened
  });

  test('default tolerance constant is exported and applied', () => {
    expect(FUNDING_TOLERANCE_M).toBe(0.001);
  });
});

describe('programMatchPrecision', () => {
  test('precision is over ACCEPTED rows only (rejected/candidate ignored)', () => {
    // 4 accepted; golden labels 3 of the 4 correct → 0.75 (fails ≥0.95).
    const golden: LabelGolden[] = [
      { id: '1', correct: true },
      { id: '2', correct: true },
      { id: '3', correct: true },
      { id: '4', correct: false },
      { id: '5', correct: true }, // not accepted → ignored
    ];
    const actual: DecisionActual[] = [
      { id: '1', accepted: true },
      { id: '2', accepted: true },
      { id: '3', accepted: true },
      { id: '4', accepted: true },
      { id: '5', accepted: false },
    ];
    const r = programMatchPrecision(golden, actual);
    expect(r.value).toBe(0.75);
    expect(r.sampleSize).toBe(4);
    expect(r.target).toBe(TARGETS.PROGRAM_MATCH_PRECISION);
    expect(r.pass).toBe(false);
  });

  test('20/20 accepted-correct → 1.0, passes', () => {
    const golden: LabelGolden[] = [];
    const actual: DecisionActual[] = [];
    for (let i = 0; i < 20; i++) {
      golden.push({ id: `${i}`, correct: true });
      actual.push({ id: `${i}`, accepted: true });
    }
    const r = programMatchPrecision(golden, actual);
    expect(r.value).toBe(1);
    expect(r.pass).toBe(true);
  });

  test('accepted id missing from golden counts as incorrect', () => {
    const r = programMatchPrecision(
      [{ id: '1', correct: true }],
      [
        { id: '1', accepted: true },
        { id: '2', accepted: true }, // no golden label → incorrect
      ],
    );
    expect(r.value).toBe(0.5);
  });

  test('no accepted rows → value null (n/a), not a pass', () => {
    const r = programMatchPrecision([{ id: '1', correct: true }], [{ id: '1', accepted: false }]);
    expect(r.value).toBeNull();
    expect(r.pass).toBe(false);
  });
});

describe('personRolePrecision', () => {
  test('uses the 0.97 target; 94/100 → fails', () => {
    const golden: LabelGolden[] = [];
    const actual: DecisionActual[] = [];
    for (let i = 0; i < 100; i++) {
      golden.push({ id: `${i}`, correct: i >= 6 }); // first 6 incorrect
      actual.push({ id: `${i}`, accepted: true });
    }
    const r = personRolePrecision(golden, actual);
    expect(r.value).toBeCloseTo(0.94, 5);
    expect(r.target).toBe(TARGETS.PERSON_ROLE_PRECISION);
    expect(r.pass).toBe(false);
  });
});

describe('deltaAccuracy', () => {
  test('matches by deltaType (case-insensitive); uses the 0.98 target', () => {
    const golden: DeltaGolden[] = [];
    const actual: DeltaActual[] = [];
    // 49/50 correct → 0.98 exactly → passes.
    for (let i = 0; i < 50; i++) {
      golden.push({ id: `${i}`, deltaType: 'cut' });
      actual.push({ id: `${i}`, deltaType: i === 0 ? 'increase' : 'CUT' });
    }
    const r = deltaAccuracy(golden, actual);
    expect(r.value).toBeCloseTo(0.98, 5);
    expect(r.target).toBe(TARGETS.DELTA_ACCURACY);
    expect(r.pass).toBe(true);
  });

  test('null actual classification is a miss', () => {
    const r = deltaAccuracy([{ id: 'a', deltaType: 'cut' }], [{ id: 'a', deltaType: null }]);
    expect(r.value).toBe(0);
  });
});

describe('summarize', () => {
  test('allPass true only when every metric passes', () => {
    const passing = peIdentityAccuracy(
      ...(Object.values(identityFixtures(100, 1)) as [R1IdentityGolden[], R1IdentityActual[]]),
    );
    const failing = peIdentityAccuracy(
      ...(Object.values(identityFixtures(100, 5)) as [R1IdentityGolden[], R1IdentityActual[]]),
    );

    expect(summarize([passing]).allPass).toBe(true);
    expect(summarize([passing, failing]).allPass).toBe(false);
  });

  test('empty result list is NOT allPass', () => {
    expect(summarize([]).allPass).toBe(false);
  });

  test('an n/a (null-value) metric blocks allPass', () => {
    const naMetric = peIdentityAccuracy([], []);
    expect(summarize([naMetric]).allPass).toBe(false);
  });
});

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('groundedFieldAccuracy (Phase K)', () => {
  test('requires identity + FY + field + SHA + page/span', () => {
    const golden: GroundedFieldGolden[] = [
      {
        id: '1',
        peCode: '0604123A',
        fy: 2027,
        field: 'request',
        stage: 'request',
        sourceSha256: SHA_A,
        page: 12,
        span: 'p12:100-140',
        expectedValue: '12.5',
        humanReviewed: false,
        syntheticWarning: 'SYNTHETIC — NOT HUMAN REVIEWED',
      },
      {
        id: '2',
        peCode: '0604999B',
        fy: 2027,
        field: 'hascMark',
        sourceSha256: SHA_B,
        page: 3,
        humanReviewed: false,
        syntheticWarning: 'SYNTHETIC placeholder',
      },
    ];
    const actual: GroundedFieldActual[] = [
      {
        id: '1',
        peCode: '0604123a',
        fy: 2027,
        field: 'request',
        stage: 'request',
        sourceSha256: SHA_A,
        page: 12,
        span: 'p12:100-140',
        actualValue: '12.5',
      },
      {
        id: '2',
        peCode: '0604999B',
        fy: 2027,
        field: 'hascMark',
        sourceSha256: SHA_A, // wrong SHA → miss
        page: 3,
      },
    ];
    const r = groundedFieldAccuracy(golden, actual);
    expect(r.value).toBe(0.5);
    expect(r.target).toBe(TARGETS.GROUNDED_FIELD_ACCURACY);
    expect(r.sampleSize).toBe(2);
  });

  test('missing actual is a miss; empty golden is n/a', () => {
    const golden: GroundedFieldGolden[] = [
      {
        id: 'x',
        peCode: '0604000A',
        fy: 2026,
        field: 'enacted',
        sourceSha256: SHA_A,
        humanReviewed: false,
        syntheticWarning: 'SYNTHETIC',
      },
    ];
    expect(groundedFieldAccuracy(golden, []).value).toBe(0);
    expect(groundedFieldAccuracy([], []).value).toBeNull();
    expect(groundedFieldAccuracy([], []).pass).toBe(false);
  });
});

describe('auditGoldenReviewProvenance', () => {
  test('synthetic rows need loud warning; human rows need reviewer+date+sha', () => {
    const badSynth: GroundedFieldGolden[] = [
      {
        id: 's',
        peCode: '0604000A',
        fy: 2026,
        field: 'request',
        sourceSha256: SHA_A,
        humanReviewed: false,
      },
    ];
    expect(auditGoldenReviewProvenance(badSynth).ok).toBe(false);

    const badHuman: GroundedFieldGolden[] = [
      {
        id: 'h',
        peCode: '0604000A',
        fy: 2026,
        field: 'request',
        sourceSha256: 'abc',
        humanReviewed: true,
      },
    ];
    const h = auditGoldenReviewProvenance(badHuman);
    expect(h.ok).toBe(false);
    expect(h.blockers.length).toBeGreaterThanOrEqual(3);

    const good: GroundedFieldGolden[] = [
      {
        id: 'ok-s',
        peCode: '0604000A',
        fy: 2026,
        field: 'request',
        sourceSha256: SHA_A,
        humanReviewed: false,
        syntheticWarning: 'SYNTHETIC — NOT human reviewed',
      },
      {
        id: 'ok-h',
        peCode: '0604000B',
        fy: 2026,
        field: 'request',
        sourceSha256: SHA_B,
        humanReviewed: true,
        reviewer: 'analyst@example.com',
        reviewedAt: '2026-07-01',
      },
    ];
    expect(auditGoldenReviewProvenance(good).ok).toBe(true);
  });
});

describe('classificationAccuracy + separatedBinaryMetrics', () => {
  test('classification accuracy matches labels case-insensitively', () => {
    const golden: BinaryClassGolden[] = [
      { id: 'a', label: 'current' },
      { id: 'b', label: 'outyear' },
    ];
    const actual: BinaryClassActual[] = [
      { id: 'a', label: 'CURRENT' },
      { id: 'b', label: 'current' }, // wrong
    ];
    const r = classificationAccuracy(golden, actual);
    expect(r.value).toBe(0.5);
    expect(r.target).toBe(TARGETS.CLASSIFICATION_ACCURACY);
  });

  test('precision/recall/coverage/FP/FN stay separate', () => {
    // golden positives: a,b,c  negatives: d,e
    // actual: a TP, b FN(missing), c FN(predicted neg), d TN, e FP
    const golden: BinaryClassGolden[] = [
      { id: 'a', label: 'hit' },
      { id: 'b', label: 'hit' },
      { id: 'c', label: 'hit' },
      { id: 'd', label: 'miss' },
      { id: 'e', label: 'miss' },
    ];
    const actual: BinaryClassActual[] = [
      { id: 'a', label: 'hit' },
      // b missing
      { id: 'c', label: 'miss' },
      { id: 'd', label: 'miss' },
      { id: 'e', label: 'hit' },
    ];
    const m = separatedBinaryMetrics(golden, actual, 'hit');
    expect(m.confusion).toEqual({
      truePositives: 1,
      trueNegatives: 1,
      falsePositives: 1,
      falseNegatives: 2,
    });
    expect(m.falsePositives).toBe(1);
    expect(m.falseNegatives).toBe(2);
    expect(m.precision.value).toBeCloseTo(1 / 2, 5);
    expect(m.recall.value).toBeCloseTo(1 / 3, 5);
    expect(m.coverage.value).toBeCloseTo(4 / 5, 5);
    // families list is the permanent catalog contract
    expect(METRIC_FAMILIES).toEqual(
      expect.arrayContaining([
        'precision',
        'recall',
        'coverage',
        'classification_accuracy',
        'false_positives',
        'false_negatives',
      ]),
    );
  });
});
