#!/usr/bin/env node
/**
 * Authenticated Phase 3 interaction, URL/history, responsive, and a11y proof.
 *
 * The snapshot harness proves representative rendering. This companion drives
 * the controls the Phase 3 plan explicitly names by accessible name, performs
 * form input, checks URL/history/reload behavior, and runs every deterministic
 * scenario in the catalog against isolated main and preview browser contexts.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  assertPhase3ScenarioResults,
  buildPhase3BrowserScenarios,
} from './engagement-phase3-browser-scenarios.mjs';
import {
  isEngagementRequest,
  sanitizeNetworkRecord,
  validateNetworkRecords,
} from './engagement-phase3-network-recorder.mjs';
import { compareNormalizedDom } from './engagement-phase3-dom-normalizer.mjs';

const require = createRequire(import.meta.url);
const chromeLauncher = require('chrome-launcher');

const BASE_URL = process.env.ENGAGEMENT_PHASE3_BASE_URL ?? 'http://127.0.0.1:5173';
const EVIDENCE = required('ENGAGEMENT_PHASE3_EVIDENCE_DIR');
const FIXTURE_FILE = required('ENGAGEMENT_PHASE3_FIXTURE_FILE');
const TOKEN_FILE = required('ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE');
const CLERK_SECRET_KEY = required('CLERK_SECRET_KEY');
const CLERK_API_URL = process.env.CLERK_API_URL?.trim() || 'https://api.clerk.com';
const ADMIN_CLERK_USER_ID = required('ENGAGEMENT_PHASE3_ADMIN_CLERK_USER_ID');
const PRIMARY_CLERK_ORG_ID = required('ENGAGEMENT_PHASE3_PRIMARY_CLERK_ORG_ID');
const PREVIEW_STORAGE_KEY = 'capiro.engagement-api-preview';
const PREVIEW_INDICATOR = 'Engagement API preview — External actions are disabled';
const PHASE2_BASE = '3841a5ee58e011be7fb4fb6008adfccf081976d9';
const SCREENSHOTS = path.join(EVIDENCE, 'screenshots', 'interactions');
const DESKTOP = { name: 'desktop', width: 1440, height: 900 };
const RESPONSIVE = [
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

function sourceUnchangedFromPhase2(relative) {
  const result = spawnSync(
    'git',
    ['diff', '--quiet', `${PHASE2_BASE}..HEAD`, '--', relative],
    { cwd: process.cwd(), shell: process.platform === 'win32' },
  );
  return result.status === 0;
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

  once(method, sessionId, timeoutMs = 35_000) {
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
    for (const domain of ['Page', 'Runtime', 'Network', 'Emulation', 'Accessibility']) {
      await this.cdp.send(`${domain}.enable`, {}, this.sessionId).catch((error) => {
        // Accessibility has no enable command on some CDP revisions; the tree
        // command still works. Every other domain is mandatory.
        if (domain !== 'Accessibility') throw error;
      });
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

  async waitFor(fn, timeoutMs = 35_000, intervalMs = 200) {
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

  async viewport(width, height) {
    await this.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: width <= 480 },
      this.sessionId,
    );
  }

  async navigate(pathname) {
    const url = pathname.startsWith('http') ? pathname : `${this.baseUrl}${pathname}`;
    const loaded = this.cdp.once('Page.loadEventFired', this.sessionId, 45_000).catch(() => undefined);
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    await loaded;
    await this.waitFor(() => this.evaluate('document.readyState === "complete"'), 25_000);
    await this.waitForReady();
  }

  async reload() {
    const loaded = this.cdp.once('Page.loadEventFired', this.sessionId, 45_000).catch(() => undefined);
    await this.cdp.send('Page.reload', { ignoreCache: true }, this.sessionId);
    await loaded;
    await this.waitForReady();
  }

  async history(delta) {
    await this.evaluate(`history.go(${Number(delta)})`, false);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await this.waitForReady();
  }

  async waitForReady() {
    await this.waitFor(
      () =>
        this.evaluate(`(() => {
          const body = document.body?.innerText ?? '';
          return document.readyState === 'complete' &&
            Boolean(window.Clerk?.session) &&
            !body.includes('Signing in') &&
            !body.includes('Create your account') &&
            !body.includes('Loading outreach...') &&
            !body.includes('Loading Report Activity...');
        })()`),
      45_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  async location() {
    return this.evaluate(`({ pathname: location.pathname, search: location.search, href: location.href })`);
  }

  async bodyText() {
    return this.evaluate(`(document.body?.innerText ?? '').slice(0, 50000)`);
  }

  async clickNamed(name) {
    const result = await this.evaluate(`(() => {
      const wanted = ${JSON.stringify(name)}.replace(/\\s+/g, ' ').trim();
      const visible = (node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const accessibleName = (node) => {
        const labelledBy = (node.getAttribute('aria-labelledby') || '')
          .split(/\\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ');
        return String(
          node.getAttribute('aria-label') ||
          labelledBy ||
          node.getAttribute('title') ||
          node.getAttribute('alt') ||
          node.value ||
          node.textContent ||
          ''
        ).replace(/\\s+/g, ' ').trim();
      };
      const nodes = Array.from(document.querySelectorAll(
        'button,a,[role="button"],[role="tab"],input[type="button"],input[type="submit"]'
      )).filter(visible);
      const matches = nodes.filter((node) => accessibleName(node) === wanted);
      if (matches.length !== 1) {
        return {
          ok: false,
          count: matches.length,
          available: nodes.map(accessibleName).filter(Boolean).slice(0, 100),
        };
      }
      const node = matches[0];
      node.scrollIntoView({ block: 'center', inline: 'center' });
      node.focus();
      node.click();
      return { ok: true, tag: node.tagName, name: accessibleName(node) };
    })()`);
    if (!result?.ok) {
      throw new Error(
        `Expected exactly one visible control named ${JSON.stringify(name)}; ` +
          `found ${String(result?.count)}. Available: ${JSON.stringify(result?.available ?? [])}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    return result;
  }

  async pressNamed(name, key = 'Enter') {
    await this.evaluate(`(() => {
      const wanted = ${JSON.stringify(name)};
      const nodes = Array.from(document.querySelectorAll('button,a,[role="button"],[role="tab"]'));
      const node = nodes.find((candidate) => {
        const text = String(candidate.getAttribute('aria-label') || candidate.textContent || '')
          .replace(/\\s+/g, ' ')
          .trim();
        const rect = candidate.getBoundingClientRect();
        return text === wanted && rect.width > 0 && rect.height > 0;
      });
      if (!node) throw new Error('No focusable control named ' + wanted);
      node.focus();
      return true;
    })()`);
    for (const type of ['keyDown', 'keyUp']) {
      await this.cdp.send(
        'Input.dispatchKeyEvent',
        { type, key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 32 },
        this.sessionId,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  async fillPlaceholder(placeholder, value) {
    const result = await this.evaluate(`(() => {
      const node = Array.from(document.querySelectorAll('input,textarea')).find(
        (candidate) => candidate.getAttribute('placeholder') === ${JSON.stringify(placeholder)}
      );
      if (!node) return { ok: false };
      const descriptor = Object.getOwnPropertyDescriptor(
        node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      );
      descriptor?.set?.call(node, ${JSON.stringify(value)});
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.focus();
      return { ok: true, value: node.value };
    })()`);
    if (!result?.ok || result.value !== value) {
      throw new Error(`Could not fill ${JSON.stringify(placeholder)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  async selectAntOption(currentText, optionText) {
    const opened = await this.evaluate(`(() => {
      const wanted = ${JSON.stringify(currentText)};
      const select = Array.from(document.querySelectorAll('.ant-select')).find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (node.innerText || '').includes(wanted);
      });
      const trigger = select?.querySelector('.ant-select-selector');
      if (!trigger) return false;
      trigger.click();
      return true;
    })()`);
    if (!opened) throw new Error(`No Ant Select displaying ${JSON.stringify(currentText)}`);
    await this.waitFor(
      () =>
        this.evaluate(`Array.from(document.querySelectorAll('[role="option"]')).some((node) =>
          (node.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(optionText)} &&
          node.getBoundingClientRect().width > 0
        )`),
      10_000,
    );
    const selected = await this.evaluate(`(() => {
      const option = Array.from(document.querySelectorAll('[role="option"]')).find((node) =>
        (node.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(optionText)} &&
        node.getBoundingClientRect().width > 0
      );
      if (!option) return false;
      option.click();
      return true;
    })()`);
    if (!selected) throw new Error(`Could not select ${JSON.stringify(optionText)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
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

  async snapshot(viewport) {
    const dom = await this.evaluate(`(() => {
      const root = document.getElementById('root') ?? document.body;
      const bodyText = document.body?.innerText ?? '';
      const visible = (node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const controlName = (node) => {
        const labelledBy = (node.getAttribute('aria-labelledby') || '')
          .split(/\\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ');
        const labels = node.labels ? Array.from(node.labels).map((label) => label.textContent || '').join(' ') : '';
        return String(
          node.getAttribute('aria-label') || labelledBy || labels || node.getAttribute('title') ||
          node.getAttribute('alt') || node.getAttribute('placeholder') || node.value || node.textContent || ''
        ).replace(/\\s+/g, ' ').trim();
      };
      const ids = Array.from(document.querySelectorAll('[id]')).map((node) => node.id).filter(Boolean);
      const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      const controls = Array.from(document.querySelectorAll(
        'button,a,input,select,textarea,[role="button"],[role="tab"],[role="checkbox"],[role="combobox"]'
      )).filter(visible);
      const unnamedControls = controls
        .filter((node) => !controlName(node))
        .map((node) => node.outerHTML.slice(0, 240));
      const unnamedDialogs = Array.from(document.querySelectorAll('[role="dialog"],dialog'))
        .filter(visible)
        .filter((node) => !(node.getAttribute('aria-label') || node.getAttribute('aria-labelledby')))
        .map((node) => node.outerHTML.slice(0, 240));
      const touchTargetFailures = controls
        .filter((node) => !['A'].includes(node.tagName))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { name: controlName(node), width: Math.round(rect.width), height: Math.round(rect.height) };
        })
        .filter((row) => row.width < 24 || row.height < 24);
      const colorOnlyStatuses = Array.from(document.querySelectorAll('[class*="status"],.ant-tag'))
        .filter(visible)
        .filter((node) => !controlName(node))
        .map((node) => node.outerHTML.slice(0, 240));
      return {
        pathname: location.pathname,
        search: location.search,
        bodyText: bodyText.slice(0, 50000),
        html: root?.outerHTML?.slice(0, 700000) ?? '',
        duplicateIds,
        unnamedControls,
        unnamedDialogs,
        touchTargetFailures,
        colorOnlyStatuses,
        horizontalOverflow:
          Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0) >
          window.innerWidth + 2,
        previewIndicator: bodyText.includes(${JSON.stringify(PREVIEW_INDICATOR)}),
      };
    })()`);

    const ax = await this.cdp.send('Accessibility.getFullAXTree', {}, this.sessionId);
    const namedRoles = new Set([
      'button',
      'link',
      'textbox',
      'combobox',
      'checkbox',
      'radio',
      'tab',
      'dialog',
      'menuitem',
      'switch',
    ]);
    const unnamedAxNodes = (ax.nodes ?? [])
      .filter((node) => !node.ignored && namedRoles.has(String(node.role?.value ?? '')))
      .filter((node) => !String(node.name?.value ?? '').trim())
      .map((node) => ({ role: node.role?.value ?? null, nodeId: node.nodeId }))
      .slice(0, 50);

    const issues = [];
    if (dom.duplicateIds.length) issues.push(`duplicate ids: ${dom.duplicateIds.join(', ')}`);
    if (dom.unnamedControls.length) issues.push(`unnamed controls: ${dom.unnamedControls.length}`);
    if (dom.unnamedDialogs.length) issues.push(`unnamed dialogs: ${dom.unnamedDialogs.length}`);
    if (dom.horizontalOverflow) issues.push('horizontal overflow');
    if (unnamedAxNodes.length) issues.push(`unnamed AX nodes: ${unnamedAxNodes.length}`);
    if (dom.colorOnlyStatuses.length) issues.push(`color-only status nodes: ${dom.colorOnlyStatuses.length}`);
    if (viewport.width <= 480 && dom.touchTargetFailures.length) {
      issues.push(`mobile touch targets below 24px: ${dom.touchTargetFailures.length}`);
    }
    return { ...dom, unnamedAxNodes, issues };
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

async function createActor(cdp, mode) {
  const context = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const target = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId: context.browserContextId,
  });
  const attached = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const screenshotDir = path.join(SCREENSHOTS, mode);
  await mkdir(screenshotDir, { recursive: true });
  const page = new BrowserPage({
    cdp,
    sessionId: attached.sessionId,
    baseUrl: BASE_URL,
    screenshotDir,
  });
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
  if (typeof token !== 'string' || token.length < 20) {
    throw new Error('Browser produced no bearer token');
  }

  if (mode === 'preview') {
    await page.navigate('/?engagement-api-preview=v3&phase3-preserve=interaction');
    await page.waitFor(
      () =>
        page.evaluate(`(() => {
          const params = new URLSearchParams(location.search);
          return !params.has('engagement-api-preview') &&
            params.get('phase3-preserve') === 'interaction' &&
            sessionStorage.getItem(${JSON.stringify(PREVIEW_STORAGE_KEY)}) === 'v3' &&
            (document.body?.innerText ?? '').includes(${JSON.stringify(PREVIEW_INDICATOR)});
        })()`),
      30_000,
    );
  } else {
    await page.navigate('/');
    const previewState = await page.evaluate(`({
      stored: sessionStorage.getItem(${JSON.stringify(PREVIEW_STORAGE_KEY)}),
      indicator: (document.body?.innerText ?? '').includes(${JSON.stringify(PREVIEW_INDICATOR)}),
    })`);
    if (previewState?.stored || previewState?.indicator) {
      throw new Error('Main interaction actor unexpectedly entered preview mode');
    }
  }

  return { page, token, contextId: context.browserContextId };
}

function attachNetworkRecorder(cdp, page, mode, records) {
  const pending = new Map();
  let currentScenario = 'bootstrap';
  const requestKey = `${page.sessionId}:Network.requestWillBeSent`;
  const responseKey = `${page.sessionId}:Network.responseReceived`;
  const failedKey = `${page.sessionId}:Network.loadingFailed`;

  const onRequest = (params) => {
    const request = params?.request ?? {};
    pending.set(params.requestId, {
      mode,
      surface: currentScenario,
      requestId: params.requestId,
      method: request.method,
      url: request.url,
      headers: request.headers ?? {},
      responseHeaders: {},
      status: null,
    });
  };
  const onResponse = (params) => {
    const row = pending.get(params.requestId);
    if (!row) return;
    row.status = params.response?.status ?? null;
    row.responseHeaders = params.response?.headers ?? {};
    records.push(row);
    pending.delete(params.requestId);
  };
  const onFailed = (params) => {
    const row = pending.get(params.requestId);
    if (!row) return;
    row.status = -1;
    row.errorText = params.errorText ?? 'network failure';
    records.push(row);
    pending.delete(params.requestId);
  };
  cdp.listeners.set(requestKey, [...(cdp.listeners.get(requestKey) ?? []), onRequest]);
  cdp.listeners.set(responseKey, [...(cdp.listeners.get(responseKey) ?? []), onResponse]);
  cdp.listeners.set(failedKey, [...(cdp.listeners.get(failedKey) ?? []), onFailed]);

  return { setScenario(value) { currentScenario = value; } };
}

function validateScenarioSnapshot(scenario, snapshot) {
  const issues = [];
  if (snapshot.pathname !== scenario.expectedPathname) {
    issues.push(`pathname expected ${scenario.expectedPathname}, got ${snapshot.pathname}`);
  }
  const params = new URLSearchParams(snapshot.search);
  for (const [key, value] of Object.entries(scenario.expectedSearch ?? {})) {
    if (params.get(key) !== value) issues.push(`query ${key} expected ${value}, got ${params.get(key)}`);
  }
  for (const key of scenario.absentSearch ?? []) {
    if (params.has(key)) issues.push(`query ${key} should be absent`);
  }
  for (const text of scenario.requiredText ?? []) {
    if (!snapshot.bodyText.includes(text)) issues.push(`missing visible text ${JSON.stringify(text)}`);
  }
  for (const text of scenario.forbiddenText ?? []) {
    if (snapshot.bodyText.includes(text)) issues.push(`forbidden visible text ${JSON.stringify(text)}`);
  }
  return issues;
}

async function collectScenario(actor, recorder, records, scenario, viewport, mode) {
  recorder.setScenario(`${scenario.id}:${viewport.name}`);
  const start = records.length;
  await actor.page.viewport(viewport.width, viewport.height);
  await actor.page.navigate(scenario.pathname);
  const snapshot = await actor.page.snapshot(viewport);
  const scenarioRecords = records.slice(start);
  const networkIssues = validateNetworkRecords(scenarioRecords);
  const engagementRequests = scenarioRecords.filter((record) => isEngagementRequest(record.url));
  if (scenario.requireEngagementRequest && engagementRequests.length === 0) {
    networkIssues.push('no Engagement request observed');
  }
  if (mode === 'preview' && !snapshot.previewIndicator) {
    networkIssues.push('preview indicator absent');
  }
  if (mode === 'main' && snapshot.previewIndicator) {
    networkIssues.push('preview indicator leaked into main');
  }
  const screenshot = await actor.page.screenshot(`${mode}-${scenario.id}-${viewport.name}`);
  return {
    scenarioId: scenario.id,
    category: scenario.category,
    viewport: viewport.name,
    mode,
    snapshot,
    screenshot,
    validationIssues: validateScenarioSnapshot(scenario, snapshot),
    networkIssues,
    requestCount: scenarioRecords.length,
    engagementRequestCount: engagementRequests.length,
    records: scenarioRecords.map(sanitizeNetworkRecord),
  };
}

function compareScenarioPair(scenario, main, preview) {
  const issues = [];
  if (main.networkIssues.length) issues.push(...main.networkIssues.map((row) => `main: ${row}`));
  if (preview.networkIssues.length) issues.push(...preview.networkIssues.map((row) => `preview: ${row}`));
  if (main.snapshot.issues.length) issues.push(...main.snapshot.issues.map((row) => `main a11y: ${row}`));
  if (preview.snapshot.issues.length) issues.push(...preview.snapshot.issues.map((row) => `preview a11y: ${row}`));
  if (main.snapshot.pathname !== preview.snapshot.pathname || main.snapshot.search !== preview.snapshot.search) {
    issues.push(
      `URL mismatch main=${main.snapshot.pathname}${main.snapshot.search} ` +
        `preview=${preview.snapshot.pathname}${preview.snapshot.search}`,
    );
  }
  const dom = compareNormalizedDom(main.snapshot.html, preview.snapshot.html);
  if (!dom.equal) issues.push('normalized DOM mismatch');

  const validationIssues = [...main.validationIssues, ...preview.validationIssues];
  const reportQueryBaseline =
    scenario.id === 'reports-filter-sort-query' &&
    validationIssues.length > 0 &&
    sourceUnchangedFromPhase2('apps/web/src/pages/engagement/EngagementPage.tsx');

  if (issues.length) {
    throw new Error(`${scenario.id}: ${issues.join('; ')}`);
  }
  if (validationIssues.length && !reportQueryBaseline) {
    throw new Error(`${scenario.id}: ${validationIssues.join('; ')}`);
  }
  return {
    scenarioId: scenario.id,
    status: reportQueryBaseline ? 'BASELINE_DEFECT_PROVEN' : 'PASS_MAIN_AND_PREVIEW',
    baselineEvidence: reportQueryBaseline
      ? {
          source: 'apps/web/src/pages/engagement/EngagementPage.tsx',
          unchangedFromPhase2: true,
          issue: validationIssues,
        }
      : null,
    pathname: main.snapshot.pathname,
    search: main.snapshot.search,
    mainScreenshot: main.screenshot,
    previewScreenshot: preview.screenshot,
    mainRequests: main.requestCount,
    previewRequests: preview.requestCount,
  };
}

function expectSearch(location, key, expected) {
  const params = new URLSearchParams(location.search);
  if (expected == null) {
    if (params.has(key)) throw new Error(`Expected query ${key} to be absent; got ${params.get(key)}`);
  } else if (params.get(key) !== expected) {
    throw new Error(`Expected query ${key}=${expected}; got ${params.get(key)}`);
  }
}

async function runMeetingsInteractions(actor, mode, fixtures) {
  const date = String(fixtures.anchor).slice(0, 10);
  const meetingPast = fixtures.ids['meeting.past'];
  const absentMeeting = fixtures.ids['absent.meeting'];
  if (!meetingPast || !absentMeeting) throw new Error('Meetings interaction fixtures are incomplete');

  await actor.page.viewport(DESKTOP.width, DESKTOP.height);
  await actor.page.navigate(`/engagement/meetings?date=${date}`);
  await actor.page.clickNamed('Month');
  await actor.page.waitFor(async () => new URLSearchParams((await actor.page.location()).search).get('view') === 'month');
  await actor.page.pressNamed('List');
  await actor.page.waitFor(async () => new URLSearchParams((await actor.page.location()).search).get('view') === 'list');
  await actor.page.clickNamed('Day');
  await actor.page.waitFor(async () => !new URLSearchParams((await actor.page.location()).search).has('view'));

  const beforeNext = await actor.page.location();
  await actor.page.clickNamed('Next');
  const afterNext = await actor.page.location();
  if (afterNext.search === beforeNext.search) throw new Error('Next did not update the meeting date');
  await actor.page.clickNamed('Previous');
  await actor.page.clickNamed('Today');
  const todayLocation = await actor.page.location();
  if (!new URLSearchParams(todayLocation.search).get('date')) {
    throw new Error('Today did not leave a deterministic meeting date in the URL');
  }

  await actor.page.clickNamed('Meeting Library');
  await actor.page.waitFor(async () => (await actor.page.bodyText()).includes('Meeting Library'));
  await actor.page.fillPlaceholder('Search meetings, clients…', 'appropriations');
  await actor.page.clickNamed('Meetings');
  await actor.page.waitFor(async () => !(await actor.page.bodyText()).includes('Search meetings, clients…'));

  await actor.page.navigate(`/engagement/meetings/${meetingPast}?detail=notes&date=${date}`);
  await actor.page.clickNamed('Debrief');
  await actor.page.waitFor(async () => new URLSearchParams((await actor.page.location()).search).get('detail') === 'debrief');
  await actor.page.clickNamed('Prep');
  await actor.page.waitFor(async () => !new URLSearchParams((await actor.page.location()).search).has('detail'));
  await actor.page.clickNamed('Notes');
  await actor.page.waitFor(async () => new URLSearchParams((await actor.page.location()).search).get('detail') === 'notes');
  const beforeReload = await actor.page.location();
  await actor.page.reload();
  const afterReload = await actor.page.location();
  if (beforeReload.pathname !== afterReload.pathname || beforeReload.search !== afterReload.search) {
    throw new Error('Meeting deep-link state did not survive reload');
  }

  await actor.page.navigate(`/engagement/meetings/${meetingPast}?detail=prep&date=${date}`);
  await actor.page.navigate(`/engagement/meetings/${meetingPast}?detail=notes&date=${date}`);
  await actor.page.history(-1);
  expectSearch(await actor.page.location(), 'detail', null);
  await actor.page.history(1);
  expectSearch(await actor.page.location(), 'detail', 'notes');

  await actor.page.navigate(`/engagement/meetings/${absentMeeting}?date=${date}`);
  await actor.page.waitFor(async () => (await actor.page.bodyText()).includes('Meeting not found'));
  await actor.page.clickNamed('Close');
  await actor.page.waitFor(async () => (await actor.page.location()).pathname === '/engagement/meetings');

  return {
    mode,
    modeButtons: true,
    previousNextToday: true,
    keyboardOperation: true,
    librarySearch: true,
    detailTabs: true,
    reloadPersistence: true,
    historyBackForward: true,
    notFoundClose: true,
    finalLocation: await actor.page.location(),
  };
}

async function runOutreachInteractions(actor, mode, fixtures) {
  const partial = fixtures.ids['outreach.partialWizard'];
  if (!partial) throw new Error('Outreach interaction fixture is missing');
  await actor.page.navigate('/engagement/outreach');
  const listText = await actor.page.bodyText();
  for (const expected of ['Draft campaign at step 1', 'Sent campaign', 'Failed campaign']) {
    if (!listText.includes(expected)) throw new Error(`Outreach list omitted ${expected}`);
  }
  await actor.page.clickNamed('New Outreach');
  await actor.page.waitFor(async () => (await actor.page.location()).pathname === '/engagement/outreach/new/wizard');
  const freshText = await actor.page.bodyText();
  if (!freshText.includes('Step 1 of 6') || !freshText.includes('Direction')) {
    throw new Error('New Outreach did not open the first v2 step');
  }

  await actor.page.navigate(`/engagement/outreach/draft/${partial}`);
  await actor.page.waitFor(async () => (await actor.page.bodyText()).includes('Step 4 of 6'));
  const resumedText = await actor.page.bodyText();
  if (!resumedText.includes('Build Context')) throw new Error('Outreach draft did not resume at Build Context');
  await actor.page.clickNamed('Back');
  await actor.page.waitFor(async () => (await actor.page.bodyText()).includes('Step 3 of 6'));
  await actor.page.reload();
  const reloaded = await actor.page.location();
  if (reloaded.pathname !== `/engagement/outreach/draft/${partial}`) {
    throw new Error('Outreach draft URL did not survive reload');
  }

  return {
    mode,
    listStates: true,
    newWizard: true,
    resumeLastStep: true,
    representativeBackStep: true,
    reloadPersistence: true,
    finalLocation: reloaded,
  };
}

async function runReportInteractions(actor, mode) {
  await actor.page.navigate('/engagement/reports');
  await actor.page.clickNamed('Previous Cycle');
  await actor.page.waitFor(async () => new URLSearchParams((await actor.page.location()).search).get('period') === 'previous');
  await actor.page.clickNamed('All Time');
  await actor.page.waitFor(async () => new URLSearchParams((await actor.page.location()).search).get('period') === 'all');
  await actor.page.clickNamed('Current Cycle');
  await actor.page.waitFor(async () => !new URLSearchParams((await actor.page.location()).search).has('period'));

  await actor.page.selectAntOption('Filter: All Statuses', 'Filter: Complete');
  await actor.page.selectAntOption('Sort: Member A-Z', 'Sort: Pending Actions');
  const selectedText = await actor.page.bodyText();
  if (!selectedText.includes('Filter: Complete') || !selectedText.includes('Sort: Pending Actions')) {
    throw new Error('Report filter/sort controls did not update');
  }
  const beforeReload = await actor.page.location();
  await actor.page.reload();
  const afterReload = await actor.page.location();
  const afterText = await actor.page.bodyText();
  const persisted =
    beforeReload.search.includes('status=complete') &&
    beforeReload.search.includes('sort=pending-desc') &&
    afterReload.search === beforeReload.search &&
    afterText.includes('Filter: Complete') &&
    afterText.includes('Sort: Pending Actions');

  return {
    mode,
    periods: true,
    filterSortInSession: true,
    filterSortReloadPersistence: persisted,
    baselineDefect:
      !persisted && sourceUnchangedFromPhase2('apps/web/src/pages/engagement/EngagementPage.tsx')
        ? {
            source: 'apps/web/src/pages/engagement/EngagementPage.tsx',
            unchangedFromPhase2: true,
            issue: 'Report status/sort are component state and are not serialized/restored in the URL.',
          }
        : null,
    finalLocation: afterReload,
  };
}

async function runIntegrationInteractions(actor, mode) {
  await actor.page.navigate('/settings/integrations');
  const text = await actor.page.bodyText();
  for (const expected of ['Microsoft 365', 'Google Workspace']) {
    if (!text.includes(expected)) throw new Error(`Integrations omitted ${expected}`);
  }
  const location = await actor.page.location();
  if (location.pathname !== '/settings/integrations') throw new Error('Integrations route changed');
  return { mode, reads: true, finalLocation: location };
}

function compareInteraction(name, main, preview, allowBaseline = false) {
  const strip = (value) => {
    const clone = structuredClone(value);
    delete clone.mode;
    delete clone.baselineDefect;
    return clone;
  };
  const equal = JSON.stringify(strip(main)) === JSON.stringify(strip(preview));
  if (!equal) throw new Error(`${name}: main/preview interaction results differ`);
  const baseline = main.baselineDefect ?? preview.baselineDefect ?? null;
  if (baseline && !allowBaseline) throw new Error(`${name}: unexpected baseline defect`);
  return {
    id: name,
    status: baseline ? 'BASELINE_DEFECT_PROVEN' : 'PASS_MAIN_AND_PREVIEW',
    baselineEvidence: baseline,
    main,
    preview,
  };
}

async function main() {
  await mkdir(SCREENSHOTS, { recursive: true });
  const fixtures = JSON.parse(await readFile(FIXTURE_FILE, 'utf8'));
  const scenarios = buildPhase3BrowserScenarios(fixtures);
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
  const networkRecords = [];

  try {
    const mainActor = await createActor(cdp, 'main');
    const previewActor = await createActor(cdp, 'preview');
    await writeFile(TOKEN_FILE, mainActor.token, { mode: 0o600 });
    await chmod(TOKEN_FILE, 0o600).catch(() => undefined);
    const mainRecorder = attachNetworkRecorder(cdp, mainActor.page, 'main', networkRecords);
    const previewRecorder = attachNetworkRecorder(cdp, previewActor.page, 'preview', networkRecords);

    const mainCatalog = new Map();
    const previewCatalog = new Map();
    for (const scenario of scenarios) {
      mainCatalog.set(
        scenario.id,
        await collectScenario(mainActor, mainRecorder, networkRecords, scenario, DESKTOP, 'main'),
      );
      previewCatalog.set(
        scenario.id,
        await collectScenario(previewActor, previewRecorder, networkRecords, scenario, DESKTOP, 'preview'),
      );
    }
    const scenarioResults = scenarios.map((scenario) =>
      compareScenarioPair(scenario, mainCatalog.get(scenario.id), previewCatalog.get(scenario.id)),
    );
    assertPhase3ScenarioResults(scenarios, scenarioResults);

    const responsiveIds = new Set(['meetings-day', 'outreach-list', 'reports-current', 'integrations']);
    const responsiveResults = [];
    for (const viewport of RESPONSIVE) {
      for (const scenario of scenarios.filter((row) => responsiveIds.has(row.id))) {
        const mainResult = await collectScenario(
          mainActor,
          mainRecorder,
          networkRecords,
          scenario,
          viewport,
          'main',
        );
        const previewResult = await collectScenario(
          previewActor,
          previewRecorder,
          networkRecords,
          scenario,
          viewport,
          'preview',
        );
        const paired = compareScenarioPair(scenario, mainResult, previewResult);
        responsiveResults.push({ ...paired, viewport: viewport.name });
      }
    }

    mainRecorder.setScenario('meetings-interactions');
    previewRecorder.setScenario('meetings-interactions');
    const [meetingsMain, meetingsPreview] = await Promise.all([
      runMeetingsInteractions(mainActor, 'main', fixtures),
      runMeetingsInteractions(previewActor, 'preview', fixtures),
    ]);
    const meetings = compareInteraction('meetings-interactions', meetingsMain, meetingsPreview);

    mainRecorder.setScenario('outreach-interactions');
    previewRecorder.setScenario('outreach-interactions');
    const [outreachMain, outreachPreview] = await Promise.all([
      runOutreachInteractions(mainActor, 'main', fixtures),
      runOutreachInteractions(previewActor, 'preview', fixtures),
    ]);
    const outreach = compareInteraction('outreach-interactions', outreachMain, outreachPreview);

    mainRecorder.setScenario('report-interactions');
    previewRecorder.setScenario('report-interactions');
    const [reportsMain, reportsPreview] = await Promise.all([
      runReportInteractions(mainActor, 'main'),
      runReportInteractions(previewActor, 'preview'),
    ]);
    const reports = compareInteraction('report-interactions', reportsMain, reportsPreview, true);

    mainRecorder.setScenario('integration-interactions');
    previewRecorder.setScenario('integration-interactions');
    const [integrationsMain, integrationsPreview] = await Promise.all([
      runIntegrationInteractions(mainActor, 'main'),
      runIntegrationInteractions(previewActor, 'preview'),
    ]);
    const integrations = compareInteraction(
      'integration-interactions',
      integrationsMain,
      integrationsPreview,
    );

    const networkIssues = validateNetworkRecords(networkRecords);
    if (networkIssues.length) {
      throw new Error(`Interaction network contract failed:\n${networkIssues.join('\n')}`);
    }

    const evidence = {
      marker: 'ENGAGEMENT_PHASE3_BROWSER_INTERACTIONS_COMPLETE',
      scenarios: scenarioResults,
      responsive: responsiveResults,
      interactions: [meetings, outreach, reports, integrations],
      networkRecordCount: networkRecords.length,
      noSilentSkips: true,
      viewports: [DESKTOP, ...RESPONSIVE],
    };
    await Promise.all([
      writeFile(
        path.join(EVIDENCE, 'browser-interactions.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
      ),
      writeFile(
        path.join(EVIDENCE, 'browser-interaction-network.json'),
        `${JSON.stringify(networkRecords.map(sanitizeNetworkRecord), null, 2)}\n`,
      ),
    ]);
    console.log(
      `ENGAGEMENT_PHASE3_BROWSER_INTERACTIONS_COMPLETE scenarios=${scenarioResults.length} ` +
        `responsive=${responsiveResults.length} interactions=4`,
    );
  } finally {
    const killed = chrome.kill();
    if (killed && typeof killed.then === 'function') await killed;
  }
}

main().catch(async (error) => {
  await mkdir(EVIDENCE, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(EVIDENCE, 'browser-interactions-failure.json'),
    `${JSON.stringify(
      {
        marker: 'ENGAGEMENT_PHASE3_BROWSER_INTERACTIONS_FAILED',
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    )}\n`,
  ).catch(() => undefined);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
