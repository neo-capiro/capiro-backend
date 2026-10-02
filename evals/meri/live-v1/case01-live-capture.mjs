import https from 'node:https';
import {
  claimCaptureSpendReservation,
  assertCaptureSpendReservation,
  settleCaptureSpendReservation,
} from './capture-spend-aggregate.mjs';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import { ArtifactCollector, sha256Bytes, sha256Stable } from './artifact-collector.mjs';
import { assertWindowsArtifactStorage } from './windows-artifact-storage.mjs';
import { AUTHORIZED_TENANTS, parseCaptureSse } from './capture-transport.mjs';
import { frozenFixture } from './fixture.mjs';
import { cases } from './cases.mjs';
import { assertCase01ReceiptJoins, assertCase14ReceiptJoins } from './case01-receipt-joins.mjs';
import { readCase01BuildAuthority } from './case01-build-authority.mjs';
import { nativeMeriCaptureHeaders } from './lib/native-http.mjs';

const ORIGIN = 'https://os.capiro.ai';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const lock = JSON.parse(readFileSync(new URL('./contract-lock.json', import.meta.url), 'utf8'));
const testCase = cases.find((row) => row.id === '01');
export const CASE14_RECALL_PROMPT = 'What is the recently approved Aster memory? Cite its source.';
const fixedCases = Object.freeze({
  '01': Object.freeze({
    actor: testCase.actor,
    client: testCase.client,
    role: 'standard_user',
    logicalId: 'MA1-v2',
    prompt: testCase.prompt,
  }),
  14: Object.freeze({
    actor: 'PRIYA',
    client: 'ASTER',
    role: 'user_admin',
    logicalId: 'MEM-PROPOSAL-14',
    prompt: CASE14_RECALL_PROMPT,
  }),
});
const sessions = new WeakMap();
const outcomes = new WeakMap();
const claimedRuns = new Set();
const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
const need = (condition, code) => {
  if (!condition) fail(code);
};

