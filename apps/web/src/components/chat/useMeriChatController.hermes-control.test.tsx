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
import { readHermesRunPointer, writeHermesRunPointer } from './meri-hermes-interactions.js';
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

const hermesApprovalFrame = (over: Record<string, unknown> = {}) => ({
  type: 'pending_approval',
  runtime: 'hermes',
  tool: 'terminal',
  label: 'Run: rm -rf build/',
  proposalId: 'hermes:run-1:req-1',
  status: 'proposed',
  reason: 'Run: rm -rf build/',
  expiresAt: '2026-09-19T00:05:00.000Z',
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
  pendingInteractions: [
    {
      requestId: 'req-9',
      kind: 'approval',
      prompt: 'Run: rm -rf /',
      choices: ['once', 'deny'],
      multiSelect: false,
      continuation: 'live_process',
      createdAt: '2026-09-19T00:00:00.000Z',
      expiresAt: '2026-09-19T00:05:00.000Z',
      resolved: false,
      decision: null,
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

describe('Hermes reconnect on mount', () => {
  test('a non-terminal run pointed to by sessionStorage reappears its pending approval card', async () => {
    writeHermesRunPointer(window.sessionStorage, 'conversation-1', { runId: 'run-9' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/api/clio/hermes/runs/run-9')) return json(runProjection());
        if (url.includes('/api/clio/hermes/runs/run-9/events')) {
          return stream([{ type: 'done', runtime: 'hermes', runId: 'run-9' }]);
        }
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(result.current.hermesInteractions).toHaveLength(1));
    const card = result.current.hermesInteractions[0] as MeriHermesApprovalCard;
    expect(card.runId).toBe('run-9');
    expect(card.requestId).toBe('req-9');
    expect(card.resolution).toBeNull();
  });

  test('approving a card that reappeared after reconnect routes to the correct run id', async () => {
    writeHermesRunPointer(window.sessionStorage, 'conversation-1', { runId: 'run-9' });
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith('/api/clio/hermes/runs/run-9')) return json(runProjection());
        if (url.includes('/api/clio/hermes/runs/run-9/events')) {
          return stream([{ type: 'done', runtime: 'hermes', runId: 'run-9' }]);
        }
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

  test('a terminal run clears the stale pointer instead of reattaching', async () => {
    writeHermesRunPointer(window.sessionStorage, 'conversation-1', { runId: 'run-42' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/api/clio/hermes/runs/run-42')) {
          return json(runProjection({ runId: 'run-42', status: 'completed', pendingInteractions: [] }));
        }
        return json({});
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() =>
      expect(readHermesRunPointer(window.sessionStorage, 'conversation-1')).toBeNull(),
    );
    expect(result.current.hermesInteractions).toHaveLength(0);
  });
});
