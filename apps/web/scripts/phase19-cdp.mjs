import { writeFile } from 'node:fs/promises';
import path from 'node:path';

function safeName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

export class Cdp {
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

export async function connectChrome(port) {
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
  const origin = new URL(baseUrl);
  return header.split(';').map((part) => {
    const at = part.indexOf('=');
    if (at <= 0) throw new Error('Invalid cookie header');
    return {
      name: part.slice(0, at).trim(),
      value: part.slice(at + 1).trim(),
      url: baseUrl,
      domain: origin.hostname,
      path: '/',
      httpOnly: false,
      secure: origin.protocol === 'https:',
      sameSite: 'Lax',
    };
  });
}

export class BrowserPage {
  constructor({ cdp, sessionId, browserContextId, label, baseUrl, evidenceDir }) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.browserContextId = browserContextId;
    this.label = label;
    this.baseUrl = baseUrl;
    this.evidenceDir = evidenceDir;
  }

  async init() {
    for (const domain of ['Page', 'Runtime', 'Network', 'DOM', 'Accessibility']) {
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

  async reload() {
    const loaded = this.cdp.once('Page.loadEventFired', this.sessionId, 35_000).catch(() => undefined);
    await this.cdp.send('Page.reload', { ignoreCache: true }, this.sessionId);
    await loaded;
    await this.waitFor(() => this.evaluate('document.readyState === "complete"'), 20_000);
  }

  async waitText(text, timeoutMs = 25_000) {
    const literal = JSON.stringify(text);
    await this.waitFor(
      () =>
        this.evaluate(`(() => {
          const wanted = ${literal};
          if ((document.body?.innerText ?? '').includes(wanted)) return true;
          return [...document.querySelectorAll('input,textarea')]
            .some((node) => String(node.value ?? '').includes(wanted));
        })()`),
      timeoutMs,
    );
  }

  async bodyText() {
    return (await this.evaluate('document.body?.innerText ?? ""')) ?? '';
  }

  async setViewport(width, height) {
    await this.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 480,
        screenWidth: width,
        screenHeight: height,
      },
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
    const response = await this.cdp.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false, fromSurface: true },
      this.sessionId,
    );
    const file = path.join(this.evidenceDir, `${safeName(name)}.png`);
    await writeFile(file, Buffer.from(response.data, 'base64'));
    return file;
  }

  async clickText(text, exact = true) {
    const clicked = await this.evaluate(`(() => {
      const wanted = ${JSON.stringify(text)};
      const exact = ${JSON.stringify(exact)};
      const candidates = [...document.querySelectorAll('button,a,[role="tab"],[role="button"],label')]
        .filter((node) => node.offsetParent !== null && !node.disabled);
      const node = candidates.find((candidate) => {
        const value = (candidate.textContent || '').replace(/\\s+/g, ' ').trim();
        return exact ? value === wanted : value.includes(wanted);
      });
      if (!node) return false;
      node.scrollIntoView({ block: 'center', inline: 'center' });
      node.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Could not click text: ${text}`);
  }

  async clickAria(label) {
    const clicked = await this.evaluate(`(() => {
      const node = document.querySelector('[aria-label=${JSON.stringify(label)}]');
      if (!node || node.offsetParent === null) return false;
      node.scrollIntoView({ block: 'center', inline: 'center' });
      node.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Could not click aria-label: ${label}`);
  }

  async clickWithin(containerText, buttonText) {
    const clicked = await this.evaluate(`(() => {
      const marker = ${JSON.stringify(containerText)};
      const button = ${JSON.stringify(buttonText)};
      const containers = [...document.querySelectorAll('.ant-card,article,li,tr,section')]
        .filter((node) => node.offsetParent !== null);
      const container = containers.find((node) => (node.innerText || '').includes(marker));
      if (!container) return false;
      const target = [...container.querySelectorAll('button,[role="button"]')]
        .find((node) => node.offsetParent !== null &&
          (node.textContent || '').replace(/\\s+/g, ' ').trim() === button);
      if (!target) return false;
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Could not click ${buttonText} within ${containerText}`);
  }

  async fillFirstEditableTextarea(value) {
    const filled = await this.evaluate(`(() => {
      const node = [...document.querySelectorAll('textarea')]
        .find((candidate) => !candidate.readOnly && !candidate.disabled && candidate.offsetParent !== null);
      if (!node) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
        node,
        ${JSON.stringify(value)},
      );
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.focus();
      return true;
    })()`);
    if (!filled) throw new Error('No editable textarea found');
  }

  async fillByLabel(label, value) {
    const filled = await this.evaluate(`(() => {
      const wanted = ${JSON.stringify(label)};
      const labels = [...document.querySelectorAll('label,.ant-form-item-label')]
        .filter((node) => node.offsetParent !== null);
      const labelNode = labels.find((node) =>
        (node.textContent || '').replace(/\\s+/g, ' ').trim().includes(wanted),
      );
      const root = labelNode?.closest('.ant-form-item') || labelNode?.parentElement;
      const node = root?.querySelector('textarea,input');
      if (!node) return false;
      const proto = node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, ${JSON.stringify(value)});
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.focus();
      return true;
    })()`);
    if (!filled) throw new Error(`No field found for label ${label}`);
  }

  async selectByLabel(label, optionText) {
    const opened = await this.evaluate(`(() => {
      const wanted = ${JSON.stringify(label)};
      const labelNode = [...document.querySelectorAll('label,.ant-form-item-label')]
        .filter((node) => node.offsetParent !== null)
        .find((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim().includes(wanted));
      const root = labelNode?.closest('.ant-form-item') || labelNode?.parentElement;
      const selector = root?.querySelector('.ant-select-selector');
      if (!selector) return false;
      selector.click();
      return true;
    })()`);
    if (!opened) throw new Error(`No select found for label ${label}`);
    await this.waitText(optionText);
    await this.clickText(optionText);
  }

  async visibleButtonLabels() {
    return this.evaluate(`[...document.querySelectorAll('button')]
      .filter((node) => node.offsetParent !== null)
      .map((node) => (node.textContent || node.getAttribute('aria-label') || '')
        .replace(/\\s+/g, ' ').trim())`);
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
      const ids = [...document.querySelectorAll('[id]')].map((node) => node.id).filter(Boolean);
      const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      const brokenLabelledBy = [...document.querySelectorAll('[aria-labelledby]')]
        .flatMap((node) => (node.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
          .filter((id) => !document.getElementById(id))
          .map((id) => ({ tag: node.tagName, id })));
      const interactive = [...document.querySelectorAll(
        'button,a[href],input,textarea,select,[role="button"],[role="tab"]',
      )].filter((node) => node.offsetParent !== null && !node.disabled);
      const unnamed = interactive.filter((node) => {
        const name = (
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          node.textContent ||
          node.value ||
          ''
        ).trim();
        return !name;
      }).map((node) => node.outerHTML.slice(0, 160));
      const clipped = interactive.filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width <= 0 || rect.height <= 0 || rect.right > innerWidth + 1 || rect.left < -1;
      }).map((node) => ({
        text: (node.textContent || node.getAttribute('aria-label') || '').trim(),
        rect: node.getBoundingClientRect().toJSON(),
      }));
      return {
        duplicates,
        brokenLabelledBy,
        unnamed,
        clipped,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        liveRegions: document.querySelectorAll('[role="status"],[role="alert"],[aria-live]').length,
        restrictedLeak: (document.body?.innerText ?? '').includes('Restricted identity must not render'),
      };
    })()`);
    const ax = await this.cdp.send('Accessibility.getFullAXTree', {}, this.sessionId);
    const unnamedAx = (ax.nodes ?? [])
      .filter((node) =>
        ['button', 'link', 'tab', 'textbox', 'checkbox', 'combobox', 'dialog'].includes(
          node.role?.value,
        ),
      )
      .filter((node) => !String(node.name?.value ?? '').trim())
      .map((node) => ({ role: node.role?.value, nodeId: node.nodeId }));
    return { ...dom, unnamedAx };
  }

  async tab() {
    await this.cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'Tab', code: 'Tab' },
      this.sessionId,
    );
    await this.cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'Tab', code: 'Tab' },
      this.sessionId,
    );
  }
}

export async function createActor({ cdp, label, cookie, orgId, baseUrl, evidenceDir, clerkTicket }) {
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
    label,
    baseUrl,
    evidenceDir,
  });
  await page.init();

  // Prefer ticket-based sign-in on localhost. Production __session cookies are
  // not transferable across origins and leave Clerk.loaded=false on 127.0.0.1.
  if (clerkTicket) {
    const ticketUrl = `${baseUrl.replace(/\/$/, '')}/sign-in?__clerk_ticket=${encodeURIComponent(clerkTicket)}`;
    await page.navigate(ticketUrl);
  } else if (cookie) {
    await cdp.send(
      'Network.setCookies',
      { cookies: cookiesFromHeader(cookie, baseUrl) },
      page.sessionId,
    );
    await page.navigate('/');
  } else {
    throw new Error('createActor requires cookie or clerkTicket');
  }

  try {
    await page.waitFor(() => page.evaluate('Boolean(window.Clerk?.loaded)'), 45_000);
  } catch (error) {
    const debug = await page.evaluate(`({
      href: location.href,
      hasClerk: Boolean(window.Clerk),
      loaded: window.Clerk?.loaded ?? null,
      cookieNames: document.cookie.split(';').map((p) => p.split('=')[0].trim()).filter(Boolean),
    })`);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} clerk_load_debug=${JSON.stringify(debug)}`,
    );
  }

  if (clerkTicket) {
    const ticketLiteral = JSON.stringify(clerkTicket);
    await page.evaluate(`(async () => {
      if (window.Clerk?.session) return true;
      const ticket = ${ticketLiteral};
      try {
        const result = await window.Clerk.client.signIn.create({ strategy: 'ticket', ticket });
        if (result?.createdSessionId) {
          await window.Clerk.setActive({ session: result.createdSessionId });
        }
      } catch (e) {}
      return Boolean(window.Clerk?.session);
    })()`);
  }

  try {
    await page.waitFor(() => page.evaluate('Boolean(window.Clerk?.session)'), 45_000);
  } catch (error) {
    const debug = await page.evaluate(`({
      href: location.href,
      hasClerk: Boolean(window.Clerk),
      session: window.Clerk?.session?.id ?? null,
      user: window.Clerk?.user?.id ?? null,
      loaded: window.Clerk?.loaded ?? null,
      cookieNames: document.cookie.split(';').map((p) => p.split('=')[0].trim()).filter(Boolean),
    })`);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} clerk_debug=${JSON.stringify(debug)}`,
    );
  }

  const orgLiteral = JSON.stringify(orgId);
  // Organizations may be disabled on the local/test Clerk instance. Prefer an
  // active personal session; attempt org activation but do not hard-fail if
  // the instance has no organization feature.
  await page.evaluate(`(async () => {
    try {
      if (window.Clerk?.organization?.id !== ${orgLiteral}) {
        await window.Clerk?.setActive({ organization: ${orgLiteral} });
      }
    } catch (e) {}
    return window.Clerk?.organization?.id ?? null;
  })()`);
  const orgMatched = await page.evaluate(`window.Clerk?.organization?.id === ${orgLiteral}`);
  if (!orgMatched) {
    const hasSession = await page.evaluate('Boolean(window.Clerk?.session)');
    if (!hasSession) throw new Error('Clerk session missing after auth');
  }
  await page.navigate('/');
  await page.waitFor(() => page.evaluate('Boolean(window.Clerk?.session)'), 20_000);
  return page;
}
