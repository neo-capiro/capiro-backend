const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { join, dirname } = require('node:path');

const publicPath = process.env.NEWSLETTER_RECEIVING_PUBLIC_JS;
if (!publicPath)
  throw new Error(
    'Supply NEWSLETTER_RECEIVING_PUBLIC_JS for the exact compiled public newsletter namespace.',
  );
const api = require(publicPath);
const renderer = require(join(dirname(publicPath), 'newsletter-render.js'));
// Synthetic identities only. Match NewsletterService.renderPreview on the accepted Core137
// producer: real shared rendering, exact hash encoding, and saved document/revision fields.
const documentId = 'a1111111-1111-4111-8111-111111111111';
const otherDocumentId = 'b2222222-2222-4222-8222-222222222222';
const expected = { documentId, revision: 3 };
const design = api.governmentAffairsNewsletter();
const config = api.defaultNewsletterConfig();
const options = { editor: true, publicUrl: 'https://example.test' };
const html = renderer.renderNewsletterDesign(design, config, options);
const plainText = renderer.newsletterPlainText(design, config, options);
const content = { html, plainText, checks: [] };
const preview = {
  ...expected,
  renderHash: createHash('sha256').update(JSON.stringify({ html, plainText })).digest('hex'),
  hashFormat: 'newsletter-render-json-v1',
  ...content,
};

function refused(value, binding, code = 'invalid_shape', path) {
  const result =
    binding === undefined
      ? api.parseNewsletterPreview(value)
      : api.parseNewsletterPreview(value, binding);
  assert.equal(result.ok, false, 'invalid or unbound response must not become a pinned preview');
  assert.equal(result.error.code, code);
  if (path) assert.equal(result.error.path, path);
}

test('accepts the saved producer receipt only against matching expected document and revision', () => {
  const result = api.parseNewsletterPreview(preview, expected);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, preview);
  assert.notEqual(result.value, preview);
  assert.match(result.value.html, /The week in policy\./);
  assert.equal(
    api.parseNewsletterPreview(preview, { ...expected, documentId: documentId.toUpperCase() }).ok,
    true,
  );
});

test('keeps existing unpinned content parsing but refuses it when a pin is required', () => {
  const result = api.parseNewsletterPreview(content);
  assert.deepEqual(result, { ok: true, value: content });
  assert.equal(Object.hasOwn(result.value, 'documentId'), false);
  refused(content, expected, 'invalid_shape', '$.documentId');
});

test('keeps HTML inert and checks intact even with a validated receipt', () => {
  const hostile = {
    ...preview,
    html: '<script>untrusted()</script>',
    checks: [{ id: 'source', severity: 'warning', label: 'Review', detail: 'Saved check' }],
  };
  assert.deepEqual(api.parseNewsletterPreview(hostile, expected), { ok: true, value: hostile });
});

for (const field of ['documentId', 'revision', 'renderHash', 'hashFormat']) {
  test(`rejects a partial pin missing ${field}, including in the unbound form`, () => {
    const partial = { ...preview };
    delete partial[field];
    refused(partial, expected, 'invalid_shape', `$.${field}`);
    refused(partial, undefined, 'invalid_shape', `$.${field}`);
  });
}

for (const [field, values] of [
  ['documentId', ['', 'document-name', otherDocumentId.replace('-4222-', '-0222-')]],
  ['revision', [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3']],
  [
    'renderHash',
    [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'g'.repeat(64),
      'A'.repeat(64),
      `sha256:${'a'.repeat(64)}`,
      null,
    ],
  ],
  ['hashFormat', ['', 'newsletter-render-json-v2', null]],
]) {
  test(`rejects malformed ${field} in bound and unbound receiving`, () => {
    for (const value of values) {
      refused({ ...preview, [field]: value }, expected, 'invalid_shape', `$.${field}`);
      refused({ ...preview, [field]: value }, undefined, 'invalid_shape', `$.${field}`);
    }
  });
}

test('rejects a valid receipt for another document', () => {
  refused(
    { ...preview, documentId: otherDocumentId },
    expected,
    'identity_mismatch',
    '$.documentId',
  );
});

test('rejects a valid receipt from another saved revision', () => {
  refused({ ...preview, revision: 4 }, expected, 'identity_mismatch', '$.revision');
});

test('requires both valid consumer expectations and rejects unexpected binding keys', () => {
  refused(preview, {}, 'invalid_shape', '$expected.documentId');
  refused(preview, { documentId }, 'invalid_shape', '$expected.revision');
  refused(preview, { revision: 3 }, 'invalid_shape', '$expected.documentId');
  refused(preview, { ...expected, revision: 0 }, 'invalid_shape', '$expected.revision');
  refused(preview, { ...expected, stageId: otherDocumentId }, 'invalid_shape', '$expected.stageId');
});

test('refuses accessor input without executing it', () => {
  let reads = 0;
  const unsafe = { ...preview };
  Object.defineProperty(unsafe, 'renderHash', {
    enumerable: true,
    get() {
      reads += 1;
      return preview.renderHash;
    },
  });
  refused(unsafe, expected, 'invalid_json', '$.renderHash');
  assert.equal(reads, 0);
});
