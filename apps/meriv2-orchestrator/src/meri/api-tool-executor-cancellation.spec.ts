import { ApiToolExecutorRepo } from './api-tool-executor.repo.js';
import { ApiActionProposalRepo } from './api-action-proposal.repo.js';
import { ApiManagedMcpRepo } from './meriv3/api-managed-mcp.repo.js';
import { ApiVisualAnalysisRepo } from './meriv3/api-visual-analysis.repo.js';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';

describe('Meri tool transport cancellation', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const config = {
    get: (key: string) =>
      key === 'MERIV2_TOOL_TIMEOUT_MS'
        ? '60000'
        : key === 'MERIV2_API_BASE_URL'
          ? 'http://api.test'
          : key === 'INTERNAL_SERVICE_SECRET'
            ? 'internal-secret'
            : undefined,
  };

  test.each(['tool', 'action', 'managed', 'visual'])(
    'propagates cancellation and the deadline to %s transport',
    async (kind) => {
      const abort = new AbortController();
      const deadlineAt = Date.now() + 5000;
      let transport: AbortSignal | undefined;
      global.fetch = jest.fn(async (_url, init) => {
        transport = init?.signal as AbortSignal;
        expect((init?.headers as Record<string, string>)['x-meri-deadline-at']).toBe(
          String(deadlineAt),
        );
        return new Promise<Response>((_resolve, reject) =>
          transport!.addEventListener('abort', () => reject(transport!.reason), { once: true }),
        );
      }) as typeof fetch;
      const pending = RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        kind === 'tool'
          ? new ApiToolExecutorRepo(config as never).execute(
              {} as never,
              'search_memory',
              {},
              { signal: abort.signal, deadlineAt },
            )
          : kind === 'managed'
            ? new ApiManagedMcpRepo(config as never).executeRead(
                'mcp__meriv3_hubspot__read',
                {},
                { signal: abort.signal, deadlineAt },
              )
            : kind === 'visual'
              ? new ApiVisualAnalysisRepo(config as never).execute(
                  {},
                  { signal: abort.signal, deadlineAt },
                )
              : new ApiActionProposalRepo(config as never).create(
                  { tool: 'save_note', input: {}, surface: 'chat' },
                  { signal: abort.signal, deadlineAt },
                ),
      );
      expect(transport?.aborted).toBe(false);
      abort.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(transport?.aborted).toBe(true);
    },
  );

  test('pre-cancelled tool requests never reach fetch', async () => {
    global.fetch = jest.fn();
    const abort = new AbortController();
    abort.abort();
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        new ApiToolExecutorRepo(config as never).execute(
          {} as never,
          'search_memory',
          {},
          { signal: abort.signal },
        ),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
