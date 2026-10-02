import https from 'node:https';
import { isDeepStrictEqual } from 'node:util';
import { sha256Bytes, sha256Stable, stableJson } from './artifact-collector.mjs';
import { assertWindowsArtifactStorage } from './windows-artifact-storage.mjs';
import { nativeMeriCaptureHeaders } from './lib/native-http.mjs';
import { parseCaptureSse } from './capture-transport.mjs';
import { readCase01BuildAuthority } from './case01-build-authority.mjs';
import { collectCase46ArtifactUi } from './case46-artifact-ui.mjs';
import { CASE46_SCOPE, inspectCase46Scope, inspectCase46CurrentReadback, assertCase46ReceiptJoins,
  case46Need as need } from './case46-receipt-joins.mjs';
import { claimCaptureSpendReservation, assertCaptureSpendReservation,
  settleCaptureSpendReservation } from './capture-spend-aggregate.mjs';

const ORIGIN = 'https://os.capiro.ai', CLERK = 'https://clerk.app.capiro.ai';
const sessions = new WeakMap(), outcomes = new WeakMap(), claimed = new Set();

/** Pure stream checks only; no caller JSON can mint authenticated capture authority. */
export function inspectCase46Stream(text, scope) {
  const parsed = parseCaptureSse(text), events = parsed.events;
  need(parsed.issues.length === 0 && events.filter(e => e.type === 'turn_accepted').length === 1 &&
    events.filter(e => e.type === 'done').length === 1 && events.filter(e => e.type === 'pending_approval').length === 1 &&
    !events.some(e => ['error', 'page_write', 'draft_updated', 'workflow_updated'].includes(e.type)), 'STREAM_UNCERTAIN');
  const tools = events.filter(e => e.type === 'tool_call');
  need(tools.length === 1 && tools[0].tool === 'create_word', 'STREAM_TOOL_SCOPE');
  const proposal = events.find(e => e.type === 'pending_approval'), done = events.find(e => e.type === 'done');
  need(proposal.tool === 'create_word' && typeof proposal.proposalId === 'string' &&
    typeof done.messageId === 'string' && !done.serverCaptureEvidenceReceipt && !done.serverReadonlyCaptureReceipt,
    'STREAM_SEPARATE_AUTHORITY');
  const answer = events.filter(e => e.type === 'text').map(e => e.text ?? '').join('');
  need(answer.length > 0 && Buffer.byteLength(answer) <= 262144, 'STREAM_ANSWER');
  return { proposalId: proposal.proposalId, assistantMessageId: done.messageId,
    answerSha256: sha256Bytes(answer), streamSha256: sha256Bytes(text), captureRunId: scope.captureRunId };
}

