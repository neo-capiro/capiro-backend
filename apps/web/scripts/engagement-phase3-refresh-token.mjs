#!/usr/bin/env node
/**
 * Mint a fresh dedicated Phase 3 acceptance bearer immediately before API/DB
 * sweeps. Browser interaction acceptance can run for minutes; reusing the token
 * it obtained at startup risks turning later parity into matching 401s.
 *
 * The bearer is written only to the OS-temp path supplied by the local runner
 * and is deleted by runner cleanup. It is never included in evidence.
 */
import { chmod, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chromeLauncher = require('chrome-launcher');

const BASE_URL = process.env.ENGAGEMENT_PHASE3_BASE_URL ?? 'http://127.0.0.1:5173';
const TOKEN_FILE = required('ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE');
const CLERK_SECRET_KEY = required('CLERK_SECRET_KEY');
const CLERK_API_URL = process.env.CLERK_API_URL?.trim() || 'https://api.clerk.com';
const ADMIN_CLERK_USER_ID = required('ENGAGEMENT_PHASE3_ADMIN_CLERK_USER_ID');
const PRIMARY_CLERK_ORG_ID = required('ENGAGEMENT_PHASE3_PRIMARY_CLERK_ORG_ID');

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
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result ?? {});
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

async function waitFor(cdp, sessionId, expression, timeoutMs = 50_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    if (result.result?.value) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function main() {
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1280,800'],
    startingUrl: 'about:blank',
  });
  try {
    const cdp = await connectChrome(chrome.port);
    const context = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const target = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId: context.browserContextId,
    });
    const attached = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const ticket = await mintTicket();
    await cdp.send(
      'Page.navigate',
      { url: `${BASE_URL}/?__clerk_ticket=${encodeURIComponent(ticket)}` },
      sessionId,
    );
    await waitFor(cdp, sessionId, 'Boolean(window.Clerk?.session)');
    await evaluate(
      cdp,
      sessionId,
      `(async () => {
        if (window.Clerk?.organization?.id !== ${JSON.stringify(PRIMARY_CLERK_ORG_ID)}) {
          await window.Clerk?.setActive({ organization: ${JSON.stringify(PRIMARY_CLERK_ORG_ID)} });
        }
        return window.Clerk?.organization?.id === ${JSON.stringify(PRIMARY_CLERK_ORG_ID)};
      })()`,
    );
    await waitFor(
      cdp,
      sessionId,
      `window.Clerk?.organization?.id === ${JSON.stringify(PRIMARY_CLERK_ORG_ID)}`,
      30_000,
    );
    const token = await evaluate(
      cdp,
      sessionId,
      `(async () => window.Clerk?.session?.getToken({ template: 'capiro' }))()`,
    );
    if (typeof token !== 'string' || token.length < 20) {
      throw new Error('Fresh Phase 3 capiro bearer was unavailable');
    }
    await writeFile(TOKEN_FILE, token, { mode: 0o600 });
    await chmod(TOKEN_FILE, 0o600).catch(() => undefined);
    console.log('ENGAGEMENT_PHASE3_BEARER_REFRESHED');
  } finally {
    const killed = chrome.kill();
    if (killed && typeof killed.then === 'function') await killed;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
