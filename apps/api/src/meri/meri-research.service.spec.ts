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
    // Generous wall-clock budget so the existing specs exercise the round cap,
    // not the budget gate (the budget specs override these).
    CLIO_RESEARCH_TOTAL_BUDGET_MS: 420_000,
    CLIO_RESEARCH_SYNTHESIS_RESERVE_MS: 120_000,
    CLIO_RESEARCH_PROGRESS_INTERVAL_MS: 5_000,
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

function makeReviews() {
  // G4: held reports emit a review_request; fail-open stub for these specs.
  return { createSystem: jest.fn(async () => 'rr-1') } as never;
}

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

    const svc = new MeriResearchService(
      makePrisma(),
      makeConfig(),
      makeTools(),
      makeAiCredentials(),
      makeReviews(),
    );

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

  it('strips unresolved FORM B citation tokens from the delivered report, keeping valid ones', async () => {
    // FORM B tool names are lowercase snake_case (grammar [a-z][a-z0-9_]*), so use
    // a lowercase-named tool here. search_bills IS called this turn and its result
    // serializes "hr1234", so [S:search_bills:hr1234] resolves → kept. The other
    // two don't resolve (record_id absent / tool never called) → stripped.
    const toolsLc = {
      anthropicToolSchemas: () => [
        {
          name: 'search_bills',
          description: 'x',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      isConcurrencySafe: () => true,
      execute: async () => ({ items: [{ id: 'hr1234' }], count: 1 }),
    } as unknown as ConstructorParameters<typeof MeriResearchService>[2];
    const REPORT =
      '# Findings\n\nShipbuilding accounts diverge this cycle [S:search_bills:hr1234]. ' +
      'A fabricated markup figure [S:search_bills:nonesuch] and a ghost-tool cite ' +
      '[S:ghost_tool:42] must not survive.';
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools) return okResponse(sseBody(toolOnlyRound('search_bills')));
      return okResponse(sseBody(proseRound(REPORT)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new MeriResearchService(
      makePrisma(),
      makeConfig(),
      toolsLc,
      makeAiCredentials(),
      makeReviews(),
    );
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

    const reportEvt = events.find((e) => e.type === 'report') ?? {};
    const body = String(reportEvt.body ?? '');
    expect(body).toContain('Findings'); // report was produced
    expect(body).toContain('[S:search_bills:hr1234]'); // resolves → preserved verbatim
    expect(body).not.toContain('nonesuch'); // record_id absent from the tool result → stripped
    expect(body).not.toContain('ghost_tool'); // tool never called this turn → stripped
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

    const svc = new MeriResearchService(
      makePrisma(),
      makeConfig(),
      makeTools(),
      makeAiCredentials(),
      makeReviews(),
    );
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

    const svc = new MeriResearchService(
      makePrisma(),
      makeConfig(),
      makeTools(),
      makeAiCredentials(),
      makeReviews(),
    );
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

    const svc = new MeriResearchService(
      makePrisma(),
      makeConfig(),
      tools,
      makeAiCredentials(),
      makeReviews(),
    );
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

  // ── Wall-clock budget + liveness ──────────────────────────────────────────
  //
  // Two production complaints, one root pair: a research run had no wall-clock
  // ceiling (maxRounds × per-round timeout = 10 × 600s ≈ 100 minutes) and, under
  // MERI_AUDITOR_MODE=enforce, streamed no report text at all until the audit
  // cleared it. A live run and a hung one were indistinguishable in the drawer.

  function collectSse() {
    const events: Array<Record<string, unknown>> = [];
    return {
      events,
      sse: {
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
      },
    };
  }

  it('stops opening gather rounds once the wall-clock budget is spent, and still reports', async () => {
    const REPORT = '# Executive Summary\n\nWritten after the budget cut gathering short.';

    // 50 rounds are permitted, but a 1ms total budget means the gather loop must
    // bail almost immediately instead of burning all 50 model calls.
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools) return okResponse(sseBody(toolOnlyRound('searchBills')));
      return okResponse(sseBody(proseRound(REPORT)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new MeriResearchService(
      makePrisma(),
      makeConfig({
        CLIO_RESEARCH_MAX_TOOL_ROUNDS: 50,
        CLIO_RESEARCH_TOTAL_BUDGET_MS: 1,
        CLIO_RESEARCH_SYNTHESIS_RESERVE_MS: 1,
      }),
      makeTools(),
      makeAiCredentials(),
      makeReviews(),
    );
    const { events, sse } = collectSse();

    await svc.streamResearch(CTX, 'sess-1', sse);

    // The budget gate — not the round cap — ended gathering. The exact count is
    // 1-3 rather than 1: Date.now() has millisecond resolution, so several
    // fully-mocked rounds can complete inside the same millisecond before the
    // deadline is observably passed. The invariant that matters is that gathering
    // stopped nowhere near the 50 permitted rounds.
    const toolRounds = fetchBodies.filter((b) => Array.isArray(b.tools));
    expect(toolRounds.length).toBeLessThan(10);
    // Cutting gathering short must never mean shipping sources with no report:
    // the forced-synthesis pass still gets a usable window (SYNTHESIS_FLOOR_MS).
    const toolless = fetchBodies.filter((b) => !b.tools);
    expect(toolless).toHaveLength(1);
    const report = events.find((e) => e.type === 'report');
    expect(String(report?.body ?? '')).toContain('Executive Summary');
  });

  it('emits progress heartbeats naming the current stage', async () => {
    const REPORT = '# Executive Summary\n\nProgress-instrumented run.';
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools) return okResponse(sseBody(toolOnlyRound('searchBills')));
      return okResponse(sseBody(proseRound(REPORT)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new MeriResearchService(
      makePrisma(),
      makeConfig(),
      makeTools(),
      makeAiCredentials(),
      makeReviews(),
    );
    const { events, sse } = collectSse();

    await svc.streamResearch(CTX, 'sess-1', sse);

    const progress = events.filter((e) => e.type === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    const notes = progress.map((p) => String(p.note));
    expect(notes.some((n) => /Gathering evidence/i.test(n))).toBe(true);
    expect(notes.some((n) => /Writing the report/i.test(n))).toBe(true);
    // Every heartbeat carries elapsed time so the client can render a live timer
    // and treat prolonged silence as a stall.
    expect(progress.every((p) => typeof p.elapsedMs === 'number')).toBe(true);
  });

  it('explains up front that enforce mode withholds the body until checks pass', async () => {
    const prevMode = process.env.MERI_AUDITOR_MODE;
    process.env.MERI_AUDITOR_MODE = 'enforce';
    try {
      const REPORT = '# Executive Summary\n\nEnforced-delivery run.';
      fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
        captureBody(init);
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tools) return okResponse(sseBody(toolOnlyRound('searchBills')));
        return okResponse(sseBody(proseRound(REPORT)));
      }) as unknown as jest.Mock;
      global.fetch = fetchMock as unknown as typeof fetch;

      const svc = new MeriResearchService(
        makePrisma(),
        makeConfig(),
        makeTools(),
        makeAiCredentials(),
        makeReviews(),
      );
      const { events, sse } = collectSse();

      await svc.streamResearch(CTX, 'sess-1', sse);

      // The reader is told WHY nothing is streaming, rather than being left to
      // read an empty bubble as a broken run.
      const notice = events.find((e) => e.type === 'notice');
      expect(String(notice?.message ?? '')).toMatch(/grounding checks/i);
      // The buffering guarantee itself is unchanged: no report prose streams
      // token-by-token ahead of the audit, only the single post-audit delivery.
      expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
    } finally {
      if (prevMode === undefined) delete process.env.MERI_AUDITOR_MODE;
      else process.env.MERI_AUDITOR_MODE = prevMode;
    }
  });

  it('does not emit the enforce notice when grounding enforcement is off', async () => {
    const prevMode = process.env.MERI_AUDITOR_MODE;
    delete process.env.MERI_AUDITOR_MODE;
    try {
      // Long enough that proseRound() splits it into several text_deltas, so
      // "streamed as written" is actually observable (>1 text event).
      const REPORT =
        '# Executive Summary\n\nUnenforced run: the report body streams to the reader ' +
        'token-by-token because no grounding gate is withholding it. [searchBills]';
      fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
        captureBody(init);
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tools) return okResponse(sseBody(toolOnlyRound('searchBills')));
        return okResponse(sseBody(proseRound(REPORT)));
      }) as unknown as jest.Mock;
      global.fetch = fetchMock as unknown as typeof fetch;

      const svc = new MeriResearchService(
        makePrisma(),
        makeConfig(),
        makeTools(),
        makeAiCredentials(),
        makeReviews(),
      );
      const { events, sse } = collectSse();

      await svc.streamResearch(CTX, 'sess-1', sse);

      expect(events.find((e) => e.type === 'notice')).toBeUndefined();
      // Unbuffered mode still streams prose as it is written.
      expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(1);
    } finally {
      if (prevMode !== undefined) process.env.MERI_AUDITOR_MODE = prevMode;
    }
  });
});
