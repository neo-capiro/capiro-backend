import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManageAccountTeamModal } from './ManageAccountTeamModal.js';

/**
 * The account-team roster editor.
 *
 * Before `client_team_members` existed there was no per-client roster anywhere in
 * the product: the Overview Account card rendered "No roster" and linked to
 * FIRM-WIDE team settings, so there was genuinely no way to put someone on a
 * client's account team.
 *
 * The load-bearing details here are that the account owner cannot be removed
 * through this surface (they are a `clients` column, not a membership row), and
 * that the candidate picker never offers someone already on the roster.
 */

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock, delete: deleteMock }),
}));

const OWNER = {
  id: null,
  userId: 'u-owner',
  email: 'neo@capiro.ai',
  firstName: 'Neo',
  lastName: 'Martinez',
  role: null,
  isOwner: true,
  addedAt: null,
};

const MEMBER = {
  id: 'ctm-1',
  userId: 'u-lia',
  email: 'lia@capiro.ai',
  firstName: 'Lia',
  lastName: 'Martinez',
  role: 'Lead lobbyist',
  isOwner: false,
  addedAt: '2026-08-19T00:00:00.000Z',
};

const OPTIONS = [
  { id: 'u-owner', email: 'neo@capiro.ai', firstName: 'Neo', lastName: 'Martinez' },
  { id: 'u-lia', email: 'lia@capiro.ai', firstName: 'Lia', lastName: 'Martinez' },
  { id: 'u-nicole', email: 'nicole@capiro.ai', firstName: 'Nicole', lastName: 'Clayton' },
];

function mockEndpoints(team: unknown[] = [OWNER, MEMBER]) {
  getMock.mockImplementation((url: string) => {
    if (url === '/api/clients/client-1/team') return Promise.resolve({ data: team });
    if (url === '/api/client-account-owners/options') return Promise.resolve({ data: OPTIONS });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderModal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ManageAccountTeamModal open clientId="client-1" clientName="RTX Corporation" onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  deleteMock.mockReset();
});

/**
 * The picker renders immediately with only its placeholder while the
 * firm-members read is still in flight, so waiting on the SELECT is not enough —
 * wait until a real candidate option has actually been rendered.
 */
async function pickerWithCandidates(): Promise<HTMLSelectElement> {
  const picker = (await screen.findByLabelText('Add a teammate')) as HTMLSelectElement;
  await waitFor(() => expect(picker.options.length).toBeGreaterThan(1));
  return picker;
}

describe('ManageAccountTeamModal', () => {
  it('lists the owner and the team members with their roles', async () => {
    mockEndpoints();
    renderModal();

    const ownerRow = (await screen.findByText('Neo Martinez')).closest('li')!;
    expect(ownerRow).toHaveTextContent('Account owner');

    const memberRow = screen.getByText('Lia Martinez').closest('li')!;
    expect(memberRow).toHaveTextContent('Lead lobbyist');
    expect(memberRow).toHaveTextContent('lia@capiro.ai');
  });

  it('offers no Remove for the account owner — that is a separate reassignment', async () => {
    mockEndpoints();
    renderModal();

    const ownerRow = (await screen.findByText('Neo Martinez')).closest('li')!;
    expect(within(ownerRow).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(within(ownerRow).getByText('Owner')).toBeInTheDocument();

    const memberRow = screen.getByText('Lia Martinez').closest('li')!;
    expect(within(memberRow).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('does not offer people who are already on the roster', async () => {
    mockEndpoints();
    renderModal();

    const picker = await pickerWithCandidates();
    const values = Array.from(picker.options).map((option) => option.value);
    // Only the one firm member not yet on this account.
    expect(values).toEqual(['', 'u-nicole']);
  });

  it('adds a teammate with a role through the real endpoint', async () => {
    mockEndpoints();
    postMock.mockResolvedValue({ data: [OWNER, MEMBER] });
    renderModal();

    fireEvent.change(await pickerWithCandidates(), { target: { value: 'u-nicole' } });
    fireEvent.change(screen.getByLabelText('Role (optional)'), { target: { value: 'Research' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to team' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/team', {
      userId: 'u-nicole',
      role: 'Research',
    });
  });

  it('omits a blank role rather than sending an empty string the DTO rejects', async () => {
    mockEndpoints();
    postMock.mockResolvedValue({ data: [OWNER, MEMBER] });
    renderModal();

    fireEvent.change(await pickerWithCandidates(), { target: { value: 'u-nicole' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to team' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/team', { userId: 'u-nicole' });
  });

  it('cannot submit without picking someone', async () => {
    mockEndpoints();
    renderModal();

    await screen.findByLabelText('Add a teammate');
    expect(screen.getByRole('button', { name: 'Add to team' })).toBeDisabled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('removes a member by userId as a query parameter', async () => {
    mockEndpoints();
    deleteMock.mockResolvedValue({ data: [OWNER] });
    renderModal();

    const memberRow = (await screen.findByText('Lia Martinez')).closest('li')!;
    fireEvent.click(within(memberRow).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('/api/clients/client-1/team', {
        params: { userId: 'u-lia' },
      }),
    );
  });

  it('says the read failed rather than showing an empty team', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/api/clients/client-1/team') return Promise.reject(new Error('boom'));
      return Promise.resolve({ data: OPTIONS });
    });
    renderModal();

    expect(await screen.findByText('Could not read the account team.')).toBeInTheDocument();
    // An empty roster is a DIFFERENT claim from a failed read — never conflate.
    expect(screen.queryByText(/Nobody is on this account team yet/)).not.toBeInTheDocument();
  });
});
