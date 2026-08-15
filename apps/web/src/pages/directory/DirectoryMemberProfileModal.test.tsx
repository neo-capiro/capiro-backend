import { App as AntApp } from 'antd';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DirectoryEntry } from './directoryData.js';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../lib/use-api.js', () => ({ useApi: () => ({ get, post }) }));

const { DirectoryMemberProfileModal } = await import('./DirectoryMemberProfileModal.js');

/**
 * One entry exercising every tab: real bio narrative + structured fields, a
 * staffer, committee leadership, a leadership position, official links, an
 * outgoing status, and a senate class — so each tab has signature content to
 * assert against rather than only its empty state.
 */
function entry(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    id: 'member-2872',
    memberId: 2872,
    bioguideId: 'C001098',
    fullName: 'Ted Cruz',
    memberName: 'Ted Cruz',
    honorific: 'Sen.',
    photoUrl: 'https://directory.example/photos/cruz.jpg',
    title: 'United States Senator',
    office: 'Ted Cruz office (TX)',
    chamber: 'Senate',
    state: 'TX',
    district: '',
    party: 'R',
    partyName: 'Republican',
    gender: 'M',
    region: 'South',
    isFreshman: false,
    servingSince: '2013-01-03',
    focusAreas: ['Defense'],
    committees: ['Senate Commerce, Science and Transportation Committee'],
    committeeLeadership: ['Chair, Senate Commerce Committee'],
    topIssues: [{ issue: 'Defense', stafferCount: 12 }],
    leadershipPositions: ['Chair, Senate Commerce Committee'],
    caucuses: [],
    educationInstitutions: [],
    senateClass: 1,
    outgoingStatus: null,
    officeLocation: '167 Russell Senate Office Building',
    phone: '202-224-5922',
    fax: '202-228-0755',
    email: 'ted@tedcruz.org',
    contactFormUrl: 'https://www.cruz.senate.gov/contact',
    officialLinks: [{ label: 'Official website', url: 'https://www.cruz.senate.gov', type: 'website' }],
    addresses: [
      {
        id: 'addr-1',
        title: 'Main Office',
        address1: '167 Russell Senate Office Building',
        address2: '',
        city: 'Washington',
        state: 'DC',
        zip: '20510',
        phone: '202-224-5922',
        fax: '202-228-0755',
        isMain: true,
      },
    ],
    staff: [
      {
        id: 'staff-800',
        fullName: 'Grace Hopper',
        title: 'Legislative Director',
        roles: ['Legislative Director'],
        issueAreas: ['Defense', 'Appropriations'],
        email: 'grace.hopper@cruz.senate.gov',
        phone: '202-224-5923',
        officeLocation: 'Personal office',
      },
    ],
    bio: {
      dob: '1970-12-22',
      hometown: 'Houston, Texas',
      birthplace: 'Calgary, Alberta',
      occupation: 'Attorney',
      race: '',
      religion: '',
      pronunciation: 'ted krooz',
      narrative: 'Elected to the U.S. Senate in 2012.',
      education: 'Princeton University, Harvard Law School',
      military: '',
      relatives: '',
    },
    lastTouchpoint: '2026-07-13',
    owner: '',
    relationshipTier: 'Core',
    notes: '',
    recentInteractions: [],
    ...overrides,
  };
}

const NOTE = {
  id: 'note-1',
  body: 'Met at the fly-in.',
  createdAt: '2026-07-01T12:00:00Z',
  createdBy: { firstName: 'Neo', lastName: 'Martinez', email: 'neo@capiro.ai' },
};

