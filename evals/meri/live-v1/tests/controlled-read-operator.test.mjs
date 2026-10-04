import test from 'node:test';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256Stable } from '../artifact-collector.mjs';
import { writeCaptureHttpObservation } from '../capture-http-observation.mjs';
import { frozenFixture } from '../fixture.mjs';
import { createControlledReadDefinition } from '../fixture-provisioning/controlled-read-definitions.mjs';
import {
  AUTHORIZED_TENANTS,
  FIXTURE_NAMESPACE,
  receiptWithHash,
  fixtureReceiptId,
} from '../fixture-provisioning/contract.mjs';
import {
  controlledReadSetupInput,
  controlledReadExecuteInput,
  inspectControlledReadSetupReceipt,
  controlledReadBudgetPlanInput,
  controlledReadBudgetInstallInput,
  controlledReadLiveConfig,
} from '../controlled-read-operator-input.mjs';
import {
  controlledReadBrowserRequestAllowed,
  assertControlledReadSyntheticIdentity,
  inspectControlledConversationReadback,
} from '../run-controlled-read.mjs';
import * as controlledReadOperator from '../run-controlled-read.mjs';

// Exercise the actual private native transport bodies with fake HTTPS sockets.
// No injectable transport or capability is exposed by the production collector.
function localTransport(functionName, moduleName, endMarker) {
  const source = readFileSync(new URL(`../${moduleName}`, import.meta.url), 'utf8');
  const start = source.indexOf(`function ${functionName}(`);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  const observed = [];
  const https = {
    request(url, options, callback) {
      const req = new EventEmitter();
      const call = { url: String(url), options, body: '' };
      observed.push(call);
      req.write = (body) => {
        call.body += body;
      };
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () =>
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.statusCode = options.method === 'POST' ? 201 : 200;
          response.headers = { 'x-capiro-release-sha': 'a'.repeat(40) };
          callback(response);
          response.emit('data', Buffer.from('{}'));
          response.emit('end');
        });
      return req;
    },
  };
  const need = (condition, code) => {
    if (!condition) throw new Error(code);
  };
  const factory = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    https,
    URL,
    Buffer,
    TextDecoder,
    Date,
    Math,
    JSON,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
    need,
    writeCaptureHttpObservation,
    origin: 'https://os.capiro.ai',
    ORIGIN: 'https://os.capiro.ai',
  });
  return { factory, observed };
}

for (const transportKind of ['creation', 'capture']) {
  test(`${transportKind} native HTTPS sends QA User-Agent and retains TLS, auth and one-write bounds`, async () => {
    const creation = transportKind === 'creation';
    const { factory, observed } = creation
      ? localTransport(
          'creationTransport',
          'run-controlled-read.mjs',
          '\nexport function controlledReadBrowserRequestAllowed',
        )
      : localTransport(
          'nativeTransport',
          'controlled-read-live-capture.mjs',
          '\nasync function currentAdmission',
        );
    const id = '12345678-1234-4234-8234-123456789012';
    const slug = 'meri-foundation-20260928-t1';
    const saved = [];
    const transport = creation
      ? factory({ scope: { tenants: { T1: { slug } } } }, 'unit-only-placeholder')
      : factory(
          { bearer: 'unit-only-placeholder', tenant: { slug }, expected: { conversationId: id } },
          10000,
          { writeBytes: async (ref, bytes) => saved.push({ ref, value: JSON.parse(bytes) }) },
        );
    const call = creation ? transport.call : transport.request;
    await call('/api/me');
    const postPath = creation ? '/api/clio/conversations' : `/api/clio/conversations/${id}/stream`;
    await call(postPath, { message: 'unit-only' });
    assert.equal(observed.length, 2);
    if (!creation) {
      assert.equal(saved.length, 1);
      assert.equal(saved[0].ref, 'stream-response-observation.json');
      assert.equal(saved[0].value.status, 201);
      assert.equal(saved[0].value.captureAuthority, false);
    }
    for (const request of observed) {
      assert.equal(new URL(request.url).origin, 'https://os.capiro.ai');
      assert.equal(request.options.rejectUnauthorized, true);
      assert.equal(request.options.headers['user-agent'], 'Capiro-Meri-Authorized-QA/1.0');
      assert.equal(request.options.headers.authorization, 'Bearer unit-only-placeholder');
      assert.equal(request.options.headers['x-capiro-tenant'], slug);
    }
    assert.equal(observed[0].options.headers.accept, 'application/json');
    assert.equal(
      observed[1].options.headers.accept,
      creation ? 'application/json' : 'text/event-stream',
    );
    assert.equal(observed[1].options.headers['content-type'], 'application/json');
    assert.equal(observed[1].body, JSON.stringify({ message: 'unit-only' }));
    if (creation) assert.throws(() => call(postPath, {}), /CREATION_REQUEST_BOUND/u);
    else await assert.rejects(call(postPath, {}), /CONTROLLED_READ_DUPLICATE_OR_UNAPPROVED_WRITE/u);
    assert.equal(observed.length, 2);
  });
}

