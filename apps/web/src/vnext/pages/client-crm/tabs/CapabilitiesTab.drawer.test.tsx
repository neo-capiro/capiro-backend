import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmCapabilitiesProto } from './CapabilitiesTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import type { Capability } from '../../../../pages/clients/capability-types.js';

/**
 * `ClientCrmPage.tsx` only ever renders this component with `drawer` — the
 * `drawer={false}` branch CapabilitiesTab.test.tsx exercises has no real
 * caller in the app. These cover the branch a client-profile QA pass actually
 * hits: "Add capability" read as toolbar label text next to "Capability
 * areas" and the pagination controls, not as a clickable control, because it
 * was a bare unstyled <button> where every sibling control in this same file
 * uses the real SecondaryBtn. Also covers the delete-confirmation copy,
 * which claimed a cascade ("advocacy history and linked documents are
 * removed") that client-capabilities.service.ts's deleteCapability does not
 * perform — history is preserved (capabilityId set null), and there is no
 * document relation to a capability at all.
 */

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
}));

const client: Client = {
  id: 'client-1',
  name: 'Overland AI',
  website: 'overland.ai',
  description: null,
  productDescription: null,
  primaryContactName: null,
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: null,
  status: 'active',
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

const CAPABILITY: Capability = {
  id: 'cap-1',
  clientId: 'client-1',
  name: 'Autonomous ground maneuver',
  type: 'platform',
  description: 'Off-road autonomy stack.',
  sector: null,
  tags: [],
  trl: 7,
  mrl: null,
  peNumber: null,
  peNumbers: [],
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
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

const FIT_EMPTY = {
  matches: [],
  computedAt: null,
  status: 'empty' as const,
  sources: { pe: false, bill: false, fo: false },
};

function mockApis(capabilities: Capability[]) {
  getMock.mockImplementation((url: string) => {
    if (url === '/api/clients/client-1/capabilities') return Promise.resolve({ data: capabilities });
    if (url === '/api/clients/client-1/capability-fit') return Promise.resolve({ data: FIT_EMPTY });
    if (url === '/api/engagement/attachments') return Promise.resolve({ data: [] });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderDrawer() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientCrmCapabilitiesProto client={client} drawer />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

describe('ClientCrmCapabilitiesProto (drawer — the branch a real client profile actually renders)', () => {
  it('renders the toolbar\'s "Add capability" as a real, clickable button and opens the create form', async () => {
    mockApis([CAPABILITY]);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('Autonomous ground maneuver')).toBeInTheDocument());

    // A visual "reads as clickable" regression isn't something jsdom can
    // assert directly; what this (and the CSS override in
    // capabilities-tab.css) actually guards is that swapping the bare
    // <button> for the real SecondaryBtn kept the click wired to creation.
    const addButton = screen.getByRole('button', { name: 'Add capability' });
    fireEvent.click(addButton);

    expect(screen.getByText('New capability')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('renders the empty state\'s "Add capability" as a real button when the client has none', async () => {
    mockApis([]);
    renderDrawer();

    // The toolbar's own "Add capability" also renders regardless of empty
    // state, so this scopes to the empty-state message's own button.
    const emptyState = await waitFor(() =>
      screen.getByText('No capability areas recorded yet.').closest('div')!,
    );
    fireEvent.click(within(emptyState).getByRole('button', { name: 'Add capability' }));
    expect(screen.getByText('New capability')).toBeInTheDocument();
  });

  it('describes the delete confirmation honestly — no claimed document/history cascade that does not happen', async () => {
    mockApis([CAPABILITY]);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('Autonomous ground maneuver')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Autonomous ground maneuver'));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete capability' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Delete capability' }));

    expect(screen.getByText(/The capability record itself is removed\./)).toBeInTheDocument();
    expect(screen.getByText(/just no longer linked to a capability/)).toBeInTheDocument();
    expect(screen.queryByText(/linked documents are removed/)).not.toBeInTheDocument();
  });
});
