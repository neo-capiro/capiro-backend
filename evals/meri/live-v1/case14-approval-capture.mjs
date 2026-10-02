import https from 'node:https';
import { createRequire } from 'node:module';
import { buildFixtureManifest } from './fixture-provisioning/manifest.mjs';
import { selectPendingMemoryFixturePlan } from './fixture-provisioning/memory-pending-fixture-plan.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from './fixture-provisioning/contract.mjs';
import { readCase17BuildAuthority } from './case17-build-authority.mjs';
import { assertWindowsArtifactStorage } from './windows-artifact-storage.mjs';
import { sha256Bytes, sha256Stable, stableJson } from './artifact-collector.mjs';
import { currentCase14RecallAuthority } from './case01-live-capture.mjs';
import { nativeMeriCaptureHeaders } from './lib/native-http.mjs';
const ORIGIN = 'https://os.capiro.ai',
  CLERK = 'https://clerk.app.capiro.ai';
const outcomes = new WeakMap();
const need = (value, code) => {
  if (!value) throw new Error(`CASE14_APPROVAL_${code}`);
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function inspectCase14ApprovalScope(input) {
  const c = structuredClone(input),
    r = c?.recipe,
    a = c?.reviewer;
  need(
    c?.schemaVersion === 1 &&
      c.caseId === '14' &&
      c.target === ORIGIN &&
      UUID.test(c.captureRunId ?? ''),
    'SCOPE',
  );
  need(
    r?.caseId === '14' &&
      r.fixtureNamespace === FIXTURE_NAMESPACE &&
      r.ctx?.tenantId === AUTHORIZED_TENANTS.T1.id &&
      r.ctx.role === 'standard_user' &&
      r.actors.PAT.physicalId === r.ctx.userId,
    'RECIPE',
  );
  need(
    a?.tenantId === AUTHORIZED_TENANTS.T1.id &&
      a.tenantSlug === AUTHORIZED_TENANTS.T1.slug &&
      a.role === 'user_admin' &&
      a.userId === r.actors.PRIYA.physicalId &&
      a.userId !== r.ctx.userId &&
      /^user_[A-Za-z0-9]+$/u.test(a.clerkUserId ?? '') &&
      /^org_[A-Za-z0-9]+$/u.test(c.clerkOrganizationId ?? ''),
    'REVIEWER',
  );
  need(
    c.limits?.concurrency === 1 &&
      c.limits.maxApprovalSubmissions === 1 &&
      c.limits.maxSynthesisSubmissions === 0,
    'LIMITS',
  );
  return c;
}

/** Pure checks cannot mint capture authority. The native owner below supplies
 * actual authenticated detail, response and current canonical proof. */
export function inspectCase14ApprovalEvidence(e) {
  need(
    e?.kind === 'meri-case14-owned-approval-evidence' &&
      e.caseId === '14' &&
      e.applicationApprovalSubmissions === 1 &&
      e.synthesisSubmissionCount === 0 &&
      e.blockedWrites === 0 &&
      e.sessionRevoked === true,
    'BOUNDS',
  );
  const before = e.before?.fixtureEvidence,
    after = e.after?.fixtureEvidence;
  need(
    before?.kind === 'meri-case14-current-memory-owner' &&
      before.state === 'pending' &&
      after?.state === 'approved' &&
      before.caseId === '14' &&
      after.caseId === '14',
    'CANONICAL_STATE',
  );
  for (const key of [
    'candidateId',
    'recipeSha256',
    'fixtureInstanceId',
    'tenantId',
    'clientId',
    'proposerUserId',
    'reviewerUserId',
    'setupReceiptSha256',
    'payloadSha256',
    'text',
  ])
    need(before[key] === after[key], 'SOURCE_CHANGED');
  for (const owner of [before, after]) {
    const body = { ...owner };
    delete body.currentVerifySha256;
    need(sha256Stable(body) === owner.currentVerifySha256, 'OWNER_HASH');
  }
  need(
    before.tenantId === AUTHORIZED_TENANTS.T1.id &&
      before.reviewerRole === 'user_admin' &&
      before.reviewerUserId === e.reviewer.userId &&
      before.text === 'Synthetic Aster candidate for approval',
    'OWNER_SCOPE',
  );
  need(
    e.before.candidateId === before.candidateId &&
      e.after.candidateId === after.candidateId &&
      e.before.reviewRequestId === e.after.reviewRequestId &&
      e.before.status === 'pending' &&
      e.after.status === 'approved' &&
      e.after.decidedBy?.userId === e.reviewer.userId,
    'DECISION_DETAIL',
  );
  need(
    e.response.status >= 200 &&
      e.response.status < 300 &&
      e.response.releaseSha === e.apiSha &&
      e.response.value?.ok === true &&
      e.response.value.candidateId === before.candidateId &&
      e.response.value.candidateKind === 'standard' &&
      e.response.value.outcome === 'activated' &&
      e.response.value.memoryId === after.item?.clioMemoryId,
    'DECISION_ACK',
  );
  need(
    after.decision?.decision === 'approved' &&
      after.decision.actorUserId === before.reviewerUserId &&
      UUID.test(after.decision.transitionAuditId ?? '') &&
      after.item?.sourceVersion === `candidate:${before.candidateId}`,
    'CANONICAL_DECISION',
  );
  need(
    e.ui?.pendingVisible === true &&
      e.ui.confirmedVisible === true &&
      e.ui.reloadedReceiptVisible === true &&
      e.screenshots?.length === 3,
    'VISIBLE_RECEIPT',
  );
  return {
    candidateId: after.candidateId,
    physicalId: after.item.id,
    sourceVersion: after.item.sourceVersion,
    transitionAuditId: after.decision.transitionAuditId,
    approvedText: after.text,
  };
}

function nativeRead(config, bearer, deadline, candidateId) {
  let count = 0;
  return (path) =>
    new Promise((resolve, reject) => {
      need(
        ++count <= 8 &&
          Date.now() < deadline &&
          (path === '/api/me' || path === `/api/memory/review/inbox/candidates/${candidateId}`),
        'READ_BOUND',
      );
      const req = https.get(
        new URL(path, ORIGIN),
        {
          rejectUnauthorized: true,
          timeout: 15000,
          headers: {
            ...nativeMeriCaptureHeaders(bearer, config.reviewer.tenantSlug),
          },
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > 262144) req.destroy();
            else chunks.push(chunk);
          });
          response.on('error', () => reject(new Error('CASE14_APPROVAL_READ_FAILED')));
          response.on('end', () => {
            try {
              need(
                response.statusCode === 200 &&
                  response.headers['x-capiro-release-sha'] === config.deployment.apiSha,
                'READ_IDENTITY',
              );
              const text = Buffer.concat(chunks).toString();
              need(!text.includes(bearer), 'PRIVATE_RESPONSE');
              resolve(JSON.parse(text));
            } catch {
              reject(new Error('CASE14_APPROVAL_READ_INVALID'));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => reject(new Error('CASE14_APPROVAL_READ_FAILED')));
    });
}
async function web(page, sha) {
  const value = await page.evaluate(() => ({
    sha: window.__CAPIRO_CONFIG__?.releaseSha,
    surface: window.__CAPIRO_CONFIG__?.webSurface,
  }));
  need(value.sha === sha && value.surface === 'vnext', 'WEB_SOURCE');
}
async function memoryPanel(page) {
  const expand = page.getByRole('button', { name: 'Expand panel', exact: true });
  if (await expand.isVisible()) await expand.click();
  const context = page.getByRole('button', { name: 'Open Context and Memory', exact: true });
  if (await context.isVisible()) await context.click();
  await page.getByRole('button', { name: 'Memory', exact: true }).click({ timeout: 15000 });
}

/** Only one existing canonical approval POST, clicked inside Meri. No model,
 * conversation creation, fixture approval shortcut or automatic retry. */
export async function collectCase14ApprovalCapture({
  config: input,
  artifactStorage,
  createSignInTicket,
  onSessionCreated,
}) {
  const config = inspectCase14ApprovalScope(input);
  need(
    typeof createSignInTicket === 'function' && typeof onSessionCreated === 'function',
    'AUTH_CALLBACKS',
  );
  assertWindowsArtifactStorage(artifactStorage, artifactStorage?.root);
  artifactStorage.writeBytes(
    'case14-approval/attempt.json',
    Buffer.from(
      stableJson({
        caseId: '14',
        captureRunId: config.captureRunId,
        scopeSha256: sha256Stable(config),
      }),
    ),
  );
  const manifest = await buildFixtureManifest({
    fixtureInstanceId: config.recipe.fixtureInstanceId,
    actors: config.recipe.actors,
    clients: config.recipe.clients,
  });
  const selected = selectPendingMemoryFixturePlan(manifest, '14'),
    candidateId = selected.records[0].physicalId;
  need(selected.reviewerUserId === config.reviewer.userId, 'FROZEN_REVIEWER');
  const builds = await readCase17BuildAuthority(config.deployment);
  const { chromium } = createRequire(import.meta.url)('playwright');
  let browser,
    page,
    sessionId,
    timer,
    armed = false,
    submissions = 0,
    blockedWrites = 0,
    cleaned = false,
    evidence;
  const deadline = Date.now() + 240000;
  try {
    browser = await chromium.launch({ headless: true });
    timer = setTimeout(() => void browser.close().catch(() => {}), 240000);
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1000 },
    });
    page = await context.newPage();
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && url.origin !== CLERK) {
        if (
          armed &&
          submissions === 0 &&
          request.method() === 'POST' &&
          url.origin === ORIGIN &&
          url.pathname === `/api/memory/review/candidates/${candidateId}/approve` &&
          !url.search &&
          request.postData() === '{}'
        ) {
          submissions++;
          armed = false;
          return route.continue();
        }
        blockedWrites++;
        return route.abort();
      }
      if (
        request.isNavigationRequest() &&
        (request.frame() === page.mainFrame()
          ? url.origin !== ORIGIN || !/^\/(?:sign-in|meri)(?:\/|$)/u.test(url.pathname)
          : ![ORIGIN, CLERK].includes(url.origin))
      )
        return route.abort();
      return route.continue();
    });
    await page.goto(ORIGIN + '/sign-in', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 45000 });
    await web(page, config.deployment.webSha);
    const ticket = await createSignInTicket(config.reviewer.clerkUserId);
    need(typeof ticket === 'string' && ticket.length > 10 && ticket.length < 16384, 'TICKET');
    const signed = await page.evaluate(async (ticket) => {
      const a = await window.Clerk.client.signIn.create({ strategy: 'ticket', ticket });
      return { complete: a.status === 'complete', sessionId: a.createdSessionId };
    }, ticket);
    sessionId = signed.sessionId;
    if (sessionId) await onSessionCreated(sessionId);
    need(signed.complete && typeof sessionId === 'string', 'AUTH');
    await page.evaluate((value) => window.Clerk.setActive(value), {
      session: sessionId,
      organization: config.clerkOrganizationId,
    });
    await page.waitForFunction(
      ({ userId, org }) =>
        window.Clerk?.user?.id === userId && window.Clerk?.organization?.id === org,
      { userId: config.reviewer.clerkUserId, org: config.clerkOrganizationId },
      { timeout: 15000 },
    );
    const bearer = await page.evaluate(() => window.Clerk.session.getToken({ template: 'capiro' }));
    need(typeof bearer === 'string' && bearer.length > 10, 'BEARER');
    const get = nativeRead(config, bearer, deadline, candidateId),
      me = await get('/api/me');
    need(
      me.user?.id === config.reviewer.userId &&
        me.user.clerkUserId === config.reviewer.clerkUserId &&
        me.tenant?.id === config.reviewer.tenantId &&
        me.tenant.slug === config.reviewer.tenantSlug &&
        me.role === 'user_admin',
      'CURRENT_IDENTITY',
    );
    const before = await get(`/api/memory/review/inbox/candidates/${candidateId}`);
    need(
      before.fixtureEvidence?.state === 'pending' &&
        before.fixtureEvidence.recipeSha256 === sha256Stable(config.recipe) &&
        before.fixtureEvidence.manifestContentSha256 === manifest.contentSha256,
      'PENDING_OWNER',
    );
    await page.goto(ORIGIN + '/meri/new', { waitUntil: 'domcontentloaded' });
    await memoryPanel(page);
    await web(page, config.deployment.webSha);
    const section = page
      .locator('section')
      .filter({ has: page.getByText(/^NEEDS YOUR REVIEW ·/u) });
    const card = section
      .locator('article')
      .filter({ has: page.getByText('Synthetic Aster candidate for approval', { exact: true }) });
    need((await card.count()) === 1, 'UNIQUE_CARD');
    await card.waitFor({ state: 'visible', timeout: 15000 });
    const button = card.getByRole('button', { name: 'Approve', exact: true });
    need(await button.isEnabled(), 'APPROVAL_AVAILABLE');
    const screenshots = [
      artifactStorage.writeBytes('case14-approval/pending.png', await card.screenshot()),
    ];
    need(Date.now() < deadline && Date.now() - builds.observedAt < 60000, 'PRESUBMIT_FRESHNESS');
    const pending = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url() === `${ORIGIN}/api/memory/review/candidates/${candidateId}/approve`,
      { timeout: 30000 },
    );
    artifactStorage.writeBytes(
      'case14-approval/approval-intent.json',
      Buffer.from(
        stableJson({
          candidateId,
          captureRunId: config.captureRunId,
          maximumSubmissions: 1,
          status: 'INTENT',
        }),
      ),
    );
    armed = true;
    await button.click();
    const response = await pending;
    armed = false;
    need(response.status() >= 200 && response.status() < 300, 'APPROVAL_HTTP');
    const bytes = await response.body();
    need(bytes.length <= 262144 && !bytes.toString().includes(bearer), 'RESPONSE_BOUND');
    const ack = {
      status: response.status(),
      releaseSha: response.headers()['x-capiro-release-sha'],
      value: JSON.parse(bytes),
    };
    artifactStorage.writeBytes(
      'case14-approval/approval-acknowledgement.json',
      Buffer.from(stableJson(ack)),
    );
    await section
      .getByText('Decision confirmed', { exact: true })
      .waitFor({ state: 'visible', timeout: 15000 });
    screenshots.push(
      artifactStorage.writeBytes('case14-approval/confirmed.png', await section.screenshot()),
    );
    const after = await get(`/api/memory/review/inbox/candidates/${candidateId}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await memoryPanel(page);
    await web(page, config.deployment.webSha);
    const history = page
      .locator('section')
      .filter({ has: page.getByText(/^DECISION RECEIPTS ·/u) });
    const receipt = history
      .locator('[aria-label="Memory decision receipt"]')
      .filter({ hasText: `Candidate: ${candidateId}` });
    let loads = 0;
    while ((await receipt.count()) === 0) {
      const more = history.getByRole('button', {
        name: 'Load more decision receipts',
        exact: true,
      });
      need((await more.count()) === 1 && ++loads <= 9, 'RECEIPT_PAGINATION');
      const n = await history.locator('article').count();
      await more.click();
      await page.waitForFunction(
        (n) =>
          [...document.querySelectorAll('section')]
            .find((x) => x.textContent.includes('DECISION RECEIPTS ·'))
            ?.querySelectorAll('article').length > n,
        n,
        { timeout: 15000 },
      );
    }
    need((await receipt.count()) === 1, 'UNIQUE_RELOADED_RECEIPT');
    await receipt.waitFor({ state: 'visible', timeout: 15000 });
    screenshots.push(
      artifactStorage.writeBytes('case14-approval/reloaded.png', await receipt.screenshot()),
    );
    need(
      sha256Stable(
        (await get(`/api/memory/review/inbox/candidates/${candidateId}`)).fixtureEvidence,
      ) === sha256Stable(after.fixtureEvidence),
      'RESTART_OWNER_DRIFT',
    );
    need(
      sha256Stable(builds.services) ===
        sha256Stable((await readCase17BuildAuthority(config.deployment)).services),
      'DEPLOYMENT_CHANGED',
    );
    evidence = {
      kind: 'meri-case14-owned-approval-evidence',
      schemaVersion: 1,
      caseId: '14',
      captureRunId: config.captureRunId,
      reviewer: config.reviewer,
      apiSha: config.deployment.apiSha,
      webSha: config.deployment.webSha,
      builds,
      before,
      after,
      response: ack,
      screenshots,
      ui: { pendingVisible: true, confirmedVisible: true, reloadedReceiptVisible: true },
      applicationApprovalSubmissions: submissions,
      synthesisSubmissionCount: 0,
      blockedWrites,
    };
  } catch (error) {
    artifactStorage.writeBytes(
      'case14-approval/interrupted.json',
      Buffer.from(
        stableJson({
          caseId: '14',
          captureRunId: config.captureRunId,
          status: submissions ? 'RECONCILIATION_REQUIRED' : 'BLOCKED',
          applicationApprovalSubmissions: submissions,
          synthesisSubmissionCount: 0,
          blockedWrites,
        }),
      ),
    );
    throw new Error(
      /^CASE14_[A-Z_]+$/u.test(error?.message ?? '')
        ? error.message
        : 'CASE14_APPROVAL_CAPTURE_FAILED',
    );
  } finally {
    armed = false;
    if (sessionId && page)
      try {
        await page.evaluate((id) => window.Clerk.signOut({ sessionId: id }), sessionId);
        await page.waitForFunction(
          (id) => !window.Clerk?.client?.sessions?.some((s) => s.id === id),
          sessionId,
          { timeout: 15000 },
        );
        cleaned = true;
      } catch {}
    if (timer) clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
  need(cleaned && evidence, 'CLEANUP');
  evidence.sessionRevoked = true;
  evidence.completedAt = Date.now();
  inspectCase14ApprovalEvidence(evidence);
  const bytes = Buffer.from(stableJson(evidence)),
    descriptor = artifactStorage.writeBytes('case14-approval/evidence.json', bytes);
  const outcome = Object.freeze({
    caseId: '14',
    captureRunId: config.captureRunId,
    status: 'APPROVAL_CAPTURE_COMPLETE',
    evidence: descriptor,
    synthesisSubmissionCount: 0,
  });
  outcomes.set(outcome, {
    storage: artifactStorage,
    descriptor,
    sha256: sha256Bytes(bytes),
    outcomeHash: sha256Stable(outcome),
  });
  return outcome;
}

const recallUiOutcomes = new WeakMap();
/** Read-only visible replay of the already captured next turn. This function
 * cannot send a message or create a conversation and never grades by re-prompting. */
export async function collectCase14RecallUi({
  recallOutcome,
  config: input,
  artifactStorage,
  createSignInTicket,
  onSessionCreated,
}) {
  const config = inspectCase14ApprovalScope(input),
    actual = currentCase14RecallAuthority(recallOutcome),
    inputs = actual.evidence.inputs;
  need(
    recallOutcome.captureRunId === config.captureRunId &&
      inputs.expected.actorUserId === config.reviewer.userId &&
      inputs.expected.tenantId === config.reviewer.tenantId &&
      inputs.expected.apiSha === config.deployment.apiSha,
    'RECALL_SCOPE',
  );
  assertWindowsArtifactStorage(artifactStorage, artifactStorage.root);
  artifactStorage.writeBytes(
    'case14-recall-ui/attempt.json',
    Buffer.from(
      stableJson({
        captureRunId: config.captureRunId,
        conversationId: inputs.expected.conversationId,
      }),
    ),
  );
  const builds = await readCase17BuildAuthority(config.deployment),
    { chromium } = createRequire(import.meta.url)('playwright');
  let browser,
    page,
    sessionId,
    timer,
    cleaned = false,
    blockedWrites = 0,
    screenshot;
  try {
    browser = await chromium.launch({ headless: true });
    timer = setTimeout(() => void browser.close().catch(() => {}), 180000);
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1000 },
    });
    page = await context.newPage();
    await context.route('**/*', async (route) => {
      const r = route.request(),
        u = new URL(r.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method()) && u.origin !== CLERK) {
        blockedWrites++;
        return route.abort();
      }
      if (
        r.isNavigationRequest() &&
        (r.frame() === page.mainFrame()
          ? u.origin !== ORIGIN || !/^\/(?:sign-in|meri)(?:\/|$)/u.test(u.pathname)
          : ![ORIGIN, CLERK].includes(u.origin))
      )
        return route.abort();
      return route.continue();
    });
    await page.goto(ORIGIN + '/sign-in', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 45000 });
    await web(page, config.deployment.webSha);
    const ticket = await createSignInTicket(config.reviewer.clerkUserId);
    need(typeof ticket === 'string' && ticket.length > 10 && ticket.length < 16384, 'TICKET');
    const signed = await page.evaluate(async (ticket) => {
      const a = await window.Clerk.client.signIn.create({ strategy: 'ticket', ticket });
      return { complete: a.status === 'complete', sessionId: a.createdSessionId };
    }, ticket);
    sessionId = signed.sessionId;
    if (sessionId) await onSessionCreated(sessionId);
    need(signed.complete && typeof sessionId === 'string', 'AUTH');
    await page.evaluate((value) => window.Clerk.setActive(value), {
      session: sessionId,
      organization: config.clerkOrganizationId,
    });
    await page.waitForFunction(
      ({ userId, org }) =>
        window.Clerk?.user?.id === userId && window.Clerk?.organization?.id === org,
      { userId: config.reviewer.clerkUserId, org: config.clerkOrganizationId },
      { timeout: 15000 },
    );
    const bearer = await page.evaluate(() => window.Clerk.session.getToken({ template: 'capiro' }));
    need(typeof bearer === 'string' && bearer.length > 10, 'BEARER');
    const me = await nativeRead(
      config,
      bearer,
      Date.now() + 120000,
      inputs.authority.fixture.candidateId,
    )('/api/me');
    need(
      me.user?.id === config.reviewer.userId &&
        me.user.clerkUserId === config.reviewer.clerkUserId &&
        me.tenant?.id === config.reviewer.tenantId &&
        me.role === 'user_admin',
      'CURRENT_IDENTITY',
    );
    await page.goto(`${ORIGIN}/meri/t/${inputs.expected.conversationId}`, {
      waitUntil: 'domcontentloaded',
    });
    await web(page, config.deployment.webSha);
    const response = page.locator('[aria-label="Meri\'s response"]');
    need((await response.count()) <= 1, 'UNIQUE_REPLY');
    await response
      .getByText('Synthetic Aster candidate for approval', { exact: false })
      .waitFor({ state: 'visible', timeout: 15000 });
    const text = await response.innerText();
    need(text.includes(inputs.authority.fixture.approvedText), 'RECALL_VISIBLE');
    screenshot = artifactStorage.writeBytes(
      'case14-recall-ui/reply.png',
      await response.screenshot(),
    );
    need(
      blockedWrites === 0 &&
        sha256Stable(builds.services) ===
          sha256Stable((await readCase17BuildAuthority(config.deployment)).services),
      'RECALL_READ_ONLY',
    );
  } finally {
    if (sessionId && page)
      try {
        await page.evaluate((id) => window.Clerk.signOut({ sessionId: id }), sessionId);
        await page.waitForFunction(
          (id) => !window.Clerk?.client?.sessions?.some((s) => s.id === id),
          sessionId,
          { timeout: 15000 },
        );
        cleaned = true;
      } catch {}
    if (timer) clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
  need(cleaned && screenshot, 'CLEANUP');
  const evidence = {
    kind: 'meri-case14-recall-ui-readonly',
    captureRunId: config.captureRunId,
    conversationId: inputs.expected.conversationId,
    answerSha256: inputs.authority.answerSha256,
    visible: true,
    sessionRevoked: true,
    applicationWrites: 0,
    synthesisSubmissionCount: 0,
    completedAt: Date.now(),
    builds,
    screenshot,
  };
  const descriptor = artifactStorage.writeBytes(
    'case14-recall-ui/evidence.json',
    Buffer.from(stableJson(evidence)),
  );
  const outcome = Object.freeze({
    status: 'RECALL_UI_CAPTURE_COMPLETE',
    caseId: '14',
    captureRunId: config.captureRunId,
    evidence: descriptor,
  });
  recallUiOutcomes.set(outcome, { artifactStorage, descriptor, hash: sha256Stable(outcome) });
  return outcome;
}
export function currentCase14RecallUiAuthority(outcome) {
  const state = recallUiOutcomes.get(outcome);
  need(state && state.hash === sha256Stable(outcome), 'UNTRUSTED_RECALL_UI');
  assertWindowsArtifactStorage(state.artifactStorage, state.artifactStorage.root);
  const bytes = state.artifactStorage.readBytes(state.descriptor.ref);
  need(sha256Bytes(bytes) === state.descriptor.sha256, 'CHANGED_BYTES');
  const evidence = JSON.parse(bytes);
  const png = state.artifactStorage.readBytes(evidence.screenshot.ref);
  need(
    sha256Bytes(png) === evidence.screenshot.sha256 && png.length === evidence.screenshot.bytes,
    'CHANGED_SCREENSHOT',
  );
  return evidence;
}

/** One ordinary owned conversation, after approval. Existing public API retains
 * its visibility/profile checks; native storage's exclusive intent prevents replay.
 * A returned row is setup evidence, not authority to submit a recall turn. */
export async function createCase14RecallConversation({
  approvalOutcome,
  config: input,
  artifactStorage,
  env = process.env,
}) {
  const config = inspectCase14ApprovalScope(input),
    approval = currentCase14ApprovalAuthority(approvalOutcome);
  need(
    approval.captureRunId === config.captureRunId &&
      approval.reviewer.userId === config.reviewer.userId,
    'CONVERSATION_SCOPE',
  );
  assertWindowsArtifactStorage(artifactStorage, artifactStorage.root);
  const bearer = env.MERI_LIVE_BEARER_TOKEN?.trim();
  need(typeof bearer === 'string' && bearer.length > 10, 'BEARER');
  const builds = await readCase17BuildAuthority(config.deployment);
  const deadline = Date.now() + 60000;
  const me = await nativeRead(config, bearer, deadline, approval.after.candidateId)('/api/me');
  need(
    me.user?.id === config.reviewer.userId &&
      me.user.clerkUserId === config.reviewer.clerkUserId &&
      me.tenant?.id === config.reviewer.tenantId &&
      me.role === 'user_admin',
    'CURRENT_IDENTITY',
  );
  const title = `${FIXTURE_NAMESPACE} case14 ${config.captureRunId}`,
    clientId = approval.after.fixtureEvidence.clientId;
  artifactStorage.writeBytes(
    'case14-conversation/intent.json',
    Buffer.from(
      stableJson({
        captureRunId: config.captureRunId,
        actorUserId: config.reviewer.userId,
        clientId,
        title,
        maximumSubmissions: 1,
      }),
    ),
  );
  need(Date.now() - builds.observedAt < 60000 && Date.now() < deadline, 'PRESUBMIT_FRESHNESS');
  const value = await new Promise((resolve, reject) => {
    const req = https.request(
      ORIGIN + '/api/clio/conversations',
      {
        method: 'POST',
        rejectUnauthorized: true,
        timeout: 15000,
        headers: {
          ...nativeMeriCaptureHeaders(bearer, config.reviewer.tenantSlug),
          'content-type': 'application/json',
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 262144) req.destroy();
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('CASE14_APPROVAL_CONVERSATION_UNCERTAIN')));
        response.on('end', () => {
          try {
            need(
              response.statusCode >= 200 &&
                response.statusCode < 300 &&
                response.headers['x-capiro-release-sha'] === config.deployment.apiSha,
              'CONVERSATION_ACK',
            );
            const text = Buffer.concat(chunks).toString();
            need(!text.includes(bearer), 'PRIVATE_RESPONSE');
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('CASE14_APPROVAL_CONVERSATION_UNCERTAIN'));
          }
        });
      },
    );
    req.on('error', () => reject(new Error('CASE14_APPROVAL_CONVERSATION_UNCERTAIN')));
    req.on('timeout', () => req.destroy());
    req.end(JSON.stringify({ clientId, title }));
  });
  need(
    UUID.test(value.id ?? '') &&
      value.tenantId === config.reviewer.tenantId &&
      value.userId === config.reviewer.userId &&
      value.clientId === clientId &&
      value.title === title &&
      !value.archivedAt,
    'CONVERSATION_ROW',
  );
  const receipt = {
    kind: 'meri-case14-conversation-created',
    captureRunId: config.captureRunId,
    conversationId: value.id,
    tenantId: value.tenantId,
    actorUserId: value.userId,
    clientId,
    title,
    applicationCreates: 1,
    synthesisSubmissionCount: 0,
  };
  artifactStorage.writeBytes(
    'case14-conversation/acknowledgement.json',
    Buffer.from(stableJson(receipt)),
  );
  // prepareCase14RecallCapture independently GETs current policy/admission and
  // execute re-reads an empty message list immediately before the one turn.
  return receipt;
}
export function currentCase14ApprovalAuthority(outcome) {
  const saved = outcomes.get(outcome);
  need(saved && sha256Stable(outcome) === saved.outcomeHash, 'UNTRUSTED_CAPTURE');
  assertWindowsArtifactStorage(saved.storage, saved.storage.root);
  const bytes = saved.storage.readBytes(saved.descriptor.ref);
  need(sha256Bytes(bytes) === saved.sha256, 'CHANGED_BYTES');
  const evidence = JSON.parse(bytes);
  inspectCase14ApprovalEvidence(evidence);
  for (const descriptor of evidence.screenshots) {
    const bytes = saved.storage.readBytes(descriptor.ref);
    need(
      bytes.length === descriptor.bytes &&
        sha256Bytes(bytes) === descriptor.sha256 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      'CHANGED_SCREENSHOT',
    );
  }
  return evidence;
}
