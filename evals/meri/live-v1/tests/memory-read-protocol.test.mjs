import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  prepareMemoryReadCase,
  executeMemoryReadCase,
  memoryReadCaseIds,
} from '../memory-read-protocol.mjs';
import { createMemoryReadHttp, createMemoryReadRecorder } from '../memory-read-http.mjs';
import { sha256Stable } from '../artifact-collector.mjs';
import { cases } from '../cases.mjs';

// UNIT ports only. No real authentication, fixture, provider, budget admission,
// live turn, source authority or original evaluation result is constructed here.
function unit(caseId = '02') {
  const config = {
    caseId,
    captureRunId: randomUUID(),
    conversationId: randomUUID(),
    actorUserId: randomUUID(),
    clerkUserId: 'user_UNIT_SYNTHETIC',
    clientId: randomUUID(),
    apiSha: 'a'.repeat(40),
    orchestratorSha: 'b'.repeat(40),
    webSha: 'c'.repeat(40),
    maxCostMicros: 100000,
    timeoutMs: 10000,
  };
  const plan = prepareMemoryReadCase(config),
    records = new Map(),
    calls = [],
    observations = [];
  const proof = {
    fixtureReady: true,
    missing: [],
    caseId: '01',
    tenantId: plan.tenantId,
    actorUserId: config.actorUserId,
    clientId: config.clientId,
    fixtureNamespace: 'meri-foundation-20260928',
    currentVerify: {
      current: {
        correction: { unit: true },
        revoked: { unit: true },
        proposed: { unit: true },
        negativeVersions: [{ unit: 1 }, { unit: 2 }],
      },
    },
    sourceMap: { 'MA1-v2': { unit: true } },
  };
  proof.currentVerifySha256 = sha256Stable(proof.currentVerify);
  proof.physicalMapSha256 = sha256Stable(proof.sourceMap);
  const me = {
    tenant: { id: plan.tenantId, slug: plan.tenantSlug },
    user: { id: config.actorUserId, clerkUserId: config.clerkUserId },
    role: 'standard_user',
    features: { meriv3Chat: true },
  };
  let messageReads = 0;
  const ports = {
    transport: {
      async request(path, body) {
        calls.push({ path, body });
        let value;
        if (path === '/api/me') value = me;
        else if (path === '/api/clio/status') value = { configured: true, healthy: true };
        else if (path.endsWith('/messages'))
          value =
            messageReads++ === 0
              ? []
              : [
                  { id: randomUUID(), role: 'user', body: plan.prompt },
                  { id: randomUUID(), role: 'assistant', body: 'UNIT response, not graded.' },
                ];
        else if (path.endsWith('/stream'))
          return {
            status: 201,
            releaseSha: config.apiSha,
            text: 'data: {"type":"done","runId":"unit-run"}\n\n',
          };
        else value = { id: config.conversationId, clientId: config.clientId };
        return { status: 200, releaseSha: config.apiSha, text: JSON.stringify(value) };
      },
    },
    readCurrentFixture: async () => structuredClone(proof),
    spend: {
      beforeSubmit: async (binding) => ({ unitOnly: true, binding }),
      afterAttempt: async (reservation, observation) =>
        observations.push({ reservation, observation }),
    },
    record: async (name, value) => {
      assert.ok(!records.has(name), `duplicate evidence ${name}`);
      records.set(name, structuredClone(value));
    },
  };
  return { config, plan, ports, records, calls, observations, proof, me };
}

test('five plans use exact frozen original prompts with distinct case/run identities', () => {
  assert.deepEqual(memoryReadCaseIds, ['01', '02', '03', '04', '05']);
  for (const id of memoryReadCaseIds) {
    const { plan } = unit(id);
    assert.equal(plan.prompt, cases.find((row) => row.id === id).prompt);
    assert.equal(plan.caseId, id);
    assert.equal(plan.liveAcceptance, 'NOT_RUN');
  }
  assert.throws(() => unit('06'), /CASE_INVALID/);
  assert.throws(
    () => prepareMemoryReadCase({ ...unit().config, maxCostMicros: 15000001 }),
    /COST_INVALID/,
  );
  assert.throws(
    () => prepareMemoryReadCase({ ...unit().config, bearer: 'UNIT_SECRET' }),
    /CONFIG_FIELDS_INVALID/,
  );
});

