import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const stableGetToken = vi.fn(async () => 'test-token');
const stableAuth = { getToken: stableGetToken, orgId: 'org-1', userId: 'user-1' };
const stableApi = { get: async () => ({ data: [] }), post: async () => ({ data: {} }) };
const stableImpersonation = { actAsTenantSlug: null };
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => stableAuth }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => stableApi }));
vi.mock('../../state/impersonation.js', () => ({ useImpersonation: () => stableImpersonation }));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));

import { useMeriChatController } from './useMeriChatController.js';
import { resetChatStoreForTests, setChatSession } from './chat-store.js';

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start: (stream) => {
        controller = stream;
      },
    }),
    { status: 200 },
  );
  return {
    response,
    emit: (...events: Array<Record<string, unknown>>) => {
      controller.enqueue(
        new TextEncoder().encode(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        ),
      );
    },
    close: () => controller.close(),
  };
}

function completeInventory() {
  const stream = controlledStream();
  stream.emit(
    { type: 'start', intent: 'client_inventory', tier: 'deep' },
    { type: 'plan', steps: ['Read client inventory'] },
    { type: 'tool_call', tool: 'client_context', label: 'Reviewed client context' },
    {
      type: 'sources',
      sources: [
        { tool: 'client_context', summary: '26 capabilities', count: 26, confidence: 'high' },
      ],
    },
    { type: 'text', text: 'The client has 26 capabilities.' },
    {
      type: 'done',
      messageId: 'saved-inventory',
      retrieval: {
        plan: {
          subjectScope: 'client',
          queryClass: 'lookup',
          targetHint: null,
          recipeTool: null,
          requiredDomains: ['clients'],
        },
        coverage: {
          complete: true,
          stopReason: null,
          recordsReturned: 26,
          recordsEvaluated: 26,
          paginationComplete: true,
          truncated: false,
        },
      },
    },
  );
  stream.close();
  return stream.response;
}

