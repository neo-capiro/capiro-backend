import test from 'node:test';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256Stable } from '../artifact-collector.mjs';
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
    const transport = creation
      ? factory({ scope: { tenants: { T1: { slug } } } }, 'unit-only-placeholder')
      : factory(
          { bearer: 'unit-only-placeholder', tenant: { slug }, expected: { conversationId: id } },
          10000,
        );
    const call = creation ? transport.call : transport.request;
    await call('/api/me');
    const postPath = creation ? '/api/clio/conversations' : `/api/clio/conversations/${id}/stream`;
    await call(postPath, { message: 'unit-only' });
    assert.equal(observed.length, 2);
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
