import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  auth: { orgId: 'org-1', userId: 'user-1', isLoaded: true },
  impersonation: { actAsTenantSlug: null as string | null },
  post: vi.fn(),
}));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => mock.auth }));
vi.mock('../../../../state/impersonation.js', () => ({ useImpersonation: () => mock.impersonation }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({
  post: async (url: string, body: unknown) => ({ data: await mock.post(url, body) }),
  get: async () => ({ data: {} }),
}) }));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ data: undefined }) }));
import { HearingActions } from './HearingActions.js';
const defaults = { hearingId: 'hearing-1', hearingTitle: 'Hearing one', clientId: 'client-1', canCreateBrief: true, canSaveMoment: true, pendingAction: null, onPendingHandled: vi.fn() };
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname + location.search}</output>; }
function mount(initial: Partial<Parameters<typeof HearingActions>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = (props: Partial<Parameters<typeof HearingActions>[0]> = {}) => <StrictMode><QueryClientProvider client={qc}><MemoryRouter><Location /><HearingActions {...defaults} {...props} /></MemoryRouter></QueryClientProvider></StrictMode>;
  const rendered = render(view(initial));
  return { ...rendered, update: (props: Partial<Parameters<typeof HearingActions>[0]> = {}) => rendered.rerender(view(props)) };
}
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  mock.auth.orgId = 'org-1'; mock.auth.userId = 'user-1'; mock.impersonation.actAsTenantSlug = null;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('Stage outreach producer completion guards', () => {
  it.each(['hearing', 'client', 'organization', 'user', 'impersonation'])('ignores a late result after %s changes', async (scope) => {
    let resolve!: (data: unknown) => void;
    mock.post.mockImplementation(() => new Promise((finish) => { resolve = finish; }));
    const ui = mount(); fireEvent.click(screen.getByRole('button', { name: 'Stage outreach' }));
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    if (scope === 'organization') mock.auth.orgId = 'org-2';
    if (scope === 'user') mock.auth.userId = 'user-2';
    if (scope === 'impersonation') mock.impersonation.actAsTenantSlug = 'tenant-2';
    ui.update(scope === 'hearing' ? { hearingId: 'hearing-2' } : scope === 'client' ? { clientId: 'client-2' } : {});
    await act(async () => { resolve({ clientId: 'client-1', privateText: 'old client details' }); });
    expect(sessionStorage.getItem('lw:outreach-context')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open →' })).not.toBeInTheDocument();
  });
  it('does not revive a result after the selection changes away and back', async () => {
    let resolve!: (data: unknown) => void;
    mock.post.mockImplementation(() => new Promise((finish) => { resolve = finish; }));
    const ui = mount(); fireEvent.click(screen.getByRole('button', { name: 'Stage outreach' }));
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    ui.update({ clientId: 'client-2' }); ui.update({ clientId: 'client-1' });
    await act(async () => { resolve({ clientId: 'client-1' }); });
    expect(sessionStorage.getItem('lw:outreach-context')).toBeNull();
  });
  it('retains only the latest selected moment and binds its Open link to that launch', async () => {
    const pending: Array<(data: unknown) => void> = [];
    mock.post.mockImplementation(() => new Promise((finish) => { pending.push(finish); }));
    const ui = mount();
    ui.update({ pendingAction: { action: 'stage_outreach', refs: { segmentId: 'moment-1' } } });
    await waitFor(() => expect(pending).toHaveLength(1));
    ui.update({ pendingAction: { action: 'stage_outreach', refs: { segmentId: 'moment-2' } } });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => { pending[1]({ clientId: 'client-1', moment: 'moment-2' }); });
    expect(await screen.findByRole('button', { name: 'Open →' })).toBeInTheDocument();
    const stored = JSON.parse(sessionStorage.getItem('lw:outreach-context')!);
    expect(stored.prefill.moment).toBe('moment-2');
    await act(async () => { pending[0]({ clientId: 'client-1', moment: 'moment-1' }); });
    expect(JSON.parse(sessionStorage.getItem('lw:outreach-context')!).prefill.moment).toBe('moment-2');
    fireEvent.click(screen.getByRole('button', { name: 'Open →' }));
    expect(screen.getByTestId('location')).toHaveTextContent(`contextId=${stored.id}`);
  });
  it('completes a recommended moment action on its initial StrictMode mount', async () => {
    mock.post.mockResolvedValue({ clientId: 'client-1', moment: 'moment-1' });
    mount({ pendingAction: { action: 'stage_outreach', refs: { segmentId: 'moment-1' } } });
    expect(await screen.findByRole('button', { name: 'Open →' })).toBeInTheDocument();
    expect(mock.post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem('lw:outreach-context')!).prefill.moment).toBe('moment-1');
  });
  it('reports storage failure without publishing a false ready link', async () => {
    mock.post.mockResolvedValue({ clientId: 'client-1' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Stage outreach' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved');
    expect(screen.queryByRole('button', { name: 'Open →' })).not.toBeInTheDocument();
  });
});
