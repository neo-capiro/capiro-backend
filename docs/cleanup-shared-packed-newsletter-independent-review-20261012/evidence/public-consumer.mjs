import assert from 'node:assert/strict';
import { createNewsletterBlock, defaultNewsletterConfig, defaultNewsletterStyles, NEWSLETTER_TEMPLATE_ID } from '@capiro/shared/newsletter';
import { renderNewsletterBlock, newsletterEscape, newsletterSocialShareTarget } from '@capiro/shared/newsletter-render';
assert.equal(NEWSLETTER_TEMPLATE_ID, 'bp_weekly_newsletter');
assert.equal(newsletterEscape('<"&'), '&lt;&quot;&amp;');
assert.ok(renderNewsletterBlock(createNewsletterBlock('paragraph', { id: 'esm', text: 'Public ESM' }), { version: 1, styles: defaultNewsletterStyles(), sections: [] }, defaultNewsletterConfig()).includes('Public ESM'));
assert.equal(newsletterSocialShareTarget('https://example.com/engagement/newsletter-public/token'), '');
console.log(JSON.stringify({ publicEsmImports: true, cases: 4, privateSourceImports: false }));