/** Static scope checks do not create live authority. */
export function inspectCase01Scope(config, env = process.env) {
  return inspectMemoryScope(config, env, '01');
}
export function inspectCase14RecallScope(config, env = process.env) {
  return inspectMemoryScope(config, env, '14');
}
function inspectMemoryScope(config, env, caseId) {
  const selected = fixedCases[caseId];
  need(
    config?.schemaVersion === 1 && config.provenance === 'LIVE_CAPTURE' && config.caseId === caseId,
    'CASE01_ONLY',
  );
  need(
    config.target?.apiOrigin === ORIGIN && config.target.environment === 'capiro-dev',
    'CASE01_TARGET_NOT_APPROVED',
  );
  need(
    config.limits?.concurrency === 1 &&
      Number.isInteger(config.limits.deadlineMs) &&
      config.limits.deadlineMs >= 1000 &&
      config.limits.deadlineMs <= 900000,
    'CASE01_LIMIT_INVALID',
  );
  const maxSpendMicros = config.limits.maxSpendUsd * 1000000;
  need(
    Number.isSafeInteger(maxSpendMicros) && maxSpendMicros > 0 && maxSpendMicros <= 3000000,
    'CASE01_COST_LIMIT_INVALID',
  );
  need(
    config.contract?.fixtureSha256 === lock.fixtureSha256 &&
      config.contract.contractSourceSha256 === lock.contractSourceSha256 &&
      config.fixture?.version === frozenFixture.version &&
      config.fixture.namespace === 'meri-foundation-20260928' &&
      config.fixture.sha256 === lock.fixtureSha256 &&
      config.fixture.mappingSha256 === sha256Stable(config.scope?.sources),
    'CASE01_FROZEN_CONTRACT_MISMATCH',
  );
  const actor = config.scope?.actors?.[selected.actor],
    tenant = config.scope?.tenants?.[frozenFixture.actors[selected.actor].tenantId],
    client = config.scope?.clients?.[selected.client];
  need(
    actor &&
      tenant &&
      client &&
      AUTHORIZED_TENANTS[tenant.slug] === tenant.physicalId &&
      actor.role === selected.role &&
      actor.tenantPhysicalId === tenant.physicalId &&
      client.tenantPhysicalId === tenant.physicalId &&
      UUID.test(actor.userId) &&
      UUID.test(client.physicalId) &&
      typeof actor.clerkUserId === 'string' &&
      actor.clerkUserId.length > 0,
    'CASE01_SCOPE_INVALID',
  );
  need(
    UUID.test(config.captureRunId ?? '') && UUID.test(config.conversationId ?? ''),
    'CASE01_PRECREATED_CONVERSATION_REQUIRED',
  );
  const source = config.scope.sources?.[selected.logicalId];
  need(
    Object.keys(config.scope.sources).join(',') === selected.logicalId &&
      UUID.test(source?.physicalId ?? '') &&
      source.frozenFixtureId === selected.logicalId &&
      source.kind === 'memory' &&
      source.tenantPhysicalId === tenant.physicalId &&
      source.clientPhysicalId === client.physicalId &&
      typeof source.version === 'string',
    'CASE01_SOURCE_SCOPE_INVALID',
  );
  need(
    /^meri-synthetic-fixture-seed-receipt:sha256:[a-f0-9]{64}$/u.test(
      config.fixture.seedReceiptId ?? '',
    ) &&
      /^meri-synthetic-fixture-reset-receipt:sha256:[a-f0-9]{64}$/u.test(
        config.fixture.resetReceiptId ?? '',
      ),
    'CASE01_OWNER_RECEIPTS_REQUIRED',
  );
  const bearer = env.MERI_LIVE_BEARER_TOKEN?.trim();
  need(typeof bearer === 'string' && bearer.length > 0, 'CASE01_AUTH_MISSING');
  return {
    selected,
    actor,
    tenant,
    client,
    source,
    bearer,
    expected: {
      caseId,
      captureRunId: config.captureRunId,
      conversationId: config.conversationId,
      tenantId: tenant.physicalId,
      actorUserId: actor.userId,
      clientId: client.physicalId,
      apiSha: config.deployment?.apiSha,
      orchestratorSha: config.deployment?.orchestratorSha,
      fixtureVersion: config.fixture.version,
      physicalMapSha256: config.fixture.mappingSha256,
      seedReceiptId: config.fixture.seedReceiptId,
      resetReceiptId: config.fixture.resetReceiptId,
      maxSpendMicros,
    },
  };
}

