#!/usr/bin/env node
/**
 * Phase 3 transport/database/auth resilience acceptance.
 *
 * Injects deterministic faults outside product code, proves main/preview
 * classification and recovery, verifies a failed pre-upstream safe write does
 * not duplicate on retry, pauses the disposable database after boot and proves
 * both runtimes recover, and starts isolated shadow processes against an
 * unavailable database and unavailable Clerk issuer to prove both fail closed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPhase3FaultController } from './engagement-phase3-faults.mjs';
import { createPhase3Proxy } from './engagement-phase3-local-proxy.mjs';

const EVIDENCE = required('ENGAGEMENT_PHASE3_EVIDENCE_DIR');
const FIXTURE_FILE = required('ENGAGEMENT_PHASE3_FIXTURE_FILE');
const TOKEN_FILE = required('ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE');
const DB_CONTAINER = required('ENGAGEMENT_PHASE3_DB_CONTAINER');
const MAIN_URL = new URL(process.env.ENGAGEMENT_PHASE3_MAIN_URL ?? 'http://127.0.0.1:4000');
const SHADOW_URL = new URL(
  process.env.ENGAGEMENT_PHASE3_ENGAGEMENT_URL ?? 'http://127.0.0.1:4500',
);
const FAULT_PORT = Number(process.env.ENGAGEMENT_PHASE3_FAULT_PROXY_PORT ?? 4601);
const FAULT_URL = `http://127.0.0.1:${FAULT_PORT}`;
const DOCKER = process.platform === 'win32' ? 'docker.exe' : 'docker';
const MARKER = '[PHASE3_PARITY_FIXTURE] resilience retry';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function headers(token, preview = false) {
  return {
    Authorization: `Bearer ${token}`,
    ...(preview ? { 'X-Capiro-Engagement-Preview': 'v3' } : {}),
  };
}

async function fetchResult(url, init = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // retain malformed text
    }
    return {
      kind: 'http',
      status: response.status,
      service: response.headers.get('x-capiro-service'),
      body,
      text,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      kind: error?.name === 'AbortError' ? 'timeout' : 'transport',
      status: null,
      service: null,
      body: null,
      text: '',
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function requirePreviewIdentity(label, result) {
  if (result.kind === 'http' && result.service !== 'engagement-api') {
    throw new Error(`${label}: preview response missing X-Capiro-Service: engagement-api`);
  }
}

function docker(...args) {
  const result = spawnSync(DOCKER, args, {
    env: process.env,
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${DOCKER} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return String(result.stdout ?? '').trim();
}

async function waitForRecovered(token, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const [main, shadow] = await Promise.all([
      fetchResult(`${MAIN_URL.origin}/api/engagement/meetings`, {
        headers: headers(token),
      }),
      fetchResult(`${SHADOW_URL.origin}/api/engagement/meetings`, {
        headers: headers(token),
      }),
    ]);
    last = { main, shadow };
    if (
      main.kind === 'http' &&
      shadow.kind === 'http' &&
      main.status >= 200 &&
      main.status < 300 &&
      shadow.status >= 200 &&
      shadow.status < 300 &&
      shadow.service === 'engagement-api'
    ) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Engagement runtimes did not recover after DB resume: ${JSON.stringify(last)}`);
}

async function isolatedShadowProbe({ port, token, envOverrides, label }) {
  const child = spawn('node', ['apps/api/dist/engagement-main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CAPIRO_SERVICE_NAME: 'engagement-api',
      ENGAGEMENT_API_PORT: String(port),
      ENGAGEMENT_API_BIND_HOST: '127.0.0.1',
      ENGAGEMENT_PROCESS_MODE: 'shadow',
      ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
      ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
      ENGAGEMENT_CALLBACKS_ENABLED: 'false',
      ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
      ...envOverrides,
    },
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (child.exitCode != null) {
      return {
        result: 'BOOT_FAILED_CLOSED',
        exitCode: child.exitCode,
        outputTail: output.slice(-1200),
      };
    }
    const probe = await fetchResult(
      `http://127.0.0.1:${port}/api/engagement/meetings`,
      { headers: headers(token) },
      5_000,
    );
    if (probe.kind === 'http' && probe.status >= 200 && probe.status < 300) {
      throw new Error(`${label}: isolated shadow returned successful meeting data`);
    }
    if (probe.kind === 'http' && probe.service !== 'engagement-api') {
      throw new Error(`${label}: fail-closed response lost service identity`);
    }
    return { result: 'REQUEST_FAILED_CLOSED', probe, outputTail: output.slice(-1200) };
  } finally {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (child.exitCode == null) child.kill('SIGKILL');
    }
  }
}

async function assertNoCurrentStreamingConsumer() {
  const inventoryPath = path.resolve(
    'apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json',
  );
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const patterns = [
    /\bEventSource\s*\(/,
    /\bReadableStream\b/,
    /\.getReader\s*\(/,
    /text\/event-stream/i,
    /response\.body\b/,
  ];
  const hits = [];
  for (const relative of inventory.consumerFiles ?? []) {
    const source = await readFile(path.resolve(relative), 'utf8');
    const matched = patterns.filter((pattern) => pattern.test(source)).map((pattern) => String(pattern));
    if (matched.length) hits.push({ relative, matched });
  }
  if (hits.length) {
    throw new Error(
      `Current Engagement consumers now contain streaming code; add a real interruption probe: ` +
        JSON.stringify(hits),
    );
  }
  return {
    status: 'NOT_APPLICABLE_NO_CURRENT_ENGAGEMENT_STREAM_CONSUMER',
    inventoryConsumerCount: (inventory.consumerFiles ?? []).length,
    sourceFilesScanned: (inventory.consumerFiles ?? []).length,
    patterns: patterns.map((pattern) => String(pattern)),
  };
}

async function main() {
  const [tokenRaw, fixturesRaw] = await Promise.all([
    readFile(TOKEN_FILE, 'utf8'),
    readFile(FIXTURE_FILE, 'utf8'),
  ]);
  const token = tokenRaw.trim();
  if (token.length < 20) throw new Error('Phase 3 bearer token file is empty or invalid');
  const fixtures = JSON.parse(fixturesRaw);
  const clientId = fixtures.ids?.['client.alpha'];
  if (typeof clientId !== 'string') throw new Error('Phase 3 resilience fixture client is missing');

  const controller = createPhase3FaultController();
  const decisions = [];
  const proxy = createPhase3Proxy({
    port: FAULT_PORT,
    mainPort: Number(MAIN_URL.port),
    engagementPort: Number(SHADOW_URL.port),
    faultController: controller,
    onDecision: (entry) => decisions.push(entry),
  });
  await proxy.listen();

  let databasePaused = false;
  let retryTaskId = '';
  const results = [];
  try {
    // Ordinary status classes must remain ordinary errors in BOTH modes. The
    // preview synthetic response carries the service identity the real runtime
    // would have attached; no generic 503 is relabelled as a shadow denial.
    for (const status of [429, 500, 502, 503, 504]) {
      const pathname = '/api/engagement/meetings';
      controller.arm({
        id: `main-${status}`,
        action: 'respond',
        owner: 'main-api',
        method: 'GET',
        pathname,
        status,
        body: { statusCode: status, code: `ORDINARY_${status}`, message: `ordinary-${status}` },
      });
      controller.arm({
        id: `preview-${status}`,
        action: 'respond',
        owner: 'engagement-api',
        method: 'GET',
        pathname,
        status,
        headers: { 'x-capiro-service': 'engagement-api' },
        body: { statusCode: status, code: `ORDINARY_${status}`, message: `ordinary-${status}` },
      });
      const [mainResult, previewResult] = await Promise.all([
        fetchResult(`${FAULT_URL}${pathname}`, { headers: headers(token) }),
        fetchResult(`${FAULT_URL}${pathname}`, { headers: headers(token, true) }),
      ]);
      requirePreviewIdentity(`ordinary-${status}`, previewResult);
      if (
        mainResult.status !== status ||
        previewResult.status !== status ||
        mainResult.body?.code !== `ORDINARY_${status}` ||
        previewResult.body?.code !== `ORDINARY_${status}`
      ) {
        throw new Error(`Ordinary ${status} fault lost its status/code semantics`);
      }
      results.push({ id: `ordinary-${status}`, mainResult, previewResult });
    }

    for (const action of ['malformed_json', 'partial_response', 'reset']) {
      for (const owner of ['main-api', 'engagement-api']) {
        controller.arm({
          id: `${owner}-${action}`,
          action,
          owner,
          method: 'GET',
          pathname: '/api/engagement/meetings',
          status: 200,
          headers: owner === 'engagement-api' ? { 'x-capiro-service': 'engagement-api' } : {},
          fragment: '{"phase3":"partial"',
        });
      }
      const [mainResult, previewResult] = await Promise.all([
        fetchResult(`${FAULT_URL}/api/engagement/meetings`, { headers: headers(token) }),
        fetchResult(`${FAULT_URL}/api/engagement/meetings`, {
          headers: headers(token, true),
        }),
      ]);
      if (action === 'malformed_json') {
        requirePreviewIdentity(action, previewResult);
        if (
          mainResult.kind !== 'http' ||
          previewResult.kind !== 'http' ||
          mainResult.text !== previewResult.text
        ) {
          throw new Error('Malformed JSON did not produce equivalent complete transport results');
        }
      } else if (mainResult.kind === 'http' || previewResult.kind === 'http') {
        throw new Error(`${action} unexpectedly completed as a clean HTTP response`);
      }
      results.push({ id: action, mainResult, previewResult });
    }

    for (const owner of ['main-api', 'engagement-api']) {
      controller.arm({
        id: `${owner}-slow`,
        action: 'respond',
        owner,
        method: 'GET',
        pathname: '/api/engagement/meetings',
        status: 200,
        delayMs: 1_500,
        headers: owner === 'engagement-api' ? { 'x-capiro-service': 'engagement-api' } : {},
        body: [],
      });
    }
    const [slowMain, slowPreview] = await Promise.all([
      fetchResult(`${FAULT_URL}/api/engagement/meetings`, { headers: headers(token) }, 100),
      fetchResult(
        `${FAULT_URL}/api/engagement/meetings`,
        { headers: headers(token, true) },
        100,
      ),
    ]);
    if (slowMain.kind !== 'timeout' || slowPreview.kind !== 'timeout') {
      throw new Error('Slow response fault did not time out in both modes');
    }
    results.push({ id: 'slow-timeout', mainResult: slowMain, previewResult: slowPreview });

    // Failed-before-upstream write then explicit retry: no row after the fault,
    // exactly one row after retry. External actions have their own complete
    // denial/digest sweep and are never retried here.
    controller.arm({
      id: 'task-write-before-upstream',
      action: 'respond',
      owner: 'engagement-api',
      method: 'POST',
      pathname: '/api/engagement/tasks',
      status: 503,
      headers: { 'x-capiro-service': 'engagement-api' },
      body: { statusCode: 503, code: 'ORDINARY_503', message: 'retryable local fault' },
    });
    const failedTask = await fetchResult(`${FAULT_URL}/api/engagement/tasks`, {
      method: 'POST',
      headers: { ...headers(token, true), 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, title: MARKER }),
    });
    requirePreviewIdentity('task retry fault', failedTask);
    if (failedTask.status !== 503) throw new Error('First task attempt did not receive injected 503');
    const beforeRetry = await fetchResult(
      `${MAIN_URL.origin}/api/engagement/tasks?clientId=${encodeURIComponent(clientId)}`,
      { headers: headers(token) },
    );
    const beforeRows = Array.isArray(beforeRetry.body) ? beforeRetry.body : [];
    if (beforeRows.some((row) => row?.title === MARKER)) {
      throw new Error('Failed-before-upstream task attempt wrote a row');
    }
    const retriedTask = await fetchResult(`${FAULT_URL}/api/engagement/tasks`, {
      method: 'POST',
      headers: { ...headers(token, true), 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, title: MARKER }),
    });
    requirePreviewIdentity('task retry success', retriedTask);
    if (
      retriedTask.kind !== 'http' ||
      retriedTask.status < 200 ||
      retriedTask.status >= 300 ||
      typeof retriedTask.body?.id !== 'string'
    ) {
      throw new Error('Task retry did not create one successful row');
    }
    retryTaskId = retriedTask.body.id;
    const afterRetry = await fetchResult(
      `${MAIN_URL.origin}/api/engagement/tasks?clientId=${encodeURIComponent(clientId)}`,
      { headers: headers(token) },
    );
    const afterRows = Array.isArray(afterRetry.body) ? afterRetry.body : [];
    if (afterRows.filter((row) => row?.id === retryTaskId).length !== 1) {
      throw new Error('Task retry did not resolve to exactly one shared row');
    }
    results.push({ id: 'safe-write-retry-no-duplicate', failedTask, retriedTask });

    // DB unavailable after boot, then recovered.
    docker('pause', DB_CONTAINER);
    databasePaused = true;
    const [dbMain, dbPreview] = await Promise.all([
      fetchResult(`${MAIN_URL.origin}/api/engagement/meetings`, { headers: headers(token) }, 8_000),
      fetchResult(
        `${SHADOW_URL.origin}/api/engagement/meetings`,
        { headers: headers(token) },
        8_000,
      ),
    ]);
    if (
      (dbMain.kind === 'http' && dbMain.status >= 200 && dbMain.status < 300) ||
      (dbPreview.kind === 'http' && dbPreview.status >= 200 && dbPreview.status < 300)
    ) {
      throw new Error('Database pause left a runtime serving successful meeting data');
    }
    if (dbMain.status === 401 || dbPreview.status === 401) {
      throw new Error('Database outage probe was vacuous because authentication returned 401');
    }
    docker('unpause', DB_CONTAINER);
    databasePaused = false;
    const recovered = await waitForRecovered(token);
    results.push({
      id: 'database-after-boot-recovery',
      outage: { main: dbMain, preview: dbPreview },
      recovered,
    });

    results.push({
      id: 'database-unavailable-at-boot',
      ...(await isolatedShadowProbe({
        port: Number(process.env.ENGAGEMENT_PHASE3_BOOT_DB_FAILURE_PORT ?? 4511),
        token,
        label: 'database unavailable at boot',
        envOverrides: {
          DATABASE_URL: 'postgresql://capiro:capiro@127.0.0.1:1/capiro?schema=public',
        },
      })),
    });

    results.push({
      id: 'auth-upstream-unavailable',
      ...(await isolatedShadowProbe({
        port: Number(process.env.ENGAGEMENT_PHASE3_AUTH_FAILURE_PORT ?? 4512),
        token,
        label: 'auth upstream unavailable',
        envOverrides: {
          CLERK_JWT_ISSUER: 'http://127.0.0.1:1',
          CLERK_SECRET_KEY: 'sk_test_phase3_unavailable_auth_upstream',
        },
      })),
    });

    results.push({ id: 'stream-interruption', ...(await assertNoCurrentStreamingConsumer()) });

    const snapshot = controller.snapshot();
    if (snapshot.armed.length) {
      throw new Error(`Not every resilience fault was exercised: ${snapshot.armed.join(', ')}`);
    }

    await writeFile(
      path.join(EVIDENCE, 'resilience.json'),
      `${JSON.stringify(
        {
          marker: 'ENGAGEMENT_PHASE3_RESILIENCE_COMPLETE',
          cases: results.length,
          results,
          faultHits: snapshot.hits,
          proxyDecisions: decisions,
          databaseRecovered: true,
          authUnavailableFailedClosed: true,
          retryDuplicateCount: 0,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`ENGAGEMENT_PHASE3_RESILIENCE_COMPLETE cases=${results.length}`);
  } finally {
    if (databasePaused) {
      try {
        docker('unpause', DB_CONTAINER);
      } catch {
        // local runner finally removes the disposable container; retain original failure
      }
    }
    // The wrapper deletes the retry row through psql and verifies residual zero
    // before the containment digest begins. Keep the id in evidence for that
    // controlled cleanup rather than attempting a nonexistent task DELETE route.
    await proxy.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
