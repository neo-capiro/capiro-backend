import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  inspectCase01Scope,
  inspectCase01Admission,
  executeCase01LiveCapture,
  currentCase01CaptureAuthority,
  prepareCase01LiveCapture,
} from '../case01-live-capture.mjs';
import { inspectCase01Build } from '../case01-build-authority.mjs';
import { assertCase01ReceiptJoins } from '../case01-receipt-joins.mjs';
import { sha256Bytes, sha256Stable } from '../artifact-collector.mjs';
import { cases } from '../cases.mjs';
import { frozenFixture } from '../fixture.mjs';
const lock = JSON.parse(readFileSync(new URL('../contract-lock.json', import.meta.url), 'utf8'));
const id = (n) =>
  `${n}`.repeat(8) +
  '-' +
  `${n}`.repeat(4) +
  '-4' +
  `${n}`.repeat(3) +
  '-8' +
  `${n}`.repeat(3) +
  '-' +
  `${n}`.repeat(12);
const obs = (value) => ({ status: 'OBSERVED', value, reason: null });
const unknown = () => ({
  status: 'UNKNOWN',
  value: null,
  reason: 'canonical owner readback required',
});
export function fixture() {
  const c = cases.find((row) => row.id === '01');
  const tenantId = 'f2d6cf8f-057c-479a-8110-62fe5086d43f';
  const text = 'Monthly reports contain fiscal year, budget stage, citations, and action owner.';
  const source = {
    frozenFixtureId: 'MA1-v2',
    physicalId: id(4),
    tenantPhysicalId: tenantId,
    clientPhysicalId: id(3),
    kind: 'memory',
    version: 'memory-version:actual-proposal',
  };
  const config = {
    schemaVersion: 1,
    provenance: 'LIVE_CAPTURE',
    caseId: '01',
    target: { apiOrigin: 'https://os.capiro.ai', environment: 'capiro-dev' },
    limits: { concurrency: 1, deadlineMs: 60000, maxSpendUsd: 3 },
    contract: lock,
    captureRunId: id(5),
    conversationId: id(6),
    deployment: { apiSha: 'a'.repeat(40), orchestratorSha: 'b'.repeat(40) },
    scope: {
      actors: {
        [c.actor]: {
          userId: id(2),
          clerkUserId: 'synthetic-clerk',
          role: 'standard_user',
          tenantPhysicalId: tenantId,
        },
      },
      tenants: {
        [frozenFixture.actors[c.actor].tenantId]: {
          physicalId: tenantId,
          slug: 'meri-foundation-20260928-t1',
        },
      },
      clients: { [c.client]: { physicalId: id(3), tenantPhysicalId: tenantId } },
      sources: { 'MA1-v2': source },
    },
    fixture: {
      namespace: 'meri-foundation-20260928',
      version: frozenFixture.version,
      sha256: lock.fixtureSha256,
      seedReceiptId: `meri-synthetic-fixture-seed-receipt:sha256:${'1'.repeat(64)}`,
      resetReceiptId: `meri-synthetic-fixture-reset-receipt:sha256:${'2'.repeat(64)}`,
    },
  };
  config.fixture.mappingSha256 = sha256Stable(config.scope.sources);
  const scope = inspectCase01Scope(config, { MERI_LIVE_BEARER_TOKEN: 'synthetic-test-bearer' });
  const now = Date.now();
  const canonical = {
    fixtureNamespace: config.fixture.namespace,
    fixtureVersion: config.fixture.version,
    physicalMapSha256: config.fixture.mappingSha256,
    currentVerifySha256: 'c'.repeat(64),
    seedReceiptId: config.fixture.seedReceiptId,
    resetReceiptId: config.fixture.resetReceiptId,
    sources: [
      {
        logicalId: 'MA1-v2',
        physicalId: source.physicalId,
        tenantId,
        clientId: id(3),
        sourceVersion: source.version,
        contentSha256: sha256Bytes(text),
      },
    ],
  };
  const budget = {
    ready: true,
    qualificationSha256: 'd'.repeat(64),
    currentVerifySha256: canonical.currentVerifySha256,
    maxCostMicros: 3000000,
    coverage: 'case01_memory_turn',
  };
  const admission = {
    ...scope.expected,
    schemaVersion: 1,
    kind: 'meri-case01-authenticated-admission',
    status: 'READY',
    issuedAt: now,
    expiresAt: now + 60000,
    apiReleaseSha: config.deployment.apiSha,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: 'e'.repeat(64),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    fixture: canonical,
    providerBudget: budget,
  };
  const admissionInput = {
    scope,
    admission,
    me: {
      tenant: { id: tenantId, slug: scope.tenant.slug },
      user: { id: id(2), clerkUserId: 'synthetic-clerk' },
      role: 'standard_user',
      features: { meriv3Chat: true },
    },
    status: { configured: true, healthy: true },
    conversation: { id: id(6), clientId: id(3) },
    apiReleaseSha: config.deployment.apiSha,
    now,
  };
  const policy = {
    ...scope.expected,
    policyId: id(8),
    requestId: 'request',
    traceId: 'trace',
    turnId: id(7),
    expiresAt: now + 1800000,
    toolAuthority: admission.toolAuthority,
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
  };
  const receipt = {
    ...policy,
    version: 1,
    kind: 'server_capture_evidence_receipt',
    purpose: 'server_capture_evidence',
    status: 'BLOCKED',
    blockers: [
      `source_client_authority_unproved:${id(4)}`,
      `source_tenant_authority_unproved:${id(4)}`,
    ],
    releases: {
      api: { releaseRevision: obs(config.deployment.apiSha) },
      orchestrator: { releaseRevision: obs(config.deployment.orchestratorSha) },
    },
    usage: {
      provider: obs('test-provider'),
      model: obs('test-model'),
      inputTokens: obs(50),
      outputTokens: obs(25),
      costKind: 'existing_pricing_estimate',
    },
    fixture: {
      namespace: canonical.fixtureNamespace,
      version: obs(canonical.fixtureVersion),
      physicalMapSha256: obs(canonical.physicalMapSha256),
      seedReceiptId: obs(canonical.seedReceiptId),
      resetReceiptId: obs(canonical.resetReceiptId),
    },
    toolCalls: [
      {
        callId: 'call-1',
        name: 'search_memory',
        attempt: 1,
        status: 'complete',
        readOnly: true,
        sourceIds: [id(4)],
      },
    ],
    sources: [
      {
        sourceId: id(4),
        toolCallId: 'call-1',
        tenantId: unknown(),
        clientId: unknown(),
        currentVersion: obs(`content:${sha256Bytes(text)}`),
        passageSha256: obs(sha256Bytes(text)),
        fullRead: obs(true),
      },
    ],
    effects: {
      boundary: 'bounded_capture_path_hooks',
      logicalEffects: [
        {
          logicalEffectId: 'request:provider-budget-ledger',
          operationId: 'admission',
          receiptId: 'f'.repeat(64),
          status: 'observed',
        },
      ],
      writes: [
        ['conversation_user_message', id(7)],
        ['conversation_assistant_message', id(9)],
        ['assistant_receipt_metadata', id(9)],
        ['provider_budget_ledger', id(6)],
      ].map(([kind, recordId]) => ({
        logicalWriteId: kind === 'provider_budget_ledger' ? 'request:provider-budget-ledger' : kind,
        phase: 'during',
        kind,
        recordId,
        status: 'observed',
      })),
    },
    providerBudget: {
      version: 1,
      boundary: 'case01_memory_turn',
      status: 'SETTLED',
      admissionId: 'admission',
      turnId: id(7),
      ledgerSha256: 'f'.repeat(64),
      qualificationSha256: budget.qualificationSha256,
      attempts: 2,
      chargedTokens: 75,
      chargedCostMicros: 1000,
      maxCostMicros: 3000000,
      unaccountedBoundaries: [],
    },
  };
  const envelope = {
    version: 1,
    audience: 'capiro:meri:server-readonly-capture:evidence:v1',
    purpose: 'server_capture_evidence',
    receipt,
    signature: '0'.repeat(64),
  };
  const authority = {
    ...policy,
    schemaVersion: 1,
    kind: 'meri-case01-authenticated-readback',
    messageId: id(9),
    verifiedAt: now,
    envelopeSha256: sha256Stable(envelope),
    answerSha256: sha256Bytes('answer'),
    fixture: canonical,
    providerBudget: budget,
  };
  const joins = {
    expected: { ...scope.expected, assistantMessageId: id(9) },
    admission,
    authority,
    policy,
    envelope,
    doneEnvelope: structuredClone(envelope),
    answer: 'answer',
    sourceReadback: {
      kind: 'memory',
      status: 'available',
      recordId: id(4),
      sourceVersion: source.version,
      text,
      offset: 0,
      nextCursor: null,
    },
    citations: [
      {
        id: id(4),
        tool: 'search_memory',
        snippet: text,
        source: { recordId: id(4), kind: 'memory', version: `content:${sha256Bytes(text)}` },
      },
    ],
    now,
  };
  return { config, scope, admissionInput, joins };
}
function refresh(input) {
  input.doneEnvelope = structuredClone(input.envelope);
  input.authority.envelopeSha256 = sha256Stable(input.envelope);
}