/** Pure negative-testable joins; READY in caller JSON is never a capability. */
export function inspectCase01Admission({
  scope,
  admission,
  me,
  status,
  conversation,
  apiReleaseSha,
  now = Date.now(),
}) {
  need(scope.expected.caseId === '01', 'CASE01_ONLY');
  return inspectMemoryAdmission({ scope, admission, me, status, conversation, apiReleaseSha, now });
}
export function inspectCase14RecallAdmission(input) {
  need(input.scope.expected.caseId === '14', 'CASE14_ONLY');
  return inspectMemoryAdmission(input);
}
function inspectMemoryAdmission({
  scope,
  admission,
  me,
  status,
  conversation,
  apiReleaseSha,
  now = Date.now(),
}) {
  const { expected, actor, tenant, client, source } = scope;
  const selected = fixedCases[expected.caseId];
  need(
    me?.tenant?.id === tenant.physicalId &&
      me.tenant.slug === tenant.slug &&
      me.user?.id === actor.userId &&
      me.user.clerkUserId === actor.clerkUserId &&
      me.role === selected.role &&
      me.features?.meriv3Chat === true,
    'CASE01_CURRENT_ACTOR_MISMATCH',
  );
  need(
    status?.configured === true && status.healthy === true && apiReleaseSha === expected.apiSha,
    'CASE01_RUNTIME_UNREADY',
  );
  need(
    conversation?.id === expected.conversationId &&
      conversation.clientId === client.physicalId &&
      admission?.schemaVersion === 1 &&
      admission.kind === `meri-case${expected.caseId}-authenticated-admission` &&
      admission.status === 'READY',
    'CASE01_ADMISSION_MISSING',
  );
  for (const key of [
    'caseId',
    'captureRunId',
    'conversationId',
    'tenantId',
    'actorUserId',
    'clientId',
  ])
    need(admission[key] === expected[key], 'CASE01_ADMISSION_SCOPE_MISMATCH');
  need(
    Number.isSafeInteger(admission.issuedAt) &&
      Number.isSafeInteger(admission.expiresAt) &&
      admission.issuedAt <= now + 1000 &&
      admission.expiresAt > now &&
      admission.expiresAt - admission.issuedAt <= 60000 &&
      admission.apiReleaseSha === expected.apiSha &&
      admission.toolAuthority === 'shared_static_registry_read_only' &&
      HASH.test(admission.toolCatalogSha256 ?? '') &&
      admission.dynamicMcpAllowed === false &&
      admission.incidentalWriters === 'suppressed',
    'CASE01_ADMISSION_BOUNDARY_UNPROVED',
  );
  const fixture = admission.fixture;
  need(
    fixture?.fixtureNamespace === 'meri-foundation-20260928' &&
      HASH.test(fixture.currentVerifySha256 ?? '') &&
      ['fixtureVersion', 'physicalMapSha256', 'seedReceiptId', 'resetReceiptId'].every(
        (key) => fixture[key] === expected[key],
      ) &&
      fixture.sources?.length === 1 &&
      fixture.sources[0].logicalId === selected.logicalId &&
      fixture.sources[0].physicalId === source.physicalId &&
      fixture.sources[0].tenantId === expected.tenantId &&
      fixture.sources[0].clientId === expected.clientId &&
      fixture.sources[0].sourceVersion === source.version &&
      HASH.test(fixture.sources[0].contentSha256 ?? ''),
    'CASE01_CURRENT_FIXTURE_UNPROVED',
  );
  const budget = admission.providerBudget;
  need(
    budget?.ready === true &&
      budget.coverage === `case${expected.caseId}_memory_turn` &&
      HASH.test(budget.qualificationSha256 ?? '') &&
      budget.currentVerifySha256 === fixture.currentVerifySha256 &&
      budget.maxCostMicros === expected.maxSpendMicros,
    'CASE01_PROVIDER_CEILING_UNPROVED',
  );
  return admission;
}

function privateBytes(value, bearer) {
  const forbidden = /(?:authorization|cookie|secret|password|api[_-]?key|session)/iu;
  const tokenFields = new Set([
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'chargedTokens',
  ]);
  const scan = (item, path = []) => {
    if (typeof item === 'string')
      need(
        !item.includes(bearer) &&
          !/Bearer\s+[^\s]+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/iu.test(
            item,
          ),
        'CASE01_SECRET_IN_EVIDENCE',
      );
    if (item && typeof item === 'object')
      for (const [key, child] of Object.entries(item)) {
        need(!forbidden.test(key), 'CASE01_SECRET_FIELD_IN_EVIDENCE');
        if (/token/iu.test(key)) {
          const numeric = typeof child === 'number' && Number.isSafeInteger(child) && child >= 0;
          const observation =
            child?.status === 'OBSERVED' &&
            child.reason === null &&
            Number.isSafeInteger(child.value) &&
            child.value >= 0;
          need(
            tokenFields.has(key) &&
              (numeric ||
                observation ||
                (child?.value === null &&
                  ['UNKNOWN', 'NOT_RUN', 'PENDING_BINDING'].includes(child.status))),
            'CASE01_SECRET_FIELD_IN_EVIDENCE',
          );
        }
        scan(child, [...path, key]);
      }
  };
  scan(value);
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function nativeTransport(scope, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let requests = 0,
    submitted = 0;
  const request = async (path, body) => {
    need(Date.now() < deadline && ++requests <= 10, 'CASE01_REQUEST_BOUND');
    need(
      path.startsWith('/api/') && !path.includes('\\') && !path.startsWith('//'),
      'CASE01_REQUEST_PATH_INVALID',
    );
    const url = new URL(path, ORIGIN);
    need(url.origin === ORIGIN, 'CASE01_TARGET_ESCAPE');
    if (body !== undefined) {
      need(
        submitted === 0 &&
          path === `/api/clio/conversations/${scope.expected.conversationId}/stream`,
        'CASE01_DUPLICATE_OR_UNAPPROVED_WRITE',
      );
      submitted++;
    }
    return new Promise((resolve, reject) => {
      let hardTimer;
      const finish = (value) => {
        clearTimeout(hardTimer);
        resolve(value);
      };
      const stop = (error) => {
        clearTimeout(hardTimer);
        reject(error);
      };
      const req = https.request(
        url,
        {
          method: body === undefined ? 'GET' : 'POST',
          rejectUnauthorized: true,
          headers: {
            ...nativeMeriCaptureHeaders(scope.bearer, scope.tenant.slug),
            accept: body === undefined ? 'application/json' : 'text/event-stream',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) {
              req.destroy();
              stop(new Error('CASE01_RESPONSE_LIMIT'));
            } else chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              need(response.statusCode >= 200 && response.statusCode < 300, 'CASE01_HTTP_REJECTED');
              const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
              finish({
                text,
                releaseSha: response.headers['x-capiro-release-sha'],
                status: response.statusCode,
              });
            } catch {
              stop(new Error('CASE01_RESPONSE_REJECTED'));
            }
          });
          response.on('error', () => stop(new Error('CASE01_RESPONSE_INTERRUPTED')));
        },
      );
      hardTimer = setTimeout(
        () => {
          req.destroy();
          stop(new Error('CASE01_DEADLINE'));
        },
        Math.max(1, deadline - Date.now()),
      );
      req.setTimeout(Math.max(1, Math.min(900000, deadline - Date.now())), () => {
        req.destroy();
        stop(new Error('CASE01_DEADLINE'));
      });
      req.on('error', () => stop(new Error('CASE01_NETWORK_FAILED')));
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  };
  return {
    request,
    json: async (path) => {
      const response = await request(path);
      return { ...response, value: JSON.parse(response.text) };
    },
    counts: () => ({ requestCount: requests, synthesisSubmissionCount: submitted }),
  };
}

