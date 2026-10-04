import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { openCase14MemoryPanel, waitForCase14MemoryQuery } from '../case14-approval-capture.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

test(
  'case14 waits for real browser rail mount and delayed review/history results',
  { timeout: 20000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      let network = 0;
      await context.route('**/*', (route) => {
        network++;
        return route.abort();
      });
      const page = await context.newPage();
      await page.setContent('<main>Loading route</main>');
      assert.equal(
        await page
          .getByRole('button', { name: 'Open Context and Memory', exact: true })
          .isVisible(),
        false,
      );
      await page.evaluate(() => {
        window.actions = [];
        setTimeout(() => {
          document.querySelector('main').innerHTML =
            '<aside data-meri-context-rail><button>Open Context and Memory</button></aside>';
          document.querySelector('button').onclick = () => {
            window.actions.push('context');
            document.querySelector('aside').innerHTML = '<button>Memory</button>';
            document.querySelector('button').onclick = () => {
              window.actions.push('memory');
              document.querySelector('aside').innerHTML =
                '<section><div>NEEDS YOUR REVIEW · 0</div><p>Loading review queue…</p></section>';
            };
          };
        }, 100);
      });
      await openCase14MemoryPanel(page);
      const oldCard = page.locator('section article');
      assert.equal(await oldCard.count(), 0, 'old immediate count misclassifies the loading query');
      await page.evaluate(() =>
        setTimeout(() => {
          document.querySelector('section').innerHTML =
            '<div>NEEDS YOUR REVIEW · 1</div><article>Synthetic Aster candidate for approval<button>Approve</button></article>';
        }, 100),
      );
      const review = await waitForCase14MemoryQuery(page, 'review');
      assert.equal(await review.locator('article').count(), 1);
      assert.deepEqual(await page.evaluate(() => window.actions), ['context', 'memory']);

      await page.setContent(
        '<section><div>DECISION RECEIPTS · 0</div><p>Loading decision receipts…</p></section>',
      );
      assert.equal(await page.locator('[aria-label="Memory decision receipt"]').count(), 0);
      await page.evaluate(() =>
        setTimeout(() => {
          document.querySelector('section').innerHTML =
            '<div>DECISION RECEIPTS · 1</div><article><div aria-label="Memory decision receipt">Candidate: test-owned-id</div></article>';
        }, 100),
      );
      const history = await waitForCase14MemoryQuery(page, 'history');
      assert.equal(await history.locator('[aria-label="Memory decision receipt"]').count(), 1);
      assert.equal(network, 0);
    } finally {
      await browser.close();
    }
  },
);

test(
  'actual settled query errors remain failures; empty review is not an approval',
  { timeout: 20000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      for (const [kind, label, error, code] of [
        [
          'review',
          'NEEDS YOUR REVIEW ·',
          'The institutional review queue could not be loaded.',
          'REVIEW_QUERY_FAILED',
        ],
        [
          'history',
          'DECISION RECEIPTS ·',
          'Decision receipts could not be loaded.',
          'HISTORY_QUERY_FAILED',
        ],
      ]) {
        await page.setContent(`<section><div>${label} 0</div><p>${error}</p></section>`);
        await assert.rejects(waitForCase14MemoryQuery(page, kind), new RegExp(code, 'u'));
      }
      await page.setContent(
        '<section><div>NEEDS YOUR REVIEW · 0</div><p>Nothing is waiting for your review.</p></section>',
      );
      assert.equal(
        await (await waitForCase14MemoryQuery(page, 'review')).locator('article').count(),
        0,
      );
      await assert.rejects(waitForCase14MemoryQuery(page, 'unsupported'), /QUERY_KIND/u);
    } finally {
      await browser.close();
    }
  },
);
