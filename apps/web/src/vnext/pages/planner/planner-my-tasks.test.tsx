import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANNER_DEFAULT_MY_TASKS, type PlannerMyTasksData } from '@capiro/strategy-verifier';
import { PlannerMyTasksSettings } from './planner-my-tasks.js';
afterEach(cleanup);
describe('Planner personal date rule editor', () => {
  it('saves a configured private reminder together with placements and sections', async () => {
    const onSave = vi.fn(async (_data: PlannerMyTasksData) => undefined);
    render(
      <PlannerMyTasksSettings
        data={PLANNER_DEFAULT_MY_TASKS}
        onSave={onSave}
        onClose={() => {}}
        pending={false}
        error={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add personal date rule' }));
    fireEvent.change(screen.getByLabelText('Rule name'), {
      target: { value: 'Prepare upcoming work' },
    });
    fireEvent.change(screen.getByLabelText('Before due date'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Move to personal section'), {
      target: { value: PLANNER_DEFAULT_MY_TASKS.sections[1]!.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save personal sections' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      placements: [],
      rules: [
        {
          name: 'Prepare upcoming work',
          notify: true,
          schedule: { amount: 2, unit: 'days' },
          sectionId: PLANNER_DEFAULT_MY_TASKS.sections[1]!.id,
        },
      ],
    });
  });
});
