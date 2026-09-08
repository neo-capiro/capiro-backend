import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientProfileShell } from './ClientProfileShell.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
const putMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../../components/feedback/toast.js', () => ({ useCapiroToast: () => toastMock }));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, put: putMock }),
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

const sarah = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'sarah@example.com',
  firstName: 'Sarah',
  lastName: 'Martinez',
};
const jordan = {
  id: '22222222-2222-2222-2222-222222222222',
  email: 'jordan@example.com',
  firstName: 'Jordan',
  lastName: 'Clayton',
};

function renderShell(canAssign = true, profile = client) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <ClientProfileShell
          client={profile}
          tab="overview"
          view={null}
          onNavigate={vi.fn()}
          onFillWithMeri={vi.fn()}
          onDataHealth={vi.fn()}
          canEditFocus={canAssign}
        >
          <div>body</div>
        </ClientProfileShell>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  putMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  getMock.mockImplementation((url: string) => {
    if (url.endsWith('/options')) return Promise.resolve({ data: [sarah, jordan] });
    if (url.endsWith('/client-1')) {
      return Promise.resolve({
        data: { accountOwnerUserId: sarah.id, accountOwner: sarah },
      });
    }
    return Promise.reject(new Error(`unexpected get ${url}`));
  });
  putMock.mockResolvedValue({
    data: { accountOwnerUserId: jordan.id, accountOwner: jordan },
  });
});

describe('ClientProfileShell account owner', () => {
  it('shows the persisted owner and lets a user_admin assign another active tenant member', async () => {
    renderShell(true);

    const select = await screen.findByRole('combobox', { name: 'Account owner' });
    await waitFor(() => expect(select).toHaveValue(sarah.id));

    fireEvent.change(select, { target: { value: jordan.id } });

    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/api/client-account-owners/client-1', {
        accountOwnerUserId: jordan.id,
      }),
    );
    await waitFor(() => expect(select).toHaveValue(jordan.id));
  });

  it('renders the persisted owner read-only when assignment is not allowed', async () => {
    renderShell(false);

    expect(await screen.findByText('Sarah Martinez')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Account owner' })).not.toBeInTheDocument();
  });

  it('shows saved funding priorities separately from the sector focus chips', () => {
    renderShell(false, {
      ...client,
      description: 'Reliable grid infrastructure.',
      intakeData: {
        sectors: ['ENERGY'],
        fundingPriorities: ['Grid storage pilot', 'Rural microgrid deployment'],
      },
    });

    const priorities = screen.getByRole('list', { name: 'Funding priorities' });
    expect(within(priorities).getAllByRole('listitem')).toHaveLength(2);
    expect(within(priorities).getByText('Grid storage pilot')).toBeInTheDocument();
    expect(within(priorities).getByText('Rural microgrid deployment')).toBeInTheDocument();
    expect(within(priorities).queryByText('Energy')).not.toBeInTheDocument();
    expect(screen.getByText('Energy')).toBeInTheDocument();
  });

  it('does not invent funding priorities when only sector tags are recorded', () => {
    renderShell(false, { ...client, intakeData: { sectors: ['ENERGY'] } });
    expect(screen.queryByRole('list', { name: 'Funding priorities' })).not.toBeInTheDocument();
  });

  it('keeps long priority lists compact while leaving every saved priority available', () => {
    renderShell(false, {
      ...client,
      intakeData: {
        fundingPriorities: [
          'Grid storage pilot',
          'Rural microgrid deployment',
          'Water treatment pilot',
          'Solar workforce training',
        ],
      },
    });
    expect(
      within(screen.getByRole('list', { name: 'Funding priorities' })).getAllByRole('listitem'),
    ).toHaveLength(3);
    expect(screen.getByText('Show 1 more priority')).toBeInTheDocument();
    expect(screen.getByText('Solar workforce training')).not.toBeVisible();
    fireEvent.click(screen.getByText('Show 1 more priority'));
    expect(screen.getByText('Solar workforce training')).toBeVisible();
  });
});

describe('ClientProfileShell JSON export', () => {
  it.each([false, true])('reports whether intelligence is omitted (unavailable: %s)', async (unavailable) => {
    const originalGet = getMock.getMockImplementation()!;
    getMock.mockImplementation((url: string) => {
      if (url === '/api/clients/client-1') return Promise.resolve({ data: client });
      if (url === '/api/intelligence/client-profile/client-1') {
        return unavailable
          ? Promise.reject({ response: { status: 503 } })
          : Promise.resolve({ data: { clientId: client.id } });
      }
      return originalGet(url);
    });
    let exported: Blob | undefined;
    let filename = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      filename = this.download;
    });
    const revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(blob: Blob) { exported = blob; return 'blob:test-export'; }
      static revokeObjectURL = revoke;
    });
    try {
      renderShell(false);
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Overland AI' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Export client profile (JSON)' }));
      await waitFor(() => expect(click).toHaveBeenCalledOnce());
      const json = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsText(exported!);
      });
      const payload = JSON.parse(json);
      expect(payload.complete).toBe(!unavailable);
      expect(payload.omittedSources).toEqual(unavailable ? ['intelligence'] : []);
      expect(payload.client.id).toBe(client.id);
      expect(filename).toBe(`Overland_AI-profile${unavailable ? '-partial' : ''}.json`);
      if (unavailable) {
        expect(payload.intelligence).toBeNull();
        expect(payload.sources.intelligence).toMatchObject({ status: 'unavailable', error: { code: 'source_unavailable', httpStatus: 503 } });
        expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('Partial JSON export'));
        expect(toastMock.success).not.toHaveBeenCalled();
      } else {
        expect(payload.intelligence.clientId).toBe(client.id);
        expect(payload.sources.intelligence.status).toBe('available');
        expect(toastMock.success).toHaveBeenCalledWith('Client profile JSON exported.');
      }
      expect(revoke).toHaveBeenCalledWith('blob:test-export');
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('does not download a profile when the required client source fails', async () => {
    const originalGet = getMock.getMockImplementation()!;
    getMock.mockImplementation((url: string) => url === '/api/clients/client-1'
      ? Promise.reject(new Error('unavailable'))
      : originalGet(url));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      renderShell(false);
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Overland AI' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Export client profile (JSON)' }));
      await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Client profile could not be exported. Please retry.'));
      expect(click).not.toHaveBeenCalled();
    } finally {
      click.mockRestore();
    }
  });
});
