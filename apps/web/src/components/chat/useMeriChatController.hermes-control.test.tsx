import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const auth = { getToken: async () => 'token', orgId: 'org-1', userId: 'user-1' };
const api = { get: async () => ({ data: [] }), post: async () => ({ data: {} }) };
const impersonation = { actAsTenantSlug: null };
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => auth }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../state/impersonation.js', () => ({ useImpersonation: () => impersonation }));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));
import { useMeriChatController } from './useMeriChatController.js';
import { resetChatStoreForTests, setChatSession } from './chat-store.js';
import type { MeriHermesApprovalCard, MeriHermesClarifyCard } from './meri-hermes-interactions.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const stream = (events: unknown[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          ),
        );
        controller.close();
      },
    }),
  );

/** A stream the test drives frame by frame — used to assert what the UI shows
 * WHILE a recovered run is still generating, not only after it finished. */
function controlledStream() {
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        sink = controller;
      },
    }),
  );
  return {
    response,
    push: (event: unknown) => sink?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    close: () => sink?.close(),
  };
}

/** An event stream that stays open and silent — i.e. a run still in flight. */
const openStream = () => controlledStream().response;

/** Approvals expire (300s by default), and an expired one is refused rather
 * than sent — so a fixture that is still LIVE has to be relative to now. */
const notYetExpired = () => new Date(Date.now() + 5 * 60_000).toISOString();

const hermesApprovalFrame = (over: Record<string, unknown> = {}) => ({
  type: 'pending_approval',
  runtime: 'hermes',
  tool: 'terminal',
  label: 'Run: rm -rf build/',
  proposalId: 'hermes:run-1:req-1',
  status: 'proposed',
  reason: 'Run: rm -rf build/',
  expiresAt: notYetExpired(),
  riskTier: 'native_hermes_approval',
  policyCode: 'HERMES_NATIVE_APPROVAL',
  ruleId: null,
  policy: {
    source: 'hermes',
    mode: 'native',
    packKey: 'hermes-native',
    packVersion: 'v2026.9.14',
    binding: 'run',
    decisionHash: '',
    contextHash: '',
    decision: 'WARN',
    jurisdiction: 'worker',
    channel: 'terminal',
    recipientType: null,
  },
  preview: {
    label: 'Run: rm -rf build/',
    riskTier: 'native_hermes_approval',
    leavesFirm: false,
    reversible: false,
    fields: { command: 'rm -rf build/' },
    counts: {},
    reason: 'Run: rm -rf build/',
  },
  interaction: { requestId: 'req-1', choices: ['once', 'deny'], continuation: 'live_process' },
  ...over,
});

const hermesClarifyFrame = (over: Record<string, unknown> = {}) => ({
  type: 'clarify',
  runtime: 'hermes',
  requestId: 'clar-1',
  questions: [{ id: 'clar-1', question: 'Which client?', choices: [], multiSelect: false }],
  continuation: 'durable_continuation',
  ...over,
});

const runProjection = (over: Record<string, unknown> = {}) => ({
  runId: 'run-9',
  status: 'waiting_for_approval',
  finishReason: null,
  partial: false,
  error: null,
  lastSeq: 3,
  outputSnapshot: '',
  outputSeq: 0,
  pendingInteractions: [
    {
      requestId: 'req-9',
      kind: 'approval',
      prompt: 'Run: rm -rf /',
      choices: ['once', 'deny'],
      multiSelect: false,
      continuation: 'live_process',
      createdAt: '2026-09-19T00:00:00.000Z',
      expiresAt: notYetExpired(),
      resolved: false,
      decision: null,
    },
  ],
  ...over,
});

const ACTIVE_URL = 'https://api.test/api/clio/hermes/conversations/conversation-1/active';

/** The discovery payload (GET …/conversations/:id/active). */
const activeConversation = (over: Record<string, unknown> = {}) => ({
  run: {
    runId: 'run-9',
    status: 'waiting_for_approval',
    finishReason: null,
    partial: false,
    detached: false,
    outputSnapshot: '',
    outputSeq: 0,
    lastSeq: 3,
    hermesRunId: 'hermes-run-9',
    hermesSessionId: 'hermes-session-9',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:10.000Z',
    finishedAt: null,
  },
  pendingInteractions: [
    {
      runId: 'run-9',
      requestId: 'req-9',
      kind: 'approval',
      continuation: 'live_process',
      prompt: 'Run: rm -rf /',
      choices: ['once', 'deny'],
      multiSelect: false,
      createdAt: '2026-09-19T00:00:00.000Z',
      expiresAt: notYetExpired(),
    },
  ],
  ...over,
});

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

