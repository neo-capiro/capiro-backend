// WS-22 native conversation client spec — the workspace document-agent's ONLY
// production caller of the five supported generated phases.
//
// No network, model or database is touched here: every call goes through the
// client's own `fetchImpl` seam, and `globalThis.fetch` is stubbed to throw so
// an accidental live call fails loudly instead of silently reaching out. There
// is no fallback path to the retired `WorkspaceReasoningGateway` /
// `GenerationService` seam to exercise.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  NativeGenerationConversationClient,
  NativeGenerationOwnerError,
  nativeGenerationOrigin,
} from './native-generation-conversation.client.js';
import type {
  NativeGenerationTurnRequest,
  NativeGenerationTurnSubject,
} from './native-generation.bridge.js';

const ORIGIN = 'https://control.internal.example';
const SECRET = 's'.repeat(32);

const subject = (over: Partial<NativeGenerationTurnSubject> = {}): NativeGenerationTurnSubject => ({
  requestId: 'req-1',
  tenantId: 'tenant-a',
  actorId: 'user_2abc',
  draftId: 'draft-9',
  clientId: 'client-4',
  ...over,
});

const turnRequest = (over: Partial<NativeGenerationTurnRequest> = {}): NativeGenerationTurnRequest => ({
  ...subject(),
  phase: 'brief',
  expectedRevision: 7,
  paidGeneration: true,
  sources: [{ id: 'draft-9', kind: 'workspace-draft' }],
  ...over,
});

type Reply = { ok: boolean; status: number; text: () => Promise<string> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});
const body = (payload: Record<string, unknown>): Reply => reply(200, { schemaVersion: 1, ...payload });
const raw = (status: number, text: string): Reply => ({ ok: status >= 200 && status < 300, status, text: async () => text });

type Call = { url: string; method: string; headers: Record<string, string>; body: string; redirect?: string };

