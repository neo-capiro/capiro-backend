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
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const USAGE = 'Usage: node apps/web/scripts/vnext-visual-capture.mjs --capture (writes PNGs and manifest.json to VNEXT_VISUAL_OUTPUT_DIR or ./artifacts/vnext-visual)';
const cliArgs = process.argv.slice(2);
if (cliArgs.length === 1 && (cliArgs[0] === '--help' || cliArgs[0] === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (cliArgs.length !== 1 || cliArgs[0] !== '--capture') {
  console.error(USAGE);
  if (cliArgs.length) console.error(`[vnext-visual-capture] unknown argument: ${cliArgs.join(' ')}`);
  process.exit(2);
}

const chromeLauncher = await import('chrome-launcher');

const baseUrl = (process.env.VNEXT_VISUAL_BASE_URL ?? 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(process.env.VNEXT_VISUAL_OUTPUT_DIR ?? 'artifacts/vnext-visual');

/**
 * `expect` is a selector that must be present *after* load. It is what stops a
 * blank or half-mounted page from being written out and later mistaken for
 * evidence — a capture harness is not a passing visual regression, and a white
 * PNG is the easiest way to accidentally claim one.
 */
const targets = [
  // Q16/Q17 bug-regression captures, not Figma pixel baselines.
  ...[1440, 390].flatMap((width) => [
    {
      name: `client-attribution-q17-${width}`,
      path: '/vnext-shell.html?screen=client-crm&crmOverlay=advocacy',
      width, height: 1400,
      expect: '.capiro-advocacy-record__head',
      qaLayout: 'attribution',
    },
    {
      name: `client-facility-evidence-q16-${width}`,
      path: '/vnext-shell.html?screen=client-facilities',
      width, height: 1400,
      expect: '.capiro-intel-fac-location .capiro-facility-verification',
      qaLayout: 'facility-evidence',
    },
    {
      name: `client-facilities-q16-${width}`,
      path: '/vnext-shell.html?screen=client-crm&crmOverlay=facilities',
      width, height: 1400,
      expect: '.capiro-facmod__list .capiro-facility-verification',
      qaLayout: 'facilities',
    },
  ]),

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
  {
    name: 'client-record-desktop',
    path: '/vnext-shell.html?screen=client-crm&crmTab=relationships&relView=history',
    width: 2048,
    height: 1189,
    expect: '.cap-pf-record-directory [aria-current="page"]',
  },
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
  // Hill Day workspace v2 — library, wizard, editor at the acceptance widths.
  {
    name: 'hillday-library-1440',
    path: '/vnext-shell.html?screen=hillday-library',
    width: 1440,
    height: 1000,
    expect: '.hd-library',
  },
  {
    name: 'hillday-wizard-1440',
    path: '/vnext-shell.html?screen=hillday-wizard',
    width: 1440,
    height: 1000,
    expect: '.hd-flow',
  },
  {
    name: 'hillday-editor-1440',
    path: '/vnext-shell.html?screen=hillday-editor',
    width: 1440,
    height: 1000,
    expect: '.hd-editor',
  },
  {
    name: 'hillday-editor-1180',
    path: '/vnext-shell.html?screen=hillday-editor',
    width: 1180,
    height: 1000,
    expect: '.hd-editor',
  },
  {
    name: 'hillday-editor-900',
    path: '/vnext-shell.html?screen=hillday-editor',
    width: 900,
    height: 1000,
    expect: '.hd-editor',
  },
  {
    name: 'hillday-editor-760',
    path: '/vnext-shell.html?screen=hillday-editor',
    width: 760,
    height: 900,
    expect: '.hd-editor',
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
    // A system proxy can intercept the loopback URL and land the tab on
    // chrome-error://chromewebdata (observed 2026-09-01) — force a direct
    // connection so the harness never routes through one.
    '--proxy-server=direct://',
    '--proxy-bypass-list=*',
  ],
});

const manifest = { generatedAt: new Date().toISOString(), baseUrl, captures: [] };

try {
  const wsUrl = await pageWebSocketUrl(chrome.port);
  console.log(`[capture] ws target: ${wsUrl.slice(0, 80)}`);
  const cdp = await connect(wsUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

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

      // A module script that fails to load (for example a vite dependency chunk
      // invalidated by a mid-run re-optimization) never raises an exception;
      // keep console errors and failed requests for the failure message.
      const loadDiagnostics = [];
      const offConsole = cdp.on('Runtime.consoleAPICalled', (params) => {
        if (params?.type !== 'error') return;
        const text = (params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        loadDiagnostics.push(`console: ${text.slice(0, 200)}`);
      });
      const offNetwork = cdp.on('Network.loadingFailed', (params) => {
        loadDiagnostics.push(
          `request failed: ${params?.errorText ?? 'unknown'} (${params?.type ?? '?'})`,
        );
      });

      for (let loadAttempt = 1; ; loadAttempt++) {
        // Start from a blank document: consecutive targets can share a URL, and
        // a same-URL navigation would pass the landed check on the old page.
        const blank = cdp.once('Page.loadEventFired', 5_000);
        await cdp.send('Page.navigate', { url: 'about:blank' });
        await blank.catch(() => undefined);
        const loaded = cdp.once('Page.loadEventFired', NAV_TIMEOUT_MS);
        // Chrome occasionally refuses the first navigation on a freshly launched
        // headless instance (ERR_CONNECTION_REFUSED while the network stack warms
        // up); retry until the tab actually lands on the URL.
        for (let navAttempt = 0; ; navAttempt++) {
          await cdp.send('Page.navigate', { url });
          await new Promise((r) => setTimeout(r, navAttempt === 0 ? 1500 : 750));
          const landed = await evaluate(cdp, `location.href.startsWith(${JSON.stringify(url.slice(0, 40))})`);
          if (landed === true || navAttempt >= 8) break;
        }
        await loaded;

        // Dev-server settle wait: on vite dev the module graph can finish executing
        // AFTER the load event (on-demand transform), so poll for the expect selector
        // for up to 45s before declaring the page unrendered.
        const settleDeadline = Date.now() + 45_000;
        let present = false;
        for (;;) {
          present =
            (await evaluate(
              cdp,
              `Boolean(document.querySelector(${JSON.stringify(target.expect)}))`,
            )) === true;
          if (present || Date.now() > settleDeadline) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        // One fresh reload when the page stayed empty; the selector is still
        // required for the capture below.
        if (present || loadAttempt >= 2) break;
        console.warn(
          `[capture] ${target.name}: "${target.expect}" absent after load; reloading once` +
            ([...pageErrors, ...loadDiagnostics].length
              ? ` (${[...pageErrors, ...loadDiagnostics].slice(-5).join(' | ')})`
              : ''),
        );
        // Errors from the discarded attempt are reported above, not against
        // the fresh load.
        pageErrors.length = 0;
      }
      offConsole();
      offNetwork();

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
        const probe = await evaluate(
          cdp,
          'JSON.stringify({ url: location.href, readyState: document.readyState, title: document.title.slice(0,80), bodyText: document.body?.innerText?.slice(0,200) ?? "" })',
        );
        throw new Error(
          `${target.name}: expected selector "${target.expect}" was absent after load — ` +
            `the page did not render${pageErrors.length ? `; page errors: ${pageErrors.join(' | ')}` : ''}` +
            `${loadDiagnostics.length ? `; load diagnostics: ${loadDiagnostics.slice(-10).join(' | ')}` : ''}; probe: ${probe}`,
        );
      }
      if (pageErrors.length) {
        throw new Error(`${target.name}: page threw during load: ${pageErrors.join(' | ')}`);
      }


      if (target.qaLayout) {
        const failures = await evaluate(cdp, `(() => {
          const failures = [];
          const visibleOverflow = [...document.querySelectorAll('[role="dialog"]')].some(el => el.scrollWidth > el.clientWidth + 2);
          if (visibleOverflow) failures.push('dialog has horizontal overflow');
          if (${JSON.stringify(target.qaLayout)} === 'attribution') {
            const title = document.querySelector('.capiro-advocacy-record__title').getBoundingClientRect();
            const badges = document.querySelector('.capiro-advocacy-record__badges').getBoundingClientRect();
            const badge = document.querySelector('.capiro-advocacy-record__badges .capiro-badge').getBoundingClientRect();
            const head = document.querySelector('.capiro-advocacy-record__head').getBoundingClientRect();
            if (title.width < head.width - 2) failures.push('badges squeeze the record title');
            if (badges.top < title.bottom) failures.push('badge shares and crowds the title line');
            if (badge.height > 44) failures.push('attribution badge is oversized');
            const buttons = [...document.querySelectorAll('[aria-label="Matter actions"] button')].map(el => el.getBoundingClientRect());
            if (buttons.length !== 2) failures.push('matter actions are missing');
            if (buttons.length === 2 && buttons[1].left < buttons[0].right + 6 && buttons[1].top < buttons[0].bottom + 6) failures.push('matter actions overlap or lack spacing');
          } else {
            const text = document.querySelector(${JSON.stringify(target.qaLayout === 'facilities' ? '.capiro-facmod__list' : '.capiro-intel-stack-24')}).textContent;
            for (const label of ['Geocoder: Matched', 'U.S. House source: Manual', 'State House: Not resolved', 'State Senate: Not resolved', 'Geocoder: Review required']) {
              if (!text.includes(label)) failures.push('missing evidence label: ' + label);
            }
          }
          return failures;
        })()`);
        if (failures.length) throw new Error(target.name + ': ' + failures.join('; '));
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
  // Windows: chrome-launcher's kill() rmSync's its profile tmpdir while the
  // OS still holds handles, and the EPERM crashed the whole run after (or
  // before) captures landed. Cleanup is best-effort here — the captures and
  // the manifest matter, the tempdir does not.
  try {
    await chrome.kill();
  } catch (cleanupError) {
    console.warn(`chrome cleanup skipped: ${cleanupError?.message ?? cleanupError}`);
  }
}

await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Wrote ${manifest.captures.length} vNext visual captures to ${outputDir}`);

/** Resolve the debugger websocket for the launched browser's first page target. */
async function pageWebSocketUrl(port) {
  const deadline = Date.now() + 45_000;
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