beforeEach(() => {
  resetChatStoreForTests();
  window.sessionStorage.clear();
  setChatSession('conversation-1');
  auth.orgId = 'org-1';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Hermes stop/detach', () => {
  test('Stop calls the explicit cancel route for an active Hermes run — not only the fetch abort', async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push(url);
        if (url.endsWith('/stream')) {
          // Never sends `done` — the turn is still running server-side when
          // Stop is pressed (the scenario ticket 4 exists for).
          return stream([
            { type: 'start', intent: 'general_question', tier: 'deep', runtime: 'hermes', runId: 'run-1' },
          ]);
        }
        if (url.endsWith('/api/clio/hermes/runs/run-1/stop')) return json({ ok: true });
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await act(async () => {
      await result.current.sendMessage('Do the thing');
    });
    await act(async () => {
      result.current.handleStop();
    });
    await waitFor(() =>
      expect(posts).toContain('https://api.test/api/clio/hermes/runs/run-1/stop'),
    );
  });

  test('leaving the page (invalidateRouteStream) detaches only — it never calls the stop route', async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push(url);
        if (url.endsWith('/stream')) {
          return stream([
            { type: 'start', intent: 'general_question', tier: 'deep', runtime: 'hermes', runId: 'run-1' },
          ]);
        }
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await act(async () => {
      await result.current.sendMessage('Do the thing');
    });
    act(() => {
      result.current.invalidateRouteStream();
    });
    // Give any stray microtask a chance to fire, then assert no stop call was made.
    await act(async () => {
      await Promise.resolve();
    });
    expect(posts.some((url) => url.endsWith('/stop'))).toBe(false);
  });
});

describe('Hermes native approval card', () => {
  test('a pending_approval{runtime:"hermes"} frame renders a card, and approve_once POSTs the decision', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith('/stream')) {
          return stream([
            { type: 'start', intent: 'general_question', tier: 'deep', runtime: 'hermes', runId: 'run-1' },
            hermesApprovalFrame(),
          ]);
        }
        if (url.endsWith('/api/clio/hermes/runs/run-1/approval')) return json({ ok: true });
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await act(async () => {
      await result.current.sendMessage('Run the cleanup script');
    });
    expect(result.current.hermesInteractions).toHaveLength(1);
    const card = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    expect(card.kind).toBe('approval');
    expect(card.runId).toBe('run-1');
    expect(card.requestId).toBe('req-1');
    expect(card.command).toBe('rm -rf build/');
    expect(card.resolution).toBeNull();

    await act(async () => {
      await result.current.resolveHermesApproval(card, 'approve_once');
    });
    expect(posts).toContainEqual({
      url: 'https://api.test/api/clio/hermes/runs/run-1/approval',
      body: { requestId: 'req-1', decision: 'approve_once' },
    });
    const resolved = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    expect(resolved.resolution).toMatchObject({ decision: 'approve_once' });
  });

  test('deny POSTs deny — never a broader "always"/"session" decision', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith('/stream')) {
          return stream([
            { type: 'start', intent: 'general_question', tier: 'deep', runtime: 'hermes', runId: 'run-1' },
            hermesApprovalFrame(),
          ]);
        }
        return json({ ok: true });
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await act(async () => {
      await result.current.sendMessage('Run the cleanup script');
    });
    const card = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    await act(async () => {
      await result.current.resolveHermesApproval(card, 'deny');
    });
    expect(posts).toContainEqual({
      url: 'https://api.test/api/clio/hermes/runs/run-1/approval',
      body: { requestId: 'req-1', decision: 'deny' },
    });
  });
});

