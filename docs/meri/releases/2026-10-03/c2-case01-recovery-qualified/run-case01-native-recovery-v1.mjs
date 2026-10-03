#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildCase01Scope, assertCase01SyntheticIdentity } from './case01-native-bootstrap-v2/run-case01-native.mjs';
import { case01SubmissionObservation } from './case01-native-bootstrap-v2/case01-prepared-guards.mjs';
import { prepareCase01LiveCapture, executeCase01LiveCapture, inspectCase01Scope } from '../../meri-c1-20261002/evals/meri/live-v1/case01-live-capture.mjs';
import { gradeCase01CapturedOutcome } from '../../meri-c1-20261002/evals/meri/live-v1/grade-case01-capture.mjs';
import { createWindowsArtifactStorage } from '../../meri-c1-20261002/evals/meri/live-v1/windows-artifact-storage.mjs';
import { restoreCase01PresubmissionCaptureSpend } from '../../meri-c1-20261002/evals/meri/live-v1/capture-spend-aggregate.mjs';
import { acquireCase01PresubmissionRecoveryAuthority, inspectCase01PresubmissionRecoveryAuthority,
  recheckCase01PresubmissionRecoveryAuthority } from '../../meri-c1-20261002/evals/meri/live-v1/case01-presubmission-recovery-authority.mjs';
