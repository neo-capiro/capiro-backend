import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { CapiroToastProvider } from '../../components/feedback/toast.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManageFacilitiesModal } from './ManageFacilitiesModal.js';

/**
 * The vNext facilities editor that replaced a dead "Manage facilities" button
 * (it navigated to `?tab=facilities`, which routes back to the view already on
 * screen).
 *
 * The validation tests matter more than they look: the API cross-checks a
 * district against its state's seat count, so a plausible-looking "WA-14" is a
 * server 400. Catching it in the form is the difference between a labelled field
 * error and an opaque failed save.
 */

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock, patch: patchMock, delete: deleteMock }),
}));

const FACILITY = {
  id: 'fac-1',
  clientId: 'client-1',
  name: 'Seattle HQ',
  addressLine: '1201 3rd Ave',
  city: 'Seattle',
  state: 'WA',
  zip: '98101',
  congressionalDistrict: '07',
  employeeCount: 240,
  notes: null,
  latitude: 47.6,
  longitude: -122.3,
  stateHouseDistrict: '41',
  stateSenateDistrict: '46',
  geocodedAt: '2026-07-01T00:00:00.000Z',
  geocodeStatus: 'matched',
  districtSource: 'geocoded',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

function renderModal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CapiroToastProvider>
          <ManageFacilitiesModal
            open
            clientId="client-1"
            clientName="Overland AI"
            onClose={() => {}}
          />
        </CapiroToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Open the create form and return it. */
async function openAddForm(): Promise<HTMLElement> {
  renderModal();
  await waitFor(() => expect(getMock).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole('button', { name: 'Add facility' }));
  return (await screen.findByLabelText('Facility name')).closest('form')!;
}

afterEach(() => cleanup());

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  patchMock.mockReset();
  deleteMock.mockReset();
  getMock.mockResolvedValue({ data: [FACILITY] });
});

