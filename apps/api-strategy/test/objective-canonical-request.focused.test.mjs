// Source fixture authoring only: no application/DB/provider or authority proof.
// The parent runs bounded checks separately. Exact JCS is restricted to the
// safe-integer candidate domain; sidecar self-hashes never prove custody.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const custody = [];
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const asModule = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
async function sourceModule(path, replacements = []) {
  const url = new URL(path, import.meta.url), original = await readFile(url, 'utf8');
  let source = original;
  for (const [from, to] of replacements) {
    const parts = source.split(from); assert.equal(parts.length, 2, `one declared dependency ${from}`); source = parts.join(to);
  }
  const stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url.href });
  custody.push({ path, sha256: sha(original), replacementSpecifiers: replacements.map(([from]) => from), transformedSha256: sha(stripped) });
  return asModule(stripped);
}
const appUrl = await sourceModule('../src/planner/objective-canonical-application.ts');
const genUrl = await sourceModule('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", JSON.stringify(appUrl)],
]);
const requestUrl = await sourceModule('../src/meri/objective-canonical-request.ts', [
  ["'../planner/objective-canonical-application.js'", JSON.stringify(appUrl)],
  ["'./objective-canonical-generation.js'", JSON.stringify(genUrl)],
]);
const { applicationHash } = await import(appUrl);
const { canonicalGenerationAdmissionSha256 } = await import(genUrl);
const { createCanonicalRequestPublication: create, checkCanonicalRequestPublication: check,
  candidateJcsSha256: jcs, CANONICAL_STRATEGY_CANDIDATE_VERSION } = await import(requestUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hash = c => c.repeat(64);
const clone = value => structuredClone(value);
const start = Date.parse('2026-10-16T06:00:00.000Z');
const refused = (run, code) => assert.throws(run,
  e => code ? e.code === code : ['INPUT_INVALID', 'REQUEST_CONFLICT', 'AUTHORITY_UNAVAILABLE'].includes(e.code));
function fixture() {
  const source = { clientId: id(3), objectiveId: id(4), objectiveVersion: 2, objectiveRevisionId: id(8) };
  const intent = { outcome: ' Exact outcome ', governmentProblem: 'Read the actual evidence', askType: 'meri_propose',
    minimumWin: 'A reviewed proposal', limits: '' };
  const prompt = 'Literal governed prompt\naccepted historical artifact; pending recommendation remains uncertain.\n';
  return {
    admission: { schemaVersion: 1, namespace: 'capiro.objective-strategy.admission:v1',
      canonical: { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
        canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
        requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 2, snapshotHash: hash('a') },
      actorUserId: id(9), clerkUserId: 'user_fixture', consentId: id(12), controlVersion: 3,
      generationJobId: id(10), generationRequestId: id(11), admittedAtMs: start - 60_000,
      effectExpiresAtMs: start + 1_800_000, expectedStrategyVersionId: null },
    dto: { clientId: id(3), type: 'authorization', goal: '  Exact queued goal\n', meriContext: null,
      ownerUserId: null, targetDate: '2028-02-29', attachmentIds: [] },
    context: { schemaVersion: 1, tenantId: id(2), clerkUserId: 'user_fixture', requestId: id(11), source, intent,
      snapshotSha256: hash('a'), sourceDigest: applicationHash({ source, intent }), packetId: id(20),
      compiledAt: '2026-10-16T06:00:00.000Z', coverageDigest: hash('b'), promptSha256: sha(prompt), evidence: [
        { ref: `profile-fill:${id(30)}:${hash('c')}`, sourceId: id(30), asOfMs: start - 5_000,
          scope: 'client', clientId: id(3), reviewState: 'accepted' },
        { ref: `profile-fill:${id(31)}:${hash('d')}`, sourceId: id(31), asOfMs: start - 1_000,
          scope: 'client', clientId: id(3), reviewState: 'pending' },
      ] },
    prompt, owners: [{ ownerRef: 'owner:fixture', clerkUserId: 'user_fixture' }],
    delegation: { ref: id(40), revision: 'actual-delegation-revision:7', issuedAtMs: start - 120_000,
      absoluteExpiresAtMs: start + 3_600_000 },
    requestedAtMs: start + 1_000, effectExpiresAtMs: start + 1_200_000,
  };
}
const verify = (p, f) => check(p, { admission: f.admission, dto: f.dto });

test('custody names the three actual modules and declared source-only dependency rewrites', t => {
  assert.equal(custody.length, 3); assert.deepEqual(custody.map(x => x.replacementSpecifiers.length), [0, 1, 2]);
  t.diagnostic(JSON.stringify({ sourceCustody: custody }));
});
test('restricted JCS uses independent fixed canonical vectors and UTF-16 key order', () => {
  assert.equal(jcs([]), '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  assert.equal(jcs({ b: 2, a: 1 }), sha('{"a":1,"b":2}'));
  assert.equal(jcs({ '\ue000': 1, '\ud83d\ude00': 2 }), sha('{"😀":2,"\ue000":1}'));
  assert.equal(jcs({ x: -0, y: Number.MAX_SAFE_INTEGER }), sha('{"x":0,"y":9007199254740991}'));
  assert.equal(jcs('é'), sha('"é"'));
  assert.notEqual(jcs('é'), sha('é'));
});
test('restricted JCS rejects floats, unsafe integers, invalid Unicode, symbols and sparse arrays', () => {
  for (const value of [0.25, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, 1n, '\ud800', '\udfff',
    { ['\ud800']: 1 }, new Array(1), new Date(0), Object.assign([], { extra: 1 }), { [Symbol('extra')]: 1 }])
    refused(() => jcs(value), 'INPUT_INVALID');
  const cycle = {}; cycle.self = cycle; refused(() => jcs(cycle));
});
test('accessors and proxies never execute while hashing or reading factory input', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { calls++; throw Error(); } });
  refused(() => jcs(getter));
  refused(() => jcs(new Proxy({}, { ownKeys() { calls++; throw Error(); } })));
  const revoked = Proxy.revocable({}, {}); revoked.revoke(); refused(() => jcs(revoked.proxy));
  const f = fixture(); Object.defineProperty(f.context.evidence[0], 'reviewState', { enumerable: true, get() { calls++; throw Error(); } });
  refused(() => create(f)); assert.equal(calls, 0);
});
test('initial publication has exactly five fields and a complete closed 4d8 initial request', () => {
  const f = fixture(), before = clone(f), p = create(f), r = p.request;
  assert.deepEqual(f, before);
  assert.deepEqual(Object.keys(p).sort(), ['executionContext', 'request', 'requestSha256', 'schemaVersion', 'sourceAdmissionSha256']);
  assert.equal(r.candidateVersion, CANONICAL_STRATEGY_CANDIDATE_VERSION); assert.equal(r.operation, 'strategy.draft');
  assert.equal(r.requestId, id(11)); assert.equal(r.jobId, id(10)); assert.equal(r.basis, null);
  assert.deepEqual(r.principal, { tenantId: id(2), actorId: 'user_fixture', clientId: id(3), ownerActorId: 'user_fixture' });
  assert.deepEqual(r.source, { kind: 'objective', objectiveId: id(4), objectiveVersion: 2,
    objectiveRevisionId: id(8), snapshotSha256: hash('a'), intent: f.context.intent });
  assert.equal(p.sourceAdmissionSha256, canonicalGenerationAdmissionSha256(f.admission));
  assert.equal(r.context.packetId, id(20)); assert.equal(r.context.asOfMs, start);
  assert.equal(r.context.coverageSha256, hash('b')); assert.deepEqual(r.context.evidence, f.context.evidence);
  assert.deepEqual(r.context.ownerRefs, ['owner:fixture']); assert.deepEqual(p.executionContext.ownerRefs, f.owners);
  assert.equal(p.executionContext.prompt, f.prompt); assert.equal(p.executionContext.promptSha256, sha(f.prompt));
  assert.equal(p.executionContext.contextPacketId, id(20)); assert.deepEqual(verify(p, f), p);
});
test('request, input and context hashes use their exact separate payloads', () => {
  const p = create(fixture()), r = p.request;
  const { inputSha256, ...withoutInput } = r, { contextSha256, ...withoutContext } = r.context;
  assert.equal(inputSha256, jcs(withoutInput)); assert.equal(contextSha256, jcs(withoutContext));
  assert.equal(p.requestSha256, jcs(r)); assert.notEqual(inputSha256, jcs(r.input));
  assert.notEqual(p.requestSha256, inputSha256); assert.notEqual(r.source.snapshotSha256, applicationHash({ source: r.source }));
  assert.notEqual(r.source.snapshotSha256, fixture().context.sourceDigest);
});
test('raw DTO strings and blank values survive while optional absent/null fields normalize exactly', () => {
  const f = fixture(); f.dto.goal = ''; f.dto.meriContext = '  exact\n'; f.dto.ownerUserId = '   ';
  const p = create(f); assert.equal(p.request.input.goal, ''); assert.equal(p.request.input.meriContext, '  exact\n');
  assert.equal(p.request.input.ownerUserId, '   '); assert.equal(p.request.principal.ownerActorId, 'user_fixture');
  for (const key of ['goal', 'meriContext', 'ownerUserId', 'targetDate', 'attachmentIds']) delete f.dto[key];
  const absent = create(f); for (const key of ['goal', 'meriContext', 'ownerUserId', 'targetDate', 'attachmentIds']) f.dto[key] = null;
  assert.deepEqual(create(f), absent);
  assert.deepEqual(absent.request.input, { typeHint: 'authorization', goal: null, meriContext: null,
    ownerUserId: null, targetDate: null, attachmentIds: [] });
  assert.deepEqual(absent.request.context.draft.input, absent.request.input);
});
test('selected owner is trimmed only for selection and must have an actual owner pair', () => {
  const f = fixture(); f.dto.ownerUserId = '  user_selected  ';
  refused(() => create(f), 'AUTHORITY_UNAVAILABLE');
  f.owners.push({ ownerRef: 'owner:selected', clerkUserId: 'user_selected' });
  const p = create(f); assert.equal(p.request.principal.ownerActorId, 'user_selected');
  assert.equal(p.request.input.ownerUserId, '  user_selected  ');
  assert.equal(p.request.context.draft.selectedOwnerActorId, 'user_selected');
  f.owners.push({ ownerRef: 'owner:selected', clerkUserId: 'user_other' }); refused(() => create(f));
});
test('Clerk actor is an opaque subject, never converted to native UUID or restricted to an invented regex', () => {
  const f = fixture(), actor = 'issuer|actor:opaque'; f.admission.clerkUserId = actor; f.context.clerkUserId = actor;
  f.owners[0].clerkUserId = actor;
  assert.equal(create(f).request.principal.actorId, actor);
});
test('no requested attachments uses the truthful not-requested legacy observation only', () => {
  const p = create(fixture()); assert.deepEqual(p.request.context.draft.attachments, {
    correlation: 'unattributed-legacy-bundle', coverage: 'not-proven-by-legacy-resolver', state: 'not-requested',
    documentsSha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', documents: [],
  });
  for (const ids of [['attachment-1'], [''], ['a', 'a']]) {
    const f = fixture(); f.dto.attachmentIds = ids; refused(() => create(f), 'AUTHORITY_UNAVAILABLE');
  }
});
test('non-null regeneration basis refuses without emitting an incompatible 4d8 request', () => {
  const f = fixture(); f.admission.expectedStrategyVersionId = id(100); refused(() => create(f), 'AUTHORITY_UNAVAILABLE');
});
test('every owner/context/source identity is bound to the actual admission', () => {
  for (const change of [f => { f.context.tenantId = id(99); }, f => { f.context.clerkUserId = 'other'; },
    f => { f.context.requestId = id(99); }, f => { f.dto.clientId = id(99); },
    f => { f.context.source.clientId = id(99); }, f => { f.context.source.objectiveId = id(99); },
    f => { f.context.source.objectiveRevisionId = id(99); }, f => { f.context.source.objectiveVersion++; },
    f => { f.context.snapshotSha256 = f.context.sourceDigest; }, f => { f.context.intent.outcome = 'substituted'; }]) {
    const f = fixture(); change(f); refused(() => create(f));
  }
});
test('prompt hash uses literal UTF-8 content and rejects mismatching Core observation', () => {
  const f = fixture(); f.prompt = 'Évidence 🧭\n'; f.context.promptSha256 = sha(f.prompt);
  assert.equal(create(f).executionContext.promptSha256, sha(f.prompt));
  assert.notEqual(sha(f.prompt), jcs(f.prompt));
  f.prompt += 'changed'; refused(() => create(f), 'REQUEST_CONFLICT');
});
test('all closed DTO/context/owner/delegation shapes reject unknown or missing fields', () => {
  for (const change of [f => { f.extra = true; }, f => { f.dto.provider = 'posted'; },
    f => { f.context.rawSource = {}; }, f => { f.context.source.extra = true; },
    f => { f.context.intent.extra = true; }, f => { f.context.evidence[0].fact = 'promoted'; },
    f => { f.owners[0].actorUserId = id(9); }, f => { f.delegation.consentId = id(12); },
    f => { delete f.delegation.revision; }, f => { delete f.context.evidence; }, f => { delete f.dto.type; }]) {
    const f = fixture(); change(f); refused(() => create(f));
  }
});
test('evidence keeps accepted/pending artifact status and refuses hidden, promoted or cross-client entries', () => {
  const f = fixture(); assert.deepEqual(create(f).request.context.evidence.map(e => e.reviewState), ['accepted', 'pending']);
  for (const change of [e => { e.reviewState = 'rejected'; }, e => { e.reviewState = 'informational'; },
    e => { e.reviewState = 'verified'; }, e => { e.scope = 'personal'; }, e => { e.scope = 'tenant-shared'; e.clientId = null; },
    e => { e.clientId = id(99); }, e => { e.ref = 'prompt:guessed'; }, e => { e.ref += '\n'; },
    e => { e.sourceId = id(99); }, e => { e.asOfMs = start + 1; }]) {
    const x = fixture(); change(x.context.evidence[0]); refused(() => create(x));
  }
});
test('duplicate refs or finding IDs and incomplete evidence overflow refuse without lossy filtering', () => {
  const f = fixture(); f.context.evidence.push(clone(f.context.evidence[0])); refused(() => create(f));
  f.context.evidence[2].ref = `profile-fill:${id(30)}:${hash('e')}`; refused(() => create(f));
  const large = fixture(); large.context.evidence = Array.from({ length: 257 }, (_, i) => ({ ...large.context.evidence[0],
    sourceId: id(i + 1000), ref: `profile-fill:${id(i + 1000)}:${hash('c')}` })); refused(() => create(large));
});
test('frozen publication and nested payload prevent caller mutation after hashing', () => {
  const p = create(fixture()); assert.ok(Object.isFrozen(p)); assert.ok(Object.isFrozen(p.request.input));
  assert.ok(Object.isFrozen(p.request.context.evidence[0])); assert.ok(Object.isFrozen(p.executionContext.ownerRefs[0]));
  assert.throws(() => { p.request.input.goal = 'changed'; });
});
test('candidate original deadline clips to each actual ceiling and the fixed 15-minute attempt bound', () => {
  const f = fixture(); assert.equal(create(f).request.originalExpiresAtMs, f.requestedAtMs + 900_000);
  for (const change of [x => { x.effectExpiresAtMs = x.requestedAtMs + 10; },
    x => { x.admission.effectExpiresAtMs = x.requestedAtMs + 10; },
    x => { x.delegation.absoluteExpiresAtMs = x.requestedAtMs + 10; }]) {
    const x = fixture(); change(x); assert.equal(create(x).request.originalExpiresAtMs, x.requestedAtMs + 10);
  }
});
test('deadline equality, future issuance, delegation over 24 hours and invalid clock domains refuse', () => {
  for (const change of [f => { f.effectExpiresAtMs = f.requestedAtMs; },
    f => { f.delegation.issuedAtMs = f.requestedAtMs + 1; },
    f => { f.delegation.absoluteExpiresAtMs = f.delegation.issuedAtMs + 86_400_001; },
    f => { f.delegation.absoluteExpiresAtMs = f.requestedAtMs; },
    f => { f.requestedAtMs = start - 1; }, f => { f.context.compiledAt = '2026-02-30T00:00:00Z'; },
    f => { f.context.compiledAt += '\n'; }, f => { f.requestedAtMs = NaN; },
    f => { f.effectExpiresAtMs = Number.MAX_SAFE_INTEGER + 1; }]) {
    const f = fixture(); change(f); refused(() => create(f));
  }
});
test('delegation is preserved as supplied genuine metadata, never synthesized from consent/control', () => {
  const f = fixture(), p = create(f); assert.deepEqual(p.request.delegation, f.delegation);
  assert.notEqual(p.request.delegation.ref, f.admission.consentId);
  assert.notEqual(p.request.delegation.revision, String(f.admission.controlVersion));
  delete f.delegation; refused(() => create(f));
});
test('invalid enums, dates, over-limit raw fields and malformed exact hashes refuse', () => {
  for (const change of [f => { f.dto.type = 'meri_propose'; }, f => { f.dto.targetDate = '2027-02-29'; },
    f => { f.dto.goal = 'a'.repeat(4001); }, f => { f.context.intent.minimumWin = ' '; },
    f => { f.context.sourceDigest += '\n'; }, f => { f.delegation.ref += '\n'; },
    f => { f.owners = Array.from({ length: 101 }, (_, i) => ({ ownerRef: `owner:${i}`, clerkUserId: 'user_fixture' })); }]) {
    const f = fixture(); change(f); refused(() => create(f));
  }
});
test('whole publication byte limit refuses a prompt that fits its own bound but exceeds the full envelope', () => {
  const f = fixture(); f.prompt = 'x'.repeat(2 * 1024 * 1024); f.context.promptSha256 = sha(f.prompt);
  refused(() => create(f), 'INPUT_INVALID');
});
test('candidate request byte limit refuses an otherwise shaped wide request before publishing it', () => {
  const f = fixture(); f.dto.goal = 'é'.repeat(4000); f.context.intent.governmentProblem = 'é'.repeat(4000);
  f.context.sourceDigest = applicationHash({ source: f.context.source, intent: f.context.intent });
  f.owners = [f.owners[0], ...Array.from({ length: 99 }, (_, i) => ({
    ownerRef: `owner:${i}:` + '🧭'.repeat(118), clerkUserId: 'user_fixture',
  }))];
  f.context.evidence = Array.from({ length: 256 }, (_, i) => ({ ...f.context.evidence[0],
    sourceId: id(i + 1000), ref: `profile-fill:${id(i + 1000)}:${hash('c')}` }));
  refused(() => create(f), 'INPUT_INVALID');
});
test('retained lookup reconstructs exact saved bytes without current clock, expiry renewal or Core recompilation', () => {
  const f = fixture(), p = create(f), originalNow = Date.now;
  Date.now = () => { throw Error('historical reconstruction may not read current clock'); };
  try { assert.deepEqual(verify(p, f), p); } finally { Date.now = originalNow; }
  assert.equal(verify(p, f).request.requestedAtMs, p.request.requestedAtMs);
  assert.equal(verify(p, f).request.originalExpiresAtMs, p.request.originalExpiresAtMs);
});
test('lookup rejects every inconsistent outer/request/context/execution hash, extra field and packet/pair drift', () => {
  for (const change of [p => { p.extra = true; }, p => { p.schemaVersion = 2; },
    p => { p.sourceAdmissionSha256 = hash('f'); }, p => { p.requestSha256 = hash('f'); },
    p => { p.request.inputSha256 = hash('f'); }, p => { p.request.context.contextSha256 = hash('f'); },
    p => { p.request.source.snapshotSha256 = hash('f'); }, p => { p.request.input.goal = 'changed'; },
    p => { p.request.context.draft.extra = true; }, p => { p.executionContext.prompt += 'changed'; },
    p => { p.executionContext.promptSha256 = hash('f'); }, p => { p.executionContext.contextPacketId = id(99); },
    p => { p.executionContext.ownerRefs[0].ownerRef = 'different'; },
    p => { p.executionContext.ownerRefs[0].clerkUserId = 'different'; }, p => { p.executionContext.extra = true; }]) {
    const f = fixture(), p = clone(create(f)); change(p); refused(() => verify(p, f), 'OUTCOME_UNCONFIRMED');
  }
});
test('lookup binds actual retained DTO/admission rather than accepting posted replacements', () => {
  const f = fixture(), p = create(f); f.dto.goal += 'changed'; refused(() => verify(p, f), 'OUTCOME_UNCONFIRMED');
  const g = fixture(), q = create(g); g.admission.consentId = id(99); refused(() => verify(q, g), 'OUTCOME_UNCONFIRMED');
});
test('coherence reconstruction explicitly does not establish immutable prompt custody from self-hashes', () => {
  const f = fixture(), p = clone(create(f)); p.executionContext.prompt = 'An internally coherent replacement';
  p.executionContext.promptSha256 = sha(p.executionContext.prompt);
  assert.deepEqual(verify(p, f), p);
  assert.notEqual(jcs(p), jcs(create(f))); // The service must pin the full publication and compiled prompt admission.
});
test('lookup refuses malformed proxy/accessor input without evaluating it', () => {
  let calls = 0; const f = fixture(), p = clone(create(f));
  Object.defineProperty(p.executionContext, 'prompt', { enumerable: true, get() { calls++; throw Error(); } });
  refused(() => verify(p, f), 'OUTCOME_UNCONFIRMED'); assert.equal(calls, 0);
});