// UNIT fixtures only: no mocked result here can mint collector or live authority.
function sample(caseId = '20') {
  const manifest = {
    namespace: FIXTURE_NAMESPACE,
    target: 'capiro-dev',
    status: 'ready',
    ids: {
      users: { pat: { userId: randomUUID(), clerkUserId: 'user_synthetic_unit' } },
      tenants: { t1: { tenantId: AUTHORIZED_TENANTS.T1.id, clerkOrgId: 'org_synthetic_unit' } },
    },
    targetBinding: { clerkInstanceId: 'instance_unit' },
    handles: { users: { pat: `${FIXTURE_NAMESPACE}-pat@example.com` } },
  };
  const input = controlledReadSetupInput(manifest, {
    caseId,
    clientId: randomUUID(),
    captureRunId: randomUUID(),
  });
  const definition = createControlledReadDefinition({ ...input, tenantId: input.ctx.tenantId });
  const plan = {
    kind: 'meri-controlled-read-setup-plan',
    version: 1,
    tenantId: input.ctx.tenantId,
    actorUserId: input.ctx.userId,
    clientId: input.clientId,
    caseId,
    captureRunId: input.captureRunId,
    tenantRowVersion: '42',
    priorSettingsSha256: 'a'.repeat(64),
    definitionSha256: sha256Stable(definition),
    physicalMapSha256: definition.physicalMapSha256,
    sourceMap: definition.sourceMap,
    sourceStorage: 'immutable_source_owned_controlled_adapter',
    sharedCorpusWrites: 0,
    liveAcceptance: 'NOT_RUN',
  };
  plan.planSha256 = sha256Stable(plan);
  const operationId = randomUUID();
  const seedReceipt = receiptWithHash({
    kind: 'meri-synthetic-fixture-seed-receipt',
    owner: 'meri_controlled_read_v1',
    operationId,
    tenantId: input.ctx.tenantId,
    actorUserId: input.ctx.userId,
    caseId,
    clientId: input.clientId,
    captureRunId: input.captureRunId,
    definitionSha256: sha256Stable(definition),
    physicalMapSha256: definition.physicalMapSha256,
    sourceStorage: 'immutable_source_owned_controlled_adapter',
    sharedCorpusWrites: 0,
  });
  const resetReceipt = receiptWithHash({
    kind: 'meri-synthetic-fixture-reset-receipt',
    owner: 'meri_controlled_read_v1',
    operationId,
    scope: 'replace_owned_capture_binding_and_controlled_locator_only',
    priorSettingsSha256: 'b'.repeat(64),
    sharedCorpusWrites: 0,
  });
  const currentVerifySha256 = 'c'.repeat(64);
  const binding = {
    caseId,
    captureRunId: input.captureRunId,
    fixtureVersion: frozenFixture.version,
    physicalMapSha256: definition.physicalMapSha256,
    seedReceiptId: fixtureReceiptId(seedReceipt, 'meri-synthetic-fixture-seed-receipt'),
    resetReceiptId: fixtureReceiptId(resetReceipt, 'meri-synthetic-fixture-reset-receipt'),
    fixtureNamespace: FIXTURE_NAMESPACE,
    actorUserId: input.ctx.userId,
    clientId: input.clientId,
    currentVerifySha256,
  };
  const setup = {
    status: 'CONTROLLED_READ_BOUND',
    operationId,
    binding,
    sourceMap: definition.sourceMap,
    currentVerifySha256,
    seedReceipt,
    resetReceipt,
    sharedCorpusWrites: 0,
    liveAcceptance: 'NOT_RUN',
  };
  const budgetPlan = {
    status: 'READY_FOR_RATE_QUALIFICATION',
    caseId,
    captureRunId: input.captureRunId,
    currentVerifySha256,
    captureBindingSha256: sha256Stable(binding),
    priorQualificationSha256: sha256Stable(null),
    tenantRowVersion: '43',
  };
  const now = Date.now();
  const rates = {
    kind: 'meri-capture-reviewed-provider-rates',
    version: 1,
    priceKind: 'qualified_text_token_upper_bound',
    maxTokens: 200000,
    observedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3600000).toISOString(),
    rates: [
      {
        kind: 'openai_responses',
        provider: 'unit',
        model: 'unit',
        inputMicrosPerMillion: 1000000,
        outputMicrosPerMillion: 2000000,
      },
    ],
    sources: [
      {
        kind: 'openai_responses',
        provider: 'unit',
        model: 'unit',
        url: 'https://example.invalid/UNIT',
        unitContract: 'UNIT ONLY',
      },
    ],
  };
  const installInput = controlledReadBudgetInstallInput(input, setup, budgetPlan, rates, now);
  const installed = {
    status: 'PROVIDER_QUALIFICATION_INSTALLED',
    tenantId: input.ctx.tenantId,
    clientId: input.clientId,
    captureRunId: input.captureRunId,
    currentVerifySha256,
    captureBindingSha256: sha256Stable(binding),
    qualificationSha256: sha256Stable(installInput.qualification),
    maxCostMicros: 3000000,
    rateEvidenceSha256: sha256Stable(rates),
    rateEvidenceExpiresAt: rates.expiresAt,
  };
  const deployment = {
    apiSha: '1'.repeat(40),
    orchestratorSha: '2'.repeat(40),
    webSha: '3'.repeat(40),
    operatorSourceSha: '4'.repeat(40),
    builds: Object.fromEntries(
      [
        ['api', '1'],
        ['meriv2-orchestrator', '2'],
      ].map(([service, c]) => [
        service,
        {
          service,
          sourceSha: c.repeat(40),
          imageDigest: 'sha256:' + c.repeat(64),
          buildId: 'capiro-build-web-dev:' + randomUUID(),
          buildspecSha256: 'd'.repeat(64),
        },
      ]),
    ),
  };
  const live = controlledReadLiveConfig(input, setup, installInput, installed, deployment, now);
  return {
    manifest,
    input,
    plan,
    setup,
    budgetPlan,
    rates,
    now,
    installInput,
    installed,
    deployment,
    live,
  };
}
for (const caseId of ['20', '72'])
  test(`case${caseId} input chain preserves fixed source and exact owner/CAS/budget/build identities`, () => {
    const s = sample(caseId);
    assert.equal(controlledReadExecuteInput(s.input, s.plan).expectedPlanSha256, s.plan.planSha256);
    assert.equal(
      inspectControlledReadSetupReceipt(s.input, s.setup).bindingSha256,
      sha256Stable(s.setup.binding),
    );
    assert.deepEqual(controlledReadBudgetPlanInput(s.input, s.setup).ctx, s.input.ctx);
    assert.equal(s.live.config.conversationId, null, 'no invented precreated conversation');
    assert.equal(s.live.config.limits.maxSpendUsd, 3);
    assert.equal(s.live.operatorSourceSha, s.deployment.operatorSourceSha);
    assert.equal(s.live.expectedWebSha, s.deployment.webSha);
    assert.deepEqual(s.live.config.scope.sources, s.setup.sourceMap);
  });
