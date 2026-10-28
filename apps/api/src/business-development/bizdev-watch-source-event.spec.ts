import {
  BizDevWatchSourceEventDelivery, SOURCE_EVENT_BINDING_PATH, SOURCE_EVENT_EVENT_PATH, SOURCE_EVENT_PRODUCER,
  bizDevWatchSourceEvent, createSourceEventTransport, sourceEventFactHash, sourceEventFacts,
  type SourceEventAlertCustody, type SourceEventEnvelope,
} from './bizdev-watch-source-event.js';

const ALERT = '1f2e3d4c-5b6a-4798-8899-aabbccddeeff';
const WATCH = '2a3b4c5d-6e7f-4808-9911-bbccddeeff00';
const PROSPECT = '3b4c5d6e-7f80-4918-8a22-ccddeeff0011';
const SCHEDULE = '4c5d6e7f-8091-4a28-9b33-ddeeff001122';
const CUSTODY: SourceEventAlertCustody = {
  tenantId: 'tenant-a', alertId: ALERT, watchId: WATCH, prospectId: PROSPECT,
  dedupeKey: 'federal_award:rec-1:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  fingerprint: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  sourceFamily: 'federal_award', recordId: 'rec-1', sourceRevision: 'rev-7', occurredAtMs: Date.parse('2026-10-15T12:00:00.000Z'),
};

/** A task-owned local transport: it records the exact bytes and answers like the real listener. */
function localTransport(answers: Array<Record<string, unknown>> = []) {
  const calls: Array<{ path: string; body: unknown; headers: Record<string, string> }> = [];
  const transport = {
    async binding(pair: { tenantId: string; sourceFamily: string; resourceKey: string }) {
      calls.push({ path: SOURCE_EVENT_BINDING_PATH, body: pair, headers: {} });
      const next = answers.shift();
      if (!next) return { scheduleId: SCHEDULE, generation: 3 };
      if (next.binding === undefined) return { scheduleId: SCHEDULE, generation: 3 };
      return next.binding as { scheduleId: string; generation: number } | null;
    },
    async event(envelope: SourceEventEnvelope, signal?: AbortSignal) {
      void signal;
      calls.push({ path: SOURCE_EVENT_EVENT_PATH, body: JSON.parse(JSON.stringify(envelope)), headers: {} });
      const next = answers.shift() ?? { status: 200, disposition: 'DISPATCHED', code: null };
      if (next.throw === true) throw new Error('transport down');
      return { status: next.status as number, disposition: (next.disposition ?? null) as string | null,
        outcome: (next.outcome ?? null) as string | null, code: (next.code ?? null) as string | null };
    },
  };
  return { calls, transport };
}

describe('bizdev watch source event codec', () => {
  it('emits the one closed canonical envelope and derives its own hash', () => {
    const event = bizDevWatchSourceEvent({ custody: CUSTODY, scheduleId: SCHEDULE, generation: 3 });
    expect(Object.keys(event).sort()).toEqual(
      ['alert', 'eventHash', 'eventId', 'occurredAt', 'producer', 'routine', 'schemaVersion', 'source', 'tenantId']);
    expect(Object.keys(event.alert).sort()).toEqual(['alertId', 'dedupeKey', 'fingerprint', 'prospectId', 'watchId']);
    expect(Object.keys(event.source).sort()).toEqual(['recordId', 'sourceFamily', 'sourceRevision']);
    expect(event.producer).toBe(SOURCE_EVENT_PRODUCER);
    expect(event.occurredAt).toBe('2026-10-15T12:00:00.000Z');
    expect(event.eventHash).toMatch(/^[a-f0-9]{64}$/);
    expect(event.eventHash).toBe(sourceEventFactHash(sourceEventFacts({ tenantId: event.tenantId, alert: event.alert, source: event.source })));
    // No prompt, scope grant, destination selector, budget, limit or run identifier exists here.
    for (const forbidden of ['prompt', 'instruction', 'scopes', 'grant', 'destination', 'budget', 'limits', 'runId', 'workflowId'])
      expect(JSON.stringify(event)).not.toContain(`"${forbidden}"`);
  });

  it('is immutable and replayable: the identity is the immutable alert id and the bytes are stable', () => {
    const first = bizDevWatchSourceEvent({ custody: CUSTODY, scheduleId: SCHEDULE, generation: 3 });
    const replay = bizDevWatchSourceEvent({ custody: { ...CUSTODY }, scheduleId: SCHEDULE, generation: 3 });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(first.eventId).toBe(ALERT);
    // The claimed routine pins are the only server-selected part; an invented generation is refused.
    expect(() => bizDevWatchSourceEvent({ custody: CUSTODY, scheduleId: SCHEDULE, generation: 0 })).toThrow();
    expect(() => bizDevWatchSourceEvent({ custody: { ...CUSTODY, fingerprint: 'not-a-digest' }, scheduleId: SCHEDULE, generation: 1 })).toThrow();
  });
});

