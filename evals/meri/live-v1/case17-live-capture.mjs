import https from 'node:https';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { collectCase17MemoryUi } from './case17-memory-ui.mjs';
import { inspectCase17SavedEvidence } from './case17-saved-checks.mjs';
import { readCase17BuildAuthority } from './case17-build-authority.mjs';
import { assertWindowsArtifactStorage } from './windows-artifact-storage.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from './fixture-provisioning/contract.mjs';
import { sha256Stable, stableJson } from './lib/stable.mjs';

const ORIGIN = 'https://os.capiro.ai',
  CLERK = 'https://clerk.app.capiro.ai';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u,
  SHA = /^[a-f0-9]{40}$/u;
const outcomes = new WeakMap();
const need = (ok, code) => {
  if (!ok) throw new Error(`CASE17_LIVE_${code}`);
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Pure scope validation is never capture authority. */
export function inspectCase17Scope(config) {
  const r = config?.recipe;
  need(
    config?.schemaVersion === 1 &&
      config.caseId === '17' &&
      config.target === ORIGIN &&
      UUID.test(config.captureRunId ?? ''),
    'SCOPE',
  );
  need(
    r?.schemaVersion === 1 &&
      r.caseId === '17' &&
      r.target === 'capiro-dev' &&
      r.fixtureNamespace === FIXTURE_NAMESPACE &&
      UUID.test(r.fixtureInstanceId ?? ''),
    'RECIPE',
  );
  need(
    r.ctx?.tenantId === AUTHORIZED_TENANTS.T1.id &&
      r.ctx.tenantSlug === AUTHORIZED_TENANTS.T1.slug &&
      r.ctx.role === 'user_admin' &&
      UUID.test(r.ctx.userId ?? '') &&
      /^user_[A-Za-z0-9]+$/u.test(r.clerkUserId ?? ''),
    'ACTOR',
  );
  need(
    r.actors?.PRIYA?.physicalId === r.ctx.userId &&
      r.actors.PRIYA.tenantId === 'T1' &&
      /^org_[A-Za-z0-9]+$/u.test(config.clerkOrganizationId ?? ''),
    'PROPOSER',
  );
  need(
    SHA.test(config.deployment?.apiSha ?? '') &&
      SHA.test(config.deployment?.webSha ?? '') &&
      config.limits?.concurrency === 1 &&
      config.limits.maxSynthesisSubmissions === 0 &&
      config.limits.maxApplicationWrites === 0,
    'LIMITS',
  );
  return structuredClone(config);
}

/** Fixed native HTTPS only. No injectable transport, origin, method or response. */
function nativeReads(config, bearer, deadline) {
  let reads = 0;
  return async (path) => {
    need(Date.now() < deadline && ++reads <= 30, 'READ_BOUND');
    need(
      path === '/api/me' ||
        /^\/api\/memory\/proposals\?limit=50(?:&cursor=[A-Za-z0-9%_-]+)?$/u.test(path),
      'READ_ROUTE',
    );
    return new Promise((resolve, reject) => {
      const request = https.request(
        new URL(path, ORIGIN),
        {
          method: 'GET',
          rejectUnauthorized: true,
          timeout: Math.min(15000, deadline - Date.now()),
          headers: {
            'User-Agent': 'Capiro-Meri-Authorized-QA/1.0',
            Authorization: `Bearer ${bearer}`,
            'x-capiro-tenant': config.recipe.ctx.tenantSlug,
          },
        },
        (response) => {
          const chunks = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 262144) request.destroy(new Error('CASE17_LIVE_RESPONSE_BOUND'));
            else chunks.push(chunk);
          });
          response.on('error', () => reject(new Error('CASE17_LIVE_READ_FAILED')));
          response.on('end', () => {
            try {
              need(
                response.statusCode === 200 &&
                  response.headers['x-capiro-release-sha'] === config.deployment.apiSha,
                'AUTHENTICATED_READ',
              );
              const text = Buffer.concat(chunks).toString('utf8');
              need(!text.includes(bearer), 'SECRET_IN_RESPONSE');
              resolve({
                status: response.statusCode,
                releaseSha: response.headers['x-capiro-release-sha'],
                bytes,
                value: JSON.parse(text),
              });
            } catch {
              reject(new Error('CASE17_LIVE_READ_INVALID'));
            }
          });
        },
      );
      request.on('timeout', () => request.destroy());
      request.on('error', () => reject(new Error('CASE17_LIVE_READ_FAILED')));
      request.end();
    });
  };
}

