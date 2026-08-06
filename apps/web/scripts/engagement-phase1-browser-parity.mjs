#!/usr/bin/env node
/**
 * Authenticated Chrome/CDP proof that the unchanged web application still uses
 * only the main API during Phase 1. Missing credentials, a sign-in redirect, an
 * unfinished application shell, or missing per-surface Engagement API traffic
 * are hard failures.
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
const COOKIE = optionalAny(
  'ENGAGEMENT_PHASE1_USER_COOKIE',
  'ENGAGEMENT_PHASE0_USER_COOKIE',
);
// Sign-in-token mode. Clerk session JWTs live ~60s and a bare __session value cannot survive a
// multi-minute run, so rather than depending on a captured cookie the harness can mint a
// single-use Clerk sign-in token for the seeded user and let the browser redeem it into a real
// session. This is a first-class Clerk feature, not an auth bypass: Clerk performs the sign-in
// and sets its own cookies. Requires no Clerk dashboard change and no organization.
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY?.trim() ?? '';
const CLERK_API_URL = process.env.CLERK_API_URL?.trim() || 'https://api.clerk.com';
const ACCEPTANCE_USER_CLERK_ID = optionalAny(
  'ENGAGEMENT_PHASE1_USER_CLERK_ID',
  'ENGAGEMENT_PHASE0_USER_CLERK_ID',
);
const BROWSER_AUTH = process.env.ENGAGEMENT_PHASE1_BROWSER_AUTH?.trim() || 'auto';
// Organization id is OPTIONAL. A valid Clerk session with no active organization is a
// supported acceptance mode: TenantContextMiddleware already selects the user's sole active
// membership when no tenant id, org id, tenant slug, or X-Capiro-Tenant hint is supplied.
// When an org id IS given, the original organization-based path is preserved unchanged.
const ORG_ID = optionalAny(
  'ENGAGEMENT_PHASE1_CLERK_ORG_ID',
  'ENGAGEMENT_PHASE0_CLERK_ORG_ID',
);
const ORGLESS = !ORG_ID;
// Negative-control rehearsal: deliberately emit shadow traffic from the page so the
// routing verifier below has something real to reject. Used by NC8; never set in a
// normal acceptance run.
const NC8_REHEARSAL = process.env.ENGAGEMENT_PHASE1_NC8_REHEARSAL === '1';
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

function optionalAny(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

/**
 * Fail fast on a session cookie that cannot possibly authenticate.
 *
 * Without this, an unusable cookie surfaces only as a 35s "Timed out" while waiting for
 * window.Clerk.session, which looks identical to a slow dev server, a missing publishable key,
 * or a Clerk outage. Clerk bootstraps a session from the long-lived client cookie
 * (`__client` / `__clerk_db_jwt`) and mints short-lived `__session` JWTs from it, so either a
 * client cookie or an unexpired `__session` JWT is enough. Values are never logged.
 */
function inspectSessionCookie(header) {
  const entries = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('='));
  const names = entries.map((entry) => entry.slice(0, entry.indexOf('=')));

  const clientCookie = entries.find(
    (entry) => entry.startsWith('__client=') || entry.startsWith('__clerk_db_jwt='),
  );
  const sessionCookie = entries.find((entry) => entry.startsWith('__session='));

  let sessionState = entries.length === 0 ? 'empty-header' : 'absent';
  if (sessionCookie) {
    const value = sessionCookie.slice(sessionCookie.indexOf('=') + 1);
    const segments = value.split('.');
    if (segments.length !== 3) {
      sessionState = `not-a-jwt (1 segment, length ${value.length})`;
    } else {
      try {
        const payload = JSON.parse(
          Buffer.from(segments[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
            'utf8',
          ),
        );
        const now = Math.floor(Date.now() / 1000);
        sessionState =
          typeof payload.exp === 'number' && payload.exp <= now
            ? `expired at ${new Date(payload.exp * 1000).toISOString()}`
            : 'valid';
      } catch {
        sessionState = 'undecodable-payload';
      }
    }
  }

  return {
    cookieNames: names,
    sessionState,
    clientCookiePresent: Boolean(clientCookie),
    usable: Boolean(clientCookie) || sessionState === 'valid',
  };
}

