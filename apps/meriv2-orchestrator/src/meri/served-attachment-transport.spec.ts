import { MERI_TOOL_NAMES } from '@capiro/shared';
import type { MeriContext, ToolExecutionControl } from '@capiro/meriv2-core';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ApiToolExecutorRepo } from './api-tool-executor.repo.js';
import {
  bindCurrentConversationToolInput,
  CURRENT_CONVERSATION_RESEARCH_PORTFOLIO_TOOLS,
} from './current-turn-tool-scope.js';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';
import {
  withTrustedCurrentTurnScope,
  type TrustedCurrentTurnScope,
} from '../request/trusted-current-turn-scope.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const OTHER_CONVERSATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const SECRET = 'served-attachment-transport-secret';
const originalFetch = global.fetch;

const scope = (conversationId = CONVERSATION): TrustedCurrentTurnScope => ({
  tenantId: TENANT,
  userId: USER,
  conversationId,
  selectedClientId: CLIENT,
});

function config(secret: string | null | undefined = SECRET, apiBaseUrl = 'http://api.test') {
  return {
    get: (key: string) =>
      key === 'INTERNAL_SERVICE_SECRET'
        ? secret
        : key === 'MERIV2_API_BASE_URL'
          ? apiBaseUrl
          : key === 'MERIV2_TOOL_TIMEOUT_MS'
            ? '60000'
            : undefined,
  } as never;
}

function execute(
  input: Record<string, unknown>,
  options: {
    current?: TrustedCurrentTurnScope;
    secret?: string | null;
    control?: ToolExecutionControl;
    apiBaseUrl?: string;
  } = {},
) {
  const repo = new ApiToolExecutorRepo(config(options.secret, options.apiBaseUrl));
  return RequestCredentialsStore.run({ bearerToken: 'fresh-user-bearer' }, () =>
    options.current === undefined
      ? repo.execute({} as MeriContext, 'read_chat_attachments', input)
      : withTrustedCurrentTurnScope(options.current, () =>
          repo.execute({} as MeriContext, 'read_chat_attachments', input, options.control),
        ),
  );
}

afterEach(() => {
  global.fetch = originalFetch;
});

// The API owner returns a qualified manifest envelope even when no records exist.
// A manifest remains discovery-only; transport tests must not invent content coverage.
function attachmentManifest(conversationId = CONVERSATION) {
  return {
    tool: 'read_chat_attachments',
    authoritativeOwner: 'clio_chat_attachment',
    currentStatus: 'available',
    generatedAt: '2026-09-29T00:00:00.000Z',
    conversationId,
    clientId: CLIENT,
    coverage: {
      mode: 'manifest',
      total: null,
      returned: 0,
      unavailableInPage: 0,
      scannedMessages: 0,
      paginationComplete: true,
      complete: true,
      contentComplete: false,
      nextCursor: null,
      query: null,
      queryAppliesTo: 'filename',
    },
    records: [],
  };
}

