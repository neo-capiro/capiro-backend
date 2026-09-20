import { validateCitationMarkers } from '@capiro/shared';
import {
  HERMES_MAX_CITATIONS_PER_RECALL,
  HERMES_MAX_CITATIONS_PER_RUN,
  hermesCitationsFrame,
  hermesCitationsFromRunEvents,
  translateHermesWireEvent,
} from './meri-hermes-event-translator.js';

const ctx = {
  meriRunId: 'run-1',
  now: () => new Date('2026-09-19T12:00:00Z'),
  approvalTimeoutSeconds: 300,
};

describe('translateHermesWireEvent', () => {
  test('streams text deltas and accumulates them', () => {
    const t = translateHermesWireEvent({ event: 'message.delta', delta: 'Hello' }, ctx);
    expect(t.textDelta).toBe('Hello');
    expect(t.frames).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(t.event?.kind).toBe('message.delta');
  });

  test('maps tool lifecycle to tool_call/sources the web client already resolves', () => {
    const started = translateHermesWireEvent(
      { event: 'tool.started', tool: 'read_file', preview: '{"path":"x"}' },
      ctx,
    );
    expect(started.frames[0]).toEqual({ type: 'tool_call', tool: 'read_file', label: 'read file' });
    const done = translateHermesWireEvent(
      { event: 'tool.completed', tool: 'read_file', duration: 0.4, error: false },
      ctx,
    );
    expect(done.frames[0]).toMatchObject({
      type: 'sources',
      sources: [{ tool: 'read_file', confidence: 'high' }],
    });
    const failed = translateHermesWireEvent(
      { event: 'tool.completed', tool: 'terminal', duration: 1, error: true },
      ctx,
    );
    expect(failed.frames[0]).toMatchObject({ sources: [{ confidence: 'low' }] });
  });

  test('never forwards private reasoning', () => {
    const t = translateHermesWireEvent(
      { event: 'reasoning.available', text: 'secret chain of thought' },
      ctx,
    );
    expect(t.frames).toEqual([]);
    expect(t.event).toBeNull();
    expect(JSON.stringify(t)).not.toContain('secret chain');
  });

  test('native approval becomes a pending interaction with a live-process continuation', () => {
    const t = translateHermesWireEvent(
      {
        event: 'approval.request',
        request_id: 'req-9',
        command: 'rm -rf ./fixture',
        description: 'Dangerous command',
        choices: ['once', 'deny'],
      },
      ctx,
    );
    expect(t.status).toBe('waiting_for_approval');
    expect(t.pendingInteraction).toEqual({
      requestId: 'req-9',
      prompt: 'Dangerous command\n\nrm -rf ./fixture',
      choices: ['once', 'deny'],
      expiresAt: '2026-09-19T12:05:00.000Z',
    });
    expect(t.frames[0]).toMatchObject({
      type: 'pending_approval',
      runtime: 'hermes',
      proposalId: 'hermes:run-1:req-9',
      interaction: { requestId: 'req-9', continuation: 'live_process' },
    });
  });

  test('terminal frames carry finish reason, partiality and usage', () => {
    const done = translateHermesWireEvent(
      {
        event: 'run.completed',
        output: 'final',
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      ctx,
    );
    expect(done.status).toBe('completed');
    expect(done.terminal).toEqual({
      finishReason: 'stop',
      partial: false,
      output: 'final',
      error: null,
    });
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: null });
    expect(done.frames[0]).toMatchObject({ type: 'usage' });
    const failed = translateHermesWireEvent({ event: 'run.failed', error: 'boom' }, ctx);
    expect(failed.terminal).toMatchObject({ finishReason: 'error', partial: true, error: 'boom' });
    expect(failed.frames[0]).toEqual({ type: 'error', message: 'boom' });
    expect(translateHermesWireEvent({ event: 'run.cancelled' }, ctx).terminal?.finishReason).toBe(
      'aborted',
    );
    expect(translateHermesWireEvent({ event: 'run.interrupted' }, ctx).status).toBe('interrupted');
  });

  test('unknown frames are logged internally and never shown as progress', () => {
    const t = translateHermesWireEvent({ event: 'something.new', foo: 1 }, ctx);
    expect(t.frames).toEqual([]);
    expect(t.event).toEqual({
      kind: 'run.status',
      visibility: 'internal',
      payload: { unknownWireEvent: 'something.new' },
    });
  });
});

