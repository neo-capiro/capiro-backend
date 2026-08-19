import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmCapabilitiesProto } from './CapabilitiesTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

/**
 * Regression: "Add capability" was a dead button.
 *
 * It opened `CapabilityDrawerVNext` with `capability={null}`, and that component
 * returns `null` in that case by design (it is an editor — every field saves via
 * `PATCH …/capabilities/:id`, which needs an id). So the modal appeared titled
 * "Capability — New capability" with an entirely EMPTY body: nothing to fill in,
 * nothing to submit. There was no create path on this surface at all.
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

const CREATED = {
  id: 'cap-new',
  clientId: 'client-1',
  name: 'JaiaBot Hydro',
  type: 'product',
  description: null,
  sector: 'DEFENSE',
  tags: ['maritime autonomy'],
  trl: 6,
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
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

function renderCapabilities() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientCrmCapabilitiesProto client={client} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Open the header's "Add capability" and return the dialog.
 *
 * Queries inside the form MUST be scoped to the dialog: the page keeps its own
 * "Add capability" buttons (header + the areas card's empty state) mounted
 * behind the modal, and the form's submit carries the same label.
 */
async function openCreateForm(): Promise<HTMLElement> {
  renderCapabilities();
  await waitFor(() => expect(getMock).toHaveBeenCalled());
  fireEvent.click(screen.getAllByRole('button', { name: 'Add capability' })[0]!);
  return screen.findByRole('dialog');
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockResolvedValue({ data: [] });
});

describe('Capabilities → Add capability', () => {
  it('opens a form with real fields, not an empty modal', async () => {
    const form = await openCreateForm();

    expect(form).toHaveTextContent('New capability');
    // The fields the create DTO accepts are actually present and editable.
    expect(within(form).getByLabelText('Name')).toBeInTheDocument();
    expect(within(form).getByLabelText('Type')).toBeInTheDocument();
    // The shared CapiroSelect puts helpText inside the <label>, so the
    // accessible name is "Sector" + the hint — anchor rather than exact-match.
    expect(within(form).getByLabelText(/^Sector/)).toBeInTheDocument();
    expect(within(form).getByLabelText('Tags')).toBeInTheDocument();
    expect(within(form).getByLabelText('Description')).toBeInTheDocument();
  });

  it('refuses to submit without a name and does not call the API', async () => {
    const form = await openCreateForm();

    fireEvent.click(within(form).getByRole('button', { name: 'Add capability' }));

    expect(await within(form).findByText('Give the capability a name')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('POSTs the collected fields to the real capabilities endpoint', async () => {
    postMock.mockResolvedValue({ data: CREATED });
    const form = await openCreateForm();

    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: '  JaiaBot Hydro  ' } });
    fireEvent.change(within(form).getByLabelText('Type'), { target: { value: 'platform' } });
    fireEvent.change(within(form).getByLabelText(/^Sector/), { target: { value: 'DEFENSE' } });
    fireEvent.change(within(form).getByLabelText('Description'), { target: { value: 'Hydrographic USV' } });
    // A tag typed but never committed with Enter must still be sent — clicking
    // submit blurs the input, and reading committed state would race that blur.
    fireEvent.change(within(form).getByLabelText('Tags'), { target: { value: 'maritime autonomy' } });
    fireEvent.click(within(form).getByRole('button', { name: 'TRL 6: Prototype demonstrated' }));

    fireEvent.click(within(form).getByRole('button', { name: 'Add capability' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/capabilities', {
      name: 'JaiaBot Hydro',
      type: 'platform',
      sector: 'DEFENSE',
      description: 'Hydrographic USV',
      tags: ['maritime autonomy'],
      trl: 6,
    });
  });

  it('omits blank optional fields rather than sending empty strings the API rejects', async () => {
    postMock.mockResolvedValue({ data: CREATED });
    const form = await openCreateForm();

    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Bare minimum' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add capability' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    // `@IsOptional()` skips only null/undefined, so '' would 400.
    expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/capabilities', {
      name: 'Bare minimum',
      type: 'product',
    });
  });

  it('continues into the editor on the saved record so PE numbers and documents are reachable', async () => {
    postMock.mockResolvedValue({ data: CREATED });
    const form = await openCreateForm();

    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'JaiaBot Hydro' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add capability' }));

    // The editor's own fields — only reachable once the record has an id.
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByLabelText('PE numbers')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Match keywords')).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'Documents' })).toBeInTheDocument();
  });
});
