import { useLayoutEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { claimMeriIdentity, resetChatStoreForTests } from '../../components/chat/chat-store.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { setGlobalClientFilter } from '../../state/client-filter.js';
import { VNextMeriWorkspace } from './VNextMeriWorkspace.js';
import { restoreMeriComposerDraft, useMeriComposerDraft } from './meri-composer-drafts.js';
import {
  consumeMeriHandoffPacket,
  hearingDraftScopeError,
  legiwatchHandoffRequest,
  LW_MERI_CONTEXT_KEY,
  LW_MERI_CONTEXT_MAX_AGE_MS,
  writeMeriHandoffPacket,
  type LegiwatchHandoffPacket,
} from './meri-legiwatch-handoff.js';

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => 'token'),
  orgId: 'org-a',
  userId: 'user-a',
  impersonatedTenantSlug: null as string | null,
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
  navigate: null as ReturnType<typeof useNavigate> | null,
}));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: mocks.getToken, orgId: mocks.orgId, userId: mocks.userId }),
}));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: mocks.impersonatedTenantSlug }),
}));
vi.mock('./VNextMeriIntegrations.js', () => ({ VNextMeriIntegrations: () => null }));
vi.mock('./VNextMeriShell.js', () => ({ VNextMeriShell: ComposerProbe }));

function ComposerProbe({ controller }: { controller: MeriChatController }) {
  const identity = `${mocks.impersonatedTenantSlug ?? mocks.orgId}:${mocks.userId}`;
  const { draft, setDraft, clearForSubmission } = useMeriComposerDraft(
    identity,
    controller.sessionId,
  );
  return (
    <div>
      <output aria-label="Client scope">{controller.selectedClientValue || 'all'}</output>
      <textarea aria-label="Message" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button
        onClick={async () => {
          const restore = clearForSubmission();
          try {
            if ((await controller.sendMessage(draft)) === false) restore();
          } catch {
            restore();
          }
        }}
      >
        Send
      </button>
    </div>
  );
}
function LocationProbe() {
  const location = useLocation();
  mocks.navigate = useNavigate();
  useLayoutEffect(() => {
    window.history.replaceState({}, '', `${location.pathname}${location.search}`);
  }, [location.pathname, location.search]);
  return (
    <output aria-label="Route">
      {location.pathname}
      {location.search}
    </output>
  );
}
const HANDOFF_QS =
  '?source=legiwatch&hearingId=hearing-123&client=client-anduril&segmentId=segment-1&insightId=insight-1&handoffId=launch-1';
function envelope(): LegiwatchHandoffPacket {
  return {
    hearingId: 'hearing-123',
    identityKey: 'org-a:user-a',
    handoffId: 'launch-1',
    createdAt: Date.now(),
    packet: {
      source: 'legiwatch-hearing',
      hearing: {
        id: 'hearing-123',
        title: 'Fauci Hearing',
        calendarDate: '2026-07-29',
        officialPageUrl: 'https://senate.gov/hearing-123',
      },
      client: { id: 'client-anduril', name: 'Anduril' },
      transcriptSegment: {
        id: 'segment-1',
        text: 'A distinct selected transcript excerpt',
        speakerLabel: 'Witness',
        startMs: 1200,
        endMs: 5000,
      },
      intelligenceFinding: {
        id: 'insight-1',
        title: 'A selected finding',
        summary: 'The selected summary',
        evidenceText: 'Quoted supporting evidence',
        segmentId: 'segment-1',
      },
      clientRelevance: [
        {
          insightId: 'insight-1',
          rationale: 'Relevant to the selected client',
          band: 'high',
          score: 90,
        },
      ],
      question: null,
      evidenceReferences: {
        hearingId: 'hearing-123',
        segmentIds: ['segment-1'],
        insightIds: ['insight-1'],
      },
    },
  };
}
function stubFetch(historyUnavailable = false) {
  const history = [
    {
      id: 'newest-thread',
      title: 'Unrelated newest thread',
      clientId: null as string | null,
      client: null,
      latestMessage: null,
      updatedAt: '2026-09-09T00:00:00.000Z',
    },
  ];
  return vi.fn(async (url: string, init?: RequestInit) => {
    const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.endsWith('/api/clients')) return ok([{ id: 'client-anduril', name: 'Anduril' }]);
    if (url.endsWith('/api/clio/conversations')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const thread = { ...history[0]!, id: 'created-thread', clientId: body.clientId ?? null };
        history.push(thread);
        return ok(thread);
      }
      if (historyUnavailable) return new Response('History unavailable', { status: 503 });
      return ok(history);
    }
    if (url.includes('/messages')) return ok([]);
    if (url.endsWith('/stream'))
      return new Response('data: {"type":"done","messageId":"answer-1"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    return ok({});
  });
}
function renderRoute(initial = `/meri${HANDOFF_QS}`) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <VNextMeriWorkspace />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
function message() {
  return screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
}

