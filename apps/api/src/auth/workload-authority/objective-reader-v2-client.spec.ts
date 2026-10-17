import { createHash, generateKeyPairSync } from 'node:crypto';
import { z } from 'zod';
import { readerPurposes } from './objective-reader-v2-contract.js';
import { createObjectiveReaderV2Client, type ObjectiveReaderV2ClientOptions,
  type ObjectiveReaderV2ExpectedSource, type ObjectiveReaderV2Observation } from './objective-reader-v2-client.js';
import { issueObjectiveReaderV2Jwt, type ObjectiveReaderV2Purpose } from './objective-reader-v2-jwt.js';

// SYNTHETIC native/decoder/HTTP fixtures. Keys stay process-local. Positive live
// authority, protected-facts custody and durable production issuance are not claimed.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = 1_800_000_000_000;
const finite = (v: unknown): string => v !== null && typeof v === 'object' ? Array.isArray(v) ? `[${v.map(finite).join(',')}]` :
  `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${finite((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);
const hash = (v: unknown) => createHash('sha256').update(finite(v)).digest('hex');
const bindingSchema = z.object({ tenantId: z.string(), actorId: z.string(), conversationId: z.string(), runId: z.string(),
  attemptId: z.string(), workerId: z.string(), writerFence: z.number() }).strict();
const canonicalSchema = z.object({ canonicalPlanId: z.string(), tenantId: z.string(), clientId: z.string(), objectiveId: z.string(),
  canonicalStrategyId: z.string(), canonicalProjectId: z.string(), bindingVersion: z.number(), epoch: z.literal(1),
  requestedIntentId: z.string(), requestedObjectiveRevisionId: z.string(), requestedObjectiveVersion: z.number(), snapshotHash: z.string() }).strict();
const admissionSchema = z.object({ schemaVersion: z.literal(1), namespace: z.literal('capiro.objective-strategy.admission:v1'),
  canonical: canonicalSchema, actorUserId: z.string(), clerkUserId: z.string(), consentId: z.string(), controlVersion: z.number(),
  generationJobId: z.string(), generationRequestId: z.string(), admittedAtMs: z.number(), effectExpiresAtMs: z.number(), expectedStrategyVersionId: z.null() }).strict();
const purposes = Object.keys(readerPurposes) as ObjectiveReaderV2Purpose[];
const keys = Object.fromEntries(purposes.map(p => [p, generateKeyPairSync('ed25519')])) as Record<ObjectiveReaderV2Purpose, ReturnType<typeof generateKeyPairSync>>;
function fixture(p: ObjectiveReaderV2Purpose = 'active-source') {
  const state = { now: NOW, issue: 0, validate: 0, fetch: 0, events: [] as string[], issued: '', tokens: [] as string[] };
  const binding = { tenantId: id(1), actorId: 'synthetic_actor_é', conversationId: id(2), runId: id(3), attemptId: id(4), workerId: id(5), writerFence: 1 };
  const admission = { schemaVersion: 1 as const, namespace: 'capiro.objective-strategy.admission:v1' as const,
    canonical: { canonicalPlanId: id(6), tenantId: id(1), clientId: id(7), objectiveId: id(8), canonicalStrategyId: id(9), canonicalProjectId: id(10),
      bindingVersion: 1, epoch: 1 as const, requestedIntentId: id(11), requestedObjectiveRevisionId: id(12), requestedObjectiveVersion: 2, snapshotHash: 'c'.repeat(64) },
    actorUserId: id(13), clerkUserId: binding.actorId, consentId: id(14), controlVersion: 2, generationJobId: id(15), generationRequestId: id(16),
    admittedAtMs: NOW - 1000, effectExpiresAtMs: NOW + 90000, expectedStrategyVersionId: null };
  const expected: ObjectiveReaderV2ExpectedSource = { generationJobId: id(15), sourceAdmissionSha256: hash(admission), sourceAdmission: admission, queuedType: 'appropriations' };
  const output: ObjectiveReaderV2Observation = { schemaVersion: 2, purpose: p === 'historical-source' ? p : 'active-source', generationJobId: id(15),
    sourceAdmission: admission, sourceAdmissionSha256: expected.sourceAdmissionSha256, binding,
    sourceRequestSha256: 'd'.repeat(64), issuance: { issuanceKey: hash(binding), binding, requestSha256: 'd'.repeat(64), expiresAtMs: p === 'historical-source' ? NOW - 1 : NOW + 80000,
      grantId: id(17), capabilitySha256: 'e'.repeat(64), factsSha256: 'f'.repeat(64) }, typedRequestSha256: '1'.repeat(64), executionContextSha256: '2'.repeat(64),
    acceptedRequestId: id(16), acceptedPromptSha256: '3'.repeat(64), queuedType: 'appropriations', runState: p === 'historical-source' ? 'completed' : 'running', checkedAtMs: NOW, expiresAtMs: NOW + 2000 };
  const trust = Object.fromEntries(purposes.map(purpose => [purpose, { purpose, issuer: `urn:synthetic:core:objective:${purpose}:v2`,
    kid: `${purpose}-synthetic-2`, publicKey: keys[purpose].publicKey }])) as NonNullable<ObjectiveReaderV2ClientOptions['trust']>;
  const options: ObjectiveReaderV2ClientOptions = { enabled: true, origin: 'https://synthetic-meri.example', trust, now: () => state.now,
    parsers: { admission: raw => admissionSchema.parse(raw), binding: raw => bindingSchema.parse(raw) },
    credentialOwner: {
      async issue(request) { state.issue++; state.events.push('issue'); state.issued = issueObjectiveReaderV2Jwt(request,
        { purpose: request.purpose, issuer: trust[request.purpose].issuer, kid: trust[request.purpose].kid, privateKey: keys[request.purpose].privateKey },
        { jti: id(18), nowSeconds: Math.floor(state.now / 1000), expiresAtSeconds: Math.floor(state.now / 1000) + 30 });
        return { token: state.issued, expiresAtMs: NOW + 30000 }; },
      async revalidate(value) { state.validate++; state.events.push(value.observation === null ? 'native-before' : 'native-after'); state.tokens.push(value.credential.token); return true; },
    }, transport: (async (url, init) => { state.fetch++; state.events.push('fetch'); expect(url).toBe(options.origin! + readerPurposes[p].path);
      expect(init?.redirect).toBe('manual'); expect(init?.method).toBe('POST');
      expect(JSON.parse(Buffer.from(init?.body as Uint8Array).toString())).toEqual({ schemaVersion: 2, purpose: p, generationJobId: id(15), sourceAdmissionSha256: expected.sourceAdmissionSha256 });
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${state.issued}`);
      return new Response(JSON.stringify(output), { headers: { 'content-type': 'application/json' } }); }) as typeof fetch };
  return { state, expected, output, options, read: () => createObjectiveReaderV2Client(options).read(p, expected) };
}

