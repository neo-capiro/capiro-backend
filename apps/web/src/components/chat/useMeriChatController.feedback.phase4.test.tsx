import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const stableAuth = { getToken: async () => 'test-token', orgId: 'org-1', userId: 'user-1' };
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => stableAuth }));
const stableApi = { get: async () => ({ data: [] }), post: async () => ({ data: {} }) };
vi.mock('../../lib/use-api.js', () => ({ useApi: () => stableApi }));
const stableImpersonation = { actAsTenantSlug: null };
vi.mock('../../state/impersonation.js', () => ({ useImpersonation: () => stableImpersonation }));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));
import { useMeriChatController } from './useMeriChatController.js';
import { appendChatMessage, getChatStateSnapshot, resetChatStoreForTests, setChatSession } from './chat-store.js';

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
const rating = () => getChatStateSnapshot().messages.find((message) => message.id === 'durable-message')?.feedback;
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mountFeedback(responses: Array<Promise<Response>>) {
  const calls: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/feedback')) {
      calls.push(JSON.parse(String(init?.body)));
      return responses.shift() ?? Promise.resolve(new Response(null, { status: 200 }));
    }
    return Promise.resolve(new Response('[]', { status: 200 }));
  }));
  const hook = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
  act(() => appendChatMessage({ id: 'durable-message', role: 'assistant', content: 'Answer', createdAt: new Date(), feedback: 'up' }));
  return { ...hook, calls };
}

describe('Phase 4 feedback request ownership and ordering', () => {
  beforeEach(() => { stableAuth.userId = 'user-1'; resetChatStoreForTests(); setChatSession('conversation-1'); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('rolls back a failed write and accepts an explicit retry against the same durable message', async () => {
    const failure = deferred<Response>();
    const { result, calls } = mountFeedback([failure.promise]);
    let first!: Promise<void>;
    act(() => { first = result.current.submitFeedback('durable-message', { rating: 'down', reasons: ['outdated'], note: 'Please check date' }); });
    const rejected = expect(first).rejects.toThrow('Feedback could not be saved');
    await waitFor(() => expect(rating()).toBe('down'));
    await act(async () => { failure.resolve(new Response(null, { status: 503 })); await rejected; });
    expect(rating()).toBe('up');
    await act(async () => result.current.submitFeedback('durable-message', { rating: 'down', reasons: ['outdated'], note: 'Please check date' }));
    expect(rating()).toBe('down');
    expect(calls).toEqual([
      { rating: 'down', reasons: ['outdated'], note: 'Please check date' },
      { rating: 'down', reasons: ['outdated'], note: 'Please check date' },
    ]);
  });

  it('serializes rapid changes and rolls back to the most recent saved selection', async () => {
    const firstResponse = deferred<Response>(); const secondResponse = deferred<Response>();
    const { result, calls } = mountFeedback([firstResponse.promise, secondResponse.promise]);
    let first!: Promise<void>; let second!: Promise<void>;
    act(() => { first = result.current.submitFeedback('durable-message', { rating: 'down' }); second = result.current.submitFeedback('durable-message', { rating: null }); });
    const rejected = expect(second).rejects.toThrow('Feedback could not be saved');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(rating()).toBe('down');
    await act(async () => { firstResponse.resolve(new Response(null, { status: 200 })); await first; });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(rating()).toBeNull();
    await act(async () => { secondResponse.resolve(new Response(null, { status: 503 })); await rejected; });
    expect(rating()).toBe('down');
  });

  it('allows the newer selection after an earlier request fails', async () => {
    const response = deferred<Response>();
    const { result, calls } = mountFeedback([response.promise]);
    let first!: Promise<void>; let second!: Promise<void>;
    act(() => { first = result.current.submitFeedback('durable-message', { rating: 'down' }); second = result.current.submitFeedback('durable-message', { rating: null }); });
    const rejected = expect(first).rejects.toThrow('Feedback could not be saved');
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => { response.resolve(new Response(null, { status: 500 })); await rejected; await second; });
    expect(rating()).toBeNull();
    expect(calls).toEqual([{ rating: 'down' }, { rating: null }]);
  });

  it('does not roll back a different identity when an old write fails', async () => {
    const response = deferred<Response>();
    const { result, calls, rerender } = mountFeedback([response.promise]);
    let task!: Promise<void>;
    act(() => { task = result.current.submitFeedback('durable-message', { rating: 'down' }); });
    await waitFor(() => expect(calls).toHaveLength(1));
    stableAuth.userId = 'user-2'; rerender();
    act(() => {
      setChatSession('conversation-1');
      appendChatMessage({ id: 'durable-message', role: 'assistant', content: 'Different owner', createdAt: new Date(), feedback: null });
    });
    await act(async () => { response.resolve(new Response(null, { status: 500 })); await task; });
    expect(rating()).toBeNull();
  });

  it('does not let a late failure overwrite freshly loaded history after a route transition', async () => {
    const response = deferred<Response>();
    const { result, calls } = mountFeedback([response.promise]);
    let task!: Promise<void>;
    act(() => { task = result.current.submitFeedback('durable-message', { rating: 'down' }); });
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => { result.current.discardRouteState(); setChatSession('conversation-2'); });
    act(() => { setChatSession('conversation-1'); });
    await act(async () => { response.resolve(new Response(null, { status: 500 })); await task; });
    expect(rating()).toBe('down');
  });
});
