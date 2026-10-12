const test = require('node:test');
const assert = require('node:assert/strict');
const n = require('@capiro/shared/newsletter');
const r = require('@capiro/shared/newsletter-render');
const design = { version: 1, styles: n.defaultNewsletterStyles(), sections: [] };
const config = n.defaultNewsletterConfig();
const block = (kind, overrides = {}) => n.createNewsletterBlock(kind, { id: 'fixture-' + kind, ...overrides });
const render = (value, options = {}) => r.renderNewsletterBlock(value, design, config, options);

test('consumer resolves only immutable public package exports', () => {
  for (const name of ['newsletter', 'newsletter-render']) {
    const path = require.resolve('@capiro/shared/' + name);
    assert.ok(path.startsWith(__dirname + '/node_modules/@capiro/shared/dist/'));
  }
  assert.equal(n.NEWSLETTER_TEMPLATE_ID, 'bp_weekly_newsletter');
  assert.deepEqual(n.NEWSLETTER_BLOCK_KINDS, ['image','heading','paragraph','button','divider','spacer','video','social','logo','survey','code','apps','product','product-rec','footer','columns']);
});
test('private source, dist and undeclared font subpaths stay refused', () => {
  for (const path of ['src/newsletter', 'dist/newsletter.js', 'newsletter-fonts']) assert.throws(() => require('@capiro/shared/' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
test('default rich and code renderers escape rather than sanitize HTML', () => {
  const html = '<script>alert("x")</script><b>Hello</b>';
  const paragraph = render(block('paragraph', { html }));
  assert.ok(paragraph.includes('&lt;script&gt;'));
  assert.ok(!paragraph.includes('<script>'));
  const code = render(block('code', { html }));
  assert.ok(code.includes('<pre '));
  assert.ok(code.includes('&lt;b&gt;Hello&lt;/b&gt;'));
});
test('caller sanitizer output is an explicit trusted boundary', () => {
  const calls = [];
  const output = render(block('paragraph', { html: '<b>input</b>' }), { sanitizeHtml: value => { calls.push(value); return '<script>caller-trusted</script><b>output</b>'; } });
  assert.deepEqual(calls, ['<b>input</b>']);
  assert.ok(output.includes('<script>caller-trusted</script>'));
  assert.ok(output.includes('<b>output</b>'));
});
test('URL helper refuses invalid protocols, credentials and image SVG data', () => {
  for (const value of ['javascript:alert(1)', 'file:///tmp/a', 'https://user:pass@example.com/x', 'data:text/html;base64,WA==', '//example.com/x']) assert.equal(r.newsletterSafeUrl(value), '');
  assert.equal(r.newsletterSafeUrl('data:image/svg+xml;base64,WA==', true), '');
  assert.equal(r.newsletterSafeUrl('data:image/png;base64,WA==', true), 'data:image/png;base64,WA==');
  assert.equal(r.newsletterSafeUrl('mailto:hello@example.com'), 'mailto:hello@example.com');
  assert.equal(r.newsletterSafeUrl('/newsletter/capitol.png'), '/newsletter/capitol.png');
  assert.equal(r.newsletterSafeUrl('*|UNSUB|*'), '*|UNSUB|*');
});
test('invalid original links do not invoke rewrite; trusted rewrites are not revalidated', () => {
  let calls = 0;
  const refused = render(block('button', { text: 'Go', url: 'javascript:bad' }), { rewriteLink: () => { calls++; return 'https://unused.example/'; } });
  assert.equal(calls, 0); assert.ok(refused.includes('href="#"'));
  const trusted = render(block('button', { text: 'Go', url: 'https://example.com/' }), { rewriteLink: (url, id) => { calls++; assert.equal(url, 'https://example.com/'); assert.equal(id, 'fixture-button'); return 'javascript:caller-trusted'; } });
  assert.equal(calls, 1); assert.ok(trusted.includes('href="javascript:caller-trusted"'));
});
test('visibility is recipient-specific and editor mode deliberately shows hidden blocks', () => {
  const hidden = block('paragraph', { text: 'Private', visibility: { mode: 'custom', rules: [{ field: 'email', operator: 'is', value: 'owner@example.com' }] } });
  assert.equal(render(hidden), '');
  assert.equal(render(hidden, { recipient: { email: 'other@example.com' } }), '');
  assert.ok(render(hidden, { recipient: { email: 'OWNER@example.com' } }).includes('Private'));
  assert.ok(render(hidden, { editor: true }).includes('opacity:.65'));
});
test('hosted survey rendering defaults disabled and callback rendering is not stage eligibility', () => {
  const survey = block('survey');
  assert.ok(render(survey).includes('aria-disabled="true"'));
  survey.survey.saved = { id: 'saved-id', sourceClientIds: [], title: 'Synthetic survey' };
  assert.ok(render(survey).includes('aria-disabled="true"'));
  assert.ok(render(survey, { savedSurveyUrl: id => { assert.equal(id, 'fixture-survey'); return 'https://example.com/survey'; } }).includes('href="https://example.com/survey"'));
});
test('share target never exports recipient public action capabilities or merge tags', () => {
  for (const target of ['https://example.com/engagement/newsletter-public/token/archive', 'https://example.com/%65ngagement/newsletter-public/token', 'https://example.com/?tag=*|UNSUB|*', 'https://u:p@example.com/', 'javascript:bad']) assert.equal(r.newsletterSocialShareTarget(target), '');
  assert.equal(r.newsletterSocialShareUrl('forward', 'https://example.com/'), '');
  assert.equal(r.newsletterSocialShareUrl('linkedin', 'https://example.com/'), 'https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fexample.com%2F');
});
test('social share configuration is explicit and unresolved targets remain disabled', () => {
  const social = block('social');
  social.social.mode = 'share';
  assert.ok(render(social).includes('aria-disabled="true"'));
  social.social.share = { ...n.defaultNewsletterSocialShare(), source: 'custom', customUrl: 'https://example.com/' };
  assert.ok(render(social).includes('linkedin.com/sharing/share-offsite'));
});
test('rendered bundled asset links are strings and do not retrieve assets', () => {
  const output = render(block('image', { imageUrl: '/newsletter/capitol.png', alt: '<safe>' }), { publicUrl: 'https://assets.example/' });
  assert.ok(output.includes('src="https://assets.example/newsletter/capitol.png"'));
  assert.ok(output.includes('alt="&lt;safe&gt;"'));
});
test('nested render/plain text traversal and fresh clone ownership survive packing', () => {
  const original = block('columns', { columns: [[block('paragraph', { text: 'First' })], [block('paragraph', { id: 'second', text: 'Second' })]] });
  const nested = { ...design, sections: [{ id: 'section', name: 'Body', style: {}, blocks: [original] }] };
  const seen = []; n.visitNewsletterBlocks(nested, b => seen.push(b.id));
  assert.deepEqual(seen, ['fixture-columns', 'fixture-paragraph', 'second']);
  assert.equal(n.findNewsletterBlock(nested, 'second').text, 'Second');
  assert.ok(r.newsletterPlainText(nested, config).includes('First'));
  assert.ok(r.renderNewsletterDesign(nested, config).includes('Second'));
  const cloned = n.cloneNewsletterBlocks([original]);
  assert.notEqual(cloned[0].id, original.id); assert.notEqual(cloned[0].columns[0][0].id, original.columns[0][0].id);
  cloned[0].columns[0][0].text = 'Changed'; assert.equal(original.columns[0][0].text, 'First');
});
test('canonical font catalog runtime is reachable without fetching fonts', () => {
  assert.ok(n.NEWSLETTER_FONT_CATALOG.length > 100);
  const font = n.newsletterCatalogFont(n.NEWSLETTER_FONT_CATALOG[0].family);
  assert.ok(font); assert.ok(n.newsletterCatalogStyle(font.family));
});