function harness(respond: () => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const fetchImpl = jest.fn(async (url: unknown, init: unknown) => {
    const i = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string; redirect?: string };
    calls.push({
      url: String(url),
      method: i.method ?? '',
      headers: i.headers ?? {},
      body: i.body ?? '',
      ...(i.redirect === undefined ? {} : { redirect: i.redirect }),
    });
    return respond();
  });
  const client = new NativeGenerationConversationClient({
    origin: ORIGIN,
    serviceSecret: SECRET,
    timeoutMs: 50,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { calls, client, fetchImpl };
}

const json = (call: Call): { schemaVersion: number; request: Record<string, unknown> } =>
  JSON.parse(call.body) as { schemaVersion: number; request: Record<string, unknown> };

const nativeFetch = (globalThis as { fetch?: unknown }).fetch;
let liveFetchCalls = 0;

beforeEach(() => {
  liveFetchCalls = 0;
  (globalThis as { fetch?: unknown }).fetch = () => {
    liveFetchCalls += 1;
    throw new Error('the WS22 client must never reach the ambient global fetch in these tests');
  };
});

afterEach(() => {
  (globalThis as { fetch?: unknown }).fetch = nativeFetch;
});

describe('native conversation origin and secret admission', () => {
  it('accepts a bare https origin and loopback http, and refuses anything else', () => {
    expect(nativeGenerationOrigin('https://control.internal.example').origin).toBe('https://control.internal.example');
    expect(nativeGenerationOrigin('http://127.0.0.1:8080/').port).toBe('8080');
    expect(() => nativeGenerationOrigin('http://control.internal.example')).toThrow(/https/);
    expect(() => nativeGenerationOrigin('https://control.internal.example/v1')).toThrow(/bare origin/);
    expect(() => nativeGenerationOrigin('https://user:pw@control.internal.example')).toThrow(/bare origin/);
    expect(() => nativeGenerationOrigin('https://control.internal.example/?a=1')).toThrow(/bare origin/);
  });

  it('refuses a service secret that is missing or too short', () => {
    expect(
      () => new NativeGenerationConversationClient({ origin: ORIGIN, serviceSecret: 'short' }),
    ).toThrow(/service secret/);
    expect(liveFetchCalls).toBe(0);
  });
});

describe('native conversation turn', () => {
  it('posts one closed turn body with the session credential and the service secret', async () => {
    const h = harness(() => body({ outcome: { status: 'complete', runId: 'run-1', result: { brief: { assumptions: [], provenance: {} } } } }));
    const outcome = await h.client.turn(turnRequest(), { credential: 'session-credential' });

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.url).toBe(`${ORIGIN}/v1/internal/workspace-generation/turn`);
    expect(call.method).toBe('POST');
    expect(call.redirect).toBe('error');
    expect(call.headers.authorization).toBe('Bearer session-credential');
    expect(call.headers['x-internal-service-secret']).toBe(SECRET);

    const sent = json(call);
    expect(sent.schemaVersion).toBe(1);
    // The exact turn body: identity and pins only. No authority is derived
    // here, no document text travels, and the paid intent is the closed body
    // flag — never a borrowed idempotency header or body key.
    expect(sent.request).toEqual({
      requestId: 'req-1',
      tenantId: 'tenant-a',
      actorId: 'user_2abc',
      draftId: 'draft-9',
      clientId: 'client-4',
      phase: 'brief',
      expectedRevision: 7,
      paidGeneration: true,
      sources: [{ id: 'draft-9', kind: 'workspace-draft' }],
    });
    expect(Object.keys(call.headers)).not.toContain('idempotency-key');
    expect(call.body).not.toContain('session-credential');
    expect(outcome).toEqual({ status: 'complete', runId: 'run-1', result: { brief: { assumptions: [], provenance: {} } } });
    expect(liveFetchCalls).toBe(0);
  });

  it('refuses before any transport call when the session credential is missing', async () => {
    const h = harness(() => body({ outcome: { status: 'unknown', requestId: 'req-1' } }));
    await expect(h.client.turn(turnRequest(), { credential: '' })).rejects.toMatchObject({
      code: 'refused',
      status: 400,
    });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(liveFetchCalls).toBe(0);
  });

  it('maps every terminal outcome the owner can report', async () => {
    const cases: [Record<string, unknown>, unknown][] = [
      [{ status: 'complete', runId: 'run-2', result: { context: { includedItemIds: [], excludedItems: [], conflicts: [], coverage: { plannedClaims: 0, supportedClaims: 0, missingClaims: [] } } } }, { status: 'complete', runId: 'run-2' }],
      [{ status: 'approval_required', runId: 'run-3', proposalId: 'prop-3' }, { status: 'approval_required', runId: 'run-3', proposalId: 'prop-3' }],
      [{ status: 'failed', runId: 'run-4', state: 'deadline' }, { status: 'failed', runId: 'run-4', state: 'deadline' }],
      [{ status: 'unknown', requestId: 'other-id' }, { status: 'unknown', requestId: 'other-id' }],
    ];
    for (const [outcome, expected] of cases) {
      const h = harness(() => body({ outcome }));
      expect(await h.client.turn(turnRequest(), { credential: 'c' })).toMatchObject(expected as never);
    }
  });

  it('refuses an outcome the owner never defined instead of inventing one', async () => {
    const h = harness(() => body({ outcome: { status: 'not-a-status' } }));
    await expect(h.client.turn(turnRequest(), { credential: 'c' })).rejects.toMatchObject({
      code: 'unavailable',
      status: 502,
    });
  });
});

