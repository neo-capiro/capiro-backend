#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import https from 'node:https';
import { readCase01BuildAuthority } from './case01-build-authority.mjs';
import {
  prepareControlledReadLiveCapture,
  executeControlledReadLiveCapture,
  inspectControlledReadScope,
} from './controlled-read-live-capture.mjs';
import { gradeControlledReadCapturedOutcome } from './grade-controlled-read-capture.mjs';
import { createWindowsArtifactStorage } from './windows-artifact-storage.mjs';
import { openCaptureSpendAggregate } from './capture-spend-aggregate.mjs';
import {
  controlledReadSetupInput,
  inspectControlledReadSetupReceipt,
} from './controlled-read-operator-input.mjs';

const origin = 'https://os.capiro.ai',
  clerkOrigin = 'https://clerk.app.capiro.ai';
const namespace = 'meri-foundation-20260928';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const need = (value, code) => {
  if (!value) {
    const error = new Error(code);
    error.safeCode = code;
    throw error;
  }
};
const read = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));

export function inspectControlledConversationReadback({ config, created, current, messages }) {
  const actor = config.scope.actors.PAT,
    tenant = config.scope.tenants.T1;
  const title = `${namespace} case${config.caseId} ${config.captureRunId}`;
  for (const row of [created, current])
    need(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        row?.id ?? '',
      ) &&
        row.tenantId === tenant.physicalId &&
        row.userId === actor.userId &&
        row.clientId === config.scope.clients.ASTER.physicalId &&
        row.title === title &&
        row.archivedAt === null &&
        !row.metadata?.serverCaptureProviderBudget,
      'CREATED_CONVERSATION_SCOPE_MISMATCH',
    );
  need(
    created.id === current.id && Array.isArray(messages) && messages.length === 0,
    'CREATED_CONVERSATION_NOT_EMPTY',
  );
  return created.id;
}
function creationTransport(config, bearer) {
  let posts = 0,
    reads = 0;
  const call = (path, body) => {
    const post = body !== undefined;
    need(
      post
        ? path === '/api/clio/conversations' && ++posts === 1
        : ++reads <= 4 &&
            (['/api/me', '/api/clio/status'].includes(path) ||
              /^\/api\/clio\/conversations\/[a-f0-9-]{36}(?:\/messages)?$/u.test(path)),
      'CREATION_REQUEST_BOUND',
    );
    return new Promise((resolveResponse, reject) => {
      const request = https.request(
        new URL(path, origin),
        {
          method: post ? 'POST' : 'GET',
          rejectUnauthorized: true,
          headers: {
            'user-agent': 'Capiro-Meri-Authorized-QA/1.0',
            authorization: `Bearer ${bearer}`,
            'x-capiro-tenant': config.scope.tenants.T1.slug,
            accept: 'application/json',
            ...(post ? { 'content-type': 'application/json' } : {}),
          },
        },
        (response) => {
          const chunks = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) request.destroy(new Error('CREATION_RESPONSE_TOO_LARGE'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            clearTimeout(timer);
            try {
              need(response.statusCode === (post ? 201 : 200), 'CREATION_HTTP_FAILED');
              const sourceSha = response.headers['x-capiro-release-sha'];
              // Canonical header is checked below against the deployed API source.
              resolveResponse({
                value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                sourceSha,
                headers: response.headers,
                status: response.statusCode,
              });
            } catch {
              reject(new Error('CREATION_RESPONSE_REJECTED'));
            }
          });
        },
      );
      const timer = setTimeout(() => request.destroy(new Error('CREATION_DEADLINE')), 30000);
      request.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      if (post) request.write(JSON.stringify(body));
      request.end();
    });
  };
  return { call };
}