describe('Hermes durable clarification card', () => {
  test('a clarify frame renders a card, and answering it records the receipt AND sends the answer as the next message', async () => {
    const posts: string[] = [];
    let streamCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push(url);
        if (url.endsWith('/stream')) {
          streamCalls += 1;
          if (streamCalls === 1) {
            return stream([
              { type: 'start', intent: 'general_question', tier: 'deep', runtime: 'hermes', runId: 'run-1' },
              hermesClarifyFrame(),
            ]);
          }
          // The durable continuation: answering resends as an ordinary message.
          return stream([{ type: 'done', runtime: 'hermes', runId: 'run-1', finishReason: 'stop' }]);
        }
        if (url.endsWith('/api/clio/hermes/runs/run-1/clarification')) return json({ ok: true });
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await act(async () => {
      await result.current.sendMessage('Set up a new client record');
    });
    expect(result.current.hermesInteractions).toHaveLength(1);
    const card = result.current.hermesInteractions[0] as MeriHermesClarifyCard;
    expect(card.kind).toBe('clarification');
    expect(card.question).toBe('Which client?');

    await act(async () => {
      await result.current.answerHermesClarification(card, 'Acme Corp');
    });
    expect(posts).toContain('https://api.test/api/clio/hermes/runs/run-1/clarification');
    expect(streamCalls).toBe(2);
    const resolved = result.current.hermesInteractions[0] as MeriHermesClarifyCard;
    expect(resolved.resolution).toMatchObject({ answer: 'Acme Corp' });
    expect(result.current.messages.some((m) => m.role === 'user' && m.content === 'Acme Corp')).toBe(true);
  });
});

describe('Hermes discovery on mount (fresh tab / other device)', () => {
  test('recovers an in-flight run and its pending approval with sessionStorage entirely empty', async () => {
    // This is the whole point of server-side discovery: nothing in this
    // browser knows the run exists. A per-tab pointer could not represent it,
    // so a fresh tab, a second browser or another device used to see nothing.
    window.sessionStorage.clear();
    window.localStorage.clear();
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        if (url === ACTIVE_URL) return json(activeConversation());
        if (url.includes('/api/clio/hermes/runs/run-9/events')) return openStream();
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(result.current.hermesInteractions).toHaveLength(1));
    const card = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    expect(card.runId).toBe('run-9');
    expect(card.requestId).toBe('req-9');
    expect(card.resolution).toBeNull();
    expect(urls).toContain(ACTIVE_URL);
    // Nothing was written to, or read from, per-tab storage to make this work.
    expect(window.sessionStorage.length).toBe(0);
  });

  test('approving a card recovered by discovery routes to the run that asked', async () => {
    window.sessionStorage.clear();
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url === ACTIVE_URL) return json(activeConversation());
        if (url.includes('/api/clio/hermes/runs/run-9/events')) return openStream();
        if (url.endsWith('/api/clio/hermes/runs/run-9/approval')) return json({ ok: true });
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(result.current.hermesInteractions).toHaveLength(1));
    const card = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    await act(async () => {
      await result.current.resolveHermesApproval(card, 'approve_once');
    });
    expect(posts).toContainEqual({
      url: 'https://api.test/api/clio/hermes/runs/run-9/approval',
      body: { requestId: 'req-9', decision: 'approve_once' },
    });
  });

  test('no active run and nothing outstanding leaves the conversation untouched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === ACTIVE_URL) return json({ run: null, pendingInteractions: [] });
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(result.current.hermesRunStatus).toBeNull());
    expect(result.current.hermesInteractions).toHaveLength(0);
    expect(result.current.messages).toHaveLength(0);
  });

  test('a 404 from discovery (not the owner / pilot closed) is silent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === ACTIVE_URL) return new Response('not found', { status: 404 });
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(result.current.hermesInteractions).toHaveLength(0));
    expect(result.current.messages).toHaveLength(0);
  });
});

