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
const patchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock, patch: patchMock }),
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
  patchMock.mockReset();
});

function capabilityNamed(id: string, name: string): Capability {
  return { ...CAPABILITY, id, name };
}

describe('ClientCrmCapabilitiesProto (drawer — the branch a real client profile actually renders)', () => {
  it('renders every capability area at once — no more "3 at a time, click through pages"', async () => {
    const many = [
      capabilityNamed('cap-1', 'Autonomous ground maneuver'),
      capabilityNamed('cap-2', 'GPS-denied navigation'),
      capabilityNamed('cap-3', 'Tactical mesh networking'),
      capabilityNamed('cap-4', 'Contested-logistics resupply'),
      capabilityNamed('cap-5', 'Directed-energy countermeasures'),
    ];
    mockApis(many);
    renderDrawer();

    for (const cap of many) {
      await waitFor(() => expect(screen.getByText(cap.name)).toBeInTheDocument());
    }
    expect(screen.getByText('5 areas')).toBeInTheDocument();
    // The old carousel's prev/next arrows and page dots are gone entirely.
    expect(screen.queryByRole('button', { name: 'Next capability' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous capability' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Capability page 2' })).not.toBeInTheDocument();
  });


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

  /**
   * Q04 — Capability TRL display does not update after saving.
   *
   * Repro: open a capability with no TRL set, click TRL 1. The closed card's
   * maturity pill flips ("Research") because it reads live from the refetched
   * list, but the still-OPEN editor kept showing "Not set — click to set"
   * until you closed and reopened it. Selecting a second value (TRL 9) showed
   * the same lag — the editor stayed on the FIRST saved value while the list
   * had already moved to "Fielded". Root cause: the editor was held as a
   * snapshot object (`editing`) captured at open time, never re-derived after
   * the save's list refetch. Fixed by tracking the open capability by id and
   * deriving the rendered object from the live query on every render — same
   * fix already applied to the canonical antd drawer.
   */
  it('Q04: the open editor reflects each freshly saved TRL value without closing and reopening', async () => {
    const noTrl = capabilityNamed('cap-1', 'Autonomous ground maneuver');
    noTrl.trl = null;
    mockApis([noTrl]);
    let currentList = [noTrl];
    patchMock.mockImplementation(async (_url: string, patch: Record<string, unknown>) => {
      currentList = [{ ...currentList[0]!, ...patch }];
      getMock.mockImplementation((url: string) => {
        if (url === '/api/clients/client-1/capabilities') return Promise.resolve({ data: currentList });
        if (url === '/api/clients/client-1/capability-fit') return Promise.resolve({ data: FIT_EMPTY });
        if (url === '/api/engagement/attachments') return Promise.resolve({ data: [] });
        return Promise.reject(new Error(`unexpected GET ${url}`));
      });
      return { data: currentList[0] };
    });
    renderDrawer();

    // Open the capability — TRL starts unset.
    fireEvent.click(await screen.findByText('Autonomous ground maneuver'));
    expect(await screen.findByText('Not set — click to set')).toBeInTheDocument();

    // Select TRL 1. The OPEN editor (not just the closed card) must update.
    fireEvent.click(screen.getByRole('button', { name: 'TRL 1: Basic principles' }));
    await waitFor(() => expect(patchMock).toHaveBeenCalledWith('/api/clients/client-1/capabilities/cap-1', { trl: 1 }));
    await waitFor(() => expect(screen.queryByText('Not set — click to set')).not.toBeInTheDocument());
    expect(await screen.findByText('TRL 1 · Basic principles')).toBeInTheDocument();

    // Select TRL 9. The editor must move off TRL 1, not stay stuck on it.
    fireEvent.click(screen.getByRole('button', { name: 'TRL 9: Operational proven' }));
    await waitFor(() => expect(patchMock).toHaveBeenCalledWith('/api/clients/client-1/capabilities/cap-1', { trl: 9 }));
    await waitFor(() => expect(screen.queryByText('TRL 1 · Basic principles')).not.toBeInTheDocument());
    expect(await screen.findByText('TRL 9 · Operational proven')).toBeInTheDocument();
  });

  /**
   * Q05 — removing a PE chip leaves an inconsistent capability list.
   *
   * End-to-end repro against a real query cache + refetch loop (the unit-level
   * assertion lives in CapabilityDrawerVNext.test.tsx): add PE "invalid-pe"
   * (normalized to INVALID-PE), remove it via the chip's × only (no typing,
   * no input focus), switch to the Documents tab and back — the removal must
   * not have been lost, and the closed card's own "PE ..." line (backed by
   * the same list query) must never disgree with what the reopened editor
   * shows.
   */
  it('Q05: removing a PE chip persists across a tab switch and matches the closed card', async () => {
    const cap = capabilityNamed('cap-1', 'Autonomous ground maneuver');
    mockApis([cap]);
    let currentList = [cap];
    patchMock.mockImplementation(async (_url: string, patch: Record<string, unknown>) => {
      currentList = [{ ...currentList[0]!, ...patch }];
      getMock.mockImplementation((url: string) => {
        if (url === '/api/clients/client-1/capabilities') return Promise.resolve({ data: currentList });
        if (url === '/api/clients/client-1/capability-fit') return Promise.resolve({ data: FIT_EMPTY });
        if (url === '/api/engagement/attachments') return Promise.resolve({ data: [] });
        return Promise.reject(new Error(`unexpected GET ${url}`));
      });
      return { data: currentList[0] };
    });
    renderDrawer();

    fireEvent.click(await screen.findByText('Autonomous ground maneuver'));
    const peInput = screen.getByLabelText('PE numbers');
    fireEvent.change(peInput, { target: { value: 'invalid-pe' } });
    fireEvent.keyDown(peInput, { key: 'Enter' });
    fireEvent.blur(peInput);
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-1/capabilities/cap-1', {
        peNumbers: ['INVALID-PE'],
      }),
    );
    expect(await screen.findByText('INVALID-PE')).toBeInTheDocument();

    // Remove via the chip's × ONLY — the QA repro's exact interaction.
    fireEvent.click(screen.getByRole('button', { name: 'Remove INVALID-PE' }));
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-1/capabilities/cap-1', {
        peNumbers: [],
      }),
    );

    // Switch to Documents and back WITHOUT ever touching the PE input again —
    // this is what threw the un-persisted removal away before the fix.
    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Profile' }));
    expect(screen.queryByText('INVALID-PE')).not.toBeInTheDocument();

    // Close and reopen — reads straight from the (by-now refetched) list,
    // proving this isn't a display-only removal that the server never saw.
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    fireEvent.click(await screen.findByText('Autonomous ground maneuver'));
    expect(screen.queryByText('INVALID-PE')).not.toBeInTheDocument();

    // The closed card's own PE line must agree — no split between the two.
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(screen.queryByText('PE INVALID-PE')).not.toBeInTheDocument();
  });
});
