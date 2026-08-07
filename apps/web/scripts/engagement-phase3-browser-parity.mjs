#!/usr/bin/env node
/**
 * Phase 3 authenticated dual-mode browser parity harness.
 *
 * Runs the exact same SPA and fixture database in two isolated Chrome browser
 * contexts. Main mode never activates preview. Preview mode activates via the
 * supported query parameter and therefore exercises the production request
 * interceptor rather than injecting headers from the harness.
 *
 * The local runner places a tiny header-aware proxy at the normal API base URL:
 * main Engagement requests -> main API :4000; exact preview-header Engagement
 * requests -> engagement-api :4500; every non-Engagement request -> main API.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  assertNetworkRecords,
  isEngagementRequest,
  sanitizeNetworkRecord,
} from './engagement-phase3-network-recorder.mjs';
import { compareNormalizedDom, normalizeDomSnapshot } from './engagement-phase3-dom-normalizer.mjs';

const require = createRequire(import.meta.url);
const chromeLauncher = require('chrome-launcher');

const BASE_URL = process.env.ENGAGEMENT_PHASE3_BASE_URL ?? 'http://127.0.0.1:5173';
const EVIDENCE = required('ENGAGEMENT_PHASE3_EVIDENCE_DIR');
const FIXTURE_FILE = required('ENGAGEMENT_PHASE3_FIXTURE_FILE');
const TOKEN_FILE = process.env.ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE?.trim() || path.join(EVIDENCE, 'admin-bearer-token');
const CLERK_SECRET_KEY = required('CLERK_SECRET_KEY');
const CLERK_API_URL = process.env.CLERK_API_URL?.trim() || 'https://api.clerk.com';
const ADMIN_CLERK_USER_ID = required('ENGAGEMENT_PHASE3_ADMIN_CLERK_USER_ID');
const PRIMARY_CLERK_ORG_ID = required('ENGAGEMENT_PHASE3_PRIMARY_CLERK_ORG_ID');
const PREVIEW_STORAGE_KEY = 'capiro.engagement-api-preview';
const PREVIEW_INDICATOR = 'Engagement API preview — External actions are disabled';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result ?? {});
        return;
      }
      const key = `${message.sessionId ?? 'browser'}:${message.method}`;
      for (const listener of this.listeners.get(key) ?? []) listener(message.params ?? {});
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  once(method, sessionId, timeoutMs = 30_000) {
    const key = `${sessionId ?? 'browser'}:${method}`;
    return new Promise((resolve, reject) => {
      const listener = (params) => {
        clearTimeout(timer);
        this.listeners.set(key, (this.listeners.get(key) ?? []).filter((item) => item !== listener));
        resolve(params);
      };
      const timer = setTimeout(() => {
        this.listeners.set(key, (this.listeners.get(key) ?? []).filter((item) => item !== listener));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.listeners.set(key, [...(this.listeners.get(key) ?? []), listener]);
    });
  }
}

async function connectChrome(port) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => {
    if (!response.ok) throw new Error(`Chrome version endpoint returned ${response.status}`);
    return response.json();
  });
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return new Cdp(socket);
}

class BrowserPage {
  constructor({ cdp, sessionId, baseUrl, screenshotDir }) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.baseUrl = baseUrl;
    this.screenshotDir = screenshotDir;
  }

  async init() {
    for (const domain of ['Page', 'Runtime', 'Network', 'Emulation']) {
      await this.cdp.send(`${domain}.enable`, {}, this.sessionId);
    }
  }

  async evaluate(expression, awaitPromise = true) {
    const response = await this.cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true, userGesture: true },
      this.sessionId,
    );
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  async waitFor(fn, timeoutMs = 30_000, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        if (await fn()) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw lastError ?? new Error(`Timed out after ${timeoutMs}ms`);
  }

  async navigate(pathname) {
    const url = pathname.startsWith('http') ? pathname : `${this.baseUrl}${pathname}`;
    const loaded = this.cdp.once('Page.loadEventFired', this.sessionId, 40_000).catch(() => undefined);
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    await loaded;
    await this.waitFor(() => this.evaluate('document.readyState === "complete"'), 20_000);
  }

  async viewport(width, height) {
    await this.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: width <= 480 },
      this.sessionId,
    );
  }

  async screenshot(name) {
    const response = await this.cdp.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false, fromSurface: true },
      this.sessionId,
    );
    const filename = path.join(this.screenshotDir, `${safeName(name)}.png`);
    await writeFile(filename, Buffer.from(response.data, 'base64'));
    return filename;
  }
}

async function mintSignInToken() {
  const response = await fetch(`${CLERK_API_URL}/v1/sign_in_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: ADMIN_CLERK_USER_ID, expires_in_seconds: 3600 }),
  });
  if (!response.ok) throw new Error(`Clerk sign-in token mint failed with ${response.status}`);
  const parsed = await response.json();
  if (typeof parsed?.token !== 'string' || parsed.token.length < 20) {
    throw new Error('Clerk sign-in token response contained no usable ticket');
  }
  return parsed.token;
}

async function createActor(cdp, mode, screenshotDir) {
  const context = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const target = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId: context.browserContextId,
  });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const page = new BrowserPage({ cdp, sessionId: attached.sessionId, baseUrl: BASE_URL, screenshotDir });
  await page.init();

  const ticket = await mintSignInToken();
  await page.navigate(`/?__clerk_ticket=${encodeURIComponent(ticket)}`);
  await page.waitFor(() => page.evaluate('Boolean(window.Clerk?.session)'), 50_000);
  await page.evaluate(`(async () => {
    if (window.Clerk?.organization?.id !== ${JSON.stringify(PRIMARY_CLERK_ORG_ID)}) {
      await window.Clerk?.setActive({ organization: ${JSON.stringify(PRIMARY_CLERK_ORG_ID)} });
    }
    return window.Clerk?.organization?.id ?? null;
  })()`);
  await page.waitFor(
    () => page.evaluate(`window.Clerk?.organization?.id === ${JSON.stringify(PRIMARY_CLERK_ORG_ID)}`),
    30_000,
  );

  const token = await page.evaluate(`(async () => {
    const value = await window.Clerk?.session?.getToken({ template: 'capiro' });
    if (!value) throw new Error('capiro token unavailable');
    return value;
  })()`);
  if (typeof token !== 'string' || token.length < 20) throw new Error('Browser produced no bearer token');

  if (mode === 'preview') {
    await page.navigate('/?engagement-api-preview=v3&phase3-preserve=1');
    await page.waitFor(
      () =>
        page.evaluate(`(() => {
          const params = new URLSearchParams(location.search);
          return !params.has('engagement-api-preview') &&
            params.get('phase3-preserve') === '1' &&
            sessionStorage.getItem(${JSON.stringify(PREVIEW_STORAGE_KEY)}) === 'v3' &&
            (document.body?.innerText ?? '').includes(${JSON.stringify(PREVIEW_INDICATOR)});
        })()`),
      30_000,
    );
  } else {
    await page.navigate('/');
    const state = await page.evaluate(`({
      stored: sessionStorage.getItem(${JSON.stringify(PREVIEW_STORAGE_KEY)}),
      indicator: (document.body?.innerText ?? '').includes(${JSON.stringify(PREVIEW_INDICATOR)}),
    })`);
    if (state?.stored || state?.indicator) throw new Error('Main browser context unexpectedly entered preview mode');
  }

  return { page, token };
}

function attachNetworkRecorder(cdp, page, mode, records) {
  const pending = new Map();
  const requestKey = `${page.sessionId}:Network.requestWillBeSent`;
  const responseKey = `${page.sessionId}:Network.responseReceived`;
  const failedKey = `${page.sessionId}:Network.loadingFailed`;

  const onRequest = (params) => {
    const request = params?.request ?? {};
    pending.set(params.requestId, {
      mode,
      surface: null,
      requestId: params.requestId,
      method: request.method,
      url: request.url,
      headers: request.headers ?? {},
      responseHeaders: {},
      status: null,
    });
  };
  const onResponse = (params) => {
    const current = pending.get(params.requestId);
    if (!current) return;
    current.status = params.response?.status ?? null;
    current.responseHeaders = params.response?.headers ?? {};
    records.push(current);
    pending.delete(params.requestId);
  };
  const onFailed = (params) => {
    const current = pending.get(params.requestId);
    if (!current) return;
    current.status = -1;
    current.errorText = params.errorText ?? 'network failure';
    records.push(current);
    pending.delete(params.requestId);
  };

  cdp.listeners.set(requestKey, [...(cdp.listeners.get(requestKey) ?? []), onRequest]);
  cdp.listeners.set(responseKey, [...(cdp.listeners.get(responseKey) ?? []), onResponse]);
  cdp.listeners.set(failedKey, [...(cdp.listeners.get(failedKey) ?? []), onFailed]);

  return {
    setSurface(surface) {
      for (const record of pending.values()) if (!record.surface) record.surface = surface;
      this.currentSurface = surface;
    },
    markNewRecords(start, surface) {
      for (let index = start; index < records.length; index += 1) {
        if (records[index].mode === mode && !records[index].surface) records[index].surface = surface;
      }
    },
  };
}

function buildStates(fixtures) {
  const ids = fixtures?.ids ?? fixtures;
  const clientId = ids?.['client.alpha'] ?? ids?.client?.alpha ?? null;
  return [
    { id: 'meetings', pathname: '/engagement/meetings', requireEngagementRequest: true },
    { id: 'outreach', pathname: '/engagement/outreach', requireEngagementRequest: true },
    { id: 'reports', pathname: '/engagement/reports', requireEngagementRequest: true },
    { id: 'integrations', pathname: '/settings/integrations', requireEngagementRequest: true },
    { id: 'home', pathname: '/', requireEngagementRequest: true },
    ...(clientId
      ? [{ id: 'client-profile', pathname: `/clients/${clientId}`, requireEngagementRequest: true }]
      : []),
  ];
}

async function collectPageState(page, state, viewport, mode) {
  await page.viewport(viewport.width, viewport.height);
  await page.navigate(state.pathname);
  await page.waitFor(
    () =>
      page.evaluate(`(() => {
        const body = document.body?.innerText ?? '';
        return document.readyState === 'complete' &&
          Boolean(window.Clerk?.session) &&
          !body.includes('Signing in') &&
          !body.includes('Create your account');
      })()`),
    35_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  const snapshot = await page.evaluate(`(() => {
    const root = document.getElementById('root') ?? document.body;
    const bodyText = document.body?.innerText ?? '';
    const ids = Array.from(document.querySelectorAll('[id]')).map((node) => node.id).filter(Boolean);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    const unnamedControls = Array.from(document.querySelectorAll('button,input,select,textarea,[role="button"]'))
      .filter((node) => {
        const text = (node.innerText || node.value || '').trim();
        const label = node.getAttribute('aria-label') || node.getAttribute('aria-labelledby') || node.getAttribute('title');
        return !text && !label;
      }).length;
    const dialogsWithoutName = Array.from(document.querySelectorAll('[role="dialog"],dialog'))
      .filter((node) => !(node.getAttribute('aria-label') || node.getAttribute('aria-labelledby'))).length;
    return {
      pathname: location.pathname,
      search: location.search,
      bodyText: bodyText.slice(0, 20000),
      html: root?.outerHTML?.slice(0, 500000) ?? '',
      duplicateIds: Array.from(new Set(duplicateIds)),
      unnamedControls,
      dialogsWithoutName,
      horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0) > window.innerWidth + 2,
      previewIndicator: bodyText.includes(${JSON.stringify(PREVIEW_INDICATOR)}),
    };
  })()`);

  if (snapshot.pathname !== state.pathname) {
    throw new Error(`${mode}/${state.id}/${viewport.name}: expected ${state.pathname}, got ${snapshot.pathname}`);
  }
  if (snapshot.bodyText.trim().length < 20) {
    throw new Error(`${mode}/${state.id}/${viewport.name}: rendered body is empty`);
  }
  for (const forbidden of ['Application error', 'Something went wrong', 'Sign in to']) {
    if (snapshot.bodyText.includes(forbidden)) {
      throw new Error(`${mode}/${state.id}/${viewport.name}: error/auth page contains ${forbidden}`);
    }
  }
  if (mode === 'preview' && !snapshot.previewIndicator) {
    throw new Error(`${state.id}/${viewport.name}: preview indicator missing`);
  }
  if (mode === 'main' && snapshot.previewIndicator) {
    throw new Error(`${state.id}/${viewport.name}: preview indicator leaked into main`);
  }

  const screenshot = await page.screenshot(`${mode}-${state.id}-${viewport.name}`);
  return { ...snapshot, screenshot, normalizedDom: normalizeDomSnapshot(snapshot.html) };
}

async function main() {
  const fixtures = JSON.parse(await readFile(FIXTURE_FILE, 'utf8'));
  const states = buildStates(fixtures);
  if (states.length < 5) throw new Error('Fixture index did not produce the required Phase 3 browser surfaces');

  const screenshotRoot = path.join(EVIDENCE, 'screenshots');
  await mkdir(path.join(screenshotRoot, 'main'), { recursive: true });
  await mkdir(path.join(screenshotRoot, 'preview'), { recursive: true });

  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
    startingUrl: 'about:blank',
  });
  const cdp = await connectChrome(chrome.port);
  const networkRecords = [];

  try {
    const mainActor = await createActor(cdp, 'main', path.join(screenshotRoot, 'main'));
    const previewActor = await createActor(cdp, 'preview', path.join(screenshotRoot, 'preview'));
    await writeFile(TOKEN_FILE, mainActor.token, { mode: 0o600 });
    await chmod(TOKEN_FILE, 0o600).catch(() => undefined);

    const mainRecorder = attachNetworkRecorder(cdp, mainActor.page, 'main', networkRecords);
    const previewRecorder = attachNetworkRecorder(cdp, previewActor.page, 'preview', networkRecords);
    const results = [];
    const accessibility = [];

    for (const viewport of VIEWPORTS) {
      for (const state of states) {
        const mainStart = networkRecords.length;
        mainRecorder.setSurface(state.id);
        const mainState = await collectPageState(mainActor.page, state, viewport, 'main');
        mainRecorder.markNewRecords(mainStart, state.id);

        const previewStart = networkRecords.length;
        previewRecorder.setSurface(state.id);
        const previewState = await collectPageState(previewActor.page, state, viewport, 'preview');
        previewRecorder.markNewRecords(previewStart, state.id);

        const mainRequests = networkRecords.slice(mainStart, previewStart).filter((row) => row.mode === 'main');
        const previewRequests = networkRecords.slice(previewStart).filter((row) => row.mode === 'preview');
        if (state.requireEngagementRequest) {
          if (!mainRequests.some((row) => isEngagementRequest(row.url))) {
            throw new Error(`${state.id}/${viewport.name}: main emitted no Engagement request`);
          }
          if (!previewRequests.some((row) => isEngagementRequest(row.url))) {
            throw new Error(`${state.id}/${viewport.name}: preview emitted no Engagement request`);
          }
        }

        const dom = compareNormalizedDom(mainState.html, previewState.html);
        if (!dom.equal) {
          throw new Error(`${state.id}/${viewport.name}: normalized main/preview DOM differs`);
        }

        for (const [mode, snapshot] of [
          ['main', mainState],
          ['preview', previewState],
        ]) {
          const problems = [];
          if (snapshot.duplicateIds.length) problems.push(`duplicate ids: ${snapshot.duplicateIds.join(', ')}`);
          if (snapshot.unnamedControls) problems.push(`${snapshot.unnamedControls} unnamed controls`);
          if (snapshot.dialogsWithoutName) problems.push(`${snapshot.dialogsWithoutName} unnamed dialogs`);
          if (snapshot.horizontalOverflow) problems.push('horizontal overflow');
          accessibility.push({ mode, surface: state.id, viewport: viewport.name, problems });
          if (problems.length) {
            throw new Error(`${mode}/${state.id}/${viewport.name}: accessibility/layout ${problems.join('; ')}`);
          }
        }

        results.push({
          surface: state.id,
          pathname: state.pathname,
          viewport,
          main: { screenshot: mainState.screenshot, normalizedDom: mainState.normalizedDom },
          preview: { screenshot: previewState.screenshot, normalizedDom: previewState.normalizedDom },
          domEqual: true,
        });
      }
    }

    assertNetworkRecords(networkRecords);

    const sanitizedNetwork = networkRecords.map(sanitizeNetworkRecord);
    await writeFile(path.join(EVIDENCE, 'ui-surface-results.json'), `${JSON.stringify(results, null, 2)}\n`);
    await writeFile(path.join(EVIDENCE, 'network-results.json'), `${JSON.stringify(sanitizedNetwork, null, 2)}\n`);
    await writeFile(path.join(EVIDENCE, 'accessibility.json'), `${JSON.stringify(accessibility, null, 2)}\n`);
    await writeFile(
      path.join(EVIDENCE, 'dom-comparison.json'),
      `${JSON.stringify(results.map((row) => ({ surface: row.surface, viewport: row.viewport.name, equal: row.domEqual })), null, 2)}\n`,
    );
    await writeFile(
      path.join(EVIDENCE, 'summary.json'),
      `${JSON.stringify(
        {
          marker: 'ENGAGEMENT_PHASE3_BROWSER_PARITY_COMPLETE',
          surfaces: states.map((state) => state.id),
          viewports: VIEWPORTS,
          comparisons: results.length,
          networkRecords: sanitizedNetwork.length,
          previewServiceIdentityVerified: sanitizedNetwork.some(
            (row) => row.mode === 'preview' && isEngagementRequest(row.url) && row.status != null,
          ),
          accessibilityChecks: accessibility.length,
        },
        null,
        2,
      )}\n`,
    );
    console.log('ENGAGEMENT_PHASE3_BROWSER_PARITY_COMPLETE');
  } finally {
    const result = chrome.kill();
    if (result && typeof result.then === 'function') await result;
  }
}

main().catch(async (error) => {
  await mkdir(EVIDENCE, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(EVIDENCE, 'browser-parity-failure.json'),
    `${JSON.stringify({ marker: 'ENGAGEMENT_PHASE3_BROWSER_PARITY_FAILED', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
  ).catch(() => undefined);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