test('new reviewed500k rate sheet selects15USD while prior200k qualification remains3USD', () => {
  const s = sample();
  const rates = { ...s.rates, maxTokens: 500000, rates: s.rates.rates.map(r => ({
    ...r, inputMicrosPerMillion: 25000000, outputMicrosPerMillion: 75000000 })) };
  const input = controlledReadBudgetInstallInput(s.input, s.setup, s.budgetPlan, rates, s.now);
  assert.equal(input.qualification.maxCostMicros, 15000000);
  assert.equal(input.qualification.maxTokens, 500000);
  const installed = { ...s.installed, maxCostMicros: 15000000,
    qualificationSha256: sha256Stable(input.qualification), rateEvidenceSha256: sha256Stable(rates) };
  const live = controlledReadLiveConfig(s.input, s.setup, input, installed, s.deployment, s.now);
  assert.equal(live.config.limits.maxSpendUsd, 15);
  assert.equal(s.installInput.qualification.maxCostMicros, 3000000);
  assert.equal(s.live.config.limits.maxSpendUsd, 3);
  assert.throws(() => controlledReadLiveConfig(s.input, s.setup, input, s.installed, s.deployment, s.now));
});
test('rejects other cases/tenants and plans with modified fixed mappings or stale hash', () => {
  const s = sample();
  for (const caseId of ['01', '21', '26', '74'])
    assert.throws(() => controlledReadSetupInput(s.manifest, { ...s.input, caseId }), /SCOPE/);
  for (const mutate of [
    (p) => (p.caseId = '72'),
    (p) => (p.actorUserId = randomUUID()),
    (p) => (p.planSha256 = '0'.repeat(64)),
    (p) => (p.sourceMap['R2-27'].physicalId = randomUUID()),
  ]) {
    const plan = structuredClone(s.plan);
    mutate(plan);
    assert.throws(() => controlledReadExecuteInput(s.input, plan), /PLAN_JOIN/);
  }
  const manifest = structuredClone(s.manifest);
  manifest.ids.tenants.t1.tenantId = AUTHORIZED_TENANTS.T2.id;
  assert.throws(() => controlledReadSetupInput(manifest, s.input), /SCOPE/);
});
test('seed/reset proof rejects swapped run, actor, client, operation and fabricated source/hash', () => {
  const s = sample();
  for (const mutate of [
    (r) => (r.binding.captureRunId = randomUUID()),
    (r) => (r.binding.actorUserId = randomUUID()),
    (r) => (r.binding.clientId = randomUUID()),
    (r) => (r.operationId = randomUUID()),
    (r) => (r.sourceMap['R2-27'].physicalId = randomUUID()),
    (r) => (r.seedReceipt.sharedCorpusWrites = 1),
  ]) {
    const receipt = structuredClone(s.setup);
    mutate(receipt);
    assert.throws(() => inspectControlledReadSetupReceipt(s.input, receipt));
  }
});
test('rates/installation require current bounded exact CAS and qualification joins', () => {
  const s = sample();
  for (const mutate of [
    (p) => (p.captureRunId = randomUUID()),
    (p) => (p.currentVerifySha256 = '0'.repeat(64)),
    (p) => (p.captureBindingSha256 = '0'.repeat(64)),
    (p) => (p.priorQualificationSha256 = ''),
    (p) => (p.tenantRowVersion = null),
  ]) {
    const plan = structuredClone(s.budgetPlan);
    mutate(plan);
    assert.throws(
      () => controlledReadBudgetInstallInput(s.input, s.setup, plan, s.rates, s.now),
      /BUDGET_PLAN/,
    );
  }
  for (const mutate of [
    (r) => (r.expiresAt = new Date(s.now + 5000).toISOString()),
    (r) => (r.maxTokens = 272001),
    (r) => (r.observedAt = new Date(s.now + 1).toISOString()),
    (r) => (r.sources = []),
  ]) {
    const rates = structuredClone(s.rates);
    mutate(rates);
    assert.throws(
      () => controlledReadBudgetInstallInput(s.input, s.setup, s.budgetPlan, rates, s.now),
      /RATES/,
    );
  }
  for (const mutate of [
    (r) => (r.maxCostMicros = 4000000),
    (r) => (r.qualificationSha256 = '0'.repeat(64)),
    (r) => (r.captureRunId = randomUUID()),
    (r) => (r.currentVerifySha256 = '0'.repeat(64)),
  ]) {
    const receipt = structuredClone(s.installed);
    mutate(receipt);
    assert.throws(
      () =>
        controlledReadLiveConfig(s.input, s.setup, s.installInput, receipt, s.deployment, s.now),
      /INSTALL_JOIN/,
    );
  }
  const deployment = structuredClone(s.deployment);
  deployment.builds.api.sourceSha = '9'.repeat(40);
  assert.throws(
    () =>
      controlledReadLiveConfig(s.input, s.setup, s.installInput, s.installed, deployment, s.now),
    /BUILD_BINDING/,
  );
});
test('ordinary synthetic Clerk identity rejects wrong instance/org/member role and foreign user', () => {
  const s = sample(),
    manifest = s.manifest;
  const packet = {
    manifest,
    config: s.live.config,
    instance: { id: 'instance_unit' },
    user: {
      id: manifest.ids.users.pat.clerkUserId,
      firstName: 'Pat',
      lastName: 'Synthetic',
      publicMetadata: { fixtureNamespace: FIXTURE_NAMESPACE },
      emailAddresses: [{ emailAddress: manifest.handles.users.pat }],
    },
    organization: {
      id: 'org_synthetic_unit',
      slug: `${FIXTURE_NAMESPACE}-t1`,
      publicMetadata: { fixtureNamespace: FIXTURE_NAMESPACE },
    },
    memberships: {
      totalCount: 1,
      data: [{ organization: { id: 'org_synthetic_unit' }, role: 'org:member' }],
    },
  };
  assertControlledReadSyntheticIdentity(packet);
  for (const mutate of [
    (p) => (p.instance.id = 'foreign'),
    (p) => (p.user.id = 'foreign'),
    (p) => (p.organization.id = 'foreign'),
    (p) => (p.memberships.data[0].role = 'org:admin'),
    (p) => (p.memberships.totalCount = 2),
  ]) {
    const clone = structuredClone(packet);
    mutate(clone);
    assert.throws(() => assertControlledReadSyntheticIdentity(clone));
  }
});
test('browser cannot mutate application or leave canonical origin, while Clerk auth is allowed', () => {
  assert.equal(
    controlledReadBrowserRequestAllowed({
      url: 'https://os.capiro.ai/meri',
      method: 'GET',
      topNavigation: true,
    }),
    true,
  );
  assert.equal(
    controlledReadBrowserRequestAllowed({
      url: 'https://clerk.app.capiro.ai/v1/client/sign_ins',
      method: 'POST',
    }),
    true,
  );
  for (const value of [
    { url: 'https://os.capiro.ai/api/clio/conversations', method: 'POST' },
    { url: 'https://example.invalid/meri', method: 'GET', topNavigation: true },
    { url: 'http://os.capiro.ai/api', method: 'GET' },
    { url: 'https://clerk.app.capiro.ai.evil.invalid', method: 'POST' },
    { url: 'https://secret@os.capiro.ai/meri', method: 'GET' },
  ])
    assert.equal(controlledReadBrowserRequestAllowed(value), false);
});
// Run the actual post-navigation boundary and its private readiness predicate in
// a local VM. The page double has no browser, authentication or network access.
function localBrowserReadiness(states, beforeTokenEvaluation) {
  const source = readFileSync(new URL('../run-controlled-read.mjs', import.meta.url), 'utf8');
  const helperStart = source.indexOf('async function waitForControlledReadBrowserIdentity(');
  const helperEnd = source.indexOf('\nasync function verifyWeb(', helperStart);
  const start = source.indexOf("    await page.goto(origin + '/meri/t/' + config.conversationId");
  const end = source.indexOf('    summary.capturePrepared = true;', start);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && start > helperEnd && end > start);
  const calls = [],
    readiness = [],
    window = {};
  const token = async (options) => {
    calls.push('token');
    assert.deepEqual(JSON.parse(JSON.stringify(options)), { template: 'capiro', skipCache: true });
    return 'unit-local-token';
  };
  const ready = {
    loaded: true,
    session: { id: 'session_unit', getToken: token },
    user: { id: 'user_unit' },
    organization: { id: 'org_unit' },
  };
  const page = {
    async goto() {
      calls.push('navigation');
      window.Clerk = { loaded: false };
    },
    async waitForFunction(predicate, input, options) {
      calls.push('readiness');
      assert.equal(options.timeout, 45000);
      for (const state of states(ready)) {
        window.Clerk = state;
        readiness.push(Boolean(predicate(input)));
        if (readiness.at(-1)) return;
      }
      throw new Error('UNIT_PRIVATE_BROWSER_DETAIL_MUST_NOT_ESCAPE');
    },
    evaluate: async (callback, input) => {
      beforeTokenEvaluation?.(window);
      return callback(input);
    },
  };
  let prepared;
  const run = vm.runInNewContext(
    `(async () => { let bearer;\n${source.slice(helperStart, helperEnd)}\n${source.slice(start, end)}\nreturn bearer; })`,
    {
      page,
      window,
      origin: 'https://unit.invalid',
      config: { conversationId: randomUUID() },
      actor: { clerkUserId: 'user_unit' },
      tenant: { clerkOrgId: 'org_unit' },
      createdSessionId: 'session_unit',
      expectedWebSha: 'unit-source',
      routeFailure: undefined,
      outRoot: 'unit-output',
      pythonExecutable: 'unit-python',
      spendReservation: Object.freeze({ unitOnly: true }),
      join,
      createWindowsArtifactStorage: () => Object.freeze({ unitOnly: true }),
      prepareControlledReadLiveCapture: async (input) => {
        prepared = input;
        calls.push('prepare');
        return Object.freeze({ unitOnly: true });
      },
      verifyWeb: async () => calls.push('web'),
      need: (condition, code) => {
        if (!condition) throw Object.assign(new Error(code), { safeCode: code });
      },
    },
  );
  return { run, calls, readiness, refresh: () => prepared.bearerSupplier() };
}

