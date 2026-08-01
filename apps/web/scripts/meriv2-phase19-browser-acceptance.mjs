#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as chromeLauncher from 'chrome-launcher';

const BASE_URL = (process.env.PHASE19_BASE_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
const FIXTURE_FILE = process.env.PHASE19_FIXTURE_FILE ?? '/tmp/meriv2-phase19-fixtures.json';
const EVIDENCE_DIR = process.env.PHASE19_EVIDENCE_DIR ?? '/tmp/meriv2-phase19-browser-evidence';
const SHA = process.env.GITHUB_SHA ?? process.env.PHASE19_SHA ?? 'unknown';
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'desktop-1024x768', width: 1024, height: 768 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'mobile-390x844', width: 390, height: 844 },
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function cookieHeader(name) {
  return required(name);
}

function safeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
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
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  once(method, sessionId, timeoutMs = 15_000) {
    const key = `${sessionId ?? 'browser'}:${method}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.set(
          key,
          (this.listeners.get(key) ?? []).filter((item) => item !== listener),
        );
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const listener = (params) => {
        clearTimeout(timer);
        this.listeners.set(
          key,
          (this.listeners.get(key) ?? []).filter((item) => item !== listener),
        );
        resolve(params);
      };
      this.listeners.set(key, [...(this.listeners.get(key) ?? []), listener]);
    });
  }
}

class BrowserPage {
  constructor(cdp, sessionId, browserContextId, label) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.browserContextId = browserContextId;
    this.label = label;
  }

  async init() {
    for (const domain of ['Page', 'Runtime', 'Network', 'DOM', 'Accessibility']) {
      await this.cdp.send(`${domain}.enable`, {}, this.sessionId);
    }
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

  async navigate(pathname) {
    const url = pathname.startsWith('http') ? pathname : `${BASE_URL}${pathname}`;
    const loaded = this.cdp.once('Page.loadEventFired', this.sessionId, 30_000).catch(() => undefined);
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    await loaded;
    await this.waitFor(() => this.evaluate('document.readyState === "complete"'), 20_000);
    return url;
  }

  async reload() {
    const loaded = this.cdp.once('Page.loadEventFired', this.sessionId, 30_000).catch(() => undefined);
    await this.cdp.send('Page.reload', { ignoreCache: true }, this.sessionId);
    await loaded;
  }

  async waitFor(fn, timeoutMs = 20_000, intervalMs = 200) {
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

  async waitText(text, timeoutMs = 20_000) {
    await this.waitFor(
      () => this.evaluate(`document.body?.innerText.includes(${JSON.stringify(text)}) === true`),
      timeoutMs,
    );
  }

  async bodyText() {
    return (await this.evaluate('document.body?.innerText ?? ""')) ?? '';
  }

  async setViewport(width, height) {
    await this.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: width <= 480, screenWidth: width, screenHeight: height },
      this.sessionId,
    );
  }

  async setReducedMotion() {
    await this.cdp.send(
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] },
      this.sessionId,
    );
  }

  async screenshot(name) {
    const result = await this.cdp.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false, fromSurface: true },
      this.sessionId,
    );
    const file = path.join(EVIDENCE_DIR, `${safeName(name)}.png`);
    await writeFile(file, Buffer.from(result.data, 'base64'));
    return file;
  }

  async clickText(text, exact = true) {
    const clicked = await this.evaluate(`(() => {
      const wanted = ${JSON.stringify(text)};
      const exact = ${JSON.stringify(exact)};
      const all = [...document.querySelectorAll('button,a,[role="tab"],[role="button"],label')];
      const node = all.find((el) => {
        const value = (el.textContent || '').replace(/\\s+/g,' ').trim();
        return exact ? value === wanted : value.includes(wanted);
      });
      if (!node) return false;
      node.scrollIntoView({block:'center', inline:'center'});
      node.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Could not click text: ${text}`);
  }

  async clickAria(label) {
    const clicked = await this.evaluate(`(() => {
      const node = document.querySelector('[aria-label=${JSON.stringify(label)}]');
      if (!node) return false;
      node.scrollIntoView({block:'center'});
      node.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Could not click aria-label: ${label}`);
  }

  async clickWithin(containerText, buttonText) {
    const clicked = await this.evaluate(`(() => {
      const marker = ${JSON.stringify(containerText)};
      const button = ${JSON.stringify(buttonText)};
      const containers = [...document.querySelectorAll('.ant-card,article,li,tr,section')];
      const container = containers.find((el) => (el.innerText || '').includes(marker));
      if (!container) return false;
      const target = [...container.querySelectorAll('button,[role="button"]')]
        .find((el) => (el.textContent || '').replace(/\\s+/g,' ').trim() === button);
      if (!target) return false;
      target.scrollIntoView({block:'center'});
      target.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Could not click ${buttonText} within ${containerText}`);
  }

  async fillFirstEditableTextarea(value) {
    const filled = await this.evaluate(`(() => {
      const node = [...document.querySelectorAll('textarea')]
        .find((el) => !el.readOnly && !el.disabled && el.offsetParent !== null);
      if (!node) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      setter.call(node, ${JSON.stringify(value)});
      node.dispatchEvent(new Event('input',{bubbles:true}));
      node.dispatchEvent(new Event('change',{bubbles:true}));
      node.focus();
      return true;
    })()`);
    if (!filled) throw new Error('No editable textarea found');
  }

  async fillByLabel(label, value) {
    const filled = await this.evaluate(`(() => {
      const wanted = ${JSON.stringify(label)};
      const labels = [...document.querySelectorAll('label,.ant-form-item-label')];
      const labelNode = labels.find((el) => (el.textContent || '').replace(/\\s+/g,' ').trim().includes(wanted));
      const root = labelNode?.closest('.ant-form-item') || labelNode?.parentElement;
      const node = root?.querySelector('textarea,input');
      if (!node) return false;
      const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(node, ${JSON.stringify(value)});
      node.dispatchEvent(new Event('input',{bubbles:true}));
      node.dispatchEvent(new Event('change',{bubbles:true}));
      node.focus();
      return true;
    })()`);
    if (!filled) throw new Error(`No field found for label ${label}`);
  }

  async selectByLabel(label, optionText) {
    const opened = await this.evaluate(`(() => {
      const wanted = ${JSON.stringify(label)};
      const labelNode = [...document.querySelectorAll('label,.ant-form-item-label')]
        .find((el) => (el.textContent || '').replace(/\\s+/g,' ').trim().includes(wanted));
      const root = labelNode?.closest('.ant-form-item') || labelNode?.parentElement;
      const node = root?.querySelector('.ant-select-selector');
      if (!node) return false;
      node.click();
      return true;
    })()`);
    if (!opened) throw new Error(`No select found for label ${label}`);
    await this.waitText(optionText);
    await this.clickText(optionText, true);
  }

  async visibleButtonLabels() {
    return this.evaluate(`[...document.querySelectorAll('button')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => (el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim())`);
  }

  async api(pathname, method = 'GET', body) {
    return this.evaluate(`(async () => {
      const token = await window.Clerk?.session?.getToken({ template: 'capiro' });
      if (!token) return { status: 0, text: 'missing_clerk_token' };
      const response = await fetch(${JSON.stringify(pathname)}, {
        method: ${JSON.stringify(method)},
        credentials: 'include',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}
      });
      return { status: response.status, text: await response.text() };
    })()`);
  }

  async audit() {
    const dom = await this.evaluate(`(() => {
      const ids = [...document.querySelectorAll('[id]')].map((el) => el.id).filter(Boolean);
      const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      const brokenLabelledBy = [...document.querySelectorAll('[aria-labelledby]')]
        .flatMap((el) => (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
          .filter((id) => !document.getElementById(id)).map((id) => ({tag:el.tagName,id})));
      const interactive = [...document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="tab"]')]
        .filter((el) => el.offsetParent !== null && !el.disabled);
      const unnamed = interactive.filter((el) => {
        const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.value || '').trim();
        return !name;
      }).map((el) => el.outerHTML.slice(0,160));
      const clipped = interactive.filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width <= 0 || rect.height <= 0 || rect.right > innerWidth + 1 || rect.left < -1;
      }).map((el) => ({text:(el.textContent||el.getAttribute('aria-label')||'').trim(),rect:el.getBoundingClientRect().toJSON()}));
      const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
      const liveRegions = document.querySelectorAll('[role="status"],[role="alert"],[aria-live]').length;
      const restrictedLeak = document.body.innerText.includes('Restricted identity must not render');
      return { duplicates, brokenLabelledBy, unnamed, clipped, overflow, liveRegions, restrictedLeak };
    })()`);
    const ax = await this.cdp.send('Accessibility.getFullAXTree', {}, this.sessionId);
    const unnamedAx = (ax.nodes ?? [])
      .filter((node) => ['button','link','tab','textbox','checkbox','combobox','dialog'].includes(node.role?.value))
      .filter((node) => !String(node.name?.value ?? '').trim())
      .map((node) => ({ role: node.role?.value, nodeId: node.nodeId }));
    return { ...dom, unnamedAx };
  }
}

async function connectChrome(port) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return new Cdp(socket);
}

function parseCookies(header) {
  return header.split(';').map((part) => {
    const at = part.indexOf('=');
    if (at <= 0) throw new Error('Invalid cookie header');
    return { name: part.slice(0, at).trim(), value: part.slice(at + 1).trim(), url: BASE_URL };
  });
}

async function createActor(cdp, label, cookie, orgId) {
  const context = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const target = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId: context.browserContextId,
  });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const page = new BrowserPage(cdp, attached.sessionId, context.browserContextId, label);
  await page.init();
  await cdp.send('Network.setCookies', { cookies: parseCookies(cookie) }, page.sessionId);
  await page.navigate('/');
  await page.waitFor(() => page.evaluate('Boolean(window.Clerk?.session)'), 30_000);
  await page.evaluate(`(async () => {
    if (window.Clerk?.organization?.id !== ${JSON.stringify(orgId)}) {
      await window.Clerk?.setActive({ organization: ${JSON.stringify(orgId)} });
    }
    return window.Clerk?.organization?.id ?? null;
  })()`);
  await page.waitFor(() => page.evaluate(`window.Clerk?.organization?.id === ${JSON.stringify(orgId)}`), 20_000);
  return page;
}

const results = [];
let failed = 0;
let blocked = 0;

async function scenario(name, actor, scope, run, options = {}) {
  const started = new Date().toISOString();
  try {
    const actual = await run();
    const screenshot = options.screenshot === false ? null : await actor.screenshot(`${name}-${actor.label}`);
    results.push({ name, actor: actor.label, scope, status: 'passed', expected: options.expected ?? 'pass', actual, started, screenshot });
    console.log(`PASS ${name}`);
    return actual;
  } catch (error) {
    failed += 1;
    let screenshot = null;
    try { screenshot = await actor.screenshot(`${name}-${actor.label}-failed`); } catch {}
    results.push({
      name,
      actor: actor.label,
      scope,
      status: 'failed',
      expected: options.expected ?? 'pass',
      actual: error instanceof Error ? error.message : String(error),
      started,
      screenshot,
    });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

function recordBlocked(name, actor, scope, reason) {
  blocked += 1;
  results.push({ name, actor, scope, status: 'blocked', expected: 'authenticated live scenario', actual: reason, started: new Date().toISOString(), screenshot: null });
  console.error(`BLOCKED ${name}: ${reason}`);
}

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const fixtures = JSON.parse(await readFile(FIXTURE_FILE, 'utf8'));
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  try {
    const cdp = await connectChrome(chrome.port);
    const orgId = fixtures.tenant.clerkOrgId;
    const proposer = await createActor(cdp, 'proposer-admin', cookieHeader('PHASE19_PROPOSER_COOKIE'), orgId);
    const reviewer = await createActor(cdp, 'independent-reviewer', cookieHeader('PHASE19_REVIEWER_COOKIE'), orgId);
    const clientReviewer = await createActor(cdp, 'client-granted-reviewer', cookieHeader('PHASE19_CLIENT_REVIEWER_COOKIE'), orgId);
    const denied = await createActor(cdp, 'ethical-wall-denied-user', cookieHeader('PHASE19_DENIED_COOKIE'), orgId);

    const privateMarker = `Phase 19 private save ${SHA.slice(0, 12)}`;
    await scenario('memory-private-save-and-reload', proposer, 'tenant/user-private', async () => {
      await proposer.navigate('/settings/memory');
      await proposer.clickText('My files');
      await proposer.waitText('Save changes');
      await proposer.fillFirstEditableTextarea(privateMarker);
      await proposer.clickText('Save changes');
      await proposer.waitText('Saved');
      await proposer.reload();
      await proposer.clickText('My files');
      await proposer.waitText(privateMarker);
      return { persisted: true, marker: privateMarker };
    });

    const sharedMarker = `Phase 19 shared proposal ${SHA.slice(0, 12)}`;
    const sharedCandidate = await scenario('memory-shared-proposal', proposer, 'tenant/firm', async () => {
      await proposer.navigate('/settings/memory');
      await proposer.clickText('Firm');
      await proposer.waitText('Submit for review');
      await proposer.fillFirstEditableTextarea(sharedMarker);
      await proposer.clickText('Submit for review');
      await proposer.waitText('Submitted for independent review');
      const text = await proposer.bodyText();
      const id = text.match(/Candidate\s+([0-9a-f-]{36})/i)?.[1];
      if (!id) throw new Error('Shared proposal candidate id not rendered');
      return { candidateId: id, marker: sharedMarker };
    });

    if (sharedCandidate?.candidateId) {
      await scenario('memory-independent-approval', reviewer, 'tenant/firm', async () => {
        await reviewer.navigate('/settings/memory');
        await reviewer.waitText(sharedMarker);
        await reviewer.clickWithin(sharedMarker, 'Approve');
        await reviewer.waitText('Memory approved');
        return { candidateId: sharedCandidate.candidateId, approved: true };
      });
      await scenario('memory-approved-content-reload', proposer, 'tenant/firm', async () => {
        await proposer.navigate('/settings/memory');
        await proposer.clickText('Firm');
        await proposer.waitText(sharedMarker);
        return { activeContentUpdated: true };
      });
    }

    await scenario('memory-client-granted-reviewer', clientReviewer, 'tenant/client', async () => {
      await clientReviewer.navigate('/settings/memory');
      await clientReviewer.waitText('Phase 19 Client Reviewer Candidate');
      await clientReviewer.clickWithin('Phase 19 Client Reviewer Candidate', 'Approve');
      await clientReviewer.waitText('Memory approved');
      return { candidateId: fixtures.candidates.pendingClient, approved: true };
    });

    await scenario('memory-ethical-wall-denied-response', denied, 'tenant/client', async () => {
      const detail = await denied.api(`/api/memory/governance/items/${fixtures.items.approvedClientItemId}`);
      const queue = await denied.api('/api/memory/review/candidates');
      const forbiddenText = 'Phase 19 confidential approved client memory';
      if (![403, 404].includes(detail.status)) throw new Error(`Expected 403/404, received ${detail.status}`);
      if (detail.text.toLowerCase().includes(forbiddenText.toLowerCase())) throw new Error('Denied detail response leaked confidential content');
      if (queue.text.includes(fixtures.candidates.pendingClient) || queue.text.includes('Phase 19 Client Reviewer Candidate')) {
        throw new Error('Denied review queue leaked client proposal identity');
      }
      return { detailStatus: detail.status, queueStatus: queue.status, confidentialLeak: false };
    });

    await scenario('memory-proposer-withdrawal', proposer, 'tenant/firm', async () => {
      await proposer.navigate('/settings/memory');
      await proposer.waitText('Phase 19 proposer withdrawal marker.');
      await proposer.clickWithin('Phase 19 proposer withdrawal marker.', 'Withdraw');
      await proposer.waitText('Proposal withdrawn');
      await proposer.reload();
      await proposer.waitText('Withdrawn');
      return { candidateId: fixtures.candidates.withdraw, status: 'withdrawn' };
    });

    await scenario('memory-reviewer-rejection', reviewer, 'tenant/firm', async () => {
      await reviewer.navigate('/settings/memory');
      await reviewer.waitText('Phase 19 reviewer rejection marker.');
      await reviewer.clickWithin('Phase 19 reviewer rejection marker.', 'Reject');
      await reviewer.waitText('Memory rejected');
      return { candidateId: fixtures.candidates.reject, status: 'rejected' };
    });
    await scenario('memory-rejection-visible-to-proposer', proposer, 'tenant/firm', async () => {
      await proposer.navigate('/settings/memory');
      await proposer.waitText('Rejected by reviewer');
      return { statusLabel: 'Rejected by reviewer' };
    });

    const correctionMarker = `Phase 19 corrected content ${SHA.slice(0, 12)}`;
    await scenario('memory-correction-proposal', proposer, 'tenant/firm', async () => {
      await proposer.navigate('/settings/memory');
      await proposer.clickText('Active');
      await proposer.clickAria(`Open memory ${fixtures.items.correctionBase.title}`);
      await proposer.waitText('Suggest correction');
      await proposer.clickText('Suggest correction');
      await proposer.fillByLabel('Corrected memory', correctionMarker);
      await proposer.clickText('Submit');
      await proposer.waitText('Submitted for independent review');
      return { marker: correctionMarker };
    });
    await scenario('memory-correction-approval', reviewer, 'tenant/firm', async () => {
      await reviewer.navigate('/settings/memory');
      await reviewer.waitText(correctionMarker);
      await reviewer.clickWithin(correctionMarker, 'Approve');
      await reviewer.waitText('Memory version activated');
      return { activated: true };
    });

    await scenario('memory-conflict-resolution', reviewer, 'tenant/firm', async () => {
      await reviewer.navigate('/settings/memory');
      await reviewer.clickText('Conflicts');
      await reviewer.clickAria(`Open memory ${fixtures.items.correctionBase.title}`);
      await reviewer.waitText('Resolve conflict');
      await reviewer.clickText('Resolve conflict');
      await reviewer.selectByLabel('Controlling memory', fixtures.items.correctionBase.title);
      await reviewer.fillByLabel('Reason', 'Phase 19 selects the reviewed controlling version.');
      await reviewer.clickText('Submit');
      await reviewer.waitText('Memory conflict resolved');
      return { conflictGroupId: fixtures.items.conflictGroupId, controllingItemId: fixtures.items.conflictAnchor };
    });

    await scenario('memory-legal-hold-controls', reviewer, 'tenant/firm', async () => {
      await reviewer.navigate('/settings/memory');
      await reviewer.clickText('Active');
      await reviewer.clickAria(`Open memory ${fixtures.items.legalHold.title}`);
      await reviewer.waitText('Legal hold');
      const text = await reviewer.bodyText();
      const buttons = await reviewer.visibleButtonLabels();
      if (!text.includes('Yes')) throw new Error('Legal hold detail did not render Yes');
      if (buttons.includes('Revoke') || buttons.includes('Suggest correction')) {
        throw new Error('Legal-held item exposed destructive controls');
      }
      return { destructiveControlsHidden: true };
    });

    await scenario('memory-revoke', proposer, 'tenant/firm', async () => {
      await proposer.navigate('/settings/memory');
      await proposer.clickText('Active');
      await proposer.clickAria(`Open memory ${fixtures.items.revokeRestore.title}`);
      await proposer.clickText('Revoke');
      await proposer.fillByLabel('Reason', 'Phase 19 reversible browser revoke.');
      await proposer.clickText('Revoke memory');
      await proposer.waitText('Memory revoked');
      return { revoked: true };
    });
    await scenario('memory-restore-as-new-version', proposer, 'tenant/firm', async () => {
      await proposer.navigate('/settings/memory');
      await proposer.clickText('History');
      await proposer.clickAria(`Open memory ${fixtures.items.revokeRestore.title}`);
      await proposer.clickText('Restore as new version');
      await proposer.waitText('Submitted for independent review');
      return { restoreProposed: true };
    });
    await scenario('memory-restore-approval', reviewer, 'tenant/firm', async () => {
      await reviewer.navigate('/settings/memory');
      await reviewer.waitText(fixtures.items.revokeRestore.title);
      await reviewer.clickWithin(fixtures.items.revokeRestore.title, 'Approve');
      await reviewer.waitText('Memory version activated');
      return { restored: true };
    });

    await scenario('memory-projection-failure-retry', reviewer, 'tenant/firm', async () => {
      await reviewer.navigate('/settings/memory');
      await reviewer.clickText('Projection health');
      await reviewer.waitText('Projection work needs attention');
      await reviewer.clickWithin(fixtures.items.revokeRestore.title, 'Retry');
      await reviewer.waitText('Projection retry queued');
      return { jobId: fixtures.projectionJobId, retryQueued: true };
    });

    for (const viewport of VIEWPORTS) {
      await reviewer.setViewport(viewport.width, viewport.height);
      await reviewer.navigate('/settings/memory');
      const audit = await reviewer.audit();
      const screenshot = await reviewer.screenshot(`authenticated-memory-${viewport.name}`);
      const pass =
        audit.duplicates.length === 0 &&
        audit.brokenLabelledBy.length === 0 &&
        audit.unnamed.length === 0 &&
        audit.unnamedAx.length === 0 &&
        audit.clipped.length === 0 &&
        audit.overflow === false;
      results.push({
        name: `viewport-authenticated-memory-${viewport.name}`,
        actor: reviewer.label,
        scope: fixtures.tenant.slug,
        status: pass ? 'passed' : 'failed',
        expected: 'no duplicate IDs, broken labels, unnamed controls, clipped actions, or page overflow',
        actual: audit,
        started: new Date().toISOString(),
        screenshot,
      });
      if (!pass) failed += 1;
    }

    await reviewer.setReducedMotion();
    await scenario('context-inspector-browser-accessibility', reviewer, 'fixture-supplement', async () => {
      await reviewer.navigate('/context-inspector-a11y-fixture.html');
      const audit = await reviewer.audit();
      if (audit.duplicates.length || audit.brokenLabelledBy.length || audit.unnamedAx.length || audit.restrictedLeak) {
        throw new Error(JSON.stringify(audit));
      }
      await reviewer.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' }, reviewer.sessionId);
      await reviewer.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' }, reviewer.sessionId);
      const focused = await reviewer.evaluate('document.activeElement !== document.body');
      if (!focused) throw new Error('Keyboard Tab did not move focus');
      return { ...audit, keyboardFocusMoved: true };
    });

    await scenario('assurance-state-browser-fixture', reviewer, 'fixture-supplement', async () => {
      await reviewer.navigate('/phase19-assurance-fixture.html');
      await reviewer.waitText('High-risk chat hold');
      await reviewer.clickText('Apply 2 selected');
      await reviewer.waitText('Applied locally; save failed.');
      await reviewer.clickText('Retry save');
      await reviewer.waitText('Applied and saved.');
      await reviewer.clickText('Retry failed sections');
      await reviewer.waitText('Retry completed');
      const audit = await reviewer.audit();
      if (audit.duplicates.length || audit.brokenLabelledBy.length || audit.unnamedAx.length || audit.overflow) {
        throw new Error(JSON.stringify(audit));
      }
      return audit;
    });

    const liveGeneration = [
      ['context-inspector-after-authenticated-reload', 'PHASE19_LIVE_CONTEXT_PATH', 'PHASE19_LIVE_CONTEXT_EXPECT'],
      ['high-risk-chat-hold', 'PHASE19_LIVE_CHAT_PATH', 'PHASE19_LIVE_CHAT_EXPECT'],
      ['in-editor-held-edit', 'PHASE19_LIVE_EDITOR_PATH', 'PHASE19_LIVE_EDITOR_EXPECT'],
      ['workspace-partial-generation-and-retry', 'PHASE19_LIVE_WORKSPACE_PATH', 'PHASE19_LIVE_WORKSPACE_EXPECT'],
      ['strategy-steward-hold', 'PHASE19_LIVE_STRATEGY_PATH', 'PHASE19_LIVE_STRATEGY_EXPECT'],
      ['export-acknowledgment', 'PHASE19_LIVE_EXPORT_PATH', 'PHASE19_LIVE_EXPORT_EXPECT'],
      ['proposal-card-policy-version', 'PHASE19_LIVE_PROPOSAL_PATH', 'PHASE19_LIVE_PROPOSAL_EXPECT'],
    ];
    for (const [name, pathEnv, expectedEnv] of liveGeneration) {
      const pathname = process.env[pathEnv]?.trim();
      const expected = process.env[expectedEnv]?.trim();
      if (!pathname || !expected) {
        recordBlocked(name, reviewer.label, fixtures.tenant.slug, `${pathEnv} and ${expectedEnv} are required for live acceptance`);
        continue;
      }
      await scenario(name, reviewer, fixtures.tenant.slug, async () => {
        await reviewer.navigate(pathname);
        await reviewer.waitText(expected, 60_000);
        await reviewer.reload();
        await reviewer.waitText(expected, 30_000);
        return { path: pathname, expectedText: expected, persistedAfterReload: true };
      });
    }

    if (!process.env.PHASE18_ACCEPTED_SHA) {
      recordBlocked('phase18-prerequisite', 'release-gate', fixtures.tenant.slug, 'PHASE18_ACCEPTED_SHA is not present; Phase 19 cannot be finally accepted before Phase 18');
    }
  } finally {
    await chrome.kill();
  }

  const summary = {
    marker: 'MERIV2_PHASE19_BROWSER_ACCEPTANCE_SUMMARY',
    sha: SHA,
    baseUrl: BASE_URL,
    passed: results.filter((item) => item.status === 'passed').length,
    failed,
    blocked,
    result: failed > 0 ? 'failed' : blocked > 0 ? 'blocked' : 'passed',
    results,
  };
  await writeFile(path.join(EVIDENCE_DIR, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary));
  if (failed > 0) process.exitCode = 1;
  else if (blocked > 0) process.exitCode = 2;
}

main().catch(async (error) => {
  await mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => undefined);
  const result = {
    marker: 'MERIV2_PHASE19_BROWSER_ACCEPTANCE_FATAL',
    sha: SHA,
    error: error instanceof Error ? error.message.slice(0, 1000) : String(error),
  };
  await writeFile(path.join(EVIDENCE_DIR, 'fatal.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8').catch(() => undefined);
  console.error(JSON.stringify(result));
  process.exitCode = 1;
});
