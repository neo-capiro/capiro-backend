import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANNER_DEFAULT_TIME_OPTIONS, type PlannerBootstrap } from '@capiro/strategy-verifier';
import { PlannerImport } from './planner-import.js';
const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('./planner-api.js', () => ({
  usePlannerMutations: () => ({ importTask: { mutateAsync: mocks.save } }),
  plannerError: (e: Error) => e.message,
}));
const bootstrap: PlannerBootstrap = {
  me: { id: 'alex', name: 'Alex' },
  people: [{ id: 'alex', name: 'Alex' }],
  projects: [],
  timeOptions: PLANNER_DEFAULT_TIME_OPTIONS,
};
beforeEach(() => mocks.save.mockReset().mockResolvedValue({ id: 'new-task' }));
afterEach(cleanup);
const upload = async (source: string) => {
  const file = new File([source], 'time.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: async () => source });
  fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [file] } });
  await waitFor(() => expect(screen.queryByText(/tasks ready to import/)).toBeInTheDocument());
};
describe('Reviewed CSV time transfer', () => {
  it('previews both durations and sends only task fields plus a captured key/date', async () => {
    render(<PlannerImport bootstrap={bootstrap} onClose={() => {}} />);
    await upload('Task,Assignee,Estimated time,Actual time\nOne,Alex,2hr 15min,1:30');
    expect(screen.getByText('2:15')).toBeVisible();
    expect(screen.getByText('1:30')).toBeVisible();
    expect(screen.getByText(/They do not recreate the source/)).toBeVisible();
    fireEvent.input(screen.getByLabelText('Work date for imported time'), {
      target: { value: '2026-12-14' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import reviewed tasks' }));
    await screen.findByText('1 of 1 created');
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        importKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
        actualMinutes: 90,
        time: { workedOn: '2026-12-14', timeZone: 'UTC' },
        data: expect.objectContaining({ name: 'One', assigneeId: 'alex', estimateMinutes: 135 }),
      }),
    );
    expect(mocks.save.mock.calls[0]![0].data).not.toHaveProperty('importedActualMinutes');
    expect(screen.getByLabelText('Work date for imported time')).toBeDisabled();
  });
  it('reuses the exact row key after an ambiguous first response', async () => {
    mocks.save.mockRejectedValueOnce(new Error('Connection interrupted'));
    const view = render(<PlannerImport bootstrap={bootstrap} onClose={() => {}} />);
    await upload('Task,Actual time\nOne,0.5');
    fireEvent.click(screen.getByRole('button', { name: 'Import reviewed tasks' }));
    await screen.findByRole('alert');
    const first = mocks.save.mock.calls[0]![0];
    expect(screen.getByLabelText('CSV file')).toBeDisabled();
    expect(screen.getByLabelText('Work date for imported time')).toBeDisabled();
    view.rerender(
      <PlannerImport
        bootstrap={{
          ...bootstrap,
          timeOptions: { ...PLANNER_DEFAULT_TIME_OPTIONS, timeZone: 'America/New_York' },
        }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import reviewed tasks' }));
    await screen.findByText('1 of 1 created');
    expect(mocks.save.mock.calls[1]![0]).toEqual(first);
  });
  it('resumes only remaining rows after a later failure and keeps their original keys', async () => {
    mocks.save
      .mockResolvedValueOnce({ id: 'first' })
      .mockRejectedValueOnce(new Error('Interrupted'));
    render(<PlannerImport bootstrap={bootstrap} onClose={() => {}} />);
    await upload('Task,Estimated time,Actual time\nOne,1,0\nTwo,1,1');
    fireEvent.click(screen.getByRole('button', { name: 'Import reviewed tasks' }));
    await screen.findByRole('alert');
    const second = mocks.save.mock.calls[1]![0];
    expect(screen.getByLabelText('CSV file')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Resume remaining import' }));
    await screen.findByText('2 of 2 created');
    expect(mocks.save).toHaveBeenCalledTimes(3);
    expect(mocks.save.mock.calls[2]![0]).toEqual(second);
  });
  it('rejects malformed time in any row before offering creation', async () => {
    render(<PlannerImport bootstrap={bootstrap} onClose={() => {}} />);
    const file = new File(['x'], 'bad.csv');
    Object.defineProperty(file, 'text', { value: async () => 'Task,Actual time\nOne,1\nTwo,1:60' });
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [file] } });
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Import reviewed tasks' })).toBeDisabled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