test('pure admission checks canonical current scope and exact server budget without creating authority', () => {
  const h = fixture();
  assert.equal(inspectCase01Admission(h.admissionInput), h.admissionInput.admission);
  assert.throws(
    () => currentCase01CaptureAuthority({ status: 'CAPTURE_COMPLETE', evidence: h.joins }),
    /CASE01_AUTHENTICATED_OUTCOME_REQUIRED/,
  );
});
test('serialized lookalikes cannot execute or bypass native storage before network', async () => {
  const h = fixture();
  await assert.rejects(
    executeCase01LiveCapture({ kind: 'meri-case01-live-session' }),
    /CASE01_AUTHENTICATED_CAPABILITY_REQUIRED/,
  );
  await assert.rejects(
    prepareCase01LiveCapture({
      config: h.config,
      runRoot: 'C:/unowned',
      artifactStorage: { root: 'C:/unowned' },
      env: { MERI_LIVE_BEARER_TOKEN: 'synthetic-test-bearer' },
    }),
    /unverified native artifact storage capability/,
  );
});
for (const [name, change] of [
  [
    'wrong origin',
    (h) => {
      h.config.target.apiOrigin = 'https://app.capiro.ai';
    },
  ],
  [
    'case20',
    (h) => {
      h.config.caseId = '20';
    },
  ],
  [
    'unapproved tenant',
    (h) => {
      h.scope.tenant.physicalId = id(9);
    },
  ],
  [
    'admin actor',
    (h) => {
      h.scope.actor.role = 'tenant_admin';
    },
  ],
  [
    'no conversation',
    (h) => {
      h.config.conversationId = null;
    },
  ],
  [
    'over3USD',
    (h) => {
      h.config.limits.maxSpendUsd = 3.000001;
    },
  ],
  [
    'parallel',
    (h) => {
      h.config.limits.concurrency = 2;
    },
  ],
  [
    'stale contract',
    (h) => {
      h.config.contract = { ...h.config.contract, fixtureSha256: '0'.repeat(64) };
    },
  ],
])
  test(`scope refuses ${name}`, () => {
    const h = fixture();
    change(h);
    assert.throws(() =>
      inspectCase01Scope(h.config, { MERI_LIVE_BEARER_TOKEN: 'synthetic-test-bearer' }),
    );
  });