test('post-navigation token read waits through unloaded Clerk and missing session for exact identity', async () => {
  const run = localBrowserReadiness((ready) => [
    undefined,
    { ...ready, loaded: false },
    { ...ready, session: null },
    ready,
  ]);
  assert.equal(await run.run(), 'unit-local-token');
  assert.deepEqual(run.readiness, [false, false, false, true]);
  assert.deepEqual(run.calls, ['navigation', 'web', 'readiness', 'token', 'prepare']);
});

test('wrong browser session, actor, org or unavailable token method blocks before token with sanitized failure', async () => {
  for (const mutate of [
    (ready) => ({ ...ready, session: { ...ready.session, id: 'other_session' } }),
    (ready) => ({ ...ready, user: { id: 'other_user' } }),
    (ready) => ({ ...ready, organization: { id: 'other_org' } }),
    (ready) => ({ ...ready, session: { id: 'session_unit' } }),
  ]) {
    const run = localBrowserReadiness((ready) => [mutate(ready)]);
    await assert.rejects(run.run(), (error) => {
      assert.equal(error.message, 'BROWSER_IDENTITY_NOT_READY');
      assert.equal(error.safeCode, 'BROWSER_IDENTITY_NOT_READY');
      return true;
    });
    assert.deepEqual(run.readiness, [false]);
    assert.deepEqual(run.calls, ['navigation', 'web', 'readiness']);
  }
});

