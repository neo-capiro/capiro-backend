#!/usr/bin/env node
/**
 * Phase 3 browser-level recoverable-error proof.
 *
 * CDP Fetch interception injects one request fault at a time without changing
 * product code or the local proxy. The current surface must retain its primary
 * navigation/control shell, never render a global crash/auth page, and recover
 * on a clean reload in BOTH main and preview contexts.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chromeLauncher = require('chrome-launcher');

const BASE_URL = process.env.ENGAGEMENT_PHASE3_BASE_URL ?? 'http://127.0.0.1:5173';
const EVIDENCE = required('ENGAGEMENT_PHASE3_EVIDENCE_DIR');
const CLERK_SECRET_KEY = required('CLERK_SECRET_KEY');
const CLERK_API_URL = process.env.CLERK_API_URL?.trim() || 'https://api.clerk.com';
const ADMIN_CLERK_USER_ID = required('ENGAGEMENT_PHASE3_ADMIN_CLERK_USER_ID');
const PRIMARY_CLERK_ORG_ID = required('ENGAGEMENT_PHASE3_PRIMARY_CLERK_ORG_ID');
const PREVIEW_STORAGE_KEY = 'capiro.engagement-api-preview';
const PREVIEW_INDICATOR = 'Engagement API preview — External actions are disabled';

const CASES = [
  {
    id: 'meetings-ordinary-503',
    route: '/engagement/meetings',
    requestPath: '/api/engagement/meetings',
    fault: 'http_503',
    shellText: 'Meetings',
    recoveryText: 'Upcoming client briefing',
  },
  {
    id: 'outreach-reset',
    route: '/engagement/outreach',
    requestPath: '/api/engagement/outreach',
    fault: 'reset',
    shellText: 'Outreach',
    recoveryText: 'Draft campaign at step 1',
  },
  {
    id: 'reports-malformed-json',
    route: '/engagement/reports',
    requestPath: '/api/engagement/reports/overview',
    fault: 'malformed_json',
    shellText: 'Reports',
    recoveryText: 'Office Engagement Tracker',
  },
  {
    id: 'integrations-ordinary-502',
    route: '/settings/integrations',
    requestPath: '/api/engagement/integrations',
    fault: 'http_502',
    shellText: 'Integrations',
    recoveryText: 'Microsoft 365',
  },
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
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

async function mintTicket() {
  const response = await fetch(`${CLERK_API_URL}/v1/sign_in_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: ADMIN_CLERK_USER_ID, expires_in_seconds: 3600 }),
  });
  if (!response.ok) throw new Error(`Clerk sign-in token mint failed with ${response.status}`);
  const body = await response.json();
  if (typeof body?.token !== 'string' || body.token.length < 20) {
    throw new Error('Clerk sign-in token response contained no usable ticket');
  }
  return body.token;
}

class Page {
  constructor(cdp, sessionId, mode) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.mode = mode;
    this.fault = null;
    this.faultHits = [];
  }

  async init() {
    for (const domain of ['Page', 'Runtime', 'Network', 'Fetch']) {
      await this.cdp.send(`${domain}.enable`, {}, this.sessionId);
    }
    const key = `${this.sessionId}:Fetch.requestPaused`;
    const listener = (params) => void this.handlePaused(params);
    this.cdp.listeners.set(key, [...(this.cdp.listeners.get(key) ?? []), listener]);
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true, userGesture: true },
      this.sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async waitFor(fn, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        if (await fn()) return;
      } catch (error) {
        last = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw last ?? new Error(`Timed out after ${timeoutMs}ms`);
  }

  async navigate(route) {
    await this.cdp.send('Page.navigate', { url: `${BASE_URL}${route}` }, this.sessionId);
    await this.waitFor(() => this.evaluate('document.readyState === "complete"'));
    await this.waitFor(() => this.evaluate('Boolean(window.Clerk?.session)'));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  }

  async reload() {
    await this.cdp.send('Page.reload', { ignoreCache: true }, this.sessionId);
    await this.waitFor(() => this.evaluate('document.readyState === "complete"'));
    await this.waitFor(() => this.evaluate('Boolean(window.Clerk?.session)'));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  }

  armFault(testCase) {
    if (this.fault) throw new Error(`A browser recovery fault is already armed: ${this.fault.id}`);
    this.fault = { ...testCase, consumed: false };
  }

  async handlePaused(params) {
    const request = params.request ?? {};
    const pathname = (() => {
      try {
        return new URL(request.url).pathname;
      } catch {
        return '';
      }
    })();
    const fault = this.fault;
    if (
      !fault ||
      fault.consumed ||
      request.method !== 'GET' ||
      pathname !== fault.requestPath
    ) {
      await this.cdp.send('Fetch.continueRequest', { requestId: params.requestId }, this.sessionId);
      return;
    }

    fault.consumed = true;
    this.faultHits.push({ id: fault.id, pathname, mode: this.mode, fault: fault.fault });
    if (fault.fault === 'reset') {
      await this.cdp.send(
        'Fetch.failRequest',
        { requestId: params.requestId, errorReason: 'ConnectionReset' },
        this.sessionId,
      );
      return;
    }

    const status = fault.fault === 'http_502' ? 502 : fault.fault === 'http_503' ? 503 : 200;
    const responseHeaders = [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Cache-Control', value: 'no-store' },
      ...(this.mode === 'preview'
        ? [{ name: 'X-Capiro-Service', value: 'engagement-api' }]
        : []),
    ];
    const body =
      fault.fault === 'malformed_json'
        ? '{"phase3":"malformed"'
        : JSON.stringify({
            statusCode: status,
            code: `ORDINARY_${status}`,
            message: `Phase 3 injected browser ${status}`,
          });
    await this.cdp.send(
      'Fetch.fulfillRequest',
      {
        requestId: params.requestId,
        responseCode: status,
        responseHeaders,
        body: Buffer.from(body).toString('base64'),
      },
      this.sessionId,
    );
  }

  async snapshot() {
    return this.evaluate(`(() => ({
      pathname: location.pathname,
      search: location.search,
      body: (document.body?.innerText ?? '').slice(0, 50000),
      preview: (document.body?.innerText ?? '').includes(${JSON.stringify(PREVIEW_INDICATOR)}),
      globalCrash: [
        'Application error',
        'Something went wrong',
        'Sign in to',
        'Create your account'
      ].some((needle) => (document.body?.innerText ?? '').includes(needle)),
      focusableControls: Array.from(document.querySelectorAll(
        'button,a,input,select,textarea,[role="button"],[role="tab"]'
      )).filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
      }).length,
    }))()`);
  }
}

async function createPage(cdp, mode) {
  const context = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const target = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId: context.browserContextId,
  });
  const attached = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const page = new Page(cdp, attached.sessionId, mode);
  await page.init();
  const ticket = await mintTicket();
  await page.navigate(`/?__clerk_ticket=${encodeURIComponent(ticket)}`);
  await page.evaluate(`(async () => {
    if (window.Clerk?.organization?.id !== ${JSON.stringify(PRIMARY_CLERK_ORG_ID)}) {
      await window.Clerk?.setActive({ organization: ${JSON.stringify(PRIMARY_CLERK_ORG_ID)} });
    }
    return true;
  })()`);
  await page.waitFor(
    () => page.evaluate(`window.Clerk?.organization?.id === ${JSON.stringify(PRIMARY_CLERK_ORG_ID)}`),
  );
  if (mode === 'preview') {
    await page.navigate('/?engagement-api-preview=v3');
    await page.waitFor(
      () =>
        page.evaluate(
          `sessionStorage.getItem(${JSON.stringify(PREVIEW_STORAGE_KEY)}) === 'v3' && ` +
            `(document.body?.innerText ?? '').includes(${JSON.stringify(PREVIEW_INDICATOR)})`,
        ),
    );
  } else {
    await page.navigate('/');
  }
  return page;
}

async function runCase(page, testCase) {
  page.armFault(testCase);
  await page.navigate(testCase.route);
  const faulted = await page.snapshot();
  if (!page.fault?.consumed) throw new Error(`${page.mode}:${testCase.id} fault was not consumed`);
  page.fault = null;
  if (faulted.pathname !== testCase.route) {
    throw new Error(`${page.mode}:${testCase.id} changed route to ${faulted.pathname}`);
  }
  if (faulted.globalCrash) throw new Error(`${page.mode}:${testCase.id} rendered a global crash/auth page`);
  if (!faulted.body.includes(testCase.shellText)) {
    throw new Error(`${page.mode}:${testCase.id} lost shell text ${testCase.shellText}`);
  }
  if (faulted.focusableControls < 2) {
    throw new Error(`${page.mode}:${testCase.id} left no usable controls`);
  }
  if (page.mode === 'preview' && !faulted.preview) {
    throw new Error(`${page.mode}:${testCase.id} lost the preview indicator`);
  }

  await page.reload();
  const recovered = await page.snapshot();
  if (recovered.globalCrash || !recovered.body.includes(testCase.recoveryText)) {
    throw new Error(`${page.mode}:${testCase.id} did not recover on clean reload`);
  }
  if (page.mode === 'preview' && !recovered.preview) {
    throw new Error(`${page.mode}:${testCase.id} recovery lost preview mode`);
  }
  return { mode: page.mode, id: testCase.id, faulted, recovered };
}

async function main() {
  await mkdir(EVIDENCE, { recursive: true });
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
    startingUrl: 'about:blank',
  });
  try {
    const cdp = await connectChrome(chrome.port);
    const mainPage = await createPage(cdp, 'main');
    const previewPage = await createPage(cdp, 'preview');
    const results = [];
    for (const testCase of CASES) {
      const [main, preview] = await Promise.all([
        runCase(mainPage, testCase),
        runCase(previewPage, testCase),
      ]);
      if (
        main.faulted.pathname !== preview.faulted.pathname ||
        main.recovered.pathname !== preview.recovered.pathname ||
        !main.recovered.body.includes(testCase.recoveryText) ||
        !preview.recovered.body.includes(testCase.recoveryText)
      ) {
        throw new Error(`${testCase.id}: main/preview browser recovery diverged`);
      }
      results.push({ id: testCase.id, main, preview });
    }
    const hitIds = new Set([...mainPage.faultHits, ...previewPage.faultHits].map((row) => row.id));
    const missing = CASES.filter((testCase) => !hitIds.has(testCase.id)).map((row) => row.id);
    if (missing.length) throw new Error(`Browser recovery silently skipped: ${missing.join(', ')}`);

    await writeFile(
      path.join(EVIDENCE, 'browser-recovery.json'),
      `${JSON.stringify(
        {
          marker: 'ENGAGEMENT_PHASE3_BROWSER_RECOVERY_COMPLETE',
          cases: results.length,
          results,
          faultHits: [...mainPage.faultHits, ...previewPage.faultHits],
          noSilentSkips: true,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`ENGAGEMENT_PHASE3_BROWSER_RECOVERY_COMPLETE cases=${results.length}`);
  } finally {
    const killed = chrome.kill();
    if (killed && typeof killed.then === 'function') await killed;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
