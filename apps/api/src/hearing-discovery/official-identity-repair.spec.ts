import { identityRepairPatch } from '../../scripts/repair-official-hearing-observations.js';
import { projectCanonical } from './canonical-diff.js';

describe('reviewed official identity restoration', () => {
  it('clears the other event’s subcommittee and restores the retained full-committee time', () => {
    const projected = projectCanonical([
      {
        sourceId: 'official',
        adapterKey: 'senate-schedule',
        sourcePriority: 1,
        lastSeenAt: new Date('2026-10-04'),
        sourceUpdatedAt: null,
        congress: 119,
        chamber: 'senate',
        committeeSystemCode: 'ssju00',
        subcommitteeSystemCode: null,
        committeeName: 'Judiciary',
        title: 'Oversight of Jack Smith',
        calendarDate: new Date('2026-09-29'),
        startsAt: new Date('2026-09-29T13:00:00Z'),
        displayTime: '9:00 AM',
        officialPageUrl: 'https://www.senate.gov/hearings/338784',
      },
    ]);
    expect(identityRepairPatch(projected)).toMatchObject({
      title: 'Oversight of Jack Smith',
      subcommitteeSystemCode: null,
      startsAt: new Date('2026-09-29T13:00:00Z'),
      time: '9:00 AM',
      url: 'https://www.senate.gov/hearings/338784',
    });
  });
  it('refuses to invent a replacement title, date or publisher URL', () => {
    expect(() => identityRepairPatch(projectCanonical([]))).toThrow('independently retained');
  });
});
