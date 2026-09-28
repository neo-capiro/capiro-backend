import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { executeLiveCase } from '../capture-adapter.mjs';
import { ArtifactCollector, verifyCollectedArtifacts } from '../artifact-collector.mjs';
import { main as captureCli } from '../capture-cli.mjs';
import { sourceMappingDigest } from '../capture-transport.mjs';

const API_SHA = 'a'.repeat(40);
const ORCH_SHA = 'b'.repeat(40);
const TENANT = 'f2d6cf8f-057c-479a-8110-62fe5086d43f';
const USER = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const CONVERSATION = '55555555-5555-4555-8555-555555555555';
const SECRET = 'eyJfixturetoken123456.abcdefgh12345678.signature12345678';

function config(origin, overrides = {}) {
  const value = {
    schemaVersion: 1,
    provenance: 'UNIT_FIXTURE_NOT_LIVE',
    captureRunId: `unit-${Math.random()}`,
    target: { environment: 'controlled-local-http', apiOrigin: origin },
    contract: {
      fixtureSha256: '2a8159d45d512f325539eb700907700ecc16cbc2d6536277adf85d8f49368e61',
      contractSourceSha256: 'acd2a1cf766ad6e988025c4c43235213164926e7036cc8361986916d59963b66',
    },
    deployment: { apiSha: API_SHA, orchestratorSha: ORCH_SHA },
    fixture: {
      namespace: 'meri-foundation-20260928',
      version: 'meri-live-v1-2026-09-26.1',
      sha256: '2a8159d45d512f325539eb700907700ecc16cbc2d6536277adf85d8f49368e61',
      seedReceiptId: 'UNIT_FIXTURE_NOT_LIVE',
      mappingSha256: '',
    },
    limits: { concurrency: 1, deadlineMs: 5_000, maxSpendUsd: 0.25 },
    scope: {
      tenants: { T1: { physicalId: TENANT, slug: 'meri-foundation-20260928-t1' } },
      actors: { PAT: { userId: USER, clerkUserId: 'user_synthetic_pat', tenantPhysicalId: TENANT, role: 'standard_user' } },
      clients: { ASTER: { physicalId: CLIENT, tenantPhysicalId: TENANT, name: 'Aster Defense' } },
      sources: {
        'MA1-v2': { frozenFixtureId: 'MA1-v2', physicalId: SOURCE, tenantPhysicalId: TENANT, clientPhysicalId: CLIENT, kind: 'memory', version: 'content:v2' },
        'R2-27': { frozenFixtureId: 'R2-27', physicalId: '66666666-6666-4666-8666-666666666666', tenantPhysicalId: TENANT, clientPhysicalId: null, kind: 'budget_document', version: 'r2-v1', locator: 'page 14' },
      },
    },
  };
  Object.assign(value, overrides);
  value.fixture.mappingSha256 = sourceMappingDigest(value);
  return value;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function server(options = {}) {
  const counts = { total: 0, conversation: 0, stream: 0, redirectedTarget: 0 };
  const instance = createServer(async (req, res) => {
    counts.total += 1;
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/redirect-target') { counts.redirectedTarget += 1; return json(res, 200, { status: 'ok' }); }
    if (url.pathname === '/health') {
      if (options.redirect) { res.writeHead(302, { location: '/redirect-target' }); return res.end(); }
      return json(res, 200, { status: 'ok' }, { 'x-capiro-release-sha': API_SHA });
    }
    if (url.pathname === '/api/me') return json(res, 200, {
      user: { id: USER, clerkUserId: 'user_synthetic_pat' },
      tenant: { id: TENANT, slug: 'meri-foundation-20260928-t1' },
      role: 'standard_user', features: { meriv3Chat: true }, debugToken: SECRET,
    });
    if (url.pathname === '/api/clio/status') return json(res, 200, { configured: true, healthy: true });
    if (url.pathname === '/api/clients') return json(res, 200, options.missingClient ? [] : [{ id: CLIENT, name: 'Aster Defense' }]);
    if (url.pathname === '/api/clio/conversations' && req.method === 'POST') {
      counts.conversation += 1;
      return json(res, 201, { id: CONVERSATION, clientId: CLIENT });
    }
    if (url.pathname === `/api/clio/conversations/${CONVERSATION}/stream`) {
      counts.stream += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const citationId = options.sourceMismatch ? '77777777-7777-4777-8777-777777777777' : SOURCE;
      const events = [
        { type: 'turn_accepted', messageId: '88888888-8888-4888-8888-888888888888' },
        { type: 'runtime', model: 'controlled-model', telemetry: { effectiveModel: 'controlled-model' } },
        { type: 'tool_call', tool: 'search_institutional_memory', label: 'Memory' },
        { type: 'sources', sources: [{ tool: 'search_institutional_memory', summary: 'one current record', confidence: 'high' }] },
        { type: 'text', text: 'Observed current approved memory.' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, ...(options.observedCostUsd === undefined ? {} : { costUsd: options.observedCostUsd }) } },
      ];
      if (!options.missingSource) events.push({
        type: 'citations',
        citations: [{ n: 1, type: 'memory', id: citationId, title: 'Current memory', url: null, snippet: 'Observed current value', tool: 'search_institutional_memory', source: { kind: 'memory', recordId: citationId, clientId: CLIENT, version: 'content:v2' } }],
      });
      if (!options.interrupted) events.push({ type: 'done', messageId: MESSAGE, model: 'controlled-model', retrieval: { trace: { version: 1, observedToolCalls: 1 } } });
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (options.malformedFrame) res.write('data: {not-json}\n\n');
      if (options.unterminatedFrame) res.write('data: {"type":"text"');
      if (options.duplicateDone) res.write(`data: ${JSON.stringify({ type: 'done', messageId: MESSAGE })}\n\n`);
      if (options.postTerminal) res.write(`data: ${JSON.stringify({ type: 'runtime', model: 'after-terminal' })}\n\n`);
      if (options.frameOverflow) for (let index = 0; index < 4_097; index += 1) res.write(`: frame-${index}\n\n`);
      if (options.invalidUtf8) res.write(Buffer.from([0xc3, 0x28]));
      return res.end();
    }
    if (url.pathname === `/api/clio/conversations/${CONVERSATION}/messages`) return json(res, 200, [{ id: MESSAGE, role: 'assistant', body: 'Observed current approved memory.' }]);
    if (url.pathname === '/api/clio/sources') return json(res, 200, { kind: 'memory', status: 'available', recordId: url.searchParams.get('recordId'), sourceVersion: 'v2', text: 'Current server readback' });
    return json(res, 404, { error: 'not found' });
  });
  await new Promise((resolveReady) => instance.listen(0, '127.0.0.1', resolveReady));
  const address = instance.address();
  return { origin: `http://127.0.0.1:${address.port}`, counts, close: () => new Promise((done) => instance.close(done)) };
}

