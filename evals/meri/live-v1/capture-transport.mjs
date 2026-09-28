import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { cases } from './cases.mjs';
import { frozenFixture } from './fixture.mjs';
import { sha256Bytes, sha256Stable, redactSecrets } from './artifact-collector.mjs';

export const APPROVED_LIVE_ORIGINS = Object.freeze(['https://app.capiro.ai']);
export const AUTHORIZED_TENANTS = Object.freeze({
  'meri-foundation-20260928-t1': 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
  'meri-foundation-20260928-t2': '52e91176-08f-4d89-9633-bc212f5bdbbf',
});
export const SUPPORTED_CASE_IDS = Object.freeze(['01', '20']);
const READ_ONLY_TOOL_DENY = /(?:create|update|delete|send|write|approve|reject|apply|execute|mutate|upload|propose)/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SSE_FRAMES = 4_096;
const caseById = new Map(cases.map((item) => [item.id, item]));
const contractLock = JSON.parse(readFileSync(new URL('./contract-lock.json', import.meta.url), 'utf8'));

export class CaptureBlockedError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'CaptureBlockedError';
    this.code = code;
    this.detail = detail;
  }
}

function requireValue(condition, code, message) {
  if (!condition) throw new CaptureBlockedError(code, message);
}

function cleanOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new CaptureBlockedError('TARGET_URL_INVALID', 'apiOrigin must be an exact approved origin'); }
  requireValue(url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '', 'TARGET_URL_INVALID', 'apiOrigin must contain only scheme and host');
  return url.origin;
}

