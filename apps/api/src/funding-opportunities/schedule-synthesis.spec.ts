import {
  appendScheduleCorrections,
  collectScheduleDeadlines,
  extractScheduleDates,
  renderScheduleConstraints,
  type ScheduleDeadlineFact,
} from '@capiro/shared';

const AS_OF = '2026-09-10T12:00:00.000Z';
const open: ScheduleDeadlineFact = {
  id: 'DIU:2026-11-14', title: 'DIU', at: '2026-11-15T04:59:59.999Z',
  dateOnly: '2026-11-14', timeZone: 'America/New_York', daysRemaining: 65, status: 'open',
};
const passed: ScheduleDeadlineFact = {
  id: 'Old:2026-09-01', title: 'Old NOFO', at: '2026-09-02T03:59:59.999Z',
  dateOnly: '2026-09-01', timeZone: 'America/New_York', daysRemaining: -9, status: 'closed',
};

describe('schedule synthesis helpers', () => {
  test('collects and deduplicates deadlines nested in tool envelopes', () => {
    const deadline = { at: open.at, dateOnly: open.dateOnly, timeZone: open.timeZone, daysRemaining: 65, status: 'open' };
    expect(collectScheduleDeadlines({ data: [{ title: 'DIU', deadline }, { title: 'DIU', nested: { deadline } }] })).toEqual([
      { ...open, id: `DIU:${open.at}` },
    ]);
  });

  test.each([
    [open, 'Schedule constraints (computed): today=2026-09-10 UTC; DIU: deadline 2026-11-15T04:59:59.999Z America/New_York, 65 days remaining, status open; suggested dates: Capture plan complete 2026-10-25, Compliance review 2026-11-01, Draft complete 2026-11-05, Final review 2026-11-10; every proposed milestone must fall on or before its deadline; deadlines already passed cannot be planned against — say so and propose the next actionable step.'],
    [passed, 'Schedule constraints (computed): today=2026-09-10 UTC; Old NOFO: deadline 2026-09-02T03:59:59.999Z America/New_York, -9 days remaining, status closed; every proposed milestone must fall on or before its deadline; deadlines already passed cannot be planned against — say so and propose the next actionable step.'],
  ])('renders an exact computed constraints block', (deadline, expected) => {
    expect(renderScheduleConstraints(AS_OF, [deadline])).toBe(expected);
  });

  test('extracts supported dates only inside schedule sections and ignores fiscal years, amounts, and bare years', () => {
    const text = '# Summary\nOutside 2026-10-01\n# Capture Plan\n- Kickoff — 2026-10-02\n- Submit — Nov 20, 2026\n- Budget FY2027 is $22.197M in 2027\n# Risks\nOutside December 1, 2026';
    expect(extractScheduleDates(text)).toEqual([
      { id: 'milestone-1', label: 'Kickoff — 2026-10-02', date: '2026-10-02', rawDate: '2026-10-02' },
      { id: 'milestone-2', label: 'Submit — Nov 20, 2026', date: '2026-11-20', rawDate: 'Nov 20, 2026' },
    ]);
  });

  test('formats milestone-after-deadline and passed-deadline corrections', () => {
    expect(appendScheduleCorrections({ text: '# Timeline\n- Submit proposal — Nov 20, 2026', asOf: AS_OF, deadlines: [open] }).text).toBe(
      "# Timeline\n- Submit proposal — Nov 20, 2026\n\nCorrection: 'Submit proposal — Nov 20, 2026' falls after the DIU deadline of 2026-11-14 (America/New_York); the feasible submission date is on or before 2026-11-14.",
    );
    expect(appendScheduleCorrections({ text: '# Schedule\n- Review — 2026-08-30', asOf: AS_OF, deadlines: [passed] }).text).toBe(
      '# Schedule\n- Review — 2026-08-30\n\nCorrection: the Old NOFO deadline of 2026-09-01 (America/New_York) has passed; do not plan against it. Confirm the next actionable opportunity.',
    );
  });
});