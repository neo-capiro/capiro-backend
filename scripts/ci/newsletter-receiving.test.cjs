const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runNewsletterReceivingCorpus } = require('./fixtures/newsletter-receiving-corpus.cjs');
const publicPath = process.env.NEWSLETTER_RECEIVING_PUBLIC_JS;
if (!publicPath)
  throw new Error(
    'Supply NEWSLETTER_RECEIVING_PUBLIC_JS for the exact compiled public newsletter namespace.',
  );
const api = require(publicPath);
const results = runNewsletterReceivingCorpus(api);
for (const result of results.cases)
  test(result.name, () => assert.equal(result.passed, true, result.error));
