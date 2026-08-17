import { buildMatrix, type DocStatus } from './expected-documents.js';

describe('buildMatrix', () => {
  const expected = [
    { fiscalYear: 2027, authority: 'dod-comptroller', component: 'ARMY', family: 'rdte', label: 'FY27 Army R-2 Vol1', matchKey: 'jbook_r2_army_v1_fy2027' },
    { fiscalYear: 2027, authority: 'dod-comptroller', component: 'AF', family: 'rdte', label: 'FY27 AF R-2 Vol1', matchKey: 'jbook_r2_af_v1_fy2027' },
    { fiscalYear: 2026, authority: 'hac_d', component: null, family: 'committee', label: 'FY26 HAC-D report', matchKey: 'hacd_report_fy2026' },
    { fiscalYear: 2027, authority: 'hac_d', component: null, family: 'committee', label: 'FY27 HAC-D report', matchKey: 'hacd_report_fy2027', defaultStatus: 'NOT_YET_PUBLISHED' as DocStatus },
    { fiscalYear: 2027, authority: 'dod-comptroller', component: 'SF', family: 'milpers', label: 'SF MilPers', matchKey: 'sf_milpers_fy2027', defaultStatus: 'NOT_APPLICABLE' as DocStatus },
  ];

  it('marks ingested docs FOUND and released-but-absent docs MISSING (actionable)', () => {
    const ingested = new Set(['jbook_r2_army_v1_fy2027']);
    const report = buildMatrix(expected, ingested);

    expect(report.total).toBe(5);
    expect(report.byStatus.FOUND).toBe(1);
    // AF R-2 released but absent => MISSING (actionable). HAC-D FY26 released but absent => MISSING.
    expect(report.byStatus.MISSING).toBe(2);
    expect(report.byStatus.NOT_YET_PUBLISHED).toBe(1);
    expect(report.byStatus.NOT_APPLICABLE).toBe(1);
    expect(report.actionable.map((a) => a.label).sort()).toEqual(['FY26 HAC-D report', 'FY27 AF R-2 Vol1']);
  });

  it('does NOT count NOT_YET_PUBLISHED / NOT_APPLICABLE as actionable gaps', () => {
    const report = buildMatrix(expected, new Set());
    expect(report.actionable.some((a) => a.label === 'FY27 HAC-D report')).toBe(false);
    expect(report.actionable.some((a) => a.label === 'SF MilPers')).toBe(false);
  });

  it('records the satisfying sourceKey on FOUND entries', () => {
    const report = buildMatrix(expected, new Set(['jbook_r2_af_v1_fy2027']));
    const af = report.entries.find((e) => e.label === 'FY27 AF R-2 Vol1')!;
    expect(af.status).toBe('FOUND');
    expect(af.satisfiedBy).toBe('jbook_r2_af_v1_fy2027');
  });
});
