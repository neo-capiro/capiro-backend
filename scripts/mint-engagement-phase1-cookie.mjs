#!/usr/bin/env node
/**
 * Mint ENGAGEMENT_PHASE1_USER_COOKIE by completing a Clerk sign-in token
 * in headless Chrome and reading the resulting __session cookie.
 * Never prints token/cookie values — only writes them to COOKIE_OUT.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const chromeLauncher = webRequire('chrome-launcher');
const { connectChrome } = await import(
  pathToFileURL(path.join(root, 'apps/web/scripts/phase19-cdp.mjs')).href
);

const secret = process.env.CLERK_SECRET_KEY?.trim();
const userId = (
  process.env.ENGAGEMENT_PHASE1_USER_CLERK_ID ||
  process.env.ENGAGEMENT_PHASE0_USER_CLERK_ID ||
  ''
).trim();
const orgId = (
  process.env.ENGAGEMENT_PHASE1_CLERK_ORG_ID ||
  process.env.ENGAGEMENT_PHASE0_CLERK_ORG_ID ||
  ''
).trim();
const outFile = process.env.ENGAGEMENT_PHASE1_COOKIE_OUT?.trim();
const appOrigin = process.env.ENGAGEMENT_PHASE1_APP_ORIGIN?.trim() || 'https://app.capiro.ai';

if (!secret || !userId || !outFile) {
  console.error('CLERK_SECRET_KEY, user clerk id, and ENGAGEMENT_PHASE1_COOKIE_OUT are required');
  process.exit(2);
}

async function backend(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

const sit = await backend('POST', 'https://api.clerk.com/v1/sign_in_tokens', {
  user_id: userId,
  expires_in_seconds: 3600,
});
if (sit.status >= 300 || !sit.body?.url) {
  console.error(`sign_in_token failed status=${sit.status}`);
  process.exit(1);
}

const ticketUrl = sit.body.url;
const chrome = await chromeLauncher.launch({
  chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1280,800'],
  startingUrl: 'about:blank',
});

try {
  const cdp = await connectChrome(chrome.port);
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;
  for (const domain of ['Page', 'Network', 'Runtime']) {
    await cdp.send(`${domain}.enable`, {}, sessionId);
  }

  await cdp.send('Page.navigate', { url: ticketUrl }, sessionId);
  const deadline = Date.now() + 60_000;
  let sessionCookie = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 750));
    const cookies = await cdp.send('Network.getAllCookies', {}, sessionId);
    const list = cookies.cookies || [];
    const session = list.find((c) => c.name === '__session' && c.value && c.value.length > 20);
    if (session) {
      const preferred =
        list.find(
          (c) =>
            c.name === '__session' &&
            c.value &&
            (String(c.domain || '').includes('capiro.ai') ||
              String(c.domain || '').includes('clerk')),
        ) || session;
      sessionCookie = `__session=${preferred.value}`;
      const client = list.find((c) => c.name === '__client' && c.value);
      if (client) sessionCookie += `; __client=${client.value}`;
      break;
    }
    try {
      await cdp.send(
        'Runtime.evaluate',
        { expression: 'location.href', returnByValue: true },
        sessionId,
      );
    } catch {
      /* ignore */
    }
  }

  if (!sessionCookie) {
    const cookies = await cdp.send('Network.getAllCookies', {}, sessionId);
    const names = (cookies.cookies || []).map((c) => `${c.name}@${c.domain}`);
    console.error(`no __session cookie after ticket flow; cookies=${names.join(',')}`);
    process.exit(1);
  }

  writeFileSync(outFile, sessionCookie, { mode: 0o600 });
  console.error('minted_session_cookie_ok');
  if (orgId) console.error('org_target_present=true');
  void appOrigin;
} finally {
  try {
    const result = chrome.kill();
    if (result && typeof result.then === 'function') await result;
  } catch {
    /* ignore */
  }
}