async function loadedWeb(page, expected) {
  const actual = await page.evaluate(() => {
    const config = window.__CAPIRO_CONFIG__;
    const match = /^pk_(?:live|test)_([A-Za-z0-9_-]+)$/u.exec(config?.clerkPublishableKey ?? '');
    let clerkHost;
    if (match) {
      try {
        clerkHost = atob(match[1].replace(/-/g, '+').replace(/_/g, '/')).replace(/\$$/u, '');
      } catch {}
    }
    return { releaseSha: config?.releaseSha, surface: config?.webSurface, clerkHost };
  });
  need(
    actual.releaseSha === expected &&
      actual.surface === 'vnext' &&
      actual.clerkHost === 'clerk.app.capiro.ai',
    'WEB_SOURCE',
  );
}

/** Creates its own browser, reads actual authenticated server owner evidence, and
 * stores immutable bytes. Operator callbacks may supply only an ephemeral ticket
 * and receive the new session ID for independent revoke-on-crash cleanup. They
 * never receive the page, native transport or authority capability.
 */
export async function collectCase17LiveCapture({
  config: input,
  artifactStorage,
  createSignInTicket,
  onSessionCreated,
}) {
  const config = inspectCase17Scope(input);
  need(
    typeof createSignInTicket === 'function' && typeof onSessionCreated === 'function',
    'AUTH_OPERATOR_REQUIRED',
  );
  assertWindowsArtifactStorage(artifactStorage, artifactStorage?.root);
  artifactStorage.writeBytes(
    'case17/attempt.json',
    Buffer.from(
      stableJson({
        caseId: '17',
        captureRunId: config.captureRunId,
        scopeSha256: sha256Stable(config),
        status: 'STARTED',
      }),
    ),
  );
  const builds = await readCase17BuildAuthority(config.deployment);
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  let browser,
    page,
    sessionId,
    cleaned = false,
    blockedWrites = 0,
    collected;
  const startedAt = Date.now(),
    deadline = startedAt + 240000;
  let timer;
  try {
    browser = await chromium.launch({ headless: true });
    timer = setTimeout(() => {
      void browser.close().catch(() => {});
    }, 240000);
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1000 },
    });
    page = await context.newPage();
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && url.origin !== CLERK) {
        blockedWrites++;
        return route.abort();
      }
      if (
        request.isNavigationRequest() &&
        url.origin !== ORIGIN &&
        !(request.frame() !== page.mainFrame() && url.origin === CLERK)
      )
        return route.abort();
      return route.continue();
    });
    await page.goto(ORIGIN + '/sign-in', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 45000 });
    await loadedWeb(page, config.deployment.webSha);
    need(Date.now() - builds.observedAt < 1800000, 'BUILD_PROOF_EXPIRED');
    const ticket = await createSignInTicket(config.recipe.clerkUserId);
    need(typeof ticket === 'string' && ticket.length > 10 && ticket.length < 16384, 'TICKET');
    const signed = await page.evaluate(async (token) => {
      const attempt = await window.Clerk.client.signIn.create({
        strategy: 'ticket',
        ticket: token,
      });
      return { complete: attempt.status === 'complete', sessionId: attempt.createdSessionId };
    }, ticket);
    sessionId = signed.sessionId;
    if (sessionId) await onSessionCreated(sessionId);
    need(signed.complete && typeof sessionId === 'string', 'SIGN_IN');
    await page.evaluate((input) => window.Clerk.setActive(input), {
      session: sessionId,
      organization: config.clerkOrganizationId,
    });
    await page.waitForFunction(
      ({ userId, orgId }) =>
        window.Clerk?.user?.id === userId && window.Clerk?.organization?.id === orgId,
      { userId: config.recipe.clerkUserId, orgId: config.clerkOrganizationId },
      { timeout: 15000 },
    );
    const bearer = await page.evaluate(() => window.Clerk.session.getToken({ template: 'capiro' }));
    need(typeof bearer === 'string' && bearer.length > 10, 'BEARER');
    const get = nativeReads(config, bearer, deadline);
    const readCurrentOwner = async () => {
      const result = await get('/api/memory/proposals?limit=50');
      const owner = result.value.fixtureEvidence;
      need(
        owner?.recipeSha256 === sha256Stable(config.recipe) &&
          owner.ctx?.userId === config.recipe.ctx.userId &&
          owner.ctx?.tenantId === config.recipe.ctx.tenantId,
        'CANONICAL_OWNER',
      );
      return owner;
    };
    collected = await collectCase17MemoryUi({
      page,
      recipe: config.recipe,
      readCurrentOwner,
      readApi: get,
      expectedApiSha: config.deployment.apiSha,
      expectedWebSha: config.deployment.webSha,
      artifactStorage,
    });
    await loadedWeb(page, config.deployment.webSha);
    need(blockedWrites === 0 && Date.now() < deadline, 'READ_ONLY_BOUND');
    inspectCase17SavedEvidence(collected.evidence);
    const afterBuilds = await readCase17BuildAuthority(config.deployment);
    need(
      sha256Stable(builds.services) === sha256Stable(afterBuilds.services),
      'DEPLOYMENT_CHANGED',
    );
  } catch (error) {
    throw new Error(
      /^CASE17_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'CASE17_LIVE_CAPTURE_FAILED',
    );
  } finally {
    if (sessionId && page) {
      try {
        await page.evaluate((id) => window.Clerk.signOut({ sessionId: id }), sessionId);
        await page.waitForFunction(
          (id) => !window.Clerk?.client?.sessions?.some((session) => session.id === id),
          sessionId,
          { timeout: 15000 },
        );
        cleaned = true;
      } catch {
        cleaned = false;
      }
    }
    if (timer) clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
  need(cleaned && collected, 'SESSION_CLEANUP_REQUIRED');
  const evidence = {
    kind: 'meri-case17-owned-live-evidence',
    schemaVersion: 1,
    caseId: '17',
    captureRunId: config.captureRunId,
    completedAt: Date.now(),
    builds,
    scopeSha256: sha256Stable(config),
    sessionRevoked: true,
    ...collected.evidence,
  };
  const bytes = Buffer.from(stableJson(evidence)),
    descriptor = artifactStorage.writeBytes('case17/evidence.json', bytes);
  const outcome = Object.freeze({
    caseId: '17',
    captureRunId: config.captureRunId,
    status: 'CAPTURE_COMPLETE',
    evidence: Object.freeze(descriptor),
    synthesisSubmissionCount: 0,
  });
  outcomes.set(outcome, {
    artifactStorage,
    descriptor,
    sha256: hash(bytes),
    outcomeSha256: sha256Stable(outcome),
  });
  currentCase17CaptureAuthority(outcome);
  return outcome;
}

/** Rechecks actual native-owned bytes; copied JSON cannot become authority. */
export function currentCase17CaptureAuthority(outcome) {
  const state = outcomes.get(outcome);
  need(state && sha256Stable(outcome) === state.outcomeSha256, 'UNTRUSTED_CAPTURE');
  assertWindowsArtifactStorage(state.artifactStorage, state.artifactStorage.root);
  const bytes = state.artifactStorage.readBytes(state.descriptor.ref);
  need(
    hash(bytes) === state.sha256 && state.descriptor.sha256 === state.sha256,
    'EVIDENCE_CHANGED',
  );
  const evidence = JSON.parse(bytes);
  inspectCase17SavedEvidence(evidence);
  for (const round of evidence.rounds)
    for (const card of round.cards) {
      const png = state.artifactStorage.readBytes(card.screenshot.ref);
      need(
        png.length === card.screenshot.bytes &&
          hash(png) === card.screenshot.sha256 &&
          png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        'SCREENSHOT_CHANGED',
      );
    }
  return { evidence, descriptor: structuredClone(state.descriptor) };
}
