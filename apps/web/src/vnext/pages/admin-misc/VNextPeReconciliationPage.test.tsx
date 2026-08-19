/**
 * Ported from pages/admin/PeReconciliationPage.test.tsx — same endpoint +
 * payload assertions (GET reconciliation-queue with the status filter; POST
 * .../:id/resolve with keep_current / accept_conflicting / manual_value),
 * adapted to the vNext confirm-dialog flow and the in-page 403 gate.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VNextPeReconciliationPage } from './VNextPeReconciliationPage.js';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock }),
}));

let meRole = 'capiro_admin';
vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({ data: { role: meRole }, isLoading: false }),
}));

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'rq1',
    peCode: '0603270A',
    fy: 2027,
    fieldName: 'budget_authority',
    currentValue: '12.5',
    conflictingSource: 'dtic_r2',
    conflictingValue: '14.0',
    deltaPct: 0.12,
    queuedAt: '2026-06-04T12:00:00.000Z',
    status: 'open',
    ...over,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VNextPeReconciliationPage />
    </QueryClientProvider>,
  );
}

describe('VNextPeReconciliationPage', () => {
  beforeEach(() => {
    meRole = 'capiro_admin';
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiPostMock.mockResolvedValue({ data: { resolved: true } });
  });

  test('renders the open queue with the status filter (GET carries status=open)', async () => {
    apiGetMock.mockResolvedValue({ data: { data: [entry()], total: 1, page: 1, limit: 25 } });

    renderPage();

    expect(await screen.findByText('0603270A')).toBeInTheDocument();
    expect(screen.getByText('dtic_r2')).toBeInTheDocument();
    expect(screen.getByText('12.0%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manual…' })).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/program-elements/admin/reconciliation-queue',
      expect.objectContaining({ params: { status: 'open' } }),
    );
  });

  test('Keep resolves via POST with decision=keep_current (confirm flow)', async () => {
    apiGetMock.mockResolvedValue({ data: { data: [entry()], total: 1, page: 1, limit: 25 } });

    renderPage();
    await screen.findByText('0603270A');

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    // Confirm inside the dialog (its OK button is also named Keep).
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    expect(apiPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/program-elements/admin/reconciliation-queue/rq1/resolve'),
      expect.objectContaining({ decision: 'keep_current' }),
    );
  });

  test('Manual… applies a numeric manual value via decision=manual_value', async () => {
    apiGetMock.mockResolvedValue({ data: { data: [entry()], total: 1, page: 1, limit: 25 } });

    renderPage();
    await screen.findByText('0603270A');

    fireEvent.click(screen.getByRole('button', { name: 'Manual…' }));
    const dialog = await screen.findByRole('dialog');

    // Submitting without a value is guarded (no POST, inline error).
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply value' }));
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Enter a numeric value in $ millions')).toBeInTheDocument();

    // Regex matcher: the inline validation error rendered by the previous
    // guarded submit is part of the label element's text, so an exact-string
    // label query no longer matches.
    fireEvent.change(within(dialog).getByLabelText(/Value \(\$ millions\)/), {
      target: { value: '15.25' },
    });
    fireEvent.change(within(dialog).getByLabelText('Notes (optional)'), {
      target: { value: 'analyst call' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply value' }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    expect(apiPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/program-elements/admin/reconciliation-queue/rq1/resolve'),
      expect.objectContaining({ decision: 'manual_value', manualValue: 15.25, notes: 'analyst call' }),
    );
  });

  test('non-admin sees the in-page 403 (server RolesGuard remains the boundary)', () => {
    meRole = 'user_admin';
    renderPage();

    expect(screen.getByText('403')).toBeInTheDocument();
    expect(
      screen.getByText('Reconciliation review is restricted to Capiro administrators.'),
    ).toBeInTheDocument();
    // The gated query never fires.
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('honest empty state', async () => {
    apiGetMock.mockResolvedValue({ data: { data: [], total: 0, page: 1, limit: 25 } });

    renderPage();

    expect(await screen.findByText('No open reconciliation entries.')).toBeInTheDocument();
  });
});