test('native bearer supplier refreshes the same session and rejects a later foreign session before token access', async () => {
  let foreign = false;
  const run = localBrowserReadiness((ready) => [
    foreign ? { ...ready, session: { ...ready.session, id: 'other_session' } } : ready,
  ]);
  await run.run();
  assert.equal(await run.refresh(), 'unit-local-token');
  assert.equal(run.calls.filter((call) => call === 'token').length, 2);
  foreign = true;
  await assert.rejects(run.refresh(), /BROWSER_IDENTITY_NOT_READY/);
  assert.equal(run.calls.filter((call) => call === 'token').length, 2);
  assert.equal(run.calls.filter((call) => call === 'prepare').length, 1);
});

test('identity changes between readiness and token evaluation fail closed without token or capture preparation', async () => {
  for (const change of [
    (clerk) => (clerk.session.id = 'other_session'),
    (clerk) => (clerk.user.id = 'other_user'),
    (clerk) => (clerk.organization.id = 'other_org'),
  ]) {
    const run = localBrowserReadiness((ready) => [ready], (window) => change(window.Clerk));
    await assert.rejects(run.run(), /CAPTURE_BEARER_UNAVAILABLE/);
    assert.deepEqual(run.calls, ['navigation', 'web', 'readiness']);
  }
});

