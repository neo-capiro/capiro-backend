import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

const mock = vi.hoisted(() => ({
  post: vi.fn(), get: vi.fn(), patch: vi.fn(),
  auth: { isLoaded: true, userId: 'user-1', orgId: 'org-1' },
  impersonation: { actAsTenantSlug: null as string | null },
  me: { data: { tenant: { id: 'tenant-1' }, user: { id: 'user-1' }, features: {} }, isError: false, refetch: vi.fn() },
}));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ post: mock.post, get: mock.get, patch: mock.patch }) }));
vi.mock('../../../lib/me.js', () => ({ useMe: () => mock.me }));
vi.mock('@clerk/clerk-react', () => ({ useUser: () => ({ user: null }), useAuth: () => mock.auth }));
vi.mock('../../../state/impersonation.js', () => ({ useImpersonation: () => mock.impersonation }));
// Keep the route and real wizard state/persistence. Isolate the template and
// Directory data browsers so this regression doesn't depend on external lists.
vi.mock('./v2/StepTemplate.js', () => ({ StepTemplate: ({ onChange }: { onChange: (id: string) => void }) => <button onClick={() => onChange('template-1')}>Choose test template</button> }));
vi.mock('./v2/StepRecipientsSelect.js', () => ({ StepRecipientsSelect: ({ clientId, onChange }: any) => <div>
  <span>Campaign client: {clientId}</span>
  <button onClick={() => onChange({ targets: [{ key: 'target-1', type: 'individual', recipients: [{ id: 'recipient-1', email: 'test@example.test', name: 'Test recipient', clientId }], cc: [], bcc: [] }] })}>Choose test recipient</button>
</div> }));