function loopback(origin) {
  const url = new URL(origin);
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

export function assertLiveCaptureReadiness(config) {
  if (config?.provenance !== 'LIVE_CAPTURE') return;
  const origin = cleanOrigin(config?.target?.apiOrigin);
  requireValue(config.target?.environment === 'capiro-dev', 'TARGET_NOT_APPROVED', 'live target must be capiro-dev');
  requireValue(APPROVED_LIVE_ORIGINS.includes(origin), 'TARGET_NOT_APPROVED', 'live API origin must be exactly https://app.capiro.ai');
  throw new CaptureBlockedError(
    'LIVE_SERVER_AUTHORITY_CONTRACT_MISSING',
    'LIVE_CAPTURE is disabled before conversation creation and synthesis because the existing server contract does not expose required capture authority',
    {
      missingServerContracts: [
        'predispatch read-only tool enforcement and incidental-write suppression receipt',
        'server-authored current fixture/source ownership and version receipt',
        'served API and orchestrator release identity receipt',
        'server/provider-enforced cost reservation',
      ],
    },
  );
}

export function sourceMappingDigest(config) {
  return sha256Stable(config?.scope?.sources ?? {});
}

export function validateCaptureConfig(config, caseId, env = process.env) {
  const testCase = caseById.get(caseId);
  requireValue(testCase, 'CASE_UNKNOWN', `unknown case ${caseId}`);
  requireValue(SUPPORTED_CASE_IDS.includes(caseId), 'CASE_UNSUPPORTED', unsupportedCaseReason(testCase));
  requireValue(testCase.surface === 'api' && testCase.expectedOperation?.kind === 'read' && testCase.expectedOperation?.expectedLogicalEffectCount === 0, 'CASE_NOT_READ_ONLY', 'bounded adapter supports API read cases only');
  requireValue(config?.schemaVersion === 1, 'CONFIG_INVALID', 'scope config schemaVersion must be 1');
  requireValue(['LIVE_CAPTURE', 'UNIT_FIXTURE_NOT_LIVE'].includes(config.provenance), 'PROVENANCE_INVALID', 'provenance must be explicit');
  const origin = cleanOrigin(config?.target?.apiOrigin);
  if (config.provenance === 'LIVE_CAPTURE') {
    assertLiveCaptureReadiness(config);
  } else {
    requireValue(config.target.environment === 'controlled-local-http', 'UNIT_TARGET_INVALID', 'unit provenance requires controlled-local-http');
    requireValue(loopback(origin), 'UNIT_TARGET_INVALID', 'unit fixture transport is loopback-only');
  }
  requireValue(config.limits?.concurrency === 1, 'CONCURRENCY_INVALID', 'capture concurrency must equal 1');
  requireValue(Number.isInteger(config.limits?.deadlineMs) && config.limits.deadlineMs >= 1_000 && config.limits.deadlineMs <= 900_000, 'DEADLINE_INVALID', 'deadlineMs must be between 1000 and 900000');
  requireValue(typeof config.limits?.maxSpendUsd === 'number' && config.limits.maxSpendUsd > 0 && config.limits.maxSpendUsd <= 1, 'SPEND_THRESHOLD_INVALID', 'post-hoc maxSpendUsd threshold must be greater than zero and at most 1');
  requireValue(GIT_SHA.test(config.deployment?.apiSha ?? ''), 'DEPLOYMENT_INVALID', 'deployment.apiSha must be an exact git SHA');
  requireValue(GIT_SHA.test(config.deployment?.orchestratorSha ?? ''), 'DEPLOYMENT_INVALID', 'deployment.orchestratorSha must be an exact git SHA');
  requireValue(config.contract?.fixtureSha256 === contractLock.fixtureSha256, 'CONTRACT_LOCK_MISMATCH', 'scope config fixture hash does not match the immutable contract lock');
  requireValue(config.contract?.contractSourceSha256 === contractLock.contractSourceSha256, 'CONTRACT_LOCK_MISMATCH', 'scope config source hash does not match the immutable contract lock');
  requireValue(config.fixture?.namespace === 'meri-foundation-20260928', 'FIXTURE_INVALID', 'fixture namespace is not the approved synthetic namespace');
  requireValue(config.fixture?.version === frozenFixture.version, 'FIXTURE_INVALID', 'fixture version is stale');
  requireValue(config.fixture?.sha256 === config.contract?.fixtureSha256, 'FIXTURE_INVALID', 'fixture hash is not bound to the contract');
  requireValue(config.fixture?.mappingSha256 === sourceMappingDigest(config), 'SCOPE_MAPPING_INVALID', 'physical-to-frozen source mapping hash mismatch');
  requireValue(typeof config.fixture?.seedReceiptId === 'string' && config.fixture.seedReceiptId.length > 0, 'FIXTURE_INVALID', 'seed receipt id is required');

  const actor = config.scope?.actors?.[testCase.actor];
  const tenant = config.scope?.tenants?.[frozenFixture.actors[testCase.actor].tenantId];
  requireValue(actor && tenant, 'SCOPE_MAPPING_MISSING', `actor/tenant mapping is missing for ${testCase.actor}`);
  requireValue(AUTHORIZED_TENANTS[tenant.slug] === tenant.physicalId, 'TENANT_NOT_AUTHORIZED', 'tenant is not one of the two authorized synthetic tenants');
  requireValue(actor.tenantPhysicalId === tenant.physicalId && UUID.test(actor.userId ?? '') && typeof actor.clerkUserId === 'string' && actor.clerkUserId.length > 0, 'ACTOR_MAPPING_INVALID', 'actor physical identity mapping is invalid');
  requireValue(actor.role === 'standard_user', 'ACTOR_ROLE_INVALID', 'read capture actor must be the ordinary standard_user');

  let client = null;
  if (testCase.client) {
    client = config.scope?.clients?.[testCase.client];
    requireValue(client && UUID.test(client.physicalId ?? ''), 'CLIENT_MAPPING_MISSING', `client mapping is missing for ${testCase.client}`);
    requireValue(client.tenantPhysicalId === tenant.physicalId, 'CLIENT_MAPPING_INVALID', 'client mapping is not bound to the selected tenant');
  }
  const sources = testCase.requiredSources.map((logicalId) => {
    const mapping = config.scope?.sources?.[logicalId];
    requireValue(mapping && UUID.test(mapping.physicalId ?? ''), 'SOURCE_MAPPING_MISSING', `physical source mapping is missing for ${logicalId}`);
    requireValue(mapping.tenantPhysicalId === tenant.physicalId, 'SOURCE_MAPPING_INVALID', `source ${logicalId} is not bound to the selected tenant`);
    requireValue(mapping.frozenFixtureId === logicalId, 'SOURCE_MAPPING_INVALID', `source ${logicalId} does not explicitly bind its frozen fixture id`);
    if (mapping.clientPhysicalId !== null) requireValue(mapping.clientPhysicalId === client?.physicalId, 'SOURCE_MAPPING_INVALID', `source ${logicalId} client mapping mismatch`);
    return { logicalId, ...mapping };
  });

  const bearer = env.MERI_LIVE_BEARER_TOKEN?.trim() ?? '';
  requireValue(bearer.length > 0, 'AUTH_MISSING', 'MERI_LIVE_BEARER_TOKEN is required and is never serialized');
  return { testCase, origin, actor, tenant, client, sources, bearer };
}

export function unsupportedCaseReason(testCase) {
  if (!testCase) return 'unknown case';
  if (testCase.surface === 'workspace') return 'UNSUPPORTED_BROWSER_WORKSPACE: browser/UI capture is outside the bounded read adapter';
  if (testCase.surface === 'research') return 'UNSUPPORTED_DURABLE_RESEARCH: restart/resume/research capture is outside the bounded read adapter';
  if (testCase.expectedOperation?.expectedLogicalEffectCount > 0) return 'UNSUPPORTED_WRITE: mutating business tools are prohibited in this slice';
  if (/fault|restart|compaction|retry|disconnect|timeout/i.test(`${testCase.setup} ${testCase.rowPassCondition}`)) return 'UNSUPPORTED_FAULT_OR_STATEFUL_SETUP: fault/restart/compaction injection is prohibited in this slice';
  return 'UNSUPPORTED_API_CASE: no reviewed physical-source adapter exists for this case';
}

function responseHeaders(headers) {
  return Object.fromEntries([...headers.entries()]
    .filter(([key]) => !/^(?:set-cookie|authorization|cookie)$/iu.test(key))
    .sort(([a], [b]) => a.localeCompare(b)));
}

async function readBounded(response) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), interrupted: null };
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CaptureBlockedError('RESPONSE_TOO_LARGE', 'response exceeded the 8 MiB capture bound');
      }
      chunks.push(Buffer.from(value));
    }
    return { bytes: Buffer.concat(chunks), interrupted: null };
  } catch (error) {
    if (error instanceof CaptureBlockedError) throw error;
    return { bytes: Buffer.concat(chunks), interrupted: error instanceof Error ? error.message : String(error) };
  }
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CaptureBlockedError('RESPONSE_INVALID_UTF8', `${label} did not return strict UTF-8`);
  }
}