describe('Hermes snapshot-based recovery', () => {
  test('seeds from outputSnapshot, subscribes at after=outputSeq, and appends only later deltas', async () => {
    // Replaying from after=0 would be wrong AND lossy: the run's event log is
    // capped at 5 000 events and prunes the oldest (contracts.md §4.2), so a
    // long run's beginning is simply gone. The snapshot is the authority up to
    // outputSeq; the stream is the authority after it.
    window.sessionStorage.clear();
    const eventUrls: string[] = [];
    const live = controlledStream();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === ACTIVE_URL) {
          return json(
            activeConversation({
              run: {
                ...activeConversation().run,
                status: 'running',
                outputSnapshot: 'The first half of a long answer. ',
                outputSeq: 1234,
                lastSeq: 1234,
              },
              pendingInteractions: [],
            }),
          );
        }
        if (url.includes('/api/clio/hermes/runs/run-9/events')) {
          eventUrls.push(url);
          return live.response;
        }
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });

    // The recovered text is on screen before a single new byte arrives.
    await waitFor(() =>
      expect(result.current.messages.at(-1)?.content).toBe('The first half of a long answer. '),
    );
    expect(eventUrls).toEqual([
      'https://api.test/api/clio/hermes/runs/run-9/events?after=1234',
    ]);
    expect(eventUrls[0]).not.toContain('after=0');

    // …and the run is still generating: later deltas append, never duplicate.
    await act(async () => {
      live.push({ type: 'text', text: 'And the rest' });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(result.current.messages.at(-1)?.content).toBe('The first half of a long answer. And the rest'),
    );
    await act(async () => {
      live.push({ type: 'text', text: ' of it.' });
      live.push({ type: 'done', runtime: 'hermes', runId: 'run-9' });
      live.close();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(result.current.messages.at(-1)?.content).toBe(
        'The first half of a long answer. And the rest of it.',
      ),
    );
    // Exactly one assistant message — the recovery never forks a second one.
    expect(result.current.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  test('an error frame after recovery is appended, never overwriting the recovered text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === ACTIVE_URL) {
          return json(
            activeConversation({
              run: {
                ...activeConversation().run,
                status: 'running',
                outputSnapshot: 'Work already done.',
                outputSeq: 7,
              },
              pendingInteractions: [],
            }),
          );
        }
        if (url.includes('/api/clio/hermes/runs/run-9/events')) {
          return stream([
            { type: 'error', message: 'worker vanished' },
            { type: 'done', runtime: 'hermes', runId: 'run-9' },
          ]);
        }
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toContain('worker vanished'));
    expect(result.current.messages.at(-1)?.content).toContain('Work already done.');
  });
});

describe('Hermes interactions that outlive their run', () => {
  const clarificationOnFinishedRun = () =>
    activeConversation({
      run: null,
      pendingInteractions: [
        {
          runId: 'run-finished',
          requestId: 'clar_7',
          kind: 'clarification',
          continuation: 'durable_continuation',
          prompt: 'Which client should I file this under?',
          choices: [],
          multiSelect: false,
          createdAt: '2026-09-19T00:00:00.000Z',
          expiresAt: null,
        },
      ],
    });

  test('an unresolved clarification whose run is terminal is still discovered and still answerable', async () => {
    window.sessionStorage.clear();
    const posts: Array<{ url: string; body: unknown }> = [];
    let streamCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url === ACTIVE_URL) return json(clarificationOnFinishedRun());
        if (url.endsWith('/stream')) {
          streamCalls += 1;
          return stream([{ type: 'done', runtime: 'hermes', runId: 'run-next', finishReason: 'stop' }]);
        }
        return json({ ok: true });
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(result.current.hermesInteractions).toHaveLength(1));
    const card = result.current.hermesInteractions[0] as MeriHermesClarifyCard;
    expect(card.kind).toBe('clarification');
    expect(card.runTerminal).toBe(true);
    expect(card.resolution).toBeNull();
    // Nothing is streaming, so the composer stays usable for the answer.
    expect(result.current.isStreaming).toBe(false);

    await act(async () => {
      await result.current.answerHermesClarification(card, 'Acme Corp');
    });
    // The durable receipt carries the ORIGINAL request id back to the run that
    // asked, and the answer itself goes out as the next chat message.
    expect(posts).toContainEqual({
      url: 'https://api.test/api/clio/hermes/runs/run-finished/clarification',
      body: { requestId: 'clar_7', answer: 'Acme Corp' },
    });
    expect(streamCalls).toBe(1);
    expect(result.current.messages.some((m) => m.role === 'user' && m.content === 'Acme Corp')).toBe(true);
    expect((result.current.hermesInteractions[0] as MeriHermesClarifyCard).resolution).toMatchObject({
      answer: 'Acme Corp',
    });
  });

  test('a native approval whose run is terminal is surfaced as refused instead of silently failing', async () => {
    window.sessionStorage.clear();
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push(url);
        if (url === ACTIVE_URL) {
          return json(
            activeConversation({
              run: null,
              pendingInteractions: [
                {
                  runId: 'run-finished',
                  requestId: 'req_9',
                  kind: 'approval',
                  continuation: 'live_process',
                  prompt: 'Run: rm -rf build/',
                  choices: ['once', 'deny'],
                  multiSelect: false,
                  createdAt: '2026-09-19T00:00:00.000Z',
                  expiresAt: null,
                },
              ],
            }),
          );
        }
        return json({ ok: true });
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(result.current.hermesInteractions).toHaveLength(1));
    const card = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    expect(card.runTerminal).toBe(true);

    // The worker that was blocked on this is gone; the backend refuses the
    // decision. Say so rather than POSTing something that cannot succeed.
    await expect(result.current.resolveHermesApproval(card, 'approve_once')).rejects.toThrow(/no longer act/i);
    expect(posts.some((url) => url.endsWith('/approval'))).toBe(false);
    expect((result.current.hermesInteractions[0] as MeriHermesApprovalCard).resolution).toBeNull();
  });

  test('a live approval left unresolved when its run finishes becomes non-actionable rather than disappearing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/stream')) {
          return stream([
            { type: 'start', intent: 'general_question', tier: 'deep', runtime: 'hermes', runId: 'run-1' },
            hermesApprovalFrame(),
            { type: 'done', runtime: 'hermes', runId: 'run-1', finishReason: 'stop' },
          ]);
        }
        if (url === ACTIVE_URL) return json({ run: null, pendingInteractions: [] });
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await act(async () => {
      await result.current.sendMessage('Run the cleanup script');
    });
    await waitFor(() =>
      expect((result.current.hermesInteractions[0] as MeriHermesApprovalCard)?.runTerminal).toBe(true),
    );
    // The card is still there — the user gets to see what was asked and that
    // it never ran — but it is no longer offering a decision.
    expect(result.current.hermesInteractions).toHaveLength(1);
  });

  test('a server refusal (409) on an approval marks the card non-actionable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/stream')) {
          return stream([
            { type: 'start', intent: 'general_question', tier: 'deep', runtime: 'hermes', runId: 'run-1' },
            hermesApprovalFrame(),
          ]);
        }
        if (url.endsWith('/api/clio/hermes/runs/run-1/approval')) {
          return new Response('run is no longer accepting approvals', { status: 409 });
        }
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await act(async () => {
      await result.current.sendMessage('Run the cleanup script');
    });
    const card = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    await expect(result.current.resolveHermesApproval(card, 'approve_once')).rejects.toThrow();
    await waitFor(() =>
      expect((result.current.hermesInteractions[0] as MeriHermesApprovalCard).runTerminal).toBe(true),
    );
  });
});

