// One original case01 capture; credentials remain in process and session is revoked.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import {BASE,REPO,loadRelease,assertSameRelease,readCase01Inputs,stableHash} from './live-operator-gates.mjs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCase01LiveCapture, executeCase01LiveCapture,currentCase01CaptureAuthority } from 'file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/case01-live-capture.mjs';
import { gradeCase01CapturedOutcome } from 'file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/grade-case01-capture.mjs';
import { createWindowsArtifactStorage } from 'file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/windows-artifact-storage.mjs';

const base = BASE, repo = REPO;
const driverName='run-case01-authenticated-v2.mjs';
let release,preparedInputs,outcome;
const origin = 'https://os.capiro.ai';
const namespace = 'meri-foundation-20260928';
const expectedWeb = '78ad5805679a3045b1fc10fb19beafa7f76e4e64';
const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (condition, code) => { if (!condition) { const e = new Error(code); e.safeCode = code; throw e; } };
const req = createRequire(repo + '/apps/api/package.json');
let clerk, browser, createdSessionId;
let summary;
const output = join(base, 'case01-live-execution-v2.json');
const persist = () => writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
function secret() {
  const values = readFileSync('C:/ProgramData/Hermes/.env', 'utf8').split(/\r?\n/u)
    .filter(line => /^CLERK_SECRET_KEY\s*=/u.test(line))
    .map(line => line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/gu, ''));
  need(values.length === 1 && values[0], 'CLERK_SECRET_UNAVAILABLE');
  return values[0];
}
async function verifyWeb(page) {
  const current = await page.evaluate(() => {
    const config = window.__CAPIRO_CONFIG__;
    let clerkHost = 'invalid';
    const match = /^pk_(?:live|test)_([A-Za-z0-9_-]+)$/.exec(config?.clerkPublishableKey || '');
    if (match) { try { clerkHost = atob(match[1].replace(/-/g, '+').replace(/_/g, '/')).replace(/\$$/, ''); } catch {} }
    return { releaseSha: config?.releaseSha, webSurface: config?.webSurface, clerkHost };
  });
  need(current.releaseSha === expectedWeb && current.webSurface === 'vnext' && current.clerkHost === 'clerk.app.capiro.ai', 'WEB_RELEASE_MISMATCH');
}
async function revokeOwned(){
  if(!createdSessionId||!clerk)return;
  let state=await clerk.sessions.getSession(createdSessionId);
  if(!['ended','revoked'].includes(state.status)){
    await clerk.sessions.revokeSession(createdSessionId);
    state=await clerk.sessions.getSession(createdSessionId);
  }
  need(['ended','revoked'].includes(state.status),'SESSION_CLEANUP_FAILED');
  if(summary){summary.sessionRevoked=true;persist();}
}
async function main() {
  need(process.argv.length === 3 && ['--execute-original-case01-once','--check-readiness'].includes(process.argv[2]), 'EXACT_COMMAND_REQUIRED');
  release=loadRelease(driverName);
  preparedInputs=readCase01Inputs(release);
  const {config}=preparedInputs;
  const build={sourceSha:release.sourceSha,orchestratorSourceSha:release.sourceSha};
  if(process.argv[2]==='--check-readiness'){console.log(JSON.stringify({status:'LOCAL_INPUTS_READY',caseId:'01',sourceSha:release.sourceSha,networkCalls:0}));return;}
  need(!existsSync(output)&&!existsSync(join(base,'case01-live-artifacts-v2')),'NEW_OPERATION_PATHS_REQUIRED');
  const manifest = read('C:/dev/cap-meri-foundation-evidence/private/meri-foundation-20260928.manifest.json');
  need(manifest.namespace === namespace && manifest.target === 'capiro-dev' && manifest.status === 'ready', 'SYNTHETIC_MANIFEST_INVALID');
  const actor = manifest.ids.users.pat, tenant = manifest.ids.tenants.t1;
  need(config.scope.actors.PAT.clerkUserId === actor.clerkUserId && config.scope.actors.PAT.userId === actor.userId && config.scope.tenants.T1.physicalId === tenant.tenantId, 'SYNTHETIC_BINDING_MISMATCH');
  const { createClerkClient } = req('@clerk/backend');
  const { chromium } = req('C:/dev/node_modules/playwright');
  clerk = createClerkClient({ secretKey: secret() });
  need((await clerk.instance.get()).id === manifest.targetBinding.clerkInstanceId, 'CLERK_INSTANCE_MISMATCH');
  const user = await clerk.users.getUser(actor.clerkUserId);
  const organization = await clerk.organizations.getOrganization({ organizationId: tenant.clerkOrgId });
  const memberships = await clerk.users.getOrganizationMembershipList({ userId: actor.clerkUserId, limit: 100 });
  const email = manifest.handles.users.pat;
  need(user.publicMetadata?.fixtureNamespace === namespace && /synthetic/iu.test([user.firstName, user.lastName].join(' ')) && email.includes(namespace) && email.endsWith('@example.com') && user.emailAddresses.some(row => row.emailAddress === email), 'SYNTHETIC_USER_MISMATCH');
  need(organization.slug === namespace + '-t1' && organization.publicMetadata?.fixtureNamespace === namespace, 'SYNTHETIC_ORG_MISMATCH');
  need(memberships.totalCount === 1 && memberships.data.length === 1 && memberships.data[0].organization?.id === tenant.clerkOrgId && memberships.data[0].role === 'org:member', 'ORDINARY_ACTOR_REQUIRED');
  summary = { schemaVersion: 1, caseId: '01', sourceSha: build.sourceSha, webSourceSha:release.webSourceSha, operatorHead:release.operatorHead, pinsSha256:release.pinsSha256, inputPinsSha256:preparedInputs.inputPinsSha256, scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))), captureRunId: config.captureRunId, conversationId: config.conversationId, startedAt: new Date().toISOString(), verdict: 'NOT_RUN', maximumNewTurns: 1, browserApplicationWrites: 0, sessionCreated: false, sessionRevoked: false, fullFile01Acceptance: false };
  writeFileSync(join(base, 'case01-live-execution-v2.lock'), JSON.stringify({ sourceSha: build.sourceSha, captureRunId: config.captureRunId, conversationId: config.conversationId }), { flag: 'wx' });
  persist();
  assertSameRelease(release,loadRelease(driverName));
  need(stableHash(preparedInputs)===stableHash(readCase01Inputs(release)),'CASE01_INPUTS_CHANGED');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  let routeFailure;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && url.origin !== origin) {
      routeFailure = 'UNEXPECTED_NAVIGATION'; return route.abort('blockedbyclient');
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || url.origin === 'https://clerk.app.capiro.ai') return route.continue();
    routeFailure = 'BROWSER_MUTATION_BLOCKED'; return route.abort('blockedbyclient');
  });
  await page.goto(origin + '/meri', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 45000 });
  await verifyWeb(page);
  need(!routeFailure, routeFailure);
  assertSameRelease(release,loadRelease(driverName));
  need(stableHash(preparedInputs)===stableHash(readCase01Inputs(release)),'CASE01_INPUTS_CHANGED');
  const ticket = await clerk.signInTokens.createSignInToken({ userId: actor.clerkUserId, expiresInSeconds: 120 });
  const signedIn = await page.evaluate(async token => {
    const attempt = await window.Clerk.client.signIn.create({ strategy: 'ticket', ticket: token });
    return { complete: attempt.status === 'complete', sessionId: attempt.createdSessionId };
  }, ticket.token);
  createdSessionId = signedIn.sessionId;
  summary.sessionCreated = typeof createdSessionId === 'string' && !!createdSessionId; persist();
  need(signedIn.complete && summary.sessionCreated, 'SYNTHETIC_AUTH_FAILED');
  await page.evaluate(async input => window.Clerk.setActive(input), { session: createdSessionId, organization: tenant.clerkOrgId });
  await page.goto(origin + '/meri/t/' + config.conversationId, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(({ userId, orgId }) => window.Clerk?.loaded && window.Clerk.user?.id === userId && window.Clerk.organization?.id === orgId, { userId: actor.clerkUserId, orgId: tenant.clerkOrgId });
  await verifyWeb(page);
  need(!routeFailure, routeFailure);
  const bearer = await page.evaluate(() => window.Clerk.session.getToken({ template: 'capiro' }));
  need(typeof bearer === 'string' && bearer.length > 0, 'CAPTURE_BEARER_UNAVAILABLE');
  const runRoot = join(base, 'case01-live-artifacts-v2');
  const storage = createWindowsArtifactStorage(runRoot, { pythonExecutable: 'C:/ProgramData/Hermes/tools/python-3.14.7+20260901-win32-x64/python.exe' });
  assertSameRelease(release,loadRelease(driverName));
  need(stableHash(preparedInputs)===stableHash(readCase01Inputs(release)),'CASE01_INPUTS_CHANGED');
  const capability = await prepareCase01LiveCapture({ config, runRoot, artifactStorage: storage, env: { MERI_LIVE_BEARER_TOKEN: bearer } });
  summary.capturePrepared = true; persist();
  assertSameRelease(release,loadRelease(driverName));
  need(stableHash(preparedInputs)===stableHash(readCase01Inputs(release)),'CASE01_INPUTS_CHANGED');
  summary.nativeExecutionInvoked=true;persist();
  outcome = await executeCase01LiveCapture(capability);
  summary.outcome = outcome; persist();
  need(outcome.status === 'CAPTURE_COMPLETE' && outcome.synthesisSubmissionCount === 1, outcome.reason || 'CAPTURE_NOT_COMPLETE');
  // No second model call or fabricated human score. Grade the same process-owned capture.
  summary.grading = gradeCase01CapturedOutcome(outcome); persist();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await verifyWeb(page);
  const response = page.locator('[aria-label="Meri\'s response"]');
  await response.waitFor({ state: 'visible', timeout: 30000 });
  need(await response.count() === 1 && !routeFailure, routeFailure || 'OWNED_ASSISTANT_NOT_UNIQUE');
  await response.screenshot({ path: join(base, 'case01-assistant-v2.png') });
  summary.assistantVisible = true;
  summary.verdict = summary.grading.deterministicStatus === 'PASS' ? 'CAPTURE_AND_DETERMINISTIC_PASS' : 'FAIL';
  need(summary.grading.deterministicStatus==='PASS','CASE01_DETERMINISTIC_FAILURE');
  await browser.close();browser=undefined;
  await revokeOwned();
  const actual=currentCase01CaptureAuthority(outcome);
  const reviewRequest={schemaVersion:1,kind:'meri-case01-human-adjudication-request',caseId:'01',
    captureRunId:outcome.captureRunId,turnId:actual.joins.turnId,
    answerSha256:hash(actual.evidence.inputs.answer),evidenceSha256:outcome.evidence.sha256,
    completedAt:actual.evidence.inputs.envelope.receipt.completedAt,
    screenshot:'case01-assistant-v2.png',screenshotSha256:hash(readFileSync(join(base,'case01-assistant-v2.png'))),
    evidence:outcome.evidence,humanRubric:'NOT_RUN'};
  writeFileSync(join(base,'case01-human-adjudication-request-v2.json'),JSON.stringify(reviewRequest,null,2)+'\n',{flag:'wx'});
  summary.humanRubric='NOT_RUN';summary.verdict='CAPTURED_AWAITING_HUMAN_ADJUDICATION';persist();
  console.log(JSON.stringify({caseId:'01',status:summary.verdict,deterministicStatus:summary.grading.deterministicStatus,sessionRevoked:summary.sessionRevoked,evidenceSha256:outcome.evidence.sha256}));
  const lines=createInterface({input:process.stdin});
  const command=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),20*60*1000);lines.once('line',line=>{clearTimeout(timer);resolve(line);});lines.once('close',()=>{clearTimeout(timer);resolve(null);});});lines.close();
  if(command===null){
    summary.verdict='CAPTURED_HUMAN_REVIEW_PENDING';summary.humanRubric='NOT_RUN';summary.awaitingHumanReview=true;
    summary.turnResubmissionAllowed=false;summary.opaqueOutcomeAvailableAfterExit=false;
    summary.followupConstraint='Saved artifacts and hashes remain available for manual review; the existing opaque grader requires this original process. No repeat capture or new turn is authorized.';
    persist();return;
  }
  need(command==='GRADE_SAVED_CASE01_HUMAN_ADJUDICATION','REVIEW_COMMAND_REQUIRED');
  summary.grading=gradeCase01CapturedOutcome(outcome,{humanAdjudication:read(join(base,'case01-human-adjudication-v2.json'))});
  summary.humanRubric=summary.grading.status;summary.verdict=summary.grading.status==='PASS'?'CASE01_PASS':summary.grading.status;persist();
  need(summary.grading.status==='PASS','CASE01_HUMAN_ADJUDICATION_NOT_PASS');
}
try {
  await main();
} catch (error) {
  if (summary) { summary.verdict = 'BLOCKED'; summary.failureCode = error.safeCode || error.code || error.name; }
  else console.error(JSON.stringify({ verdict: 'BLOCKED', code: error.safeCode || error.name }));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  try{await revokeOwned();}catch{if(summary){summary.verdict='BLOCKED';summary.failureCode='SESSION_CLEANUP_FAILED';}process.exitCode=1;}
  if (summary) {
    summary.completedAt = new Date().toISOString(); persist();
    console.log(JSON.stringify({ verdict: summary.verdict, caseId: '01', turnsSent: summary.outcome?.synthesisSubmissionCount ?? (summary.nativeExecutionInvoked?null:0), deterministicStatus: summary.grading?.deterministicStatus, sessionRevoked: summary.sessionRevoked, failureCode: summary.failureCode, fullFile01Acceptance:false }));
    if (!['CASE01_PASS','CAPTURED_HUMAN_REVIEW_PENDING'].includes(summary.verdict)) process.exitCode = 1;
  }
}