export function controlledReadBrowserRequestAllowed({ url, method, topNavigation }) {
  try {
    const target = new URL(url);
    return (
      target.protocol === 'https:' &&
      !target.username &&
      !target.password &&
      (!topNavigation || target.origin === origin) &&
      (['GET', 'HEAD', 'OPTIONS'].includes(method) || target.origin === clerkOrigin)
    );
  } catch {
    return false;
  }
}
export function assertControlledReadSyntheticIdentity({
  manifest,
  config,
  instance,
  user,
  organization,
  memberships,
}) {
  const input = controlledReadSetupInput(manifest, {
    caseId: config.caseId,
    captureRunId: config.captureRunId,
    clientId: config.scope.clients.ASTER.physicalId,
  });
  need(
    isDeepStrictEqual(config.scope.actors.PAT, {
      userId: input.ctx.userId,
      clerkUserId: input.ctx.clerkUserId,
      role: 'standard_user',
      tenantPhysicalId: input.ctx.tenantId,
    }) && config.scope.tenants.T1.physicalId === input.ctx.tenantId,
    'SYNTHETIC_BINDING_MISMATCH',
  );
  const actor = manifest.ids.users.pat,
    tenant = manifest.ids.tenants.t1,
    email = manifest.handles?.users?.pat;
  need(
    typeof manifest.targetBinding?.clerkInstanceId === 'string' &&
      instance?.id === manifest.targetBinding.clerkInstanceId,
    'CLERK_INSTANCE_MISMATCH',
  );
  need(
    user?.id === actor.clerkUserId &&
      user.publicMetadata?.fixtureNamespace === namespace &&
      /synthetic/iu.test([user.firstName, user.lastName].join(' ')) &&
      typeof email === 'string' &&
      email.includes(namespace) &&
      email.endsWith('@example.com') &&
      user.emailAddresses?.some((row) => row.emailAddress === email),
    'SYNTHETIC_USER_MISMATCH',
  );
  need(
    organization?.id === tenant.clerkOrgId &&
      organization.slug === namespace + '-t1' &&
      organization.publicMetadata?.fixtureNamespace === namespace,
    'SYNTHETIC_ORG_MISMATCH',
  );
  need(
    memberships?.totalCount === 1 &&
      memberships.data?.length === 1 &&
      memberships.data[0].organization?.id === tenant.clerkOrgId &&
      memberships.data[0].role === 'org:member',
    'ORDINARY_ACTOR_REQUIRED',
  );
  return { actor, tenant };
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
/** Executable bounded operator, no injected browser/HTTP/provider callbacks.
 * Importing the module does nothing. Only the explicit CLI starts authentication. */
export async function runControlledReadOperator(args = process.argv.slice(2)) {
  let clerk, browser, createdSessionId, summary, output;
  const persist = () => {
    if (summary) writeFileSync(output, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  };
  try {
    const [command, scopeFlag, scopePath, manifestFlag, manifestPath, outFlag, outRoot] = args;
    need(
      args.length === 7 &&
        command === '--execute-original-controlled-read-once' &&
        scopeFlag === '--scope' &&
        manifestFlag === '--manifest' &&
        outFlag === '--out' &&
        [scopePath, manifestPath, outRoot].every(isAbsolute),
      'EXACT_COMMAND_REQUIRED',
    );
    const clerkSecret = process.env.CLERK_SECRET_KEY;
    // Do not pass this operator-only credential to Git, AWS or browser child processes.
    delete process.env.CLERK_SECRET_KEY;
    const {
      config,
      setupReceipt,
      expectedWebSha,
      qualificationExpiresAt,
      operatorSourceSha,
      aggregateCheckpoint,
    } = read(scopePath);
    need(config?.conversationId === null, 'PRECREATED_OR_REPLAY_SCOPE_REJECTED');
    inspectControlledReadScope(
      { ...config, conversationId: config.captureRunId },
      { MERI_LIVE_BEARER_TOKEN: 'static-shape-inspection-only' },
    );
    need(
      /^[a-f0-9]{40}$/u.test(expectedWebSha ?? '') &&
        Date.parse(qualificationExpiresAt) > Date.now() + 900000,
      'CURRENT_RELEASE_AND_RATES_REQUIRED',
    );
    const git = (...values) =>
      execFileSync('git', values, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
    need(git('status', '--porcelain') === '', 'RUNNER_DIRTY');
    need(git('rev-parse', 'HEAD') === operatorSourceSha, 'REVIEWED_OPERATOR_SOURCE_REQUIRED');
    // New operator-only files need not trigger another backend release. Existing
    // server, fixture and pricing source must remain exactly released. The reviewed
    // local-only collector delta adds the descriptive native HTTPS User-Agent.
    git('merge-base', '--is-ancestor', config.deployment.apiSha, 'HEAD');
    const operatorFiles = new Set([
      'controlled-read-operator-input.mjs',
      'materialize-controlled-read.mjs',
      'run-controlled-read.mjs',
      'controlled-read-live-capture.mjs',
      'case01-live-capture.mjs',
      'capture-spend-aggregate.mjs',
      'lib/windows-capture-spend.py',
      'tests/capture-spend-aggregate.test.mjs',
      'CONTROLLED-READ-OPERATOR.md',
      'tests/controlled-read-operator.test.mjs',
    ]);
    need(
      git('diff', '--name-only', config.deployment.apiSha + '..HEAD')
        .split('\n')
        .every(
          (path) =>
            !path ||
            path.startsWith('docs/') ||
            (path.startsWith('evals/meri/live-v1/') &&
              operatorFiles.has(path.slice('evals/meri/live-v1/'.length))),
        ),
      'RUNNER_SOURCE_MISMATCH',
    );
    const manifest = read(manifestPath);
    inspectControlledReadSetupReceipt(
      controlledReadSetupInput(manifest, {
        caseId: config.caseId,
        clientId: config.scope.clients.ASTER.physicalId,
        captureRunId: config.captureRunId,
      }),
      setupReceipt,
    );
    need(process.platform === 'win32' && clerkSecret, 'PRIVATE_CLERK_INPUT_REQUIRED');
    // Exclusive run directory before any external auth action; never overwrite or resume.
    mkdirSync(outRoot);
    const claims = 'C:/dev/cap-meri-foundation-evidence/controlled-read-claims';
    mkdirSync(claims, { recursive: true });
    writeFileSync(
      join(claims, `${config.caseId}-${config.captureRunId}.json`),
      JSON.stringify({
        kind: 'meri-controlled-read-one-shot-claim',
        captureRunId: config.captureRunId,
        caseId: config.caseId,
        operatorSourceSha,
        outRoot: resolve(outRoot),
        createdAt: new Date().toISOString(),
      }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    output = join(outRoot, 'execution.json');
    summary = {
      schemaVersion: 1,
      caseId: config.caseId,
      captureRunId: config.captureRunId,
      conversationId: config.conversationId,
      sourceSha: config.deployment.apiSha,
      expectedWebSha,
      scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
      startedAt: new Date().toISOString(),
      verdict: 'NOT_RUN',
      maximumNewTurns: 1,
      browserApplicationWrites: 0,
      conversationCreationAttempted: false,
      sessionCreated: false,
      sessionRevoked: false,
      fullFile01Acceptance: false,
    };
    persist();
    const spendOwner = openCaptureSpendAggregate(aggregateCheckpoint, {
      pythonExecutable: 'C:/ProgramData/Hermes/tools/python-3.14.7+20260901-win32-x64/python.exe',
    });
    const spendReservation = spendOwner.reserve({
      caseId: config.caseId,
      captureRunId: config.captureRunId,
      ceilingMicros: config.limits.maxSpendUsd * 1000000,
    });
    const saveSpendCheckpoint = (name) => {
      const file = join(outRoot, name);
      writeFileSync(file, JSON.stringify(spendOwner.checkpoint(), null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      const fd = openSync(file, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    // The reservation and its resumable identity checkpoint are durable before
    // auth, conversation creation or any provider submission. No automatic refund.
    saveSpendCheckpoint('aggregate-reserved-checkpoint.json');
    const { createClerkClient } = require('@clerk/backend');
    const { chromium } = require('C:/dev/node_modules/playwright');
    clerk = createClerkClient({ secretKey: clerkSecret });
    const actor = manifest.ids.users.pat,
      tenant = manifest.ids.tenants.t1;
    assertControlledReadSyntheticIdentity({
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
    let bearer = await page.evaluate(() => window.Clerk.session.getToken({ template: 'capiro' }));
    need(typeof bearer === 'string' && bearer.length > 0, 'CAPTURE_BEARER_UNAVAILABLE');
    const builds = await readCase01BuildAuthority(config.deployment);
    const transport = creationTransport(config, bearer);
    const me = (await transport.call('/api/me')).value;
    const status = await transport.call('/api/clio/status');
    need(
      me.tenant?.id === config.scope.tenants.T1.physicalId &&
        me.tenant.slug === config.scope.tenants.T1.slug &&
        me.user?.id === actor.userId &&
        me.user.clerkUserId === actor.clerkUserId &&
        me.role === 'standard_user' &&
        me.features?.meriv3Chat === true,
      'CURRENT_ACTOR_MISMATCH',
    );
    need(
      status.value.configured === true &&
        status.value.healthy === true &&
        status.sourceSha === config.deployment.apiSha &&
        Date.now() - builds.observedAt <= 60000,
      'CURRENT_API_BUILD_MISMATCH',
    );
    const title = `${namespace} case${config.caseId} ${config.captureRunId}`;
    // Persist intent before the sole POST. An ambiguous acknowledgement is
    // reconciliation-required; neither this process nor a rerun retries it.
    summary.conversationCreationAttempted = true;
    summary.creationIntent = {
      clientId: config.scope.clients.ASTER.physicalId,
      title,
      createdAt: new Date().toISOString(),
      retryAllowed: false,
    };
    persist();
    const created = (
      await transport.call('/api/clio/conversations', {
        clientId: config.scope.clients.ASTER.physicalId,
        title,
      })
    ).value;
    need(/^[a-f0-9-]{36}$/u.test(created?.id ?? ''), 'CREATED_ID_MISSING');
    summary.conversationId = created.id;
    persist();
    const current = (await transport.call(`/api/clio/conversations/${created.id}`)).value;
    const messages = (await transport.call(`/api/clio/conversations/${created.id}/messages`)).value;
    config.conversationId = inspectControlledConversationReadback({
      config,
      created,
      current,
      messages,
    });
    summary.conversationReadback = {
      status: 'EMPTY_OWNED_CONVERSATION_CREATED',
      createdSha256: hash(JSON.stringify(created)),
      currentSha256: hash(JSON.stringify(current)),
      messagesSha256: hash(JSON.stringify(messages)),
      observedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(outRoot, 'actual-capture-scope.json'),
      JSON.stringify(config, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    persist();
    await page.goto(origin + '/meri/t/' + config.conversationId, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await verifyWeb(page, expectedWebSha);
    need(!routeFailure, routeFailure);
    bearer = await page.evaluate(() =>
      window.Clerk.session.getToken({ template: 'capiro', skipCache: true }),
    );
    need(typeof bearer === 'string' && bearer.length > 0, 'CAPTURE_BEARER_UNAVAILABLE');
    const runRoot = join(outRoot, 'artifacts');
    const storage = createWindowsArtifactStorage(runRoot, {
      pythonExecutable: 'C:/ProgramData/Hermes/tools/python-3.14.7+20260901-win32-x64/python.exe',
    });
    const capability = await prepareControlledReadLiveCapture({
      config,
      runRoot,
      artifactStorage: storage,
      spendReservation,
      env: { MERI_LIVE_BEARER_TOKEN: bearer },
    });
    summary.capturePrepared = true;
    persist();
    const outcome = await executeControlledReadLiveCapture(capability);
    saveSpendCheckpoint('aggregate-final-checkpoint.json');
    summary.outcome = outcome;
    persist();
    need(
      outcome.status === 'CAPTURE_COMPLETE' && outcome.synthesisSubmissionCount === 1,
      'CAPTURE_NOT_COMPLETE',
    );
    summary.grading = gradeControlledReadCapturedOutcome(outcome);
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
      summary.failureCode = error.safeCode || 'CONTROLLED_READ_OPERATOR_FAILED';
    } else
      console.error(
        JSON.stringify({
          verdict: 'BLOCKED',
          code: error.safeCode || 'CONTROLLED_READ_OPERATOR_FAILED',
        }),
      );
  } finally {
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
      persist();
      console.log(
        JSON.stringify({
          verdict: summary.verdict,
          caseId: summary.caseId,
          turnsSent: summary.outcome?.synthesisSubmissionCount ?? 0,
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
  process.exitCode = await runControlledReadOperator();