test('native conversation readback requires new exact owned empty active row with no previous ledger', () => {
  const s = sample(),
    config = s.live.config;
  const created = {
    id: randomUUID(),
    tenantId: s.input.ctx.tenantId,
    userId: s.input.ctx.userId,
    clientId: s.input.clientId,
    title: `${FIXTURE_NAMESPACE} case20 ${s.input.captureRunId}`,
    archivedAt: null,
    metadata: {},
  };
  assert.equal(
    inspectControlledConversationReadback({ config, created, current: created, messages: [] }),
    created.id,
  );
  for (const mutate of [
    (r) => (r.id = randomUUID()),
    (r) => (r.userId = randomUUID()),
    (r) => (r.clientId = randomUUID()),
    (r) => (r.title += 'other'),
    (r) => (r.archivedAt = new Date().toISOString()),
    (r) => (r.metadata.serverCaptureProviderBudget = {}),
  ]) {
    const current = structuredClone(created);
    mutate(current);
    assert.throws(() =>
      inspectControlledConversationReadback({ config, created, current, messages: [] }),
    );
  }
  assert.throws(
    () =>
      inspectControlledConversationReadback({ config, created, current: created, messages: [{}] }),
    /NOT_EMPTY/,
  );
});
test('materializer CLI refuses failed oneoff receipts and existing output; never starts auth on import', () => {
  const s = sample(),
    root = mkdtempSync(join(tmpdir(), 'meri-controlled-operator-unit-'));
  const save = (name, value) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const plan = save('plan.json', {
    status: 'VERIFIED',
    containerExitCode: 0,
    ownerReceipts: [s.plan],
  });
  const packet = save('packet.json', {
    inputPath: save('input.json', s.input),
    setupPlanPath: plan,
  });
  const out = join(root, 'execute.json');
  const cli = fileURLToPath(new URL('../materialize-controlled-read.mjs', import.meta.url));
  const run = () =>
    spawnSync(process.execPath, [cli, 'setup-execute', '--packet', packet, '--out', out], {
      encoding: 'utf8',
      timeout: 15000,
    });
  assert.equal(run().status, 0);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).expectedPlanSha256, s.plan.planSha256);
  assert.equal(run().status, 1, 'exclusive receipt output cannot be replaced');
  writeFileSync(
    plan,
    JSON.stringify({ status: 'FAILED', containerExitCode: 0, ownerReceipts: [s.plan] }),
  );
  const failed = spawnSync(
    process.execPath,
    [cli, 'setup-execute', '--packet', packet, '--out', join(root, 'failed.json')],
    { encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /EXECUTION_NOT_VERIFIED/);
});

