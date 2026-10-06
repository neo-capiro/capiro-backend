import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
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

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

function stubResearchCreation() {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/clio/research') && init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        // Refusing creation stops the flow before any plan stream starts.
        return new Response('meri_jobs_disabled', { status: 403 });
      }
      return json([]);
    }),
  );
  return bodies;
}

beforeEach(() => {
  resetChatStoreForTests();
  setChatSession('conversation-1');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Delegate this', () => {
  test('creates a deliverable job that asks for one Word document', async () => {
    const bodies = stubResearchCreation();
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      await result.current.delegateJob('Write an office brief on HR 1');
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      topic: 'Write an office brief on HR 1',
      conversationId: 'conversation-1',
      kind: 'deliverable',
      deliverables: [{ format: 'docx' }],
    });
  });

  test.each([
    ['Compare the House and Senate marks in an Excel workbook', 'xlsx'],
    ['Build a six-slide quarterly update deck', 'pptx'],
  ] as const)('asks for the file the request names: %s', async (request, format) => {
    const bodies = stubResearchCreation();
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      await result.current.delegateJob(request);
    });
    expect(bodies[0]).toMatchObject({ kind: 'deliverable', deliverables: [{ format }] });
  });

  test('ordinary research stays a research session', async () => {
    const bodies = stubResearchCreation();
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    act(() => result.current.setResearchMode(true));
    await act(async () => {
      await result.current.sendMessage('Research HR 1');
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('kind');
    expect(bodies[0]).not.toHaveProperty('deliverables');
  });
});