describe('Objective reader v2 closed Core source adapter', () => {
  test.each(['active-source', 'historical-source'] as const)('%s uses same token and fresh native checks before and after original entity transport', async p => {
    const f = fixture(p), result = await f.read();
    expect(result).toEqual(f.output); expect(Object.isFrozen(result)).toBe(true);
    expect(f.state.events).toEqual(['issue', 'native-before', 'fetch', 'native-after']);
    expect(f.state.tokens).toEqual([f.state.issued, f.state.issued]); expect(f.state.issue).toBe(1);
  });
  test('historical read preserves expired execution metadata and does not renew it', async () => {
    const f = fixture('historical-source'); const result = await f.read() as ObjectiveReaderV2Observation;
    expect(result.issuance.expiresAtMs).toBe(NOW - 1); expect(result.expiresAtMs).toBeGreaterThan(NOW);
  });
  test('unconfigured/default disabled client fails before clock, authority or HTTP I/O', async () => {
    const f = fixture(); const fail = () => { throw Error('never'); };
    await expect(createObjectiveReaderV2Client().readActiveSource(f.expected)).rejects.toThrow('UNAVAILABLE');
    await expect(createObjectiveReaderV2Client({ ...f.options, enabled: false, now: fail }).readActiveSource(f.expected)).rejects.toThrow('UNAVAILABLE');
    await expect(createObjectiveReaderV2Client({ ...f.options, credentialOwner: undefined }).readActiveSource(f.expected)).rejects.toThrow('UNAVAILABLE');
    expect(f.state.events).toEqual([]);
  });
  test('disabled/accessor/proxy enable state never evaluates dependency or key getters', async () => {
    const f = fixture(); let reads = 0;
    const poison = { enabled: false };
    for (const key of ['origin', 'credentialOwner', 'parsers', 'trust', 'transport', 'now']) {
      Object.defineProperty(poison, key, { enumerable: true, get() { reads++; throw Error('must not read disabled dependency'); } });
    }
    const enabledAccessor = Object.defineProperty({}, 'enabled', { enumerable: true, get() { reads++; throw Error('must not read enable getter'); } });
    const proxy = new Proxy({}, { get() { reads++; throw Error('get'); }, getOwnPropertyDescriptor() { reads++; throw Error('descriptor'); },
      ownKeys() { reads++; throw Error('keys'); }, getPrototypeOf() { reads++; throw Error('prototype'); } });
    for (const options of [poison, enabledAccessor, proxy]) {
      await expect(createObjectiveReaderV2Client(options).readActiveSource(f.expected)).rejects.toThrow('UNAVAILABLE');
    }
    expect(reads).toBe(0); expect(f.state.events).toEqual([]);
  });
  test.each(['publicKey', 'issuer', 'kid'] as const)('the receiving trust registry refuses reused %s material before native or HTTP I/O', async field => {
    const f = fixture(), original = f.options.trust!;
    const trust = { ...original, 'historical-source': { ...original['historical-source'], [field]: original['active-source'][field] } };
    await expect(createObjectiveReaderV2Client({ ...f.options, trust }).readActiveSource(f.expected)).rejects.toThrow();
    expect(f.state.events).toEqual([]);
  });
  test('trust registry captures pins once and rejects accessors without evaluating them', async () => {
    const f = fixture(), pins = { ...f.options.trust! }; let read = false;
    Object.defineProperty(pins, 'active-source', { enumerable: true, get() { read = true; throw Error('must not evaluate key getter'); } });
    await expect(createObjectiveReaderV2Client({ ...f.options, trust: pins }).readActiveSource(f.expected)).rejects.toThrow();
    expect(read).toBe(false); expect(f.state.events).toEqual([]);
  });
  test.each(['http://synthetic-meri.example', 'https://synthetic-meri.example/', 'https://synthetic-meri.example/a',
    'https://synthetic-meri.example?x=1', 'https://synthetic-meri.example#x', 'https://actor:secret@synthetic-meri.example'])('rejects nonexact fixed HTTPS origin %s before I/O', async origin => {
    const f = fixture(); await expect(createObjectiveReaderV2Client({ ...f.options, origin }).readActiveSource(f.expected)).rejects.toThrow();
    expect(f.state.events).toEqual([]);
  });
  test('rejects caller binding, source mutation or accessor before native issuance', async () => {
    const f = fixture();
    for (const input of [{ ...f.expected, binding: f.output.binding }, { ...f.expected, generationJobId: id(99) },
      { ...f.expected, sourceAdmissionSha256: '0'.repeat(64) }]) await expect(createObjectiveReaderV2Client(f.options).readActiveSource(input)).rejects.toThrow();
    let called = false; const get = Object.defineProperty({ ...f.expected }, 'queuedType', { get() { called = true; return 'appropriations'; }, enumerable: true });
    await expect(createObjectiveReaderV2Client(f.options).readActiveSource(get)).rejects.toThrow(); expect(called).toBe(false); expect(f.state.events).toEqual([]);
  });
  test('caller arrays reject map/index accessors and subclasses without executing their iteration', async () => {
    const f = fixture(); let calls = 0;
    const method = [1]; Object.defineProperty(method, 'map', { get() { calls++; throw Error('caller map getter'); } });
    const indexed = [1]; Object.defineProperty(indexed, '0', { enumerable: true, configurable: true, get() { calls++; throw Error('caller index getter'); } });
    class DerivedArray extends Array { override map(): never { calls++; throw Error('subclass map'); } }
    for (const sourceAdmission of [method, indexed, new DerivedArray(1), [, 1]]) {
      await expect(createObjectiveReaderV2Client(f.options).readActiveSource({ ...f.expected, sourceAdmission })).rejects.toThrow();
    }
    expect(calls).toBe(0); expect(f.state.events).toEqual([]);
  });
  test.each(['sourceAdmissionSha256', 'generationJobId', 'sourceRequestSha256', 'acceptedRequestId', 'queuedType', 'purpose'])('rejects substituted response %s', async key => {
    const f = fixture(); (f.output as unknown as Record<string, unknown>)[key] = key === 'sourceAdmissionSha256' || key === 'sourceRequestSha256' ? '0'.repeat(64) : id(99);
    await expect(f.read()).rejects.toThrow(); expect(f.state.validate).toBe(1);
  });
  test('rejects extra top-level/nested secret or changed tenant, actor, writer fence and issuance identity', async () => {
    const patches: Array<(f: ReturnType<typeof fixture>) => void> = [f => { Object.assign(f.output, { proxyConfiguration: 'secret' }); },
      f => { Object.assign(f.output.issuance, { materialRef: 'secret' }); }, f => { f.output.binding = { ...f.output.binding, writerFence: 2 }; },
      f => { f.output.binding.actorId = 'other'; f.output.issuance.binding = f.output.binding; },
      f => { f.output.issuance.issuanceKey = '0'.repeat(64); }, f => { (f.output.sourceAdmission as Record<string, unknown>).consentId = id(99); }];
    for (const patch of patches) { const f = fixture(); patch(f); await expect(f.read()).rejects.toThrow(); }
  });
  test.each(['active-source', 'historical-source'] as const)('keeps %s state and expiry domain distinct', async p => {
    const patches: Array<(f: ReturnType<typeof fixture>) => void> = [f => { f.output.runState = p === 'active-source' ? 'completed' : 'running'; },
      f => { f.output.expiresAtMs = NOW; }, f => { f.output.checkedAtMs = NOW + 1; }, f => { f.output.expiresAtMs = NOW + 3001; },
      f => { f.output.issuance.expiresAtMs = NOW + 90001; }];
    if (p === 'active-source') patches.push(f => { f.output.issuance.expiresAtMs = NOW - 1; });
    for (const patch of patches) { const f = fixture(p); patch(f); await expect(f.read()).rejects.toThrow(); }
  });
  test.each(['active-source', 'historical-source'] as const)('%s rejects a cached observation checked before this read began', async p => {
    const f = fixture(p); f.output.checkedAtMs = NOW - 1;
    await expect(f.read()).rejects.toThrow(); expect(f.state.validate).toBe(1);
  });
  test('retained source rejects a cached receipt checked before this read began', async () => {
    const f = fixture('retained-result'); let decoded = 0;
    // This test isolates freshness after a SYNTHETIC strict-decoder boundary;
    // the cross-repository composition suite supplies the actual retained owner.
    const wire = { schemaVersion: 1, generationJobId: f.expected.generationJobId, binding: f.output.binding,
      sourceAdmissionSha256: f.expected.sourceAdmissionSha256, sourceRequestSha256: 'a'.repeat(64), typedRequestSha256: 'b'.repeat(64),
      completionId: id(30), checkpointId: id(31), checkpointSha256: 'c'.repeat(64), resultRef: id(32), resultSha256: 'd'.repeat(64),
      file: {}, rawFileSha256: 'e'.repeat(64), execution: {}, result: {}, checkedAtMs: NOW - 1, expiresAtMs: NOW + 1000 };
    f.options.parsers!.retained = raw => { decoded++; return raw; };
    await expect(createObjectiveReaderV2Client({ ...f.options, transport: (async () => new Response(JSON.stringify(wire),
      { headers: { 'content-type': 'application/json' } })) as typeof fetch }).readRetainedResult(f.expected)).rejects.toThrow();
    expect(decoded).toBe(1); expect(f.state.validate).toBe(1);
  });
  test('native authority failure before and after transport fails closed without automatic token reissue', async () => {
    for (const failAt of [1, 2]) { const f = fixture(); const original = f.options.credentialOwner!.revalidate;
      f.options.credentialOwner!.revalidate = async (...args) => { if (f.state.validate + 1 === failAt) throw Error('SYNTHETIC_REVOKED'); return original(...args); };
      await expect(f.read()).rejects.toThrow(); expect(f.state.issue).toBe(1); expect(f.state.fetch).toBe(failAt === 1 ? 0 : 1); }
  });
  test('an observation expiring during final native recheck cannot escape the client', async () => {
    const f = fixture(), original = f.options.credentialOwner!.revalidate;
    f.options.credentialOwner!.revalidate = async (...args) => {
      const result = await original(...args); if (args[0].observation !== null) f.state.now = f.output.expiresAtMs; return result;
    };
    await expect(f.read()).rejects.toThrow(); expect(f.state.issue).toBe(1); expect(f.state.validate).toBe(2);
  });
  test.each(['issue', 'native-before'] as const)('a backward clock during %s fails immediately even if later transport would restore it', async stage => {
    const f = fixture(), baseIssue = f.options.credentialOwner!.issue, baseValidate = f.options.credentialOwner!.revalidate;
    f.options.credentialOwner!.issue = async (...args) => { const issued = await baseIssue(...args); if (stage === 'issue') f.state.now = NOW - 1; return issued; };
    f.options.credentialOwner!.revalidate = async (...args) => { const result = await baseValidate(...args); if (stage === 'native-before') f.state.now = NOW - 1; return result; };
    const baseFetch = f.options.transport!;
    await expect(createObjectiveReaderV2Client({ ...f.options, transport: (async (...args: Parameters<typeof fetch>) => { f.state.now = NOW; return baseFetch(...args); }) as typeof fetch })
      .readActiveSource(f.expected)).rejects.toThrow();
    expect(f.state.fetch).toBe(0);
  });
  test('rejects wrong token, mismatched lifetime and expired credential before transport', async () => {
    for (const patch of [{ token: 'wrong', expiresAtMs: NOW + 30000 }, { token: '', expiresAtMs: NOW + 30001 }]) {
      const f = fixture(), original = f.options.credentialOwner!.issue;
      f.options.credentialOwner!.issue = async (...args) => ({ ...await original(...args), ...patch, token: patch.token || f.state.issued });
      await expect(f.read()).rejects.toThrow(); expect(f.state.fetch).toBe(0);
    }
  });
  test('rejects redirects, errors, encoded responses, wrong entity length and malformed UTF8', async () => {
    const responses = [() => new Response('', { status: 302, headers: { location: 'https://other.invalid' } }),
      () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
      () => new Response('{}', { headers: { 'content-type': 'text/plain' } }),
      () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }),
      () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1' } }),
      () => new Response(Uint8Array.from([255]), { headers: { 'content-type': 'application/json' } })];
    for (const response of responses) { const f = fixture(); await expect(createObjectiveReaderV2Client({ ...f.options, transport: (async () => response()) as typeof fetch }).readActiveSource(f.expected)).rejects.toThrow(); }
  });
  test('rejects an oversized streaming response and stale source after transport', async () => {
    const f = fixture(); const huge = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4194305)); c.close(); } });
    await expect(createObjectiveReaderV2Client({ ...f.options, transport: (async () => new Response(huge, { headers: { 'content-type': 'application/json' } })) as typeof fetch }).readActiveSource(f.expected)).rejects.toThrow();
    const slow = fixture(), base = slow.options.transport!;
    await expect(createObjectiveReaderV2Client({ ...slow.options, transport: (async (...args: Parameters<typeof fetch>) => { const r = await base(...args); slow.state.now += 3000; return r; }) as typeof fetch }).readActiveSource(slow.expected)).rejects.toThrow();
  });
  test('retained result is unavailable before I/O without the existing strict retained owner decoder', async () => {
    const f = fixture('retained-result'); await expect(f.read()).rejects.toThrow(); expect(f.state.events).toEqual([]);
  });
  test('retained decoder cannot return an arbitrary truthy value or strip unchecked fields', async () => {
    const f = fixture('retained-result'); f.options.parsers!.retained = () => true;
    await expect(f.read()).rejects.toThrow(); expect(f.state.validate).toBe(1);
  });
  test('caller cancellation exits a stuck owner and never starts HTTP', async () => {
    const f = fixture(), controller = new AbortController(); f.options.credentialOwner!.issue = () => new Promise(() => undefined);
    const pending = createObjectiveReaderV2Client(f.options).readActiveSource(f.expected, controller.signal); controller.abort();
    await expect(pending).rejects.toThrow(); expect(f.state.fetch).toBe(0);
  });
});
