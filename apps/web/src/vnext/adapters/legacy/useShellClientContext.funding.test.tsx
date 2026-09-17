import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import { useShellClientContext } from './useShellClientContext.js';

const globalState = vi.hoisted(() => ({ selectedClientId: 'stale-global', setSelectedClientId: vi.fn() }));
const api = vi.hoisted(() => ({ get: vi.fn(async () => ({ data: [{ id: 'overland', name: 'Overland AI', status: 'active' }, { id: 'halcyon', name: 'Halcyon Grid', status: 'active' }] })) }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../../state/client-filter.js', () => ({ useClientFilter: () => globalState }));

function Harness() {
  const model = useShellClientContext();
  const location = useLocation();
  return <><output data-testid="scope">{model.selectedClientId ?? 'none'}:{model.scopeLabel}</output><button onClick={() => model.setSelectedClientId('halcyon')}>Select Halcyon</button><button onClick={() => model.setSelectedClientId(null)}>Clear client</button><output data-testid="url">{location.pathname}{location.search}</output></>;
}
function mount(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}><Routes><Route path="*" element={<Harness />} /></Routes></MemoryRouter></QueryClientProvider>);
}

describe('Funding shell client scope contract', () => {
  test('canonical Funding client wins stale global scope; missing Funding client is all-client', async () => {
    const first = mount('/intelligence/opportunities?client=overland&mode=matched');
    await waitFor(() => expect(screen.getByTestId('scope')).toHaveTextContent('overland:Overland AI'));
    first.unmount();
    mount('/intelligence/opportunities?mode=all');
    await waitFor(() => expect(screen.getByTestId('scope')).toHaveTextContent('none:All clients'));
  });
  test('Funding setter writes client, preserves criteria, clears page and forces all mode when cleared', async () => {
    mount('/intelligence/opportunities?mode=matched&client=overland&query=typed&page=4');
    await waitFor(() => screen.getByTestId('scope'));
    fireEvent.click(screen.getByRole('button', { name: 'Select Halcyon' }));
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('client=halcyon'));
    expect(screen.getByTestId('url')).not.toHaveTextContent('page=4');
    fireEvent.click(screen.getByRole('button', { name: 'Clear client' }));
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('mode=all'));
    expect(screen.getByTestId('url')).not.toHaveTextContent('client=');
  });
  test('non-Funding route preserves clientId semantics', async () => {
    mount('/clients?clientId=overland');
    await waitFor(() => expect(screen.getByTestId('scope')).toHaveTextContent('overland'));
    fireEvent.click(screen.getByRole('button', { name: 'Select Halcyon' }));
    expect(screen.getByTestId('url')).toHaveTextContent('clientId=halcyon');
  });
});