/**
 * A8 — record-level citations from governed recall.
 *
 * Pure-translation coverage. The end-to-end proof (a REAL governed recall
 * against real Postgres, through the REAL broker, persisted on a REAL assistant
 * message by the REAL adapter) is meri-hermes-citations.integration.spec.ts;
 * these tests pin the contract and the no-fabrication rules.
 */
describe('hermesCitationsFromRunEvents (A8)', () => {
  const recallEvent = (items: unknown[], extra: Record<string, unknown> = {}) => ({
    kind: 'memory.recalled',
    payload: {
      path: 'context_plane',
      returned: items.length,
      coverage: { requested: 8, returned: items.length, total: items.length, sourceStatus: 'healthy', complete: true, detail: null },
      frames: [],
      items,
      ...extra,
    },
  });

  const item = (over: Record<string, unknown> = {}) => ({
    sourceId: '11111111-1111-4111-8111-111111111111',
    domain: 'institutional_knowledge',
    title: 'Firm diligence checklist',
    scope: 'firm',
    clientId: null,
    excerpt: 'Firm diligence checklist: confirm the conflict check before any filing.',
    updatedAt: '2026-09-18T10:00:00.000Z',
    provenance: { source: 'manual', sourceType: 'manual' },
    ...over,
  });

  test('a governed recall becomes the SAME MeriCitation contract the V3 path persists', () => {
    const citations = hermesCitationsFromRunEvents([recallEvent([item()])]);
    expect(citations).toEqual([
      {
        n: 1,
        type: 'memory',
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Firm diligence checklist',
        url: null,
        snippet: 'Firm diligence checklist: confirm the conflict check before any filing.',
        tool: 'meri_memory_search',
        source: {
          kind: 'memory',
          recordId: '11111111-1111-4111-8111-111111111111',
          observedAt: '2026-09-18T10:00:00.000Z',
        },
      },
    ]);
    // Contract interop: the citation the Hermes path produces is consumable by
    // the SAME shared helper the V3 loop validates its markers with, so a
    // future worker-side citable-sources block needs no second contract.
    const validated = validateCitationMarkers('The checklist [1] applies.', citations);
    expect(validated.used.map((c) => c.id)).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(validated.dropped).toEqual([]);
  });

  test('a client-scoped record carries its clientId into the source locator', () => {
    const [citation] = hermesCitationsFromRunEvents([
      recallEvent([item({ scope: 'client', clientId: '22222222-2222-4222-8222-222222222222' })]),
    ]);
    expect(citation!.source).toEqual({
      kind: 'memory',
      recordId: '11111111-1111-4111-8111-111111111111',
      clientId: '22222222-2222-4222-8222-222222222222',
      observedAt: '2026-09-18T10:00:00.000Z',
    });
  });

  test('a run with NO retrieval yields no citations and no frame', () => {
    const events = [
      { kind: 'tool.started', payload: { tool: 'meri_whoami', frames: [] } },
      { kind: 'tool.completed', payload: { tool: 'meri_whoami', durationSeconds: 0.2, error: false, frames: [] } },
      { kind: 'message.delta', payload: { delta: 'Here is the answer.' } },
      { kind: 'run.completed', payload: { outputChars: 19 } },
    ];
    expect(hermesCitationsFromRunEvents(events)).toEqual([]);
    expect(hermesCitationsFrame(hermesCitationsFromRunEvents(events))).toBeNull();
  });

  test('a recall that returned NOTHING is never dressed up as a source', () => {
    // Empty items, an absent items key (a pre-A8 event), a non-array, and a
    // coverage row that claims matches exist but released none: all zero.
    expect(hermesCitationsFromRunEvents([recallEvent([])])).toEqual([]);
    expect(
      hermesCitationsFromRunEvents([
        { kind: 'memory.recalled', payload: { path: 'context_plane', returned: 0, coverage: { total: 12 }, frames: [] } },
      ]),
    ).toEqual([]);
    expect(
      hermesCitationsFromRunEvents([{ kind: 'memory.recalled', payload: { items: 'not-an-array', frames: [] } }]),
    ).toEqual([]);
  });

  test('an item with no real record id is dropped rather than given a placeholder', () => {
    const citations = hermesCitationsFromRunEvents([
      recallEvent([item({ sourceId: '' }), item({ sourceId: null }), { title: 'no id at all' }, null, 'string', item()]),
    ]);
    expect(citations).toHaveLength(1);
    expect(citations[0]!.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(citations[0]!.n).toBe(1);
  });

  test('a malformed item keeps its record id as the title instead of inventing prose for it', () => {
    const [citation] = hermesCitationsFromRunEvents([
      recallEvent([item({ title: '   ', excerpt: '  ' })]),
    ]);
    expect(citation!.title).toBe('11111111-1111-4111-8111-111111111111');
    expect(citation!.snippet).toBeNull();
    expect(citation!.url).toBeNull();
  });

  test('numbering is global across recalls and a repeated record is cited once', () => {
    const a = item({ sourceId: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'A' });
    const b = item({ sourceId: 'bbbbbbbb-0000-4000-8000-000000000002', title: 'B' });
    const citations = hermesCitationsFromRunEvents([
      recallEvent([a, b]),
      { kind: 'tool.completed', payload: { tool: 'meri_memory_search', frames: [] } },
      recallEvent([b, a]), // the same two records recalled again by a second tool call
    ]);
    expect(citations.map((c) => [c.n, c.title])).toEqual([
      [1, 'A'],
      [2, 'B'],
    ]);
  });

  test('long excerpts and titles are truncated, not dropped', () => {
    const [citation] = hermesCitationsFromRunEvents([
      recallEvent([item({ title: 'T'.repeat(400), excerpt: 'E'.repeat(900) })]),
    ]);
    expect(citation!.title).toHaveLength(201); // 200 + the ellipsis
    expect(citation!.snippet).toHaveLength(241);
    expect(citation!.snippet!.endsWith('…')).toBe(true);
  });

  test('citations are bounded per recall and per run', () => {
    const many = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) =>
        item({ sourceId: `${prefix}-0000-4000-8000-${String(i).padStart(12, '0')}`, title: `${prefix}-${i}` }),
      );
    expect(hermesCitationsFromRunEvents([recallEvent(many('cccccccc', 40))])).toHaveLength(
      HERMES_MAX_CITATIONS_PER_RECALL,
    );
    const manyRecalls = Array.from({ length: 12 }, (_, r) => recallEvent(many(`dddddd${String(r).padStart(2, '0')}`, 5)));
    expect(hermesCitationsFromRunEvents(manyRecalls)).toHaveLength(HERMES_MAX_CITATIONS_PER_RUN);
  });

  test('tool-progress trust steps are NOT citations, and the sources frame they emit is untouched', () => {
    // A8 adds a second, different signal. The `tool.completed -> {type:'sources'}`
    // trust step answers "which tool ran"; it must keep working and must never
    // be promoted into a record-level citation.
    const completed = translateHermesWireEvent(
      { event: 'tool.completed', tool: 'meri_memory_search', duration: 0.6, error: false },
      ctx,
    );
    expect(completed.frames[0]).toEqual({
      type: 'sources',
      sources: [
        { tool: 'meri_memory_search', label: 'meri memory search', count: null, summary: 'Completed in 0.6s.', confidence: 'high' },
      ],
    });
    expect(hermesCitationsFromRunEvents([{ kind: completed.event!.kind, payload: completed.event!.payload }])).toEqual([]);
  });
});

describe('hermesCitationsFrame (A8)', () => {
  test('is the frame the existing web client already consumes', () => {
    const citations = hermesCitationsFromRunEvents([
      {
        kind: 'memory.recalled',
        payload: { items: [{ sourceId: 'eeeeeeee-0000-4000-8000-000000000003', title: 'E' }], frames: [] },
      },
    ]);
    expect(hermesCitationsFrame(citations)).toEqual({ type: 'citations', citations });
  });

  test('is null when there is nothing to cite, so an empty frame never clears rendered sources', () => {
    expect(hermesCitationsFrame([])).toBeNull();
  });
});
