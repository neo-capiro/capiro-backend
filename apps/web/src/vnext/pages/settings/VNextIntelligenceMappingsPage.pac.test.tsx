import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VNextIntelligenceMappingsPage } from './VNextIntelligenceMappingsPage.js';
import { CapiroToastProvider } from '../../components/feedback/toast.js';

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get, post }) }));

function renderMappings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const awardKey = ['client-district-nexus', 'client-1'];
  const pacKey = ['client-fec-money-flow', 'client-1'];
  const marketKey = ['federal-market', 'contracts', '', '', '', '', undefined, undefined, 'client-1', 1];
  for (const key of [awardKey, pacKey, marketKey]) qc.setQueryData(key, { old: true });
  render(
    <QueryClientProvider client={qc}>
      <CapiroToastProvider>
        <MemoryRouter initialEntries={['/settings/intelligence-mappings?source=fec_committee']}>
          <VNextIntelligenceMappingsPage />
        </MemoryRouter>
      </CapiroToastProvider>
    </QueryClientProvider>,
  );
  return { qc, keys: [awardKey, pacKey, marketKey] };
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url: string) => {
    if (url === '/api/clients') return Promise.resolve({ data: [{ id: 'client-1', name: 'Anduril' }] });
    if (url.startsWith('/api/intelligence/fec-committees/search')) return Promise.resolve({ data: [{
      id: 'C00763623', name: 'ANDURIL INDUSTRIES PAC', committeeType: 'Q', active: null, cycle: 2026, sourceSyncedAt: null,
    }] });
    return Promise.resolve({ data: [] });
  });
  post.mockResolvedValue({ data: {} });
});

describe('manual PAC mapping', () => {
  it('uses the catalog committee ID, shows unknown status honestly, and invalidates current cards', async () => {
    const { qc, keys } = renderMappings();
    fireEvent.click(screen.getByRole('button', { name: 'Add mapping manually' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Anduril' });
    fireEvent.change(within(dialog).getByLabelText('1 · Select the client to attach to'), { target: { value: 'client-1' } });
    fireEvent.change(within(dialog).getByLabelText('2 · Search'), { target: { value: 'C00763623' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search' }));

    const link = await within(dialog).findByRole('link', { name: 'C00763623' });
    expect(link).toHaveAttribute('href', 'https://www.fec.gov/data/committee/C00763623/');
    expect(within(dialog).getByText('Status unavailable')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Attach' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/intelligence/mappings/client-1/manual', {
      source: 'fec_committee', externalId: 'C00763623', externalName: 'ANDURIL INDUSTRIES PAC',
    }));
    await waitFor(() => {
      for (const key of keys) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    });
    expect(get).toHaveBeenCalledWith('/api/intelligence/fec-committees/search?q=C00763623');
  });

  it('reports a failed catalog request instead of claiming there are no matching committees', async () => {
    get.mockImplementation((url: string) => url.includes('fec-committees/search')
      ? Promise.reject(new Error('catalog unavailable'))
      : Promise.resolve({ data: [] }));
    renderMappings();
    fireEvent.click(screen.getByRole('button', { name: 'Add mapping manually' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('2 · Search'), { target: { value: 'Anduril' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search' }));
    await within(dialog).findByText(/Committee search failed — catalog unavailable/);
    expect(within(dialog).queryByText(/No PAC committee matched/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Attach' })).not.toBeInTheDocument();
  });
});
