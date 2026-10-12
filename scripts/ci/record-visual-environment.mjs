#!/usr/bin/env node
/**
 * record-visual-environment.mjs — record the EXACT, reproducible rendering
 * environment identity for the CleanUp1 visual baseline (CleanUp1 §8; review
 * rounds 4, 6–11).
 *
 * Corrections to date:
 *   - r4: inline `node -e` shell-expanded a dpkg format string; recorded the
 *     Playwright PACKAGE version as the browser version.
 *   - r6/7: shell-interpolated PW_PREFIX; read the first cache chrome glob;
 *     never launched the browser; missed the actual headless-shell + fonts.
 *   - r9: with no runtime/fonts/image it still exited 0.
 *   - r10: `CAPIRO_VISUAL_EXPECTED_DIGEST` let the caller move BOTH sides of the
 *     comparison, so `ref=000…, digest=000…, expected=000…` passed while the
 *     ACTUAL outer image was bc6ab0… .
 *   - r11 (this revision): the AGREED pin is an IMMUTABLE in-source constant (no
 *     env override); the requested identity must be bound, by EXACT equality, to
 *     a PARENT-SUPPLIED verified `docker inspect` receipt (a bare caller string
 *     is diagnostic-only). No substring/includes matching.
 *
 * The recorder is fail-closed: any unmet requirement writes a DIAGNOSTIC partial
 * record and exits NONZERO. Probes use ARGV execFile only (no shell).
 * Output: docs/plans/cleanup1-visual-environment.json (schema v5).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const OUT = process.env.VISUAL_ENV_OUT || 'docs/plans/cleanup1-visual-environment.json';
const IMAGE_REF = process.env.CAPIRO_VISUAL_IMAGE || null;
const IMAGE_DIGEST = process.env.CAPIRO_VISUAL_IMAGE_DIGEST || null;
const INSPECT_RAW = process.env.CAPIRO_VISUAL_IMAGE_INSPECT_JSON || null;
const PW_CLI = process.env.PLAYWRIGHT_CLI || null;
const PW_RUNTIME_DIR = process.env.PLAYWRIGHT_RUNTIME_DIR || null;

/** The AGREED pinned renderer contract — IMMUTABLE (review round 11). */
const AGREED_DIGEST = 'sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7';
const AGREED_REF = `mcr.microsoft.com/playwright@${AGREED_DIGEST}`;
const AGREED_BROWSER_VERSION = '153.0.8010.12';
const AGREED_HEADLESS_SHELL_SHA256 = 'ded93a9c9a53a1ae040f08124badcca95c938e9d5015ff340c3b5538c41bf39e';

const CONTEXT_CONTRACT = {
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
};

const HEX64 = /^[0-9a-f]{64}$/i;
const isHex64 = (v) => typeof v === 'string' && HEX64.test(v);

function argv(cmd, args) {
  try {
    return { ok: true, value: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}
const text = (cmd, args) => {
  const r = argv(cmd, args);
  return r.ok ? String(r.value).trim() : null;
};
const sha256File = (p) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
};

function osRelease() {
  try {
    const t = fs.readFileSync('/etc/os-release', 'utf8');
    return t.split('\n').filter((l) => /^(ID|VERSION_ID|VERSION_CODENAME|PRETTY_NAME)=/.test(l)).join(';') || null;
  } catch {
    return null;
  }
}

function fontPackages() {
  const pkgs = ['fontconfig', 'fonts-liberation', 'fonts-noto-color-emoji'];
  const r = argv('dpkg-query', ['-W', '-f=${Package} ${Version}\n', ...pkgs]);
  if (!r.ok) return { packages: null, error: r.error };
  const packages = String(r.value)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, version] = line.split(/\s+/, 2);
      return { package: name, version: version || null };
    })
    .sort((a, b) => (a.package < b.package ? -1 : 1));
  return { packages, error: null };
}