function parseJson(bytes, label) {
  try { return JSON.parse(decodeUtf8(bytes, label)); }
  catch (error) {
    if (error instanceof CaptureBlockedError) throw error;
    throw new CaptureBlockedError('RESPONSE_INVALID', `${label} did not return JSON`);
  }
}

function parseSse(body) {
  const normalized = body.replace(/\r\n?/gu, '\n');
  const chunks = normalized.split('\n\n');
  const trailing = chunks.pop() ?? '';
  const issues = [];
  if (trailing.trim()) issues.push('SSE_UNTERMINATED_TRAILING_FRAME');
  const frames = chunks.filter((frame) => frame.trim());
  if (frames.length > MAX_SSE_FRAMES) {
    throw new CaptureBlockedError('SSE_FRAME_LIMIT_EXCEEDED', `SSE response exceeded the ${MAX_SSE_FRAMES} frame bound`);
  }
  const events = [];
  for (const frame of frames) {
    const data = frame.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /u, ''));
    if (data.length === 0) continue;
    const payload = data.join('\n');
    try {
      const event = JSON.parse(payload);
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('SSE data is not an event object');
      events.push(event);
    } catch {
      issues.push('SSE_MALFORMED_FRAME');
      events.push({ type: 'capture_parse_error', rawSha256: sha256Bytes(payload) });
    }
  }
  const firstTerminal = events.findIndex((event) => event?.type === 'done');
  if (firstTerminal >= 0 && firstTerminal < events.length - 1) issues.push('SSE_POST_TERMINAL_EVENT');
  if (events.filter((event) => event?.type === 'done').length > 1) issues.push('SSE_DUPLICATE_TERMINAL_EVENT');
  return { events, issues: [...new Set(issues)] };
}