test('submission observation preserves native zero/one and treats absent or invalid attempted outcomes as unknown', () => {
  const observe = controlledReadOperator.controlledReadSubmissionObservation;
  assert.equal(typeof observe, 'function');
  for (const count of [0, 1])
    assert.deepEqual(
      observe({ executionAttempted: true, outcome: { synthesisSubmissionCount: count } }),
      {
        turnsSent: count,
        turnsSentStatus: 'OBSERVED_NATIVE_OUTCOME',
      },
    );
  for (const count of [undefined, null, -1, 2, 0.5, '0', '1', NaN, Infinity, true]) {
    assert.deepEqual(
      observe({ executionAttempted: true, outcome: { synthesisSubmissionCount: count } }),
      {
        turnsSent: null,
        turnsSentStatus: 'UNKNOWN_AFTER_EXECUTION_INTENT',
      },
    );
  }
  for (const outcome of [undefined, null, {}])
    assert.deepEqual(observe({ executionAttempted: true, outcome }), {
      turnsSent: null,
      turnsSentStatus: 'UNKNOWN_AFTER_EXECUTION_INTENT',
    });
  assert.deepEqual(observe({ executionAttempted: false }), {
    turnsSent: 0,
    turnsSentStatus: 'NOT_ATTEMPTED',
  });
  assert.deepEqual(observe(undefined), { turnsSent: 0, turnsSentStatus: 'NOT_ATTEMPTED' });
});

