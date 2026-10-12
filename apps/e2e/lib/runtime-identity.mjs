/**
 * ACTUAL capture-runtime identity (CleanUp1 §8.5) — round-10.
 *
 * The published baseline manifest must record the renderer that REALLY ran, not
 * a hardcoded string. This module:
 *
 *   - launches the SHARED EXTERNAL Chromium via the same bridge the suite uses
 *     and reads `browser.version()` (the actual engine build);
 *   - resolves the ACTUAL launched executable — the default Playwright launched
 *     binary is `chrome-headless-shell`, which is DIFFERENT from
 *     `chromium.executablePath()` (full Chrome). We therefore discover the real
 *     child process (Linux `/proc` descendants; Windows child walk) and hash the
 *     binary bytes when readable;
 *   - records the pinned container image (CAPIRO_VISUAL_IMAGE) + digest
 *     (CAPIRO_VISUAL_IMAGE_DIGEST) when supplied — the CI contract passes these
 *     so a published manifest can be tied to the exact image;
 *   - records the font stack identity: on Linux `fc-list` (count + sha256 of the
 *     sorted list) plus each font file hash; elsewhere fontconfig is reported as
 *     unavailable so a Windows run can never masquerade as a Linux renderer.
 *
 * Everything is best-effort but HONEST: an unknown field is reported as null
 * with an explicit source tag, never fabricated.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { chromium } from './playwright-bridge.mjs';
import { readRenderObservations, aggregateRenderContext } from './render-context.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function readText(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

/** Recursively collect descendant PIDs of `root` on Linux via /proc. */
function procDescendants(root) {
  const out = [];
  const seen = new Set();
  const visit = (pid) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    let kids = '';
    try { kids = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim(); } catch { return; }
    for (const k of kids.split(/\s+/).filter(Boolean)) {
      const kp = Number(k);
      out.push(kp);
      visit(kp);
    }
  };
  visit(root);
  return out;
}

function cmdlineOf(pid) {
  const raw = readText(`/proc/${pid}/cmdline`);
  if (raw == null) return null;
  return raw.split('\0').filter(Boolean);
}

/**
 * Discover the ACTUAL browser executable Playwright launched. Preference order:
 * a `chrome-headless-shell` / `headless_shell` path (the default Playwright
 * launch), else a `chrome`/`chromium` path. Returns { path, sha256, via }
 * (sha256 null when unreadable).
 */
function discoverLaunchedBrowser(browser) {
  const platform = process.platform;
  if (platform === 'linux') {
    // The @playwright/test driver process owns the browser pair; find it from
    // our own process tree and scan for a browser binary in a descendant cmdline.
    const descendants = procDescendants(process.pid);
    let headless = null;
    let full = null;
    for (const pid of descendants) {
      const argv = cmdlineOf(pid);
      if (!argv) continue;
      const exe = argv.find((a) => /(chrome-headless-shell|headless_shell)/.test(a));
      if (exe && !headless) headless = { pid, path: exe, via: 'proc:headless-shell' };
      const fullExe = argv.find((a) => /(chrome|chromium)(-linux64)?\/[^/]*chrome$/.test(a)) ?? argv.find((a) => /\/chrome$/.test(a));
      if (fullExe && !full) full = { pid, path: fullExe, via: 'proc:chrome' };
    }
    const pick = headless ?? full;
    if (pick) {
      let digest = null;
      try { digest = sha256(readFileSync(pick.path)); } catch { /* unreadable */ }
      return { path: pick.path, sha256: digest, via: pick.via, isHeadlessShell: Boolean(headless) };
    }
    return { path: null, sha256: null, via: 'proc:not-found', isHeadlessShell: null };
  }
  // Non-Linux: the launched process is a child of the node test runner; we can
  // only report what Playwright itself resolves. NEVER present this as the
  // Linux launched identity.
  let fullPath = null;
  try { fullPath = chromium.executablePath(); } catch { /* ignore */ }
  return { path: fullPath, sha256: null, via: `playwright.executablePath (${platform}; not the launched headless shell)`, isHeadlessShell: null };
}

