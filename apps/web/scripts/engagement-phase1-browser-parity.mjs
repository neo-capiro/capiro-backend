#!/usr/bin/env node
/**
 * Authenticated Chrome/CDP proof that the unchanged web application still uses
 * only the main API during Phase 1. Missing credentials, a sign-in redirect, an
 * empty application shell, or zero Engagement API traffic are hard failures.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chromeLauncher = require('chrome-launcher');

const BASE_URL = process.env.ENGAGEMENT_PHASE1_BASE_URL ?? 'http://127.0.0.1:5173';
const MAIN_URL = process.env.ENGAGEMENT_PHASE1_MAIN_URL ?? 'http://127.0.0.1:4000';
const SHADOW_URL =
  process.env.ENGAGEMENT_PHASE1_ENGAGEMENT_URL ?? 'http://127.0.0.1:4500';
const EVIDENCE = required('ENGAGEMENT_PHASE1_EVIDENCE_DIR');
const TOKEN_FILE = required('ENGAGEMENT_PHASE1_TOKEN_FILE');
const COOKIE = requiredAny(
  'ENGAGEMENT_PHASE1_USER_COOKIE',
  'ENGAGEMENT_PHASE0_USER_COOKIE',
);
const ORG_ID = requiredAny(
  'ENGAGEMENT_PHASE1_CLERK_ORG_ID',
  'ENGAGEMENT_PHASE0_CLERK_ORG_ID',
);
const SCREENSHOTS = path.join(EVIDENCE, 'screenshots');

const STATES = [
  { pathname: '/engagement/meetings', label: 'Meetings' },
  { pathname: '/engagement/outreach', label: 'Outreach' },
  { pathname: '/engagement/reports', label: 'Reports' },
  { pathname: '/engagement/integrations', label: 'Integrations' },
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredAny(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`One of ${names.join(', ')} is required`);
}

function requestHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function safeName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
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
      this.socket.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  }

  once(method, sessionId, timeoutMs = 20_000) {
    const key = `${sessionId ?? 'browser'}:${method}`;
    return new Promise((resolve, reject) => {
      const listener = (params) => {
        clearTimeout(timer);
        this.listeners.set(
          key,
          (this.listeners.get(key) ?? []).filter((item) => item !== listener),
        );
        resolve(params);
      };
      const timer = setTimeout(() => {
        this.listeners.set(
          key,
          (this.listeners.get(key) ?? []).filter((item) => item !== listener),
        );
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

function cookiesFromHeader(header, baseUrl) {
  return header.split(';').map((part) => {
    const at = part.indexOf('=');
    if (at <= 0) throw new Error('Invalid cookie header');
    return {
      name: part.slice(0, at).trim(),
      value: part.slice(at + 1).trim(),
      url: baseUrl,
    };
  });
}

class BrowserPage {
  constructor({ cdp, sessionId, browserContextId, baseUrl, evidenceDir }) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.browserContextId = browserContextId;
    this.baseUrl = baseUrl;
    this.evidenceDir = evidenceDir;
  }

  async init() {
    for (const domain of ['Page', 'Runtime', 'Network']) {
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
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
      );
    }
    return response.result?.value;
  }

  async waitFor(fn, timeoutMs = 25_000, intervalMs = 200) {
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
    const loaded = this.cdp.once('Page.loadEventFired', this.sessionId, 35_000).catch(() => undefined);
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    await loaded;
    await this.waitFor(() => this.evaluate('document.readyState === "complete"'), 20_000);
    return url;
  }

  async screenshot(name) {
    const response = await this.cdp.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false, fromSurface: true },
      this.sessionId,
    );
    const filename = path.join(this.evidenceDir, `${safeName(name)}.png`);
    await writeFile(filename, Buffer.from(response.data, 'base64'));
    return filename;
  }
}

async function createActor({ cdp, cookie, orgId, baseUrl, evidenceDir }) {
  const context = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const target = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId: context.browserContextId,
  });
  const attached = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const page = new BrowserPage({
    cdp,
    sessionId: attached.sessionId,
    browserContextId: context.browserContextId,
    baseUrl,
    evidenceDir,
  });
  await page.init();
  await cdp.send(
    'Network.setCookies',
    { cookies: cookiesFromHeader(cookie, baseUrl) },
    page.sessionId,
  );
  await page.navigate('/');
  await page.waitFor(() => page.evaluate('Boolean(window.Clerk?.session)'), 35_000);
  await page.evaluate(`(async () => {
    if (window.Clerk?.organization?.id !== ${JSON.stringify(orgId)}) {
      await window.Clerk?.setActive({ organization: ${JSON.stringify(orgId)} });
    }
    return window.Clerk?.organization?.id ?? null;
  })()`);
  await page.waitFor(
    () => page.evaluate(`window.Clerk?.organization?.id === ${JSON.stringify(orgId)}`),
    25_000,
  );
  return page;
}

async function main() {
  await mkdir(SCREENSHOTS, { recursive: true });
  const chrome = await chromeLauncher.launch({
    chromeFlags: [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=1440,900',
    ],
    startingUrl: 'about:blank',
  });
  const cdp = await connectChrome(chrome.port);
  const requests = [];

  try {
    const page = await createActor({
      cdp,
      cookie: COOKIE,
      orgId: ORG_ID,
      baseUrl: BASE_URL,
      evidenceDir: SCREENSHOTS,
    });

    const networkKey = `${page.sessionId}:Network.requestWillBeSent`;
    const listener = (params) => {
      const request = params?.request ?? {};
      requests.push({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(
          Object.entries(request.headers ?? {}).filter(
            ([key]) => !/authorization|cookie/i.test(key),
          ),
        ),
      });
    };
    cdp.listeners.set(networkKey, [...(cdp.listeners.get(networkKey) ?? []), listener]);

    const bearerToken = await page.evaluate(`(async () => {
      const token = await window.Clerk?.session?.getToken({ template: 'capiro' });
      if (!token) throw new Error('Clerk capiro token unavailable');
      return token;
    })()`);
    if (typeof bearerToken !== 'string' || bearerToken.length < 20) {
      throw new Error('Authenticated browser did not produce a bearer token');
    }
    await writeFile(TOKEN_FILE, bearerToken, { mode: 0o600 });
    await chmod(TOKEN_FILE, 0o600).catch(() => undefined);

    const stateResults = [];
    for (const state of STATES) {
      const requestStart = requests.length;
      await page.navigate(state.pathname);
      await page
        .waitFor(
          () =>
            page.evaluate(`(() => {
              const body = document.body?.innerText ?? '';
              return document.readyState === 'complete' &&
                !body.includes('Loading') &&
                !body.includes('Signing in');
            })()`),
          30_000,
        )
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const browserState = await page.evaluate(`({
        pathname: location.pathname,
        href: location.href,
        hasSession: Boolean(window.Clerk?.session),
        body: (document.body?.innerText ?? '').slice(0, 4000),
      })`);
      if (!browserState?.hasSession) {
        throw new Error(`Clerk session disappeared at ${state.pathname}`);
      }
      if (browserState.pathname !== state.pathname) {
        throw new Error(
          `Expected ${state.pathname}, rendered ${String(browserState.pathname)} (${String(
            browserState.href,
          )})`,
        );
      }
      const body = String(browserState.body ?? '');
      if (body.trim().length < 20) {
        throw new Error(`Engagement application shell was empty at ${state.pathname}`);
      }
      if (
        body.includes('Something went wrong') ||
        body.includes('Application error') ||
        body.includes('Sign in to') ||
        body.includes('Create your account')
      ) {
        throw new Error(`Authentication/error page rendered at ${state.pathname}`);
      }

      const screenshot = await page.screenshot(`phase1-${state.label}`);
      const stateRequests = requests.slice(requestStart);
      stateResults.push({
        ...state,
        screenshot,
        renderedPathname: browserState.pathname,
        requestCount: stateRequests.length,
        errorBoundary: false,
        authenticated: true,
      });
    }

    const engagementRequests = requests.filter((entry) =>
      String(entry.url).includes('/api/engagement'),
    );
    if (engagementRequests.length === 0) {
      throw new Error('No authenticated Engagement API requests were observed');
    }

    const mainHost = new URL(MAIN_URL).host;
    const shadowHost = new URL(SHADOW_URL).host;
    const nonMainEngagementRequests = engagementRequests.filter(
      (entry) => requestHost(entry.url) !== mainHost,
    );
    const shadowRequests = requests.filter((entry) => {
      const url = String(entry.url);
      return requestHost(url) === shadowHost || url.includes(':4500') || /engagement-api/i.test(url);
    });
    const previewHeaders = requests.filter((entry) =>
      Object.keys(entry.headers ?? {}).some(
        (key) => key.toLowerCase() === 'x-capiro-engagement-preview',
      ),
    );

    if (nonMainEngagementRequests.length > 0) {
      throw new Error(
        `Engagement browser traffic did not exclusively target ${mainHost}: ${nonMainEngagementRequests
          .map((entry) => entry.url)
          .join(', ')}`,
      );
    }
    if (shadowRequests.length > 0) {
      throw new Error('The web application sent traffic to engagement-api port 4500');
    }
    if (previewHeaders.length > 0) {
      throw new Error('The web application sent the Phase 2 preview header');
    }

    const sourceChecks = [];
    for (const relative of ['apps/web/src/lib/api-client.ts', 'apps/web/src/lib/use-api.ts']) {
      const source = await readFile(path.resolve(process.cwd(), relative), 'utf8');
      for (const forbidden of [
        'VITE_ENGAGEMENT_API_URL',
        'X-Capiro-Engagement-Preview',
        ':4500',
      ]) {
        sourceChecks.push({ relative, forbidden, absent: !source.includes(forbidden) });
      }
    }
    if (sourceChecks.some((check) => !check.absent)) {
      throw new Error('Static web routing boundary contains a Phase 2 preview token');
    }

    const evidence = {
      marker: 'ENGAGEMENT_PHASE1_BROWSER_COMPLETE',
      mode: 'authenticated_existing_session_cookie',
      baseUrl: BASE_URL,
      mainApiUrl: MAIN_URL,
      shadowApiUrl: SHADOW_URL,
      states: stateResults,
      observedRequestCount: requests.length,
      engagementApiRequestCount: engagementRequests.length,
      engagementRequests,
      nonMainEngagementRequests,
      shadowRequests,
      previewHeaderRequests: previewHeaders,
      sourceChecks,
      currentOutreachRoute: '/engagement/outreach',
      previewRoutingEnabled: false,
      authenticated: true,
      externalBusinessProviderAction: false,
    };
    await writeFile(
      path.join(EVIDENCE, 'browser-parity.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log('ENGAGEMENT_PHASE1_BROWSER_COMPLETE');
  } finally {
    const result = chrome.kill();
    if (result && typeof result.then === 'function') await result;
  }
}

main().catch(async (error) => {
  await mkdir(EVIDENCE, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(EVIDENCE, 'browser-parity-failure.json'),
    `${JSON.stringify(
      {
        marker: 'ENGAGEMENT_PHASE1_BROWSER_FAILED',
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    )}\n`,
  ).catch(() => undefined);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
