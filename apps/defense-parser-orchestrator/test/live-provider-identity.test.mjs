import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLivePageIdentity,
  buildProviderManifest,
} from '../src/real-batch.mjs';

const H = (ch) => ch.repeat(64);

function identity(requestedParserMethod) {
  return buildLivePageIdentity({
    sourceSha256: H('a'),
    pageNumber: 7,
    parserMethod: requestedParserMethod,
    modelName: 'nemotron-parse',
    modelVersion: 'LLM-NIM-1.14_VLM-NIM-1.5.0',
    parserOptionsHash: H('b'),
    renderedImageSha256: H('c'),
    providerPayloadSha256: H('d'),
    renderingConfigSha256: H('e'),
  });
}

test('subscribed live provider is always recorded as nemotron_parse while governed table/OCR route intent remains separate', () => {
  const table = identity('nvidia_page_elements_table_structure');
  assert.equal(table.requestedParserMethod, 'nvidia_page_elements_table_structure');
  assert.equal(table.parserMethod, 'nemotron_parse');

  const ocr = identity('nvidia_ocr');
  assert.equal(ocr.requestedParserMethod, 'nvidia_ocr');
  assert.equal(ocr.parserMethod, 'nemotron_parse');
});

test('input sidecar retains requested route intent but identifies actual batch provider truthfully', () => {
  const page = identity('nvidia_page_elements_table_structure');
  const payload = { model: 'nvidia/nemotron-parse' };
  const batch = {
    batchId: 'batch',
    sourceDocumentId: 'doc',
    sourceSha256: H('a'),
    parserMethod: page.parserMethod,
    modelName: page.modelName,
    modelVersion: page.modelVersion,
    parserOptionsHash: page.parserOptionsHash,
    pages: [
      {
        ...page,
        pageClass: 'complex_table',
        cacheKey: 'cache',
        escalationReason: 'governed_escalation_complex_table',
        providerPayload: payload,
        providerPayloadSha256: H('d'),
      },
    ],
  };
  // Keep the payload hash aligned with the test fixture rather than weakening
  // buildProviderManifest's immutable-byte check.
  batch.pages[0].providerPayloadSha256 =
    (await import('../src/session5.mjs')).sha256Hex(
      (await import('../src/session5.mjs')).canonicalJson(payload),
    );
  const manifest = buildProviderManifest(batch);
  assert.equal(manifest.sidecar.parserMethod, 'nemotron_parse');
  assert.equal(
    manifest.sidecar.records[0].requestedParserMethod,
    'nvidia_page_elements_table_structure',
  );
  assert.equal(manifest.sidecar.records[0].actualParserMethod, 'nemotron_parse');
});