/** Font stack identity: fc-list on Linux; explicitly unavailable elsewhere. */
function fontIdentity() {
  if (process.platform !== 'linux') {
    return { source: 'unavailable-nonlinux', platform: process.platform, count: null, listSha256: null, files: [] };
  }
  const res = spawnSync('fc-list', ['--format', '%{file}\\n'], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) {
    // Fall back to the known font dirs when fc-list is absent, but flag it.
    const dirs = ['/usr/share/fonts', '/usr/local/share/fonts'];
    const files = [];
    for (const d of dirs) if (existsSync(d)) collectFiles(d, files);
    files.sort();
    return {
      source: res.status === 0 ? 'font-dirs' : 'fc-list-failed',
      count: files.length,
      listSha256: sha256(Buffer.from(files.join('\n'))),
      files: files.map((f) => ({ path: f, sha256: fileSha(f) })),
    };
  }
  const files = [...new Set(res.stdout.split('\n').map((s) => s.trim()).filter(Boolean))].sort();
  return {
    source: 'fc-list',
    count: files.length,
    listSha256: sha256(Buffer.from(files.join('\n'))),
    files: files.map((f) => ({ path: f, sha256: fileSha(f) })),
  };
}

function collectFiles(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) collectFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
}

function fileSha(p) {
  try { return sha256(readFileSync(p)); } catch { return null; }
}

/**
 * Capture the full runtime identity. Launches (and closes) the shared external
 * Chromium once for the engine/binary/font/image identity, then binds the
 * browser CONTEXT to the ACTUAL page contexts independently observed by the
 * specs (never a synthetic probe context). Bounded: single launch, fixed args,
 * no page navigation.
 *
 * `observationsPath` (default `CAPIRO_RENDER_OBSERVATIONS`) is the file the
 * specs append their REAL page-context observations to for the route-capture,
 * regression and strict-repeat pages plus the separate onboarding page. When it
 * is absent or incomplete, every context field stays null and the renderer
 * contract REFUSES (fail closed) — a declared value is never substituted.
 */
export async function captureRuntimeIdentity({ observationsPath = process.env.CAPIRO_RENDER_OBSERVATIONS } = {}) {
  let browser = null;
  let version = null;
  let launched = { path: null, sha256: null, via: 'not-launched', isHeadlessShell: null };
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--headless=new'] });
    version = browser.version();
    launched = discoverLaunchedBrowser(browser);
  } catch (e) {
    launched = { path: null, sha256: null, via: `launch-failed: ${String(e.message).slice(0, 120)}`, isHeadlessShell: null };
  }
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }

  // The ACTUAL observed page-context contract (route projects + separate
  // onboarding). A missing/incomplete/disagreeing observation set yields a null
  // context and the renderer contract then refuses (fail closed).
  let renderContext = null;
  let renderContextProblems = ['no render-context observations were collected'];
  if (typeof observationsPath === 'string' && observationsPath) {
    const read = readRenderObservations(observationsPath);
    if (!read.ok) {
      renderContextProblems = [read.error];
    } else {
      const agg = aggregateRenderContext(read.doc);
      renderContextProblems = agg.problems;
      renderContext = agg.context;
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    os: `${process.platform} ${process.arch}`,
    node: process.version,
    browserVersion: version,
    launchedBrowser: launched,
    image: {
      ref: process.env.CAPIRO_VISUAL_IMAGE ?? null,
      digest: process.env.CAPIRO_VISUAL_IMAGE_DIGEST ?? null,
    },
    fonts: fontIdentity(),
    // ACTUAL observed browser-context values (the pixels depend on these).
    colorScheme: renderContext?.colorScheme ?? null,
    mediaType: renderContext?.mediaType ?? null,
    viewports: renderContext?.viewports ?? [],
    locale: renderContext?.locale ?? null,
    timezone: renderContext?.timezone ?? null,
    deviceScaleFactor: renderContext?.deviceScaleFactor ?? null,
    reducedMotion: typeof renderContext?.reducedMotion === 'boolean' ? renderContext.reducedMotion : null,
    // The ACTUAL applied fixed clock (read back from the capture pages), never a
    // hard-coded source constant.
    fixedClock: renderContext?.fixedClock ?? null,
    // The SEPARATE onboarding page context.
    onboarding: renderContext?.onboarding ?? null,
    renderContextObservations: {
      path: typeof observationsPath === 'string' && observationsPath ? observationsPath : null,
      observedCount: renderContext?.observedCount ?? 0,
      problems: renderContextProblems,
    },
  };
}

export { sha256 };
