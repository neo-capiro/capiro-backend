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

describe('LW-04 LegiWatch → Meri real route and send', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    sessionStorage.clear();
    setGlobalClientFilter(null);
    mocks.orgId = 'org-a';
    mocks.userId = 'user-a';
    mocks.impersonatedTenantSlug = null;
    mocks.api.get.mockResolvedValue({
      data: { tenant: { name: 'Tenant under test' }, features: { meriv3Chat: true } },
    });
    claimMeriIdentity('org-a:user-a');
  });
  afterEach(() => vi.unstubAllGlobals());
  test('prepares actual evidence without opening history or sending, then sends it once under the selected client', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    writeMeriHandoffPacket(envelope());
    renderRoute();
    await waitFor(() =>
      expect(message().value).toContain('A distinct selected transcript excerpt'),
    );
    expect(screen.getByLabelText('Client scope').textContent).toBe('client-anduril');
    await waitFor(() => expect(screen.getByLabelText('Route').textContent).toBe('/meri/new'));
    for (const text of [
      'Quoted supporting evidence',
      'Relevant to the selected client',
      'https://senate.gov/hearing-123',
    ])
      expect(message().value).toContain(text);
    expect(sessionStorage.getItem(LW_MERI_CONTEXT_KEY)).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url.includes('/messages') || init?.method === 'POST',
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(1),
    );
    const create = fetchMock.mock.calls.find(
      ([url, init]) => url.endsWith('/conversations') && init?.method === 'POST',
    );
    expect(JSON.parse(String(create?.[1]?.body)).clientId).toBe('client-anduril');
    const stream = fetchMock.mock.calls.find(([url]) => url.endsWith('/stream'));
    expect(JSON.parse(String(stream?.[1]?.body)).body).toContain(
      'A distinct selected transcript excerpt',
    );
    expect(JSON.parse(String(stream?.[1]?.body)).body).toContain('Hearing ID: hearing-123');
    await waitFor(() =>
      expect(screen.getByLabelText('Route').textContent).toBe('/meri/t/created-thread'),
    );
    expect(document.querySelector('.vnext-meri__handoff-chip')).toBeNull();
  });
  test('a history outage does not discard the verified roster or block a record-free hearing draft', async () => {
    const fetchMock = stubFetch(true);
    vi.stubGlobal('fetch', fetchMock);
    writeMeriHandoffPacket(envelope());
    renderRoute();
    await waitFor(() => expect(message().value).toContain('Hearing ID: hearing-123'));
    expect(screen.getByLabelText('Client scope').textContent).toBe('client-anduril');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    await waitFor(() => expect(screen.getByLabelText('Route').textContent).toBe('/meri/new'));
  });
  test('All clients resets an unrelated inherited client selection', async () => {
    setGlobalClientFilter('client-anduril');
    const entry = envelope();
    entry.packet.client = null;
    entry.packet.clientRelevance = [];
    writeMeriHandoffPacket(entry);
    vi.stubGlobal('fetch', stubFetch());
    renderRoute(`/meri/new${HANDOFF_QS.replace('&client=client-anduril', '')}`);
    await waitFor(() => expect(message().value).toContain('Client scope: All clients'));
    expect(screen.getByLabelText('Client scope').textContent).toBe('all');
  });
  test.each(['missing', 'wrong-account', 'wrong-client', 'expired'] as const)(
    'rejects %s context without preparing or sending content',
    async (scenario) => {
      const entry = envelope();
      if (scenario === 'wrong-account') entry.identityKey = 'org-other:user-a';
      if (scenario === 'wrong-client') entry.packet.client = { id: 'client-other', name: 'Other' };
      if (scenario === 'expired') entry.createdAt -= LW_MERI_CONTEXT_MAX_AGE_MS + 1;
      if (scenario !== 'missing') writeMeriHandoffPacket(entry);
      const fetchMock = stubFetch();
      vi.stubGlobal('fetch', fetchMock);
      renderRoute();
      await waitFor(() =>
        expect(document.querySelector('.vnext-meri__route-error')?.textContent).toContain(
          'missing, expired, or does not match',
        ),
      );
      expect(message().value).toBe('');
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    },
  );
  test('preserves an existing unsent draft and clearly refuses to replace it', async () => {
    restoreMeriComposerDraft('org-a:user-a', null, 'My unfinished question');
    writeMeriHandoffPacket(envelope());
    vi.stubGlobal('fetch', stubFetch());
    renderRoute();
    await waitFor(() =>
      expect(document.querySelector('.vnext-meri__route-error')?.textContent).toContain(
        'Your draft was preserved',
      ),
    );
    expect(message().value).toBe('My unfinished question');
  });
  test('malformed LegiWatch links never fall through to the newest thread', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderRoute('/meri?source=legiwatch');
    await waitFor(() => expect(document.querySelector('.vnext-meri__route-error')).not.toBeNull());
    expect(screen.getByLabelText('Route').textContent).toBe('/meri/new');
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/messages'))).toBe(false);
  });
  test('a recovered client hearing draft blocks Send under All clients until scope is corrected', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    writeMeriHandoffPacket(envelope());
    const first = renderRoute();
    await waitFor(() => expect(message().value).toContain('Hearing ID: hearing-123'));
    first.unmount();
    setGlobalClientFilter(null);
    renderRoute('/meri/new');
    await waitFor(() => expect(message().value).toContain('Hearing ID: hearing-123'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(document.querySelector('.vnext-meri__route-error')?.textContent).toContain(
        'Select Anduril before sending',
      ),
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(message().value).toContain('Hearing ID: hearing-123');
    act(() => setGlobalClientFilter('client-anduril'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(1),
    );
  });
  test('ordinary root navigation still opens the newest thread', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderRoute('/meri');
    await waitFor(() =>
      expect(screen.getByLabelText('Route').textContent).toBe('/meri/t/newest-thread'),
    );
    expect(fetchMock.mock.calls.some(([url]) => url.includes('newest-thread/messages'))).toBe(true);
  });
  test('a simultaneous generic launch cannot automatically send a different prompt', async () => {
    writeMeriHandoffPacket(envelope());
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderRoute(`/meri/new${HANDOFF_QS}&meriPrompt=Unrelated+request&meriClient=client-anduril`);
    await waitFor(() => expect(message().value).toContain('Hearing ID: hearing-123'));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    await waitFor(() => expect(screen.getByLabelText('Route').textContent).toBe('/meri/new'));
  });
  test('prepared draft survives an integrations detour without leaking to another identity', async () => {
    writeMeriHandoffPacket(envelope());
    vi.stubGlobal('fetch', stubFetch());
    const view = renderRoute();
    await waitFor(() => expect(message().value).toContain('Hearing ID: hearing-123'));
    await act(async () => mocks.navigate?.('/meri/integrations'));
    await act(async () => mocks.navigate?.('/meri/new'));
    await waitFor(() => expect(message().value).toContain('Hearing ID: hearing-123'));
    view.unmount();
    mocks.orgId = 'org-other';
    renderRoute('/meri/new');
    await waitFor(() => expect(message().value).toBe(''));
    expect(document.querySelector('.vnext-meri__handoff-chip')).toBeNull();
  });
});
describe('one-time handoff validation', () => {
  beforeEach(() => sessionStorage.clear());
  test('ordinary prompts do not require session storage', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('disabled');
    });
    expect(hearingDraftScopeError('org-a:user-a', 'My ordinary question', null)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  test.each(['hearing', 'nonce', 'segment', 'insight', 'future', 'malformed'] as const)(
    'rejects %s mismatch',
    (scenario) => {
      const entry = envelope();
      if (scenario === 'hearing') entry.packet.hearing.id = 'other';
      if (scenario === 'nonce') entry.handoffId = 'previous-launch';
      if (scenario === 'segment') entry.packet.evidenceReferences.segmentIds = ['other'];
      if (scenario === 'insight') entry.packet.intelligenceFinding = { id: 'other' };
      if (scenario === 'future') entry.createdAt = Date.now() + 60_000;
      writeMeriHandoffPacket(entry);
      if (scenario === 'malformed') sessionStorage.setItem(LW_MERI_CONTEXT_KEY, '{broken');
      expect(
        consumeMeriHandoffPacket(legiwatchHandoffRequest(HANDOFF_QS)!, 'org-a:user-a'),
      ).toBeNull();
      expect(sessionStorage.getItem(LW_MERI_CONTEXT_KEY)).toBeNull();
    },
  );
});