for (const [name, change] of [
  [
    'wrong actor',
    (h) => {
      h.me.user.id = id(9);
    },
  ],
  [
    'wrong tenant',
    (h) => {
      h.me.tenant.id = id(9);
    },
  ],
  [
    'wrong client',
    (h) => {
      h.conversation.clientId = id(9);
    },
  ],
  [
    'expired',
    (h) => {
      h.admission.expiresAt = h.now;
    },
  ],
  [
    'mutable dispatch',
    (h) => {
      h.admission.dynamicMcpAllowed = true;
    },
  ],
  [
    'wrong source',
    (h) => {
      h.admission.fixture.sources[0].physicalId = id(9);
    },
  ],
  [
    'missing reset',
    (h) => {
      h.admission.fixture.resetReceiptId = null;
    },
  ],
  [
    'no budget',
    (h) => {
      h.admission.providerBudget.ready = false;
    },
  ],
  [
    'server budget exceeds configured',
    (h) => {
      h.admission.providerBudget.maxCostMicros = 3000001;
    },
  ],
  [
    'different owner version',
    (h) => {
      h.admission.providerBudget.currentVerifySha256 = '9'.repeat(64);
    },
  ],
  [
    'wrong release',
    (h) => {
      h.apiReleaseSha = '0'.repeat(40);
    },
  ],
])
  test(`admission refuses ${name}`, () => {
    const h = fixture().admissionInput;
    change(h);
    assert.throws(() => inspectCase01Admission(h));
  });