describe('native conversation read and cancel', () => {
  it('reports a read with no retained outcome as null, and an unknown one by the retained request id', async () => {
    const absent = harness(() => body({ outcome: null }));
    expect(await absent.client.readTurn(turnRequest(), 'c')).toBeNull();
    expect(absent.calls[0]!.url).toBe(`${ORIGIN}/v1/internal/workspace-generation/read`);

    // A well-formed unknown outcome is reported by the id the OWNER named.
    const unknown = harness(() => body({ outcome: { status: 'unknown', requestId: 'ws-held-9' } }));
    expect(await unknown.client.readTurn(turnRequest({ requestId: 'req-9' }), 'c')).toEqual({
      status: 'unknown',
      requestId: 'ws-held-9',
    });
  });

  // The response body is unvalidated wire input on BOTH paths: an outcome that
  // does not close is malformed (502), never cast into a typed outcome.
  const malformedOutcomes: Array<[string, unknown]> = [
    ['a complete outcome without a runId', { status: 'complete', result: {} }],
    ['a status the owner never defined', { status: 'document_decoded', runId: 'run-6' }],
    ['an unknown outcome without a requestId', { status: 'unknown' }],
    ['an approval_required outcome without a proposalId', { status: 'approval_required', runId: 'run-7' }],
    ['a complete outcome whose result is not an object', { status: 'complete', runId: 'run-8', result: 'text' }],
    ['a failed outcome without a state', { status: 'failed', runId: 'run-9' }],
    ['a non-object outcome', 'not-an-outcome'],
    ['an array outcome', [{ status: 'complete', runId: 'run-10', result: {} }]],
  ];

  it.each(malformedOutcomes)(
    'rejects %s on the turn AND the read instead of casting it',
    async (_label, outcome) => {
      const onTurn = harness(() => body({ outcome }));
      await expect(onTurn.client.turn(turnRequest(), { credential: 'c' })).rejects.toMatchObject({
        code: 'unavailable',
        status: 502,
      });

      const onRead = harness(() => body({ outcome }));
      await expect(onRead.client.readTurn(turnRequest(), 'c')).rejects.toMatchObject({
        code: 'unavailable',
        status: 502,
      });
    },
  );

  it('addresses cancel by the exact retained identity', async () => {
    const h = harness(() => body({ state: 'cancelled' }));
    await h.client.cancel({ ...subject(), runId: 'run-7' }, 'c');
    expect(h.calls[0]!.url).toBe(`${ORIGIN}/v1/internal/workspace-generation/cancel`);
    expect(json(h.calls[0]!).request).toEqual({
      requestId: 'req-1',
      tenantId: 'tenant-a',
      actorId: 'user_2abc',
      draftId: 'draft-9',
      clientId: 'client-4',
      runId: 'run-7',
    });
  });

  it('refuses a cancel answer without a state instead of reporting success', async () => {
    const h = harness(() => body({}));
    await expect(h.client.cancel(subject(), 'c')).rejects.toMatchObject({ code: 'unavailable', status: 502 });
  });
});

describe('native conversation transport failures', () => {
  it('maps the owner refusal codes to stable adapter codes, and an unknown code to unavailable', async () => {
    const cases: [string, string][] = [
      ['WORKSPACE_GENERATION_UNAVAILABLE', 'unavailable'],
      ['WORKSPACE_GENERATION_REFUSED', 'refused'],
      ['WORKSPACE_GENERATION_AUTHORITY_REFUSED', 'authority'],
      ['WORKSPACE_GENERATION_SCOPE_REFUSED', 'authority'],
      ['WORKSPACE_GENERATION_REQUEST_REFUSED', 'conflict'],
      ['WORKSPACE_GENERATION_OUTPUT_REFUSED', 'output'],
      ['WORKSPACE_GENERATION_UNKNOWN', 'unavailable'],
      ['WORKSPACE_GENERATION_DEADLINE', 'unavailable'],
      ['SOMETHING_NEW', 'unavailable'],
    ];
    for (const [ownerCode, adapterCode] of cases) {
      const h = harness(() => reply(403, { schemaVersion: 1, error: { code: ownerCode } }));
      await expect(h.client.turn(turnRequest(), { credential: 'c' })).rejects.toMatchObject({
        code: adapterCode,
        status: 403,
      });
    }
  });

  it('treats a drifted schema, a non-JSON body and an oversized body as unavailable', async () => {
    const drifted = harness(() => reply(200, { schemaVersion: 2, outcome: { status: 'unknown', requestId: 'req-1' } }));
    await expect(drifted.client.turn(turnRequest(), { credential: 'c' })).rejects.toMatchObject({ code: 'unavailable', status: 502 });

    const notJson = harness(() => raw(200, '<html>proxy</html>'));
    await expect(notJson.client.turn(turnRequest(), { credential: 'c' })).rejects.toMatchObject({ code: 'unavailable', status: 502 });

    const oversized = harness(() => raw(200, JSON.stringify({ schemaVersion: 1, padding: 'x'.repeat(1_048_577) })));
    await expect(oversized.client.turn(turnRequest(), { credential: 'c' })).rejects.toMatchObject({ code: 'unavailable', status: 502 });
  });

  it('reports a transport failure as unavailable without leaking the failure text to the caller', async () => {
    const h = harness(() => {
      throw new Error(`connect ECONNREFUSED ${ORIGIN}`);
    });
    const error = await h.client.turn(turnRequest(), { credential: 'c' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NativeGenerationOwnerError);
    expect((error as NativeGenerationOwnerError).code).toBe('unavailable');
    expect((error as NativeGenerationOwnerError).status).toBe(503);
    expect((error as Error).message).toBe('The native conversation owner is unreachable.');
    expect((error as Error).message).not.toContain('ECONNREFUSED');
    expect(liveFetchCalls).toBe(0);
  });
});
