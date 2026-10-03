import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { aws } from '../meri-fresh-20261003/auth-preflight.mjs';
import { assertCase01SyntheticIdentity } from './case01-native-bootstrap-v2/run-case01-native.mjs';
import { controlledReadBrowserRequestAllowed } from '../../meri-c1-20261002/evals/meri/live-v1/run-controlled-read.mjs';
const root = 'C:/dev/main/outputs/meri-c2-20261003';
const failedRoot = root + '/case01-native-bd35c0f4-1604-4371-b7e9-a1338369e53f';
const output = root + '/case01-browser-readiness-diagnostic-v1.json';
assert.equal(existsSync(output), false);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const execution = read(failedRoot + '/execution.json');
assert.equal(execution.executionAttempted, false);
assert.equal(execution.sessionRevoked, true);
assert.equal(execution.conversationId, 'f493355c-ee97-44a1-a0b0-e05e7b104b59');
assert.equal(execution.conversationReadback.status, 'EMPTY_OWNED_CONVERSATION_CREATED');
assert.equal(existsSync(failedRoot + '/artifacts'), false);
const config = read(failedRoot + '/actual-capture-scope.json');
const manifest = read(root + '/case01-recovered-auth-scope.private.json');
const journalPath = 'C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl';
const journalSha256 = hash(readFileSync(journalPath));
assert.equal(journalSha256, '7ac5a5d06782d325e0d30327586968aa60233681b7dec2ed98f50285ed6daa60');
const require = createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');
const { createClerkClient } = require('@clerk/backend');
const { chromium } = require('C:/dev/node_modules/playwright');
const secret = aws(['secretsmanager','get-secret-value','--secret-id','arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM']).SecretString;
assert.equal(typeof secret, 'string'); assert.equal(/^sk_/u.test(secret), true);
const clerk = createClerkClient({ secretKey: secret });
const actor = manifest.ids.users.pat, tenant = manifest.ids.tenants.t1;
const result = { status: 'RUNNING', startedAt: new Date().toISOString(),
  failedExecutionSha256: hash(readFileSync(failedRoot + '/execution.json')), journalSha256,
  conversationId: execution.conversationId, applicationWrites: 0, providerCalls: 0, journalMutations: 0,
  captureEntryCalls: 0, blockedRequests: [], sessionRevoked: false };
const fd = openSync(output, 'wx', 0o600);
const save = () => { writeFileSync(fd, JSON.stringify(result, null, 2) + '\n'); fsyncSync(fd); };
let browser, sessionId;
try {
  assertCase01SyntheticIdentity({ manifest, config, instance: await clerk.instance.get(),
    user: await clerk.users.getUser(actor.clerkUserId),
    organization: await clerk.organizations.getOrganization({ organizationId: tenant.clerkOrgId }),
    memberships: await clerk.users.getOrganizationMembershipList({ userId: actor.clerkUserId, limit: 100 }) });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await context.route('**/*', async route => {
    const request = route.request();
    if (controlledReadBrowserRequestAllowed({ url: request.url(), method: request.method(),
      topNavigation: request.isNavigationRequest() && request.frame() === page.mainFrame() })) return route.continue();
    const u = new URL(request.url());
    result.blockedRequests.push({ origin: u.origin, path: u.pathname, method: request.method() });
    return route.abort('blockedbyclient');
  });
  await page.goto('https://os.capiro.ai/meri', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 45000 });
  const ticket = await clerk.signInTokens.createSignInToken({ userId: actor.clerkUserId, expiresInSeconds: 120 });
  const signed = await page.evaluate(async token => {
    const r = await window.Clerk.client.signIn.create({ strategy: 'ticket', ticket: token });
    return { status: r.status, sessionId: r.createdSessionId };
  }, ticket.token);
  sessionId = signed.sessionId; assert.equal(signed.status, 'complete'); assert.equal(typeof sessionId, 'string');
  await page.evaluate(input => window.Clerk.setActive(input), { session: sessionId, organization: tenant.clerkOrgId });
  await page.waitForFunction(({ userId, orgId }) => window.Clerk?.loaded && window.Clerk.user?.id === userId && window.Clerk.organization?.id === orgId,
    { userId: actor.clerkUserId, orgId: tenant.clerkOrgId }, { timeout: 45000 });
  const before = await page.evaluate(() => ({ loaded: window.Clerk?.loaded ?? false, sessionPresent: !!window.Clerk?.session,
    releaseSha: window.__CAPIRO_CONFIG__?.releaseSha }));
  assert.equal(before.releaseSha, '78ad5805679a3045b1fc10fb19beafa7f76e4e64');
  result.beforeNavigation = before;
  await page.goto('https://os.capiro.ai/meri/t/' + execution.conversationId, { waitUntil: 'domcontentloaded', timeout: 45000 });
  result.immediateAfterNavigation = await page.evaluate(async () => {
    const state = { loaded: window.Clerk?.loaded ?? false, sessionPresent: !!window.Clerk?.session, releaseSha: window.__CAPIRO_CONFIG__?.releaseSha };
    try {
      const token = await window.Clerk.session.getToken({ template: 'capiro', skipCache: true });
      return { ...state, tokenAvailable: typeof token === 'string' && token.length > 0 };
    } catch (error) {
      return { ...state, tokenAvailable: false, errorClass: error?.name === 'TypeError' ? 'TypeError' : 'OTHER',
        missingObjectProperty: /(?:undefined|null).*getToken|getToken.*(?:undefined|null)/u.test(String(error?.message ?? '')), messageOmitted: true };
    }
  });
  await page.waitForFunction(({ userId, orgId }) => window.Clerk?.loaded && !!window.Clerk.session && window.Clerk.user?.id === userId && window.Clerk.organization?.id === orgId,
    { userId: actor.clerkUserId, orgId: tenant.clerkOrgId }, { timeout: 45000 });
  result.afterReadinessWait = await page.evaluate(async () => {
    const token = await window.Clerk.session.getToken({ template: 'capiro', skipCache: true });
    return { loaded: window.Clerk.loaded, sessionPresent: !!window.Clerk.session, tokenAvailable: typeof token === 'string' && token.length > 0,
      releaseSha: window.__CAPIRO_CONFIG__?.releaseSha };
  });
  result.status = 'READ_ONLY_BROWSER_DIAGNOSTIC_COMPLETE';
} catch (error) {
  result.status = 'DIAGNOSTIC_FAILED';
  result.errorClass = ['AssertionError','TypeError','TimeoutError','Error'].includes(error?.name) ? error.name : 'OTHER';
  result.errorMessageSha256 = hash(String(error?.message ?? ''));
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try { await clerk.sessions.revokeSession(sessionId); assert.equal((await clerk.sessions.getSession(sessionId)).status, 'revoked'); result.sessionRevoked = true; }
    catch { result.sessionCleanupUnconfirmed = true; process.exitCode = 1; }
  }
  if (browser) await browser.close();
  result.journalUnchanged = hash(readFileSync(journalPath)) === journalSha256;
  result.completedAt = new Date().toISOString();
  save(); closeSync(fd);
  console.log(JSON.stringify(result));
}