import { controlledReadBrowserRequestAllowed } from '../../meri-c1-20261002/evals/meri/live-v1/run-controlled-read.mjs';
const root = 'C:/dev/main/outputs/meri-c2-20261003';
const repo = 'C:/dev/main/meri-c1-20261002';
const fixedRun = 'bd35c0f4-1604-4371-b7e9-a1338369e53f';
const fixedConversation = 'f493355c-ee97-44a1-a0b0-e05e7b104b59';
const originalRoot = root + '/case01-native-' + fixedRun;
const fixedOutput = root + '/case01-native-recovery-v1-' + fixedRun;
const reviewPath = root + '/case01-native-recovery-v1-reviewed-input.json';
const previousOperator = 'b7918cd947e6cc7fb8c83ee171e5fa50e483e7aa';
const origin = 'https://os.capiro.ai';
const pythonExecutable = 'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';
const require = createRequire(repo + '/apps/api/package.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
const need = (value, code) => { if (!value) { const e = new Error(code); e.safeCode = code; throw e; } };
const safeFailure = error => /^(?:CASE01_|CAPTURE_SPEND_)[A-Z0-9_]+$/u.test(error?.safeCode ?? error?.message ?? '') ? (error.safeCode ?? error.message) : 'CASE01_RECOVERY_OPERATOR_FAILED';
function writeExclusive(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
}
async function verifyWeb(page, expectedWebSha) {
  const current = await page.evaluate(() => {
    const config = window.__CAPIRO_CONFIG__;
    let clerkHost = 'invalid';
    const match = /^pk_(?:live|test)_([A-Za-z0-9_-]+)$/.exec(config?.clerkPublishableKey || '');
    if (match) {
      try {
        clerkHost = atob(match[1].replace(/-/g, '+').replace(/_/g, '/')).replace(/\$$/, '');
      } catch {}
    }
    return { releaseSha: config?.releaseSha, webSurface: config?.webSurface, clerkHost };
  });
  need(
    current.releaseSha === expectedWebSha &&
      current.webSurface === 'vnext' &&
      current.clerkHost === 'clerk.app.capiro.ai',
    'WEB_RELEASE_MISMATCH',
  );
}
export async function runCase01RecoveryOperator(args = process.argv.slice(2)) {
  let clerk, browser, createdSessionId, summary, output, eventPath, sequence = 0;
  const persist = () => {
    if (!summary) return;
    summary.submissionObservation = case01SubmissionObservation(summary);
    const bytes = JSON.stringify(summary, null, 2) + '\n';
    // The append-only fsynced history survives later summary replacement/failure.
    const fd = openSync(eventPath, 'a', 0o600);
    try { writeFileSync(fd, JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), summary }) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    writeFileSync(output, bytes, { mode: 0o600 });
    const current = openSync(output, 'r+');
    try { fsyncSync(current); } finally { closeSync(current); }
  };
  try {
    need(args.length === 1 && args[0] === '--continue-same-unsubmitted-case01-once', 'CASE01_RECOVERY_COMMAND_REQUIRED');
    const clerkSecret = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;
    const review = read(reviewPath);
    need(review.status === 'REVIEWED_CASE01_PRESUBMISSION_CONTINUATION' && /^[a-f0-9]{40}$/u.test(review.operatorCommit), 'CASE01_RECOVERY_REVIEW_REQUIRED');
    for (const item of review.files) need(hash(readFileSync(item.path)) === item.sha256, 'CASE01_RECOVERY_SOURCE_CHANGED');
    const git = (...values) => execFileSync('git', values, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
    need(git('status', '--porcelain') === '' && git('rev-parse', 'HEAD') === review.operatorCommit, 'CASE01_RECOVERY_CLEAN_SOURCE_REQUIRED');
    git('merge-base', '--is-ancestor', previousOperator, 'HEAD');
    const allowed = new Set(['evals/meri/live-v1/case01-presubmission-recovery-authority.mjs',
      'evals/meri/live-v1/tests/case01-presubmission-recovery.test.mjs', 'evals/meri/live-v1/capture-spend-aggregate.mjs']);
    need(git('diff', '--name-only', previousOperator + '..HEAD').split('\n').every(p => !p || p.startsWith('docs/') || allowed.has(p)), 'CASE01_RECOVERY_UNREVIEWED_DELTA');
    const scopePath = root + '/case01-native-actual-scope-v2.json';
    const manifestPath = root + '/case01-recovered-auth-scope.private.json';
    const scopeBytes = readFileSync(scopePath), input = JSON.parse(scopeBytes);
    need(hash(scopeBytes) === '87b10494d9547a4ec9fb28641271d9cec7fbfa5cd9d3c971c91201400fce4d69', 'CASE01_ORIGINAL_SCOPE_CHANGED');
    const { config, expectedWebSha, qualificationExpiresAt, setupProof } = buildCase01Scope(input);
    need(hash(readFileSync(manifestPath)) === input.manifestSha256, 'CASE01_MANIFEST_BYTES_CHANGED');
    config.conversationId = fixedConversation;
    need(isDeepStrictEqual(config, read(originalRoot + '/actual-capture-scope.json')), 'CASE01_ORIGINAL_CONVERSATION_SCOPE_CHANGED');
    inspectCase01Scope(config, { MERI_LIVE_BEARER_TOKEN: 'static-shape-only' });
    need(Date.parse(qualificationExpiresAt) > Date.now() + 900000, 'CASE01_CURRENT_RATES_REQUIRED');
    need(process.platform === 'win32' && clerkSecret, 'CASE01_PRIVATE_CLERK_INPUT_REQUIRED');
    const manifest = read(manifestPath), outRoot = fixedOutput;
    mkdirSync(outRoot); // Exclusive continuation directory; a rerun cannot overwrite it.
    output = join(outRoot, 'execution.json'); eventPath = join(outRoot, 'execution-events.jsonl');
    summary = { schemaVersion: 1, caseId: '01', captureRunId: fixedRun, conversationId: fixedConversation,
      operatorSourceSha: review.operatorCommit, originalOperatorSourceSha: previousOperator,
      sourceSha: config.deployment.apiSha, orchestratorSha: config.deployment.orchestratorSha,
      expectedWebSha, scopeFileSha256: hash(scopeBytes), manifestSha256: input.manifestSha256, setupProof,
      scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))), startedAt: new Date().toISOString(),
      verdict: 'NOT_RUN', stage: 'AUTHENTICATION', maximumNewTurns: 1, automaticPaidRetryAllowed: false,
      browserApplicationWrites: 0, conversationCreationAttempted: false, newReservationAttempted: false,
      executionAttempted: false, sessionCreated: false, sessionRevoked: false, fullFile01Acceptance: false };
    writeExclusive(join(outRoot, 'actual-capture-scope.json'), config);
    persist();
    const { createClerkClient } = require('@clerk/backend');
    const { chromium } = require('C:/dev/node_modules/playwright');
    clerk = createClerkClient({ secretKey: clerkSecret });
    const actor = manifest.ids.users.pat,
      tenant = manifest.ids.tenants.t1;
    assertCase01SyntheticIdentity({
      manifest,
      config,
      instance: await clerk.instance.get(),
      user: await clerk.users.getUser(actor.clerkUserId),
      organization: await clerk.organizations.getOrganization({
        organizationId: tenant.clerkOrgId,
      }),
      memberships: await clerk.users.getOrganizationMembershipList({
        userId: actor.clerkUserId,
        limit: 100,
      }),
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    let routeFailure;
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (
        controlledReadBrowserRequestAllowed({
          url: request.url(),
          method: request.method(),
          topNavigation: request.isNavigationRequest() && request.frame() === page.mainFrame(),
        })
      )
        return route.continue();
      routeFailure = 'BROWSER_REQUEST_BLOCKED';
      return route.abort('blockedbyclient');
    });
    await page.goto(origin + '/meri', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 45000 });
    await verifyWeb(page, expectedWebSha);
    need(!routeFailure, routeFailure);
    const ticket = await clerk.signInTokens.createSignInToken({
      userId: actor.clerkUserId,
      expiresInSeconds: 120,
    });
    summary.signInAttempted = true;
    persist();
    const signedIn = await page.evaluate(async (token) => {
      const attempt = await window.Clerk.client.signIn.create({
        strategy: 'ticket',
        ticket: token,
      });
      return { complete: attempt.status === 'complete', sessionId: attempt.createdSessionId };
    }, ticket.token);
    createdSessionId = signedIn.sessionId;
    summary.sessionCreated = typeof createdSessionId === 'string' && !!createdSessionId;
    if (summary.sessionCreated) {
      summary.createdSessionIdSha256 = hash(createdSessionId);
      // Session ID stays in memory. The hash allows an authorized recovery
      // operator to identify only this session from the same synthetic user's
      // private Clerk readback after a process interruption.
    }
    persist();
    need(signedIn.complete && summary.sessionCreated, 'SYNTHETIC_AUTH_FAILED');
    await page.evaluate(async (input) => window.Clerk.setActive(input), {
      session: createdSessionId,
      organization: tenant.clerkOrgId,
    });
    await page.waitForFunction(
      ({ userId, orgId }) =>
        window.Clerk?.loaded &&
        window.Clerk.user?.id === userId &&
        window.Clerk.organization?.id === orgId,
      { userId: actor.clerkUserId, orgId: tenant.clerkOrgId },
    );
    await verifyWeb(page, expectedWebSha);
    need(!routeFailure, routeFailure);
    await page.goto(origin + '/meri/t/' + config.conversationId, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(({ userId, orgId, sessionId }) => window.Clerk?.loaded &&
      window.Clerk.session?.id === sessionId && window.Clerk.user?.id === userId && window.Clerk.organization?.id === orgId,
      { userId: actor.clerkUserId, orgId: tenant.clerkOrgId, sessionId: createdSessionId }, { timeout: 45000 });
    await verifyWeb(page, expectedWebSha);
    need(!routeFailure, 'CASE01_BROWSER_REQUEST_BLOCKED');
    const bearer = await page.evaluate(() => window.Clerk.session.getToken({ template: 'capiro', skipCache: true }));
    need(typeof bearer === 'string' && bearer.length > 0, 'CASE01_CAPTURE_BEARER_UNAVAILABLE');
    summary.stage = 'QUALIFY_EXISTING_RESERVATION'; persist();
    const authority = await acquireCase01PresubmissionRecoveryAuthority({ bearer,
      invocation: 'QUALIFY_SAME_CASE01_UNSUBMITTED_RESERVATION_ONCE' });
    summary.recoveryProof = inspectCase01PresubmissionRecoveryAuthority(authority); persist();
    const { owner: spendOwner, reservation: spendReservation } = restoreCase01PresubmissionCaptureSpend(authority,
      { pythonExecutable, invocation: 'RESTORE_SAME_CASE01_UNSUBMITTED_RESERVATION_ONCE' });
    const saveSpendCheckpoint = name => writeExclusive(join(outRoot, name), spendOwner.checkpoint());
    saveSpendCheckpoint('aggregate-restored-checkpoint.json');
    summary.restoredReservation = { caseId: spendReservation.caseId, captureRunId: spendReservation.captureRunId,
      reservationId: spendReservation.reservationId, ceilingMicros: spendReservation.ceilingMicros };
    summary.stage = 'PREPARE_NATIVE_CAPTURE'; persist();
    const runRoot = join(outRoot, 'artifacts');
    const storage = createWindowsArtifactStorage(runRoot, {
      pythonExecutable,
    });
    const capability = await prepareCase01LiveCapture({
      config,
      runRoot,
      artifactStorage: storage,
      spendReservation,
      env: { MERI_LIVE_BEARER_TOKEN: bearer },
    });
    summary.capturePrepared = true;
    const admitted = JSON.parse(storage.readBytes('admission.json').toString('utf8')).admission;
    summary.nativeAdmissionReadback = {
      qualificationSha256: admitted?.providerBudget?.qualificationSha256 ?? null,
      currentVerifySha256: admitted?.fixture?.currentVerifySha256 ?? null,
    };
    persist();
    need(summary.nativeAdmissionReadback.qualificationSha256 === setupProof.qualificationSha256 &&
      summary.nativeAdmissionReadback.currentVerifySha256 === setupProof.currentVerifySha256,
      'CASE01_NATIVE_SETUP_CHANGED');
    // Recovery proof repeats actual empty-conversation/no-admission reads once;
    // native execution then checks current fixture, budget, messages and spend.
    await recheckCase01PresubmissionRecoveryAuthority({ authority, bearer,
      invocation: 'RECHECK_SAME_CASE01_BEFORE_FIRST_SUBMISSION_ONCE' });
    summary.recoveryProof = inspectCase01PresubmissionRecoveryAuthority(authority);
    need(!routeFailure, 'CASE01_BROWSER_REQUEST_BLOCKED');
    summary.stage = 'EXECUTE_NATIVE_CAPTURE'; persist();

    // Persist uncertainty before entering the native owner. A thrown error can
    // follow a submitted stream or a failed artifact finalization; never infer zero.
    summary.executionAttempted = true;
    summary.executionIntent = {
      phase: 'EXECUTE_CASE01_LIVE_CAPTURE',
      captureRunId: config.captureRunId,
      conversationId: config.conversationId,
      recordedAt: new Date().toISOString(),
      automaticPaidRetryAllowed: false,
      uncertainReservationRetained: true,
    };
    persist(); // fsync event history and current summary before native dispatch.
    const outcome = await executeCase01LiveCapture(capability);
    summary.outcome = outcome;
    persist(); // Preserve failed/uncertain native result before checkpoints/assertions.
    saveSpendCheckpoint('aggregate-final-checkpoint.json');
    need(
      outcome.status === 'CAPTURE_COMPLETE' && outcome.synthesisSubmissionCount === 1,
      'CAPTURE_NOT_COMPLETE',
    );
    summary.stage = 'GRADE_AND_BROWSER_READBACK';
    summary.grading = gradeCase01CapturedOutcome(outcome);
    persist();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await verifyWeb(page, expectedWebSha);
    const response = page.locator('[aria-label="Meri\'s response"]');
    await response.waitFor({ state: 'visible', timeout: 30000 });
    need((await response.count()) === 1 && !routeFailure, 'OWNED_ASSISTANT_NOT_UNIQUE');
    await response.screenshot({ path: join(outRoot, 'assistant.png') });
    summary.assistantVisible = true;
    summary.verdict =
      summary.grading.deterministicStatus === 'PASS' ? 'CAPTURE_AND_DETERMINISTIC_PASS' : 'FAIL';
  } catch (error) {
    if (summary) {
      summary.verdict = 'BLOCKED';
      summary.failureCode = safeFailure(error);
      summary.failureDiagnostic = { errorClass: ['Error','TypeError','AssertionError','TimeoutError'].includes(error?.name) ? error.name : 'OTHER', messageSha256: hash(String(error?.message ?? '')), messageOmitted: true };
    } else
      console.error(
        JSON.stringify({
          verdict: 'BLOCKED',
          code: safeFailure(error),
        }),
      );
  } finally {
    if (summary?.signInAttempted && !createdSessionId) {
      summary.sessionCleanupUnconfirmed = true;
      summary.verdict = 'BLOCKED';
      summary.cleanupReason = 'SIGN_IN_ACKNOWLEDGEMENT_UNKNOWN_RECONCILIATION_REQUIRED';
    }
    if (createdSessionId && clerk) {
      try {
        await clerk.sessions.revokeSession(createdSessionId);
        need(
          (await clerk.sessions.getSession(createdSessionId)).status === 'revoked',
          'SESSION_REVOKE_NOT_CONFIRMED',
        );
        summary.sessionRevoked = true;
      } catch {
        if (summary) {
          summary.verdict = 'BLOCKED';
          summary.failureCode = 'SESSION_CLEANUP_FAILED';
        }
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        if (summary) {
          summary.verdict = 'BLOCKED';
          summary.failureCode = 'BROWSER_CLEANUP_FAILED';
        }
      }
    }
    if (summary) {
      summary.completedAt = new Date().toISOString();
      summary.originalEvidencePreserved = hash(readFileSync(originalRoot + '/execution.json')) === '091946b7c594ccb4821202b00eaef0d6b4cab89c2bdf4d5ca9708a8ed66c593b';
      if (!summary.originalEvidencePreserved) {
        summary.verdict = 'BLOCKED';
        summary.originalEvidenceFailure = 'CASE01_ORIGINAL_FAILURE_EVIDENCE_CHANGED';
      }
      persist();
      console.log(
        JSON.stringify({
          verdict: summary.verdict,
          caseId: summary.caseId,
          ...summary.submissionObservation,
          deterministicStatus: summary.grading?.deterministicStatus,
          sessionRevoked: summary.sessionRevoked,
          failureCode: summary.failureCode,
        }),
      );
    }
  }
  return summary?.verdict === 'CAPTURE_AND_DETERMINISTIC_PASS' && summary.sessionRevoked ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await runCase01RecoveryOperator();