function fontconfigFiles() {
  const r = argv('fc-list', ['--format=%{file}\n']);
  if (!r.ok) return { count: 0, listSha256: null, files: [], error: r.error };
  const paths = [...new Set(String(r.value).split('\n').filter(Boolean))].sort();
  const files = paths.map((p) => ({ path: p, sha256: sha256File(p) }));
  const listSha256 = crypto.createHash('sha256').update(`${paths.join('\n')}\n`).digest('hex');
  return { count: paths.length, listSha256, files, error: null };
}

/**
 * Parse the PARENT-supplied `docker inspect` receipt (image OR container) and
 * bind the requested identity to it by EXACT equality. Returns the inspected
 * identity; pushes a problem (never throws) on any mismatch.
 */
function inspectImageIdentity(raw, problems) {
  if (!raw) {
    problems.push('CAPIRO_VISUAL_IMAGE_INSPECT_JSON (verified parent docker-inspect receipt) is required — a bare caller string is diagnostic-only');
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    problems.push(`CAPIRO_VISUAL_IMAGE_INSPECT_JSON is not valid JSON: ${e.message}`);
    return null;
  }
  const doc = Array.isArray(obj) ? obj[0] : obj;
  if (!doc || typeof doc !== 'object') {
    problems.push('CAPIRO_VISUAL_IMAGE_INSPECT_JSON did not contain an inspect object');
    return null;
  }
  const repoDigests = Array.isArray(doc.RepoDigests) ? doc.RepoDigests.map(String) : [];
  const imageId = typeof doc.Id === 'string' ? doc.Id : null;
  const configImage = doc.Config && typeof doc.Config.Image === 'string' ? doc.Config.Image : null;
  // EXACT equality to the agreed repo@digest — never substring/includes.
  if (!repoDigests.includes(AGREED_REF)) {
    problems.push(`inspect receipt RepoDigests ${JSON.stringify(repoDigests)} does not contain the exact agreed ref ${AGREED_REF}`);
  }
  if (configImage && configImage !== AGREED_REF) {
    problems.push(`inspect receipt Config.Image ${JSON.stringify(configImage)} != agreed ref ${AGREED_REF}`);
  }
  if (!imageId || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    problems.push(`inspect receipt Id ${JSON.stringify(imageId)} must be an exact sha256:<64hex> image id (missing/malformed is rejected)`);
  }
  return { repoDigests, imageId, configImage };
}

