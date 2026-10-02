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
import { assertControlledReadReceiptJoins } from './controlled-read-receipt-joins.mjs';
import { createControlledReadDefinition } from './fixture-provisioning/controlled-read-definitions.mjs';
import { readCase01BuildAuthority } from './case01-build-authority.mjs';

const ORIGIN = 'https://os.capiro.ai';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const lock = JSON.parse(readFileSync(new URL('./contract-lock.json', import.meta.url), 'utf8'));
const selectedCase = (id) => cases.find((row) => row.id === id && ['20', '72'].includes(id));
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
export function inspectControlledReadScope(config, env = process.env) {
  need(
    config?.schemaVersion === 1 &&
      config.provenance === 'LIVE_CAPTURE' &&
      ['20', '72'].includes(config.caseId),
    'CONTROLLED_READ_ONLY',
  );
  need(
    config.target?.apiOrigin === ORIGIN && config.target.environment === 'capiro-dev',
    'CONTROLLED_READ_TARGET_NOT_APPROVED',
  );
  need(
    config.limits?.concurrency === 1 &&
      Number.isInteger(config.limits.deadlineMs) &&
      config.limits.deadlineMs >= 1000 &&
      config.limits.deadlineMs <= 900000,
    'CONTROLLED_READ_LIMIT_INVALID',
  );
  const maxSpendMicros = config.limits.maxSpendUsd * 1000000;
  need(
    Number.isSafeInteger(maxSpendMicros) && maxSpendMicros > 0 && maxSpendMicros <= 3000000,
    'CONTROLLED_READ_COST_LIMIT_INVALID',
  );
  need(
    config.contract?.fixtureSha256 === lock.fixtureSha256 &&
      config.contract.contractSourceSha256 === lock.contractSourceSha256 &&
      config.fixture?.version === frozenFixture.version &&
      config.fixture.namespace === 'meri-foundation-20260928' &&
      config.fixture.sha256 === lock.fixtureSha256 &&
      config.fixture.mappingSha256 === sha256Stable(config.scope?.sources),
    'CONTROLLED_READ_FROZEN_CONTRACT_MISMATCH',
  );
  const testCase = selectedCase(config.caseId);
  const actor = config.scope?.actors?.[testCase.actor],
    tenant = config.scope?.tenants?.[frozenFixture.actors[testCase.actor].tenantId],
    client = config.scope?.clients?.[testCase.client];
  need(
    actor &&
      tenant &&
      client &&
      AUTHORIZED_TENANTS[tenant.slug] === tenant.physicalId &&
      actor.role === 'standard_user' &&
      actor.tenantPhysicalId === tenant.physicalId &&
      client.tenantPhysicalId === tenant.physicalId &&
      UUID.test(actor.userId) &&
      UUID.test(client.physicalId) &&
      typeof actor.clerkUserId === 'string' &&
      actor.clerkUserId.length > 0,
    'CONTROLLED_READ_SCOPE_INVALID',
  );
  need(
    UUID.test(config.captureRunId ?? '') && UUID.test(config.conversationId ?? ''),
    'CONTROLLED_READ_PRECREATED_CONVERSATION_REQUIRED',
  );
  const definition = createControlledReadDefinition({
    caseId: config.caseId,
    tenantId: tenant.physicalId,
    clientId: client.physicalId,
    captureRunId: config.captureRunId,
  });
  need(
    isDeepStrictEqual(config.scope.sources, definition.sourceMap),
    'CONTROLLED_READ_SOURCE_SCOPE_INVALID',
  );
  const source = definition.reads[0];
  need(
    /^meri-synthetic-fixture-seed-receipt:sha256:[a-f0-9]{64}$/u.test(
      config.fixture.seedReceiptId ?? '',
    ) &&
      /^meri-synthetic-fixture-reset-receipt:sha256:[a-f0-9]{64}$/u.test(
        config.fixture.resetReceiptId ?? '',
      ),
    'CONTROLLED_READ_OWNER_RECEIPTS_REQUIRED',
  );
  const bearer = env.MERI_LIVE_BEARER_TOKEN?.trim();
  need(typeof bearer === 'string' && bearer.length > 0, 'CONTROLLED_READ_AUTH_MISSING');
  return {
    actor,
    tenant,
    client,
    source,
    definition,
    bearer,
    expected: {
      caseId: config.caseId,
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
export function inspectControlledReadAdmission({
  scope,
  admission,
  me,
  status,
  conversation,
  apiReleaseSha,
  now = Date.now(),
}) {
  const { expected, actor, tenant, client, source } = scope;
  need(
    me?.tenant?.id === tenant.physicalId &&
      me.tenant.slug === tenant.slug &&
      me.user?.id === actor.userId &&
      me.user.clerkUserId === actor.clerkUserId &&
      me.role === 'standard_user' &&
      me.features?.meriv3Chat === true,
    'CONTROLLED_READ_CURRENT_ACTOR_MISMATCH',
  );
  need(
    status?.configured === true && status.healthy === true && apiReleaseSha === expected.apiSha,
    'CONTROLLED_READ_RUNTIME_UNREADY',
  );
  need(
    conversation?.id === expected.conversationId &&
      conversation.clientId === client.physicalId &&
      admission?.schemaVersion === 1 &&
      admission.kind === 'meri-controlled-read-authenticated-admission' &&
      admission.status === 'READY',
    'CONTROLLED_READ_ADMISSION_MISSING',
  );
  for (const key of [
    'caseId',
    'captureRunId',
    'conversationId',
    'tenantId',
    'actorUserId',
    'clientId',
  ])
    need(admission[key] === expected[key], 'CONTROLLED_READ_ADMISSION_SCOPE_MISMATCH');
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
    'CONTROLLED_READ_ADMISSION_BOUNDARY_UNPROVED',
  );
  const fixture = admission.fixture;
  need(
    fixture?.fixtureNamespace === 'meri-foundation-20260928' &&
      HASH.test(fixture.currentVerifySha256 ?? '') &&
      ['fixtureVersion', 'physicalMapSha256', 'seedReceiptId', 'resetReceiptId'].every(
        (key) => fixture[key] === expected[key],
      ) &&
      fixture.sources?.length === 1 &&
      fixture.sources[0].logicalId === source.logicalId &&
      fixture.sources[0].physicalId === source.physicalId &&
      fixture.sources[0].tenantId === expected.tenantId &&
      fixture.sources[0].clientId === (expected.caseId === '20' ? null : expected.clientId) &&
      fixture.sources[0].sourceVersion === source.version &&
      fixture.sources[0].kind === source.kind &&
      fixture.sources[0].sourceStorage === 'immutable_source_owned_controlled_adapter' &&
      fixture.sources[0].contentSha256 === source.contentSha256,
    'CONTROLLED_READ_CURRENT_FIXTURE_UNPROVED',
  );
  const budget = admission.providerBudget;
  need(
    budget?.ready === true &&
      budget.coverage === `case${expected.caseId}_controlled_read_turn` &&
      HASH.test(budget.qualificationSha256 ?? '') &&
      budget.currentVerifySha256 === fixture.currentVerifySha256 &&
      budget.maxCostMicros === expected.maxSpendMicros,
    'CONTROLLED_READ_PROVIDER_CEILING_UNPROVED',
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
        'CONTROLLED_READ_SECRET_IN_EVIDENCE',
      );
    if (item && typeof item === 'object')
      for (const [key, child] of Object.entries(item)) {
        need(!forbidden.test(key), 'CONTROLLED_READ_SECRET_FIELD_IN_EVIDENCE');
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
            'CONTROLLED_READ_SECRET_FIELD_IN_EVIDENCE',
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
    need(Date.now() < deadline && ++requests <= 10, 'CONTROLLED_READ_REQUEST_BOUND');
    need(
      path.startsWith('/api/') && !path.includes('\\') && !path.startsWith('//'),
      'CONTROLLED_READ_REQUEST_PATH_INVALID',
    );
    const url = new URL(path, ORIGIN);
    need(url.origin === ORIGIN, 'CONTROLLED_READ_TARGET_ESCAPE');
    if (body !== undefined) {
      need(
        submitted === 0 &&
          path === `/api/clio/conversations/${scope.expected.conversationId}/stream`,
        'CONTROLLED_READ_DUPLICATE_OR_UNAPPROVED_WRITE',
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
            'user-agent': 'Capiro-Meri-Authorized-QA/1.0',
            authorization: `Bearer ${scope.bearer}`,
            'x-capiro-tenant': scope.tenant.slug,
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
              stop(new Error('CONTROLLED_READ_RESPONSE_LIMIT'));
            } else chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              need(
                response.statusCode >= 200 && response.statusCode < 300,
                'CONTROLLED_READ_HTTP_REJECTED',
              );
              const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
              finish({
                text,
                releaseSha: response.headers['x-capiro-release-sha'],
                status: response.statusCode,
              });
            } catch {
              stop(new Error('CONTROLLED_READ_RESPONSE_REJECTED'));
            }
          });
          response.on('error', () => stop(new Error('CONTROLLED_READ_RESPONSE_INTERRUPTED')));
        },
      );
      hardTimer = setTimeout(
        () => {
          req.destroy();
          stop(new Error('CONTROLLED_READ_DEADLINE'));
        },
        Math.max(1, deadline - Date.now()),
      );
      req.setTimeout(Math.max(1, Math.min(900000, deadline - Date.now())), () => {
        req.destroy();
        stop(new Error('CONTROLLED_READ_DEADLINE'));
      });
      req.on('error', () => stop(new Error('CONTROLLED_READ_NETWORK_FAILED')));
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
  const admission = inspectControlledReadAdmission({
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
export async function prepareControlledReadLiveCapture({
  config,
  runRoot,
  artifactStorage,
  spendReservation,
  env = process.env,
}) {
  const scope = inspectControlledReadScope(config, env);
  const claim = [
    scope.expected.tenantId,
    scope.expected.conversationId,
    scope.expected.captureRunId,
  ].join(':');
  need(!claimedRuns.has(claim), 'CONTROLLED_READ_RUN_ALREADY_CLAIMED');
  assertWindowsArtifactStorage(artifactStorage, runRoot);
  claimCaptureSpendReservation(spendReservation, scope.expected);
  const collector = new ArtifactCollector(
    runRoot,
    {
      schemaVersion: 1,
      kind: 'meri-controlled-read-authenticated-capture',
      provenance: 'LIVE_CAPTURE',
      captureRunId: config.captureRunId,
      caseId: config.caseId,
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
  const capability = Object.freeze({ kind: 'meri-controlled-read-live-session' });
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

export async function executeControlledReadLiveCapture(capability) {
  const state = sessions.get(capability);
  need(state && !state.consumed, 'CONTROLLED_READ_AUTHENTICATED_CAPABILITY_REQUIRED');
  state.consumed = true;
  const { scope, config, collector, transport, before, builds, spendReservation } = state;
  const testCase = selectedCase(config.caseId);
  let outcome;
  try {
    need(Date.now() - builds.observedAt <= 60000, 'CONTROLLED_READ_BUILD_PROOF_STALE');
    const current = await currentAdmission(scope, transport);
    need(
      isDeepStrictEqual(current.admission.fixture, before.admission.fixture) &&
        isDeepStrictEqual(current.admission.providerBudget, before.admission.providerBudget),
      'CONTROLLED_READ_PREDISPATCH_OWNER_DRIFT',
    );
    await collector.writeJson('submission-intent.json', {
      caseId: config.caseId,
      captureRunId: config.captureRunId,
      conversationId: config.conversationId,
      promptSha256: sha256Bytes(testCase.prompt),
      maxCostMicros: scope.expected.maxSpendMicros,
    });
    const previous = await transport.json(
      `/api/clio/conversations/${config.conversationId}/messages`,
    );
    need(
      Array.isArray(previous.value) && previous.value.length === 0,
      'CONTROLLED_READ_CONVERSATION_NOT_EMPTY',
    );
    need(
      Date.now() < current.admission.expiresAt && Date.now() - builds.observedAt <= 60000,
      'CONTROLLED_READ_PRESUBMIT_AUTHORITY_STALE',
    );
    assertCaptureSpendReservation(spendReservation, scope.expected);
    const stream = await transport.request(
      `/api/clio/conversations/${config.conversationId}/stream`,
      { body: testCase.prompt },
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
      'CONTROLLED_READ_STREAM_UNCERTAIN',
    );
    const done = events.find((e) => e.type === 'done');
    const answer = events
      .filter((e) => e.type === 'text')
      .map((e) => e.text ?? '')
      .join('');
    const citations = events
      .filter((e) => e.type === 'citations')
      .flatMap((e) => e.citations ?? []);
    let sourceReadback = null;
    if (config.caseId === '20') {
      need(
        citations.length === 1 && citations[0].source?.kind === 'controlled_read',
        'CONTROLLED_READ_CITATION_MISSING',
      );
      const locator = citations[0].source;
      need(
        locator.recordId === scope.source.physicalId &&
          locator.clientId === scope.expected.clientId &&
          locator.conversationId === config.conversationId &&
          locator.version === 'v1' &&
          locator.section === 'page 14',
        'CONTROLLED_READ_CITATION_SCOPE_MISMATCH',
      );
      const query = new URLSearchParams(
        Object.entries(locator)
          .filter(([, v]) => v !== null && v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      );
      sourceReadback = (await transport.json(`/api/clio/sources?${query}`)).value;
    } else need(citations.length === 0, 'CONTROLLED_READ_ERROR_CANNOT_BE_CITED');
    const messages = await transport.json(
      `/api/clio/conversations/${config.conversationId}/messages`,
    );
    need(Array.isArray(messages.value), 'CONTROLLED_READ_MESSAGES_INVALID');
    const rows = messages.value.filter(
      (row) => row.id === done.messageId && row.role === 'assistant',
    );
    need(
      rows.length === 1 &&
        typeof rows[0].body === 'string' &&
        rows[0].body.trim() === answer.trim(),
      'CONTROLLED_READ_PERSISTENCE_MISMATCH',
    );
    const message = rows[0],
      metadata = message.metadata ?? {};
    const inputs = {
      expected: { ...scope.expected, assistantMessageId: message.id },
      admission: current.admission,
      authority: metadata.controlledReadCaptureAuthority,
      policy: metadata.serverReadonlyCapturePolicy,
      envelope: metadata.serverCaptureEvidenceReceipt,
      doneEnvelope: done.serverCaptureEvidenceReceipt,
      answer: message.body,
      sourceReadback,
      citations,
    };
    await collector.writeBytes('captured-inputs.json', privateBytes(inputs, scope.bearer));
    const joins = assertControlledReadReceiptJoins(inputs);
    const evidence = {
      schemaVersion: 1,
      kind: 'meri-controlled-read-authenticated-evidence',
      provenance: 'LIVE_CAPTURE',
      inputs,
      builds,
      identity: current.identity,
      streamSha256: sha256Bytes(stream.text),
      streamAnswerSha256: sha256Bytes(answer),
      ...transport.counts(),
    };
    const descriptor = await collector.writeBytes(
      'controlled-read-evidence.json',
      privateBytes(evidence, scope.bearer),
    );
    outcome = Object.freeze({
      status: 'CAPTURE_COMPLETE',
      acceptanceStatus: 'NOT_RUN',
      acceptanceReason:
        'Controlled adapter authenticated capture complete; original deterministic row checks and human adjudication still required',
      caseId: config.caseId,
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
      reason: /^CONTROLLED_READ_[A-Z_]+$/u.test(error?.code ?? error?.message ?? '')
        ? (error.code ?? error.message)
        : 'CONTROLLED_READ_CAPTURE_REJECTED',
      caseId: config.caseId,
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
export function currentControlledReadCaptureAuthority(outcome) {
  const state = outcomes.get(outcome);
  need(state, 'CONTROLLED_READ_AUTHENTICATED_OUTCOME_REQUIRED');
  need(
    sha256Bytes(state.collector.storage.readBytes('bundle-owner.json')) ===
      state.collector.ownerSha256,
    'CONTROLLED_READ_ARTIFACT_OWNER_CHANGED',
  );
  const bytes = state.collector.storage.readBytes(state.descriptor.ref);
  need(sha256Bytes(bytes) === state.descriptor.sha256, 'CONTROLLED_READ_ARTIFACT_BYTES_CHANGED');
  return structuredClone({ joins: state.joins, evidence: state.evidence });
}