describe('Hermes approval invariants', () => {
  async function cardUnderTest() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/stream')) {
          return stream([
            { type: 'start', intent: 'general_question', tier: 'deep', runtime: 'hermes', runId: 'run-1' },
            hermesApprovalFrame(),
          ]);
        }
        return json({ ok: true });
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await act(async () => {
      await result.current.sendMessage('Run the cleanup script');
    });
    return result;
  }

  test('a duplicate decision on an already-answered request is rejected, not double-applied', async () => {
    const result = await cardUnderTest();
    const card = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    await act(async () => {
      await result.current.resolveHermesApproval(card, 'approve_once');
    });
    const resolved = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    expect(resolved.resolution).toMatchObject({ decision: 'approve_once' });
    // Re-submitting the SAME (now stale) card must not overwrite the recorded
    // decision with a second one.
    await expect(result.current.resolveHermesApproval(resolved, 'deny')).rejects.toThrow(/already answered/i);
    expect((result.current.hermesInteractions[0] as MeriHermesApprovalCard).resolution).toMatchObject({
      decision: 'approve_once',
    });
  });

  test('an expired approval is rejected client-side rather than sent for the server to 403', async () => {
    const result = await cardUnderTest();
    const card = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    const stale: MeriHermesApprovalCard = { ...card, expiresAt: '2000-01-01T00:00:00.000Z' };
    await expect(result.current.resolveHermesApproval(stale, 'approve_once')).rejects.toThrow(/expired/i);
  });

  test('the card never carries a decision beyond run-once/deny', async () => {
    const result = await cardUnderTest();
    const card = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    // `choices` is informational (what Hermes reported); the control surface
    // this controller exposes is only ever approve_once | deny.
    await act(async () => {
      await result.current.resolveHermesApproval(card, 'deny');
    });
    const resolved = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    expect(['approve_once', 'deny']).toContain(resolved.resolution?.decision);
  });
});
