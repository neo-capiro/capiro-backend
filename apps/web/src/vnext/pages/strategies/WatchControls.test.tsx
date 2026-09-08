import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchControls } from './WatchControls.js';

const state = vi.hoisted(() => ({ data: {} as any, error: false, configure: vi.fn(), check: vi.fn(), refetch: vi.fn() }));
vi.mock('./strategies-api.js', () => ({
  useWatchMonitoring: () => ({ data: state.data, isError: state.error, refetch: state.refetch }),
  useConfigureWatchMonitoring: () => ({ mutateAsync: state.configure }),
  useRevalidateWatch: () => ({ mutateAsync: state.check }),
}));
beforeEach(() => {
  state.data = { available: true, schedulerEnabled: false, mission: null, lastRun: null };
  state.error = false;
  state.configure.mockReset(); state.check.mockReset(); state.refetch.mockReset();
  state.refetch.mockImplementation(async () => ({ data: state.data }));
  state.check.mockResolvedValue({ pendingCount: 0, lastRecheck: { state: 'complete' } });
});
const show = () => render(<MemoryRouter><WatchControls strategyId="strategy" /></MemoryRouter>);

describe('Strategy monitoring controls', () => {
  it('shows never checked and requires an explicit scoped save before a check', async () => {
    show();
    expect(screen.getByText(/Never checked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
    expect(state.configure).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Monitoring frequency'), { target: { value: 'manual' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save monitoring' }));
    await waitFor(() => expect(state.configure).toHaveBeenCalledWith('manual'));
  });

  it('checks via the canonical version-aware path without configuring another mission', async () => {
    state.data.mission = { id: 'mission', state: 'active', cadence: null };
    show(); fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(screen.getByText('Check complete. 0 proposed changes ready for review.')).toBeInTheDocument());
    expect(state.check).toHaveBeenCalledTimes(1);
    expect(state.configure).not.toHaveBeenCalled();
  });

  it('does not treat a failed check or failed status refresh as success', async () => {
    state.data.mission = { id: 'mission', state: 'active', cadence: null };
    state.check.mockResolvedValue({ pendingCount: 0, lastRecheck: { state: 'failed' } });
    show(); fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The check failed'));
    state.refetch.mockResolvedValue({ isError: true, error: new Error('Monitoring unavailable') });
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Monitoring unavailable'));
    expect(state.check).toHaveBeenCalledTimes(1);
  });
});
