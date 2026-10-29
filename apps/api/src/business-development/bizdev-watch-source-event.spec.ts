import {
  BizDevWatchSourceEventDelivery, SOURCE_EVENT_BINDING_PATH, SOURCE_EVENT_EVENT_PATH, SOURCE_EVENT_PRODUCER,
  bizDevWatchSourceEvent, createSourceEventSink, createSourceEventTransport, sourceEventFactHash, sourceEventFacts,
  type SourceEventAlertCustody, type SourceEventEnvelope,
} from './bizdev-watch-source-event.js';
import { advancesDeliveryCursor } from './bizdev-watch.types.js';

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
      const next = answers.shift() ?? { status: 200, disposition: 'DISPATCHED', code: null, recorded: 'DISPATCHED' };
      if (next.throw === true) throw new Error('transport down');
      // Meri echoes the received event identity on a 200, so a local answer that means "this event"
      // NAMES it; an answer can override the identity to model a foreign/malformed response.
      return { status: next.status as number, disposition: (next.disposition ?? null) as string | null,
        outcome: (next.outcome ?? null) as string | null, code: (next.code ?? null) as string | null,
        recorded: (next.recorded ?? null) as string | null,
        eventId: Object.hasOwn(next, 'eventId') ? (next.eventId as string | null) : envelope.eventId,
        eventHash: Object.hasOwn(next, 'eventHash') ? (next.eventHash as string | null) : envelope.eventHash };
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
    expect(answer).toEqual({ state: 'DISPATCHED', code: null, attempts: 1, recorded: 'DISPATCHED' });
    expect(calls.map((call) => call.path)).toEqual([SOURCE_EVENT_BINDING_PATH, SOURCE_EVENT_EVENT_PATH]);
    expect(calls[1]!.body).toEqual(bizDevWatchSourceEvent({ custody: CUSTODY, scheduleId: SCHEDULE, generation: 3 }));
  });

  it('never dispatches without an approved binding and never invents a routine generation', async () => {
    const { calls, transport } = localTransport([{ binding: null }]);
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    expect(answer).toEqual({ state: 'SKIPPED', code: 'SOURCE_EVENT_BINDING_ABSENT', attempts: 0, recorded: null });
    expect(calls.map((call) => call.path)).toEqual([SOURCE_EVENT_BINDING_PATH]);
  });

  it('reports Meri\'s own recorded disposition for a replayed event instead of a second effect', async () => {
    const { calls, transport } = localTransport([
      { binding: undefined },
      { status: 200, disposition: 'DEDUPED', outcome: 'DEDUPED', code: null, recorded: 'DISPATCHED' },
    ]);
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    expect(answer).toEqual({ state: 'DEDUPED', code: null, attempts: 1, recorded: 'DISPATCHED' });
    expect(calls[1]!.body).toEqual(calls[1]!.body);
  });

  it('preserves a DEDUPED replay\'s UNKNOWN recorded outcome so the cursor rule can refuse it', async () => {
    const { transport } = localTransport([
      { binding: undefined },
      { status: 200, disposition: 'DEDUPED', outcome: 'DEDUPED', code: null, recorded: 'UNKNOWN' },
    ]);
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    // The disposition stays DEDUPED — never rewritten into a terminal state — and the recorded
    // outcome is carried verbatim so advancesDeliveryCursor() can hold instead of completing.
    expect(answer.state).toBe('DEDUPED');
    expect(answer.recorded).toBe('UNKNOWN');
    expect(advancesDeliveryCursor(answer)).toBe(false);
  });

  it('normalises an unrecognised recorded outcome to null instead of trusting it', async () => {
    const { transport } = localTransport([
      { binding: undefined },
      { status: 200, disposition: 'DEDUPED', outcome: 'DEDUPED', code: null, recorded: 'SETTLED' },
    ]);
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    expect(answer.state).toBe('DEDUPED');
    expect(answer.recorded).toBeNull();
    expect(advancesDeliveryCursor(answer)).toBe(false);
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
    expect(answer).toEqual({ state: 'REFUSED', code: 'SOURCE_EVENT_REFUSED', attempts: 1, recorded: null });
  });
});

