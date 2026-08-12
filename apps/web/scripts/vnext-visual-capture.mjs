#!/usr/bin/env node
/**
 * vNext visual capture, driven directly over the Chrome DevTools Protocol.
 *
 * This previously went through Lighthouse and had been failing repo-wide with
 * "No Lighthouse screenshot data was available". Two independent causes, both
 * confirmed against lighthouse 12.8.2 rather than assumed:
 *
 *   1. `audits['full-page-screenshot']` no longer exists in Lighthouse 12 — the
 *      full-page screenshot moved to the top-level `lhr.fullPageScreenshot`. The
 *      script's primary path was dead code, leaving only the `final-screenshot`
 *      fallback.
 *   2. That fallback then died too: Lighthouse reported `runtimeError: NO_FCP`
 *      ("The page did not paint any content") against the Vite dev server, which
 *      puts every audit — `final-screenshot` included — into `scoreDisplayMode:
 *      'error'` with null details.
 *
 * Lighthouse is the wrong instrument here regardless: it is a performance
 * auditor, so it cannot promise an exact viewport or that webfonts have settled
 * before the pixels are taken. Both matter when the output is overlaid on a
 * Figma frame. CDP gives us both directly, using the `chrome-launcher` dependency
 * the repo already has and Node's built-in WebSocket — no new dependencies.
 *
 * Start Vite first, then run:
 *   VNEXT_VISUAL_BASE_URL=http://127.0.0.1:4173 pnpm --filter @capiro/web visual:vnext:capture
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as chromeLauncher from 'chrome-launcher';

const baseUrl = (process.env.VNEXT_VISUAL_BASE_URL ?? 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(process.env.VNEXT_VISUAL_OUTPUT_DIR ?? 'artifacts/vnext-visual');

/**
 * `expect` is a selector that must be present *after* load. It is what stops a
 * blank or half-mounted page from being written out and later mistaken for
 * evidence — a capture harness is not a passing visual regression, and a white
 * PNG is the easiest way to accidentally claim one.
 */
const targets = [
  {
    name: 'component-gallery-desktop',
    path: '/vnext-workshop.html',
    width: 1440,
    height: 1200,
    expect: '#root *',
  },
  {
    name: 'shell-desktop-expanded',
    path: '/vnext-shell.html',
    width: 1600,
    height: 1000,
    expect: '.capiro-vnext-uui',
  },
  {
    name: 'shell-desktop-collapsed',
    path: '/vnext-shell.html?collapsed=1',
    width: 1600,
    height: 1000,
    expect: '.capiro-vnext-uui[data-collapsed]',
  },
  { name: 'shell-tablet', path: '/vnext-shell.html', width: 900, height: 1000, expect: '.capiro-vnext-uui' },
  { name: 'shell-mobile', path: '/vnext-shell.html', width: 390, height: 844, expect: '.capiro-vnext-uui' },
  // Directory vNext (Figma 937:2539). Added under the README's own baseline
  // rule: a product screen earns a baseline once it is implemented from its
  // canonical node, which Congressional Staff now is.
  {
    name: 'directory-congressional-staff',
    path: '/vnext-shell.html?screen=congressional-staff',
    width: 1600,
    height: 1000,
    expect: '.capiro-directory-row',
  },
  {
    name: 'directory-congressional-staff-collapsed',
    path: '/vnext-shell.html?screen=congressional-staff&collapsed=1',
    width: 1600,
    height: 1000,
    expect: '.capiro-directory-row',
  },
  {
    name: 'directory-congressional-staff-empty',
    path: '/vnext-shell.html?screen=congressional-staff-empty',
    width: 1600,
    height: 1000,
    expect: '.capiro-directory-results',
  },
];

const NAV_TIMEOUT_MS = 30_000;

await mkdir(outputDir, { recursive: true });
const chrome = await chromeLauncher.launch({
  chromeFlags: [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    // Keeps rendering active for an unfocused headless window; a backgrounded
    // renderer is what starved Lighthouse of a first paint.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
  ],
});

const manifest = { generatedAt: new Date().toISOString(), baseUrl, captures: [] };

try {
  const wsUrl = await pageWebSocketUrl(chrome.port);
  const cdp = await connect(wsUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    for (const target of targets) {
      const url = `${baseUrl}${target.path}`;
      const pageErrors = [];
      const offError = cdp.on('Runtime.exceptionThrown', (params) => {
        pageErrors.push(
          params?.exceptionDetails?.exception?.description ??
            params?.exceptionDetails?.text ??
            'unknown page exception',
        );
      });

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: target.width,
        height: target.height,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const loaded = cdp.once('Page.loadEventFired', NAV_TIMEOUT_MS);
      await cdp.send('Page.navigate', { url });
      await loaded;

      // Webfonts, then two animation frames: text metrics must be final before
      // the pixels are taken or every overlay against Figma is off by a hair.
      await evaluate(cdp, 'document.fonts.ready.then(() => true)');
      await evaluate(
        cdp,
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
      );

      const rendered = await evaluate(
        cdp,
        `Boolean(document.querySelector(${JSON.stringify(target.expect)}))`,
      );
      if (rendered !== true) {
        throw new Error(
          `${target.name}: expected selector "${target.expect}" was absent after load — ` +
            `the page did not render${pageErrors.length ? `; page errors: ${pageErrors.join(' | ')}` : ''}`,
        );
      }
      if (pageErrors.length) {
        throw new Error(`${target.name}: page threw during load: ${pageErrors.join(' | ')}`);
      }

      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      });
      offError();

      const bytes = Buffer.from(data, 'base64');
      const filename = `${target.name}.png`;
      await writeFile(path.join(outputDir, filename), bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const documentHeight = await evaluate(cdp, 'document.documentElement.scrollHeight');

      manifest.captures.push({
        name: target.name,
        file: filename,
        mediaType: 'image/png',
        path: target.path,
        viewport: { width: target.width, height: target.height },
        capturedHeight: typeof documentHeight === 'number' ? documentHeight : null,
        sha256,
      });
      console.log(`${target.name}: ${bytes.length} bytes png sha256:${sha256}`);
    }
  } finally {
    cdp.close();
  }
} finally {
  await chrome.kill();
}

await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Wrote ${manifest.captures.length} vNext visual captures to ${outputDir}`);

/** Resolve the debugger websocket for the launched browser's first page target. */
async function pageWebSocketUrl(port) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome may not have opened its debugging port yet.
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for a Chrome page target');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Minimal CDP client over Node's built-in WebSocket. */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 0;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Could not connect to ${wsUrl}`)), {
      once: true,
    });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of listeners.get(message.method) ?? []) handler(message.params);
    }
  });

  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, handler) {
      const handlers = listeners.get(method) ?? [];
      handlers.push(handler);
      listeners.set(method, handlers);
      return () => listeners.set(method, (listeners.get(method) ?? []).filter((h) => h !== handler));
    },
    once(method, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${method}`));
        }, timeoutMs);
        const off = this.on(method, (params) => {
          clearTimeout(timer);
          off();
          resolve(params);
        });
      });
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `Evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
    );
  }
  return result.result?.value;
}