function transport(scope, bearer, deadline) {
  let requests = 0, submissions = 0;
  const conversation = `/api/clio/conversations/${scope.conversationId}`;
  const reads = new Set(['/api/me', '/api/clio/status', conversation, conversation + '/messages',
    `/api/clio/action-proposals?conversationId=${scope.conversationId}`]);
  const request = (path, body) => {
    need(Date.now() < deadline && ++requests <= 28, 'REQUEST_BOUND');
    const url = new URL(path, ORIGIN);
    need(url.origin === ORIGIN && (body === undefined ? reads.has(path) : path === conversation + '/stream'), 'REQUEST_SCOPE');
    if (body !== undefined) {
      need(submissions === 0 && isDeepStrictEqual(body, { body: CASE46_SCOPE.prompt }), 'DUPLICATE_SUBMISSION');
      submissions++;
    }
    return new Promise((resolve, reject) => {
      let timer, finished = false;
      const fail = code => { if (!finished) { finished = true; clearTimeout(timer); reject(new Error(code)); } };
      const req = https.request(url, { method: body === undefined ? 'GET' : 'POST', rejectUnauthorized: true,
        headers: { ...nativeMeriCaptureHeaders(bearer, scope.tenantSlug),
          accept: body === undefined ? 'application/json' : 'text/event-stream',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, res => {
        let size = 0; const chunks = [];
        res.on('data', chunk => { size += chunk.length; if (size > 1_048_576) { req.destroy(); fail('CASE46_RESPONSE_BOUND'); } else chunks.push(chunk); });
        res.on('error', () => fail('CASE46_RESPONSE_INTERRUPTED'));
        res.on('end', () => {
          if (finished) return;
          try {
            need(res.statusCode === 200 && res.headers['x-capiro-release-sha'] === scope.apiSha, 'HTTP_RELEASE');
            const text = new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks));
            finished = true; clearTimeout(timer);
            resolve({ text, bytes: size, status: res.statusCode, releaseSha: res.headers['x-capiro-release-sha'] });
          } catch { fail('CASE46_HTTP_REJECTED'); }
        });
      });
      timer = setTimeout(() => { req.destroy(); fail('CASE46_HTTP_DEADLINE'); }, Math.max(1, deadline - Date.now()));
      req.on('error', () => fail('CASE46_NETWORK_FAILED'));
      req.setTimeout(Math.max(1, Math.min(60_000, deadline - Date.now())), () => { req.destroy(); fail('CASE46_HTTP_IDLE'); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  };
  return { request, json: async path => { const r = await request(path); return { ...r, value: JSON.parse(r.text) }; },
    counts: () => ({ requestCount: requests, synthesisSubmissionCount: submissions }) };
}

async function pageIdentity(page, scope) {
  need(page.url() === `${ORIGIN}/meri/t/${scope.conversationId}`, 'PAGE_ROUTE');
  const actual = await page.evaluate(() => ({ sha: window.__CAPIRO_CONFIG__?.releaseSha,
    surface: window.__CAPIRO_CONFIG__?.webSurface, user: window.Clerk?.user?.id }));
  need(actual.sha === scope.webSha && actual.surface === 'vnext' && actual.user === scope.clerkUserId, 'PAGE_IDENTITY');
}

async function admission(scope, http, phase) {
  const me = (await http.json('/api/me')).value;
  need(me?.user?.id === scope.userId && me.user.clerkUserId === scope.clerkUserId && me.tenant?.id === scope.tenantId &&
    me.tenant.slug === scope.tenantSlug && me.role === scope.role, 'CURRENT_ACTOR');
  const conversation = (await http.json(`/api/clio/conversations/${scope.conversationId}`)).value;
  need(conversation?.id === scope.conversationId && conversation.clientId === scope.clientId &&
    conversation.metadata?.governedArtifactCapture?.bindingSha256 === scope.bindingSha256, 'CURRENT_CONVERSATION');
  return inspectCase46CurrentReadback({ scope, current: conversation.captureAdmission, phase });
}

function safeBytes(value, bearer) {
  const text = stableJson(value);
  need(!text.includes(bearer) && !/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(text) &&
    !/(?:Bearer\s+)[A-Za-z0-9._~+/-]{12,}|(?:sk_live_|sk-proj-|sk-or-v1-)[A-Za-z0-9_-]{12,}/u.test(text), 'PRIVATE_OUTPUT');
  return Buffer.from(text);
}

/** Binds real native HTTPS/build reads and native storage to a one-shot in-process capability.
 * The root-owned authenticated operator supplies its page; no injected network results are accepted.
 */
export async function prepareCase46LiveCapture({ config, page, runRoot, artifactStorage, spendReservation, env = process.env }) {
  need(config?.schemaVersion === 1 && config.provenance === 'LIVE_CAPTURE' &&
    config.target?.apiOrigin === ORIGIN && config.target.environment === 'capiro-dev', 'CONFIG');
  const scope = inspectCase46Scope(config.scope), bearer = env.MERI_LIVE_BEARER_TOKEN?.trim();
  need(typeof bearer === 'string' && bearer.length > 0 && !/[\r\n]/u.test(bearer), 'AUTH_MISSING');
  need(Number.isSafeInteger(config.deadlineMs) && config.deadlineMs >= 1000 && config.deadlineMs <= 900000, 'DEADLINE');
  need(config.deployment?.apiSha === scope.apiSha && config.deployment.orchestratorSha === scope.orchestratorSha, 'DEPLOYMENT_SCOPE');
  assertWindowsArtifactStorage(artifactStorage, runRoot);
  const key = `${scope.captureRunId}:${scope.conversationId}`;
  need(!claimed.has(key), 'RUN_ALREADY_CLAIMED'); claimed.add(key);
  const expected = { caseId: '46', captureRunId: scope.captureRunId, conversationId: scope.conversationId,
    tenantId: scope.tenantId, actorUserId: scope.userId, clientId: scope.clientId,
    currentVerifySha256: scope.currentVerifySha256, qualificationSha256: scope.qualificationSha256,
    maxSpendMicros: scope.qualification.maxCostMicros };
  claimCaptureSpendReservation(spendReservation, expected);
  artifactStorage.init(safeBytes({ version: 1, kind: 'meri-case46-authenticated-capture', expected }, bearer),
    Buffer.from('MERI_CASE46_NATIVE_CAPTURE'));
  const owner = artifactStorage.writeBytes('case46-capture-owner.json', safeBytes({ version: 1,
    kind: 'meri-case46-authenticated-capture', provenance: 'LIVE_CAPTURE', expected }, bearer));
  const deadline = Math.min(Date.now() + config.deadlineMs, Date.parse(scope.qualification.rateEvidenceExpiresAt));
  const http = transport(scope, bearer, deadline);
  await pageIdentity(page, scope);
  const builds = await readCase01BuildAuthority(config.deployment);
  const before = await admission(scope, http, 'READY');
  const initialMessages = (await http.json(`/api/clio/conversations/${scope.conversationId}/messages`)).value;
  need(Array.isArray(initialMessages) && initialMessages.length === 0, 'PREEXISTING_MESSAGES');
  const capability = Object.freeze({ kind: 'meri-case46-native-session' });
  sessions.set(capability, { scope, page, bearer, storage: artifactStorage, owner, expected, spendReservation,
    http, before, builds, deadline, consumed: false, approvalRequests: 0, blockedWrites: 0 });
  return capability;
}

export async function executeCase46LiveCapture(capability) {
  const state = sessions.get(capability);
  need(state && !state.consumed, 'AUTHENTICATED_CAPABILITY_REQUIRED'); state.consumed = true;
  const { scope, page, bearer, storage, http, before, builds, expected, spendReservation } = state;
  let proposalId, outcome;
  const guard = async route => {
    const req = route.request(), url = new URL(req.url());
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() &&
      (url.origin !== ORIGIN || url.pathname !== `/meri/t/${scope.conversationId}`)) return route.abort();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && url.origin !== CLERK) {
      let body; try { body = JSON.parse(req.postData() || '{}'); } catch { body = null; }
      if (Date.now() >= state.deadline || !proposalId || url.origin !== ORIGIN || url.search ||
        url.pathname !== `/api/clio/action-proposals/${proposalId}/approve` || req.method() !== 'POST' ||
        !body || Object.keys(body).length || state.approvalRequests !== 0) {
        state.blockedWrites++; return route.abort();
      }
      state.approvalRequests++;
    }
    return route.continue();
  };
  await page.route('**/*', guard);
  try {
    await pageIdentity(page, scope);
    need(Date.now() < state.deadline && Date.now() - builds.observedAt <= 60000, 'PRESUBMIT_BUILD_STALE');
    const current = await admission(scope, http, 'READY');
    need(isDeepStrictEqual(current, before), 'PRESUBMIT_OWNER_DRIFT');
    assertCaptureSpendReservation(spendReservation, expected);
    storage.writeBytes('case46-submission-intent.json', safeBytes({ expected, originalPromptSha256: before.originalPromptSha256 }, bearer));
    const streamed = await http.request(`/api/clio/conversations/${scope.conversationId}/stream`, { body: CASE46_SCOPE.prompt });
    const stream = inspectCase46Stream(streamed.text, scope);
    const proposed = await admission(scope, http, 'AWAITING_APPROVAL');
    need(proposed.proposalId === stream.proposalId && proposed.assistant.id === stream.assistantMessageId &&
      proposed.assistant.bodySha256 === stream.answerSha256, 'STREAM_SAVED_JOIN');
    proposalId = proposed.proposalId;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await pageIdentity(page, scope);
    const ui = await collectCase46ArtifactUi({ page, scope: { ...scope, proposalId }, readApi: http.json, artifactStorage: storage });
    const proposedScreenshot = storage.readBytes('case46-proposed.png');
    const after = await admission(scope, http, 'ARTIFACT_CREATED');
    const messages = (await http.json(`/api/clio/conversations/${scope.conversationId}/messages`)).value;
    need(Array.isArray(messages) && messages.length === 2 && messages.filter(m => m.role === 'user').length === 1 &&
      messages.find(m => m.role === 'user').body === CASE46_SCOPE.prompt, 'SAVED_MESSAGE_COUNT');
    const assistant = messages.find(m => m.role === 'assistant');
    const inputs = { scope, before, proposed, after, assistant, ui: ui.evidence, now: Date.now() };
    const joins = assertCase46ReceiptJoins(inputs);
    need(state.approvalRequests === 1 && state.blockedWrites === 0, 'BROWSER_WRITE_BOUND');
    const evidence = { version: 1, kind: 'meri-case46-authenticated-evidence', provenance: 'LIVE_CAPTURE',
      inputs, expected, builds, stream, uiDescriptor: ui.descriptor,
      approvalScreenshot: { ref: 'case46-proposed.png', bytes: proposedScreenshot.length, sha256: sha256Bytes(proposedScreenshot) },
      completedAt: Date.now(), ...http.counts() };
    const descriptor = storage.writeBytes('case46-evidence.json', safeBytes(evidence, bearer));
    outcome = Object.freeze({ status: 'CAPTURE_COMPLETE', caseId: '46', captureRunId: scope.captureRunId,
      evidence: descriptor, ...http.counts(), approvalRequests: state.approvalRequests, liveAcceptance: 'NOT_RUN', fullFile01Acceptance: false });
    outcomes.set(outcome, { state, evidence, joins, descriptor });
    settleCaptureSpendReservation(spendReservation, outcome);
  } catch (error) {
    outcome = Object.freeze({ status: http.counts().synthesisSubmissionCount ? 'CAPTURE_UNCERTAIN' : 'BLOCKED',
      caseId: '46', captureRunId: scope.captureRunId, reason: /^CASE46_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'CASE46_CAPTURE_REJECTED',
      ...http.counts(), approvalRequests: state.approvalRequests, blockedWrites: state.blockedWrites,
      liveAcceptance: 'NOT_RUN', fullFile01Acceptance: false });
    storage.writeBytes('case46-stopped.json', safeBytes(outcome, bearer));
  } finally { await page.unroute('**/*', guard); }
  return outcome;
}

/** Opaque authority requires this process's completed native capture and unchanged saved files. */
export function currentCase46CaptureAuthority(outcome) {
  const found = outcomes.get(outcome);
  need(found && outcome.status === 'CAPTURE_COMPLETE', 'AUTHENTICATED_OUTCOME_REQUIRED');
  const { state, evidence, joins, descriptor } = found;
  need(sha256Bytes(state.storage.readBytes(state.owner.ref)) === state.owner.sha256 &&
    sha256Bytes(state.storage.readBytes(descriptor.ref)) === descriptor.sha256, 'SAVED_AUTHORITY_CHANGED');
  for (const artifact of [evidence.uiDescriptor, evidence.approvalScreenshot])
    need(sha256Bytes(state.storage.readBytes(artifact.ref)) === artifact.sha256, 'SAVED_UI_CHANGED');
  for (const round of evidence.inputs.ui.rounds) for (const artifact of [round.bytes, round.screenshot])
    need(sha256Bytes(state.storage.readBytes(artifact.ref)) === artifact.sha256, 'SAVED_UI_CHANGED');
  return structuredClone({ evidence, joins });
}