function routeFetch(stream: (init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith('/stream') ? stream(init) : new Response('[]', { status: 200 }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('Meri work belongs to its pending turn', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    setChatSession('conversation-1');
    stableGetToken.mockImplementation(async () => 'test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('clears old work before the next response headers or start frame arrive and preserves the saved receipt', async () => {
    const nextStream = controlledStream();
    let resolveNext!: (response: Response) => void;
    let turns = 0;
    routeFetch(() =>
      ++turns === 1
        ? completeInventory()
        : new Promise((resolve) => {
            resolveNext = resolve;
          }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      await result.current.sendMessage('Inventory');
    });
    const inventory = result.current.messages.find((message) => message.id === 'saved-inventory');
    expect(result.current.trustSteps).toHaveLength(1);
    expect(result.current.lastRetrieval?.coverage.complete).toBe(true);

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.sendMessage('Search Federal Market');
    });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.trustSteps).toEqual([]);
    expect(result.current.planSteps).toEqual([]);
    expect(result.current.orchestratorIntent).toBeNull();
    expect(result.current.orchestratorTier).toBeNull();
    expect(result.current.lastRetrieval).toBeNull();
    expect(result.current.messages.find((message) => message.id === 'saved-inventory')).toEqual(
      inventory,
    );

    await waitFor(() => expect(turns).toBe(2));
    await act(async () => {
      resolveNext(nextStream.response);
    });
    expect(result.current.trustSteps).toEqual([]);
    await act(async () => {
      nextStream.emit(
        {
          type: 'tool_call',
          tool: 'procurement_forecast',
          label: 'Searched procurement forecasts',
        },
        {
          type: 'sources',
          sources: [
            { tool: 'procurement_forecast', count: 0, summary: 'No results', confidence: 'high' },
          ],
        },
        { type: 'done', messageId: 'saved-market' },
      );
      nextStream.close();
      expect(await pending).toBe(true);
    });
    expect(
      result.current.messages.find((message) => message.id === 'saved-market')?.trustSteps,
    ).toEqual([
      expect.objectContaining({ tool: 'procurement_forecast', count: 0, status: 'done' }),
    ]);
    expect(result.current.messages.find((message) => message.id === 'saved-inventory')).toEqual(
      inventory,
    );
  });

  test('ignores a read fulfilled after Stop and retains the work and partial text already received', async () => {
    const stream = controlledStream();
    routeFetch(() => stream.response);
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.sendMessage('Check forecasts');
    });
    await act(async () => {
      stream.emit(
        { type: 'tool_call', tool: 'procurement_forecast', label: 'Searched forecasts' },
        { type: 'text', text: 'One observed result.' },
      );
    });
    await waitFor(() => expect(result.current.trustSteps).toHaveLength(1));
    act(() => result.current.handleStop());
    await act(async () => {
      // The stream deliberately ignores AbortSignal to reproduce the already
      // fulfilled browser-read race without relying on network timing.
      stream.emit(
        { type: 'tool_call', tool: 'late_tool', label: 'Must not appear' },
        { type: 'text', text: ' Late text must not appear.' },
      );
      stream.close();
      expect(await pending).toBe(true);
    });
    expect(result.current.trustSteps).toHaveLength(1);
    expect(result.current.messages.find((message) => message.role === 'assistant')).toMatchObject({
      content: 'One observed result.',
      runtimeStatus: { partial: true, stopped: true },
      trustSteps: [expect.objectContaining({ tool: 'procurement_forecast' })],
    });
  });

  test('a stopped stream cannot add work to or unlock a newer pending turn', async () => {
    const oldStream = controlledStream();
    const newStream = controlledStream();
    let turns = 0;
    routeFetch(() => (++turns === 1 ? oldStream.response : newStream.response));
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    let oldPending!: Promise<boolean>;
    act(() => {
      oldPending = result.current.sendMessage('Old lookup');
    });
    await act(async () => {
      oldStream.emit({ type: 'tool_call', tool: 'old_lookup' });
    });
    await waitFor(() => expect(result.current.trustSteps).toHaveLength(1));
    act(() => result.current.handleStop());
    let newPending!: Promise<boolean>;
    act(() => {
      newPending = result.current.sendMessage('New lookup');
    });
    await act(async () => {
      newStream.emit({ type: 'tool_call', tool: 'new_lookup' });
    });
    await waitFor(() => expect(result.current.trustSteps[0]?.tool).toBe('new_lookup'));
    await act(async () => {
      oldStream.emit({ type: 'tool_call', tool: 'late_old_lookup' });
      oldStream.close();
      await oldPending;
    });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.trustSteps.map((step) => step.tool)).toEqual(['new_lookup']);
    await act(async () => {
      newStream.emit({ type: 'done', messageId: 'new-result' });
      newStream.close();
      await newPending;
    });
    const assistants = result.current.messages.filter((message) => message.role === 'assistant');
    expect(assistants[0]).toMatchObject({
      runtimeStatus: { stopped: true },
      trustSteps: [expect.objectContaining({ tool: 'old_lookup' })],
    });
    expect(assistants[1]).toMatchObject({
      id: 'new-result',
      trustSteps: [expect.objectContaining({ tool: 'new_lookup' })],
    });
  });

  test('Stop while authentication is pending prevents dispatch and keeps the unsent draft recoverable', async () => {
    const fetchMock = routeFetch(() => completeInventory());
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {});
    let resolveToken!: (token: string) => void;
    stableGetToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.sendMessage('Keep this unsent prompt');
    });
    act(() => result.current.handleStop());
    await act(async () => {
      resolveToken('test-token');
      expect(await pending).toBe(false);
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/stream'))).toHaveLength(0);
    expect(result.current.isStreaming).toBe(false);
    expect(
      result.current.messages.find((message) => message.role === 'assistant')?.runtimeStatus,
    ).toMatchObject({ partial: true, stopped: true });
  });

  test.each([null, 'start', 'turn_accepted'] as const)(
    'progress is honest and Stop preserves acceptance only after a durable receipt (%s)',
    async (receiptType) => {
      const stream = controlledStream();
      routeFetch(() => stream.response);
      const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
        wrapper,
      });
      let pending!: Promise<boolean>;
      act(() => {
        pending = result.current.sendMessage('Prepare client context');
      });
      await act(async () => {
        stream.emit({
          type: 'progress',
          accepted: false,
          phase: 'context',
          runId: 'run-1',
          note: 'Reading authorized client context',
          elapsedMs: 5000,
        });
      });
      await waitFor(() =>
        expect(result.current.turnProgress).toEqual({
          note: 'Reading authorized client context',
          elapsedMs: 5000,
        }),
      );
      expect(result.current.trustSteps).toEqual([]);
      if (receiptType) {
        await act(async () => {
          stream.emit(
            { type: receiptType, intent: 'client_brief', tier: 'fast' },
            {
              type: 'progress',
              phase: 'provider',
              runId: 'run-1',
              note: 'Waiting for the model provider',
              elapsedMs: 10000,
            },
          );
        });
        await waitFor(() =>
          expect(result.current.turnProgress?.note).toBe('Waiting for the model provider'),
        );
      }
      act(() => result.current.handleStop());
      expect(result.current.turnProgress).toBeNull();
      await act(async () => {
        stream.close();
        expect(await pending).toBe(Boolean(receiptType));
      });
      expect(result.current.trustSteps).toEqual([]);
    },
  );

  test('Stop after response headers but before any acceptance frame leaves the draft recoverable', async () => {
    const stream = controlledStream();
    const fetchMock = routeFetch(() => stream.response);
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.sendMessage('Keep this pending prompt');
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/stream'))).toBe(true),
    );
    act(() => result.current.handleStop());
    await act(async () => {
      stream.close();
      expect(await pending).toBe(false);
    });
  });
});