describe('RP editable scoped starters', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    sessionStorage.clear();
    setGlobalClientFilter(null);
    mocks.orgId = 'org-a';
    mocks.userId = 'user-a';
    mocks.impersonatedTenantSlug = null;
    mocks.api.get.mockResolvedValue({
      data: { tenant: { name: 'Owned mock' }, features: { meriv3Chat: true } },
    });
    claimMeriIdentity('org-a:user-a');
  });
  afterEach(() => vi.unstubAllGlobals());
  const initial =
    '/meri/new?meriResearchPortfolio=33333333-3333-4333-8333-333333333333&meriPrompt=Explain%20this%20portfolio';
  test('fills editable intent, consumes query, waits for explicit Send and preserves server-scoped creation', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderRoute(initial);
    await waitFor(() => expect(message().value).toBe('Explain this portfolio'));
    expect(screen.getByLabelText('Route').textContent).toBe('/meri/new');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fireEvent.change(message(), { target: { value: 'Edited RP intent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(1),
    );
    const create = fetchMock.mock.calls.find(
      ([url, init]) => url.endsWith('/conversations') && init?.method === 'POST',
    );
    expect(JSON.parse(String(create?.[1]?.body)).researchPortfolioId).toBe(
      '33333333-3333-4333-8333-333333333333',
    );
    const stream = fetchMock.mock.calls.find(([url]) => url.endsWith('/stream'));
    expect(JSON.parse(String(stream?.[1]?.body)).body).toBe('Edited RP intent');
  });
  test('remount preserves edited draft and its RP scope without sending', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    const first = renderRoute(initial);
    await waitFor(() => expect(message().value).toBe('Explain this portfolio'));
    fireEvent.change(message(), { target: { value: 'Retained edited intent' } });
    first.unmount();
    renderRoute('/meri/new');
    await waitFor(() => expect(message().value).toBe('Retained edited intent'));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(1),
    );
    const create = fetchMock.mock.calls.find(
      ([url, init]) => url.endsWith('/conversations') && init?.method === 'POST',
    );
    expect(JSON.parse(String(create?.[1]?.body)).researchPortfolioId).toBe(
      '33333333-3333-4333-8333-333333333333',
    );
  });
  test('preserves an existing unsent draft and does not retarget it', async () => {
    restoreMeriComposerDraft('org-a:user-a', null, 'Existing separate intent');
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderRoute(initial);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Your draft was preserved'),
    );
    expect(message().value).toBe('Existing separate intent');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(
      sessionStorage.getItem('capiro:meri:research-portfolio-draft-scope:v1:org-a:user-a'),
    ).toBeNull();
  });
  test('manual Clear then fresh text creates an unscoped conversation', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderRoute(initial);
    await waitFor(() => expect(message().value).toBe('Explain this portfolio'));
    fireEvent.change(message(), { target: { value: '' } });
    await waitFor(() =>
      expect(
        sessionStorage.getItem('capiro:meri:research-portfolio-draft-scope:v1:org-a:user-a'),
      ).toBeNull(),
    );
    fireEvent.change(message(), { target: { value: 'Fresh general intent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(1),
    );
    const create = fetchMock.mock.calls.find(
      ([url, init]) => url.endsWith('/conversations') && init?.method === 'POST',
    );
    expect(JSON.parse(String(create?.[1]?.body)).researchPortfolioId).toBeUndefined();
  });
  test('blocks a corrupt retained RP scope until the draft is cleared', async () => {
    restoreMeriComposerDraft('org-a:user-a', null, 'Retained RP intent');
    sessionStorage.setItem('capiro:meri:research-portfolio-draft-scope:v1:org-a:user-a', 'corrupt');
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderRoute('/meri/new');
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('scope is invalid'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(message().value).toBe('Retained RP intent'));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  test('server denial on explicit Send retains draft for a scoped retry and never streams', async () => {
    const ordinary = stubFetch();
    let deny = true;
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      url.endsWith('/conversations') && init?.method === 'POST' && deny
        ? Promise.resolve(new Response('RP access denied', { status: 403 }))
        : ordinary(url, init),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderRoute(initial);
    await waitFor(() => expect(message().value).toBe('Explain this portfolio'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('RP access denied'),
    );
    await waitFor(() => expect(message().value).toBe('Explain this portfolio'));
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/stream'))).toBe(false);
    deny = false;
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(1),
    );
    const creations = fetchMock.mock.calls.filter(
      ([url, init]) => url.endsWith('/conversations') && init?.method === 'POST',
    );
    expect(creations).toHaveLength(2);
    for (const row of creations)
      expect(JSON.parse(String(row[1]?.body)).researchPortfolioId).toBe(
        '33333333-3333-4333-8333-333333333333',
      );
  });
});
