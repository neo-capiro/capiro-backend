import { qualifyDocumentTextOnlyRuntime } from './document-runtime-qualification.js';
const expected = { allocationSha256: 'd'.repeat(64), profileVersion: '1.1.0' as const, chargeMicrousd: 1 as const,
  documentPricing: { mode: 'source_text_only' as const, route: '/api/clio/tools/read_client_documents' as const,
    coreSourceCommit: 'a'.repeat(40), coreImageDigest: `sha256:${'b'.repeat(64)}`, configurationSha256: 'c'.repeat(64) } };
const runtime = { sourceHead: expected.documentPricing.coreSourceCommit, imageDigest: expected.documentPricing.coreImageDigest,
  configurationSha256: expected.documentPricing.configurationSha256 };
describe('independent current runtime document qualification', () => {
  it('matches all three exact pins against the original allocation', () => {
    expect(qualifyDocumentTextOnlyRuntime(expected, runtime)).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['sourceHead', 'imageDigest', 'configurationSha256'])('refuses a changed or missing %s', (key) => {
    expect(() => qualifyDocumentTextOnlyRuntime(expected, { ...runtime, [key]: 'other' })).toThrow();
    const missing = { ...runtime } as Record<string, unknown>; delete missing[key];
    expect(() => qualifyDocumentTextOnlyRuntime(expected, missing)).toThrow();
  });
  it('refuses absent, extra or self-declared environment evidence', () => {
    expect(() => qualifyDocumentTextOnlyRuntime(null, runtime)).toThrow();
    expect(() => qualifyDocumentTextOnlyRuntime(expected, undefined)).toThrow();
    expect(() => qualifyDocumentTextOnlyRuntime(expected, { ...runtime, verified: true })).toThrow();
    expect(() => qualifyDocumentTextOnlyRuntime(expected, { RELEASE_SHA: runtime.sourceHead,
      CORE_IMAGE_DIGEST: runtime.imageDigest, CORE_CONFIG_SHA: runtime.configurationSha256 })).toThrow();
  });
});
