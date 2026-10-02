import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { waitForCase17ProposalQuery } from '../case17-memory-ui.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

test('visible section can precede the query; collector waits for exact cards before counting', { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let networkCalls = 0;
    await page.route('**/*', route => { networkCalls++; return route.abort(); });
    await page.setContent('<section><div>YOUR PROPOSALS · 0</div><div>Loading your proposals…</div></section>');
    const initial = page.locator('section').filter({ has: page.getByText(/^YOUR PROPOSALS ·/u) });
    await initial.waitFor({ state: 'visible' });
    // The old collector proceeded here, then rejected the first missing card.
    assert.equal(await initial.getByRole('button', { name: 'Load more proposals', exact: true }).count(), 0);
    assert.equal(await initial.locator('article').count(), 0);
    const keys = Array.from({ length: 6 }, (_, index) => `unit-owned-key-${index}`);
    await page.evaluate(keys => {
      window.proposalClicks = 0;
      setTimeout(() => {
        const section = document.querySelector('section');
        section.innerHTML = '<div>YOUR PROPOSALS · 6</div>' + keys.map(key => `<article><h3>${key}</h3><button>Withdraw</button></article>`).join('');
        for (const button of section.querySelectorAll('button')) button.onclick = () => { window.proposalClicks++; };
      }, 150);
    }, keys);
    const section = await waitForCase17ProposalQuery(page);
    for (const key of keys)
      assert.equal(await section.locator('article').filter({ has: page.getByText(key, { exact: true }) }).count(), 1);
    assert.equal(await section.locator('article').count(), 6);
    assert.equal(await page.evaluate(() => window.proposalClicks), 0);
    assert.equal(networkCalls, 0);

    // Readiness cannot normalize duplicates or substitute an unexpected key.
    await page.evaluate(() => document.querySelector('section').append(document.querySelector('article').cloneNode(true)));
    const duplicate = await waitForCase17ProposalQuery(page);
    assert.equal(await duplicate.locator('article').filter({ has: page.getByText(keys[0], { exact: true }) }).count(), 2);
  } finally { await browser.close(); }
});

test('failed query rejects; actual empty result remains empty for unchanged strict card assertions', { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent('<section><div>YOUR PROPOSALS · 0</div><div>Your proposal history could not be loaded.</div></section>');
    await assert.rejects(waitForCase17ProposalQuery(page), /CASE17_UI_PROPOSALS_QUERY_FAILED/u);
    await page.setContent('<section><div>YOUR PROPOSALS · 0</div><div>You have not proposed an institutional memory change.</div></section>');
    const section = await waitForCase17ProposalQuery(page);
    assert.equal(await section.locator('article').count(), 0);
    assert.equal(await section.getByRole('button').count(), 0);
  } finally { await browser.close(); }
});