async function currentAdmission(scope, transport) {
  const me = await transport.json('/api/me');
  const status = await transport.json('/api/clio/status');
  const conversation = await transport.json(
    `/api/clio/conversations/${scope.expected.conversationId}`,
  );
  const admission = inspectMemoryAdmission({
    scope,
    me: me.value,
    status: status.value,
    conversation: conversation.value,
    admission: conversation.value.captureAdmission,
    apiReleaseSha: status.releaseSha,
  });
  return {
    admission,
    identity: {
      tenantId: scope.tenant.physicalId,
      tenantSlug: scope.tenant.slug,
      actorUserId: scope.actor.userId,
      clerkUserId: scope.actor.clerkUserId,
      role: me.value.role,
      clientId: scope.client.physicalId,
    },
  };
}

/** Actual HTTPS + current AWS/read-only build verification. No fetch/owner mocks,
 * service secret, caller boolean or serialized receipt can mint this capability.
 * The precreated synthetic conversation is the only permitted application target.
 */
export async function prepareCase01LiveCapture({
  config,
  runRoot,
  artifactStorage,
  spendReservation,
  env = process.env,
}) {
  return prepareMemoryLiveCapture(
    { config, runRoot, artifactStorage, spendReservation, env },
    '01',
  );
}
export async function prepareCase14RecallCapture(input) {
  return prepareMemoryLiveCapture(input, '14');
}
async function prepareMemoryLiveCapture(
  { config, runRoot, artifactStorage, spendReservation, env = process.env },
  caseId,
) {
  const scope = inspectMemoryScope(config, env, caseId);
  const claim = [
    scope.expected.tenantId,
    scope.expected.conversationId,
    scope.expected.captureRunId,
  ].join(':');
  need(!claimedRuns.has(claim), 'CASE01_RUN_ALREADY_CLAIMED');
  assertWindowsArtifactStorage(artifactStorage, runRoot);
  claimCaptureSpendReservation(spendReservation, scope.expected);
  const collector = new ArtifactCollector(
    runRoot,
    {
      schemaVersion: 1,
      kind: `meri-case${caseId}-authenticated-capture`,
      provenance: 'LIVE_CAPTURE',
      captureRunId: config.captureRunId,
      caseId,
      fixtureVersion: frozenFixture.version,
      fixtureSha256: lock.fixtureSha256,
      contractSourceSha256: lock.contractSourceSha256,
    },
    [scope.bearer],
    { storage: artifactStorage },
  );
  await collector.init();
  claimedRuns.add(claim);
  const builds = await readCase01BuildAuthority(config.deployment);
  const transport = nativeTransport(scope, config.limits.deadlineMs);
  const before = await currentAdmission(scope, transport);
  await collector.writeBytes('admission.json', privateBytes(before, scope.bearer));
  await collector.writeBytes('immutable-builds.json', privateBytes(builds, scope.bearer));
  const capability = Object.freeze({ kind: `meri-case${caseId}-live-session` });
  sessions.set(capability, {
    scope,
    config: structuredClone(config),
    collector,
    transport,
    before,
    builds,
    spendReservation,
    consumed: false,
  });
  return capability;
}

