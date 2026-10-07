// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  plannerTemplateSchedule,
  type PlannerTemplateData,
} from '@capiro/strategy-verifier';
import {
  PlannerTemplateScheduleEditor,
  plannerTemplateOffsets,
} from './planner-template-schedule.js';

afterEach(cleanup);
const config: PlannerTemplateData = {
  description: '',
  privacy: 'private',
  members: [],
  project: {
    ...PLANNER_DEFAULT_PROJECT,
    name: 'Template',
    startOn: '2026-10-06',
    dueOn: '2026-10-12',
  },
  tasks: [
    {
      ...PLANNER_DEFAULT_TASK,
      name: 'Prepare',
      startOn: '2026-10-07',
      dueOn: '2026-10-09',
      dueTime: '09:00',
      timeZone: 'America/New_York',
    },
  ],
};
function Editor() {
  const [schedule, setSchedule] = useState<PlannerTemplateData['schedule']>();
  return (
    <>
      <PlannerTemplateScheduleEditor config={{ ...config, schedule }} onChange={setSchedule} />
      <output>{JSON.stringify(schedule ?? null)}</output>
    </>
  );
}
describe('Planner relative templates', () => {
  it('calculates positive start offsets and negative due offsets from the source project', () => {
    expect(plannerTemplateOffsets(config, 'start').dates).toEqual([
      { startOffset: 1, dueOffset: 3 },
    ]);
    expect(plannerTemplateOffsets(config, 'due').dates).toEqual([
      { startOffset: -5, dueOffset: -3 },
    ]);
  });
  it('preserves input after React events finish and allows dates to be omitted', () => {
    render(<Editor />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Schedule dates from' }), {
      target: { value: 'start' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Prepare due offset' }), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Count working days and skip weekends' }));
    expect(JSON.parse(screen.getByRole('status').textContent!)).toMatchObject({
      anchor: 'start',
      skipWeekends: true,
      dates: [{ startOffset: 1, dueOffset: 5 }],
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Prepare due offset' }), {
      target: { value: '' },
    });
    expect(JSON.parse(screen.getByRole('status').textContent!).dates[0].dueOffset).toBeNull();
  });
  it('counts workdays in both directions and clears time or recurrence when a relative due date is omitted', () => {
    const next = plannerTemplateSchedule(
      {
        ...config,
        schedule: {
          anchor: 'due',
          skipWeekends: true,
          dates: [{ startOffset: -2, dueOffset: -1 }],
        },
      },
      '2026-10-12',
    );
    expect(next.tasks[0]).toMatchObject({
      startOn: '2026-10-08',
      dueOn: '2026-10-09',
      dueTime: '09:00',
    });
    const cleared = plannerTemplateSchedule(
      {
        ...config,
        schedule: {
          anchor: 'start',
          skipWeekends: true,
          dates: [{ startOffset: 0, dueOffset: null }],
        },
      },
      '2026-10-10',
    );
    expect(cleared.tasks[0]).toMatchObject({
      startOn: '2026-10-12',
      dueOn: null,
      dueTime: null,
      recurrence: null,
    });
    expect(config.tasks[0]!.dueOn).toBe('2026-10-09');
  });
});
