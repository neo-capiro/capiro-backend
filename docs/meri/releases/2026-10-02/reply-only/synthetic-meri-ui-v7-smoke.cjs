'use strict';
// Preparation only until root supplies fresh deployed-digest + canary readiness.
// Never persist credentials, browser/session state, raw responses, or page text.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const BASE = __dirname;
const NS = 'meri-foundation-20260928';
const ORIGIN = 'https://os.capiro.ai';
const EXPECTED_WEB_SOURCE = '940fe9354f95630c6acb0f20f75ced26ea9e75f4';
const CLERK_ORIGIN = 'https://clerk.app.capiro.ai';
const EXPECTED_REPLY = 'Meri smoke check complete.';
const PROMPT = 'This is a synthetic interface smoke check. Reply only: Meri smoke check complete. Do not call tools, retrieve records, remember anything, create tasks, modify business records, or send messages.';
const ACTORS = [['t1', 'pat'], ['t2', 't2Actor']];
const fail = code => { const error = new Error(code); error.safeCode = code; throw error; };
const need = (ok, code) => { if (!ok) fail(code); };
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function secret() {
  const lines = fs.readFileSync('C:/ProgramData/Hermes/.env', 'utf8').split(/\r?\n/);
  const values = lines.filter(line => /^CLERK_SECRET_KEY\s*=/.test(line)).map(line => line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, ''));
  need(values.length === 1 && values[0], 'CLERK_SECRET_UNAVAILABLE');
  return values[0];
}
function loadGate(file) {
  const gate = read(file);
  need(gate.schemaVersion === 'meri.synthetic-ui-readiness.v2' && gate.ready === true && gate.attemptId === 'v7-reply-only-repair' && gate.authorizedNewTurns === 2, 'V7_ROOT_READINESS_REQUIRED');
  const now = Date.now() / 1000;
  need(Number.isFinite(gate.expiresAtEpoch) && now < gate.expiresAtEpoch && gate.expiresAtEpoch - now <= 900, 'READINESS_EXPIRED');
  need(gate.environment === 'capiro-dev' && gate.origin === ORIGIN, 'EXACT_RELEASE_TARGET_REQUIRED');
  need(/^[a-f0-9]{40}$/.test(gate.mergedSourceSha) && /^[a-f0-9]{40}$/.test(gate.repairedRuntimeSourceSha), 'MERGED_REPAIRED_SOURCE_REQUIRED');
  need(gate.expectedScriptSha256 === sha(fs.readFileSync(__filename)), 'REVIEWED_SCRIPT_BINDING_REQUIRED');
  const tenants = ACTORS.map(([tenant]) => `${NS}-${tenant}`);
  need(JSON.stringify(gate.approvedTenantSlugs) === JSON.stringify(tenants), 'EXACT_SYNTHETIC_SCOPE_REQUIRED');
  need(typeof gate.independentVerificationPath === 'string' && path.isAbsolute(gate.independentVerificationPath) && /^[a-f0-9]{64}$/.test(gate.independentVerificationSha256), 'INDEPENDENT_RELEASE_READBACK_REQUIRED');
  const proofBytes = fs.readFileSync(gate.independentVerificationPath);
  need(sha(proofBytes) === gate.independentVerificationSha256, 'RELEASE_READBACK_HASH_MISMATCH');
  const proof = JSON.parse(proofBytes.toString('utf8').replace(/^\uFEFF/, ''));
  need(proof.verdict === 'PASS' && proof.environment === 'capiro-dev' && proof.origin === ORIGIN && proof.mergedSourceSha === gate.mergedSourceSha && proof.attemptId === gate.attemptId, 'RELEASE_READBACK_IDENTITY_MISMATCH');
  need(Number.isFinite(proof.observedAtEpoch) && proof.observedAtEpoch <= now && now - proof.observedAtEpoch <= 900, 'RELEASE_READBACK_STALE');
  need(JSON.stringify(proof.approvedTenantSlugs) === JSON.stringify(tenants) && proof.syntheticCohortsVerified === true, 'CURRENT_SYNTHETIC_COHORT_PROOF_REQUIRED');
  need(proof.syntheticFlagEvidence?.status === 'LAST_AUTHORITATIVE_APPLY' && /^[a-f0-9]{64}$/.test(proof.syntheticFlagEvidence?.receiptSha256) && proof.syntheticFlagEvidence?.freshDbQuery === false, 'HISTORICAL_SYNTHETIC_FLAG_EVIDENCE_REQUIRED');
  for (const name of ['api', 'meriv2-orchestrator', 'web-vnext']) {
    const service = gate.services?.[name], observed = proof.services?.[name];
    need(service && observed && /^[a-f0-9]{40}$/.test(service.sourceSha) && /^sha256:[a-f0-9]{64}$/.test(service.imageDigest) && /^arn:aws:ecs:us-east-1:\d{12}:task-definition\/[A-Za-z0-9_-]+:\d+$/.test(service.taskDefinitionArn) && /^ecs-svc\/[0-9]+$/.test(service.primaryDeploymentId) && service.healthy === true, 'RELEASE_SERVICE_BINDING_REQUIRED');
    for (const key of ['sourceSha', 'imageDigest', 'taskDefinitionArn', 'primaryDeploymentId', 'healthy']) need(service[key] === observed[key], 'RELEASE_SERVICE_READBACK_MISMATCH');
  }
  need(gate.services['web-vnext'].sourceSha === EXPECTED_WEB_SOURCE && gate.services['meriv2-orchestrator'].sourceSha === gate.repairedRuntimeSourceSha, 'EXPECTED_REPAIRED_SOURCE_REQUIRED');
  return { ...gate, syntheticFlagEvidence: proof.syntheticFlagEvidence };
}
async function verifyLoadedWeb(page) {
  const observed = await page.evaluate(() => {
    const config = window.__CAPIRO_CONFIG__;
    let clerkHostname = 'invalid';
    const match = /^pk_(?:live|test)_([A-Za-z0-9_-]+)$/.exec(config?.clerkPublishableKey || '');
    if (match) { try { clerkHostname = atob(match[1].replace(/-/g, '+').replace(/_/g, '/')).replace(/\$$/, ''); } catch {} }
    return { releaseSha: config?.releaseSha, webSurface: config?.webSurface, clerkHostname };
  });
  need(observed.releaseSha === EXPECTED_WEB_SOURCE && observed.webSurface === 'vnext', 'LOADED_WEB_RELEASE_MISMATCH');
  need(observed.clerkHostname === 'clerk.app.capiro.ai', 'LOADED_CLERK_HOST_MISMATCH');
  return observed;
}
function blockedEndpoint(request, url) {
  const knownHosts = new Set(['os.capiro.ai', 'api.capiro.ai', 'clerk.app.capiro.ai', 'clerk.capiro.ai']);
  const literals = new Set(['api', 'clio', 'conversations', 'stream', 'v1', 'client', 'sign_ins', 'sessions', 'tokens', 'touch', 'activate', 'sign_out', 'environment', 'telemetry', 'events', 'attempt_first_factor', 'prepare_first_factor']);
  return { method: request.method(), hostname: knownHosts.has(url.hostname) ? url.hostname : 'unapproved-host', hostnameSha256: sha(url.hostname), pathnameShape: '/' + url.pathname.split('/').filter(Boolean).map(x => literals.has(x) ? x : ':segment').join('/') };
}
async function getOwnedJson(page, pathname) {
  return page.evaluate(async pathname => {
    const token = await window.Clerk.session.getToken({ template: 'capiro' });
    if (!token) return { ok: false, code: 'READBACK_AUTH_TOKEN_UNAVAILABLE' };
    const response = await fetch(pathname, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { ok: false, code: 'READBACK_HTTP_FAILURE', status: response.status };
    const text = await response.text();
    if (text.length > 262144) return { ok: false, code: 'READBACK_BOUND_EXCEEDED' };
    return { ok: true, value: JSON.parse(text) };
  }, pathname);
}
async function savedMetrics(page, conversationId) {
  need(/^[A-Za-z0-9_-]+$/.test(conversationId), 'INVALID_OWNED_CONVERSATION_ID');
  const response = await getOwnedJson(page, `/api/clio/conversations/${conversationId}/messages`);
  need(response.ok, response.code || 'MESSAGES_READBACK_FAILED');
  const messages = response.value;
  need(Array.isArray(messages) && messages.length === 2, 'EXPECTED_ONE_SAVED_TURN');
  const users = messages.filter(x => x.role === 'user'), assistants = messages.filter(x => x.role === 'assistant');
  need(users.length === 1 && assistants.length === 1 && users[0].body === PROMPT && typeof assistants[0].body === 'string', 'SAVED_SYNTHETIC_TURN_MISMATCH');
  const body = assistants[0].body;
  return { userPromptMatches: true, assistantTextLength: body.length, assistantTextSha256: sha(body), assistantExpectedEqual: body.trim() === EXPECTED_REPLY, assistantExpectedSubstring: body.includes(EXPECTED_REPLY) };
}
async function awaitExpectedVisible(page) {
  try { await page.getByText(EXPECTED_REPLY, { exact: true }).waitFor({ state: 'visible', timeout: 15000 }); return true; }
  catch { return false; }
}
async function main() {
  need(process.argv.length === 5 && process.argv[2] === '--readiness' && ['--execute-two-synthetic-turns', '--check-readiness'].includes(process.argv[4]), 'EXPLICIT_EXECUTION_GATE_REQUIRED');
  const gate = loadGate(process.argv[3]);
  if (process.argv[4] === '--check-readiness') { console.log(JSON.stringify({ readiness: 'PASS', attemptId: gate.attemptId, authenticated: false, turnsSent: 0 })); return; }
  const manifest = read('C:/dev/cap-meri-foundation-evidence/private/meri-foundation-20260928.manifest.json');
  need(manifest.namespace === NS && manifest.target === 'capiro-dev' && manifest.status === 'ready', 'FIXTURE_BINDING_INVALID');
  const req = createRequire('C:/dev/cap-meri-migration-history-guard/apps/api/package.json');
  const { createClerkClient } = req('@clerk/backend');
  const { chromium } = require('C:/dev/node_modules/playwright');
  const clerk = createClerkClient({ secretKey: secret() });
  need((await clerk.instance.get()).id === manifest.targetBinding.clerkInstanceId, 'CLERK_INSTANCE_MISMATCH');
  const summary = { schemaVersion: 1, sourceSha: gate.mergedSourceSha, scriptSha256: sha(fs.readFileSync(__filename)), startedAt: new Date().toISOString(), verdict: 'NOT RUN', tenants: [], attemptId: gate.attemptId, maximumNewTurns: 2, syntheticFlagEvidence: gate.syntheticFlagEvidence, readinessProofSha256: gate.independentVerificationSha256, repairedRuntimeSourceSha: gate.repairedRuntimeSourceSha, deployedServices: Object.fromEntries(Object.entries(gate.services).filter(([name]) => ['api', 'meriv2-orchestrator', 'web-vnext'].includes(name)).map(([name, service]) => [name, Object.fromEntries(['sourceSha', 'imageDigest', 'taskDefinitionArn', 'primaryDeploymentId', 'healthy'].map(key => [key, service[key]]))])), fullFile01Acceptance: false };
  const output = path.join(BASE, 'synthetic-meri-ui-v7-smoke-result.json');
  // Permanent task-local claim prevents accidental retries after an uncertain send.
  fs.writeFileSync(path.join(BASE, 'synthetic-meri-ui-v7-smoke-execution.lock'), JSON.stringify({ sourceSha: gate.mergedSourceSha, startedAt: summary.startedAt }), { flag: 'wx' });
  const persist = () => fs.writeFileSync(output, JSON.stringify(summary, null, 2));
  persist();
  try {
    for (const [tenantKey, actorKey] of ACTORS) {
      loadGate(process.argv[3]);
      const actor = manifest.ids.users[actorKey], tenant = manifest.ids.tenants[tenantKey];
      const row = { tenant: `${NS}-${tenantKey}`, identityVerified: false, loadedWebReleaseSha: null, webSurface: null, composerVisible: false, conversationCreateRequests: 0, conversationsCreated: 0, turnsSent: 0, blockedMutationCount: 0, blockedEndpoints: [], authAttempt: null, streamStatus: null, doneReceived: false, toolCalls: 0, streamErrors: 0, expectedReplyVisible: false, sessionRevoked: null, verdict: 'NOT RUN' };
      summary.tenants.push(row); persist();
      const user = await clerk.users.getUser(actor.clerkUserId);
      const org = await clerk.organizations.getOrganization({ organizationId: tenant.clerkOrgId });
      const memberships = await clerk.users.getOrganizationMembershipList({ userId: actor.clerkUserId, limit: 100 });
      const email = manifest.handles.users[actorKey];
      need(user.publicMetadata?.fixtureNamespace === NS && /synthetic/i.test([user.firstName, user.lastName].join(' ')) && typeof email === 'string' && email.includes(NS) && email.endsWith('@example.com') && user.emailAddresses.some(x => x.emailAddress === email), 'SYNTHETIC_USER_MISMATCH');
      need(org.id === tenant.clerkOrgId && org.slug === row.tenant && org.publicMetadata?.fixtureNamespace === NS, 'SYNTHETIC_ORG_MISMATCH');
      need(memberships.totalCount === 1 && memberships.data.length === 1 && memberships.data[0].organization?.id === tenant.clerkOrgId && memberships.data[0].role === 'org:member', 'ORDINARY_SINGLE_ORG_MEMBERSHIP_REQUIRED');
      const browser = await chromium.launch({ headless: true });
      let timedOut = false, createdSessionId = null;
      const timer = setTimeout(() => { timedOut = true; void browser.close().catch(() => {}); }, 180000);
      try {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const page = await context.newPage(); page.setDefaultTimeout(30000);
        let armed = false, conversationId = null, routeFailure = null, streamResponse = null;
        const isApp = url => url.origin === ORIGIN;
        const isClerk = url => url.origin === CLERK_ORIGIN;
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          try {
            if (request.isNavigationRequest() && request.frame() === page.mainFrame() && url.origin !== ORIGIN) fail('UNEXPECTED_TOP_LEVEL_NAVIGATION');
            if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || isClerk(url)) return await route.continue();
            if (isApp(url) && armed && request.method() === 'POST' && url.pathname === '/api/clio/conversations' && row.conversationCreateRequests === 0) {
              const body = request.postDataJSON();
              need(body && Object.keys(body).every(x => x === 'title') && body.title === 'Chat session', 'UNEXPECTED_CONVERSATION_SCOPE');
              row.conversationCreateRequests++; persist();
              const response = await route.fetch({ maxRedirects: 0 }); need(response.ok(), 'CONVERSATION_CREATION_FAILED');
              const data = await response.json(); need(typeof data.id === 'string' && /^[A-Za-z0-9_-]+$/.test(data.id) && !data.clientId, 'CONVERSATION_IDENTITY_INVALID');
              conversationId = data.id; row.conversationsCreated++; persist();
              return await route.fulfill({ response });
            }
            if (isApp(url) && armed && request.method() === 'POST' && conversationId && url.pathname === `/api/clio/conversations/${conversationId}/stream` && row.turnsSent === 0) {
              const body = request.postDataJSON(); need(body?.body === PROMPT && Object.keys(body).length === 1, 'UNEXPECTED_CHAT_PAYLOAD');
              row.turnsSent++; persist(); return await route.continue();
            }
            row.blockedMutationCount++; if (row.blockedEndpoints.length < 8) row.blockedEndpoints.push(blockedEndpoint(request, url)); persist(); fail('UNAPPROVED_BROWSER_MUTATION');
          } catch (error) {
            routeFailure ||= error.safeCode || 'ROUTE_FAILURE';
            await route.abort('blockedbyclient').catch(() => {});
          }
        });
        page.on('response', response => { const url = new URL(response.url()); if (isApp(url) && /\/api\/clio\/conversations\/[^/]+\/stream$/.test(url.pathname)) streamResponse = response; });
        await page.goto(`${ORIGIN}/meri`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 45000 });
        await verifyLoadedWeb(page);
        need(!routeFailure, routeFailure || 'AUTH_PREFLIGHT_BLOCKED');
        const ticket = await clerk.signInTokens.createSignInToken({ userId: actor.clerkUserId, expiresInSeconds: 120 });
        const signedIn = await page.evaluate(async token => {
          const attempt = await window.Clerk.client.signIn.create({ strategy: 'ticket', ticket: token });
          const statuses = new Set(['complete', 'needs_identifier', 'needs_first_factor', 'needs_second_factor', 'needs_new_password', 'needs_client_trust']);
          const fields = new Set(['email_address', 'phone_number', 'password', 'username', 'first_name', 'last_name', 'legal_accepted']);
          return { status: statuses.has(attempt.status) ? attempt.status : 'unrecognized', hasSession: typeof attempt.createdSessionId === 'string' && !!attempt.createdSessionId, sessionId: typeof attempt.createdSessionId === 'string' ? attempt.createdSessionId : null, missingFields: Array.isArray(attempt.missingFields) ? attempt.missingFields.slice(0, 8).map(x => fields.has(x) ? x : 'unrecognized') : [] };
        }, ticket.token);
        createdSessionId = signedIn.sessionId;
        row.authAttempt = { status: signedIn.status, hasSession: signedIn.hasSession, missingFields: signedIn.missingFields }; persist();
        need(!routeFailure, routeFailure || 'AUTH_REQUEST_BLOCKED');
        need(signedIn.status === 'complete' && signedIn.hasSession, 'SYNTHETIC_AUTHENTICATION_FAILED');
        await page.evaluate(async ({ session, organization }) => { await window.Clerk.setActive({ session, organization }); }, { session: createdSessionId, organization: tenant.clerkOrgId });
        await page.goto(`${ORIGIN}/meri/new`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(({ userId, orgId }) => window.Clerk?.loaded && window.Clerk.user?.id === userId && window.Clerk.organization?.id === orgId, { userId: actor.clerkUserId, orgId: tenant.clerkOrgId });
        const loadedWeb = await verifyLoadedWeb(page);
        row.loadedWebReleaseSha = loadedWeb.releaseSha; row.webSurface = loadedWeb.webSurface;
        row.identityVerified = true;
        const composer = page.getByRole('textbox', { name: 'Message Meri', exact: true });
        await composer.waitFor({ state: 'visible' }); row.composerVisible = true;
        need(!routeFailure && row.turnsSent === 0 && row.conversationsCreated === 0, routeFailure || 'UNEXPECTED_AUTOSEND');
        need(['t1', 't2'].includes(tenantKey), 'ONLY_APPROVED_REPAIR_TENANTS_MAY_SEND');
        need(row.identityVerified && row.composerVisible, 'CURRENT_AUTHENTICATED_COMPOSER_REQUIRED');
        await composer.fill(PROMPT);
        const identity = await page.evaluate(() => ({ userId: window.Clerk?.user?.id, orgId: window.Clerk?.organization?.id }));
        need(identity.userId === actor.clerkUserId && identity.orgId === tenant.clerkOrgId, 'IDENTITY_CHANGED_BEFORE_SEND');
        await verifyLoadedWeb(page);
        armed = true; await page.getByRole('button', { name: 'Send', exact: true }).click();
        const deadline = Date.now() + 105000;
        while (!streamResponse && !routeFailure && Date.now() < deadline) await page.waitForTimeout(200);
        need(!routeFailure && streamResponse, routeFailure || 'STREAM_NOT_STARTED');
        row.streamStatus = streamResponse.status(); need(streamResponse.ok(), 'STREAM_HTTP_FAILURE');
        const raw = await streamResponse.text(); need(raw.length < 262144, 'STREAM_BOUND_EXCEEDED');
        let streamedText = '';
        for (const line of raw.split(/\r?\n/)) {
          if (!line.startsWith('data: ')) continue;
          let event; try { event = JSON.parse(line.slice(6)); } catch { continue; }
          if (event.type === 'done') row.doneReceived = true;
          if (event.type === 'error') row.streamErrors++;
          if (event.type === 'tool_call') row.toolCalls++;
          if (event.type === 'text' && typeof event.text === 'string') streamedText += event.text;
        }
        row.streamExpectedSubstring = streamedText.includes(EXPECTED_REPLY);
        row.expectedReplyVisible = await awaitExpectedVisible(page);
        row.savedAssistant = await savedMetrics(page, conversationId); persist();
        need(!routeFailure && row.turnsSent === 1 && row.conversationsCreated === 1 && row.doneReceived && row.streamErrors === 0 && row.toolCalls === 0 && row.expectedReplyVisible && row.streamExpectedSubstring && row.savedAssistant.assistantExpectedEqual, routeFailure || 'SMOKE_ASSERTION_FAILED');
        row.verdict = 'PASS'; persist();
      } finally {
        clearTimeout(timer); await browser.close().catch(() => {});
        if (createdSessionId) {
          try { await clerk.sessions.revokeSession(createdSessionId); row.sessionRevoked = true; }
          catch { row.sessionRevoked = false; persist(); fail('SYNTHETIC_SESSION_CLEANUP_FAILED'); }
        }
        persist(); if (timedOut) fail('BROWSER_TIME_BOUND_EXCEEDED');
      }
    }
    need(summary.tenants.length === 2 && summary.tenants.every(x => x.verdict === 'PASS' && x.turnsSent === 1), 'REPAIR_TWO_TENANT_ASSERTION_FAILED');
    summary.verdict = 'PASS'; summary.completedAt = new Date().toISOString(); persist();
  } catch (error) {
    summary.verdict = 'BLOCKED'; summary.failureCode = error.safeCode || error.name; summary.completedAt = new Date().toISOString(); persist(); throw error;
  }
  console.log(JSON.stringify({ verdict: summary.verdict, tenants: summary.tenants.length, turnsSent: summary.tenants.reduce((n, x) => n + x.turnsSent, 0), fullFile01Acceptance: false }));
}
main().catch(error => { console.error(JSON.stringify({ verdict: 'BLOCKED', code: error.safeCode || error.name })); process.exitCode = 1; });
