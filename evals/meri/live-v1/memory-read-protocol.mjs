import { createHash } from 'node:crypto';
import { cases } from './cases.mjs';
import { parseCaptureSse } from './capture-transport.mjs';
import { sha256Stable } from './artifact-collector.mjs';
import { AUTHORIZED_TENANTS } from './fixture-provisioning/contract.mjs';
import { readCase01MemoryCorpusInTx } from './fixture-provisioning/case01-memory-owner.mjs';

export const memoryReadCaseIds = Object.freeze(['01', '02', '03', '04', '05']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA = /^[a-f0-9]{40}$/u;
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const need = (value, code) => {
  if (!value) throw new Error(code);
};
const attempted = new Set();

/** This is a plan for the ordinary product route, not capture authority. The
 * caller owns fresh authentication, exact deployed-image checks and the shared
 * spend adapter. No token, login, fixture mutation or model call occurs here. */
export function prepareMemoryReadCase(config) {
  const fields = [
    'caseId',
    'captureRunId',
    'conversationId',
    'actorUserId',
    'clerkUserId',
    'clientId',
    'apiSha',
    'orchestratorSha',
    'webSha',
    'maxCostMicros',
    'timeoutMs',
  ];
  need(
    config && Object.keys(config).sort().join('|') === [...fields].sort().join('|'),
    'MEMORY_READ_CONFIG_FIELDS_INVALID',
  );
  const row = cases.find((item) => item.id === config?.caseId);
  need(
    memoryReadCaseIds.includes(config?.caseId) && row?.actor === 'PAT' && row.client === 'ASTER',
    'MEMORY_READ_CASE_INVALID',
  );
  for (const key of ['captureRunId', 'conversationId', 'actorUserId', 'clientId'])
    need(UUID.test(config[key] ?? ''), 'MEMORY_READ_SCOPE_INVALID');
  need(
    typeof config.clerkUserId === 'string' && config.clerkUserId.startsWith('user_'),
    'MEMORY_READ_ACTOR_INVALID',
  );
  need(
    ['apiSha', 'orchestratorSha', 'webSha'].every((key) => SHA.test(config[key] ?? '')),
    'MEMORY_READ_RELEASE_INVALID',
  );
  need(
    Number.isSafeInteger(config.maxCostMicros) &&
      config.maxCostMicros > 0 &&
      config.maxCostMicros <= 15_000_000,
    'MEMORY_READ_COST_INVALID',
  );
  need(
    Number.isInteger(config.timeoutMs) && config.timeoutMs >= 1000 && config.timeoutMs <= 900000,
    'MEMORY_READ_TIMEOUT_INVALID',
  );
  return Object.freeze({
    ...structuredClone(config),
    kind: 'meri-memory-read-plan',
    schemaVersion: 1,
    tenantId: AUTHORIZED_TENANTS.T1.id,
    tenantSlug: AUTHORIZED_TENANTS.T1.slug,
    actor: 'PAT',
    client: 'ASTER',
    mode: 'Standard',
    prompt: row.prompt,
    promptSha256: hash(row.prompt),
    expectedSources: [...row.requiredSources],
    originalPassCondition: row.rowPassCondition,
    liveAcceptance: 'NOT_RUN',
  });
}

/** Reuse the actual five-source owner. '01' names its corpus, not the case being
 * submitted. This reads/locks canonical rows; it neither rebinds captureEvidence
 * nor creates a provider admission, receipt, fixture or claim. Run with the
 * existing minimal factory's runWithTenant and deps, never AppModule. */
export async function readCurrentMemoryCorpus(deps, ctx, clientId) {
  return deps.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
    readCase01MemoryCorpusInTx(deps, tx, ctx, clientId),
  );
}

function inspectCorpus(proof, plan) {
  need(
    proof?.fixtureReady === true &&
      proof.missing?.length === 0 &&
      proof.caseId === '01' &&
      proof.tenantId === plan.tenantId &&
      proof.actorUserId === plan.actorUserId &&
      proof.clientId === plan.clientId &&
      proof.fixtureNamespace === 'meri-foundation-20260928' &&
      proof.currentVerifySha256 === sha256Stable(proof.currentVerify) &&
      proof.physicalMapSha256 === sha256Stable(proof.sourceMap) &&
      proof.currentVerify?.current?.correction &&
      proof.currentVerify.current.revoked &&
      proof.currentVerify.current.proposed &&
      proof.currentVerify.current.negativeVersions?.length === 2,
    'MEMORY_READ_CORPUS_UNVERIFIED',
  );
  return proof.currentVerifySha256;
}