describe('bizdev watch source event delivery', () => {
  it('reads the approved binding and delivers the exact event over the fixed private route', async () => {
    const { calls, transport } = localTransport();
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    expect(answer).toEqual({ state: 'DISPATCHED', code: null, attempts: 1 });
    expect(calls.map((call) => call.path)).toEqual([SOURCE_EVENT_BINDING_PATH, SOURCE_EVENT_EVENT_PATH]);
    expect(calls[1]!.body).toEqual(bizDevWatchSourceEvent({ custody: CUSTODY, scheduleId: SCHEDULE, generation: 3 }));
  });

  it('never dispatches without an approved binding and never invents a routine generation', async () => {
    const { calls, transport } = localTransport([{ binding: null }]);
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    expect(answer).toEqual({ state: 'SKIPPED', code: 'SOURCE_EVENT_BINDING_ABSENT', attempts: 0 });
    expect(calls.map((call) => call.path)).toEqual([SOURCE_EVENT_BINDING_PATH]);
  });

  it('reports Meri\'s own recorded disposition for a replayed event instead of a second effect', async () => {
    const { calls, transport } = localTransport([
      { binding: undefined },
      { status: 200, disposition: 'DEDUPED', outcome: 'DEDUPED', code: null },
    ]);
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    expect(answer).toEqual({ state: 'DEDUPED', code: null, attempts: 1 });
    expect(calls[1]!.body).toEqual(calls[1]!.body);
  });

  it('replays the identical bytes once on a lost acknowledgement and stays UNKNOWN, never success', async () => {
    const { calls, transport } = localTransport([
      { binding: undefined },
      { status: 503, disposition: null, outcome: 'UNKNOWN', code: 'SOURCE_EVENT_UNAVAILABLE' },
      { throw: true },
    ]);
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    expect(answer.state).toBe('UNKNOWN');
    expect(answer.attempts).toBe(2);
    const posted = calls.filter((call) => call.path === SOURCE_EVENT_EVENT_PATH);
    expect(posted).toHaveLength(2);
    expect(JSON.stringify(posted[0]!.body)).toBe(JSON.stringify(posted[1]!.body));
  });

  it('reports a refusal as Meri\'s refusal and never as a delivery', async () => {
    const { transport } = localTransport([
      { binding: undefined },
      { status: 403, disposition: null, outcome: 'NOT_DISPATCHED', code: 'SOURCE_EVENT_REFUSED' },
    ]);
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    expect(answer).toEqual({ state: 'REFUSED', code: 'SOURCE_EVENT_REFUSED', attempts: 1 });
  });
});

describe('source event transport configuration', () => {
  it('refuses a non-https, credential-bearing, path-bearing or secret-less origin', () => {
    const attempt = (origin: string, secret?: string) => () => createSourceEventTransport({ origin, secret, fetchImpl: (async () => new Response('{}')) as never });
    expect(attempt('http://meri.control.test', 's')).toThrow();
    expect(attempt('https://user:pass@meri.control.test', 's')).toThrow();
    expect(attempt('https://meri.control.test/prefix', 's')).toThrow();
    expect(attempt('https://meri.control.test?x=1', 's')).toThrow();
    expect(attempt('https://meri.control.test', '')).toThrow();
    expect(attempt('https://meri.control.test', 'bad\nsecret')).toThrow();
    expect(() => createSourceEventTransport({ origin: 'https://meri.control.test', secret: 's' })).not.toThrow();
  });

  it('sends the shared service secret and never a bearer, and treats a failed read as UNAVAILABLE', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ outcome: 'BINDING_READ', binding: null }), { status: 200 });
    }) as never;
    const transport = createSourceEventTransport({ origin: 'https://meri.control.test', secret: 'task-owned-secret', fetchImpl });
    expect(await transport.binding({ tenantId: 'tenant-a', sourceFamily: 'federal_award', resourceKey: WATCH })).toBeNull();
    expect(seen[0]!.url).toBe('https://meri.control.test' + SOURCE_EVENT_BINDING_PATH);
    expect(seen[0]!.method).toBe('POST');
    expect((seen[0]!.headers as Record<string, string>)['x-internal-service-secret']).toBe('task-owned-secret');
    expect(JSON.stringify(seen[0]!.headers)).not.toContain('authorization');
    const failing = createSourceEventTransport({ origin: 'https://meri.control.test', secret: 'task-owned-secret',
      fetchImpl: (async () => new Response('nope', { status: 503 })) as never });
    await expect(failing.binding({ tenantId: 'tenant-a', sourceFamily: 'federal_award', resourceKey: WATCH })).rejects.toThrow();
  });
});
