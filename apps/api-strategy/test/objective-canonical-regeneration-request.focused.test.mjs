// Pure source fixtures only. The parent executes bounded checks separately.
// Actual factory/common/basis-checker bodies are loaded; the unused owner
// DB functions are explicit throwing bindings, never custody or native proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const custody = [];
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
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
const initialUrl = await sourceModule('../src/meri/objective-canonical-request.ts', [
  ["'../planner/objective-canonical-application.js'", JSON.stringify(appUrl)],
  ["'./objective-canonical-generation.js'", JSON.stringify(genUrl)],
]);
const unusedVersionUrl = asModule("export const buildSnapshot=()=>{throw Error('UNUSED_DB_BASIS_OWNER_BINDING');};");
const unusedLedgerUrl = asModule("export const readCanonicalGenerationProducer=()=>{throw Error('UNUSED_DB_BASIS_OWNER_BINDING');};");
const unusedHistoryUrl = asModule("export const canonicalRegenerationSnapshot=()=>{throw Error('UNUSED_DB_HISTORY_OWNER_BINDING');};export const checkCanonicalRegenerationNormalization=()=>{throw Error('UNUSED_DB_HISTORY_OWNER_BINDING');};");
const basisUrl = await sourceModule('../src/meri/objective-canonical-basis.ts', [
  ["'../planner/objective-canonical-application.js'", JSON.stringify(appUrl)],
  ["'./objective-canonical-generation.js'", JSON.stringify(genUrl)],
  ["'../strategy/versioning.js'", JSON.stringify(unusedVersionUrl)],
  ["'./objective-canonical-producer-ledger.js'", JSON.stringify(unusedLedgerUrl)],
  ["'./objective-canonical-regeneration-ledger.js'", JSON.stringify(unusedHistoryUrl)],
]);
const requestUrl = await sourceModule('../src/meri/objective-canonical-regeneration-request.ts', [
  ["'../planner/objective-canonical-application.js'", JSON.stringify(appUrl)],
  ["'./objective-canonical-generation.js'", JSON.stringify(genUrl)],
  ["'./objective-canonical-basis.js'", JSON.stringify(basisUrl)],
  ["'./objective-canonical-request.js'", JSON.stringify(initialUrl)],
]);
const { applicationHash } = await import(appUrl);
const { canonicalGenerationAdmissionSha256, generationLedgerId, GENERATION_ADMISSION, GENERATION_ACCEPTANCE,
  GENERATION_NORMALIZATION, GENERATION_PRODUCER } = await import(genUrl);
const { candidateJcsSha256: jcs, privateRequestJcsSha256: privateJcs, createCanonicalRequestPublication: initialCreate,
  checkCanonicalRequestPublication: initialCheck, CANONICAL_STRATEGY_CANDIDATE_VERSION } = await import(initialUrl);
