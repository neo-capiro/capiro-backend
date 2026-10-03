#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import https from 'node:https';
import { readCase01BuildAuthority } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/case01-build-authority.mjs';
import {
  prepareCase01LiveCapture,
  executeCase01LiveCapture,
  inspectCase01Scope,
} from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/case01-live-capture.mjs';
import { gradeCase01CapturedOutcome } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/grade-case01-capture.mjs';
import { createWindowsArtifactStorage } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/windows-artifact-storage.mjs';
import { adoptExistingFreshCaptureSpend, openCaptureSpendAggregate } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/capture-spend-aggregate.mjs';
import { inspectControlledConversationReadback, controlledReadBrowserRequestAllowed } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/run-controlled-read.mjs';
import { sha256Stable } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/artifact-collector.mjs';
import { frozenFixture } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/fixture.mjs';

const origin = 'https://os.capiro.ai',
  clerkOrigin = 'https://clerk.app.capiro.ai';
const namespace = 'meri-foundation-20260928';
const repo = 'C:/dev/main/meri-c1-20261002';
const pythonExecutable = 'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';
const require = createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const need = (value, code) => {
  if (!value) {
    const error = new Error(code);
    error.safeCode = code;
    throw error;
  }
};
const read = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));

const fixedApiSource = '5b086a6b47ffce5aa1b93bfe38f9c7b96e297642';
const fixedRun = 'bd35c0f4-1604-4371-b7e9-a1338369e53f';
const fixedClient = '41f9ec63-3963-479f-b747-59a3767ef44b';
const fixedContext = Object.freeze({ tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
  userId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f', clerkUserId: 'user_3Jw2FvWZkYGKmxWGx13tNJxFD2A' });
const fixedOutput = `C:/dev/main/outputs/meri-c2-20261003/case01-native-${fixedRun}`;
const freshPrefix = 'abe458973e6998db20586c781ac5a3cbd4ca2fa565425e62722f0eb9c985210b';
const freshAuthorization = 'e07822e83a7c7b531606519ecd4fdf1027f2fa7cbaefd4bad92a2084590262fe';
const rateBytesHash = '3531e09dfcce9f66b4ea2b3564db47bd72dc507cdcf1aecdda277b838007704e';
const rateValueHash = 'a1a179383c8451495336169f46025eb8cee8ec95487f1a43017078387b768b11';
const SHA = /^[a-f0-9]{40}$/u, HASH = /^[a-f0-9]{64}$/u;
function safeFailure(error) {
  const code = error?.safeCode ?? error?.code ?? error?.message ?? '';
  return /^(?:CASE01_|CAPTURE_SPEND_)[A-Z0-9_]+$/u.test(code) || error?.safeCode
    ? code : 'CASE01_OPERATOR_FAILED';
}
function writeExclusive(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
}
/** Saved setup is a scope cross-check only. Native admission and live canonical
 * authority still decide whether dispatch is allowed; no input creates capability. */
export function buildCase01Scope(input) {
  need(isDeepStrictEqual(Object.keys(input ?? {}).sort(),
    ['deployment', 'expectedWebSha', 'manifestSha256', 'operatorSourceSha', 'setupReceiptPath', 'setupReceiptSha256']),
    'CASE01_EXACT_INPUT_REQUIRED');
  need(SHA.test(input.operatorSourceSha ?? '') && SHA.test(input.expectedWebSha ?? '') &&
    HASH.test(input.manifestSha256 ?? '') && HASH.test(input.setupReceiptSha256 ?? '') &&
    isAbsolute(input.setupReceiptPath ?? ''), 'CASE01_PREPARED_INPUT_REQUIRED');
  const wire = readFileSync(input.setupReceiptPath);
  need(hash(wire) === input.setupReceiptSha256 && wire.at(-1) === 10, 'CASE01_SETUP_BYTES_CHANGED');
  const events = wire.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  need(events.length === 6 && events.every((event, index) => event.sequence === index + 1) &&
    isDeepStrictEqual(events.map(e => [e.stage, e.phase]), [
      ['VALIDATING', 'START'], ['BIND_DISPATCHING', 'INTENT'], ['BOUND', 'VERIFIED'],
      ['BUDGET_INSTALL_DISPATCHING', 'INTENT'], ['BUDGET_INSTALLED', 'VERIFIED'], ['COMPLETE', 'RESULT']
    ]) && events[0].mode === 'execute' && events[0].sourceSha === fixedApiSource &&
    events[0].captureRunId === fixedRun && events[0].rateBytesSha256 === rateBytesHash,
    'CASE01_SETUP_SEQUENCE_INVALID');
  const setup = events.at(-1), b = setup.bound?.binding, f = setup.fixture;
  const ratesBytes = readFileSync(new URL('../case01-native-setup-v1/case01-reviewed-rates-v2.json', import.meta.url));
  need(hash(ratesBytes) === rateBytesHash, 'CASE01_RATE_BYTES_CHANGED');
  const rates = JSON.parse(ratesBytes.toString('utf8'));
  need(sha256Stable(rates) === rateValueHash && Date.parse(rates.expiresAt) > Date.now() + 1800000,
    'CASE01_RATE_QUALIFICATION_EXPIRED');
  const q = { version: 1, caseId: '01', captureRunId: fixedRun, currentVerifySha256: f?.currentVerifySha256,
    rateEvidenceSha256: rateValueHash, rateEvidenceExpiresAt: rates.expiresAt,
    priceKind: 'qualified_text_token_upper_bound', maxAttempts: 32, maxTokens: 500000,
    maxCostMicros: 15000000, rates: rates.rates };
  need(setup.status === 'BOUND_AND_BUDGET_READ_BACK' && setup.liveAcceptance === 'NOT_RUN' &&
    setup.journalOpened === false && setup.providerCalls === 0 && setup.conversationCreations === 0 &&
    setup.fixtureLifecycleMutations === 0 && setup.bound?.status === 'BOUND' &&
    setup.installed?.status === 'PROVIDER_QUALIFICATION_INSTALLED' &&
    isDeepStrictEqual(events[2].bound, setup.bound) && isDeepStrictEqual(events[4].installed, setup.installed) &&
    events[1].planSha256 === setup.planSha256 && HASH.test(setup.planSha256 ?? '') &&
    HASH.test(setup.protectedSettingsSha256 ?? '') &&
    b?.caseId === '01' && b.captureRunId === fixedRun && b.actorUserId === fixedContext.userId &&
    b.clientId === fixedClient && b.fixtureNamespace === namespace && b.fixtureVersion === frozenFixture.version &&
    setup.bound.tenantId === fixedContext.tenantId && setup.bound.fixtureReady === true &&
    setup.bound.bindingSha256 === sha256Stable(b) &&
    f?.physicalMapSha256 === sha256Stable(f.sourceMap) &&
    ['fixtureVersion', 'physicalMapSha256', 'seedReceiptId', 'resetReceiptId', 'currentVerifySha256'].every(k => f[k] === b[k]) &&
    setup.installed.tenantId === fixedContext.tenantId && setup.installed.clientId === fixedClient &&
    setup.installed.captureRunId === fixedRun && setup.installed.currentVerifySha256 === b.currentVerifySha256 &&
    setup.installed.captureBindingSha256 === setup.bound.bindingSha256 &&
    setup.installed.rateEvidenceSha256 === rateValueHash && setup.installed.rateEvidenceExpiresAt === rates.expiresAt &&
    setup.installed.maxCostMicros === 15000000 && setup.installed.qualificationSha256 === sha256Stable(q) &&
    events[3].qualificationSha256 === sha256Stable(q) &&
    setup.readback?.status === 'READY_FOR_RATE_QUALIFICATION' && setup.readback.caseId === '01' &&
    setup.readback.captureRunId === fixedRun && setup.readback.currentVerifySha256 === b.currentVerifySha256 &&
    setup.readback.captureBindingSha256 === setup.bound.bindingSha256 &&
    setup.readback.priorQualificationSha256 === sha256Stable(q) &&
    setup.readback.tenantRowVersion === setup.installed.tenantRowVersion,
    'CASE01_SETUP_JOIN_REJECTED');
  const lock = read(join(repo, 'evals/meri/live-v1/contract-lock.json'));
  const config = {
    schemaVersion: 1, provenance: 'LIVE_CAPTURE', caseId: '01',
    target: { apiOrigin: origin, environment: 'capiro-dev' },
    limits: { concurrency: 1, deadlineMs: 900000, maxSpendUsd: 15 },
    contract: lock, captureRunId: fixedRun, conversationId: null, deployment: input.deployment,
    scope: {
      actors: { PAT: { ...fixedContext, role: 'standard_user', tenantPhysicalId: fixedContext.tenantId } },
      tenants: { T1: { physicalId: fixedContext.tenantId, slug: namespace + '-t1' } },
      clients: { ASTER: { physicalId: fixedClient, tenantPhysicalId: fixedContext.tenantId } },
      sources: f.sourceMap,
    },
    fixture: { namespace, version: f.fixtureVersion, sha256: lock.fixtureSha256,
      mappingSha256: f.physicalMapSha256, seedReceiptId: f.seedReceiptId, resetReceiptId: f.resetReceiptId },
  };
  delete config.scope.actors.PAT.tenantId;
  need(config.deployment?.apiSha === fixedApiSource && SHA.test(config.deployment.orchestratorSha ?? ''),
    'CASE01_DEPLOYMENT_INPUT_REQUIRED');
  need(isDeepStrictEqual(Object.keys(config.deployment.builds ?? {}).sort(), ['api', 'meriv2-orchestrator']),
    'CASE01_BOTH_IMMUTABLE_BUILDS_REQUIRED');
  for (const service of ['api', 'meriv2-orchestrator']) {
    const build = config.deployment.builds[service];
    need(build.service === service && build.sourceSha === config.deployment[service === 'api' ? 'apiSha' : 'orchestratorSha'] &&
      /^sha256:[a-f0-9]{64}$/u.test(build.imageDigest ?? '') && HASH.test(build.buildspecSha256 ?? '') &&
      /^capiro-build-[a-z0-9-]+:[a-f0-9-]{36}$/u.test(build.buildId ?? ''), 'CASE01_BUILD_INPUT_INCOMPLETE');
  }
  return { config, expectedWebSha: input.expectedWebSha, operatorSourceSha: input.operatorSourceSha,
    qualificationExpiresAt: rates.expiresAt, setupProof: { setupReceiptSha256: input.setupReceiptSha256,
      planSha256: setup.planSha256, currentVerifySha256: b.currentVerifySha256,
      bindingSha256: setup.bound.bindingSha256, qualificationSha256: setup.installed.qualificationSha256 } };
}

function creationTransport(config, bearer, observe) {
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
              const raw = Buffer.concat(chunks);
              // Save actual response identity/status before rejecting HTTP or JSON.
              observe({ method: post ? 'POST' : 'GET', path, status: response.statusCode,
                sourceSha: response.headers['x-capiro-release-sha'] ?? null,
                bytes: raw.length, bodySha256: hash(raw), observedAt: new Date().toISOString() });
              need(response.statusCode === (post ? 201 : 200), 'CREATION_HTTP_FAILED');
              const sourceSha = response.headers['x-capiro-release-sha'];
              // Canonical header is checked below against the deployed API source.
              resolveResponse({
                value: JSON.parse(raw.toString('utf8')),
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

export function assertCase01SyntheticIdentity({
  manifest,
  config,
  instance,
  user,
  organization,
  memberships,
}) {
  const input = { ctx: fixedContext };
  need(manifest?.namespace === namespace && manifest.target === 'capiro-dev' &&
    manifest.status === 'ready' && manifest.ids?.tenants?.t1?.tenantId === fixedContext.tenantId &&
    manifest.ids?.users?.pat?.userId === fixedContext.userId &&
    manifest.ids?.users?.pat?.clerkUserId === fixedContext.clerkUserId &&
    config.caseId === '01' && config.captureRunId === fixedRun &&
    config.scope.clients.ASTER.physicalId === fixedClient, 'CASE01_MANIFEST_SCOPE_MISMATCH');
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
export async function runCase01Operator(args = process.argv.slice(2)) {
  let clerk, browser, createdSessionId, summary, output, eventPath, sequence = 0;
  const persist = () => {
    if (!summary) return;
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
    const [command, scopeFlag, scopePath, manifestFlag, manifestPath, outFlag, outRoot] = args;
    need(
      args.length === 7 &&
        command === '--execute-original-case01-once' &&
        scopeFlag === '--scope' &&
        manifestFlag === '--manifest' &&
        outFlag === '--out' &&
        [scopePath, manifestPath, outRoot].every(isAbsolute),
      'EXACT_COMMAND_REQUIRED',
    );
    const clerkSecret = process.env.CLERK_SECRET_KEY;
    // Do not pass this operator-only credential to Git, AWS or browser child processes.
    delete process.env.CLERK_SECRET_KEY;
    const scopeBytes = readFileSync(scopePath);
    const input = JSON.parse(scopeBytes.toString('utf8').replace(/^\uFEFF/u, ''));
    const { config, expectedWebSha, qualificationExpiresAt, operatorSourceSha, setupProof } = buildCase01Scope(input);
    need(resolve(outRoot) === resolve(fixedOutput), 'EXACT_OWNED_OUTPUT_REQUIRED');
    need(hash(readFileSync(manifestPath)) === input.manifestSha256, 'MANIFEST_BYTES_CHANGED');
    need(config?.conversationId === null, 'PRECREATED_OR_REPLAY_SCOPE_REJECTED');
    inspectCase01Scope(
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
    // API source remains fixed. The only later orchestrator delta permitted by
    // this preparation is the known test fixture correction, plus documentation.
    need(config.deployment.apiSha === fixedApiSource, 'API_SOURCE_CHANGED');
    git('merge-base', '--is-ancestor', fixedApiSource, 'HEAD');
    git('merge-base', '--is-ancestor', config.deployment.orchestratorSha, 'HEAD');
    need(git('diff', '--name-only', fixedApiSource + '..HEAD').split('\n').every(path =>
      !path || path.startsWith('docs/') ||
      path === 'apps/meriv2-orchestrator/src/meri/meriv3/meriv3-governed-artifact-dispatch.spec.ts'),
      'RUNNER_SOURCE_MISMATCH');
    const manifest = read(manifestPath);
    need(process.platform === 'win32' && clerkSecret, 'PRIVATE_CLERK_INPUT_REQUIRED');
    // Exclusive run directory before any external auth action; never overwrite or resume.
    mkdirSync(outRoot);
    const claims = 'C:/dev/cap-meri-foundation-evidence/controlled-read-claims';
    mkdirSync(claims, { recursive: true });
    writeFileSync(
      join(claims, `${config.caseId}-${config.captureRunId}.json`),
      JSON.stringify({
        kind: 'meri-native-case01-one-shot-claim',
        captureRunId: config.captureRunId,
        caseId: config.caseId,
        operatorSourceSha,
        outRoot: resolve(outRoot),
        createdAt: new Date().toISOString(),
      }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    const claimFd = openSync(join(claims, `${config.caseId}-${config.captureRunId}.json`), 'r+');
    try { fsyncSync(claimFd); } finally { closeSync(claimFd); }
    output = join(outRoot, 'execution.json');
    eventPath = join(outRoot, 'execution-events.jsonl');
    summary = {
      schemaVersion: 1,
      caseId: config.caseId,
      captureRunId: config.captureRunId,
      conversationId: config.conversationId,
      sourceSha: config.deployment.apiSha,
      orchestratorSha: config.deployment.orchestratorSha,
      scopeFileSha256: hash(scopeBytes),
      manifestSha256: input.manifestSha256,
      setupProof,
      creationHttpObservations: [],
      automaticPaidRetryAllowed: false,
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
    const aggregateCheckpoint = adoptExistingFreshCaptureSpend({ pythonExecutable });
    need(aggregateCheckpoint.kind === 'meri-fresh-capture-spend-checkpoint' &&
      aggregateCheckpoint.snapshot.eventCount === 20 && aggregateCheckpoint.snapshot.activeRun === null &&
      aggregateCheckpoint.snapshot.knownSettledCostMicros === 9841281 &&
      aggregateCheckpoint.snapshot.remainingReservationMicros === 20158719 &&
      aggregateCheckpoint.snapshot.historicalPrefixSha256 === freshPrefix &&
      aggregateCheckpoint.state.files['fresh-spend.jsonl'].sha256 === freshPrefix &&
      aggregateCheckpoint.state.files['run-authorization.json'].sha256 === freshAuthorization,
      'FRESH_HISTORY_CHANGED');
    writeExclusive(join(outRoot, 'aggregate-adopted-checkpoint.json'), aggregateCheckpoint);
    summary.reservationIntent = { caseId: '01', captureRunId: fixedRun, ceilingMicros: 15000000,
      aggregateLimitMicros: 30000000, concurrency: 1, retryAllowed: false };
    persist();
    const spendOwner = openCaptureSpendAggregate(aggregateCheckpoint, {
      pythonExecutable,
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
    let bearer = await page.evaluate(() => window.Clerk.session.getToken({ template: 'capiro' }));
    need(typeof bearer === 'string' && bearer.length > 0, 'CAPTURE_BEARER_UNAVAILABLE');
    const builds = await readCase01BuildAuthority(config.deployment);
    const transport = creationTransport(config, bearer, observation => {
      summary.creationHttpObservations.push(observation);
      persist();
    });
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
    // execute itself rechecks the exact admission fixture/providerBudget again.

    const outcome = await executeCase01LiveCapture(capability);
    summary.outcome = outcome;
    persist(); // Preserve failed/uncertain native result before checkpoints/assertions.
    saveSpendCheckpoint('aggregate-final-checkpoint.json');
    need(
      outcome.status === 'CAPTURE_COMPLETE' && outcome.synthesisSubmissionCount === 1,
      'CAPTURE_NOT_COMPLETE',
    );
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
  process.exitCode = await runCase01Operator();
