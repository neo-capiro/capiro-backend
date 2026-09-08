import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirmPhasesOverlay } from './FirmPhasesOverlay.js';

const state = vi.hoisted(() => ({ error: false, pending: false, refetch: vi.fn(), save: vi.fn() }));
vi.mock('../strategies-api.js', () => ({
  useFirmPhases: () => ({
    data: state.error ? undefined : [
      { id: '1', label: 'Plan', startFy: 2026, startQ: 1, endFy: 2026, endQ: 2 },
      { id: '2', label: 'Review', startFy: 2026, startQ: 2, endFy: 2026, endQ: 3 },
      { id: '3', label: 'Execute', startFy: 2026, startQ: 3, endFy: 2027, endQ: 1 },
    ],
    isLoading: false, isError: state.error, refetch: state.refetch,
  }),
  useTenantMembers: () => ({ data: [] }),
  usePutFirmPhases: () => ({ mutate: state.save, isPending: state.pending, isError: false }),
  memberName: () => 'Teammate',
}));

beforeEach(() => { state.error = false; state.pending = false; vi.clearAllMocks(); });
const show = () => render(<MemoryRouter><FirmPhasesOverlay /></MemoryRouter>);

describe('Firm phase persistence', () => {
  it('shows the failed initial request with retry instead of an endless skeleton', () => {
    state.error = true;
    show();
    expect(screen.getByText('Firm phases could not be loaded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it('prevents equal or reversed end boundaries and enforces the API fiscal year range', () => {
    show();
    fireEvent.change(screen.getByLabelText('Plan — end quarter'), { target: { value: '1' } });
    expect(screen.getByText(/Every phase must end after it starts\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save phases' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Plan — end quarter'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Plan — start fiscal year'), { target: { value: '-2026' } });
    expect(screen.getByText(/Fiscal years must be between 2000 and 2100\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save phases' })).toBeDisabled();
    expect(state.save).not.toHaveBeenCalled();
  });

  it('keeps all inputs and modal close actions locked while a replacement saves', () => {
    state.pending = true;
    show();
    expect(screen.getByLabelText('Phase 1 name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

it('previews extending an expired phase model and only persists after Save', () => {
  render(<MemoryRouter initialEntries={['/strategies/phases?phaseStartFy=2026&phaseEndFy=2028']}><FirmPhasesOverlay /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Extend last phase through FY2028' }));
  expect(screen.getByLabelText('Execute — end fiscal year')).toHaveValue(2029);
  expect(state.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save phases' }));
  expect(state.save).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ label: 'Execute', endFy: 2029, endQ: 1 })]), expect.any(Object));
});