for (const id of memoryReadCaseIds)
  test(`case${id} collects UNIT HTTP observations without claiming acceptance`, async () => {
    const u = unit(id),
      result = await executeMemoryReadCase(u.config, u.ports);
    assert.equal(result.status, 'COLLECTED_NOT_GRADED');
    assert.equal(result.overallCaseStatus, 'NOT_RUN');
    assert.equal(result.humanRubric, 'NOT_REVIEWED');
    assert.deepEqual(
      u.calls.filter((call) => call.body !== undefined).map((call) => call.body),
      [{ body: u.plan.prompt }],
    );
    assert.ok(u.records.has('fixture-before.json') && u.records.has('fixture-after.json'));
    assert.equal(u.observations.length, 1);
    assert.equal(u.observations[0].reservation.binding.caseId, id);
    assert.ok(!Object.hasOwn(u.observations[0].observation, 'usage'));
  });

test('wrong current actor prevents both budget reservation and POST', async () => {
  const u = unit();
  u.me.user.id = randomUUID();
  u.me.user.email = 'UNIT_UNEXPECTED_PROFILE';
  let reserved = false;
  u.ports.spend.beforeSubmit = async () => {
    reserved = true;
  };
  const result = await executeMemoryReadCase(u.config, u.ports);
  assert.equal(result.failureCode, 'MEMORY_READ_ACTOR_MISMATCH');
  assert.equal(result.submissionAttempted, false);
  assert.equal(reserved, false);
  assert.equal(u.calls.filter((call) => call.body).length, 0);
  assert.ok(!JSON.stringify([...u.records]).includes('UNIT_UNEXPECTED_PROFILE'));
});

test('missing genuine budget adapter cannot dispatch', async () => {
  const u = unit();
  u.ports.spend.beforeSubmit = async () => null;
  const result = await executeMemoryReadCase(u.config, u.ports);
  assert.equal(result.failureCode, 'MEMORY_READ_ENFORCED_BUDGET_MISSING');
  assert.equal(result.submissionAttempted, false);
  assert.equal(u.calls.filter((call) => call.body).length, 0);
});

test('rejected HTTP body is preserved, observed by budget owner, and never retried', async () => {
  const u = unit(),
    original = u.ports.transport.request;
  u.ports.transport.request = async (path, body) =>
    body === undefined
      ? original(path, body)
      : { status: 409, releaseSha: u.config.apiSha, text: '{"code":"UNIT_CLOSED"}' };
  const result = await executeMemoryReadCase(u.config, u.ports);
  assert.equal(result.httpStatus, 409);
  assert.equal(u.records.get('stream.json').body, '{"code":"UNIT_CLOSED"}');
  assert.equal(result.status, 'ATTEMPT_REQUIRES_RECONCILIATION');
  assert.equal(u.observations[0].observation.submissionAttempted, true);
  await assert.rejects(executeMemoryReadCase(u.config, u.ports), /REPLAY_REFUSED/);
});

test('ambiguous network failure after POST remains a submission and keeps no invented completion', async () => {
  const u = unit(),
    original = u.ports.transport.request;
  u.ports.transport.request = async (path, body) => {
    if (body !== undefined) throw new Error('UNIT_NETWORK');
    return original(path, body);
  };
  const result = await executeMemoryReadCase(u.config, u.ports);
  assert.equal(result.submissionAttempted, true);
  assert.equal(result.completed, false);
  assert.equal(result.httpStatus, null);
  assert.equal(u.observations.length, 1);
});

