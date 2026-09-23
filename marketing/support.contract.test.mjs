import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, ...parts), 'utf8');

test('generated support page has the public route contract and accessible structure', () => {
  const page = read('support.html');

  assert.match(page, /<title>Support for Capiro and Meri \| Capiro<\/title>/);
  assert.match(page, /<meta name="description" content="Get help with Capiro and Meri account access, app issues, and privacy or data requests\.">/);
  assert.match(page, /<link rel="canonical" href="https:\/\/capiro\.ai\/support">/);
  assert.match(page, /<main id="main-content" class="support-page">/);
  assert.equal((page.match(/<h1(?:\s|>)/g) || []).length, 1);
  assert.match(page, /aria-labelledby="support-categories-title"/);
  assert.match(page, /Account access/);
  assert.match(page, /App issues/);
  assert.match(page, /Privacy and data/);
  assert.match(page, /href="mailto:info@capiro\.ai"/);
  assert.match(page, /href="https:\/\/capiro\.ai\/privacy"/);
});

test('support source avoids unsupported contact and service claims', () => {
  const source = read('templates', 'pages', 'support.html');

  assert.doesNotMatch(source, /\b24\/?7\b|response (?:time|within)|business (?:day|hour)|phone|call us|staffed hours?|mailing address/i);
  assert.doesNotMatch(source, /delete (?:your|an?) account|self-service deletion/i);
  assert.doesNotMatch(source, /client name|meeting title|prompt text|attachment contents?/i);
});

test('support is discoverable without claiming it is deployed', () => {
  const sitemap = read('sitemap.xml');
  const footer = read('templates', 'footer.html');
  const homeFooter = read('templates', 'footer-home.html');

  assert.match(sitemap, /<loc>https:\/\/capiro\.ai\/support<\/loc>\s*<lastmod>2026-09-23<\/lastmod>/);
  assert.match(footer, /<a href="\/support">Support<\/a>/);
  assert.match(homeFooter, /<a href="\/support">Support<\/a>/);
});