describe('bizdev watch source event sink (the evaluator delivery owner)', () => {
  const pairKey = (pair: { tenantId: string; sourceFamily: string; resourceKey: string }) =>
    `${pair.tenantId}|${pair.sourceFamily}|${pair.resourceKey}`;

  /** A local transport whose binding answers per pair and whose event route is recorded. */
  function sinkTransport(
    bindings: Record<string, { scheduleId: string; generation: number } | null>,
    dispositions: Array<string | { disposition: string; recorded?: string | null }> = [],
    bindingFault = false,
  ) {
    const calls: Array<{ path: string; body: { tenantId: string; sourceFamily: string; resourceKey: string } }> = [];
    return {
      calls,
      transport: {
        async binding(pair: { tenantId: string; sourceFamily: string; resourceKey: string }) {
          calls.push({ path: SOURCE_EVENT_BINDING_PATH, body: pair });
          if (bindingFault) throw new Error('binding read unavailable');
          const key = pairKey(pair);
          return Object.hasOwn(bindings, key) ? bindings[key]! : null;
        },
        async event(envelope: SourceEventEnvelope) {
          calls.push({ path: SOURCE_EVENT_EVENT_PATH, body: JSON.parse(JSON.stringify(envelope)) });
          const next = dispositions.shift() ?? 'DISPATCHED';
          const disposition = typeof next === 'string' ? next : next.disposition;
          const recorded = typeof next === 'string' ? null : (next.recorded ?? null);
          // The real listener echoes the identity it received; a local answer may override it.
          const named = typeof next === 'string' ? next : (next as { eventId?: string | null; eventHash?: string | null });
          return { status: 200, disposition, outcome: disposition, code: null, recorded,
            eventId: typeof named === 'string' ? envelope.eventId : (named.eventId ?? envelope.eventId),
            eventHash: typeof named === 'string' ? envelope.eventHash : (named.eventHash ?? envelope.eventHash) };
        },
      },
    };
  }

  it('reads the approved binding once per pair and never calls the event route for an unbound pair', async () => {
    const { calls, transport } = sinkTransport({});
    const sink = createSourceEventSink({ transport: transport as never });
    const counts = await sink([CUSTODY, { ...CUSTODY, alertId: '5d6e7f80-91a2-4b39-8c44-eeff00112233' }]);
    expect(counts).toEqual({ offered: 2, dispatched: 0, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 2 });
    // One bounded binding read for the pair, and ZERO event calls: no routine, no event.
    expect(calls.filter((call) => call.path === SOURCE_EVENT_BINDING_PATH)).toHaveLength(1);
    expect(calls.filter((call) => call.path === SOURCE_EVENT_EVENT_PATH)).toHaveLength(0);
  });

  it('delivers the approved pair only, and a foreign tenant is never covered by another approval', async () => {
    const { calls, transport } = sinkTransport({
      [`tenant-a|federal_award|${WATCH}`]: { scheduleId: SCHEDULE, generation: 3 },
    });
    const sink = createSourceEventSink({ transport: transport as never });
    const counts = await sink([
      CUSTODY,
      { ...CUSTODY, tenantId: 'tenant-b', alertId: '6e7f8091-a2b3-4c4a-9d55-ff0011223344' },
    ]);
    expect(counts).toEqual({ offered: 2, dispatched: 1, queued: 0, deduped: 0, refused: 0, unknown: 0, skipped: 1 });
    const posted = calls.filter((call) => call.path === SOURCE_EVENT_EVENT_PATH);
    expect(posted).toHaveLength(1);
    expect((posted[0]!.body as never as SourceEventEnvelope).tenantId).toBe('tenant-a');
  });

  it('reports Meri-recorded replays as deduped and refusals as refused, never as dispatch', async () => {
    const { transport } = sinkTransport(
      { [`tenant-a|federal_award|${WATCH}`]: { scheduleId: SCHEDULE, generation: 3 } },
      [{ disposition: 'DEDUPED', recorded: 'DISPATCHED' }, { disposition: 'REFUSED', recorded: 'REFUSED' }],
    );
    const sink = createSourceEventSink({ transport: transport as never });
    const counts = await sink([
      CUSTODY,
      { ...CUSTODY, alertId: '7f8091a2-b3c4-4d5b-8e66-001122334455' },
    ]);
    expect(counts.deduped).toBe(1);
    expect(counts.refused).toBe(1);
    expect(counts.dispatched).toBe(0);
  });

  it('holds a DEDUPED replay whose recorded outcome is UNKNOWN as unresolved, never a completed handoff', async () => {
    const { transport } = sinkTransport(
      { [`tenant-a|federal_award|${WATCH}`]: { scheduleId: SCHEDULE, generation: 3 } },
      [{ disposition: 'DEDUPED', recorded: 'UNKNOWN' }],
    );
    const sink = createSourceEventSink({ transport: transport as never });
    const counts = await sink([CUSTODY]);
    expect(counts.deduped).toBe(0);
    expect(counts.unknown).toBe(1);
  });

  it('a 200 that NAMES A FOREIGN event is never evidence about our event: UNKNOWN and the cursor holds', async () => {
    const foreign = { status: 200, disposition: 'DISPATCHED', recorded: 'DISPATCHED',
      eventId: '9f8e7d6c-5b4a-4392-8170-665544332211' };
    // A local transport answers its binding read from the SAME queue, so the pair read comes first and
    // then BOTH bounded delivery attempts receive this same foreign-identity answer.
    const { calls, transport } = localTransport([foreign, foreign, foreign]);
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    expect(answer).toEqual({ state: 'UNKNOWN', code: 'SOURCE_EVENT_RESPONSE_IDENTITY', attempts: 2, recorded: null });
    expect(advancesDeliveryCursor({ state: answer.state, recorded: answer.recorded })).toBe(false);
    // Exactly one bounded delivery per attempt, and the replay resends the SAME envelope bytes.
    const posted = calls.filter((call) => call.path === SOURCE_EVENT_EVENT_PATH);
    expect(posted).toHaveLength(2);
    const sent = posted[0]!.body as SourceEventEnvelope;
    expect(sent.eventId).toBe(ALERT);
    expect(posted[1]!.body).toEqual(sent);
  });

  it("a 200 whose FACT HASH is not the sent envelope's holds as UNKNOWN, never a terminal advance", async () => {
    const stale = { status: 200, disposition: 'DEDUPED', recorded: 'DISPATCHED', eventHash: 'ab'.repeat(32) };
    const { transport } = localTransport([stale, stale, stale]);
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    expect(answer).toEqual({ state: 'UNKNOWN', code: 'SOURCE_EVENT_RESPONSE_IDENTITY', attempts: 2, recorded: null });
    expect(advancesDeliveryCursor({ state: answer.state, recorded: answer.recorded })).toBe(false);
  });

  it('a MALFORMED 200 that names no identity at all holds as UNKNOWN', async () => {
    const nameless = { status: 200, disposition: 'DISPATCHED', recorded: 'DISPATCHED', eventId: null, eventHash: null };
    const { transport } = localTransport([nameless, nameless, nameless]);
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    expect(answer).toEqual({ state: 'UNKNOWN', code: 'SOURCE_EVENT_RESPONSE_IDENTITY', attempts: 2, recorded: null });
  });

  it('the identity the real listener echoes back is accepted verbatim, so the gate never over-tightens', async () => {
    // No overridden identity: the default answer echoes the sent eventId/eventHash exactly as the
    // real receiver does, and must therefore still be read as Meri's own DISPATCHED disposition.
    const { transport } = localTransport();
    const answer = await new BizDevWatchSourceEventDelivery().deliverForAlert(CUSTODY, { transport: transport as never });
    expect(answer).toEqual({ state: 'DISPATCHED', code: null, attempts: 1, recorded: 'DISPATCHED' });
  });

  it('an unanswerable binding read leaves every alert UNKNOWN, never a skip and never a dispatch', async () => {
    const { calls, transport } = sinkTransport({}, [], true);
    const sink = createSourceEventSink({ transport: transport as never });
    const counts = await sink([CUSTODY]);
    expect(counts).toEqual({ offered: 1, dispatched: 0, queued: 0, deduped: 0, refused: 0, unknown: 1, skipped: 0 });
    expect(calls.filter((call) => call.path === SOURCE_EVENT_EVENT_PATH)).toHaveLength(0);
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