class CaptureTransport {
  constructor({ origin, bearer, tenantSlug, deadlineMs, fetchImpl = fetch, onExchange = async () => {} }) {
    this.origin = origin;
    this.bearer = bearer;
    this.tenantSlug = tenantSlug;
    this.fetchImpl = fetchImpl;
    this.onExchange = onExchange;
    this.sequence = 0;
    this.streamSubmissions = 0;
    this.abort = new AbortController();
    this.deadline = setTimeout(() => this.abort.abort(new DOMException('Capture deadline exceeded', 'TimeoutError')), deadlineMs);
  }

  close() { clearTimeout(this.deadline); }

  async request(path, { method = 'GET', body, auth = true, accept = 'application/json', purpose }) {
    requireValue(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\'), 'PATH_INVALID', 'transport path must be a fixed API path');
    const url = new URL(path, this.origin);
    requireValue(url.origin === this.origin, 'TARGET_ESCAPE', 'request escaped approved origin');
    const sequence = ++this.sequence;
    const startedAt = new Date().toISOString();
    const startedMs = performance.now();
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: 'manual',
        signal: this.abort.signal,
        headers: {
          accept,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(auth ? { authorization: `Bearer ${this.bearer}`, 'x-capiro-tenant': this.tenantSlug } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new CaptureBlockedError(this.abort.signal.aborted ? 'DEADLINE_OR_ABORT' : 'NETWORK_ERROR', `request failed before a response: ${error.message}`);
    }
    const headers = responseHeaders(response.headers);
    if (response.status >= 300 && response.status < 400) {
      await this.onExchange({ sequence, purpose, method, path, startedAt, finishedAt: new Date().toISOString(), durationMs: performance.now() - startedMs, status: response.status, headers, body: '[redirect body not followed]' });
      throw new CaptureBlockedError('REDIRECT_REJECTED', `redirect rejected for ${path}`, { status: response.status, location: headers.location ?? null });
    }
    const read = await readBounded(response);
    const bytes = read.bytes;
    const exchange = { sequence, purpose, method, path, startedAt, finishedAt: new Date().toISOString(), durationMs: performance.now() - startedMs, status: response.status, headers, body: decodeUtf8(bytes, purpose), interrupted: read.interrupted };
    await this.onExchange(exchange);
    if (!response.ok) throw new CaptureBlockedError('HTTP_REJECTED', `${purpose} returned HTTP ${response.status}`, { status: response.status, body: exchange.body.slice(0, 500) });
    return { ...exchange, bytes };
  }

  json(path, options) {
    return this.request(path, options).then((result) => ({ ...result, json: parseJson(result.bytes, options.purpose) }));
  }

  async stream(path, body, purpose) {
    requireValue(this.streamSubmissions === 0, 'DUPLICATE_SYNTHESIS_PREVENTED', 'ambiguous submitted chat is never retried');
    this.streamSubmissions += 1;
    const result = await this.request(path, { method: 'POST', body, accept: 'text/event-stream', purpose });
    const parsed = parseSse(result.body);
    return { ...result, events: parsed.events, parseIssues: parsed.issues };
  }
}

function array(value) { return Array.isArray(value) ? value : []; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function physicalSourceMatch(citation, source) {
  return citation?.id === source.physicalId || citation?.stableId === source.physicalId || citation?.source?.recordId === source.physicalId;
}

function emptyLinks(config, caseId, conversationId, client) {
  return {
    schemaVersion: 1,
    ownerRunId: config.captureRunId,
    caseId,
    conversationId,
    clientPhysicalId: client?.physicalId ?? null,
    scopeMappingSha256: config.fixture.mappingSha256,
    sourceLinks: [],
    toolCallEventHashes: [],
    retrievalTraceSha256: null,
    serverTraceId: null,
    messageReadback: null,
  };
}

function safeRedactEvents(events, bearer, gaps) {
  try {
    return redactSecrets(events, [bearer]);
  } catch {
    gaps.push('CAPTURE_REDACTION_FAILED');
    return [];
  }
}

function uncertainCapture({ config, caseId, client, transport, startedAt, conversationId, setupEffects, gaps, stream, answer, links, usage, observedCostUsd }) {
  const retainedGaps = [...gaps];
  const events = safeRedactEvents(stream?.events ?? [], transport.bearer, retainedGaps);
  return {
    status: 'CAPTURE_UNCERTAIN',
    acceptanceStatus: 'NOT_RUN',
    acceptanceReason: 'chat submission did not produce a complete trustworthy receipt and will not be retried',
    startedAt,
    finishedAt: new Date().toISOString(),
    caseId,
    conversationId,
    setupEffects,
    gaps: [...new Set(retainedGaps)],
    events,
    answer,
    links: links ?? emptyLinks(config, caseId, conversationId, client),
    usage,
    postHocSpendThresholdUsd: config.limits.maxSpendUsd,
    observedCostUsd,
    requestCount: transport.sequence,
    synthesisSubmissionCount: transport.streamSubmissions,
  };
}

export async function collectLiveReadCase({ config, caseId, env = process.env, fetchImpl = fetch, onExchange = async () => {} }) {
  const validated = validateCaptureConfig(config, caseId, env);
  const { testCase, origin, actor, tenant, client, sources, bearer } = validated;
  const transport = new CaptureTransport({ origin, bearer, tenantSlug: tenant.slug, deadlineMs: config.limits.deadlineMs, fetchImpl, onExchange });
  const startedAt = new Date().toISOString();
  const gaps = [];
  const setupEffects = [];
  let conversationId = null;
  let stream = null;
  let answer = '';
  let links = null;
  let usage = null;
  let observedCostUsd = null;
  try {
    const health = await transport.json('/health', { auth: false, purpose: 'deployment-health-preflight' });
    requireValue(health.json?.status === 'ok', 'DEPLOYMENT_NOT_READY', 'API health preflight is not ready');
    requireValue(health.headers['x-capiro-release-sha'] === config.deployment.apiSha, 'DEPLOYMENT_AUTHORITY_MISSING', 'API does not expose the exact configured release SHA');

    const me = await transport.json('/api/me', { purpose: 'authenticated-identity-preflight' });
    requireValue(me.json?.tenant?.id === tenant.physicalId && me.json?.tenant?.slug === tenant.slug, 'AUTH_TENANT_MISMATCH', 'authenticated tenant does not match scope config');
    requireValue(me.json?.user?.id === actor.userId && me.json?.user?.clerkUserId === actor.clerkUserId && me.json?.role === actor.role, 'AUTH_ACTOR_MISMATCH', 'authenticated actor does not match scope config');
    requireValue(me.json?.features?.meriv3Chat === true, 'RUNTIME_FLAG_NOT_READY', 'MeriV3 is not enabled for the authenticated synthetic tenant');

    const status = await transport.json('/api/clio/status', { purpose: 'runtime-readiness-preflight' });
    requireValue(status.json?.configured === true && status.json?.healthy === true, 'RUNTIME_NOT_READY', 'Meri runtime/provider readiness preflight failed');
    const clients = await transport.json('/api/clients', { purpose: 'client-scope-preflight' });
    if (client) {
      const rows = array(clients.json?.data ?? clients.json);
      const observed = rows.find((row) => row?.id === client.physicalId);
      requireValue(observed && observed.name === client.name, 'CLIENT_SCOPE_MISMATCH', 'configured physical client was not returned by the authenticated client roster');
    }

    const conversation = await transport.json('/api/clio/conversations', {
      method: 'POST',
      body: { ...(client ? { clientId: client.physicalId } : {}), title: `Live capture ${caseId}` },
      purpose: 'synthetic-conversation-setup',
    });
    requireValue(UUID.test(conversation.json?.id ?? '') && (conversation.json?.clientId ?? null) === (client?.physicalId ?? null), 'CONVERSATION_SETUP_MISMATCH', 'conversation setup did not confirm the configured client scope');
    conversationId = conversation.json.id;
    setupEffects.push({ type: 'synthetic_conversation_create', conversationId, responseSha256: sha256Bytes(conversation.bytes), businessEffect: false });

    try {
      stream = await transport.stream(`/api/clio/conversations/${conversationId}/stream`, { body: testCase.prompt }, 'single-chat-synthesis');
    } catch (error) {
      const code = error instanceof CaptureBlockedError ? error.code : 'POST_SUBMISSION_PROCESSING_ERROR';
      gaps.push(`SYNTHESIS_OUTCOME_UNKNOWN:${code}`, 'POST_SUBMISSION_EFFECTS_UNCERTAIN');
      return uncertainCapture({ config, caseId, client, transport, startedAt, conversationId, setupEffects, gaps, stream, answer, links, usage, observedCostUsd });
    }
    const accepted = stream.events.some((event) => event?.type === 'turn_accepted');
    const doneEvents = stream.events.filter((event) => event?.type === 'done');
    const done = doneEvents.at(-1);
    const errors = stream.events.filter((event) => event?.type === 'error');
    const prohibited = stream.events.filter((event) => ['pending_approval', 'page_write', 'draft_updated', 'workflow_updated'].includes(event?.type));
    const toolCalls = stream.events.filter((event) => event?.type === 'tool_call');
    const citations = stream.events.filter((event) => event?.type === 'citations').flatMap((event) => array(event.citations));
    usage = stream.events.filter((event) => event?.type === 'usage').at(-1)?.usage ?? null;
    observedCostUsd = [usage?.costUsd, done?.costUsd, done?.telemetry?.costUsd].find((value) => Number.isFinite(value)) ?? null;
    const firstTerminal = stream.events.findIndex((event) => event?.type === 'done');
    const answerEvents = firstTerminal >= 0 ? stream.events.slice(0, firstTerminal + 1) : stream.events;
    answer = answerEvents.filter((event) => event?.type === 'text').map((event) => typeof event.text === 'string' ? event.text : '').join('');

    if (!accepted) gaps.push('TURN_ACCEPTANCE_RECEIPT_MISSING');
    if (doneEvents.length !== 1) gaps.push(doneEvents.length === 0 ? 'TERMINAL_DONE_MISSING_CAPTURE_UNCERTAIN' : 'MULTIPLE_TERMINAL_DONE_EVENTS');
    gaps.push(...stream.parseIssues);
    if (errors.length) gaps.push('SERVER_ERROR_EVENT_OBSERVED');
    if (prohibited.length) gaps.push('MUTATING_OR_APPROVAL_EVENT_OBSERVED');
    if (toolCalls.some((event) => READ_ONLY_TOOL_DENY.test(event.tool ?? ''))) gaps.push('MUTATING_TOOL_CALL_OBSERVED');
    if (!done?.model && !stream.events.some((event) => event?.type === 'runtime' && event.model)) gaps.push('EFFECTIVE_MODEL_MISSING');
    if (!usage || !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) gaps.push('TOKEN_USAGE_MISSING');
    if (observedCostUsd === null) gaps.push('SERVER_COST_USD_MISSING');
    else if (observedCostUsd > config.limits.maxSpendUsd) gaps.push('OBSERVED_COST_EXCEEDS_POST_HOC_THRESHOLD');
    if (stream.interrupted) gaps.push('SSE_TRANSPORT_INTERRUPTED');
    if (!done?.retrieval?.trace) gaps.push('SERVER_RETRIEVAL_TRACE_MISSING');
    gaps.push('SERVER_TRACE_ID_MISSING', 'SERVER_TOOL_CALL_IDS_MISSING');
    if (!answer.trim()) gaps.push('ANSWER_BYTES_MISSING');

    if (stream.parseIssues.length > 0 || doneEvents.length !== 1 || stream.interrupted) {
      gaps.push('POST_SUBMISSION_EFFECTS_UNCERTAIN');
      return uncertainCapture({ config, caseId, client, transport, startedAt, conversationId, setupEffects, gaps, stream, answer, links, usage, observedCostUsd });
    }

    const sourceLinks = [];
    for (const source of sources) {
      const matches = citations.filter((citation) => physicalSourceMatch(citation, source));
      if (matches.length !== 1) {
        if (matches.length === 0 && citations.length > 0) {
          throw new CaptureBlockedError('SOURCE_EVIDENCE_MISMATCH', `observed citations do not bind configured source ${source.logicalId}`);
        }
        gaps.push(matches.length === 0 ? `SOURCE_EVIDENCE_MISSING:${source.logicalId}` : `SOURCE_EVIDENCE_AMBIGUOUS:${source.logicalId}`);
        continue;
      }
      const citation = matches[0];
      const link = {
        frozenFixtureId: source.logicalId,
        physicalSourceId: source.physicalId,
        citationSha256: sha256Stable(redactSecrets(citation, [bearer])),
        sourceVersion: citation.source?.version ?? source.version ?? null,
        locator: citation.source?.section ?? source.locator ?? null,
        tool: citation.tool ?? null,
        canonicalReadbackSha256: null,
      };
      if (citation.source && ['email', 'client', 'memory', 'document'].includes(citation.source.kind)) {
        const query = new URLSearchParams(Object.entries(citation.source).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)]));
        const readback = await transport.json(`/api/clio/sources?${query.toString()}`, { purpose: `canonical-source-readback:${source.logicalId}` });
        requireValue(readback.json?.recordId === source.physicalId && readback.json?.status === 'available', 'SOURCE_READBACK_MISMATCH', `canonical source readback mismatch for ${source.logicalId}`);
        link.canonicalReadbackSha256 = sha256Bytes(readback.bytes);
      } else {
        gaps.push(`CANONICAL_SOURCE_READBACK_UNAVAILABLE:${source.logicalId}`);
      }
      sourceLinks.push(link);
    }

    let messageReadback = null;
    if (done?.messageId) {
      const messages = await transport.json(`/api/clio/conversations/${conversationId}/messages`, { purpose: 'canonical-message-readback' });
      const row = array(messages.json?.data ?? messages.json).find((message) => message?.id === done.messageId);
      requireValue(row && row.role === 'assistant' && typeof row.body === 'string', 'MESSAGE_READBACK_MISMATCH', 'canonical assistant message readback is missing');
      requireValue(row.body.trim() === answer.trim(), 'MESSAGE_READBACK_MISMATCH', 'streamed answer differs from canonical assistant message readback');
      messageReadback = { messageId: row.id, sha256: sha256Stable(redactSecrets(row, [bearer])) };
    } else {
      gaps.push('CANONICAL_MESSAGE_ID_MISSING');
    }

    links = {
      schemaVersion: 1,
      ownerRunId: config.captureRunId,
      caseId,
      conversationId,
      clientPhysicalId: client?.physicalId ?? null,
      sourceLinks,
      toolCallEventHashes: toolCalls.map((event, index) => ({ observedIndex: index + 1, sha256: sha256Stable(redactSecrets(event, [bearer])) })),
      retrievalTraceSha256: done?.retrieval?.trace ? sha256Stable(done.retrieval.trace) : null,
      serverTraceId: null,
      scopeMappingSha256: config.fixture.mappingSha256,
      messageReadback,
    };
    return {
      status: gaps.length ? 'CAPTURE_INCOMPLETE' : 'CAPTURE_COMPLETE',
      acceptanceStatus: 'NOT_RUN',
      acceptanceReason: config.provenance === 'UNIT_FIXTURE_NOT_LIVE' ? 'UNIT_FIXTURE_NOT_LIVE' : 'capture authority/telemetry gaps remain; verifier authority gate is unchanged',
      startedAt,
      finishedAt: new Date().toISOString(),
      caseId,
      conversationId,
      setupEffects,
      gaps: [...new Set(gaps)],
      events: redactSecrets(stream.events, [bearer]),
      answer,
      links,
      usage,
      postHocSpendThresholdUsd: config.limits.maxSpendUsd,
      observedCostUsd,
      requestCount: transport.sequence,
      synthesisSubmissionCount: transport.streamSubmissions,
    };
  } catch (error) {
    if (transport.streamSubmissions === 0) throw error;
    const code = error instanceof CaptureBlockedError ? error.code : 'POST_SUBMISSION_PROCESSING_ERROR';
    gaps.push(`SYNTHESIS_OUTCOME_UNKNOWN:${code}`, 'POST_SUBMISSION_EFFECTS_UNCERTAIN');
    return uncertainCapture({ config, caseId, client, transport, startedAt, conversationId, setupEffects, gaps, stream, answer, links, usage, observedCostUsd });
  } finally {
    transport.close();
  }
}

export async function waitForAbort(signal) {
  if (signal.aborted) return;
  await delay(1, undefined, { signal }).catch(() => undefined);
}
