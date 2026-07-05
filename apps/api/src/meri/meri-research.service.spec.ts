import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TextEncoder } from 'node:util';
import type { TenantContext } from '@capiro/shared';
import { MeriResearchService } from './meri-research.service.js';

/**
 * Unit test for the FORCED-SYNTHESIS fallback in MeriResearchService.
 *
 * Regression guard for the "Deep Research only shows the sources it searched,
 * never writes a report" bug. With 22 tools, the agentic loop can burn every
 * round calling tools (gathering) and exit on the round cap WITHOUT ever
 * streaming report prose. The fix: after the loop, if no report text was
 * produced, make one final Anthropic call with the `tools` key OMITTED so the
 * model physically cannot call tools and must write prose.
 *
 * This test mocks the Anthropic streaming endpoint (global.fetch) to return
 * tool-only rounds for every tools-enabled call, then asserts that:
 *   1. A final fetch is made with NO `tools` key (the forced-synthesis call).
 *   2. That call streams `text_delta`s which surface as `text` SSE events.
 *   3. A `report` SSE event with a non-empty body is emitted before `done`.
 *
 * No network, no DB, no Anthropic key required — fully CI-runnable.
 */

// ── SSE stream builders ──────────────────────────────────────────────────────

/**
 * Encode an array of Anthropic stream events as an async-iterable body of
 * Uint8Array chunks. We deliberately do NOT use the web `ReadableStream` global
 * here: jest's `node` test environment does not expose it, but the service only
 * relies on `response.body` being `AsyncIterable<Uint8Array>` — which is exactly
 * what undici's real fetch body is. An async generator satisfies that contract.
 */
function sseBody(events: Array<Record<string, unknown>>): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  // Split mid-stream to exercise the buffer/record-boundary reassembly path.
  const mid = Math.floor(lines.length / 2);
  const chunks = [lines.slice(0, mid), lines.slice(mid)];
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield enc.encode(c);
      }
    },
  };
}

/** A round where the model only calls one tool and stops with stop_reason=tool_use. */
function toolOnlyRound(toolName: string, index = 0): Array<Record<string, unknown>> {
  return [
    { type: 'message_start', message: { role: 'assistant' } },
    {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: `tool_${index}_${toolName}`, name: toolName },
    },
    {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
    },
    { type: 'content_block_stop', index },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
}

/** A round of pure prose (the forced-synthesis answer). */
function proseRound(text: string): Array<Record<string, unknown>> {
  // Stream the prose as several deltas to mimic real token streaming.
  const parts = text.match(/.{1,40}/gs) ?? [text];
  return [
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...parts.map((t) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: t },
    })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

function okResponse(body: AsyncIterable<Uint8Array>): Response {
  return {
    ok: true,
    status: 200,
    body: body as unknown as ReadableStream<Uint8Array>,
    text: async () => '',
  } as unknown as Response;
}

// ── Dep stubs ────────────────────────────────────────────────────────────────

const CTX: TenantContext = {
  tenantId: 'tenant-1',
  userId: 'user-1',
} as unknown as TenantContext;

const SESSION = {
  id: 'sess-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  clientId: null,
  title: 'Test research',
  topic: 'Defense appropriations outlook',
  status: 'researching',
  plan: ['Scan recent markups', 'Identify divergence'],
  clarifyingQuestions: [],
  clarifyingAnswers: {},
  sources: null,
  reportArtifactId: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    ANTHROPIC_API_KEY: 'test-key',
    CLIO_RESEARCH_MODEL: 'claude-test',
    CLIO_RESEARCH_MAX_TOKENS: 8000,
    CLIO_REQUEST_TIMEOUT_MS: 60_000,
    CLIO_RESEARCH_TIMEOUT_MS: 60_000, // research uses its own (longer) per-call timeout
    CLIO_RESEARCH_MAX_TOOL_ROUNDS: 2, // small cap so the loop exhausts fast
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConstructorParameters<
    typeof MeriResearchService
  >[1];
}

/**
 * AI-credential resolver stub (BYOK): both resolve* methods return the global
 * test key, mirroring the pre-BYOK behavior where the key came from
 * config.get('ANTHROPIC_API_KEY'). usedTenantKey=false = global fallback path.
 */
function makeAiCredentials() {
  const resolved = {
    provider: 'anthropic' as const,
    apiKey: 'test-key',
    model: 'claude-test',
    usedTenantKey: false,
    modelOverridden: false,
  };
  return {
    resolveProvider: async () => resolved,
    resolveProviderByTenantId: async () => resolved,
  } as unknown as ConstructorParameters<typeof MeriResearchService>[3];
}

