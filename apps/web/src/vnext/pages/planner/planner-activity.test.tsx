// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { PlannerEvent } from '@capiro/strategy-verifier';
import { PlannerActivity } from './planner-activity.js';

afterEach(cleanup);
const original: PlannerEvent = {
  id: 'activity-first',
  actorId: 'author',
  taskId: 'task',
  projectId: null,
  kind: 'comment',
  text: 'First comment',
  minutes: null,
  createdAt: '2026-10-06T12:00:00Z',
  version: 0,
};
function props(
  event = original,
  mutateAsync = vi.fn().mockResolvedValue(event),
): ComponentProps<typeof PlannerActivity> {
  return {
    event,
    author: 'Author',
    me: 'author',
    access: 'editor',
    mutation: { mutateAsync, isPending: false } as ComponentProps<
      typeof PlannerActivity
    >['mutation'],
  };
}
describe('Planner activity corrections', () => {
  it('keeps the opening version and draft when a concurrent correction rejects a save', async () => {
    const mutation = vi.fn().mockRejectedValue({ response: { status: 409 } });
    const initial = props(original, mutation);
    const { rerender } = render(<PlannerActivity {...initial} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit comment' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit comment' }), {
      target: { value: 'My correction' },
    });
    rerender(
      <PlannerActivity
        {...initial}
        event={{ ...original, version: 1, text: 'Other correction' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Someone else updated'),
    );
    expect(mutation).toHaveBeenCalledWith({ id: original.id, version: 0, text: 'My correction' });
    expect(screen.getByRole('textbox', { name: 'Edit comment' })).toHaveValue('My correction');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));
    expect(screen.getByText('Other correction')).toBeInTheDocument();
  });
  it('validates time corrections and removes or restores using the current version', async () => {
    const time = { ...original, kind: 'time' as const, text: 'Meeting', minutes: 15, version: 2 };
    const mutation = vi.fn().mockResolvedValue(time);
    const initial = props(time, mutation);
    const { rerender } = render(<PlannerActivity {...initial} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit time entry' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Edit logged minutes' }), {
      target: { value: '0' },
    });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Edit logged minutes' }), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
    expect(mutation).toHaveBeenCalledWith({
      id: time.id,
      version: 2,
      text: 'Meeting',
      minutes: 30,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove time entry' }));
    await waitFor(() =>
      expect(mutation).toHaveBeenLastCalledWith({ id: time.id, version: 2, removed: true }),
    );
    rerender(
      <PlannerActivity
        {...initial}
        event={{ ...time, text: '', minutes: null, removed: true, version: 3 }}
      />,
    );
    expect(screen.queryByText('Meeting')).toBeNull();
    expect(screen.getByText('Time entry removed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore time entry' }));
    await waitFor(() =>
      expect(mutation).toHaveBeenLastCalledWith({ id: time.id, version: 3, removed: false }),
    );
  });
  it('shows controls only for the author with current permission and excludes generated activity', () => {
    const initial = props();
    const { rerender } = render(<PlannerActivity {...initial} me="someone-else" />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<PlannerActivity {...initial} access="viewer" />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<PlannerActivity {...initial} access="commenter" />);
    expect(screen.getByRole('button', { name: 'Edit comment' })).toBeInTheDocument();
    rerender(
      <PlannerActivity
        {...initial}
        access="commenter"
        event={{ ...original, kind: 'time', minutes: 15 }}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<PlannerActivity {...initial} event={{ ...original, kind: 'created' }} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
