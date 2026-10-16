'use strict';
// One bounded, local actual-source regression. Never emits keys or token bytes.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const root = __dirname;
const receiptPath = path.join(root, 'retained-codec-real-jcs-check.receipt.json');
const canonicalizePath = 'C:/Users/neoma/Documents/Codex/2026-10-15/task-4/meri-greenfield/node_modules/canonicalize/lib/canonicalize.js';
const packagePath = path.resolve(path.dirname(canonicalizePath), '../package.json');
const sourceRoot = path.join(root, 'backend-retained-authority/packages/shared/src');
const names = ['core-retained-principal.ts', 'core-retained-principal.spec.ts', 'core-retained-authority-probe.ts', 'core-retained-authority-probe.spec.ts'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileFacts = filename => { const bytes = fs.readFileSync(filename); return { path: filename, bytes: bytes.length, sha256: sha(bytes) }; };
const receipt = {
  command: 'node --max-old-space-size=128 retained-codec-real-jcs-check.cjs',
  startedAt: new Date().toISOString(), node: process.version, maxOldSpaceSizeMiB: 128,
  observedHeapSizeLimitBytes: v8.getHeapStatistics().heap_size_limit,
  baselineStructuralChecks: 0, realJcsChecks: [], sourceEdits: false, network: false,
  install: false, jest: false, build: false, database: false, provider: false,
  syntheticInMemoryKeysOnly: true, keyPersistence: false, tokensOrKeysEmitted: false,
  qualification: 'Pure actual-source crypto/codec regression; not live authority, transport, business, deployment or integration qualification.',
  earlierUnrunRecord: 'Earlier 62-check run had no installed JCS in its checked runtime. That historical unrun result is preserved; this separate run uses newly supplied read-only dependency evidence.',
};
let stage = 'initialization';
function test(name, fn) {
  try { fn(); receipt.realJcsChecks.push({ name, passed: true }); }
  catch (error) { receipt.realJcsChecks.push({ name, passed: false, errorClass: error && error.constructor ? error.constructor.name : 'unknown' }); }
}
function ok(condition) { if (!condition) throw new Error('Check failed'); }
function rejects(fn, Type) {
  let error;
  try { fn(); } catch (caught) { error = caught; }
  if (!(error instanceof Type)) throw new Error('Expected closed denial not observed');
}
try {
  // Read the newly allowed package directly. Any permission failure ends this
  // run; there is no fallback path, elevation, download or alternate dependency.
  stage = 'read supplied JCS package';
  receipt.jcs = { ...fileFacts(canonicalizePath), package: fileFacts(packagePath), version: JSON.parse(fs.readFileSync(packagePath, 'utf8')).version };
  const jcsModule = require(canonicalizePath);
  const canonicalize = typeof jcsModule === 'function' ? jcsModule : jcsModule.default;
  ok(typeof canonicalize === 'function');
  stage = 'transpile actual source in memory';
  const dep = require('./current-authority-runtime/paths.cjs').dependencyRequire;
  const ts = dep('typescript');
  receipt.typescriptVersion = ts.version;
  const sourceBytes = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(sourceRoot, name))]));
  receipt.sources = names.map(name => ({ name, bytes: sourceBytes[name].length, sha256: sha(sourceBytes[name]) }));
  const output = {};
  receipt.syntaxDiagnosticCount = 0;
  for (const name of names) {
    const compiled = ts.transpileModule(sourceBytes[name].toString('utf8'), { fileName: name, reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
    receipt.syntaxDiagnosticCount += (compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length;
    output[name] = compiled.outputText;
  }
  ok(receipt.syntaxDiagnosticCount === 0);
  const load = name => { const mod = new Module(path.join(sourceRoot, name), module); mod._compile(output[name], path.join(sourceRoot, name)); return mod.exports; };
  const d = load(names[0]), p = load(names[2]);
  const keys = crypto.generateKeyPairSync('ed25519');
  const otherKeys = crypto.generateKeyPairSync('ed25519');
  const now = 1800000000000, bounds = { nowMs: now, deadlineMs: now + 30000 }, h = '1'.repeat(64);
  const principal = { tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', actorId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', clerkUserId: 'arbitrary-current-subject' };
  const common = { principal, identityRevision: h, currentAuthority: '{}', issuedAtMs: now, originalExpiresAtMs: bounds.deadlineMs };
  const selector = { schemaVersion: 1, sessionKey: '', folderId: null, clientSelector: null };
  const probePins = { keyId: 'test', issuer: 'test-core', audienceOrigin: 'https://intel.invalid',
    recipientPath: p.CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH, operation: p.CORE_RETAINED_AUTHORITY_PROBE_OPERATION };
  const P = p.CoreRetainedAuthorityProbeInvalidError, PU = p.CoreRetainedAuthorityProbeUnavailableError;
  const D = d.CoreRetainedPrincipalInvalidError, DU = d.CoreRetainedPrincipalUnavailableError;
  const dataFacts = { ...common, resourceRevision: h, rawRequestSha256: h, normalizedArgsSha256: h, normalizationContextSha256: h };
  const probeInput = { ...common, selector }, probeBounds = { ...bounds, selector };
  const dataBounds = { ...bounds, expectedDigests: { rawRequestSha256: h, normalizedArgsSha256: h, normalizationContextSha256: h } };
  const rawWire = (value, prefix) => prefix + Buffer.from(JSON.stringify(value)).toString('base64url');
  const probePrefix = 'CapiroRetainedAuthority ', dataPrefix = 'CapiroRetained ';
  stage = 'repeat earlier 62 structural/default/boundary checks';
  {
    let calls = 0, touched = 0, checks = 0;
    const never = () => { calls++; throw new Error('No JCS provider'); };
    const pins = { ...probePins, canonicalize: never };
    const ps = p.createCoreRetainedAuthorityProbeSigner({ ...pins, privateKey: keys.privateKey });
    const pv = p.createCoreRetainedAuthorityProbeCryptographicVerifier({ ...pins, publicKey: keys.publicKey });
    const ds = d.createCoreRetainedPrincipalSigner({ ...pins, privateKey: keys.privateKey });
    const dv = d.createCoreRetainedPrincipalCryptographicVerifier({ ...pins, publicKey: keys.publicKey });
    const no = (fn, Type) => { rejects(fn, Type); checks++; };
    no(() => p.createCoreRetainedAuthorityProbeSigner().sign(null, bounds), PU);
    no(() => p.createCoreRetainedAuthorityProbeCryptographicVerifier().verifyCryptographically(null, probeBounds), PU);
    no(() => d.createCoreRetainedPrincipalSigner().sign(null, bounds), DU);
    assert.deepEqual(p.parseCoreRetainedAuthorityProbeBody({ schemaVersion: 1, selector }), { schemaVersion: 1, selector }); checks++;
    ok(Object.isFrozen(p.parseCoreRetainedAuthorityProbeSelector(selector))); checks++;
    for (const change of [{ sessionKey: 'x'.repeat(257) }, { sessionKey: null }, { folderId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' },
      { clientSelector: '' }, { clientSelector: ' x' }, { clientSelector: 'x'.repeat(257) }, { clientSelector: undefined }, { extra: 1 }])
      no(() => p.parseCoreRetainedAuthorityProbeSelector({ ...selector, ...change }), P);
    for (const body of [{ selector }, { schemaVersion: 1, selector, resourceRevision: h }, { schemaVersion: 1, selector, request: {} }, { schemaVersion: 2, selector }])
      no(() => p.parseCoreRetainedAuthorityProbeBody(body), P);
    const getter = { ...selector };
    Object.defineProperty(getter, 'sessionKey', { get() { touched++; throw new Error('getter'); }, enumerable: true });
    no(() => p.parseCoreRetainedAuthorityProbeSelector(getter), P);
    no(() => p.parseCoreRetainedAuthorityProbeSelector(new Proxy(selector, { ownKeys() { touched++; throw new Error('proxy'); } })), P);
    ok(touched === 0); checks++;
    for (const [signer, input, ErrorType] of [[ps, probeInput, P], [ds, dataFacts, D]]) {
      for (const change of [{ currentAuthority: JSON.stringify('x'.repeat(4095)) }, { currentAuthority: JSON.stringify('界'.repeat(1365)) },
        { issuedAtMs: now + 1 }, { issuedAtMs: -0 }, { originalExpiresAtMs: now }, { originalExpiresAtMs: now + 30001 }])
        no(() => signer.sign({ ...input, ...change }, bounds), ErrorType);
      for (const clerkUserId of ['', 'x'.repeat(257), 'has whitespace'])
        no(() => signer.sign({ ...input, principal: { ...principal, clerkUserId } }, bounds), ErrorType);
      no(() => signer.sign(input, { ...bounds, deadlineMs: bounds.deadlineMs - 1 }), ErrorType);
    }
    for (const change of [{ resourceRevision: h }, { rawRequestSha256: h }, { selectorSha256: h }]) no(() => ps.sign({ ...probeInput, ...change }, bounds), P);
    for (const change of [{ recipientPath: '/wrong' }, { operation: 'get_research_portfolio' }, { keyId: 'k'.repeat(257) },
      { issuer: 'i'.repeat(257) }, { audienceOrigin: 'https://intel.invalid/' }])
      no(() => p.createCoreRetainedAuthorityProbeSigner({ ...pins, ...change, privateKey: keys.privateKey }), PU);
    const pf = { schemaVersion: 1, purpose: 'capiro-retained-florida-authority', algorithm: 'Ed25519', ...probePins,
      ...common, selectorSha256: h, signature: 'A'.repeat(86) };
    const df = { schemaVersion: 1, purpose: 'capiro-retained-read-principal', algorithm: 'Ed25519', ...probePins,
      ...dataFacts, signature: 'A'.repeat(86) };
    for (const prefix of [dataPrefix, probePrefix]) {
      no(() => pv.verifyCryptographically(rawWire(df, prefix), probeBounds), P);
      no(() => dv.verifyCryptographically(rawWire(pf, prefix), dataBounds), D);
    }
    for (const change of [{ purpose: 'capiro-retained-read-principal' }, { resourceRevision: h }, { algorithm: 'HS256' },
      { recipientPath: '/wrong' }, { signature: 'A'.repeat(85) + 'B' }])
      no(() => pv.verifyCryptographically(rawWire({ ...pf, ...change }, probePrefix), probeBounds), P);
    ok(calls === 0); checks++;
    const authority = JSON.stringify('é'.repeat(2047)); ok(Buffer.byteLength(authority) === 4096); checks++;
    for (const [factory, input, ErrorType] of [[p.createCoreRetainedAuthorityProbeSigner, probeInput, PU], [d.createCoreRetainedPrincipalSigner, dataFacts, DU]]) {
      const signer = factory({ ...pins, keyId: 'k'.repeat(256), issuer: 'i'.repeat(256), privateKey: keys.privateKey });
      no(() => signer.sign({ ...input, currentAuthority: authority, principal: { ...principal, clerkUserId: 'x'.repeat(256) } }, bounds), ErrorType);
    }
    ok(calls === 2); checks++;
    ok(checks === 62); receipt.baselineStructuralChecks = checks;
  }
  stage = 'actual JCS/Ed25519 regression';
  const dataPins = { ...probePins, recipientPath: '/internal/synthetic-retained-data', canonicalize };
  const actualProbePins = { ...probePins, canonicalize };
  const ds = d.createCoreRetainedPrincipalSigner({ ...dataPins, privateKey: keys.privateKey });
  const dv = d.createCoreRetainedPrincipalCryptographicVerifier({ ...dataPins, publicKey: keys.publicKey });
  const ps = p.createCoreRetainedAuthorityProbeSigner({ ...actualProbePins, privateKey: keys.privateKey });
  const pv = p.createCoreRetainedAuthorityProbeCryptographicVerifier({ ...actualProbePins, publicKey: keys.publicKey });
  const digest = value => sha(Buffer.from(canonicalize(value), 'utf8'));
  const decode = (header, prefix) => JSON.parse(Buffer.from(header.slice(prefix.length), 'base64url').toString('utf8'));
  const jcsWire = (value, prefix) => prefix + Buffer.from(canonicalize(value), 'utf8').toString('base64url');
  const resourceVector = { portfolioId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', role: 'viewer', revision: 7, linkedClientId: null };
  const rawRequest = { schemaVersion: 1, query: 'Zoë 東京', limit: 25 };
  const normalizedArgs = { query: rawRequest.query, limit: rawRequest.limit };
  const normalizationContext = { asOf: now, sessionKey: '', folderId: null, clientId: null };
  const actualFacts = { ...dataFacts, resourceRevision: digest(resourceVector), rawRequestSha256: digest(rawRequest),
    normalizedArgsSha256: digest(normalizedArgs), normalizationContextSha256: digest(normalizationContext) };
  const actualDataBounds = { ...bounds, expectedDigests: { rawRequestSha256: actualFacts.rawRequestSha256,
    normalizedArgsSha256: actualFacts.normalizedArgsSha256, normalizationContextSha256: actualFacts.normalizationContextSha256 } };
  const dataHeader = ds.sign(actualFacts, bounds), probeHeader = ps.sign(probeInput, bounds);
  const dataEnvelope = decode(dataHeader, dataPrefix), probeEnvelope = decode(probeHeader, probePrefix);
  test('real JCS fixed selector Unicode/null/version vector', () => {
    const value = { ...selector, clientSelector: 'Zoë 東京' };
    ok(canonicalize(value) === '{"clientSelector":"Zoë 東京","folderId":null,"schemaVersion":1,"sessionKey":""}');
    ok(p.coreRetainedAuthorityProbeSelectorSha256(value, canonicalize) === digest(value));
    ok(digest(value) !== digest({ sessionKey: value.sessionKey, clientSelector: value.clientSelector, folderId: null }));
  });
  test('data resource vector and actual raw/normalized/context digests round-trip', () => {
    const value = dv.verifyCryptographically(dataHeader, actualDataBounds);
    ok(value.resourceRevision === digest(resourceVector)); ok(value.rawRequestSha256 === digest(rawRequest));
    ok(value.normalizedArgsSha256 === digest(normalizedArgs)); ok(value.normalizationContextSha256 === digest(normalizationContext));
    ok(Object.isFrozen(value) && Object.isFrozen(value.principal));
  });
  for (const operation of ['get_research_portfolio', 'get_research_portfolio_changes', 'get_florida_budget_project']) test('data pinned operation ' + operation, () => {
    const signer = d.createCoreRetainedPrincipalSigner({ ...dataPins, operation, privateKey: keys.privateKey });
    const verifier = d.createCoreRetainedPrincipalCryptographicVerifier({ ...dataPins, operation, publicKey: keys.publicKey });
    ok(verifier.verifyCryptographically(signer.sign(actualFacts, bounds), actualDataBounds).operation === operation);
  });
  test('probe round-trip obtains selector commitment without data/resource claims', () => {
    const value = pv.verifyCryptographically(probeHeader, probeBounds);
    ok(value.selectorSha256 === digest(selector)); ok(Object.isFrozen(value) && Object.isFrozen(value.principal));
    for (const field of ['resourceRevision', 'rawRequestSha256', 'normalizedArgsSha256', 'normalizationContextSha256', 'selector']) ok(!(field in value));
  });
  for (const [name, envelope, domain, wrongDomain] of [
    ['data', dataEnvelope, 'capiro-retained-read-principal-v1\n', 'capiro-retained-florida-authority-v1\n'],
    ['probe', probeEnvelope, 'capiro-retained-florida-authority-v1\n', 'capiro-retained-read-principal-v1\n'],
  ]) test(name + ' actual newline domain and independent Node Ed25519 verification', () => {
    const { signature, ...unsigned } = envelope, sig = Buffer.from(signature, 'base64url');
    ok(sig.length === 64); ok(crypto.verify(null, Buffer.from(domain + canonicalize(unsigned)), keys.publicKey, sig));
    ok(!crypto.verify(null, Buffer.from(wrongDomain + canonicalize(unsigned)), keys.publicKey, sig));
    ok(!crypto.verify(null, Buffer.from(domain.replace('\n', '\\n') + canonicalize(unsigned)), keys.publicKey, sig));
  });
  for (const [field, value] of [
    ['identityRevision', '6'.repeat(64)], ['resourceRevision', '7'.repeat(64)], ['currentAuthority', '{"changed":true}'],
    ['rawRequestSha256', '8'.repeat(64)], ['normalizedArgsSha256', '8'.repeat(64)], ['normalizationContextSha256', '8'.repeat(64)],
    ['issuedAtMs', now - 1], ['originalExpiresAtMs', bounds.deadlineMs - 1], ['keyId', 'other-key'],
    ['issuer', 'other-core'], ['audienceOrigin', 'https://other.invalid'], ['recipientPath', '/other'],
    ['operation', 'get_research_portfolio'], ['purpose', 'capiro-retained-florida-authority'], ['algorithm', 'HS256'], ['schemaVersion', 2],
  ]) test('data denies tampering ' + field, () => rejects(() => dv.verifyCryptographically(jcsWire({ ...dataEnvelope, [field]: value }, dataPrefix), actualDataBounds), D));
  for (const [field, value] of [['tenantId', 'cccccccc-cccc-cccc-cccc-cccccccccccc'], ['actorId', 'cccccccc-cccc-cccc-cccc-cccccccccccc'], ['clerkUserId', 'different-clerk']])
    test('data denies principal tampering ' + field, () => rejects(() => dv.verifyCryptographically(jcsWire({ ...dataEnvelope, principal: { ...principal, [field]: value } }, dataPrefix), actualDataBounds), D));
  for (const key of ['rawRequestSha256', 'normalizedArgsSha256', 'normalizationContextSha256']) test('data binds actual expected ' + key, () =>
    rejects(() => dv.verifyCryptographically(dataHeader, { ...actualDataBounds, expectedDigests: { ...actualDataBounds.expectedDigests, [key]: '9'.repeat(64) } }), D));
  for (const [field, value] of [['identityRevision', '6'.repeat(64)], ['currentAuthority', '{"changed":true}'],
    ['issuedAtMs', now - 1], ['originalExpiresAtMs', bounds.deadlineMs - 1], ['selectorSha256', '9'.repeat(64)]])
    test('probe denies signed-fact tampering ' + field, () => rejects(() => pv.verifyCryptographically(jcsWire({ ...probeEnvelope, [field]: value }, probePrefix), probeBounds), P));
  for (const change of [{ sessionKey: '2026' }, { folderId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }, { clientSelector: 'Zoë 東京' }])
    test('probe binds actual selector field ' + Object.keys(change)[0], () => rejects(() => pv.verifyCryptographically(probeHeader, { ...probeBounds, selector: { ...selector, ...change } }), P));
  test('valid signed envelopes reject cross-purpose schemes and relabelled schemes', () => {
    rejects(() => pv.verifyCryptographically(dataHeader, probeBounds), P);
    rejects(() => dv.verifyCryptographically(probeHeader, actualDataBounds), D);
    rejects(() => pv.verifyCryptographically(probePrefix + dataHeader.slice(dataPrefix.length), probeBounds), P);
    rejects(() => dv.verifyCryptographically(dataPrefix + probeHeader.slice(probePrefix.length), actualDataBounds), D);
  });
  test('valid shape and correct selector cannot reuse a data signature for probe domain', () => {
    rejects(() => pv.verifyCryptographically(jcsWire({ ...probeEnvelope, signature: dataEnvelope.signature }, probePrefix), probeBounds), P);
    rejects(() => dv.verifyCryptographically(jcsWire({ ...dataEnvelope, signature: probeEnvelope.signature }, dataPrefix), actualDataBounds), D);
  });
  test('wrong independently generated Ed25519 key rejects both valid envelopes', () => {
    rejects(() => d.createCoreRetainedPrincipalCryptographicVerifier({ ...dataPins, publicKey: otherKeys.publicKey }).verifyCryptographically(dataHeader, actualDataBounds), D);
    rejects(() => p.createCoreRetainedAuthorityProbeCryptographicVerifier({ ...actualProbePins, publicKey: otherKeys.publicKey }).verifyCryptographically(probeHeader, probeBounds), P);
  });
  for (const [name, verifier, header, context, ErrorType] of [['data', dv, dataHeader, actualDataBounds, D], ['probe', pv, probeHeader, probeBounds, P]])
    test(name + ' exact 30-second lease, expiry boundary and shorter original deadline', () => {
      ok(verifier.verifyCryptographically(header, { ...context, nowMs: bounds.deadlineMs - 1 }).originalExpiresAtMs === bounds.deadlineMs);
      rejects(() => verifier.verifyCryptographically(header, { ...context, nowMs: bounds.deadlineMs }), ErrorType);
      rejects(() => verifier.verifyCryptographically(header, { ...context, deadlineMs: bounds.deadlineMs - 1 }), ErrorType);
    });
  for (const [name, verifier, envelope, prefix, context, ErrorType] of [['data', dv, dataEnvelope, dataPrefix, actualDataBounds, D], ['probe', pv, probeEnvelope, probePrefix, probeBounds, P]])
    test(name + ' rejects duplicate keys/non-JCS whitespace/extra fields/base64 padding', () => {
      const encoded = canonicalize(envelope);
      const duplicate = '{"schemaVersion":1,' + encoded.slice(1);
      rejects(() => verifier.verifyCryptographically(prefix + Buffer.from(duplicate).toString('base64url'), context), ErrorType);
      rejects(() => verifier.verifyCryptographically(prefix + Buffer.from(' ' + encoded).toString('base64url'), context), ErrorType);
      rejects(() => verifier.verifyCryptographically(jcsWire({ ...envelope, extra: true }, prefix), context), ErrorType);
      rejects(() => verifier.verifyCryptographically(jcsWire(envelope, prefix) + '=', context), ErrorType);
    });
  test('non-ASCII identifiers/authority/context and an internationalized pinned origin round-trip', () => {
    const audienceOrigin = new URL('https://例え.テスト').origin;
    const pins = { ...dataPins, audienceOrigin, keyId: 'clé-東京', issuer: 'émetteur-東京' };
    const value = { ...actualFacts, principal: { ...principal, clerkUserId: 'actualité東京' }, currentAuthority: JSON.stringify({ schemaVersion: 1, synthetic: 'Zoë 東京' }) };
    const signer = d.createCoreRetainedPrincipalSigner({ ...pins, privateKey: keys.privateKey });
    const verifier = d.createCoreRetainedPrincipalCryptographicVerifier({ ...pins, publicKey: keys.publicKey });
    const result = verifier.verifyCryptographically(signer.sign(value, bounds), actualDataBounds);
    ok(result.principal.clerkUserId === value.principal.clerkUserId && result.currentAuthority === value.currentAuthority && result.audienceOrigin === audienceOrigin);
  });
  test('Unicode and exact session bytes remain in the probe whole-selector hash', () => {
    const selected = { schemaVersion: 1, sessionKey: '  会期 é  ', folderId: null, clientSelector: 'Zoë 東京' };
    const header = ps.sign({ ...probeInput, selector: selected }, bounds);
    const result = pv.verifyCryptographically(header, { ...probeBounds, selector: selected });
    ok(result.selectorSha256 === digest(selected)); ok(result.selectorSha256 !== digest({ ...selected, sessionKey: selected.sessionKey.trim() }));
  });
  for (const [name, factory, verifierFactory, input, context] of [
    ['data', d.createCoreRetainedPrincipalSigner, d.createCoreRetainedPrincipalCryptographicVerifier, actualFacts, actualDataBounds],
    ['probe', p.createCoreRetainedAuthorityProbeSigner, p.createCoreRetainedAuthorityProbeCryptographicVerifier, probeInput, probeBounds],
  ]) test(name + ' real JCS signs 256-character identifiers and exact 4096-byte authority', () => {
    const pins = { ...(name === 'data' ? dataPins : actualProbePins), keyId: 'k'.repeat(256), issuer: 'i'.repeat(256) };
    const signer = factory({ ...pins, privateKey: keys.privateKey }), verifier = verifierFactory({ ...pins, publicKey: keys.publicKey });
    const value = { ...input, principal: { ...principal, clerkUserId: 'x'.repeat(256) }, currentAuthority: JSON.stringify('é'.repeat(2047)) };
    ok(Buffer.byteLength(value.currentAuthority) === 4096);
    const header = signer.sign(value, bounds), result = verifier.verifyCryptographically(header, context);
    ok(result.principal.clerkUserId.length === 256 && Buffer.byteLength(result.currentAuthority) === 4096);
    const prefix = name === 'data' ? dataPrefix : probePrefix;
    ok(Buffer.from(header.slice(prefix.length), 'base64url').length <= 8192);
  });
  test('cryptographic acceptance makes no live authority decision', () => {
    const otherResource = digest({ ...resourceVector, revision: 8 });
    const currentSigned = ds.sign({ ...actualFacts, resourceRevision: otherResource }, bounds);
    ok(dv.verifyCryptographically(currentSigned, actualDataBounds).resourceRevision === otherResource);
    ok(!('verifyCurrent' in dv) && !('verifyCurrent' in pv));
  });
  stage = 'seal receipt';
  receipt.sourcesUnchanged = names.every(name => sha(fs.readFileSync(path.join(sourceRoot, name))) === sha(sourceBytes[name]));
  receipt.dependencyUnchanged = fileFacts(canonicalizePath).sha256 === receipt.jcs.sha256 && fileFacts(packagePath).sha256 === receipt.jcs.package.sha256;
  ok(receipt.sourcesUnchanged && receipt.dependencyUnchanged);
  receipt.realJcsPassed = receipt.realJcsChecks.filter(item => item.passed).length;
  receipt.realJcsFailed = receipt.realJcsChecks.filter(item => !item.passed).length;
  receipt.totalChecks = receipt.baselineStructuralChecks + receipt.realJcsChecks.length;
  receipt.exitCode = receipt.realJcsFailed ? 1 : 0;
} catch (error) {
  receipt.exitCode = 1;
  receipt.failure = { stage, errorClass: error && error.constructor ? error.constructor.name : 'unknown' };
}
receipt.finishedAt = new Date().toISOString();
receipt.memoryUsageBytes = process.memoryUsage();
receipt.helper = fileFacts(__filename);
fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ receiptPath, receiptSha256: fileFacts(receiptPath).sha256, exitCode: receipt.exitCode,
  baselineStructuralChecks: receipt.baselineStructuralChecks, realJcsPassed: receipt.realJcsPassed,
  realJcsFailed: receipt.realJcsFailed, totalChecks: receipt.totalChecks,
  syntaxDiagnosticCount: receipt.syntaxDiagnosticCount, failure: receipt.failure,
  failedChecks: receipt.realJcsChecks.filter(item => !item.passed).map(item => item.name) }));
process.exitCode = receipt.exitCode;