function assertSessionCookieUsable(header) {
  const state = inspectSessionCookie(header);
  if (!state.usable) {
    throw new Error(
      'The browser proof cannot authenticate with the supplied cookie header. Present ' +
        `cookies: [${state.cookieNames.join(', ')}]; __session is ${state.sessionState}; no ` +
        '__client / __clerk_db_jwt cookie was supplied.\n' +
        'Clerk needs either the long-lived client cookie (which it uses to mint session ' +
        'tokens) or an unexpired __session JWT. A placeholder, truncated, or expired value ' +
        'cannot produce window.Clerk.session, so the M9 browser gate cannot be measured.\n' +
        'Either capture the cookie header from a signed-in browser session for the seeded ' +
        'acceptance user, or set CLERK_SECRET_KEY and ENGAGEMENT_PHASE1_USER_CLERK_ID so the ' +
        'harness can mint a sign-in token instead.',
    );
  }
  return state;
}

/**
 * Decide how the browser will authenticate, and say so out loud rather than switching silently.
 *
 * `cookie` reuses a captured session; `signin_token` mints a single-use Clerk sign-in token for
 * the seeded user. `auto` prefers a usable cookie and falls back to the token.
 */
function resolveBrowserAuthMode() {
  const cookieUsable = COOKIE ? inspectSessionCookie(COOKIE).usable : false;
  const tokenPossible = Boolean(CLERK_SECRET_KEY && ACCEPTANCE_USER_CLERK_ID);

  if (BROWSER_AUTH === 'cookie') {
    if (!COOKIE) throw new Error('ENGAGEMENT_PHASE1_BROWSER_AUTH=cookie needs a session cookie');
    assertSessionCookieUsable(COOKIE);
    return 'cookie';
  }
  if (BROWSER_AUTH === 'signin_token') {
    if (!tokenPossible) {
      throw new Error(
        'ENGAGEMENT_PHASE1_BROWSER_AUTH=signin_token needs CLERK_SECRET_KEY and a seeded ' +
          'user id (ENGAGEMENT_PHASE1_USER_CLERK_ID)',
      );
    }
    return 'signin_token';
  }
  if (BROWSER_AUTH !== 'auto') {
    throw new Error(
      `Unknown ENGAGEMENT_PHASE1_BROWSER_AUTH=${BROWSER_AUTH}; expected auto, cookie, or signin_token`,
    );
  }
  if (cookieUsable) return 'cookie';
  if (tokenPossible) return 'signin_token';
  // Neither path is available: report the cookie's specific defect.
  assertSessionCookieUsable(COOKIE || '');
  throw new Error('No usable browser authentication method is configured');
}

/**
 * Mint a single-use Clerk sign-in token. Each browser invocation mints its own, because the
 * token is consumed on redemption.
 */
