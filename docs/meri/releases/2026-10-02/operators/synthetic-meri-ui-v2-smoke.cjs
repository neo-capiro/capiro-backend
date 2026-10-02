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
const PRIOR_RESULT_SHA = '40a3b0be56d4b6e473cbfd119269886d98ea7f1e52f44b10343044412873c87f';
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
  need(gate.attemptId === 'v2-auth-domain-binding', 'V2_ROOT_READINESS_REQUIRED');
  const priorBytes = fs.readFileSync(path.join(BASE, 'synthetic-meri-ui-smoke-result.json'));
  need(sha(priorBytes) === PRIOR_RESULT_SHA, 'PRIOR_ATTEMPT_CHANGED');
  const prior = JSON.parse(priorBytes.toString('utf8'));
  need(prior.verdict === 'BLOCKED' && prior.tenants.every(x => x.conversationCreateRequests === 0 && x.conversationsCreated === 0 && x.turnsSent === 0), 'PRIOR_ATTEMPT_MAY_HAVE_SENT');
  need(gate.schemaVersion === 'meri.synthetic-ui-readiness.v1' && gate.ready === true, 'ROOT_READINESS_REQUIRED');
  need(Number.isFinite(gate.expiresAtEpoch) && Date.now() / 1000 < gate.expiresAtEpoch && gate.expiresAtEpoch - Date.now() / 1000 <= 900, 'READINESS_EXPIRED');
  need(/^[a-f0-9]{40}$/.test(gate.mergedSourceSha), 'MERGED_SOURCE_REQUIRED');
  const plan = read(gate.canaryPlanPath), applied = read(gate.canaryApplyReceiptPath);
  need(applied.status === 'VERIFIED' && applied.mode === 'apply' && applied.planHash === plan.planHash, 'VERIFIED_CANARY_REQUIRED');
  for (const name of ['api', 'meriv2-orchestrator', 'web-vnext']) {
    need(/^sha256:[a-f0-9]{64}$/.test(gate.images?.[name]) && gate.images[name] === plan.proofs?.[name]?.imageDigest, 'RELEASE_DIGEST_BINDING_REQUIRED');
  }
  need(plan.proofs['web-vnext'].sourceSha === EXPECTED_WEB_SOURCE, 'EXPECTED_WEB_SOURCE_REQUIRED');
  need(JSON.stringify(plan.tenants?.map(x => x[1])) === JSON.stringify(ACTORS.map(([tenant]) => `${NS}-${tenant}`)), 'EXACT_SYNTHETIC_SCOPE_REQUIRED');
  return gate;
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
async function main() {
  need(process.argv.length === 5 && process.argv[2] === '--readiness' && process.argv[4] === '--execute-two-synthetic-turns', 'EXPLICIT_EXECUTION_GATE_REQUIRED');
  const gate = loadGate(process.argv[3]);
  const manifest = read('C:/dev/cap-meri-foundation-evidence/private/meri-foundation-20260928.manifest.json');
  need(manifest.namespace === NS && manifest.target === 'capiro-dev' && manifest.status === 'ready', 'FIXTURE_BINDING_INVALID');
  const req = createRequire('C:/dev/cap-meri-migration-history-guard/apps/api/package.json');
  const { createClerkClient } = req('@clerk/backend');
  const { chromium } = require('C:/dev/node_modules/playwright');
  const clerk = createClerkClient({ secretKey: secret() });
  need((await clerk.instance.get()).id === manifest.targetBinding.clerkInstanceId, 'CLERK_INSTANCE_MISMATCH');
  const summary = { schemaVersion: 1, sourceSha: gate.mergedSourceSha, scriptSha256: sha(fs.readFileSync(__filename)), startedAt: new Date().toISOString(), verdict: 'NOT RUN', tenants: [], fullFile01Acceptance: false };
  const output = path.join(BASE, 'synthetic-meri-ui-v2-smoke-result.json');
  // Permanent task-local claim prevents accidental retries after an uncertain send.
  fs.writeFileSync(path.join(BASE, 'synthetic-meri-ui-v2-smoke-execution.lock'), JSON.stringify({ sourceSha: gate.mergedSourceSha, startedAt: summary.startedAt }), { flag: 'wx' });
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
        const isApp = url => ['os.capiro.ai', 'api.capiro.ai'].includes(url.hostname);
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
        for (const line of raw.split(/\r?\n/)) {
          if (!line.startsWith('data: ')) continue;
          let event; try { event = JSON.parse(line.slice(6)); } catch { continue; }
          if (event.type === 'done') row.doneReceived = true;
          if (event.type === 'error') row.streamErrors++;
          if (event.type === 'tool_call') row.toolCalls++;
        }
        row.expectedReplyVisible = await page.getByText('Meri smoke check complete.', { exact: true }).count() > 0;
        need(!routeFailure && row.turnsSent === 1 && row.conversationsCreated === 1 && row.doneReceived && row.streamErrors === 0 && row.toolCalls === 0 && row.expectedReplyVisible, routeFailure || 'SMOKE_ASSERTION_FAILED');
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
    summary.verdict = 'PASS'; summary.completedAt = new Date().toISOString(); persist();
  } catch (error) {
    summary.verdict = 'BLOCKED'; summary.failureCode = error.safeCode || error.name; summary.completedAt = new Date().toISOString(); persist(); throw error;
  }
  console.log(JSON.stringify({ verdict: summary.verdict, tenants: summary.tenants.length, turnsSent: summary.tenants.reduce((n, x) => n + x.turnsSent, 0), fullFile01Acceptance: false }));
}
main().catch(error => { console.error(JSON.stringify({ verdict: 'BLOCKED', code: error.safeCode || error.name })); process.exitCode = 1; });