test('complete signed/current-source joins are validation only and do not grant acceptance', () => {
  const h = fixture().joins;
  const result = assertCase01ReceiptJoins(h);
  assert.equal(result.status, 'VALIDATED_JOINS_ONLY');
  assert.throws(
    () => currentCase01CaptureAuthority(result),
    /CASE01_AUTHENTICATED_OUTCOME_REQUIRED/,
  );
});
for (const [name, change] of [
  [
    'source tenant contradiction',
    (h) => {
      h.envelope.receipt.sources[0].tenantId = obs(id(9));
    },
  ],
  [
    'source client contradiction',
    (h) => {
      h.envelope.receipt.sources[0].clientId = obs(id(9));
    },
  ],
  [
    'mutating tool',
    (h) => {
      h.envelope.receipt.toolCalls[0].readOnly = false;
    },
  ],
  [
    'unjoined tool',
    (h) => {
      h.envelope.receipt.sources[0].toolCallId = 'other';
    },
  ],
  [
    'source bytes',
    (h) => {
      h.sourceReadback.text += 'changed';
    },
  ],
  [
    'source version',
    (h) => {
      h.sourceReadback.sourceVersion = 'stale';
    },
  ],
  [
    'truncated source',
    (h) => {
      h.sourceReadback.nextCursor = 'more';
    },
  ],
  [
    'citation bytes',
    (h) => {
      h.citations[0].snippet = 'wrong';
    },
  ],
  [
    'current owner changed',
    (h) => {
      h.authority.fixture = structuredClone(h.authority.fixture);
      h.authority.fixture.currentVerifySha256 = '0'.repeat(64);
    },
  ],
  [
    'unsettled cost',
    (h) => {
      h.envelope.receipt.providerBudget.status = 'UNSETTLED';
    },
  ],
  [
    'unaccounted provider',
    (h) => {
      h.envelope.receipt.providerBudget.unaccountedBoundaries = ['embedding'];
    },
  ],
  [
    'cost exceeded',
    (h) => {
      h.envelope.receipt.providerBudget.chargedCostMicros = 3000001;
    },
  ],
  [
    'different budget',
    (h) => {
      h.envelope.receipt.providerBudget.maxCostMicros = 2000000;
    },
  ],
  [
    'unexpected write',
    (h) => {
      h.envelope.receipt.effects.writes.push({
        logicalWriteId: 'bad',
        kind: 'unexpected_write',
        status: 'observed',
      });
    },
  ],
  [
    'logical effect',
    (h) => {
      h.envelope.receipt.effects.logicalEffects.push({ logicalEffectId: 'bad' });
    },
  ],
  [
    'message effect mismatch',
    (h) => {
      h.envelope.receipt.effects.writes[1].recordId = id(8);
    },
  ],
  [
    'missing coverage',
    (h) => {
      h.envelope.receipt.blockers.push('source_coverage_unproved:' + id(4));
    },
  ],
  [
    'wrong build',
    (h) => {
      h.envelope.receipt.releases.api.releaseRevision = obs('9'.repeat(40));
    },
  ],
  [
    'usage missing',
    (h) => {
      h.envelope.receipt.usage.inputTokens = unknown();
    },
  ],
  [
    'expired authority',
    (h) => {
      h.authority.verifiedAt -= 61000;
    },
  ],
])
  test(`receipt joins refuse ${name}`, () => {
    const h = fixture().joins;
    change(h);
    refresh(h);
    assert.throws(() => assertCase01ReceiptJoins(h));
  });

