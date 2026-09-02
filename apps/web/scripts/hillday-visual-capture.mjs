
import * as chromeLauncher from 'chrome-launcher';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const baseUrl = 'http://127.0.0.1:4199';
const outputDir = 'artifacts/hillday-visual';
await mkdir(outputDir, { recursive: true });

const targets = [
  { name: 'hillday-library-1440', path: '/vnext-shell.html?screen=hillday-library', width: 1440, height: 1000, expect: '.hd-library' },
  { name: 'hillday-wizard-1440', path: '/vnext-shell.html?screen=hillday-wizard', width: 1440, height: 1000, expect: '.hd-flow' },
  { name: 'hillday-editor-1440', path: '/vnext-shell.html?screen=hillday-editor', width: 1440, height: 1000, expect: '.hd-editor' },
  { name: 'hillday-editor-1180', path: '/vnext-shell.html?screen=hillday-editor', width: 1180, height: 1000, expect: '.hd-editor' },
  { name: 'hillday-editor-900', path: '/vnext-shell.html?screen=hillday-editor', width: 900, height: 1000, expect: '.hd-editor' },
  { name: 'hillday-editor-760', path: '/vnext-shell.html?screen=hillday-editor', width: 760, height: 900, expect: '.hd-editor' },
];

for (const target of targets) {
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--proxy-server=direct://', '--proxy-bypass-list=*', '--hide-scrollbars', '--force-device-scale-factor=1'],
  });
  try {
    const list = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
    const page = list.find((e) => e.type === 'page' && e.webSocketDebuggerUrl);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
      }
    });
    await new Promise((res) => ws.addEventListener('open', res, { once: true }));
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: target.width, height: target.height, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${baseUrl}${target.path}` });
    const deadline = Date.now() + 30000;
    let ok = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const t = await send('Runtime.evaluate', { expression: `Boolean(document.querySelector(${JSON.stringify(target.expect)}))`, returnByValue: true });
      if (t?.result?.value === true) { ok = true; break; }
    }
    if (!ok) throw new Error(`${target.name}: selector never appeared`);
    await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true });
    await send('Runtime.evaluate', { expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', awaitPromise: true });
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const bytes = Buffer.from(shot.data, 'base64');
    await writeFile(path.join(outputDir, `${target.name}.png`), bytes);
    console.log(`${target.name}: ${bytes.length} bytes sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`);
    ws.close();
  } finally {
    try { await chrome.kill(); } catch (e) {}
  }
}
console.log('DONE');