function inspectIdentity(me, status, conversation, plan) {
  need(
    me?.tenant?.id === plan.tenantId &&
      me.tenant.slug === plan.tenantSlug &&
      me.user?.id === plan.actorUserId &&
      me.user.clerkUserId === plan.clerkUserId &&
      me.role === 'standard_user' &&
      me.features?.meriv3Chat === true,
    'MEMORY_READ_ACTOR_MISMATCH',
  );
  need(status?.configured === true && status.healthy === true, 'MEMORY_READ_RUNTIME_UNREADY');
  need(
    conversation?.id === plan.conversationId && conversation.clientId === plan.clientId,
    'MEMORY_READ_CONVERSATION_MISMATCH',
  );
}

/** Collect ordinary HTTP evidence with one reusable protocol. Ports are explicit
 * trusted operator dependencies, not caller booleans that mint LIVE authority.
 * spend.beforeSubmit must use the real shared enforced budget owner. The current
 * case01-only adapter is not suitable. afterAttempt records observations; only
 * that owner may reconcile actual server usage or retained uncertainty.
 * record must persist bounded synthetic evidence before acknowledging each step.
 * No automatic overall PASS or human grade is produced by this function. */
export async function executeMemoryReadCase(
  config,
  { transport, readCurrentFixture, spend, record },
) {
  const plan = prepareMemoryReadCase(config);
  need(
    transport &&
      typeof transport.request === 'function' &&
      typeof readCurrentFixture === 'function' &&
      typeof spend?.beforeSubmit === 'function' &&
      typeof spend?.afterAttempt === 'function' &&
      typeof record === 'function',
    'MEMORY_READ_OPERATOR_DEPENDENCIES_MISSING',
  );
  const key = `${plan.tenantId}:${plan.conversationId}`;
  need(!attempted.has(key), 'MEMORY_READ_REPLAY_REFUSED');
  attempted.add(key);
  const result = {
    kind: 'meri-memory-read-observation',
    caseId: plan.caseId,
    captureRunId: plan.captureRunId,
    conversationId: plan.conversationId,
    startedAt: new Date().toISOString(),
    status: 'NOT_RUN',
    machineChecks: [],
    humanRubric: 'NOT_REVIEWED',
    overallCaseStatus: 'NOT_RUN',
    submissionAttempted: false,
    httpStatus: null,
    completed: false,
    runIds: [],
    responseHashes: [],
    savedMessageHashes: [],
    unknowns: ['CURRENT_EFFECT_READBACK', 'SOURCE_PASSAGE_AND_CITATION_REVIEW', 'HUMAN_RUBRIC'],
  };
  let reservation;
  const exchange = async (name, path, body) => {
    const response = await transport.request(path, body);
    need(
      typeof response?.text === 'string' && Number.isInteger(response.status),
      'MEMORY_READ_RESPONSE_INVALID',
    );
    result.responseHashes.push({ name, sha256: hash(response.text), status: response.status });
    let savedBody = response.text;
    // Do not copy profile fields, configuration or unexpected prior conversation
    // contents before actor/empty-conversation qualification. Keep the full body
    // digest above, and only identity/readiness metadata for these GETs.
    if (['actor', 'runtime', 'conversation', 'messages-before'].includes(name)) {
      let value;
      try {
        value = JSON.parse(response.text);
      } catch {
        value = null;
      }
      savedBody =
        name === 'actor'
          ? {
              tenantId: value?.tenant?.id,
              tenantSlug: value?.tenant?.slug,
              actorUserId: value?.user?.id,
              clerkUserId: value?.user?.clerkUserId,
              role: value?.role,
              meriv3Chat: value?.features?.meriv3Chat,
            }
          : name === 'runtime'
            ? { configured: value?.configured, healthy: value?.healthy }
            : name === 'conversation'
              ? { id: value?.id, clientId: value?.clientId }
              : { count: Array.isArray(value) ? value.length : null };
    }
    await record(`${name}.json`, {
      method: body === undefined ? 'GET' : 'POST',
      path,
      status: response.status,
      releaseSha: response.releaseSha ?? null,
      body: savedBody,
    });
    // Preserve a rejected HTTP response before classifying it. Never retry POST.
    if (body !== undefined) result.httpStatus = response.status;
    need(response.status >= 200 && response.status < 300, 'MEMORY_READ_HTTP_REJECTED');
    need(response.releaseSha === plan.apiSha, 'MEMORY_READ_API_SOURCE_CHANGED');
    return response;
  };
  const json = async (name, path) => JSON.parse((await exchange(name, path)).text);
  try {
    await record('plan.json', plan);
    const me = await json('actor', '/api/me');
    const status = await json('runtime', '/api/clio/status');
    const conversation = await json(
      'conversation',
      `/api/clio/conversations/${plan.conversationId}`,
    );
    inspectIdentity(me, status, conversation, plan);
    const beforeMessages = await json(
      'messages-before',
      `/api/clio/conversations/${plan.conversationId}/messages`,
    );
    need(
      Array.isArray(beforeMessages) && beforeMessages.length === 0,
      'MEMORY_READ_CONVERSATION_NOT_EMPTY',
    );
    const before = await readCurrentFixture();
    const corpusHash = inspectCorpus(before, plan);
    await record('fixture-before.json', before);
    result.machineChecks.push({ check: 'actor_client_current_corpus', status: 'PASS' });
    reservation = await spend.beforeSubmit({
      caseId: plan.caseId,
      captureRunId: plan.captureRunId,
      conversationId: plan.conversationId,
      maxCostMicros: plan.maxCostMicros,
    });
    need(
      reservation !== null && typeof reservation === 'object',
      'MEMORY_READ_ENFORCED_BUDGET_MISSING',
    );
    // This persisted intent plus the shared durable reservation prohibits a
    // retry across process restarts; the local set additionally fences this run.
    await record('submission-intent.json', {
      caseId: plan.caseId,
      captureRunId: plan.captureRunId,
      conversationId: plan.conversationId,
      promptSha256: plan.promptSha256,
      maxCostMicros: plan.maxCostMicros,
    });
    result.submissionAttempted = true;
    const stream = await exchange(
      'stream',
      `/api/clio/conversations/${plan.conversationId}/stream`,
      { body: plan.prompt },
    );
    const parsed = parseCaptureSse(stream.text);
    await record('events.json', parsed);
    need(
      parsed.issues.length === 0 &&
        parsed.events.filter((event) => event.type === 'done').length === 1,
      'MEMORY_READ_STREAM_INCOMPLETE',
    );
    result.completed = true;
    result.runIds = [
      ...new Set(
        parsed.events
          .flatMap((event) => [event.runId, event.traceId, event.turnId])
          .filter((id) => typeof id === 'string' && id.length),
      ),
    ];
    const messages = await json(
      'messages-after',
      `/api/clio/conversations/${plan.conversationId}/messages`,
    );
    need(Array.isArray(messages), 'MEMORY_READ_MESSAGE_SHAPE_INVALID');
    result.savedMessageHashes = messages.map((message) => ({
      id: message.id,
      role: message.role,
      sha256: sha256Stable(message),
    }));
    const users = messages.filter((message) => message.role === 'user');
    const answers = messages.filter((message) => message.role === 'assistant');
    need(
      users.length === 1 &&
        users[0].body === plan.prompt &&
        answers.length === 1 &&
        typeof answers[0].body === 'string' &&
        answers[0].body.trim(),
      'MEMORY_READ_PERSISTENCE_INCOMPLETE',
    );
    result.answerSha256 = hash(answers[0].body);
    result.machineChecks.push({ check: 'one_prompt_one_saved_answer', status: 'PASS' });
    const after = await readCurrentFixture();
    await record('fixture-after.json', after);
    need(inspectCorpus(after, plan) === corpusHash, 'MEMORY_READ_CORPUS_CHANGED');
    result.machineChecks.push({ check: 'fixture_corpus_unchanged', status: 'PASS' });
    result.status = 'COLLECTED_NOT_GRADED';
  } catch (error) {
    result.status = result.submissionAttempted
      ? 'ATTEMPT_REQUIRES_RECONCILIATION'
      : 'BLOCKED_BEFORE_SUBMISSION';
    result.failureCode = /^MEMORY_READ_[A-Z_]+$/u.test(error?.message ?? '')
      ? error.message
      : 'MEMORY_READ_OPERATOR_OR_TRANSPORT_FAILED';
  } finally {
    result.finishedAt = new Date().toISOString();
    if (reservation !== null && typeof reservation === 'object') {
      try {
        await spend.afterAttempt(reservation, {
          submissionAttempted: result.submissionAttempted,
          httpStatus: result.httpStatus,
          completed: result.completed,
          runIds: result.runIds,
          responseHashes: result.responseHashes,
          savedMessageHashes: result.savedMessageHashes,
        });
        result.budgetObservationRecorded = true;
      } catch {
        result.budgetObservationRecorded = false;
        result.status = 'ATTEMPT_REQUIRES_RECONCILIATION';
        result.failureCode = 'MEMORY_READ_BUDGET_RECONCILIATION_REQUIRED';
      }
    }
    await record('observation.json', result);
  }
  return result;
}
