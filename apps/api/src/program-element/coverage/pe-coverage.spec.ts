import {
  isTruncatedTitle,
  isUnitsAnomaly,
  auditRows,
  classifyMissingMark,
  type PeYearFacts,
} from './pe-coverage.js';

describe('isTruncatedTitle', () => {
  test('flags hyphen/en-dash terminal (unspliced line wrap)', () => {
    expect(isTruncatedTitle('ADVANCED TECH-')).toBe(true);
    expect(isTruncatedTitle('F\u2013')).toBe(true); // en-dash
  });
  test('flags <=3 char names (regex cut at embedded number)', () => {
    expect(isTruncatedTitle('F-')).toBe(true);
    expect(isTruncatedTitle('AB')).toBe(true);
  });
  test('accepts full names', () => {
    expect(isTruncatedTitle('DEFENSE RESEARCH SCIENCES')).toBe(false);
    expect(isTruncatedTitle('F-22A SQUADRONS')).toBe(false);
  });
  test('empty/null is not truncated', () => {
    expect(isTruncatedTitle(null)).toBe(false);
    expect(isTruncatedTitle('')).toBe(false);
  });
});

describe('isUnitsAnomaly', () => {
  test('flags ~1000x thousands-vs-dollars mismatch', () => {
    expect(isUnitsAnomaly(296535, 296535000)).toBe(true); // dollars vs thousands
    expect(isUnitsAnomaly(296535000, 296535)).toBe(true); // reverse
  });
  test('does not flag a normal plus-up/cut', () => {
    expect(isUnitsAnomaly(296535000, 311535000)).toBe(false);
    expect(isUnitsAnomaly(100, 200)).toBe(false);
  });
  test('ignores null/zero/sign-flip', () => {
    expect(isUnitsAnomaly(null, 1000)).toBe(false);
    expect(isUnitsAnomaly(0, 1000)).toBe(false);
    expect(isUnitsAnomaly(1000, -1000000)).toBe(false);
  });
});

describe('auditRows verdict', () => {
  const good = Array.from({ length: 100 }, (_, i) => ({
    peCode: `060${String(1000 + i)}A`,
    request: 1_000_000,
    mark: 1_100_000,
    explanation: 'SOME PROGRAM NAME',
  }));

  test('clean artifact -> ok', () => {
    const r = auditRows(good);
    expect(r.status).toBe('ok');
    expect(r.titleTruncated).toBe(0);
    expect(r.unitsAnomalies).toBe(0);
    expect(r.peCodesDistinct).toBe(100);
  });

  test('F-22A-class truncation regression -> warn/fail', () => {
    const bad = good.map((r, i) => (i < 25 ? { ...r, explanation: 'F-' } : r));
    const rep = auditRows(bad);
    expect(rep.titleTruncated).toBe(25);
    expect(rep.status).toBe('fail'); // 25% > 20% threshold
    expect(rep.truncatedSamples.length).toBeGreaterThan(0);
  });

  test('any units anomaly -> fail', () => {
    const bad = [{ peCode: '0601102A', request: 296535, mark: 296535000, explanation: 'X PROGRAM' }];
    expect(auditRows(bad).status).toBe('fail');
  });
});

describe('classifyMissingMark', () => {
  const base: PeYearFacts = {
    peCode: '0602101A', // Army -> in ASC jurisdiction
    fy: 2027,
    present: { request: true },
    appropriationType: 'RDT&E',
  };

  test('present mark -> mark_present', () => {
    const c = classifyMissingMark({ ...base, present: { request: true, sascMark: true } }, 'sascMark');
    expect(c.verdict).toBe('mark_present');
  });

  test('in-request, RDT&E, in-jurisdiction, unclassified -> candidate_gap', () => {
    const c = classifyMissingMark(base, 'sascMark');
    expect(c.verdict).toBe('candidate_gap');
  });

  test('no request that FY -> expected_blank', () => {
    const c = classifyMissingMark({ ...base, present: {} }, 'sascMark');
    expect(c.verdict).toBe('expected_blank');
    expect(c.reason).toBe('no_request_that_fy');
  });

  test('terminated -> expected_blank', () => {
    const c = classifyMissingMark({ ...base, status: 'Terminated' }, 'hascMark');
    expect(c.verdict).toBe('expected_blank');
  });

  test('non-RDT&E appropriation -> expected_blank for chamber marks', () => {
    const c = classifyMissingMark({ ...base, appropriationType: 'PROC' }, 'hacDMark');
    expect(c.verdict).toBe('expected_blank');
    expect(c.reason).toContain('non_rdte');
  });

  test('out-of-jurisdiction service (unknown designator) -> expected_blank', () => {
    const c = classifyMissingMark({ ...base, peCode: '0601000Z' }, 'sascMark');
    expect(c.verdict).toBe('expected_blank');
    expect(c.reason).toContain('out_of_jurisdiction');
  });

  test('request mark itself never a candidate gap', () => {
    const c = classifyMissingMark({ ...base, present: {} }, 'request');
    expect(c.verdict).toBe('expected_blank');
    expect(c.reason).toBe('request_not_a_mark');
  });
});