/**
 * Prisma stub: withTenant just runs the callback with a tx whose model methods
 * resolve to minimal shapes. findFirst returns the session (for ensureSession);
 * create returns ids; update is a no-op.
 */
function makePrisma() {
  const tx = {
    clioResearchSession: {
      findFirst: async () => SESSION,
      update: async () => SESSION,
    },
    clioConversation: {
      create: async () => ({ id: 'conv-1' }),
    },
    clioArtifact: {
      create: async () => ({ id: 'artifact-1' }),
      findFirst: async () => null,
    },
    client: {
      findFirst: async () => null,
    },
  };
  return {
    withTenant: async (_tenantId: string, cb: (t: typeof tx) => unknown) => cb(tx),
  } as unknown as ConstructorParameters<typeof MeriResearchService>[0];
}

// Mirror of apps/api/src/meri/meri-tools.service.ts SIDE_EFFECTING_TOOLS — the
// write/send/docgen tools that must never be offered to (or run by) the
// read-only Deep Research gather loop.
const SIDE_EFFECTING_TEST = new Set([
  'create_meeting_brief',
  'draft_policy_memo',
  'save_note',
  'send_email',
  'reply_email',
  'save_memory',
  'create_word',
  'create_excel',
  'create_powerpoint',
  'schedule_task',
  'cancel_scheduled_task',
  'create_task',
  'update_task',
  'update_client_profile',
]);

