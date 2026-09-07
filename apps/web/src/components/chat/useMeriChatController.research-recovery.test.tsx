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
import { appendChatMessage, resetChatStoreForTests, setChatSession } from './chat-store.js';

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
const run = (status = 'interrupted', phase = 'research') => ({
  id: 'run-1',
  phase,
  status,
  stage: 'Reviewing client evidence',
  elapsedMs: 31_000,
});
const saved = (status = 'interrupted', phase = 'research', extras = {}) => ({
  id: 'research-1',
  title: 'Client briefing',
  run: run(status, phase),
  metadata: { handoff: { conversationId: 'conversation-1' }, planMessageId: 'plan-1' },
  plan: ['Review the client strategy'],
  clarifyingQuestions: ['What is the deadline?'],
  ...extras,
});
const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

beforeEach(() => {
  resetChatStoreForTests();
  setChatSession('conversation-1');
  auth.orgId = 'org-1';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('durable research recovery', () => {
  test('restores saved questions without starting any provider work', async () => {
    const session = saved('awaiting_clarification', 'plan');
    const fetchMock = vi.fn(async (input: unknown) =>
      String(input).includes('research?')
        ? json([session])
        : String(input).endsWith('/research/research-1')
          ? json(session)
          : json([]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.researchAwaitingAnswers).toBe(true));
    expect(result.current.researchQuestions).toEqual(['What is the deadline?']);
    expect(result.current.messages.find((message) => message.id === 'plan-1')?.content).toContain(
      'Review the client strategy',
    );
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/stream'))).toBe(false);
  });

  test('resumes the same saved research and reconciles its canonical report without another user message', async () => {
    let session = saved();
    const calls: string[] = [];
    let resumeHeader: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') calls.push(url);
        if (url.includes('research?')) return json([session]);
        if (url.endsWith('/research/research-1')) return json(session);
        if (url.endsWith('/research/research-1/stream')) {
          resumeHeader = new Headers(init?.headers).get('x-meri-research-resume-run');
          session = saved('complete', 'research', {
            report: { bodyText: 'Verified client report.' },
            metadata: {
              handoff: { conversationId: 'conversation-1' },
              reportMessageId: 'report-1',
            },
          });
          return stream([
            { type: 'report', messageId: 'report-1', body: 'Verified client report.' },
            { type: 'done' },
          ]);
        }
        return json([]);
      }),
    );
    appendChatMessage({
      id: 'original-user',
      role: 'user',
      content: 'Original topic.',
      createdAt: new Date(),
    });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.researchRecovery?.id).toBe('research-1'));
    await act(async () => {
      await result.current.resumeResearch();
    });
    expect(calls).toEqual(['https://api.test/api/clio/research/research-1/stream']);
    expect(resumeHeader).toBe('run-1');
    expect(result.current.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(result.current.messages.filter((message) => message.id === 'report-1')).toHaveLength(1);
    expect(result.current.researchReports['report-1']).toBe('research-1');
  });

  test('restores the public report body and export identity on reload', async () => {
    const session = saved('complete', 'research', {
      report: { bodyText: 'Report held for review.' },
      reportMetadata: {
        citations: [
          {
            n: 1,
            id: 'hearing-1',
            title: 'Committee transcript',
            type: 'hearing',
            tool: 'read_hearing',
            url: 'https://example.gov/hearing',
          },
        ],
        trustSteps: [
          { tool: 'read_hearing', label: 'Read the committee transcript', status: 'done' },
        ],
        contextPacketId: '123e4567-e89b-42d3-a456-426614174000',
        thinking: 'PRIVATE PROVIDER REASONING',
      },
      metadata: {
        handoff: { conversationId: 'conversation-1' },
        reportMessageId: 'report-1',
        rawReport: 'DO NOT DISPLAY',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) =>
        String(input).includes('research?')
          ? json([session])
          : String(input).endsWith('/research/research-1')
            ? json(session)
            : json([]),
      ),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.researchReports['report-1']).toBe('research-1'));
    expect(result.current.messages.find((message) => message.id === 'report-1')?.content).toBe(
      'Report held for review.',
    );
    expect(JSON.stringify(result.current.messages)).not.toContain('DO NOT DISPLAY');
    const report = result.current.messages.find((message) => message.id === 'report-1');
    expect(report?.citations?.[0]?.id).toBe('hearing-1');
    expect(report?.trustSteps?.[0]?.label).toBe('Read the committee transcript');
    expect(report?.contextPacketId).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(JSON.stringify(result.current.researchRecovery)).not.toContain(
      'PRIVATE PROVIDER REASONING',
    );
  });

  test('does not apply a saved run fetched under the previous identity', async () => {
    let resolveDetail!: (value: Response) => void;
    const session = saved();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input).includes('research?'))
          return auth.orgId === 'org-1' ? json([session]) : json([]);
        if (String(input).endsWith('/research/research-1'))
          return new Promise<Response>((resolve) => {
            resolveDetail = resolve;
          });
        return json([]);
      }),
    );
    const { result, rerender } = renderHook(
      () => useMeriChatController({ selectedClientName: null }),
      { wrapper },
    );
    await waitFor(() => expect(resolveDetail).toBeTypeOf('function'));
    act(() => {
      auth.orgId = 'org-2';
      rerender();
    });
    await act(async () => {
      resolveDetail(json(session));
    });
    expect(result.current.researchRecovery).toBeNull();
    expect(result.current.messages).toHaveLength(0);
  });

  test('EOF without done detaches the plan and never advances to research', async () => {
    const calls: string[] = [];
    let created = false;
    const session = saved('running', 'plan');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') calls.push(url);
        if (url.endsWith('/research')) {
          created = true;
          return json({ id: 'research-1' });
        }
        if (url.endsWith('/plan/stream'))
          return stream([{ type: 'plan', plan: ['Review documents'] }]);
        if (url.includes('research?')) return json(created ? [session] : []);
        if (url.endsWith('/research/research-1')) return json(session);
        return json([]);
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    act(() => result.current.setResearchMode(true));
    await act(async () => {
      await result.current.sendMessage('Prepare briefing.');
    });
    await waitFor(() => expect(result.current.researchRecovery?.run.status).toBe('running'));
    expect(calls.some((url) => url.endsWith('/research/research-1/stream'))).toBe(false);
    expect(result.current.isResearchStreaming).toBe(false);
    expect(result.current.researchSessionRef.current).toBe('research-1');
  });

  test('Stop sends an explicit cancel for a detached server run', async () => {
    let session = saved('running');
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') calls.push(url);
        if (url.endsWith('/cancel')) {
          session = saved('cancelled');
          return json({ ok: true, run: session.run });
        }
        if (url.includes('research?')) return json([session]);
        if (url.endsWith('/research/research-1')) return json(session);
        return json([]);
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.researchRecovery?.run.status).toBe('running'));
    await act(async () => {
      result.current.handleStop();
    });
    await waitFor(() => expect(result.current.researchRecovery?.run.status).toBe('cancelled'));
    expect(calls).toEqual(['https://api.test/api/clio/research/research-1/cancel']);
  });
  test('a saved request interrupted before planning resumes the plan without creating another session', async () => {
    let session = saved('interrupted', 'plan', {
      run: {
        ...run('interrupted', 'plan'),
        stage: 'Research request saved; planning has not started',
      },
    });
    const posts: string[] = [];
    let resumeHeader: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push(url);
        if (url.includes('research?')) return json([session]);
        if (url.endsWith('/research/research-1')) return json(session);
        if (url.endsWith('/research/research-1/plan/stream')) {
          resumeHeader = new Headers(init?.headers).get('x-meri-research-resume-run');
          session = saved('awaiting_clarification', 'plan');
          return stream([
            { type: 'title', title: 'Client briefing' },
            { type: 'plan', plan: ['Review the strategy'] },
            { type: 'clarify', questions: ['What is the deadline?'] },
            { type: 'done', messageId: 'plan-1' },
          ]);
        }
        return json([]);
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.researchRecovery?.run.phase).toBe('plan'));
    await act(async () => {
      await result.current.resumeResearch();
    });
    expect(posts).toEqual(['https://api.test/api/clio/research/research-1/plan/stream']);
    expect(resumeHeader).toBe('run-1');
    expect(result.current.researchAwaitingAnswers).toBe(true);
    expect(result.current.messages.filter((message) => message.id === 'plan-1')).toHaveLength(1);
  });

  test('polls a detached run to its completed canonical report using only GET requests', async () => {
    vi.useFakeTimers();
    let session = saved('running');
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push(url);
        if (url.includes('research?')) return json([session]);
        if (url.endsWith('/research/research-1')) return json(session);
        return json([]);
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.researchRecovery?.run.status).toBe('running');
    session = saved('complete', 'research', {
      report: { bodyText: 'Completed while detached.' },
      metadata: { handoff: { conversationId: 'conversation-1' }, reportMessageId: 'report-1' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.researchRecovery?.run.status).toBe('complete');
    expect(result.current.messages.find((message) => message.id === 'report-1')?.content).toBe(
      'Completed while detached.',
    );
    expect(result.current.researchReports['report-1']).toBe('research-1');
    expect(posts).toEqual([]);
  });
  test.each(['failed', 'interrupted'])(
    'a new topic after %s research creates a fresh request instead of silently refusing',
    async (status) => {
      let session = saved(status);
      const createdTopics: string[] = [];
      const streamCalls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown, init?: RequestInit) => {
          const url = String(input);
          if (url.includes('research?')) return json([session]);
          if (url.endsWith(`/research/${session.id}`)) return json(session);
          if (url.endsWith('/research') && init?.method === 'POST') {
            createdTopics.push(JSON.parse(String(init.body)).topic);
            session = saved('awaiting_clarification', 'plan', {
              id: 'research-2',
              metadata: {
                handoff: { conversationId: 'conversation-1' },
                planMessageId: 'plan-2',
              },
            });
            return json({ id: 'research-2' });
          }
          if (url.endsWith('/plan/stream')) {
            streamCalls.push(url);
            return stream([
              { type: 'title', title: 'New topic' },
              { type: 'plan', plan: ['Review new question'] },
              { type: 'clarify', questions: ['Which deadline?'] },
              { type: 'done', messageId: 'plan-2' },
            ]);
          }
          return json([]);
        }),
      );
      const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
        wrapper,
      });
      await waitFor(() => expect(result.current.researchRecovery?.run.status).toBe(status));
      act(() => result.current.setResearchMode(true));
      let accepted = false;
      await act(async () => {
        accepted = await result.current.sendMessage('Research a different client objective.');
      });
      expect(accepted).toBe(true);
      expect(createdTopics).toEqual(['Research a different client objective.']);
      expect(streamCalls).toEqual(['https://api.test/api/clio/research/research-2/plan/stream']);
      expect(result.current.researchSessionRef.current).toBe('research-2');
    },
  );

  test('a known active run still blocks another research topic from starting', async () => {
    const session = saved('running');
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') posts.push(url);
        if (url.includes('research?')) return json([session]);
        if (url.endsWith('/research/research-1')) return json(session);
        return json([]);
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.researchRecovery?.run.status).toBe('running'));
    act(() => result.current.setResearchMode(true));
    let accepted = true;
    await act(async () => {
      accepted = await result.current.sendMessage('Another topic');
    });
    expect(accepted).toBe(false);
    expect(posts).toEqual([]);
  });
});