const { createCanonicalRegenerationRequestPublication: create, checkCanonicalRegenerationRequestPublication: check,
  CORE_CANONICAL_REGENERATION_REQUEST_VERSION, CANONICAL_REGENERATION_REQUEST_MAX_BYTES } = await import(requestUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hash = c => c.repeat(64);
const clone = value => structuredClone(value);
const start = Date.parse('2026-10-16T06:00:00.000Z');
const refused = (run, code) => assert.throws(run, e => code ? e.code === code :
  ['INPUT_INVALID', 'REQUEST_CONFLICT', 'AUTHORITY_UNAVAILABLE', 'OUTCOME_UNCONFIRMED'].includes(e.code));
function node(nodeId, title, machine = true) {
  return { id: nodeId, kind: 'action', subject: 'Exact subject', title, note: null,
    ownerUserId: 'user_fixture', status: 'planned', startsOn: '2026-10-16', endsOn: null,
    openEnded: true, dependsOnIds: [], meriAuthored: machine,
    createdByUserId: machine ? 'user_fixture' : 'user_human', createdAt: '2026-10-15T12:00:00.000Z' };
}
function sealBasis(basis) {
  basis.snapshotSha256 = applicationHash(basis.snapshot);
  basis.sourceIndexSha256 = applicationHash(basis.sourceIndex);
  basis.archiveIndexSha256 = applicationHash(basis.archiveIndex);
  return basis;
}
function fixture() {
  const source = { clientId: id(3), objectiveId: id(4), objectiveVersion: 2, objectiveRevisionId: id(8) };
  const intent = { outcome: 'Preserve reviewed human work', governmentProblem: 'Read the actual evidence',
    askType: 'meri_propose', minimumWin: 'A preserving proposal', limits: '' };
  const prompt = 'Actual governed prompt\nHistorical accepted recommendation remains a recommendation.\n';
  const admission = { schemaVersion: 1, namespace: 'capiro.objective-strategy.admission:v1',
    canonical: { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
      canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
      requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 2, snapshotHash: hash('a') },
    actorUserId: id(9), clerkUserId: 'user_fixture', consentId: id(12), controlVersion: 3,
    generationJobId: id(10), generationRequestId: id(11), admittedAtMs: start - 60_000,
    effectExpiresAtMs: start + 1_800_000, expectedStrategyVersionId: id(50) };
  const meta = { id: id(5), clientId: id(3), title: 'Human current title', type: 'authorization',
    goal: 'Human current goal', meriContext: null, meriSummary: 'Prior machine summary', targetDate: null,
    ownerUserId: 'user_fixture', createdByUserId: 'user_fixture', createdAt: '2026-10-15T12:00:00.000Z' };
  const oldJob = id(51), normId = generationLedgerId(GENERATION_NORMALIZATION, id(2), 'user_fixture', oldJob);
  const basis = sealBasis({ schemaVersion: 1, namespace: 'capiro.objective-strategy.basis:v1',
    canonical: clone(admission.canonical), sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
    strategyId: id(5), expectedStrategyVersionId: id(50), snapshot: { meta,
      nodes: [node(id(60), 'Human edited machine title'), node(id(61), 'Human-only node', false)] },
    archiveIndex: [{ nodeId: id(62), archivedAt: '2026-10-16T05:00:00.000Z' }],
    sourceIndex: [
      { sourceNodeKey: 'archived_step', nodeId: id(62), archived: true,
        lastMachine: { normalizationId: normId, node: node(id(62), 'Archived prior machine node') } },
      { sourceNodeKey: 'machine_step', nodeId: id(60), archived: false,
        lastMachine: { normalizationId: normId, node: node(id(60), 'Original machine title') } },
    ],
    lastMachineStrategy: { normalizationId: normId, meta: { ...clone(meta), title: 'Prior machine title', goal: 'Prior machine goal' } },
    provenance: [{ ownerUserId: 'user_fixture', generationJobId: oldJob, generationRequestId: id(52), canonicalBindingVersion: 1,
      admissionId: generationLedgerId(GENERATION_ADMISSION, id(2), 'user_fixture', oldJob), admissionSha256: hash('b'),
      acceptanceId: generationLedgerId(GENERATION_ACCEPTANCE, id(2), 'user_fixture', oldJob), acceptanceSha256: hash('c'),
      normalizationId: normId, normalizationSha256: hash('d'),
      producerId: generationLedgerId(GENERATION_PRODUCER, id(2), 'user_fixture', oldJob), producerSha256: hash('e'),
      strategyVersionId: id(53), snapshotSha256: hash('f') }],
  });
  return { admission, basis, dto: { clientId: id(3), type: 'authorization', goal: '  Original queued goal\n', meriContext: null,
    ownerUserId: null, targetDate: '2028-02-29', attachmentIds: [] },
    context: { schemaVersion: 1, tenantId: id(2), clerkUserId: 'user_fixture', requestId: id(11), source, intent,
      snapshotSha256: hash('a'), sourceDigest: applicationHash({ source, intent }), packetId: id(20),
      compiledAt: '2026-10-16T06:00:00.000Z', coverageDigest: hash('b'), promptSha256: sha(prompt), evidence: [
        { ref: `profile-fill:${id(30)}:${hash('c')}`, sourceId: id(30), asOfMs: start - 5_000,
          scope: 'client', clientId: id(3), reviewState: 'accepted' },
        { ref: `profile-fill:${id(31)}:${hash('d')}`, sourceId: id(31), asOfMs: start - 1_000,
          scope: 'client', clientId: id(3), reviewState: 'pending' },
      ] }, prompt, owners: [{ ownerRef: 'owner:fixture', clerkUserId: 'user_fixture' }],
    delegation: { ref: id(40), revision: 'genuine-delegation-revision:7', issuedAtMs: start - 120_000,
      absoluteExpiresAtMs: start + 3_600_000 }, requestedAtMs: start + 1_000, effectExpiresAtMs: start + 1_200_000 };
}
const verify = (p, f) => check(p, { admission: f.admission, dto: f.dto });
function initialFixture() {
  const { basis: _basis, ...f } = fixture(); f.admission.expectedStrategyVersionId = null; return f;
}

test('source custody declares actual pure modules and unused DB owner bindings', t => {
  assert.deepEqual(custody.map(x => x.replacementSpecifiers.length), [0, 1, 2, 5, 4]);
  t.diagnostic(JSON.stringify({ sourceCustody: custody,
    ownerBindings: 'buildSnapshot/readCanonicalGenerationProducer/canonicalRegenerationSnapshot/checkCanonicalRegenerationNormalization throw if called; no DB/history custody qualification' }));
});
test('private regeneration version retains draft operation and exact five publication fields', () => {
  const f = fixture(), before = clone(f), p = create(f), r = p.request;
  assert.deepEqual(f, before); assert.deepEqual(verify(p, f), p);
  assert.deepEqual(Object.keys(p).sort(), ['executionContext', 'request', 'requestSha256', 'schemaVersion', 'sourceAdmissionSha256']);
  assert.equal(r.requestVersion, CORE_CANONICAL_REGENERATION_REQUEST_VERSION);
  assert.equal(r.requestVersion, 'capiro.objective-strategy.regeneration-request/20261016.1');
  assert.equal(r.operation, 'strategy.draft'); assert.equal(Object.hasOwn(r, 'candidateVersion'), false);
  assert.equal(r.requestId, f.admission.generationRequestId); assert.equal(r.jobId, f.admission.generationJobId);
  assert.equal(p.sourceAdmissionSha256, canonicalGenerationAdmissionSha256(f.admission));
});
test('application target binds every actual canonical pin and the existing sealed version', () => {
  const f = fixture(), p = create(f);
  assert.deepEqual(p.request.applicationTarget, { mode: 'regenerate', canonical: f.admission.canonical,
    expectedStrategyVersionId: id(50) });
  assert.deepEqual(Object.keys(p.request.applicationTarget.canonical).sort(), Object.keys(f.admission.canonical).sort());
  for (const key of Object.keys(f.admission.canonical)) {
    const bad = clone(p); bad.request.applicationTarget.canonical[key] = typeof bad.request.applicationTarget.canonical[key] === 'number' ? 99 : id(999);
    refused(() => verify(bad, f), 'OUTCOME_UNCONFIRMED');
  }
});
test('whole actual basis preserves human edits/manual nodes/archives and last machine baselines', () => {
  const f = fixture(), p = create(f), b = p.request.basis;
  assert.deepEqual(b, f.basis); assert.equal(p.request.basisSha256, applicationHash(f.basis));
  assert.equal(b.snapshot.nodes[0].title, 'Human edited machine title');
  assert.equal(b.sourceIndex[1].lastMachine.node.title, 'Original machine title');
  assert.equal(b.snapshot.nodes[1].meriAuthored, false); assert.equal(b.snapshot.nodes[1].id, id(61));
  assert.equal(b.sourceIndex.some(s => s.nodeId === id(61)), false);
  assert.deepEqual(b.archiveIndex, f.basis.archiveIndex); assert.deepEqual(b.provenance, f.basis.provenance);
});
test('request/input/context hashes bind exact distinct payloads and complete basis', () => {
  const p = create(fixture()), r = p.request;
  const { inputSha256, ...withoutInput } = r, { contextSha256, ...withoutContext } = r.context;
  assert.equal(inputSha256, privateJcs(withoutInput)); assert.equal(contextSha256, jcs(withoutContext));
  assert.equal(p.requestSha256, privateJcs(r)); assert.equal(r.basisSha256, applicationHash(r.basis));
  assert.notEqual(r.basisSha256, r.basis.snapshotSha256); assert.notEqual(inputSha256, privateJcs(r.input));
});
test('private finite-number JCS preserves opaque basis confidence while the initial helper remains restricted', () => {
  assert.equal(privateJcs({ confidence: 0.75, detail: { weight: 1e-7 }, minusZero: -0 }),
    sha('{"confidence":0.75,"detail":{"weight":1e-7},"minusZero":0}'));
  refused(() => jcs({ confidence: 0.75 }), 'INPUT_INVALID');
  const f = fixture();
  f.basis.snapshot.nodes[0].provenance = { sources: [{ sourceId: 'literal-source', confidence: 0.75 }] };
  f.basis.snapshot.nodes[1].targetRef = { selector: 'human', ranking: 0.125 };
  f.basis.sourceIndex[1].lastMachine.node.provenance = { sources: [{ confidence: 0.5 }] };
  sealBasis(f.basis);
  const p = create(f); assert.deepEqual(p.request.basis, f.basis);
  assert.equal(p.request.basis.snapshot.nodes[0].provenance.sources[0].confidence, 0.75);
  assert.equal(p.request.basis.snapshot.nodes[1].targetRef.ranking, 0.125);
  assert.equal(p.request.basisSha256, applicationHash(f.basis)); assert.equal(p.requestSha256, privateJcs(p.request));
  assert.deepEqual(verify(p, f), p); refused(() => jcs(p.request), 'INPUT_INVALID');
});
test('private finite JSON still rejects nonfinite/Unicode/proxy input and typed counters/times remain safe integers', () => {
  for (const value of [NaN, Infinity, -Infinity, '\ud800', { ['\ud800']: 1 }]) refused(() => privateJcs(value), 'INPUT_INVALID');
  let calls = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 0.75; } });
  refused(() => privateJcs(getter), 'INPUT_INVALID');
  refused(() => privateJcs(new Proxy({}, { ownKeys() { calls++; return []; } })), 'INPUT_INVALID');
  assert.equal(calls, 0);
  for (const mutate of [f => { f.requestedAtMs += 0.5; }, f => { f.delegation.issuedAtMs += 0.5; },
    f => { f.context.evidence[0].asOfMs += 0.5; }, f => { f.admission.canonical.bindingVersion = 2.5; }]) {
    const f = fixture(); mutate(f); refused(() => create(f));
  }
});
test('initial factory/checker retain exact external4d8 format and refuse regeneration admission', () => {
  const f = initialFixture(), p = initialCreate(f);
  assert.equal(p.request.candidateVersion, CANONICAL_STRATEGY_CANDIDATE_VERSION);
  assert.equal(p.request.operation, 'strategy.draft'); assert.equal(p.request.basis, null);
  assert.equal(Object.hasOwn(p.request, 'requestVersion'), false); assert.equal(Object.hasOwn(p.request, 'applicationTarget'), false);
  assert.deepEqual(initialCheck(p, { admission: f.admission, dto: f.dto }), p);
  const regen = fixture(), { basis: _basis, ...initialWithExistingVersion } = regen;
  refused(() => initialCreate(initialWithExistingVersion), 'AUTHORITY_UNAVAILABLE');
  refused(() => create({ ...f, basis: regen.basis }), 'AUTHORITY_UNAVAILABLE');
  refused(() => verify(p, regen), 'OUTCOME_UNCONFIRMED');
  refused(() => initialCheck(create(regen), { admission: regen.admission, dto: regen.dto }), 'OUTCOME_UNCONFIRMED');
});
test('nonnull actual basis and existing version are mandatory; unknown outer fields refuse', () => {
  for (const mutate of [f => { f.basis = null; }, f => { delete f.basis; }, f => { f.extra = true; },
    f => { f.admission.expectedStrategyVersionId = null; }, f => { f.basis.schemaVersion = 2; },
    f => { f.basis.namespace = 'unallocated:basis'; }]) {
    const f = fixture(); mutate(f); refused(() => create(f));
  }
});
test('basis source/scope/version/full hashes must match actual admission and contents', () => {
  for (const mutate of [b => { b.strategyId = id(999); }, b => { b.canonical.tenantId = id(999); },
    b => { b.expectedStrategyVersionId = id(999); }, b => { b.sourceAdmissionSha256 = hash('f'); },
    b => { b.snapshot.nodes[0].title = 'unhashed change'; }, b => { b.archiveIndex[0].nodeId = id(999); },
    b => { b.sourceIndex[0].sourceNodeKey = 'unhashed_key'; }]) {
    const f = fixture(); mutate(f.basis); refused(() => create(f));
  }
});
test('self-hashed inconsistent source/archive identity and invented normalization references refuse', () => {
  for (const mutate of [b => { b.sourceIndex[0].archived = false; }, b => { b.sourceIndex[1].nodeId = id(999); },
    b => { b.sourceIndex[1].lastMachine.node.id = id(999); }, b => { b.sourceIndex[1].lastMachine.normalizationId = id(999); },
    b => { b.archiveIndex.push(clone(b.archiveIndex[0])); }, b => { b.sourceIndex.reverse(); },
    b => { b.provenance[0].normalizationId = id(999); }, b => { b.provenance[0].canonicalBindingVersion = 2; }]) {
    const f = fixture(); mutate(f.basis); sealBasis(f.basis); refused(() => create(f));
  }
});
test('closed retained request/target/context/publication refuse extra or altered fields', () => {
  const f = fixture(), p = create(f);
  for (const mutate of [x => { x.extra = 1; }, x => { x.request.extra = 1; },
    x => { x.request.candidateVersion = CANONICAL_STRATEGY_CANDIDATE_VERSION; },
    x => { x.request.requestVersion = 'future-unallocated-version'; }, x => { x.request.operation = 'strategy.edit'; },
    x => { x.request.applicationTarget.mode = 'initial'; }, x => { x.request.applicationTarget.extra = 1; },
    x => { x.request.context.extra = 1; }, x => { x.executionContext.extra = 1; },
    x => { x.request.basisSha256 = hash('f'); }, x => { x.request.inputSha256 = hash('f'); }]) {
    const bad = clone(p); mutate(bad); refused(() => verify(bad, f), 'OUTCOME_UNCONFIRMED');
  }
});
test('raw queued DTO/null normalization/selected owner and evidence states remain exact', () => {
  const f = fixture(); f.dto.goal = ''; f.dto.meriContext = '  literal\n'; f.dto.ownerUserId = '  user_selected  ';
  f.owners.push({ ownerRef: 'owner:selected', clerkUserId: 'user_selected' });
  const p = create(f); assert.equal(p.request.input.goal, ''); assert.equal(p.request.input.meriContext, '  literal\n');
  assert.equal(p.request.input.ownerUserId, '  user_selected  '); assert.equal(p.request.principal.ownerActorId, 'user_selected');
  assert.deepEqual(p.request.context.evidence, f.context.evidence); assert.deepEqual(p.executionContext.ownerRefs, f.owners);
  assert.equal(p.request.context.evidence[1].reviewState, 'pending');
});
test('unresolved requested attachments, unmapped owners, source drift and promoted evidence refuse', () => {
  for (const mutate of [f => { f.dto.attachmentIds = ['requested-file']; }, f => { f.dto.ownerUserId = 'unknown_owner'; },
    f => { f.context.snapshotSha256 = hash('f'); }, f => { f.context.sourceDigest = hash('f'); },
    f => { f.context.evidence[1].reviewState = 'verified'; }, f => { f.context.evidence[1].scope = 'tenant-shared'; },
    f => { f.context.evidence[1].clientId = id(999); }]) {
    const f = fixture(); mutate(f); refused(() => create(f));
  }
});
test('delegation is genuine required metadata and original expiry clips without renewal', () => {
  const f = fixture(); f.delegation.absoluteExpiresAtMs = start + 15_000;
  const p = create(f); assert.equal(p.request.originalExpiresAtMs, start + 15_000);
  assert.deepEqual(p.request.delegation, f.delegation);
  for (const mutate of [x => { x.delegation = null; }, x => { x.delegation.ref = 'derived-from-consent'; },
    x => { x.delegation.issuedAtMs = start + 2_000; }, x => { x.effectExpiresAtMs = start; },
    x => { x.delegation.absoluteExpiresAtMs = x.delegation.issuedAtMs + 86_400_001; }]) {
    const bad = fixture(); mutate(bad); refused(() => create(bad));
  }
  const capped = create(fixture()); assert.equal(capped.request.originalExpiresAtMs, capped.request.requestedAtMs + 900_000);
});
test('retained reconstruction uses original times after expiry and never calls current clock', () => {
  const f = fixture(), p = create(f), originalNow = Date.now;
  try { Date.now = () => { throw Error('UNEXPECTED_WALL_CLOCK'); }; assert.deepEqual(verify(p, f), p); }
  finally { Date.now = originalNow; }
  const bad = clone(p); bad.request.originalExpiresAtMs += 1; refused(() => verify(bad, f), 'OUTCOME_UNCONFIRMED');
});
test('retained coherence is not sidecar custody; stored whole-publication and compiled prompt pins remain required', () => {
  const f = fixture(), p = create(f), changed = clone(p);
  changed.executionContext.prompt += ' altered'; changed.executionContext.promptSha256 = sha(changed.executionContext.prompt);
  const coherent = verify(changed, f); assert.notEqual(privateJcs(coherent), privateJcs(p));
  assert.equal(coherent.executionContext.prompt, changed.executionContext.prompt);
});
test('safe JSON validation rejects getters/proxies/sparse/invalid Unicode without executing them', () => {
  let calls = 0;
  const f = fixture(); Object.defineProperty(f.basis.snapshot.meta, 'title', { enumerable: true, get() { calls++; throw Error(); } });
  refused(() => create(f)); assert.equal(calls, 0);
  const proxy = new Proxy({}, { ownKeys() { calls++; throw Error(); } }); refused(() => create(proxy)); assert.equal(calls, 0);
  for (const value of ['\ud800', 1.5, new Array(1)]) {
    const bad = fixture(); bad.basis.snapshot.meta.goal = value; refused(() => create(bad));
  }
});
test('whole private request/publication bounds refuse rather than truncate and outputs are frozen clones', () => {
  const f = fixture(), p = create(f); assert.equal(CANONICAL_REGENERATION_REQUEST_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(Object.isFrozen(p.request.basis.snapshot.nodes), true); assert.equal(Object.isFrozen(p.executionContext.ownerRefs), true);
  const bad = fixture(); bad.basis.snapshot.nodes[1].note = 'x'.repeat(CANONICAL_REGENERATION_REQUEST_MAX_BYTES);
  sealBasis(bad.basis); refused(() => create(bad), 'INPUT_INVALID');
  f.basis.snapshot.nodes[0].title = 'later caller mutation'; assert.notEqual(p.request.basis.snapshot.nodes[0].title, f.basis.snapshot.nodes[0].title);
});
