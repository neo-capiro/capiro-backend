import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmOrganizationProto } from './RelationshipsOrgTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

/** Items 15-17 (wire-audit "2 Wire existing APIs"). */

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock, patch: vi.fn(), delete: vi.fn() }),
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

function person(overrides: Record<string, unknown>) {
  return {
    id: 'p1',
    clientId: 'client-1',
    name: 'Alex Rivera',
    title: 'Chief Executive Officer',
    email: null,
    phone: null,
    role: null,
    lastContact: null,
    notes: null,
    hierarchyLevel: 'executive',
    reportsToPersonId: null,
    placementSource: 'auto_title',
    placementConfidence: 0.9,
    reviewRequired: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockPeople(people: unknown[]) {
  getMock.mockImplementation((url: string) => {
    if (url === '/api/clients/client-1/people') return Promise.resolve({ data: people });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderOrg() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientCrmOrganizationProto client={client} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

describe('ClientCrmOrganizationProto — real hierarchy (item 17)', () => {
  it('renders the real reporting tree instead of the ORG fixture', async () => {
    mockPeople([
      person({ id: 'p1', name: 'Alex Rivera', title: 'Chief Executive Officer' }),
      person({
        id: 'p2',
        name: 'Priya Raman',
        title: 'VP Engineering',
        hierarchyLevel: 'leadership',
        reportsToPersonId: 'p1',
      }),
    ]);
    renderOrg();

    await waitFor(() => expect(screen.getByText('Alex Rivera')).toBeInTheDocument());
    expect(screen.getByText('Priya Raman')).toBeInTheDocument();
    // The design fixture's invented people must not leak through as if real.
    expect(screen.queryByText('James Smith')).not.toBeInTheDocument();
  });

  it('renders unplaced people rather than hiding them', async () => {
    mockPeople([
      person({ id: 'p1', name: 'Alex Rivera' }),
      person({
        id: 'p3',
        name: 'Sam Unplaced',
        title: null,
        hierarchyLevel: null,
        reportsToPersonId: null,
      }),
    ]);
    renderOrg();

    await waitFor(() => expect(screen.getByText('Sam Unplaced')).toBeInTheDocument());
    expect(screen.getByText(/Not placed/)).toBeInTheDocument();
  });

  it('shows a real empty state, not the fixture chart, when the roster is genuinely empty', async () => {
    mockPeople([]);
    renderOrg();

    await waitFor(() => expect(screen.getByText('No contacts yet')).toBeInTheDocument());
    expect(screen.queryByText('James Smith')).not.toBeInTheDocument();
  });

  it('shows a loading state without invented contacts', () => {
    getMock.mockImplementation(() => new Promise(() => {}));
    renderOrg();

    expect(screen.getByRole('status', { name: 'Loading client organization' })).toBeInTheDocument();
    expect(screen.queryByText('James Smith')).not.toBeInTheDocument();
  });
});

describe('ClientCrmOrganizationProto — real strip counters (polish items 9/11)', () => {
  it('computes placed / review / mapped / override counts from the model, never the fixture numbers', async () => {
    mockPeople([
      person({ id: 'p1', name: 'Alex Rivera' }),
      person({
        id: 'p2',
        name: 'Priya Raman',
        title: 'VP Engineering',
        hierarchyLevel: 'leadership',
        reportsToPersonId: 'p1',
        placementSource: 'manual',
      }),
      person({
        id: 'p3',
        name: 'Sam Unplaced',
        title: null,
        hierarchyLevel: null,
        reportsToPersonId: null,
        reviewRequired: true,
      }),
    ]);
    renderOrg();

    await waitFor(() => expect(screen.getByText('Alex Rivera')).toBeInTheDocument());
    // 2 of 3 placed, 1 flagged for review, 1 manual placement.
    expect(screen.getByText('2 contacts placed · 1 title needs review')).toBeInTheDocument();
    expect(screen.getByText('67% mapped')).toBeInTheDocument();
    expect(screen.getByText('1 manual override')).toBeInTheDocument();
    expect(screen.getByText('1 title to review')).toBeInTheDocument();
    // The fixture's hardcoded strip numbers must never render for a real client.
    expect(screen.queryByText('92% mapped')).not.toBeInTheDocument();
    expect(screen.queryByText('7 contacts placed · 1 title needs review')).not.toBeInTheDocument();
    expect(screen.queryByText('2 manual overrides')).not.toBeInTheDocument();
  });

  it('shows the unplaced group header with its hint and no per-card Unplaced eyebrow (polish item 8)', async () => {
    mockPeople([
      person({ id: 'p1', name: 'Alex Rivera' }),
      person({
        id: 'p3',
        name: 'Sam Unplaced',
        title: 'Freelance Wizard',
        hierarchyLevel: null,
        reportsToPersonId: null,
        reviewRequired: true,
      }),
    ]);
    renderOrg();

    await waitFor(() => expect(screen.getByText('Sam Unplaced')).toBeInTheDocument());
    expect(screen.getByText('Not placed · 1')).toBeInTheDocument();
    expect(screen.getByText('Open a contact to place it, or fix its title.')).toBeInTheDocument();
    // The group header carries "Not placed"; the card repeats neither an
    // "Unplaced" eyebrow nor the "Unplaced · No title match" footer.
    expect(screen.queryByText('Unplaced')).not.toBeInTheDocument();
    expect(screen.queryByText('Unplaced · No title match')).not.toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
  });
});

describe('ClientCrmOrganizationProto — Add contact (item 15)', () => {
  it('opens the real person drawer in create mode', async () => {
    mockPeople([person({})]);
    renderOrg();

    await waitFor(() => expect(screen.getByText('Alex Rivera')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));

    // The real ClientPersonDrawer renders a name field for a new contact.
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toBeInTheDocument());
  });
});

describe('ClientCrmOrganizationProto — hierarchy settings (item 16)', () => {
  it('lists the real level metadata and names the rule set as built-in/not editable', async () => {
    mockPeople([person({})]);
    renderOrg();

    await waitFor(() => expect(screen.getByText('Alex Rivera')).toBeInTheDocument());
    // Real LEVEL_META, not the byte-identical LEVELS fixture copy it replaced.
    expect(screen.getByText('Senior leadership')).toBeInTheDocument();
    expect(screen.getByText('EVP · SVP')).toBeInTheDocument();
    // Rules are a hardcoded const in the API with no write path — say so.
    expect(screen.getByText('Built-in title rules (not editable)')).toBeInTheDocument();
  });
});


describe('Leadership role review', () => {
  it('flags overlapping leadership titles without choosing who is current or removing either contact', async () => {
    mockPeople([
      person({ id: 'p1', name: 'Christopher Aebli', title: 'President of Communications & Spectrum Dominance', placementSource: 'manual' }),
      person({ id: 'p2', name: 'Jon Rambeau', title: 'President, Communications & Spectrum Dominance', placementSource: 'manual' }),
    ]);
    renderOrg();
    expect(await screen.findByText(/2 contacts share a leadership title/)).toBeInTheDocument();
    expect(screen.getByText('Christopher Aebli')).toBeInTheDocument();
    expect(screen.getByText('Jon Rambeau')).toBeInTheDocument();
    expect(screen.getAllByText('Role overlap · Review current title')).toHaveLength(2);
    expect(screen.getAllByText('Executive · Manually placed')).toHaveLength(2);
    expect(screen.queryByText(/Confirmed/)).not.toBeInTheDocument();
    expect(screen.getByText(/Contact dates show when records were added, not when roles began/)).toBeInTheDocument();
  });

  it('does not conflate different divisions or explicitly historical roles', async () => {
    mockPeople([
      person({ id: 'p1', title: 'President, Communications' }),
      person({ id: 'p2', name: 'Other Leader', title: 'President, Space' }),
      person({ id: 'p3', name: 'Former Leader', title: 'Former President, Communications' }),
    ]);
    renderOrg();
    await screen.findByText('Other Leader');
    expect(screen.queryByText(/contacts share a leadership title/)).not.toBeInTheDocument();
  });
});