async function mintSignInToken() {
  const response = await fetch(`${CLERK_API_URL}/v1/sign_in_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: ACCEPTANCE_USER_CLERK_ID,
      expires_in_seconds: 3600,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    // Clerk error bodies name the offending parameter but can echo identifiers; keep the
    // status and the error slugs, drop everything else.
    let detail = '';
    try {
      const parsed = JSON.parse(text);
      detail = (parsed.errors ?? [])
        .map((entry) => entry.code ?? entry.message ?? '')
        .filter(Boolean)
        .join(', ');
    } catch {
      detail = '';
    }
    throw new Error(
      `Clerk sign-in token mint failed with ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  const parsed = JSON.parse(text);
  const ticket = parsed?.token;
  if (typeof ticket !== 'string' || ticket.length < 20) {
    throw new Error('Clerk sign-in token response contained no usable ticket');
  }
  return ticket;
}

/**
 * Acceptance-runtime-only shim, injected into the disposable CDP browser and nowhere else.
 *
 * The unchanged product calls `getToken({ template: 'capiro' })`. In an orgless session that
 * template cannot resolve organization-derived claims, so for the acceptance run only we
 * delegate that one case to the default `getToken()`, whose claims carry no tenant/org hint
 * and therefore land on the middleware's sole-membership fallback. Every other invocation
 * keeps its original behavior.
 *
 * Installed via Page.addScriptToEvaluateOnNewDocument because each surface navigation is a
 * full document load, which would discard a shim applied with Runtime.evaluate.
 *
 * Nothing under apps/web/src is touched, so this cannot reach the product bundle.
 */
function orglessTokenShimSource() {
  return `(() => {
    const FLAG = '__capiroAcceptanceOrglessTokenShim';
    if (window[FLAG]) return;
    const stats = { installed: false, delegated: 0, passthrough: 0 };
    window[FLAG] = stats;
    const patch = (session) => {
      if (!session || typeof session.getToken !== 'function') return;
      if (session.__capiroAcceptanceShimmed) return;
      const original = session.getToken.bind(session);
      session.getToken = function (options) {
        try {
          const wantsCapiro = Boolean(options) && options.template === 'capiro';
          const hasOrg = Boolean(
            window.Clerk && window.Clerk.organization && window.Clerk.organization.id,
          );
          if (wantsCapiro && !hasOrg) {
            stats.delegated += 1;
            return original();
          }
        } catch (error) {
          // fall through to the original call
        }
        stats.passthrough += 1;
        return original(options);
      };
      session.__capiroAcceptanceShimmed = true;
      stats.installed = true;
    };
    const tick = () => {
      try {
        patch(window.Clerk && window.Clerk.session);
      } catch (error) {
        // Clerk not ready yet
      }
    };
    tick();
    const timer = setInterval(tick, 25);
    setTimeout(() => clearInterval(timer), 60000);
  })();`;
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

async function createActor({ cdp, cookie, orgId, baseUrl, evidenceDir, authMode, ticket }) {
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

  if (authMode === 'cookie') {
    await cdp.send(
      'Network.setCookies',
      { cookies: cookiesFromHeader(cookie, baseUrl) },
      page.sessionId,
    );
    await page.navigate('/');
  } else {
    // Clerk's client detects the __clerk_ticket query parameter and completes the sign-in
    // itself, setting its own cookies. No password, no organization, no dashboard change.
    // The ticket is never logged and never reaches evidence: the network listener is attached
    // after this navigation.
    await page.navigate(`/?__clerk_ticket=${encodeURIComponent(ticket)}`);
    await page
      .waitFor(() => page.evaluate('Boolean(window.Clerk?.loaded)', false), 45_000)
      .catch(() => undefined);
  }

  const sessionReady = async (timeoutMs) => {
    try {
      await page.waitFor(() => page.evaluate('Boolean(window.Clerk?.session)'), timeoutMs);
      return true;
    } catch {
      return false;
    }
  };

  let established = await sessionReady(45_000);
  if (!established && authMode === 'signin_token') {
    // Fall back to redeeming the ticket explicitly through the Clerk client, in case the
    // application consumed or stripped the query parameter during its own routing.
    const outcome = await page
      .evaluate(
        `(async () => {
          try {
            const signIn = await window.Clerk.client.signIn.create({
              strategy: 'ticket',
              ticket: ${JSON.stringify(ticket)},
            });
            if (signIn.status === 'complete' && signIn.createdSessionId) {
              await window.Clerk.setActive({ session: signIn.createdSessionId });
              return 'complete';
            }
            return 'status:' + String(signIn.status);
          } catch (error) {
            return 'error:' + String(error && error.message ? error.message : error);
          }
        })()`,
      )
      .catch((error) => `evaluate-failed:${error.message}`);
    console.log(`==> Sign-in token explicit redemption: ${outcome}`);
    established = await sessionReady(45_000);
  }

  if (!established) {
    // Distinguish "Clerk never loaded" from "Clerk loaded but authentication produced no
    // session".
    const diagnostic = await page
      .evaluate(
        `({
          clerkPresent: Boolean(window.Clerk),
          clerkLoaded: Boolean(window.Clerk?.loaded),
          hasUser: Boolean(window.Clerk?.user),
          pathname: location.pathname,
          bodyStart: (document.body?.innerText ?? '').slice(0, 300),
        })`,
        false,
      )
      .catch(() => null);
    await page.screenshot('phase1-session-wait-failure').catch(() => undefined);
    throw new Error(
      `Clerk session never became available (authMode=${authMode}). Page state: ` +
        `${JSON.stringify(diagnostic)}. If clerkPresent is true and hasUser is false, the ` +
        'credential did not authenticate; if clerkPresent is false, Clerk itself never ' +
        'loaded (check the publishable key and the web dev server).',
    );
  }

  if (orgId) {
    // Unchanged organization-based path.
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
    return { page, orgless: false, shimInstalled: false };
  }

  // Orgless mode: assert the session genuinely has no active organization. Never call
  // setActive, never wait on Clerk.organization, never fabricate organization state.
  const activeOrganization = await page.evaluate(
    'window.Clerk?.organization?.id ?? null',
    false,
  );
  if (activeOrganization) {
    throw new Error(
      'Orgless acceptance requires a session with no active organization; found ' +
        String(activeOrganization),
    );
  }
  // Each surface navigation is a full document load, so register the shim for every new
  // document, then also apply it to the document already open.
  await cdp.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: orglessTokenShimSource() },
    page.sessionId,
  );
  await page.evaluate(orglessTokenShimSource(), false);
  await page.waitFor(
    () => page.evaluate('Boolean(window.__capiroAcceptanceOrglessTokenShim?.installed)', false),
    20_000,
  );
  return { page, orgless: true, shimInstalled: true };
}

