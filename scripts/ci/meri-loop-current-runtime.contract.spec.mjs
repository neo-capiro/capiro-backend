import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Actual current proxy and progress helper, with a finite set of fake ports.
// The decorated raw/V3 services and Nest graph are source data only. These
// controls do not qualify native DI, Context Plane/ALS, credentials, provider
// execution, DB persistence, attachment authorization or application typing.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
const MERI = 'apps/api/src/meri/';
const proxySource = read(MERI + 'meriv3-runtime.proxy.ts');
const progressSource = read(MERI + 'meri-turn-progress.ts');
const contractSource = read(MERI + 'meri-runtime.contract.ts');
const aiSource = read(MERI + 'meri-chat-ai.types.ts');
const clientSource = read(MERI + 'meriv3-chat.client.ts');
const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');

const portsUrl = dataUrl(`
export const state = { governed: null, timers: new Map(), listener: null, next: 0, observations: 0 };
export const currentMeriGovernedRuntime = () => state.governed;
export const randomUUID = () => 'fixture-run-' + (++state.next);
const timer = (kind, callback, delay) => {
  const id = ++state.next; state.timers.set(id, { kind, callback, delay }); return id;
};
export const setTimeout = (callback, delay) => timer('timeout', callback, delay);
export const setInterval = (callback, delay) => timer('interval', callback, delay);
export const clearTimeout = id => state.timers.delete(id);
export const clearInterval = id => state.timers.delete(id);
export const contextStageTimer = {
  async observe(listener, execute) {
    state.observations++; const previous = state.listener; state.listener = listener;
    try { return await execute(); } finally { state.listener = previous; }
  },
};
`);

