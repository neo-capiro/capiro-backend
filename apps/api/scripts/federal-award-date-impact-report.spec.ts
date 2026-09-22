import {
  buildAwardDateImpactReport,
  renderAwardDateImpactMarkdown,
  type AwardDateImpactRow,
} from './federal-award-date-impact-report.js';

function row(overrides: Partial<AwardDateImpactRow> = {}): AwardDateImpactRow {
  return {
    id: 'db-1',
    awardUniqueId: 'CONT_AWD_H9222216C0078_9700_-NONE-_-NONE-',
    piid: 'H9222216C0078',
    amount: 100,
    actionDate: '2021-09-21',
    before: {
      baseAwardSignedDate: null,
      latestActionDate: null,
      sourceLastModifiedDate: null,
      popStartDate: null,
      popEndDate: null,
      dateSemanticsVersion: null,
    },
    after: {
      baseAwardSignedDate: '2016-05-25',
      latestActionDate: null,
      sourceLastModifiedDate: '2021-09-21',
      popStartDate: '2016-05-24',
      popEndDate: '2021-05-25',
      dateSemanticsVersion: 1,
    },
    ...overrides,
  };
}

describe('federal award date impact report', () => {
  it('summarizes corrected dates, fallback suspects, differences, incidents, and top amounts', () => {
    const report = buildAwardDateImpactReport(
      [row(), row({ awardUniqueId: 'other', piid: 'OTHER', amount: 500, actionDate: null })],
      '2026-09-21T00:00:00.000Z',
    );

    expect(report).toMatchObject({
      rowsExamined: 2,
      baseSignedDateFound: 2,
      legacyActionEqualsSourceLastModified: 1,
      signedMinusActionDateDays: { '->365': 1, unknown: 1 },
    });
    expect(report.incidentAwards['CONT_AWD_H9222216C0078_9700_-NONE-_-NONE-']).toBe('present');
    expect(report.topAwards.map((award) => award.piid)).toEqual(['OTHER', 'H9222216C0078']);
    expect(renderAwardDateImpactMarkdown(report)).toContain('Legacy action date equals source');
  });
});
