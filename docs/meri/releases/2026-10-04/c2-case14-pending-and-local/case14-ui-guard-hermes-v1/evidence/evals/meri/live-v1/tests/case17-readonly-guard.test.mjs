import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  createCase17WriteAccounting,
  inspectCase17WriteAccounting,
} from '../case17-readonly-guard.mjs';
import { screenshotCase17Card } from '../case17-memory-ui.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const origin = 'https://os.capiro.ai';
const preferencePath = '/api/clio/vnext/preferences';
const request = (method, url) => ({ method: () => method, url: () => url });

test(
  'real Chromium aborts the navigation preference PUT and a business POST; nested guards count once',
  { timeout: 20000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      const accounting = createCase17WriteAccounting();
      let forwardedWrites = 0,
        failedWrites = 0;
      page.on('requestfailed', (value) => {
        if (value.method() !== 'GET') failedWrites++;
      });
      await context.route('**/*', (route) => {
        if (accounting.deny(route.request())) return route.abort();
        if (route.request().method() !== 'GET') forwardedWrites++;
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<button>Memory</button>',
        });
      });
      await page.route('**/*', (route) =>
        accounting.deny(route.request()) ? route.abort() : route.fallback(),
      );
      await page.goto(origin + '/meri');
      accounting.panelPhase('initial');
      await page.evaluate((path) => {
        document.querySelector('button').onclick = () => {
          window.preferenceRequest = fetch(path, {
            method: 'PUT',
            body: '{"openSection":"memory"}',
          }).then(
            () => 'forwarded',
            () => 'aborted',
          );
        };
      }, preferencePath);
      await page.getByRole('button', { name: 'Memory', exact: true }).click();
      assert.equal(await page.evaluate(() => window.preferenceRequest), 'aborted');
      assert.equal(inspectCase17WriteAccounting(accounting.snapshot()), true);
      assert.equal(accounting.snapshot().blockedWrites, 1);
      assert.equal(accounting.snapshot().blockedPreferenceWrites, 1);
      assert.equal(
        await page.evaluate(async () =>
          fetch('/api/memory/proposals/private-identifier?secret=query', {
            method: 'POST',
            body: 'must-not-be-recorded',
          }).then(
            () => 'forwarded',
            () => 'aborted',
          ),
        ),
        'aborted',
      );
      assert.equal(forwardedWrites, 0);
      assert.equal(failedWrites, 2);
      assert.equal(accounting.snapshot().blockedWrites, 2);
      assert.equal(accounting.snapshot().blockedPreferenceWrites, 1);
      assert.throws(() => inspectCase17WriteAccounting(accounting.snapshot()), /WRITE_ACCOUNTING/u);
      assert.deepEqual(accounting.snapshot().blockedWriteRequests[1], {
        method: 'POST',
        path: '[redacted]',
        phase: 'initial',
        kind: 'blocked_other_write',
      });
      assert.doesNotMatch(
        JSON.stringify(accounting.snapshot()),
        /secret|private-identifier|must-not-be-recorded/u,
      );
    } finally {
      await browser.close();
    }
  },
);

test('only bounded exact same-origin PUTs within each panel round qualify; all other writes remain denied', () => {
  for (const [method, url, phase] of [
    ['POST', origin + preferencePath, 'initial'],
    ['PUT', origin + preferencePath + '?key=private', 'initial'],
    ['PUT', origin + preferencePath + '#fragment', 'initial'],
    ['PUT', origin + preferencePath + '/', 'initial'],
    ['PUT', 'https://untrusted.invalid' + preferencePath, 'initial'],
    ['PUT', origin + preferencePath, 'outsidePanel'],
  ]) {
    const accounting = createCase17WriteAccounting();
    accounting.panelPhase(phase);
    assert.equal(accounting.deny(request(method, url)), true);
    assert.throws(() => inspectCase17WriteAccounting(accounting.snapshot()));
  }
  const accounting = createCase17WriteAccounting();
  assert.equal(accounting.deny(request('GET', origin + preferencePath)), false);
  assert.equal(accounting.deny(request('POST', 'https://clerk.app.capiro.ai/v1/client')), false);
  for (const phase of ['initial', 'afterReload']) {
    accounting.panelPhase(phase);
    for (let i = 0; i < 3; i++)
      assert.equal(accounting.deny(request('PUT', origin + preferencePath)), true);
  }
  assert.equal(inspectCase17WriteAccounting(accounting.snapshot()), true);
  accounting.deny(request('PUT', origin + preferencePath));
  assert.throws(() => inspectCase17WriteAccounting(accounting.snapshot()));
  const sameRound = createCase17WriteAccounting();
  sameRound.panelPhase('initial');
  for (let i = 0; i < 4; i++) sameRound.deny(request('PUT', origin + preferencePath));
  assert.throws(() => inspectCase17WriteAccounting(sameRound.snapshot()));
  const mutated = accounting.snapshot();
  mutated.blockedWriteRequests = [];
  assert.throws(() => inspectCase17WriteAccounting(mutated));
});

test(
  'card screenshot restores real nested scroll visibility and rejects a card wider than its clipping ancestor',
  { timeout: 20000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      await page.route('**/*', (route) => route.abort());
      await page.setContent(`<div id="outer" style="margin:80px;width:420px;height:400px;overflow:auto;border:2px solid black">
      <div style="width:800px;height:900px;padding-top:200px;box-sizing:border-box">
        <article style="margin-left:30px;width:320px;height:180px;background:rgb(10,180,30)">
          <h3>Owned card D</h3><p>Target</p><p>Proposed value</p><p>Synthetic fixture</p><button>Withdraw</button>
        </article>
      </div></div>`);
      await page.evaluate(() => {
        const outer = document.querySelector('#outer');
        outer.scrollLeft = 180;
        outer.scrollTop = 320;
      });
      const geometry = () =>
        page.evaluate(() => {
          const a = document.querySelector('article').getBoundingClientRect();
          const p = document.querySelector('#outer').getBoundingClientRect();
          return {
            left: a.left,
            top: a.top,
            right: a.right,
            bottom: a.bottom,
            clipLeft: p.left + 2,
            clipTop: p.top + 2,
            clipRight: p.left + 422,
            clipBottom: p.top + 402,
          };
        });
      const before = await geometry();
      assert.ok(before.left < before.clipLeft && before.top < before.clipTop);
      const text = await page.locator('article').innerText();
      const styles = await page.locator('article').getAttribute('style');
      const png = await screenshotCase17Card(page.locator('article'));
      const after = await geometry();
      assert.ok(
        after.left >= after.clipLeft &&
          after.top >= after.clipTop &&
          after.right <= after.clipRight &&
          after.bottom <= after.clipBottom,
      );
      // Chromium rounds the fractional CSS bounds outwards to physical pixels.
      assert.equal(png.readUInt32BE(16), Math.ceil(after.right) - Math.floor(after.left));
      assert.equal(png.readUInt32BE(20), Math.ceil(after.bottom) - Math.floor(after.top));
      assert.equal(await page.locator('article').innerText(), text);
      assert.equal(await page.locator('article').getAttribute('style'), styles);
      await page.locator('article').evaluate((node) => {
        node.style.width = '600px';
      });
      await assert.rejects(
        screenshotCase17Card(page.locator('article')),
        /CARD_SCREENSHOT_CLIPPED/u,
      );
    } finally {
      await browser.close();
    }
  },
);