async function run(options = {}, mutate = null, env = { MERI_LIVE_BEARER_TOKEN: SECRET }) {
  const fixture = await server(options);
  const scratch = await mkdtemp(join(tmpdir(), 'meri-live-collector-'));
  const value = config(fixture.origin);
  if (mutate) mutate(value);
  value.fixture.mappingSha256 = sourceMappingDigest(value);
  const runRoot = resolve(scratch, 'run');
  try {
    const result = await executeLiveCase({ config: value, caseId: '01', runRoot, env });
    return { result, runRoot, fixture, cleanup: async () => { await fixture.close(); await rm(scratch, { recursive: true, force: true }); } };
  } catch (error) {
    await fixture.close();
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

test('controlled collector captures real HTTP/SSE/readback bytes but remains UNIT_FIXTURE_NOT_LIVE', async () => {
  const value = await run();
  try {
    assert.equal(value.result.status, 'CAPTURE_INCOMPLETE');
    assert.equal(value.result.acceptanceStatus, 'NOT_RUN');
    assert.equal(value.result.acceptanceReason, 'UNIT_FIXTURE_NOT_LIVE');
    assert.equal(value.result.synthesisSubmissionCount, 1);
    assert.equal(value.result.links.sourceLinks[0].physicalSourceId, SOURCE);
    assert.equal(value.result.integrity.valid, true);
  } finally { await value.cleanup(); }
});

test('interrupted SSE preserves uncertainty and never retries an ambiguously submitted chat', async () => {
  const value = await run({ interrupted: true });
  try {
    assert.equal(value.result.status, 'CAPTURE_UNCERTAIN');
    assert.equal(value.fixture.counts.stream, 1);
    assert.equal(value.result.synthesisSubmissionCount, 1);
    assert(value.result.gaps.includes('TERMINAL_DONE_MISSING_CAPTURE_UNCERTAIN'));
  } finally { await value.cleanup(); }
});

test('missing auth blocks before any HTTP request', async () => {
  const value = await run({}, null, {});
  try {
    assert.equal(value.result.status, 'BLOCKED');
    assert.equal(value.result.reason, 'AUTH_MISSING');
    assert.equal(value.fixture.counts.total, 0);
  } finally { await value.cleanup(); }
});

test('missing scope mapping blocks before synthesis', async () => {
  const value = await run({}, (cfg) => { delete cfg.scope.actors.PAT; });
  try {
    assert.equal(value.result.reason, 'SCOPE_MAPPING_MISSING');
    assert.equal(value.fixture.counts.stream, 0);
  } finally { await value.cleanup(); }
});

test('missing client preflight blocks before conversation or synthesis', async () => {
  const value = await run({ missingClient: true });
  try {
    assert.equal(value.result.reason, 'CLIENT_SCOPE_MISMATCH');
    assert.equal(value.fixture.counts.stream, 0);
  } finally { await value.cleanup(); }
});

test('missing source evidence is an explicit incomplete capture gap', async () => {
  const value = await run({ missingSource: true });
  try {
    assert.equal(value.result.status, 'CAPTURE_INCOMPLETE');
    assert(value.result.gaps.includes('SOURCE_EVIDENCE_MISSING:MA1-v2'));
  } finally { await value.cleanup(); }
});

test('observed source mismatch blocks and cannot be repaired from expected fixture fields', async () => {
  const value = await run({ sourceMismatch: true });
  try {
    assert.equal(value.result.status, 'BLOCKED');
    assert.equal(value.result.reason, 'SOURCE_EVIDENCE_MISMATCH');
    assert.equal(value.fixture.counts.stream, 1);
  } finally { await value.cleanup(); }
});

test('authorization and response secrets are redacted from every persisted artifact', async () => {
  const value = await run();
  try {
    const manifest = JSON.parse(await readFile(join(value.runRoot, 'capture-manifest.json'), 'utf8'));
    for (const entry of manifest.artifacts) {
      const text = await readFile(join(value.runRoot, entry.ref), 'utf8');
      assert.equal(text.includes(SECRET), false, `${entry.ref} serialized a secret`);
      assert.equal(/Bearer\s+eyJ/iu.test(text), false, `${entry.ref} serialized bearer auth`);
    }
  } finally { await value.cleanup(); }
});

test('redirects are rejected without following their target', async () => {
  const value = await run({ redirect: true });
  try {
    assert.equal(value.result.reason, 'REDIRECT_REJECTED');
    assert.equal(value.fixture.counts.redirectedTarget, 0);
    assert.equal(value.fixture.counts.stream, 0);
  } finally { await value.cleanup(); }
});

test('artifact integrity detects tampering', async () => {
  const value = await run();
  try {
    await writeFile(join(value.runRoot, 'cases/01/answer.txt'), 'tampered');
    const integrity = await verifyCollectedArtifacts(value.runRoot);
    assert.equal(integrity.valid, false);
    assert(integrity.errors.some((error) => error.includes('sha256 mismatch')));
  } finally { await value.cleanup(); }
});

test('LIVE_CAPTURE fails closed on missing server authority before any request, conversation, or synthesis', async () => {
  const fixture = await server();
  const scratch = await mkdtemp(join(tmpdir(), 'meri-live-guard-'));
  const value = config('https://app.capiro.ai', {
    provenance: 'LIVE_CAPTURE',
    target: { environment: 'capiro-dev', apiOrigin: 'https://app.capiro.ai' },
  });
  value.fixture.mappingSha256 = sourceMappingDigest(value);
  try {
    const result = await executeLiveCase({ config: value, caseId: '01', runRoot: resolve(scratch, 'run'), env: { MERI_LIVE_BEARER_TOKEN: SECRET } });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, 'LIVE_SERVER_AUTHORITY_CONTRACT_MISSING');
    assert.equal(result.requestCount, 0);
    assert.equal(result.conversationId, null);
    assert.equal(result.synthesisSubmissionCount, 0);
    assert.deepEqual(result.detail.missingServerContracts, [
      'predispatch read-only tool enforcement and incidental-write suppression receipt',
      'server-authored current fixture/source ownership and version receipt',
      'served API and orchestrator release identity receipt',
      'server/provider-enforced cost reservation',
    ]);
    assert.equal(fixture.counts.total, 0);
    assert.equal(fixture.counts.conversation, 0);
    assert.equal(fixture.counts.stream, 0);
  } finally {
    await fixture.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('LIVE_CAPTURE rejects the UI-only os.capiro.ai origin before readiness evaluation', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'meri-live-origin-'));
  const value = config('https://os.capiro.ai', {
    provenance: 'LIVE_CAPTURE',
    target: { environment: 'capiro-dev', apiOrigin: 'https://os.capiro.ai' },
  });
  try {
    const result = await executeLiveCase({ config: value, caseId: '01', runRoot: resolve(scratch, 'run'), env: { MERI_LIVE_BEARER_TOKEN: SECRET } });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, 'TARGET_NOT_APPROVED');
    assert.equal(result.requestCount, 0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

for (const [name, options, expectedGap] of [
  ['malformed trailing SSE frame after done', { malformedFrame: true }, 'SSE_MALFORMED_FRAME'],
  ['unterminated trailing SSE frame after done', { unterminatedFrame: true }, 'SSE_UNTERMINATED_TRAILING_FRAME'],
  ['duplicate terminal event', { duplicateDone: true }, 'SSE_DUPLICATE_TERMINAL_EVENT'],
  ['post-terminal event', { postTerminal: true }, 'SSE_POST_TERMINAL_EVENT'],
]) {
  test(`${name} is capture uncertainty, not quiet incompleteness`, async () => {
    const value = await run(options);
    try {
      assert.equal(value.result.status, 'CAPTURE_UNCERTAIN');
      assert.equal(value.result.synthesisSubmissionCount, 1);
      assert.equal(value.fixture.counts.stream, 1);
      assert(value.result.gaps.includes(expectedGap));
    } finally { await value.cleanup(); }
  });
}

test('invalid UTF-8 after done invalidates the stream without a retry', async () => {
  const value = await run({ invalidUtf8: true });
  try {
    assert.equal(value.result.status, 'CAPTURE_UNCERTAIN');
    assert.equal(value.result.synthesisSubmissionCount, 1);
    assert.equal(value.fixture.counts.stream, 1);
    assert(value.result.gaps.includes('SYNTHESIS_OUTCOME_UNKNOWN:RESPONSE_INVALID_UTF8'));
  } finally { await value.cleanup(); }
});

test('SSE frame count is bounded and overflow remains a one-submission uncertainty', async () => {
  const value = await run({ frameOverflow: true });
  try {
    assert.equal(value.result.status, 'CAPTURE_UNCERTAIN');
    assert.equal(value.result.synthesisSubmissionCount, 1);
    assert.equal(value.fixture.counts.stream, 1);
    assert(value.result.gaps.includes('SYNTHESIS_OUTCOME_UNKNOWN:SSE_FRAME_LIMIT_EXCEEDED'));
  } finally { await value.cleanup(); }
});

test('maxSpendUsd is only a post-hoc threshold and cannot claim provider reservation', async () => {
  const value = await run({ observedCostUsd: 0.5 });
  try {
    assert.equal(value.result.status, 'CAPTURE_INCOMPLETE');
    assert.equal(value.result.synthesisSubmissionCount, 1);
    assert.equal(value.result.postHocSpendThresholdUsd, 0.25);
    assert.equal(value.result.observedCostUsd, 0.5);
    assert(value.result.gaps.includes('OBSERVED_COST_EXCEEDS_POST_HOC_THRESHOLD'));
  } finally { await value.cleanup(); }
});

test('collector verifier rejects a same-byte external symlink substitution', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'meri-artifact-link-read-'));
  const root = resolve(scratch, 'root');
  try {
    const collector = new ArtifactCollector(root, { captureRunId: 'link-read', provenance: 'UNIT_FIXTURE_NOT_LIVE' });
    await collector.init();
    await collector.writeText('linked.txt', 'same bytes');
    await collector.finalize({ status: 'NOT_RUN' });
    const outside = resolve(scratch, 'outside.txt');
    await writeFile(outside, 'same bytes');
    await rm(resolve(root, 'linked.txt'));
    await symlink(outside, resolve(root, 'linked.txt'));
    const integrity = await verifyCollectedArtifacts(root);
    assert.equal(integrity.valid, false);
    assert(integrity.errors.some((error) => /symlink|linked/iu.test(error)));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('collector refuses a dangling symlink destination without writing outside the root', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'meri-artifact-link-write-'));
  const root = resolve(scratch, 'root');
  try {
    const collector = new ArtifactCollector(root, { captureRunId: 'link-write', provenance: 'UNIT_FIXTURE_NOT_LIVE' });
    await collector.init();
    const outside = resolve(scratch, 'escaped.txt');
    await symlink(outside, resolve(root, 'escape.txt'));
    await assert.rejects(collector.writeText('escape.txt', 'must stay owned'), /already exists or is linked/iu);
    await assert.rejects(readFile(outside, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('collector verifier rejects owned parent replacement with a directory reparse link', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'meri-artifact-parent-link-'));
  const root = resolve(scratch, 'root');
  try {
    const collector = new ArtifactCollector(root, { captureRunId: 'parent-link', provenance: 'UNIT_FIXTURE_NOT_LIVE' });
    await collector.init();
    await collector.writeText('cases/01/answer.txt', 'owned');
    await collector.finalize({ status: 'NOT_RUN' });
    const original = resolve(scratch, 'original-cases');
    const outside = resolve(scratch, 'outside-cases');
    await rename(resolve(root, 'cases'), original);
    await mkdir(resolve(outside, '01'), { recursive: true });
    await writeFile(resolve(outside, '01/answer.txt'), 'owned');
    await symlink(outside, resolve(root, 'cases'), process.platform === 'win32' ? 'junction' : 'dir');
    const integrity = await verifyCollectedArtifacts(root);
    assert.equal(integrity.valid, false);
    assert(integrity.errors.some((error) => /symlink|reparse|linked/iu.test(error)));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('portable collector refuses LIVE_CAPTURE path mode because directory handles are not pinned', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'meri-artifact-live-path-'));
  try {
    assert.throws(
      () => new ArtifactCollector(resolve(scratch, 'root'), { captureRunId: 'live-path', provenance: 'LIVE_CAPTURE' }),
      (error) => error?.code === 'LIVE_ARTIFACT_PATH_UNSAFE',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('CLI returns nonzero for controlled incomplete and uncertain captures', async () => {
  for (const [options, expectedExit] of [[{}, 4], [{ invalidUtf8: true }, 3]]) {
    const fixture = await server(options);
    const scratch = await mkdtemp(join(tmpdir(), 'meri-capture-cli-'));
    const configPath = resolve(scratch, 'scope.json');
    const outputRoot = resolve(scratch, 'output');
    const value = config(fixture.origin);
    await writeFile(configPath, `${JSON.stringify(value)}\n`);
    await mkdir(outputRoot);
    const originalLog = console.log;
    console.log = () => {};
    try {
      const exitCode = await captureCli(['--config', configPath, '--case', '01', '--out', outputRoot], { MERI_LIVE_BEARER_TOKEN: SECRET });
      assert.equal(exitCode, expectedExit);
    } finally {
      console.log = originalLog;
      await fixture.close();
      await rm(scratch, { recursive: true, force: true });
    }
  }
});

test('case 20 uses the same bounded API mechanism and exposes missing canonical source readback', async () => {
  const fixture = await server();
  const scratch = await mkdtemp(join(tmpdir(), 'meri-live-case20-'));
  const value = config(fixture.origin);
  const budgetSource = value.scope.sources['R2-27'];
  value.fixture.mappingSha256 = sourceMappingDigest(value);
  const original = fixture.close;
  await original();
  const case20Server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') return json(res, 200, { status: 'ok' }, { 'x-capiro-release-sha': API_SHA });
    if (url.pathname === '/api/me') return json(res, 200, { user: { id: USER, clerkUserId: 'user_synthetic_pat' }, tenant: { id: TENANT, slug: 'meri-foundation-20260928-t1' }, role: 'standard_user', features: { meriv3Chat: true } });
    if (url.pathname === '/api/clio/status') return json(res, 200, { configured: true, healthy: true });
    if (url.pathname === '/api/clients') return json(res, 200, [{ id: CLIENT, name: 'Aster Defense' }]);
    if (url.pathname === '/api/clio/conversations' && req.method === 'POST') return json(res, 201, { id: CONVERSATION, clientId: CLIENT });
    if (url.pathname.endsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'turn_accepted' }, { type: 'runtime', model: 'controlled-model' },
        { type: 'tool_call', tool: 'get_pe_budget_timeline', label: 'PE budget' },
        { type: 'text', text: 'Observed budget response.' },
        { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } },
        { type: 'citations', citations: [{ id: budgetSource.physicalId, title: 'Observed R-2 record', tool: 'get_pe_budget_timeline', snippet: 'Observed passage' }] },
        { type: 'done', messageId: MESSAGE, model: 'controlled-model', retrieval: { trace: { version: 1 } } },
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      return res.end();
    }
    if (url.pathname.endsWith('/messages')) return json(res, 200, [{ id: MESSAGE, role: 'assistant', body: 'Observed budget response.' }]);
    return json(res, 404, {});
  });
  await new Promise((done) => case20Server.listen(0, '127.0.0.1', done));
  const address = case20Server.address();
  value.target.apiOrigin = `http://127.0.0.1:${address.port}`;
  try {
    const result = await executeLiveCase({ config: value, caseId: '20', runRoot: resolve(scratch, 'run'), env: { MERI_LIVE_BEARER_TOKEN: SECRET } });
    assert.equal(result.status, 'CAPTURE_INCOMPLETE');
    assert(result.gaps.includes('CANONICAL_SOURCE_READBACK_UNAVAILABLE:R2-27'));
  } finally {
    await new Promise((done) => case20Server.close(done));
    await rm(scratch, { recursive: true, force: true });
  }
});