function resolveRuntime() {
  const attempts = [];
  const fromCli = () => {
    if (!PW_CLI) return null;
    try {
      if (!fs.existsSync(PW_CLI)) return { source: 'PLAYWRIGHT_CLI', ok: false, error: `does not exist: ${PW_CLI}` };
      const version = JSON.parse(fs.readFileSync(path.resolve(path.dirname(PW_CLI), 'package.json'), 'utf8')).version;
      return { source: 'PLAYWRIGHT_CLI', ok: true, value: PW_CLI, version };
    } catch (err) {
      return { source: 'PLAYWRIGHT_CLI', ok: false, error: String(err.message || err) };
    }
  };
  const fromDir = () => {
    if (!PW_RUNTIME_DIR) return null;
    try {
      const version = JSON.parse(fs.readFileSync(path.join(PW_RUNTIME_DIR, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version;
      return { source: 'PLAYWRIGHT_RUNTIME_DIR', ok: true, value: PW_RUNTIME_DIR, version, baseUrl: path.join(PW_RUNTIME_DIR, 'node_modules') };
    } catch (err) {
      return { source: 'PLAYWRIGHT_RUNTIME_DIR', ok: false, error: String(err.message || err) };
    }
  };
  for (const a of [fromCli(), fromDir()]) if (a) attempts.push(a);
  return { resolved: attempts.find((a) => a.ok) || null, attempts };
}

function procDescendants(maxDepth = 3) {
  const out = [];
  const readChildren = (pid) => {
    try {
      return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    } catch {
      try {
        return fs.readFileSync(`/proc/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
      } catch {
        return [];
      }
    }
  };
  const walk = (pid, depth) => {
    if (depth > maxDepth) return;
    for (const id of readChildren(pid)) {
      let exe = null;
      let cmd = [];
      try { exe = fs.readlinkSync(`/proc/${id}/exe`); } catch { exe = null; }
      try { cmd = fs.readFileSync(`/proc/${id}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { cmd = []; }
      out.push({ id, exe, cmd, sha256: exe ? sha256File(exe) : null });
      walk(id, depth + 1);
    }
  };
  walk(process.pid, 1);
  return out;
}

async function launchedBrowser(runtime) {
  if (!runtime.resolved) return { launched: false, reason: 'no external pinned Playwright runtime resolved' };
  let req;
  try {
    const base =
      runtime.resolved.source === 'PLAYWRIGHT_CLI'
        ? path.dirname(path.resolve(runtime.resolved.value))
        : path.join(runtime.resolved.value, 'node_modules', '@playwright', 'test');
    req = createRequire(path.join(base, 'package.json'));
  } catch (err) {
    return { launched: false, reason: `cannot create require for external runtime: ${err.message}` };
  }
  let chromium;
  try {
    ({ chromium } = req('@playwright/test'));
  } catch (err) {
    return { launched: false, reason: `cannot load @playwright/test: ${err.message}` };
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const browserVersion = browser.version();
    let selectedExecutable = null;
    try { selectedExecutable = chromium.executablePath(); } catch { /* optional */ }
    const procs = procDescendants();
    const launched = procs.find((p) => p.exe && /chrome|chromium/i.test(p.exe)) || null;
    const context = await browser.newContext(CONTEXT_CONTRACT);
    const page = await context.newPage();
    await page.setContent('<html><body><h1>Cleanup visual environment</h1><p>October review</p></body></html>');
    const shot = await page.screenshot();
    await context.close();
    return {
      launched: true,
      browserVersion,
      selectedExecutable,
      selectedExecutableIsFullChrome: !(selectedExecutable || '').includes('headless-shell'),
      actual: launched
        ? { id: launched.id, exe: launched.exe, sha256: launched.sha256, isHeadlessShell: /headless-shell/i.test(launched.exe), cmdHead: launched.cmd.slice(0, 8) }
        : { id: null, note: 'actual launched child binary not found via /proc' },
      render: {
        rendered: true,
        screenshotSha256: crypto.createHash('sha256').update(shot).digest('hex'),
        screenshotBytes: shot.length,
        context: { requested: CONTEXT_CONTRACT },
      },
    };
  } catch (err) {
    return { launched: false, reason: `browser launch/render failed: ${err.message}` };
  } finally {
    if (browser && typeof browser.close === 'function') {
      try { await browser.close(); } catch { /* best effort */ }
    }
  }
}

async function main() {
  const fp = fontPackages();
  const fc = fontconfigFiles();
  const os = osRelease();
  const runtime = resolveRuntime();
  const browser = await launchedBrowser(runtime);

  const problems = [];
  // Requested identity must EXACTLY equal the immutable agreed contract…
  if (IMAGE_REF !== AGREED_REF) problems.push(`CAPIRO_VISUAL_IMAGE ${JSON.stringify(IMAGE_REF)} != the exact agreed pinned ref ${AGREED_REF}`);
  if (IMAGE_DIGEST !== AGREED_DIGEST) problems.push(`CAPIRO_VISUAL_IMAGE_DIGEST ${JSON.stringify(IMAGE_DIGEST)} != the exact agreed pinned digest ${AGREED_DIGEST}`);
  // …and be BOUND to the actual parent docker-inspect receipt by exact equality.
  const inspected = inspectImageIdentity(INSPECT_RAW, problems);
  if (process.platform !== 'linux') problems.push(`hostPlatform=${process.platform} — Linux is required`);
  if (!os) problems.push('osRelease is unreadable (/etc/os-release)');
  if (!runtime.resolved) problems.push('external pinned Playwright runtime is unresolved');
  else if (!/^1\.63\./.test(runtime.resolved.version || '')) problems.push(`external runtime version ${runtime.resolved.version} is not 1.63.x`);
  if (!browser.launched) problems.push(`browser not launched: ${browser.reason}`);
  else {
    if (browser.browserVersion !== AGREED_BROWSER_VERSION) problems.push(`launched browser version ${browser.browserVersion} != agreed pinned ${AGREED_BROWSER_VERSION}`);
    if (!browser.actual || !browser.actual.exe) problems.push('actual launched binary was not identified');
    if (!browser.actual || !isHex64(browser.actual.sha256)) problems.push('actual launched binary sha256 was not established');
    if (!browser.actual || browser.actual.isHeadlessShell !== true) problems.push('launched binary is not the headless shell');
    if (browser.actual && browser.actual.sha256 !== AGREED_HEADLESS_SHELL_SHA256) problems.push(`launched headless-shell sha256 ${browser.actual.sha256} != agreed pinned ${AGREED_HEADLESS_SHELL_SHA256}`);
    if (!browser.render || !isHex64(browser.render.screenshotSha256)) problems.push('no rendered screenshot (renderer capability unproven)');
  }
  if (!(fc.count > 0)) problems.push('no fontconfig fonts found (fc-list empty)');
  if (fc.files.some((f) => !isHex64(f.sha256))) problems.push('some fontconfig font files were not hashed');

  const identity = {
    schema: 'capiro.cleanup1-visual-environment',
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    requestedImage: { ref: IMAGE_REF, digest: IMAGE_DIGEST },
    agreedContract: { ref: AGREED_REF, digest: AGREED_DIGEST, browserVersion: AGREED_BROWSER_VERSION, headlessShellSha256: AGREED_HEADLESS_SHELL_SHA256 },
    inspectedImageReceipt: inspected,
    hostPlatform: process.platform,
    osRelease: os,
    kernel: text('uname', ['-r']),
    runnerImage: process.env.ImageOS || process.env.RUNNER_OS || null,
    tz: process.env.TZ || null,
    lang: process.env.LANG || null,
    locale: process.env.LC_ALL || null,
    node: process.version,
    externalPlaywright: {
      cli: PW_CLI,
      runtimeDir: PW_RUNTIME_DIR,
      resolvedSource: runtime.resolved ? runtime.resolved.source : null,
      packageVersion: runtime.resolved ? runtime.resolved.version : null,
      attempts: runtime.attempts,
    },
    launchedBrowser: browser,
    fontconfig: { count: fc.count, listSha256: fc.listSha256, files: fc.files, error: fc.error },
    fontPackages: fp.packages,
    fontPackagesError: fp.error,
    xdgCacheHome: process.env.XDG_CACHE_HOME || null,
    requirementsProve: problems.length === 0,
    problems,
    notes: [
      'The agreed pin is immutable in source; env cannot move it. The requested identity must be bound by exact equality to CAPIRO_VISUAL_IMAGE_INSPECT_JSON (a real docker inspect receipt).',
      'launchedBrowser.actual is the ACTUAL launched child binary (owned /proc descendants); chromium.executablePath() names full Chrome and is only selectedExecutable.',
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(identity, null, 2) + '\n');
  process.stdout.write(`${JSON.stringify(identity)}\n`);
  if (problems.length > 0) {
    process.stderr.write(`[visual-env] FAIL-CLOSED: ${problems.length} unmet requirement(s):\n`);
    for (const p of problems) process.stderr.write(`        - ${p}\n`);
    process.stderr.write(`[visual-env] wrote DIAGNOSTIC partial record ${OUT}\n`);
    process.exit(2);
  }
  process.stdout.write(`[visual-env] OK — renderer identity established; wrote ${OUT}\n`);
}

main().catch((err) => {
  process.stderr.write(`[visual-env] FATAL: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