// Execute only the actual private persistence and prepared-to-outcome boundary.
// Test-only collaborators cannot authenticate, acquire a native capability, or dispatch HTTP.
function localExecutionBoundary({ execute, checkpoint, sync = fsyncSync }) {
  const source = readFileSync(new URL('../run-controlled-read.mjs', import.meta.url), 'utf8');
  const persistStart = source.indexOf('  const persist = () => {');
  const persistEnd = source.indexOf('\n  try {\n    const [command', persistStart);
  const executionStart = source.indexOf('    summary.capturePrepared = true;');
  const executionEnd = source.indexOf('    summary.grading =', executionStart);
  assert.ok(
    persistStart >= 0 &&
      persistEnd > persistStart &&
      executionStart > persistEnd &&
      executionEnd > executionStart,
  );
  const output = join(
    mkdtempSync(join(tmpdir(), 'meri-controlled-execution-unit-')),
    'execution.json',
  );
  const summary = {
    caseId: '20',
    captureRunId: randomUUID(),
    conversationId: randomUUID(),
    executionAttempted: false,
  };
  const executeBoundary = vm.runInNewContext(
    `(async () => {\n${source.slice(persistStart, persistEnd)}\n${source.slice(executionStart, executionEnd)}\n})`,
    {
      summary,
      output,
      config: summary,
      capability: Object.freeze({ unitOnly: true }),
      readFileSync,
      writeFileSync,
      openSync,
      fsyncSync: sync,
      closeSync,
      Date,
      JSON,
      controlledReadSubmissionObservation:
        controlledReadOperator.controlledReadSubmissionObservation,
      executeControlledReadLiveCapture: () => execute({ summary, output }),
      saveSpendCheckpoint: () => checkpoint?.({ summary, output }),
      need: (condition, code) => {
        if (!condition) throw new Error(code);
      },
    },
  );
  return { executeBoundary, summary, output };
}

test('execution intent is fsynced before one native call and thrown-after-submission remains unknown', async () => {
  let calls = 0,
    syncs = 0,
    checkpoints = 0;
  const failure = new Error('UNIT_THROWN_AFTER_SUBMISSION');
  const run = localExecutionBoundary({
    sync: (fd) => {
      syncs++;
      fsyncSync(fd);
    },
    execute: ({ summary, output }) => {
      calls++;
      assert.ok(syncs >= 2, 'history and summary were fsynced before native execution');
      const saved = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(saved.executionAttempted, true);
      assert.equal(saved.executionIntent.conversationId, summary.conversationId);
      assert.equal(saved.executionIntent.captureRunId, summary.captureRunId);
      assert.equal(saved.executionIntent.maximumNewTurns, 1);
      assert.deepEqual(saved.submissionObservation, {
        turnsSent: null,
        turnsSentStatus: 'UNKNOWN_AFTER_EXECUTION_INTENT',
      });
      const events = readFileSync(output + '.events.jsonl', 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(events.at(-1).summary.executionAttempted, true);
      throw failure;
    },
    checkpoint: () => {
      checkpoints++;
    },
  });
  await assert.rejects(run.executeBoundary(), (error) => error === failure);
  assert.equal(calls, 1);
  assert.equal(checkpoints, 0);
  assert.equal(run.summary.outcome, undefined);
  assert.deepEqual(controlledReadOperator.controlledReadSubmissionObservation(run.summary), {
    turnsSent: null,
    turnsSentStatus: 'UNKNOWN_AFTER_EXECUTION_INTENT',
  });
});

test('failed intent persistence prevents native dispatch without retry or swallowed error', async () => {
  let calls = 0;
  const failure = new Error('UNIT_FSYNC_FAILED');
  const run = localExecutionBoundary({
    execute: () => {
      calls++;
    },
    sync: () => {
      throw failure;
    },
  });
  await assert.rejects(run.executeBoundary(), (error) => error === failure);
  assert.equal(calls, 0);
});

for (const count of [0, 1])
  test(`native ${count} is durably preserved before a failing final checkpoint`, async () => {
    let calls = 0,
      checkpoints = 0;
    const outcome = {
      status: count ? 'CAPTURE_COMPLETE' : 'CAPTURE_BLOCKED',
      synthesisSubmissionCount: count,
    };
    const failure = new Error('UNIT_CHECKPOINT_FAILED');
    const run = localExecutionBoundary({
      execute: () => {
        calls++;
        return outcome;
      },
      checkpoint: ({ output }) => {
        checkpoints++;
        const saved = JSON.parse(readFileSync(output, 'utf8'));
        assert.deepEqual(saved.outcome, outcome);
        assert.deepEqual(saved.submissionObservation, {
          turnsSent: count,
          turnsSentStatus: 'OBSERVED_NATIVE_OUTCOME',
        });
        throw failure;
      },
    });
    await assert.rejects(run.executeBoundary(), (error) => error === failure);
    assert.equal(calls, 1);
    assert.equal(checkpoints, 1);
  });