describe('served attachment executor transport', () => {
  it('sends a bounded server envelope and derives conversationId when model input omits it', async () => {
    const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    global.fetch = jest.fn(async (_url, init) => {
      calls.push({
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify(attachmentManifest()));
    }) as typeof fetch;

    await expect(execute({ limit: 10 }, { current: scope() })).resolves.toMatchObject({
      tool: 'read_chat_attachments',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toMatchObject({
      authorization: 'Bearer fresh-user-bearer',
      'x-internal-service-secret': SECRET,
    });
    expect(calls[0]?.body).toEqual({
      version: 1,
      input: { limit: 10, conversationId: CONVERSATION },
      currentTurn: scope(),
    });
    expect(JSON.stringify(calls[0]?.headers)).not.toContain(CONVERSATION);
    expect(JSON.stringify(calls[0]?.headers)).not.toContain(USER);
  });

  it('uses the real fetch HTTP path with only bearer, service identity, and JSON transport metadata', async () => {
    global.fetch = originalFetch;
    let captured:
      | { url: string; authorization?: string; service?: string; body: Record<string, unknown> }
      | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        captured = {
          url: req.url ?? '',
          authorization: req.headers.authorization,
          service: req.headers['x-internal-service-secret'] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(attachmentManifest()));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('controlled HTTP server unavailable');
    try {
      await execute(
        { attachmentId: '55555555-5555-4555-8555-555555555555' },
        { current: scope(), apiBaseUrl: `http://127.0.0.1:${address.port}` },
      );
    } finally {
      server.close();
      await once(server, 'close');
    }
    expect(captured).toMatchObject({
      url: '/api/clio/tools/read_chat_attachments',
      authorization: 'Bearer fresh-user-bearer',
      service: SECRET,
      body: {
        version: 1,
        input: { conversationId: CONVERSATION },
        currentTurn: scope(),
      },
    });
  });

  it('rejects forged compatibility conversation, missing scope, and missing service identity before HTTP', async () => {
    global.fetch = jest.fn();
    await expect(
      execute({ conversationId: OTHER_CONVERSATION }, { current: scope() }),
    ).rejects.toThrow('cannot target another conversation');
    await expect(execute({})).rejects.toThrow('Trusted current conversation is unavailable');
    await expect(execute({}, { current: scope(), secret: null })).rejects.toThrow(
      'Internal service identity is not configured',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keeps parallel turn envelopes isolated', async () => {
    const bodies: Array<Record<string, any>> = [];
    global.fetch = jest.fn(async (_url, init) => {
      await Promise.resolve();
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      bodies.push(body);
      return new Response(JSON.stringify(attachmentManifest(body.currentTurn.conversationId)));
    }) as typeof fetch;
    const [first, second] = await Promise.all([
      execute({}, { current: scope(CONVERSATION) }),
      execute({}, { current: scope(OTHER_CONVERSATION) }),
    ]);
    expect(first).toEqual(attachmentManifest(CONVERSATION));
    expect(second).toEqual(attachmentManifest(OTHER_CONVERSATION));
    expect(bodies.map((body) => body.input.conversationId).sort()).toEqual(
      [CONVERSATION, OTHER_CONVERSATION].sort(),
    );
    for (const body of bodies) {
      expect(body.input.conversationId).toBe(body.currentTurn.conversationId);
    }
  });

  it('propagates the bounded deadline and aborts the controlled attachment HTTP request', async () => {
    const abort = new AbortController();
    const deadlineAt = Date.now() + 10_000;
    let transportSignal: AbortSignal | undefined;
    global.fetch = jest.fn(async (_url, init) => {
      expect((init?.headers as Record<string, string>)['x-meri-deadline-at']).toBe(
        String(deadlineAt),
      );
      transportSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) =>
        transportSignal!.addEventListener('abort', () => reject(transportSignal!.reason), {
          once: true,
        }),
      );
    }) as typeof fetch;
    const pending = execute(
      {},
      { current: scope(), control: { signal: abort.signal, deadlineAt } },
    );
    expect(transportSignal?.aborted).toBe(false);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(true);
  });
});

describe('bounded Research Portfolio current-conversation contract', () => {
  it('matches all 18 RP capabilities in this checkout canonical registry, without inventing manage', () => {
    const canonical = MERI_TOOL_NAMES.filter((name) => name.includes('research_portfolio')).sort();
    expect([...CURRENT_CONVERSATION_RESEARCH_PORTFOLIO_TOOLS].sort()).toEqual(canonical);
    expect(canonical).toHaveLength(18);
    expect(canonical).not.toContain('manage_research_portfolio');
  });

  it.each(CURRENT_CONVERSATION_RESEARCH_PORTFOLIO_TOOLS)(
    '%s injects an absent current conversation and rejects retargeting',
    (name) => {
      expect(bindCurrentConversationToolInput(name, { limit: 2 }, scope())).toEqual({
        limit: 2,
        conversationId: CONVERSATION,
      });
      expect(() =>
        bindCurrentConversationToolInput(name, { conversationId: OTHER_CONVERSATION }, scope()),
      ).toThrow('cannot target another conversation');
    },
  );

  it('leaves non-RP business tools unchanged and fails RP closed without trusted scope', () => {
    const ordinary = { conversationId: OTHER_CONVERSATION, query: 'NDAA' };
    expect(bindCurrentConversationToolInput('search_congress_bills', ordinary, scope())).toBe(
      ordinary,
    );
    expect(() =>
      bindCurrentConversationToolInput('get_research_portfolio', ordinary, undefined),
    ).toThrow('Trusted current-turn scope is unavailable');
  });
});