export async function executeCase01LiveCapture(capability) {
  need(
    sessions.get(capability)?.scope.expected.caseId === '01',
    'CASE01_AUTHENTICATED_CAPABILITY_REQUIRED',
  );
  return executeMemoryLiveCapture(capability);
}
export async function executeCase14RecallCapture(capability) {
  need(
    sessions.get(capability)?.scope.expected.caseId === '14',
    'CASE14_AUTHENTICATED_CAPABILITY_REQUIRED',
  );
  return executeMemoryLiveCapture(capability);
}
async function executeMemoryLiveCapture(capability) {
  const state = sessions.get(capability);
  need(state && !state.consumed, 'CASE01_AUTHENTICATED_CAPABILITY_REQUIRED');
  state.consumed = true;
  const { scope, config, collector, transport, before, builds, spendReservation } = state;
  const caseId = scope.expected.caseId,
    selected = fixedCases[caseId];
  let outcome;
  try {
    need(Date.now() - builds.observedAt <= 60000, 'CASE01_BUILD_PROOF_STALE');
    const current = await currentAdmission(scope, transport);
    need(
      isDeepStrictEqual(current.admission.fixture, before.admission.fixture) &&
        isDeepStrictEqual(current.admission.providerBudget, before.admission.providerBudget),
      'CASE01_PREDISPATCH_OWNER_DRIFT',
    );
    await collector.writeJson('submission-intent.json', {
      caseId,
      captureRunId: config.captureRunId,
      conversationId: config.conversationId,
      promptSha256: sha256Bytes(selected.prompt),
      maxCostMicros: scope.expected.maxSpendMicros,
    });
    const previous = await transport.json(
      `/api/clio/conversations/${config.conversationId}/messages`,
    );
    need(
      Array.isArray(previous.value) && previous.value.length === 0,
      'CASE01_CONVERSATION_NOT_EMPTY',
    );
    need(
      Date.now() < current.admission.expiresAt && Date.now() - builds.observedAt <= 60000,
      'CASE01_PRESUBMIT_AUTHORITY_STALE',
    );
    assertCaptureSpendReservation(spendReservation, scope.expected);
    const stream = await transport.request(
      `/api/clio/conversations/${config.conversationId}/stream`,
      { body: selected.prompt },
    );
    const parsed = parseCaptureSse(stream.text),
      events = parsed.events;
    need(
      parsed.issues.length === 0 &&
        events.filter((e) => e.type === 'done').length === 1 &&
        events.filter((e) => e.type === 'turn_accepted').length === 1 &&
        !events.some((e) =>
          ['error', 'pending_approval', 'page_write', 'draft_updated', 'workflow_updated'].includes(
            e.type,
          ),
        ),
      'CASE01_STREAM_UNCERTAIN',
    );
    const done = events.find((e) => e.type === 'done');
    const answer = events
      .filter((e) => e.type === 'text')
      .map((e) => e.text ?? '')
      .join('');
    const citations = events
      .filter((e) => e.type === 'citations')
      .flatMap((e) => e.citations ?? []);
    need(
      citations.length === 1 && citations[0].source?.kind === 'memory',
      'CASE01_CITATION_MISSING',
    );
    const locator = citations[0].source;
    const query = new URLSearchParams(
      Object.entries(locator)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    const source = await transport.json(`/api/clio/sources?${query}`);
    const messages = await transport.json(
      `/api/clio/conversations/${config.conversationId}/messages`,
    );
    need(Array.isArray(messages.value), 'CASE01_MESSAGES_INVALID');
    const rows = messages.value.filter(
      (row) => row.id === done.messageId && row.role === 'assistant',
    );
    need(
      rows.length === 1 &&
        typeof rows[0].body === 'string' &&
        rows[0].body.trim() === answer.trim(),
      'CASE01_PERSISTENCE_MISMATCH',
    );
    const message = rows[0],
      metadata = message.metadata ?? {};
    const inputs = {
      expected: { ...scope.expected, assistantMessageId: message.id },
      admission: current.admission,
      authority: metadata[`case${caseId}CaptureAuthority`],
      policy: metadata.serverReadonlyCapturePolicy,
      envelope: metadata.serverCaptureEvidenceReceipt,
      doneEnvelope: done.serverCaptureEvidenceReceipt,
      answer: message.body,
      sourceReadback: source.value,
      citations,
    };
    const joins =
      caseId === '14' ? assertCase14ReceiptJoins(inputs) : assertCase01ReceiptJoins(inputs);
    const evidence = {
      schemaVersion: 1,
      kind: `meri-case${caseId}-authenticated-evidence`,
      provenance: 'LIVE_CAPTURE',
      inputs,
      builds,
      identity: current.identity,
      streamSha256: sha256Bytes(stream.text),
      streamAnswerSha256: sha256Bytes(answer),
      ...transport.counts(),
    };
    const descriptor = await collector.writeBytes(
      `case${caseId}-evidence.json`,
      privateBytes(evidence, scope.bearer),
    );
    outcome = Object.freeze({
      status: 'CAPTURE_COMPLETE',
      acceptanceStatus: 'NOT_RUN',
      acceptanceReason:
        'Canonical authenticated capture complete; original deterministic row checks and human adjudication still required',
      caseId,
      captureRunId: config.captureRunId,
      conversationId: config.conversationId,
      evidence: descriptor,
      ...transport.counts(),
    });
    outcomes.set(outcome, { joins, evidence, collector, descriptor });
    try {
      const checkpoint = settleCaptureSpendReservation(spendReservation, outcome);
      await collector.writeJson('aggregate-spend-checkpoint.json', checkpoint);
    } catch (error) {
      outcomes.delete(outcome);
      throw error;
    }
  } catch (error) {
    const counts = transport.counts();
    outcome = Object.freeze({
      status: counts.synthesisSubmissionCount ? 'CAPTURE_UNCERTAIN' : 'BLOCKED',
      acceptanceStatus: 'NOT_RUN',
      reason: /^CASE01_[A-Z_]+$/u.test(error?.code ?? error?.message ?? '')
        ? (error.code ?? error.message)
        : 'CASE01_CAPTURE_REJECTED',
      caseId,
      captureRunId: config.captureRunId,
      ...counts,
    });
    await collector.writeJson('blocked.json', outcome);
  }
  await collector.finalize(outcome);
  return outcome;
}

/** Only this process's actual capture can supply verified authority to a later
 * row/adjudication adapter; serialized lookalikes and pure join results fail.
 */
export function currentCase01CaptureAuthority(outcome) {
  need(outcome?.caseId === '01', 'CASE01_AUTHENTICATED_OUTCOME_REQUIRED');
  return currentMemoryCaptureAuthority(outcome);
}
export function currentCase14RecallAuthority(outcome) {
  need(outcome?.caseId === '14', 'CASE14_AUTHENTICATED_OUTCOME_REQUIRED');
  return currentMemoryCaptureAuthority(outcome);
}
function currentMemoryCaptureAuthority(outcome) {
  const state = outcomes.get(outcome);
  need(state, 'CASE01_AUTHENTICATED_OUTCOME_REQUIRED');
  need(
    sha256Bytes(state.collector.storage.readBytes('bundle-owner.json')) ===
      state.collector.ownerSha256,
    'CASE01_ARTIFACT_OWNER_CHANGED',
  );
  const bytes = state.collector.storage.readBytes(state.descriptor.ref);
  need(sha256Bytes(bytes) === state.descriptor.sha256, 'CASE01_ARTIFACT_BYTES_CHANGED');
  return structuredClone({ joins: state.joins, evidence: state.evidence });
}