/** Reject any new runtime dependency until it is explicitly reviewed here. */
function bindImports(javascript, bindings) {
  assert.doesNotMatch(javascript, /\b(?:require|import)\s*\(/, 'no dynamic/require port');
  const pattern = /^import\s+([\s\S]*?)\s+from\s*(['"])([^'"]+)\2\s*;?/gm;
  const rows = [...javascript.matchAll(pattern)];
  assert.equal((javascript.match(/^import\b/gm) ?? []).length, rows.length, 'named from-imports only');
  assert.equal(rows.length, bindings.size, 'complete finite import ownership');
  const seen = new Set();
  for (const [, clause, , specifier] of rows) {
    assert(bindings.has(specifier), 'unowned import: ' + specifier);
    assert(!seen.has(specifier), 'duplicate import owner'); seen.add(specifier);
    assert(clause.trim().startsWith('{') && clause.trim().endsWith('}'), 'named imports only');
    const names = clause.trim().slice(1, -1).split(',').map(name => name.trim()).filter(Boolean);
    assert.deepEqual(names.sort(), [...bindings.get(specifier).names].sort(), 'exact imported names: ' + specifier);
  }
  return javascript.replace(pattern, (_match, clause, _quote, specifier) =>
    `import ${clause} from ${JSON.stringify(bindings.get(specifier).url)};`);
}
function isolatedUrl(source, bindings, prefix = '') {
  return dataUrl(prefix + bindImports(stripTypeScriptTypes(source, { mode: 'strip' }), bindings));
}
const progressUrl = isolatedUrl(progressSource, new Map([
  ['node:crypto', { names: ['randomUUID'], url: portsUrl }],
  ['../context/context-stage-timer.service.js', { names: ['contextStageTimer'], url: portsUrl }],
]), `import { setTimeout, setInterval, clearTimeout, clearInterval } from ${JSON.stringify(portsUrl)};\n`);
const proxyUrl = isolatedUrl(proxySource, new Map([
  ['./meri-context-plane-runtime.js', { names: ['currentMeriGovernedRuntime'], url: portsUrl }],
  ['./meri-turn-progress.js', { names: ['withMeriTurnProgress'], url: progressUrl }],
]));
const { createMeriRuntimeService } = await import(proxyUrl);
const { withMeriTurnProgress } = await import(progressUrl);
const { state } = await import(portsUrl);
const ctx = Object.freeze({ tenantId: 'tenant-a', userId: 'user-a', tenantSlug: 'fixture', role: 'standard_user' });
const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const events = writes => writes.filter(value => value.startsWith('data: ')).map(value => JSON.parse(value.slice(6)));
function resetPorts() {
  assert.equal(state.timers.size, 0, 'previous call left no timer');
  assert.equal(state.listener, null, 'previous call left no stage observer');
  state.governed = null; state.observations = 0;
}
function fire(kind) {
  for (const [id, timer] of [...state.timers]) {
    if (timer.kind !== kind || !state.timers.has(id)) continue;
    if (kind === 'timeout') state.timers.delete(id);
    timer.callback();
  }
}
function clean() {
  assert.equal(state.timers.size, 0, 'actual progress helper cleans every timer');
  assert.equal(state.listener, null, 'actual progress helper releases stage observer');
  assert.equal(state.governed, null, 'fake governed port releases its context');
}
function fixture(options = {}) {
  resetPorts();
  const calls = { gate: [], current: [], unavailable: [], governed: [], image: [], wire: [], kb: [], maintenance: [] };
  const trace = [], writes = [];
  const raw = options.raw ?? {
    marker: 'retained',
    listConversations(value) { assert.equal(this, raw); return [this.marker, value]; },
    scheduleAfterTurnMaintenance(...args) { assert.equal(this, raw); calls.maintenance.push(args); },
  };
  const governed = options.governed ?? {
    context: {
      contextPacket: { packetId: 'signed-api-packet' },
      retrieval: { plan: { subjectScope: 'client' }, coverage: { complete: false, missingDomains: ['knowledge'] } },
    },
    activeClient: null,
  };
  const client = {
    marker: 'wire-client',
    identity() { assert.equal(this, client); return this.marker; },
    async streamChat(args) {
      assert.equal(this, client); calls.wire.push(args);
      return options.wire ? options.wire(args) : 'wire-result';
    },
  };
  const clientKb = {
    marker: 'client-kb',
    identity() { assert.equal(this, clientKb); return this.marker; },
    async buildSnapshot(...args) { assert.equal(this, clientKb); calls.kb.push(args); return 'kb-result'; },
  };
  const v3 = {
    client, clientKb,
    async shouldHandle(value) {
      assert.equal(this, v3); trace.push('gate'); calls.gate.push(value);
      return options.gate ? options.gate(value) : options.allowed !== false;
    },
    async streamMessage(...args) {
      assert.equal(this, v3); trace.push('v3'); calls.current.push(args);
      return options.current ? options.current(args, { v3, governed }) : 'current-result';
    },
    async streamUnavailable(...args) {
      assert.equal(this, v3); trace.push('unavailable'); calls.unavailable.push(args);
      return options.unavailable ? options.unavailable(args) : 'unavailable-result';
    },
  };
  const visual = {
    async getArtifactImage(...args) {
      assert.equal(this, visual); calls.image.push(args);
      return options.image ? options.image(args) : { buffer: Buffer.from('current-image'), contentType: 'image/png', sha256: 'fixture-hash', integrityPolicy: 'persisted_hash_match' };
    },
  };
  const runtime = {
    async runChatTurn(value, input, execute) {
      assert.equal(this, runtime); trace.push('governed'); calls.governed.push([value, input]);
      if (options.prepare) await options.prepare(value, input);
      const previous = state.governed; state.governed = governed;
      try { return await execute(); } finally { state.governed = previous; }
    },
  };
  const writer = { write(value) { writes.push(value); } };
  const service = createMeriRuntimeService(raw, v3, visual, runtime);
  return { raw, v3, visual, runtime, service, calls, trace, writes, writer, governed };
}
function trackedSignal() {
  const controller = new AbortController(), listeners = new Set();
  const signal = {
    get aborted() { return controller.signal.aborted; },
    throwIfAborted() { controller.signal.throwIfAborted(); },
    addEventListener(name, listener, options) { assert.equal(name, 'abort'); listeners.add(listener); controller.signal.addEventListener(name, listener, options); },
    removeEventListener(name, listener) { listeners.delete(listener); controller.signal.removeEventListener(name, listener); },
  };
  return { signal, abort: reason => controller.abort(reason), listeners };
}
function assertCurrentSource({ contract = contractSource, ai = aiSource, client = clientSource, proxy = proxySource } = {}) {
  assert.match(contract, /export type MeriChatStream = MeriV3ProxyService\['streamMessage'\]/);
  assert.match(contract, /export type MeriStreamArgs = Parameters<MeriChatStream>/);
  assert.match(contract, /Omit<MeriService, 'getArtifactImage'>/);
  assert.match(contract, /getArtifactImage: MeriV3VisualAnalysisService\['getArtifactImage'\]/);
  assert.doesNotMatch(contract, /^import (?!type )/m, 'type contract has no runtime dependency');
  const body = /export interface ResolvedAiForChatHeader \{([\s\S]*?)\n\}/.exec(ai)?.[1];
  assert(body, 'neutral credential type exists');
  assert.deepEqual(body.trim().split('\n').map(line => line.trim()), [
    "provider: 'anthropic' | 'openai';", 'apiKey: string;', 'model: string;', 'usedTenantKey: boolean;', 'modelOverridden: boolean;',
  ]);
  assert.match(client, /import type \{ ResolvedAiForChatHeader \} from '\.\/meri-chat-ai.types.js'/);
  assert.doesNotMatch(client, /from '\.\/meriv2-chat.client.js'/);
  assert.doesNotMatch(proxy, /RawMeriInternals|installRawPhase19Adapters|MeriService\['streamMessage'\]/);
}
function assertProviderGraph(module, controller) {
  assert.match(module, /\{\s*provide: RAW_MERI_SERVICE,\s*useClass: MeriService\s*\}/);
  assert.match(module, /\{\s*provide: MERI_TURN_MAINTENANCE,\s*useExisting: RAW_MERI_SERVICE\s*\}/);
  assert.match(module, /provide: MeriService,\s*useFactory: createMeriRuntimeService,\s*inject: \[\s*RAW_MERI_SERVICE,\s*MeriV3ProxyService,\s*MeriV3VisualAnalysisService,\s*MeriContextPlaneRuntimeService,?\s*\]/);
  assert.match(controller, /import \{ MeriService \} from '\.\/meri.service.js'/);
  assert.match(controller, /import type \{ MeriRuntimeService \} from '\.\/meri-runtime.contract.js'/);
  assert.match(controller, /@Inject\(MeriService\) private readonly service: MeriRuntimeService/);
}

test('current stream/image and neutral credential types have one source owner; loader rejects new ports', () => {
  assertCurrentSource();
  assert.throws(() => assertCurrentSource({ contract: contractSource.replace("MeriV3ProxyService['streamMessage']", "MeriService['streamMessage']") }));
  assert.throws(() => assertCurrentSource({ ai: aiSource.replace('modelOverridden: boolean;', 'modelOverridden: string;') }));
  assert.throws(() => assertCurrentSource({ client: clientSource.replace('./meri-chat-ai.types.js', './meriv2-chat.client.js') }));
  assert.throws(() => bindImports("import { injected } from './unowned.js';", new Map()));
  assert.throws(() => bindImports("import './side-effect.js';", new Map()));
  assert.throws(() => bindImports("const hidden = import('./unowned.js');", new Map()));
  assert.throws(() => bindImports("import { renamed } from './allowed.js';", new Map([['./allowed.js', { names: ['expected'], url: portsUrl }]])));
});

test('construction needs no raw streaming/private seams and patches V3 only once', () => {
  const raw = {};
  for (const name of ['streamMessage', 'orchestrateContext', 'loadRelevantMemories', 'policyForIntent', 'templateForIntent', 'meriV2Chat', 'clientKb']) {
    Object.defineProperty(raw, name, { get() { assert.fail('retired raw seam read: ' + name); } });
  }
  const f = fixture({ raw });
  const firstClient = f.v3.client, firstKb = f.v3.clientKb;
  createMeriRuntimeService(raw, f.v3, f.visual, f.runtime);
  assert.equal(f.v3.client, firstClient); assert.equal(f.v3.clientKb, firstKb);
  assert.equal(Object.getOwnPropertySymbols(raw).length, 0, 'raw instance is not patched');
  assert.deepEqual(f.trace, []); clean();
});

test('closed gate refuses through V3 without context preparation or a raw fallback', async () => {
  const f = fixture({ allowed: false });
  assert.equal(await f.service.streamMessage(ctx, 'conversation', 'hello', f.writer), 'unavailable-result');
  assert.deepEqual(f.trace, ['gate', 'unavailable']); assert.deepEqual(f.calls.gate, [ctx]);
  assert.equal(f.calls.governed.length, 0); assert.equal(f.calls.current.length, 0);
  assert.equal(f.calls.unavailable[0].length, 4); assert.equal('streamMessage' in f.raw, false); clean();
});

test('allowed turn prepares once before V3 and forwards through the actual observed writer', async () => {
  const f = fixture({ current(args) { assert.equal(state.governed, f.governed); args[3].write(frame({ type: 'text', text: 'current' })); return 'answer'; } });
  assert.equal(await f.service.streamMessage(ctx, 'conversation', 'hello', f.writer), 'answer');
  assert.deepEqual(f.trace, ['gate', 'governed', 'v3']); assert.equal(f.calls.governed.length, 1);
  assert.deepEqual(f.calls.governed[0], [ctx, { conversationId: 'conversation', body: 'hello', mode: 'new', signal: undefined }]);
  assert.deepEqual(f.calls.current[0].slice(0, 3), [ctx, 'conversation', 'hello']);
  assert.notEqual(f.calls.current[0][3], f.writer); assert.deepEqual(f.writes, [frame({ type: 'text', text: 'current' })]); clean();
});

test('default mode keeps original arity and reruns preserve every optional argument by identity', async () => {
  for (const mode of [undefined, 'regenerate', 'resend']) {
    const f = fixture(), tracked = trackedSignal(), attachments = ['attachment-a'];
    const args = mode === undefined ? [ctx, 'c', 'b', f.writer] : [ctx, 'c', '', f.writer, tracked.signal, mode, attachments, 'bearer-fixture', 'tenant-impersonated'];
    await f.service.streamMessage(...args);
    const forwarded = f.calls.current[0]; assert.equal(forwarded.length, args.length);
    args.forEach((value, index) => { if (index !== 3) assert.equal(forwarded[index], value); });
    assert.equal(f.calls.governed[0][1].mode, mode ?? 'new');
    assert.deepEqual(f.calls.gate, [ctx], 'gate receives no bearer or impersonation argument');
    assert.equal(tracked.listeners.size, 0); clean();
  }
});

test('already aborted turns call no gate or runtime and release timers/listeners', async () => {
  const f = fixture(), tracked = trackedSignal(), reason = new Error('pre-aborted'); tracked.abort(reason);
  await assert.rejects(f.service.streamMessage(ctx, 'c', 'b', f.writer, tracked.signal), error => error === reason);
  assert.deepEqual(f.trace, []); assert.equal(tracked.listeners.size, 0); clean();
});

test('abort during either gate outcome cannot dispatch a V3 or refusal stream', async () => {
  for (const allowed of [false, true]) {
    const tracked = trackedSignal(), reason = new Error('gate-aborted');
    const f = fixture({ gate() { tracked.abort(reason); return allowed; } });
    await assert.rejects(f.service.streamMessage(ctx, 'c', 'b', f.writer, tracked.signal), error => error === reason);
    assert.deepEqual(f.trace, allowed ? ['gate', 'governed'] : ['gate']);
    assert.equal(f.calls.current.length, 0); assert.equal(f.calls.unavailable.length, 0);
    assert.equal(tracked.listeners.size, 0); clean();
  }
});

test('flag, preparation, current stream and refusal failures propagate without fallback', async () => {
  for (const stage of ['gate', 'prepare', 'current', 'unavailable']) {
    const reason = new Error(stage), options = { [stage]: () => { throw reason; } };
    if (stage === 'unavailable') options.allowed = false;
    const f = fixture(options);
    await assert.rejects(f.service.streamMessage(ctx, 'c', 'b', f.writer), error => error === reason);
    assert.equal(f.calls.unavailable.length, stage === 'unavailable' ? 1 : 0);
    assert.equal(f.writes.length, 0, 'no invented completion/error frame'); clean();
  }
});

test('actual progress helper observes real stages with bounded initial/heartbeat display only', async () => {
  resetPorts(); const writes = [];
  assert.equal(await withMeriTurnProgress({ write: value => writes.push(value) }, undefined, async () => {
    assert.deepEqual([...state.timers.values()].map(row => [row.kind, row.delay]), [['timeout', 1000], ['interval', 5000]]);
    fire('timeout'); state.listener('retrieval', true); fire('interval'); state.listener('retrieval', false);
    return 'canonical-result';
  }), 'canonical-result');
  const received = events(writes); assert(received.length >= 3);
  assert(received.every(event => event.type === 'progress' && event.accepted === false && event.elapsedMs >= 0));
  assert.equal(received[0].phase, 'preparing'); assert(received.some(event => event.phase === 'retrieval'));
  assert(received.every(event => event.runId === received[0].runId)); assert.equal(state.observations, 1); clean();
});

test('actual stream frames remain intact while progress tracks acceptance, tools and answer', async () => {
  resetPorts(); const writes = [], input = [
    { type: 'turn_accepted' }, { type: 'start' }, { type: 'runtime' },
    { type: 'tool_call', tool: 'search' }, { type: 'sources', sources: [{ tool: 'search' }] },
    { type: 'text', text: 'answer' }, { type: 'runtime' }, { type: 'done' },
  ];
  await withMeriTurnProgress({ write: value => writes.push(value) }, undefined, async writer => {
    fire('timeout'); input.forEach(event => writer.write(frame(event))); fire('interval');
  });
  assert.deepEqual(writes.filter(value => JSON.parse(value.slice(6)).type !== 'progress'), input.map(frame));
  const progress = events(writes).filter(event => event.type === 'progress');
  assert(progress.some(event => event.phase === 'tools')); assert(progress.some(event => event.phase === 'answer'));
  assert(progress.some(event => !('accepted' in event))); assert.equal(progress.at(-1).note, 'Finishing the response.'); clean();
});

test('progress releases resources on terminal frames, abort, throws and display write failures', async () => {
  for (const outcome of ['done', 'error', 'abort', 'throw', 'display-failure']) {
    resetPorts(); const tracked = trackedSignal(), reason = new Error(outcome), writes = [];
    const promise = withMeriTurnProgress({ write(value) { if (outcome === 'display-failure') throw reason; writes.push(value); } }, tracked.signal, async writer => {
      if (outcome === 'throw') throw reason;
      if (outcome === 'abort') { tracked.abort(reason); assert.equal(state.timers.size, 0); }
      else if (outcome === 'display-failure') { fire('timeout'); assert.equal(state.timers.size, 0); }
      else { writer.write(frame({ type: outcome })); assert.equal(state.timers.size, 0); }
      return 'canonical-result';
    });
    if (outcome === 'throw') await assert.rejects(promise, error => error === reason);
    else assert.equal(await promise, 'canonical-result');
    assert.equal(tracked.listeners.size, 0); clean();
  }
});

test('artifact images use only the current visual port with exact arguments/results/errors', async () => {
  for (const outcome of ['image', 'null', 'error']) {
    const reason = new Error('image-failure'); const raw = { getArtifactImage() { assert.fail('raw image reader used'); } };
    const result = outcome === 'null' ? null : { buffer: Buffer.from('image'), integrityPolicy: 'validated_legacy_no_persisted_hash' };
    const f = fixture({ raw, image() { if (outcome === 'error') throw reason; return result; } });
    if (outcome === 'error') await assert.rejects(f.service.getArtifactImage(ctx, 'chart'), error => error === reason);
    else assert.equal(await f.service.getArtifactImage(ctx, 'chart'), result);
    assert.deepEqual(f.calls.image, [[ctx, 'chart']]); assert.deepEqual(f.trace, []); clean();
  }
});

test('retained history and other non-stream methods stay bound to the original receiver', () => {
  const f = fixture(); const detached = f.service.listConversations;
  assert.deepEqual(detached(ctx), ['retained', ctx]); assert.equal(f.service.marker, 'retained');
  f.raw.marker = 'updated'; assert.deepEqual(f.service.listConversations(ctx), ['updated', ctx]); clean();
});

test('retained maintenance stays bound to raw and the ordinary provider graph aliases that instance', () => {
  const f = fixture(); const detached = f.service.scheduleAfterTurnMaintenance;
  detached(ctx, 'conversation'); assert.deepEqual(f.calls.maintenance, [[ctx, 'conversation']]);
  const module = read(MERI + 'meri.module.ts'), controller = read(MERI + 'meri.controller.ts');
  assertProviderGraph(module, controller);
  assert.throws(() => assertProviderGraph(module.replace('useExisting: RAW_MERI_SERVICE', 'useClass: MeriService'), controller));
  assert.throws(() => assertProviderGraph(module, controller.replace('@Inject(MeriService)', '@Inject(Object)')));
  assert.throws(() => assertProviderGraph(module.replace('MeriV3VisualAnalysisService,\n        MeriContextPlaneRuntimeService', 'MeriV3VisualAnalysisService'), controller)); clean();
});

test('V3 client-KB suppression is limited to governed turns and preserves other receiver methods', async () => {
  const f = fixture(); assert.equal(await f.v3.clientKb.buildSnapshot(ctx, 'client'), 'kb-result');
  state.governed = f.governed; assert.equal(await f.v3.clientKb.buildSnapshot(ctx, 'client'), undefined);
  state.governed = null; assert.deepEqual(f.calls.kb, [[ctx, 'client']]);
  assert.equal(f.v3.clientKb.identity(), 'client-kb'); assert.equal(f.v3.client.identity(), 'wire-client'); clean();
});

test('V3 stream adapter keeps ungoverned input exact and adds only current governed context', async () => {
  const f = fixture(), onEvent = () => {}, input = { body: 'current' }, args = { input, onEvent, signal: 'signal-port' };
  assert.equal(await f.v3.client.streamChat(args), 'wire-result'); assert.equal(f.calls.wire[0], args);
  state.governed = f.governed;
  assert.equal(await f.v3.client.streamChat(args), 'wire-result'); state.governed = null;
  const forwarded = f.calls.wire[1]; assert.notEqual(forwarded, args); assert.notEqual(forwarded.input, input);
  assert.deepEqual(forwarded.input, { body: 'current', governedContext: f.governed.context });
  assert.equal(forwarded.signal, args.signal); assert.notEqual(forwarded.onEvent, onEvent);
  assert.deepEqual(input, { body: 'current' }); assert.equal('governedContext' in input, false); clean();
});

test('actual completion adapter retains later-read receipts and signed initial coverage without mutating upstream', async () => {
  const f = fixture(); state.governed = f.governed;
  async function receive(event) {
    let received;
    await f.v3.client.streamChat({ input: {}, onEvent: value => { received = value; } });
    f.calls.wire.at(-1).onEvent(event); return received;
  }
  const coverage = { phase: 'turn', toolReads: [{ tool: 'search', status: 'partial' }], restoredSources: ['knowledge'], complete: false };
  const upstream = { type: 'done', reply: 'answer', contextPacket: { packetId: 'upstream' }, retrieval: { plan: 'upstream-plan', coverage } };
  const original = JSON.stringify(upstream), received = await receive(upstream);
  assert.equal(received.contextPacket, f.governed.context.contextPacket); assert.equal(received.contextPacketId, 'signed-api-packet');
  assert.equal(received.retrieval.plan, f.governed.context.retrieval.plan);
  assert.deepEqual(received.retrieval.coverage, { ...coverage, initialContext: f.governed.context.retrieval.coverage });
  assert.equal(received.retrieval.coverage.toolReads, coverage.toolReads); assert.equal(JSON.stringify(upstream), original);
  for (const retrieval of [undefined, null, { coverage: { complete: true } }, { coverage: { phase: 'turn', toolReads: 'malformed' } }]) {
    assert.equal((await receive({ type: 'done', retrieval })).retrieval, f.governed.context.retrieval);
  }
  const progress = { type: 'tool_done', tool: 'search', status: 'done' }; assert.equal(await receive(progress), progress);
  state.governed = null; clean();
});

test('current Phase-19 source contract names V3 adapters and rejects restored raw dependencies', () => {
  assertCurrentSource();
  assert.throws(() => assertCurrentSource({ proxy: proxySource + '\nfunction installRawPhase19Adapters() {}\n' }));
  const phase19 = read(MERI + 'phase-19-meri-context-plane.contract.spec.ts');
  assert.match(phase19, /current V3 prewarms are suppressed on governed turns/);
  assert.match(phase19, /toContain\('installV3Phase19Adapters\(meriv3\)'\)/);
  assert.match(phase19, /not\.toContain\('installRawPhase19Adapters'\)/);
  assert.match(proxySource, /installV3Phase19Adapters\(meriv3\)/);
  assert.match(proxySource, /governedContext: governed.context/);
});
