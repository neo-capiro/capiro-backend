import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { openCase17MemoryPanel } from '../case17-memory-ui.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

// A real browser fixture: React's atomic rail render is represented by a delayed
// DOM replacement. Navigation is already complete while all entry controls are
// initially absent, matching the saved live failure. No auth/network/provider.
async function installDelayedRail(page, mode) {
  await page.setContent('<main>Route loading</main>');
  await page.evaluate(mode => {
    window.transitions = [];
    const render = next => {
      const aside = document.createElement('aside');
      aside.setAttribute('data-meri-context-rail', '');
      const button = document.createElement('button');
      button.textContent = next === 'collapsed' ? 'Expand panel'
        : next === 'inspector' ? 'Open Context and Memory' : 'Memory';
      button.addEventListener('click', () => {
        window.transitions.push(button.textContent);
        if (next === 'collapsed') render('inspector');
        else if (next === 'inspector') render('context');
        else {
          const section = document.createElement('section');
          section.textContent = 'YOUR PROPOSALS · 6'; aside.append(section);
        }
      });
      aside.append(button); document.querySelector('main').replaceChildren(aside);
    };
    window.scheduleRail = () => setTimeout(() => render(mode), 150);
  }, mode);
}

test('real browser reproduces pre-mount skip and corrected collector waits before choosing controls', { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await installDelayedRail(page, 'inspector');
    const oldExpand = page.getByRole('button', { name: 'Expand panel', exact: true });
    const oldContext = page.getByRole('button', { name: 'Open Context and Memory', exact: true });
    assert.equal(await oldExpand.isVisible(), false);
    assert.equal(await oldContext.isVisible(), false);
    await page.evaluate(() => window.scheduleRail());
    await assert.rejects(page.getByRole('button', { name: 'Memory', exact: true }).click({ timeout: 500 }), { name: 'TimeoutError' });
    assert.equal(await oldContext.isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.transitions), []);

    for (const mode of ['collapsed', 'inspector', 'context']) {
      await installDelayedRail(page, mode);
      assert.equal(await page.locator('[data-meri-context-rail]').count(), 0);
      await page.evaluate(() => window.scheduleRail());
      await openCase17MemoryPanel(page);
      assert.equal(await page.getByText('YOUR PROPOSALS · 6', { exact: true }).isVisible(), true);
      const expected = mode === 'collapsed' ? ['Expand panel', 'Open Context and Memory', 'Memory']
        : mode === 'inspector' ? ['Open Context and Memory', 'Memory'] : ['Memory'];
      assert.deepEqual(await page.evaluate(() => window.transitions), expected);
    }
  } finally { await browser.close(); }
});
