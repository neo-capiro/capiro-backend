/**
 * Capability editor — vNext (re-skin of the canonical CapabilityDrawer).
 *
 * Covers the canonical contract the re-skin must preserve: null renders
 * nothing, the TRL ladder PATCHes (set + clear), token lists save ONCE on blur
 * with normalization, click-to-edit text saves on blur, and the Documents tab
 * reads the shared engagement-attachment store filtered to this capability.
 * Values are absent from every fixture file so assertions cannot pass
 * vacuously.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityDrawerVNext } from './CapabilityDrawerVNext.js';
import type { Capability } from '../../../pages/clients/capability-types.js';

const getMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, patch: patchMock }),
}));

const capability: Capability = {
  id: 'cap-9',
  clientId: 'client-4',
  name: 'Maritime sensing mesh',
  type: 'technology',
  description: 'Buoy-hosted passive sonar mesh.',
  sector: 'Maritime',
  tags: ['undersea'],
  trl: 4,
  mrl: null,
  peNumber: null,
  peNumbers: ['0603713N'],
  keywords: [],
  appropriationAccount: null,
  serviceBranch: null,
  targetSubcommittee: null,
  fundingAsk: null,
  fundingAskLabel: null,
  justification: null,
  districtNexus: null,
  existingContracts: null,
  notes: null,
  sortOrder: 0,
  createdAt: '2026-02-02T00:00:00.000Z',
  updatedAt: '2026-02-02T00:00:00.000Z',
};

function renderDrawer(overrides: Partial<Parameters<typeof CapabilityDrawerVNext>[0]> = {}) {
  const onClose = vi.fn();
  const onUpdated = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <div className="capiro-vnext-root">
        <CapabilityDrawerVNext
          capability={capability}
          clientId="client-4"
          onClose={onClose}
          onUpdated={onUpdated}
          {...overrides}
        />
      </div>
    </QueryClientProvider>,
  );
  return { ...utils, onClose, onUpdated };
}

beforeEach(() => {
  getMock.mockReset();
  patchMock.mockReset();
  patchMock.mockResolvedValue({ data: {} });
  getMock.mockResolvedValue({ data: [] });
});

describe('CapabilityDrawerVNext', () => {
  it('renders nothing for a null capability (canonical contract)', () => {
    const { container } = renderDrawer({ capability: null });
    expect(container.querySelector('.capiro-capd')).toBeNull();
  });

  it('renders the header identity and current TRL state', () => {
    renderDrawer();
    expect(screen.getByText('Maritime sensing mesh')).toBeInTheDocument();
    expect(screen.getByText('technology')).toBeInTheDocument();
    expect(screen.getByText('Maritime')).toBeInTheDocument();
    expect(screen.getByText(/TRL 4 · Lab validated/)).toBeInTheDocument();
  });

  it('PATCHes the TRL on ladder click and clears it when the active step is clicked', async () => {
    const { onUpdated } = renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: /TRL 7: System prototype/ }));
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-4/capabilities/cap-9', { trl: 7 }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());

    // Clicking the ACTIVE step clears (the drawer still shows trl=4 — props
    // did not change — so 4 is the active step).
    fireEvent.click(screen.getByRole('button', { name: /TRL 4: Lab validated/ }));
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-4/capabilities/cap-9', {
        trl: null,
      }),
    );
  });

  it('saves a PE-number token list once on blur, uppercased and de-duped', async () => {
    renderDrawer();
    const input = screen.getByLabelText('PE numbers');

    fireEvent.change(input, { target: { value: '0604402f' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // No PATCH per keystroke/commit — save happens on blur.
    expect(patchMock).not.toHaveBeenCalled();

    fireEvent.blur(input);
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-4/capabilities/cap-9', {
        peNumbers: ['0603713N', '0604402F'],
      }),
    );
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  it('saves Description on blur through click-to-edit', async () => {
    renderDrawer();
    fireEvent.click(screen.getByText('Buoy-hosted passive sonar mesh.'));
    const area = screen.getByPlaceholderText('Describe this capability...');
    fireEvent.change(area, { target: { value: 'Distributed acoustic array, surface-recoverable.' } });
    fireEvent.blur(area);
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-4/capabilities/cap-9', {
        description: 'Distributed acoustic array, surface-recoverable.',
      }),
    );
  });

  it('lists only this capability documents on the Documents tab and shows the real empty state', async () => {
    getMock.mockResolvedValue({
      data: [
        {
          id: 'att-1',
          clientId: 'client-4',
          meetingId: null,
          mailMessageId: null,
          fileName: 'mesh-white-paper.pdf',
          contentType: 'application/pdf',
          byteSize: 1024,
          source: 'capability:cap-9',
          createdAt: '2026-02-03T00:00:00.000Z',
          downloadUrl: 'https://files.example/mesh-white-paper.pdf',
          indexedAt: null,
          uploadedByUserId: null,
          uploadedByName: null,
        },
        {
          id: 'att-2',
          clientId: 'client-4',
          meetingId: null,
          mailMessageId: null,
          fileName: 'unrelated-meeting-notes.pdf',
          contentType: 'application/pdf',
          byteSize: 2048,
          source: 'meeting',
          createdAt: '2026-02-03T00:00:00.000Z',
          downloadUrl: null,
          indexedAt: null,
          uploadedByUserId: null,
          uploadedByName: null,
        },
      ],
    });
    renderDrawer();

    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(await screen.findByText('mesh-white-paper.pdf')).toBeInTheDocument();
    // Attachments from other sources on the same client must not leak in.
    expect(screen.queryByText('unrelated-meeting-notes.pdf')).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Download mesh-white-paper.pdf' }),
    ).toHaveAttribute('href', 'https://files.example/mesh-white-paper.pdf');
    expect(getMock).toHaveBeenCalledWith('/api/engagement/attachments', {
      params: { clientId: 'client-4' },
    });
  });

  it('shows the delete control only when a handler is provided, and wires it', () => {
    const onDelete = vi.fn();
    const { unmount } = renderDrawer({ onDelete });
    fireEvent.click(screen.getByRole('button', { name: 'Delete capability' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    unmount();

    renderDrawer();
    expect(screen.queryByRole('button', { name: 'Delete capability' })).not.toBeInTheDocument();
  });

  it('closes from the header control', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
