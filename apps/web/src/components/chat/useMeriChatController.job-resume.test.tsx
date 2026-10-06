import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
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
const session = (kind: string) => ({
  id: 'research-1',
  title: 'Office brief',
  run: {
    id: 'run-1',
    phase: 'research',
    status: 'interrupted',
    stage: 'Lease lost',
    readyToStart: true,
  },
  metadata: { handoff: { conversationId: 'conversation-1' } },
  plan: ['Read the bill'],
  clarifyingQuestions: [],
  job: { kind, status: 'queued', goalRevision: 0, deliverables: [], awaitingStart: true },
});

function stub(kind: string) {
  const resumes: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/stream')) {
        const headers = new Headers(init?.headers);
        resumes.push(headers.get('x-meri-research-resume-run') ?? '');
        return new Response('data: {"type":"done"}\n\n', { status: 200 });
      }
      if (url.includes('research?')) return json([session(kind)]);
      if (url.endsWith('/research/research-1')) return json(session(kind));
      return json([]);
    }),
  );
  return resumes;
}

beforeEach(() => {
  resetChatStoreForTests();
  setChatSession('conversation-1');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('job auto-resume', () => {
  test('resumes an interrupted delegated job once while its conversation is open', async () => {
    const resumes = stub('deliverable');
    renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(resumes).toEqual(['run-1']));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resumes).toEqual(['run-1']);
  });

  test('leaves interrupted plain research to the explicit Reconnect control', async () => {
    const resumes = stub('research');
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.researchRecovery?.id).toBe('research-1'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resumes).toEqual([]);
  });
});