describe('ManageFacilitiesModal', () => {
  it('lists the real facilities with location, headcount, and geocode state', async () => {
    renderModal();

    expect(await screen.findByText('Seattle HQ')).toBeInTheDocument();
    const row = screen.getByText('Seattle HQ').closest('li')!;
    expect(row).toHaveTextContent('Seattle, WA');
    expect(row).toHaveTextContent('WA-07');
    expect(row).toHaveTextContent('240 employees');
    expect(row).toHaveTextContent('Geocoded');
  });

  it('shows the automatic source, geocoded federal district, and state legislative districts', async () => {
    renderModal();

    const row = (await screen.findByText('Seattle HQ')).closest('li')!;
    expect(row).toHaveTextContent('Source: Automatic');
    expect(row).toHaveTextContent('Geocoder: Matched');
    expect(row).toHaveTextContent('State House 41');
    expect(row).toHaveTextContent('State Senate 46');
  });

  it('shows the Census standardized address recommendation for a matched facility', async () => {
    getMock.mockResolvedValue({
      data: [{ ...FACILITY, geocodeMatchedAddress: '1201 3RD AVE, SEATTLE, WA, 98101' }],
    });
    renderModal();

    expect(
      await screen.findByText('Census address: 1201 3RD AVE, SEATTLE, WA, 98101'),
    ).toBeInTheDocument();
  });

  it('lets the user explicitly choose an ambiguous Census address', async () => {
    const ambiguous = {
      ...FACILITY,
      congressionalDistrict: null,
      districtSource: null,
      geocodeStatus: 'ambiguous',
      geocodeCandidates: [
        {
          matchedAddress: '1201 3RD AVE, SEATTLE, WA, 98101',
          addressLine: '1201 3RD AVE',
          city: 'SEATTLE',
          state: 'WA',
          zip: '98101',
          latitude: 47.6,
          longitude: -122.3,
          congressionalDistrict: '07',
          congressionalDistrictCongress: 119,
          stateHouseDistrict: '41',
          stateSenateDistrict: '46',
        },
      ],
    };
    getMock.mockResolvedValue({ data: [ambiguous] });
    postMock.mockResolvedValue({ data: { ...FACILITY, geocodeStatus: 'matched' } });
    renderModal();

    const row = (await screen.findByText('Seattle HQ')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Use this address' }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/clients/client-1/facilities/fac-1/geocode-candidate',
        { candidateIndex: 0 },
      ),
    );
  });

  it.each([
    [
      'manual',
      { districtSource: 'user', geocodeStatus: 'error' },
      'Source: Manual',
      'Geocoder: Error',
    ],
    [
      'unresolved',
      { districtSource: null, geocodeStatus: 'no_match', congressionalDistrict: null },
      'Source: Unresolved',
      'Geocoder: No match',
    ],
    [
      'pending',
      { districtSource: null, geocodeStatus: 'pending', congressionalDistrict: null },
      'Source: Pending',
      'Geocoder: Pending',
    ],
    [
      'ambiguous',
      { districtSource: null, geocodeStatus: 'ambiguous' },
      'Source: Ambiguous',
      'Geocoder: Ambiguous',
    ],
    ['error', { districtSource: null, geocodeStatus: 'error' }, 'Source: Error', 'Geocoder: Error'],
  ])('keeps the %s resolution state visible', async (_name, overrides, source, geocoder) => {
    getMock.mockResolvedValue({ data: [{ ...FACILITY, ...overrides }] });
    renderModal();

    const row = (await screen.findByText('Seattle HQ')).closest('li')!;
    expect(row).toHaveTextContent(source);
    expect(row).toHaveTextContent(geocoder);
  });

  it('retries district resolution through the real endpoint', async () => {
    const unresolved = {
      ...FACILITY,
      districtSource: null,
      geocodeStatus: 'error',
      congressionalDistrict: null,
    };
    const resolved = { ...FACILITY, districtSource: 'geocoded', geocodeStatus: 'matched' };
    getMock.mockResolvedValueOnce({ data: [unresolved] }).mockResolvedValue({ data: [resolved] });
    postMock.mockResolvedValue({ data: resolved });
    renderModal();

    const row = (await screen.findByText('Seattle HQ')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Resolve district' }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/clients/client-1/facilities/fac-1/resolve-district',
      ),
    );
    await waitFor(() => expect(row).toHaveTextContent('Source: Automatic'));
  });

  it('polls facilities while a district resolution is pending', async () => {
    getMock.mockResolvedValue({
      data: [
        {
          ...FACILITY,
          districtSource: null,
          geocodeStatus: 'pending',
          congressionalDistrict: null,
        },
      ],
    });
    renderModal();
    expect(await screen.findByText('Seattle HQ')).toBeInTheDocument();
    const initialCalls = getMock.mock.calls.length;

    await waitFor(() => expect(getMock.mock.calls.length).toBeGreaterThan(initialCalls), {
      timeout: 3_000,
      interval: 100,
    });
  });

  it('says so plainly when the client has no facilities', async () => {
    getMock.mockResolvedValue({ data: [] });
    renderModal();

    expect(await screen.findByText(/No facilities recorded yet/)).toBeInTheDocument();
  });

  it('creates a facility through the real endpoint', async () => {
    postMock.mockResolvedValue({ data: { ...FACILITY, id: 'fac-2' } });
    const form = await openAddForm();

    fireEvent.change(within(form).getByLabelText('Facility name'), {
      target: { value: 'Austin plant' },
    });
    fireEvent.change(within(form).getByLabelText('City'), { target: { value: 'Austin' } });
    fireEvent.change(within(form).getByLabelText('State'), { target: { value: 'TX' } });
    fireEvent.change(within(form).getByLabelText(/^District/), { target: { value: '35' } });
    fireEvent.change(within(form).getByLabelText('Employees'), { target: { value: '120' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save facility' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/facilities', {
      name: 'Austin plant',
      addressLine: null,
      city: 'Austin',
      state: 'TX',
      zip: null,
      congressionalDistrict: '35',
      employeeCount: 120,
      notes: null,
    });
  });

  it('rejects a district the state does not have, before the server does', async () => {
    const form = await openAddForm();

    fireEvent.change(within(form).getByLabelText('Facility name'), {
      target: { value: 'Tacoma yard' },
    });
    fireEvent.change(within(form).getByLabelText('State'), { target: { value: 'WA' } });
    // WA has 10 districts — 14 is a guaranteed server 400.
    fireEvent.change(within(form).getByLabelText(/^District/), { target: { value: '14' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save facility' }));

    expect(await within(form).findByText('WA has 10 districts')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('directs a single-seat state to the at-large sentinel', async () => {
    const form = await openAddForm();

    fireEvent.change(within(form).getByLabelText('Facility name'), {
      target: { value: 'Cheyenne depot' },
    });
    fireEvent.change(within(form).getByLabelText('State'), { target: { value: 'WY' } });
    fireEvent.change(within(form).getByLabelText(/^District/), { target: { value: '3' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save facility' }));

    expect(
      await within(form).findByText('WY has a single at-large district — use 00'),
    ).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('refuses a district with no state, which the server cannot cross-check', async () => {
    const form = await openAddForm();

    fireEvent.change(within(form).getByLabelText('Facility name'), {
      target: { value: 'Unknown site' },
    });
    fireEvent.change(within(form).getByLabelText(/^District/), { target: { value: '7' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save facility' }));

    expect(
      await within(form).findByText('Pick a state before setting a district'),
    ).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('requires a name', async () => {
    const form = await openAddForm();

    fireEvent.click(within(form).getByRole('button', { name: 'Save facility' }));

    expect(await within(form).findByText('Give the facility a name')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('edits an existing facility with PATCH, not POST', async () => {
    patchMock.mockResolvedValue({ data: FACILITY });
    renderModal();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = (await screen.findByLabelText('Facility name')).closest('form')!;
    // The form opens populated from the record, not blank.
    expect(within(form).getByLabelText('Facility name')).toHaveValue('Seattle HQ');

    fireEvent.change(within(form).getByLabelText('Employees'), { target: { value: '310' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save facility' }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock.mock.calls[0]![0]).toBe('/api/clients/client-1/facilities/fac-1');
    expect(patchMock.mock.calls[0]![1]).toMatchObject({ employeeCount: 310, name: 'Seattle HQ' });
    expect(postMock).not.toHaveBeenCalled();
  });

  it('confirms before removing a facility', async () => {
    deleteMock.mockResolvedValue({ data: { deleted: true } });
    renderModal();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    // Nothing deleted on the first click — a removal silently changes the
    // client's district footprint.
    expect(deleteMock).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('dialog', { name: 'Remove facility' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('/api/clients/client-1/facilities/fac-1'),
    );
  });
});
