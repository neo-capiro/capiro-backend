// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { PlannerCapacityLimits } from './planner-capacity-limits.js';
afterEach(cleanup);
const draft = {
  revision: 'opening',
  people: [
    { id: 'owner', name: 'Owner', weeklyMinutes: 2400, canEdit: true },
    { id: 'placeholder', name: 'Designer', weeklyMinutes: 1800, canEdit: true },
  ],
};
describe('Weekly capacity review', () => {
  it('does not close a new view after an old pending save finishes', async () => {
    let resolve!: (v: unknown) => void;
    const save = vi.fn().mockImplementation(() => new Promise((r) => (resolve = r))),
      close = vi.fn();
    const result = render(<PlannerCapacityLimits draft={draft} onClose={close} onSave={save} />);
    fireEvent.input(screen.getByLabelText('Owner weekly hours'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save weekly capacity' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    result.unmount();
    resolve({});
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
  });
  it('reviews common values before saving a complete atomic batch', async () => {
    const save = vi.fn().mockResolvedValue({}),
      close = vi.fn();
    render(<PlannerCapacityLimits draft={draft} onClose={close} onSave={save} />);
    fireEvent.input(screen.getByLabelText('Weekly hours for everyone'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to everyone shown' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Owner weekly hours')).toHaveValue(20);
    expect(screen.getByLabelText('Designer weekly hours')).toHaveValue(20);
    fireEvent.click(screen.getByRole('button', { name: 'Save weekly capacity' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('opening', [
        { id: 'owner', weeklyMinutes: 1200 },
        { id: 'placeholder', weeklyMinutes: 1200 },
      ]),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('retains the opening revision and edited values during refresh and reports conflicts', async () => {
    const save = vi.fn().mockRejectedValue(new Error('Capacity changed')),
      close = vi.fn();
    const result = render(<PlannerCapacityLimits draft={draft} onClose={close} onSave={save} />);
    fireEvent.input(screen.getByLabelText('Owner weekly hours'), { target: { value: '0' } });
    result.rerender(
      <PlannerCapacityLimits
        draft={{
          ...draft,
          revision: 'new',
          people: draft.people.map((p) => ({ ...p, weeklyMinutes: 1000 })),
        }}
        onClose={close}
        onSave={save}
      />,
    );
    expect(screen.getByLabelText('Owner weekly hours')).toHaveValue(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save weekly capacity' }));
    await screen.findByRole('alert');
    expect(save).toHaveBeenCalledWith('opening', [{ id: 'owner', weeklyMinutes: 0 }]);
    expect(close).not.toHaveBeenCalled();
  });
  it('allows a personal edit without enabling common edits of read-only people', async () => {
    const save = vi.fn().mockResolvedValue({});
    render(
      <PlannerCapacityLimits
        draft={{ ...draft, people: [draft.people[0]!, { ...draft.people[1]!, canEdit: false }] }}
        onClose={vi.fn()}
        onSave={save}
      />,
    );
    expect(screen.getByLabelText('Designer weekly hours')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply to everyone shown' })).toBeDisabled();
    fireEvent.input(screen.getByLabelText('Owner weekly hours'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save weekly capacity' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('opening', [{ id: 'owner', weeklyMinutes: 1200 }]),
    );
  });
  it('rejects fractional minutes and preserves a one-minute limit', async () => {
    const save = vi.fn().mockResolvedValue({});
    render(<PlannerCapacityLimits draft={draft} onClose={vi.fn()} onSave={save} />);
    fireEvent.input(screen.getByLabelText('Owner weekly hours'), { target: { value: '0.001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save weekly capacity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('whole minutes');
    expect(save).not.toHaveBeenCalled();
    fireEvent.input(screen.getByLabelText('Owner weekly hours'), {
      target: { value: String(1 / 60) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save weekly capacity' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('opening', [{ id: 'owner', weeklyMinutes: 1 }]),
    );
  });
});
