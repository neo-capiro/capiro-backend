import { OrchestratorClient } from '../src/hearing/orchestrator.client.js';

/**
 * G1 — the intel-api ↔ orchestrator tool-invocation contract.
 *
 * Regression guard for the live-prod mismatch fixed 2026-07-05: the client must
 * (1) hit `/meri-api/tools/<name>/invoke` (not the bare `/<name>`),
 * (2) wrap the tool input under `{ input: {...} }` (the controller reads
 *     `body.input`), and
 * (3) read the tool's return value back under `data.result` (the controller
 *     returns `{ tool, result }`).
 * All three were wrong at once, so every live hearing silently produced ZERO AI
 * enrichment (graceful-degrade masked the 404). These tests assert the exact
 * wire shape and that a populated result is threaded back through.
 */

const BASE = 'https://orch.test';

function makeClient(): OrchestratorClient {
  const config = {
    get: (key: string) =>
      key === 'MERIV2_ORCHESTRATOR_URL' ? BASE : key === 'MERIV2_TIMEOUT_MS' ? '8000' : undefined,
  } as never;
  return new OrchestratorClient(config);
}

type FetchCall = { url: string; init: RequestInit };

function mockFetch(response: { ok: boolean; status?: number; json?: unknown }): FetchCall[] {
  const calls: FetchCall[] = [];
  (global as unknown as { fetch: unknown }).fetch = jest.fn(
    async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        json: async () => response.json,
      };
    },
  );
  return calls;
}

const originalFetch = global.fetch;
afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('OrchestratorClient.extract — tag_live_policy_mentions contract', () => {
  it('hits /invoke, wraps the input, and reads data.result', async () => {
    const calls = mockFetch({
      ok: true,
      json: {
        tool: 'tag_live_policy_mentions',
        result: {
          entityMentions: [{ entityType: 'bill', entityLabel: 'H.R. 1', confidence: 0.9 }],
          keyQuote: { text: 'We must fund this.', confidence: 0.8, issueTags: ['funding'] },
          clientRelevanceScore: 0.7,
          issueTags: ['funding'],
          summaryCard: { cardType: 'bill_mention', title: 'H.R. 1 discussed' },
        },
      },
    });

    const client = makeClient();
    const out = await client.extract({
      tenantId: 'tenant_1',
      sessionId: 'sess_1',
      authToken: 'jwt_abc',
      segment: { startMs: 0, endMs: 8200, text: 'fund H.R. 1', speakerLabel: 'Chair' },
      sessionContext: {
        clientId: 'client_1',
        issueIds: [],
        billIds: [],
        programElementIds: [],
        committeeId: 'hasc',
      },
    });

    // Axis 1: route ends in /invoke
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/meri-api/tools/tag_live_policy_mentions/invoke`);

    // Axis 2: body is wrapped under `input`, with exactly the tool's fields.
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(Object.keys(body)).toEqual(['input']);
    expect(body.input).toEqual({
      sessionId: 'sess_1',
      segment: { startMs: 0, endMs: 8200, text: 'fund H.R. 1', speakerLabel: 'Chair' },
      context: {
        clientId: 'client_1',
        issueIds: [],
        billIds: [],
        programElementIds: [],
        committeeId: 'hasc',
      },
    });
    // transport concerns must NOT leak into the tool input
    expect(body.input.authToken).toBeUndefined();
    expect(body.input.tenantId).toBeUndefined();
    // headers still carry auth + tenant
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer jwt_abc');
    expect(headers['x-tenant-id']).toBe('tenant_1');

    // Axis 3: fields are read from data.result — populated, not empty.
    expect(out.entityMentions).toHaveLength(1);
    expect(out.entityMentions[0]?.entityLabel).toBe('H.R. 1');
    expect(out.keyQuote?.text).toBe('We must fund this.');
    expect(out.clientRelevanceScore).toBe(0.7);
    expect(out.summaryCard?.cardType).toBe('bill_mention');
  });

  it('degrades to an empty result on a non-200 (graceful degrade preserved)', async () => {
    mockFetch({ ok: false, status: 404, json: null });
    const client = makeClient();
    const out = await client.extract({
      tenantId: 'tenant_1',
      sessionId: 'sess_1',
      authToken: 'jwt_abc',
      segment: { startMs: 0, endMs: 1000, text: 'x' },
      sessionContext: { issueIds: [], billIds: [], programElementIds: [] },
    });
    expect(out).toEqual({ entityMentions: [], issueTags: [] });
  });
});

describe('OrchestratorClient.summarizeHearing — generate_post_hearing_summary contract', () => {
  it('hits /invoke, wraps only schema fields, and reads data.result', async () => {
    const calls = mockFetch({
      ok: true,
      json: {
        tool: 'generate_post_hearing_summary',
        result: {
          executiveSummary: 'The committee debated autonomy funding.',
          tone: 'contentious',
          risks: ['Amendment may strip funding'],
          opportunities: ['Champion identified'],
          recommendedNextSteps: ['Send one-pager'],
          draftClientEmail: { subject: 'Recap', body: 'Hi, here is the recap.' },
        },
      },
    });

    const client = makeClient();
    const out = await client.summarizeHearing({
      tenantId: 'tenant_1',
      sessionId: 'sess_1',
      authToken: 'jwt_abc',
      title: 'HASC Hearing',
      quotes: [{ text: 'fund it', speakerName: 'Rep. Smith', timestampMs: 10 }],
      mentions: [{ type: 'bill', label: 'H.R. 1', ref: null }],
      actionItems: ['follow up'],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/meri-api/tools/generate_post_hearing_summary/invoke`);

    const body = JSON.parse(calls[0]?.init.body as string);
    expect(Object.keys(body)).toEqual(['input']);
    // exactly the tool's 5 schema fields — no tenantId/authToken leakage
    expect(Object.keys(body.input).sort()).toEqual([
      'actionItems',
      'mentions',
      'quotes',
      'sessionId',
      'title',
    ]);
    expect(body.input.authToken).toBeUndefined();
    expect(body.input.tenantId).toBeUndefined();

    expect(out).not.toBeNull();
    expect(out?.executiveSummary).toContain('autonomy');
    expect(out?.risks).toEqual(['Amendment may strip funding']);
    expect(out?.draftClientEmail.subject).toBe('Recap');
  });

  it('returns null on a non-200 (falls back to deterministic assembly)', async () => {
    mockFetch({ ok: false, status: 404, json: null });
    const client = makeClient();
    const out = await client.summarizeHearing({
      tenantId: 'tenant_1',
      sessionId: 'sess_1',
      authToken: 'jwt_abc',
      title: 'HASC Hearing',
      quotes: [],
      mentions: [],
      actionItems: [],
    });
    expect(out).toBeNull();
  });
});