function makeTools() {
  return {
    anthropicToolSchemas: () => [
      { name: 'searchBills', description: 'x', input_schema: { type: 'object', properties: {} } },
    ],
    isConcurrencySafe: (name: string) => !SIDE_EFFECTING_TEST.has(name),
    execute: async () => ({ items: [{ id: 1 }], count: 1 }),
  } as unknown as ConstructorParameters<typeof MeriResearchService>[2];
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe('MeriResearchService — forced synthesis', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let fetchBodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    fetchBodies = [];
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function captureBody(init?: RequestInit) {
    try {
      fetchBodies.push(JSON.parse(String(init?.body ?? '{}')));
    } catch {
      fetchBodies.push({});
    }
  }

  it('emits a report after the tool loop exhausts without prose', async () => {
    const REPORT =
      '# Executive Summary\n\nThe FY26 defense markup shows meaningful divergence ' +
      'between the House and Senate on shipbuilding accounts, creating a window for ' +
      'client engagement. [searchBills]\n\n## Recommended Actions\n\n1. Brief the client.\n\n' +
      '## Open Questions\n\nConference timing remains uncertain.';

    // Every tools-enabled call returns a tool-only round; the first call with NO
    // `tools` key returns the report prose.
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools) {
        return okResponse(sseBody(toolOnlyRound('searchBills')));
      }
      return okResponse(sseBody(proseRound(REPORT)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new MeriResearchService(makePrisma(), makeConfig(), makeTools(), makeAiCredentials());

    const events: Array<Record<string, unknown>> = [];
    const sse = {
      write: (data: string) => {
        // Service writes "data: <json>\n\n"; parse the JSON payload back out.
        const line = data.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* ignore */
          }
        }
      },
    };

    await svc.streamResearch(CTX, 'sess-1', sse);

    // 1. The tool loop ran (cap=2) and then a forced-synthesis call was made.
    //    => total fetches = 2 tool rounds + 1 synthesis = 3.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 2. Exactly one fetch omitted the `tools` key — the forced-synthesis call.
    const toolless = fetchBodies.filter((b) => !('tools' in b) || !b.tools);
    expect(toolless).toHaveLength(1);
    // ...and it carried the explicit "write the report NOW" nudge as the last msg.
    const synthBody = toolless[0] ?? {};
    const synthMsgs = (synthBody.messages as Array<{ role: string; content: unknown }>) ?? [];
    const lastMsg = synthMsgs[synthMsgs.length - 1];
    expect(String(lastMsg?.content ?? '')).toMatch(/write the full.*report now/i);

    // 3. Report prose surfaced as `text` SSE events during synthesis.
    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
    const streamedText = textEvents.map((e) => String(e.text)).join('');
    expect(streamedText).toContain('Executive Summary');

    // 4. A single `report` event with a non-empty body fired, before `done`.
    const reportIdx = events.findIndex((e) => e.type === 'report');
    const doneIdx = events.findIndex(
      (e) => e.type === 'done' && reportIdx >= 0 && events.indexOf(e) > reportIdx,
    );
    expect(reportIdx).toBeGreaterThanOrEqual(0);
    const reportEvt = events[reportIdx] ?? {};
    expect(String(reportEvt.body ?? '')).toContain('Executive Summary');
    expect(String(reportEvt.artifactId ?? '')).toBe('artifact-1');
    expect(doneIdx).toBeGreaterThan(reportIdx);

    // 5. A synthesize phase was announced.
    expect(events.some((e) => e.type === 'phase' && e.phase === 'synthesize')).toBe(true);
  });

  it('forces synthesis (never sources-only) when a gather round times out', async () => {
    // Regression guard for the production "only the research sources" bug: a
    // gather round exceeded CLIO_RESEARCH_TIMEOUT_MS, the AbortController fired,
    // and the old code let that abort kill the whole run — persisting just the
    // sources. Now an aborted round must fall through to forced synthesis.
    const REPORT = '# Executive Summary\n\nForced after a gather-round timeout. [searchBills]';

    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools) {
        // Simulate the per-round AbortController firing on the research timeout.
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      // The no-tools forced-synthesis call writes the report.
      return okResponse(sseBody(proseRound(REPORT)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new MeriResearchService(makePrisma(), makeConfig(), makeTools(), makeAiCredentials());
    const events: Array<Record<string, unknown>> = [];
    const sse = {
      write: (data: string) => {
        const line = data.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* ignore */
          }
        }
      },
    };

    await svc.streamResearch(CTX, 'sess-1', sse);

    // The aborted tool round did NOT end the run on sources alone — a single
    // forced (no-tools) synthesis call ran and produced the report.
    const toolless = fetchBodies.filter((b) => !('tools' in b) || !b.tools);
    expect(toolless).toHaveLength(1);
    const report = events.find((e) => e.type === 'report');
    expect(report).toBeTruthy();
    expect(String(report?.body ?? '')).toContain('Executive Summary');
    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
  });

  it('does NOT make a forced-synthesis call when the model already wrote prose', async () => {
    const REPORT = '# Executive Summary\n\nMeri produced this report inline during the loop.';

    // First (and only) tools-enabled call streams BOTH a tool_use stop AND prose?
    // No — to represent "the model wrote the report", the very first call returns
    // prose and stops with end_turn, so the loop breaks immediately.
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      return okResponse(sseBody(proseRound(REPORT)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new MeriResearchService(makePrisma(), makeConfig(), makeTools(), makeAiCredentials());
    const events: Array<Record<string, unknown>> = [];
    const sse = {
      write: (data: string) => {
        const line = data.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* ignore */
          }
        }
      },
    };

    await svc.streamResearch(CTX, 'sess-1', sse);

    // Only the first tools-enabled call should happen — no forced synthesis,
    // because reportBody was already populated.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchBodies[0]?.tools).toBeTruthy();
    const report = events.find((e) => e.type === 'report');
    expect(report).toBeTruthy();
    expect(String(report?.body ?? '')).toContain('Executive Summary');
  });

  it('excludes side-effecting tools from the gather schema and blocks them if called (B5)', async () => {
    const REPORT = '# Executive Summary\n\nRead-only research report.';
    const executeSpy = jest.fn(async () => ({ ok: true }));
    // Offers BOTH a read-only tool and a write tool; the service must filter the
    // write tool out of the schema it sends to the model.
    const tools = {
      anthropicToolSchemas: () => [
        { name: 'searchBills', description: 'x', input_schema: { type: 'object', properties: {} } },
        { name: 'send_email', description: 'x', input_schema: { type: 'object', properties: {} } },
      ],
      isConcurrencySafe: (name: string) => !SIDE_EFFECTING_TEST.has(name),
      execute: executeSpy,
    } as unknown as ConstructorParameters<typeof MeriResearchService>[2];

    // Every tools-enabled call FORCES a send_email tool_use (simulating a
    // schema-filter regression / model hallucination) to exercise the
    // defense-in-depth execution guard; the no-tools call returns the report.
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools) {
        return okResponse(sseBody(toolOnlyRound('send_email')));
      }
      return okResponse(sseBody(proseRound(REPORT)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new MeriResearchService(makePrisma(), makeConfig(), tools, makeAiCredentials());
    const events: Array<Record<string, unknown>> = [];
    const sse = {
      write: (data: string) => {
        const line = data.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* ignore */
          }
        }
      },
    };

    await svc.streamResearch(CTX, 'sess-1', sse);

    // (1) Schema filter: the tools offered to the model exclude the write tool.
    const firstToolsCall = fetchBodies.find((b) => Array.isArray(b.tools));
    const offered = ((firstToolsCall?.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
    expect(offered).toContain('searchBills');
    expect(offered).not.toContain('send_email');

    // (2) Defense-in-depth: even though the mock forced a send_email tool_use,
    //     execute() was never invoked (the guard blocked it before execution).
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