async function main() {
  await mkdir(SCREENSHOTS, { recursive: true });
  // Cheapest possible failure: resolve and validate authentication before spending a browser
  // launch, and state the chosen mode rather than switching silently.
  const authMode = resolveBrowserAuthMode();
  if (COOKIE) {
    const cookieState = inspectSessionCookie(COOKIE);
    console.log(
      `==> Session cookie: cookies=[${cookieState.cookieNames.join(', ')}] ` +
        `__session=${cookieState.sessionState} clientCookie=${cookieState.clientCookiePresent} ` +
        `usable=${cookieState.usable}`,
    );
  }
  console.log(`==> Browser auth mode: ${authMode}`);
  const ticket = authMode === 'signin_token' ? await mintSignInToken() : '';
  if (ticket) {
    console.log('==> Minted a single-use Clerk sign-in token for the seeded acceptance user');
  }
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
    const actor = await createActor({
      cdp,
      cookie: COOKIE,
      orgId: ORG_ID,
      baseUrl: BASE_URL,
      evidenceDir: SCREENSHOTS,
      authMode,
      ticket,
    });
    const page = actor.page;
    if (actor.orgless !== ORGLESS) {
      throw new Error('Actor auth mode did not match the configured organization posture');
    }

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

    // Orgless mode takes the default session token: the `capiro` template resolves
    // organization-derived claims that do not exist here, and a claimless token is exactly
    // what the sole-membership fallback needs.
    const bearerToken = await page.evaluate(
      ORGLESS
        ? `(async () => {
      const token = await window.Clerk?.session?.getToken();
      if (!token) throw new Error('Clerk default session token unavailable');
      return token;
    })()`
        : `(async () => {
      const token = await window.Clerk?.session?.getToken({ template: 'capiro' });
      if (!token) throw new Error('Clerk capiro token unavailable');
      return token;
    })()`,
    );
    if (typeof bearerToken !== 'string' || bearerToken.length < 20) {
      throw new Error('Authenticated browser did not produce a bearer token');
    }
    await writeFile(TOKEN_FILE, bearerToken, { mode: 0o600 });
    await chmod(TOKEN_FILE, 0o600).catch(() => undefined);

    const stateResults = [];
    for (const state of STATES) {
      const requestStart = requests.length;
      await page.navigate(state.pathname);
      await page.waitFor(
        () =>
          page.evaluate(`(() => {
            const body = document.body?.innerText ?? '';
            return document.readyState === 'complete' &&
              !body.includes('Loading') &&
              !body.includes('Signing in');
          })()`),
        30_000,
      );
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
        body.includes('Loading') ||
        body.includes('Signing in') ||
        body.includes('Something went wrong') ||
        body.includes('Application error') ||
        body.includes('Sign in to') ||
        body.includes('Create your account')
      ) {
        throw new Error(`Authentication/error/loading page rendered at ${state.pathname}`);
      }

      const stateRequests = requests.slice(requestStart);
      const stateEngagementRequests = stateRequests.filter((entry) =>
        String(entry.url).includes('/api/engagement'),
      );
      if (stateEngagementRequests.length === 0) {
        throw new Error(`No Engagement API request was observed for ${state.pathname}`);
      }
      // Shim state is per-document, so read it on each surface rather than once at the end.
      const tokenShim = ORGLESS
        ? await page.evaluate(
            `(() => {
              const s = window.__capiroAcceptanceOrglessTokenShim;
              return s
                ? { installed: Boolean(s.installed), delegated: s.delegated, passthrough: s.passthrough }
                : null;
            })()`,
            false,
          )
        : null;
      if (ORGLESS && tokenShim?.installed !== true) {
        throw new Error(
          `Acceptance token shim was not installed at ${state.pathname}; refusing to ` +
            'report an orgless browser proof that ran without it',
        );
      }
      const screenshot = await page.screenshot(`phase1-${state.label}`);
      stateResults.push({
        ...state,
        screenshot,
        renderedPathname: browserState.pathname,
        requestCount: stateRequests.length,
        engagementApiRequestCount: stateEngagementRequests.length,
        engagementRequests: stateEngagementRequests,
        tokenShim,
        errorBoundary: false,
        authenticated: browserState.hasSession === true,
        fullyLoaded: true,
      });
    }

    if (NC8_REHEARSAL) {
      // Emit real shadow traffic from the page so the routing assertions below have an actual
      // violation to detect. This run is EXPECTED to fail from here; that rejection is what
      // NC8 measures. Nothing about this path can run in a normal acceptance run.
      console.log('==> NC8 rehearsal: emitting shadow-service traffic from the page');
      await page.evaluate(
        `(async () => {
          try {
            await fetch(${JSON.stringify(`${SHADOW_URL}/api/engagement/meetings`)}, {
              mode: 'no-cors',
            });
          } catch (error) {
            // A network or CORS error is fine: Network.requestWillBeSent already fired.
          }
          return true;
        })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500));
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

    // Reaching this line during a rehearsal means the injected violation went undetected,
    // which is a verifier failure, not a pass.
    if (NC8_REHEARSAL) {
      throw new Error(
        'NC8 rehearsal emitted shadow-service traffic but the routing verifier did not ' +
          'reject it; the negative control is not effective',
      );
    }

    const tokenShimInstalled = ORGLESS
      ? stateResults.length > 0 && stateResults.every((state) => state.tokenShim?.installed === true)
      : false;
    const tokenShimDelegations = stateResults.reduce(
      (total, state) => total + (state.tokenShim?.delegated ?? 0),
      0,
    );
    if (ORGLESS && !tokenShimInstalled) {
      throw new Error('Orgless proof completed without the acceptance token shim installed');
    }

    const evidence = {
      marker: 'ENGAGEMENT_PHASE1_BROWSER_COMPLETE',
      browserProofPerformed: true,
      authMode: `${ORGLESS ? 'orgless' : 'organization'}_${
        authMode === 'signin_token' ? 'signin_token_session' : 'existing_clerk_session'
      }`,
      browserAuthMethod: authMode,
      organizationRequired: false,
      acceptanceTokenShim: tokenShimInstalled,
      acceptanceTokenShimDelegations: tokenShimDelegations,
      clerkOrganizationUsed: ORGLESS ? null : ORG_ID,
      clerkConfigurationChanged: false,
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
      authenticated:
        stateResults.length > 0 && stateResults.every((state) => state.authenticated === true),
      everySurfaceLoaded: stateResults.every((state) => state.fullyLoaded),
      everySurfaceCalledMainApi: stateResults.every(
        (state) => state.engagementApiRequestCount > 0,
      ),
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
