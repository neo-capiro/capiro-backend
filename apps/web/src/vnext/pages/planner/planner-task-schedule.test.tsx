// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PLANNER_DEFAULT_TASK, type PlannerTaskData } from '@capiro/strategy-verifier';
import { PlannerTaskSchedule } from './planner-task-schedule.js';
function Schedule({
  initial,
  disabled = false,
}: {
  initial?: Partial<PlannerTaskData>;
  disabled?: boolean;
}) {
  const [data, setData] = useState({ ...PLANNER_DEFAULT_TASK, name: 'Timed QA', ...initial });
  return (
    <>
      <PlannerTaskSchedule
        data={data}
        disabled={disabled}
        onChange={(patch) => setData((old) => ({ ...old, ...patch }))}
      />
      <output data-testid="data">{JSON.stringify(data)}</output>
    </>
  );
}
afterEach(cleanup);
describe('Planner schedule editing', () => {
  it('sets timed work in a zone and clears its time when the date is removed', () => {
    render(<Schedule initial={{ dueOn: '2026-10-07' }} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Time zone' }), {
      target: { value: 'America/New_York' },
    });
    fireEvent.input(screen.getByLabelText('Due time'), { target: { value: '09:30' } });
    expect(JSON.parse(screen.getByTestId('data').textContent!)).toMatchObject({
      dueTime: '09:30',
      timeZone: 'America/New_York',
    });
    fireEvent.input(screen.getByLabelText('Due date'), { target: { value: '' } });
    expect(JSON.parse(screen.getByTestId('data').textContent!)).toMatchObject({
      dueOn: null,
      dueTime: null,
    });
  });
  it('supports selected weekdays, an end date and completion-based schedules', () => {
    render(<Schedule initial={{ dueOn: '2026-10-05' }} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat' }), {
      target: { value: 'weekly' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wednesday' }));
    fireEvent.input(screen.getByLabelText('Repeat until'), { target: { value: '2026-10-28' } });
    expect(screen.getByText(/Next due date: 2026-10-07/)).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('data').textContent!).recurrence).toMatchObject({
      weekdays: [3],
      endsOn: '2026-10-28',
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat' }), {
      target: { value: 'periodically' },
    });
    expect(screen.getByRole('combobox', { name: 'Repeat from' })).toBeDisabled();
    expect(JSON.parse(screen.getByTestId('data').textContent!).recurrence).toMatchObject({
      frequency: 'periodically',
      basedOn: 'completion_date',
    });
  });
  it('keeps an invalid zone draft visible and respects viewer access', () => {
    render(
      <Schedule
        initial={{ dueOn: '2026-10-05', recurrence: { frequency: 'periodically', interval: 1 } }}
      />,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Time zone' }), {
      target: { value: 'Bad/Zone' },
    });
    expect(screen.getByRole('combobox', { name: 'Time zone' })).toHaveValue('Bad/Zone');
    cleanup();
    render(<Schedule disabled initial={{ dueOn: '2026-10-05' }} />);
    expect(screen.getByLabelText('Due time')).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Repeat' })).toBeDisabled();
  });
});