test('source drift and post-turn lifecycle drift are retained as failures', async () => {
  const source = unit(),
    original = source.ports.transport.request;
  source.ports.transport.request = async (...args) => ({
    ...(await original(...args)),
    releaseSha: 'd'.repeat(40),
  });
  const denied = await executeMemoryReadCase(source.config, source.ports);
  assert.equal(denied.failureCode, 'MEMORY_READ_API_SOURCE_CHANGED');
  assert.equal(denied.submissionAttempted, false);
  const changed = unit();
  let reads = 0;
  changed.ports.readCurrentFixture = async () => {
    const proof = structuredClone(changed.proof);
    if (reads++) proof.currentVerify.current.proposed = { unit: 'changed' };
    proof.currentVerifySha256 = sha256Stable(proof.currentVerify);
    return proof;
  };
  const result = await executeMemoryReadCase(changed.config, changed.ports);
  assert.equal(result.failureCode, 'MEMORY_READ_CORPUS_CHANGED');
  assert.ok(changed.records.has('fixture-after.json'));
});

test('incomplete SSE is not a completed capture', async () => {
  const u = unit(),
    original = u.ports.transport.request;
  u.ports.transport.request = async (path, body) =>
    body === undefined
      ? original(path, body)
      : {
          status: 201,
          releaseSha: u.config.apiSha,
          text: 'data: {"type":"delta","text":"UNIT"}\n\n',
        };
  const result = await executeMemoryReadCase(u.config, u.ports);
  assert.equal(result.failureCode, 'MEMORY_READ_STREAM_INCOMPLETE');
  assert.equal(result.completed, false);
});

test('a terminal stream without persisted assistant remains ungraded', async () => {
  const u = unit(),
    original = u.ports.transport.request;
  let reads = 0;
  u.ports.transport.request = async (path, body) => {
    const response = await original(path, body);
    return path.endsWith('/messages') && reads++ > 0 ? { ...response, text: '[]' } : response;
  };
  const result = await executeMemoryReadCase(u.config, u.ports);
  assert.equal(result.failureCode, 'MEMORY_READ_PERSISTENCE_INCOMPLETE');
  assert.equal(result.overallCaseStatus, 'NOT_RUN');
});

test('transport refuses non-approved paths without starting a request', () => {
  const u = unit();
  const transport = createMemoryReadHttp({
    bearer: 'UNIT_ONLY_NOT_A_CREDENTIAL',
    conversationId: u.config.conversationId,
    timeoutMs: 1000,
  });
  assert.throws(() => transport.request('/api/tasks', {}), /TRANSPORT_BOUND/);
  assert.throws(() => transport.request('https://other.invalid/'), /TRANSPORT_BOUND/);
});

test('recorder rejects secrets, duplicate files, and reused directories', async () => {
  const root = resolve(process.env.MERI_PROTOCOL_TEST_ROOT ?? process.cwd());
  const directory = await mkdtemp(join(root, 'memory-read-unit-'));
  try {
    const target = join(directory, 'evidence');
    const record = await createMemoryReadRecorder(target, { secrets: ['UNIT_SENTINEL_SECRET'] });
    await record('observed.json', { status: 409 });
    assert.equal(JSON.parse(await readFile(join(target, 'observed.json'), 'utf8')).status, 409);
    await assert.rejects(record('observed.json', {}), /EEXIST/);
    await assert.rejects(
      record('secret.json', { value: 'UNIT_SENTINEL_SECRET' }),
      /SECRET_IN_EVIDENCE/,
    );
    await assert.rejects(record('../escape.json', {}), /NAME_INVALID/);
    await assert.rejects(createMemoryReadRecorder(target), /EEXIST/);
  } finally {
    assert.equal(dirname(resolve(directory)), root);
    assert.ok(directory.startsWith(join(root, 'memory-read-unit-')));
    await rm(directory, { recursive: true, force: true });
  }
});
