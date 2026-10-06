import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  me: { features: { meriJobs: true } as { meriJobs?: boolean } },
  data: undefined as unknown,
}));
vi.mock('../../lib/me.js', () => ({ useMe: () => ({ data: mocks.me }) }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => ({ get: vi.fn() }) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { enabled?: boolean }) => ({ data: options.enabled ? mocks.data : undefined }),
}));
import { MeriRunningJobs, runningJobRows } from './MeriRunningJobs.js';

const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const row = (id: string, status: string, updatedAt = '2026-10-06T11:00:00.000Z') => ({
  id,
  title: `Job ${id}`,
  updatedAt,
  metadata: { handoff: { conversationId: `conversation-${id}` } },
  job: { kind: 'deliverable', status, goalRevision: 0, deliverables: [], awaitingStart: status === 'queued' },
});

describe('running jobs rail', () => {
  beforeEach(() => {
    mocks.me.features = { meriJobs: true };
    mocks.data = undefined;
  });

  test('lists active and recently paused jobs only', () => {
    const rows = runningJobRows(
      [
        row('a', 'executing'),
        row('b', 'completed'),
        row('c', 'queued'),
        row('d', 'queued', '2026-10-04T11:00:00.000Z'),
        row('e', 'cancel_requested'),
        { id: 'f', job: { kind: 'research' }, metadata: {} },
      ],
      NOW,
    );
    expect(rows.map((entry) => [entry.id, entry.job.status])).toEqual([
      ['a', 'executing'],
      ['c', 'queued'],
      ['e', 'cancel_requested'],
    ]);
  });

  test('opens the job conversation and says jobs continue in the background', async () => {
    mocks.data = runningJobRows([row('a', 'executing')], NOW);
    const onSelect = vi.fn();
    await act(async () => {
      render(<MeriRunningJobs identityKey="k" onSelect={onSelect} />);
    });
    expect(screen.getByText(/continue in the background/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Job a/ }));
    expect(onSelect).toHaveBeenCalledWith('conversation-a');
  });

  test('renders nothing without the jobs flag', async () => {
    mocks.me.features = { meriJobs: false };
    mocks.data = runningJobRows([row('a', 'executing')], NOW);
    await act(async () => {
      render(<MeriRunningJobs identityKey="k" onSelect={vi.fn()} />);
    });
    expect(screen.queryByRole('region', { name: 'Running jobs' })).toBeNull();
  });
});