test('SSE and canonical receipt must match exact signed bytes', () => {
  const h = fixture().joins;
  h.doneEnvelope.signature = '9'.repeat(64);
  assert.throws(() => assertCase01ReceiptJoins(h), /CASE01_RECEIPT_PAIR_MISMATCH/);
});
test('exact answer bytes are required', () => {
  const h = fixture().joins;
  h.answer += ' ';
  assert.throws(() => assertCase01ReceiptJoins(h), /CASE01_BYTES_MISMATCH/);
});

function buildFixture() {
  const expected = {
    service: 'api',
    sourceSha: 'a'.repeat(40),
    imageDigest: 'sha256:' + 'b'.repeat(64),
    buildId: 'capiro-build-web-dev:' + id(1),
    buildspecSha256: sha256Bytes('reviewed recipe'),
  };
  return {
    expected,
    build: {
      id: expected.buildId,
      buildStatus: 'SUCCEEDED',
      buildComplete: true,
      resolvedSourceVersion: expected.sourceSha,
      source: {
        type: 'GITHUB',
        location: 'https://github.com/neo-capiro/capirov2.git',
        buildspec: 'reviewed recipe',
      },
      phases: ['PRE_BUILD', 'BUILD', 'POST_BUILD'].map((phaseType) => ({
        phaseType,
        phaseStatus: 'SUCCEEDED',
      })),
    },
    snapshot: {
      task: {
        containerDefinitions: [
          {
            name: 'api',
            image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@${expected.imageDigest}`,
            environment: [
              { name: 'GIT_SHA', value: expected.sourceSha },
              { name: 'RELEASE_SHA', value: expected.sourceSha },
            ],
          },
        ],
      },
      baseline: { imageDigest: expected.imageDigest, taskDefinitionArn: 'expected' },
      service: {
        deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', id: 'deployment' }],
      },
    },
    image: { imageDetails: [{ imageDigest: expected.imageDigest }] },
  };
}
test('build comparison requires exact successful canonical source, recipe and served digest', () => {
  assert.equal(inspectCase01Build(buildFixture()).sourceSha, 'a'.repeat(40));
});
for (const [name, change] of [
  [
    'failed build',
    (h) => {
      h.build.buildStatus = 'FAILED';
    },
  ],
  [
    'wrong source',
    (h) => {
      h.build.resolvedSourceVersion = '0'.repeat(40);
    },
  ],
  [
    'different recipe',
    (h) => {
      h.build.source.buildspec += ' x';
    },
  ],
  [
    'different repository',
    (h) => {
      h.build.source.location = 'https://github.com/other/repo';
    },
  ],
  [
    'failed test phase',
    (h) => {
      h.build.phases[1].phaseStatus = 'FAILED';
    },
  ],
  [
    'wrong image',
    (h) => {
      h.snapshot.baseline.imageDigest = 'sha256:' + '0'.repeat(64);
    },
  ],
  [
    'source label drift',
    (h) => {
      h.snapshot.task.containerDefinitions[0].environment[0].value = '0'.repeat(40);
    },
  ],
])
  test(`build comparison refuses ${name}`, () => {
    const h = buildFixture();
    change(h);
    assert.throws(() => inspectCase01Build(h));
  });