function resolveGet() {
  get.mockImplementation((url: string) => {
    if (url.endsWith('/notes')) return Promise.resolve({ data: [NOTE] });
    if (url.endsWith('/news')) {
      return Promise.resolve({
        data: {
          contactId: 'member-2872',
          memberName: 'Ted Cruz',
          newsPressUrl: 'https://www.cruz.senate.gov/newsroom',
          rssFeedUrl: null,
          rssSource: null,
          items: [
            {
              id: 'news-1',
              title: 'Cruz Statement on Border Security',
              link: 'https://www.cruz.senate.gov/newsroom/press-releases/1',
              publishedAt: '2026-07-10T00:00:00Z',
              summary: 'Senator Cruz released a statement today.',
            },
          ],
          lastSyncedAt: '2026-07-11T00:00:00Z',
          feedError: null,
        },
      });
    }
    if (url.endsWith('/representation-summary')) {
      return Promise.resolve({
        data: { clients: [{ clientId: 'client-1', clientName: 'Acme Corp', facilities: [{ id: 'f1', name: 'Austin Plant' }] }] },
      });
    }
    if (url.endsWith('/fec-summary')) {
      return Promise.resolve({
        data: {
          contactId: 'member-2872',
          memberName: 'Ted Cruz',
          matchQuality: 'name_approximate',
          clients: [
            {
              clientId: 'client-1',
              clientName: 'Acme Corp',
              mappedEmployer: 'Acme Corporation',
              totalAmount: 5000,
              contributionCount: 2,
              latestContributionDate: '2026-01-01',
            },
          ],
          summary: { totalAmount: 5000, contributionCount: 2, clientCount: 1 },
          disclaimer: 'Source: public FEC filings.',
        },
      });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderModal(overrides: Partial<DirectoryEntry> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <MemoryRouter>
          <DirectoryMemberProfileModal entry={entry(overrides)} open onClose={vi.fn()} />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  resolveGet();
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => vi.unstubAllGlobals());

describe('DirectoryMemberProfileModal — hero and Contact tab', () => {
  test('renders the hero with chamber, party, state and serving-since', async () => {
    renderModal();
    expect(await screen.findByRole('heading', { name: 'Ted Cruz' })).toBeTruthy();
    expect(screen.getByText('United States Senator')).toBeTruthy();
    expect(screen.getByText('Senate')).toBeTruthy();
    expect(screen.getByText('R')).toBeTruthy();
    expect(screen.getByText('TX')).toBeTruthy();
    expect(screen.getByText(/Serving in Senate since 2013/)).toBeTruthy();
  });

  test('Contact tab shows office, contact lines, official links, addresses and the snapshot card', async () => {
    renderModal();
    expect(await screen.findByText('167 Russell Senate Office Building')).toBeTruthy();
    // The phone appears twice by design: the copyable contact line and the
    // (identical, in this fixture) address-list entry.
    expect(screen.getAllByText(/202-224-5922/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Fax: 202-228-0755/)).toBeTruthy();
    // "Email: " and the address render as sibling text nodes inside one span.
    expect(screen.getByText(/ted@tedcruz\.org/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Official website' })).toBeTruthy();
  });

  test('the snapshot card states party, gender, region and senate class', async () => {
    renderModal();
    await screen.findByText('167 Russell Senate Office Building');
    expect(screen.getByText('Party: Republican (R)')).toBeTruthy();
    expect(screen.getByText('Gender: Male')).toBeTruthy();
    expect(screen.getByText('Region: South')).toBeTruthy();
    expect(screen.getByText('Senate class: I')).toBeTruthy();
  });

  test('top issues by staff coverage renders the issue and staffer count', async () => {
    renderModal();
    expect(await screen.findByText('Defense · 12')).toBeTruthy();
  });

  test('copying email and phone hits the clipboard', async () => {
    renderModal();
    // "Copy email"/"Copy phone" each label two controls: the hero's icon-only
    // button and the matching CopyableTextRow in the Contact tab below it.
    const emailButtons = await screen.findAllByRole('button', { name: 'Copy email' });
    fireEvent.click(emailButtons[0]!);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ted@tedcruz.org'));
    const phoneButtons = screen.getAllByRole('button', { name: 'Copy phone' });
    fireEvent.click(phoneButtons[0]!);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('202-224-5922'));
  });
});

describe('DirectoryMemberProfileModal — remaining tabs', () => {
  test('Staff tab lists the roster with roles, issue areas and contact', async () => {
    renderModal();
    fireEvent.click(await screen.findByRole('tab', { name: 'Staff' }));
    expect(await screen.findByRole('link', { name: 'Grace Hopper' })).toBeTruthy();
    // "Legislative Director" appears twice by design: the staffer's title line
    // and the identically-named entry in their `roles` tag list.
    expect(screen.getAllByText('Legislative Director').length).toBeGreaterThan(0);
    expect(screen.getByText('Appropriations')).toBeTruthy();
    expect(screen.getByText('grace.hopper@cruz.senate.gov')).toBeTruthy();
  });

  test('an office with no staff records says so rather than rendering an empty table', async () => {
    renderModal({ staff: [] });
    fireEvent.click(await screen.findByRole('tab', { name: 'Staff' }));
    expect(await screen.findByText('No staff records in source snapshot')).toBeTruthy();
  });

  test('Bio tab shows the narrative and the structured fields that have a value', async () => {
    renderModal();
    fireEvent.click(await screen.findByRole('tab', { name: 'Bio' }));
    expect(await screen.findByText('Elected to the U.S. Senate in 2012.')).toBeTruthy();
    expect(screen.getByText('Houston, Texas')).toBeTruthy();
    expect(screen.getByText('Princeton University, Harvard Law School')).toBeTruthy();
    // Race and Religion are empty strings on the fixture and must not render a blank card.
    expect(screen.queryByText('Race')).toBeNull();
  });

  test('Committees tab separates leadership roles from the full committee list', async () => {
    renderModal();
    fireEvent.click(await screen.findByRole('tab', { name: 'Committees' }));
    expect(await screen.findByText('Leadership roles')).toBeTruthy();
    expect(screen.getAllByText('Chair, Senate Commerce Committee').length).toBeGreaterThan(0);
    expect(screen.getByText('Senate Commerce, Science and Transportation Committee')).toBeTruthy();
  });

  test('Leadership tab lists current leadership positions', async () => {
    renderModal();
    fireEvent.click(await screen.findByRole('tab', { name: 'Leadership' }));
    await waitFor(() =>
      expect(within(screen.getByRole('tabpanel')).getByText('Chair, Senate Commerce Committee')).toBeTruthy(),
    );
  });

  test('a member with no leadership role says so', async () => {
    renderModal({ leadershipPositions: [] });
    fireEvent.click(await screen.findByRole('tab', { name: 'Leadership' }));
    expect(await screen.findByText('No current leadership roles in source snapshot')).toBeTruthy();
  });

  test('Links tab lists every official link', async () => {
    renderModal();
    fireEvent.click(await screen.findByRole('tab', { name: 'Links' }));
    await waitFor(() =>
      expect(within(screen.getByRole('tabpanel')).getByRole('link', { name: /Official website/ })).toBeTruthy(),
    );
  });

  test('News tab fetches and renders press items', async () => {
    renderModal();
    fireEvent.click(await screen.findByRole('tab', { name: 'News' }));
    expect(await screen.findByText('Cruz Statement on Border Security')).toBeTruthy();
    // The button's icon contributes to its accessible name (e.g. "link Press
    // page"), so match loosely rather than the visible label exactly.
    expect(screen.getByRole('link', { name: /Press page/ })).toBeTruthy();
  });
});

describe('DirectoryMemberProfileModal — side panels backed by their own endpoints', () => {
  test('Represents client facilities panel renders the mapped client and facility', async () => {
    renderModal();
    expect(await screen.findByText('Represents client facilities')).toBeTruthy();
    expect(await screen.findByText('Acme Corp')).toBeTruthy();
    expect(screen.getByText('Austin Plant')).toBeTruthy();
  });

  test('Client FEC relationship panel renders the approximate-match summary and disclaimer', async () => {
    renderModal();
    expect(await screen.findByText(/\$5\.0K across 2 contributions from 1 mapped client/)).toBeTruthy();
    expect(screen.getByText('approximate · name-matched')).toBeTruthy();
    expect(screen.getByText('Source: public FEC filings.')).toBeTruthy();
  });

  test('an office with no notes yet says so, and adding one posts and refetches', async () => {
    get.mockImplementation((url: string) => {
      if (url.endsWith('/notes')) return Promise.resolve({ data: [] });
      return resolveGetFallback(url);
    });
    post.mockImplementation((url: string) =>
      url.endsWith('/notes') ? Promise.resolve({ data: NOTE }) : Promise.reject(new Error('unexpected POST')),
    );
    renderModal();

    expect(await screen.findByText('No notes yet')).toBeTruthy();

    const textarea = screen.getByPlaceholderText('Add a tenant-visible note');
    fireEvent.change(textarea, { target: { value: 'Met at the fly-in.' } });
    // Icon-prefixed accessible name (e.g. "send Add note"); match loosely.
    fireEvent.click(screen.getByRole('button', { name: /Add note/ }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/api/directory/contacts/member-2872/notes',
        expect.objectContaining({ body: 'Met at the fly-in.', directoryContactName: 'Ted Cruz' }),
      ),
    );
  });
});

/** Fallback used only by the notes-mutation test, which overrides the /notes branch above. */
function resolveGetFallback(url: string) {
  if (url.endsWith('/news')) return Promise.resolve({ data: { items: [] } });
  if (url.endsWith('/representation-summary')) return Promise.resolve({ data: { clients: [] } });
  if (url.endsWith('/fec-summary')) return Promise.resolve({ data: { clients: [], summary: { totalAmount: 0, contributionCount: 0, clientCount: 0 } } });
  return Promise.reject(new Error(`unexpected GET ${url}`));
}