import { VNextOutreachClassic } from '../../../vnext/pages/engagement/VNextOutreachClassic.js';
import { LW_OUTREACH_CONTEXT_KEY } from './legiwatch-prefill.js';
const pref = {
  clientId: 'client-1', clientName: 'Anduril', status: 'staged', autoSend: false,
  context: { hearing: { id: 'hearing-1', title: 'Shipbuilding readiness', calendarDate: '2026-09-01' }, finding: { id: 'finding-1', title: 'Procurement gap', summary: 'Fresh verified evidence.' } },
};
const entry = '/engagement/outreach?source=legiwatch&hearingId=hearing-1&client=client-1&contextId=handoff-1';
function stage(value = pref) { sessionStorage.setItem(LW_OUTREACH_CONTEXT_KEY, JSON.stringify({ id: 'handoff-1', prefill: value, createdAt: Date.now() })); }
function Location() { const loc = useLocation(); const nav = useNavigate(); return <><output data-testid="location">{loc.pathname + loc.search}</output><button onClick={() => nav(entry.replace('hearing-1', 'hearing-2'))}>Other hearing</button></>; }
function Host() {
  const [, refresh] = useState(0);
  return <><button onClick={() => refresh((x) => x + 1)}>Refresh auth state</button><VNextOutreachClassic clients={[{ id: 'client-1', name: 'Anduril', status: 'active' } as any]} selectedClientId="other-global-client" /></>;
}
function mount(route = entry) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><App><MemoryRouter initialEntries={[route]}><Location /><Routes>
    <Route path="/engagement/outreach" element={<Host />} />
    <Route path="/engagement/outreach/draft/:id" element={<div>Saved campaign destination</div>} />
  </Routes></MemoryRouter></App></QueryClientProvider>);
}
beforeEach(() => {
  cleanup(); sessionStorage.clear(); vi.clearAllMocks();
  mock.me.data.tenant.id = 'tenant-1';
  mock.auth.orgId = 'org-1'; mock.auth.userId = 'user-1'; mock.impersonation.actAsTenantSlug = null;
  mock.get.mockImplementation(async (url: string) => ({ data: url.endsWith('/capabilities') ? { ai: { activeProvider: 'openai' } } : url.endsWith('/templates') ? [] : url.endsWith('/context-library') ? { documents: [], debriefs: [], preps: [] } : [] }));
  mock.post.mockImplementation(async (url: string) => ({ data: url.endsWith('/actions/outreach-prefill') ? pref : { id: 'saved-1' } }));
  stage({ ...pref, context: { ...pref.context, finding: { ...pref.context.finding, summary: 'Untrusted cached words.' } } });
});
describe('LegiWatch handoff through the mounted canonical outreach wizard', () => {
  it('requires review, revalidates identities, hydrates real wizard state, and creates nothing until user saves', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Review hearing outreach' })).toBeInTheDocument();
    expect(screen.getByText(/Fresh verified evidence/)).toBeInTheDocument();
    expect(screen.queryByText(/Untrusted cached words/)).not.toBeInTheDocument();
    expect(mock.post).toHaveBeenCalledWith(expect.stringContaining('/hearing-1/actions/outreach-prefill'), { clientId: 'client-1', insightId: 'finding-1' }, expect.any(Object));
    expect(mock.post.mock.calls.every(([url]) => url.endsWith('/actions/outreach-prefill'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to campaign' }));
    expect(await screen.findByLabelText('Campaign name')).toHaveValue('Procurement gap');
    fireEvent.click(screen.getByRole('button', { name: 'Choose test template' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Campaign client: client-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose test recipient' }));
    expect(mock.post.mock.calls.every(([url]) => url.endsWith('/actions/outreach-prefill'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    expect(await screen.findByText('Saved campaign destination')).toBeInTheDocument();
    const save = mock.post.mock.calls.find(([url]) => url === '/api/engagement/outreach');
    expect(save?.[1]).toMatchObject({ clientId: 'client-1', title: 'Procurement gap', metadata: { mainIdea: expect.stringContaining('Procurement gap'), contextItems: [expect.objectContaining({ kind: 'note', note: expect.stringContaining('Fresh verified evidence.') })] } });
    expect(sessionStorage.getItem(LW_OUTREACH_CONTEXT_KEY)).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent('/engagement/outreach/draft/saved-1');
    expect(mock.post.mock.calls.some(([url]) => /send|generate|sessions/.test(url))).toBe(false);
  });
  it('revalidates retained staged context after a remount instead of opening blank', async () => {
    const first = mount();
    await screen.findByRole('heading', { name: 'Review hearing outreach' });
    first.unmount();
    mount();
    expect(await screen.findByRole('heading', { name: 'Review hearing outreach' })).toBeInTheDocument();
    expect(mock.post.mock.calls.filter(([url]) => url.endsWith('/actions/outreach-prefill'))).toHaveLength(2);
  });
  it('rejects a different hearing navigation on an already mounted host', async () => {
    mount(); await screen.findByRole('heading', { name: 'Review hearing outreach' });
    fireEvent.click(screen.getByRole('button', { name: 'Other hearing' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('different hearing');
    expect(screen.queryByRole('button', { name: 'Continue to campaign' })).not.toBeInTheDocument();
  });
  it('fails closed when current-tenant authorization rejects the client', async () => {
    mock.post.mockRejectedValue({ response: { status: 403 } });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
    expect(screen.queryByLabelText('Campaign name')).not.toBeInTheDocument();
  });
  it.each(['organization', 'user', 'impersonation'])('immediately hides the old wizard on %s change even while /me remains cached', async (scope) => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to campaign' }));
    expect(await screen.findByLabelText('Campaign name')).toHaveValue('Procurement gap');
    let reject!: (error: unknown) => void;
    mock.post.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    if (scope === 'organization') mock.auth.orgId = 'org-2';
    if (scope === 'user') mock.auth.userId = 'user-2';
    if (scope === 'impersonation') mock.impersonation.actAsTenantSlug = 'tenant-2';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh auth state' }));
    expect(screen.queryByLabelText('Campaign name')).not.toBeInTheDocument();
    expect(screen.queryByText(/Fresh verified evidence/)).not.toBeInTheDocument();
    expect(screen.getByText('Checking the hearing and selected client…')).toBeInTheDocument();
    await waitFor(() => expect(reject).toBeTypeOf('function'));
    reject({ response: { status: 403 } });
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
  });
  it('rejects a mismatched response even if the HTTP request succeeded', async () => {
    mock.post.mockResolvedValue({ data: { ...pref, clientId: 'client-2' } });
    mount(); expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
  });
});
