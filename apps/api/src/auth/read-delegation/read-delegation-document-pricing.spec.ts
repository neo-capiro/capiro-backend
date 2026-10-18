import { canonicalSha256 } from './read-delegation.contract.js';
import { readDocumentTextOnlyAllocation } from './read-delegation-document-pricing.js';

const operation = { id: 'read_client_documents', version: '0.2.0' };
function allocation() {
  const budgets = { maxTurns: 20, maxToolCalls: 20, maxRuntimeSeconds: 900, maxCostMicroUSD: 2000000,
    maxOutputBytes: 1048576, maxRecoveryAttempts: 0 };
  const manifest = { contractVersion: '0.2.0', profile: 'meri.general_reads', profileVersion: '1.1.0',
    allowedOperations: [operation], budgets, maxAggregateOutputBytes: 2097152, documentPricing: { mode: 'source_text_only',
      route: '/api/clio/tools/read_client_documents', coreSourceCommit: 'a'.repeat(40),
      coreImageDigest: `sha256:${'b'.repeat(64)}`, configurationSha256: 'c'.repeat(64) } };
  return { run: { tenantId: '11111111-1111-4111-8111-111111111111', actorId: 'reader',
    conversationId: '22222222-2222-4222-8222-222222222222', runId: '33333333-3333-4333-8333-333333333333' },
    manifest, manifestSha256: canonicalSha256(manifest), catalogSha256: 'f'.repeat(64), budgets,
    schedule: { revision: 'e'.repeat(64), expiresAt: '2026-10-18T15:30:00Z', operations: [{ operation, chargeMicrousd: 1 }] } };
}
function qualify(value: any) {
  value.manifestSha256 = canonicalSha256(value.manifest);
  return readDocumentTextOnlyAllocation(value, canonicalSha256(value));
}
describe('verified original document allocation projection', () => {
  it('copies and freezes the exact manifest variant and scheduled local read floor', () => {
    const original = allocation();
    const projected = qualify(original)!;
    expect(projected).toEqual({ allocationSha256: canonicalSha256(original), profileVersion: '1.1.0',
      chargeMicrousd: 1, documentPricing: original.manifest.documentPricing });
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.documentPricing)).toBe(true);
    original.manifest.documentPricing.coreSourceCommit = 'e'.repeat(40);
    expect(projected.documentPricing.coreSourceCommit).toBe('a'.repeat(40));
  });
  it.each([
    ['paid mode', (a: any) => { a.manifest.documentPricing = { vision: {}, transcription: {} }; }],
    ['old manifest revision', (a: any) => { a.manifest.profileVersion = '1.0.0'; }],
    ['wrong profile', (a: any) => { a.manifest.profile = 'other'; }],
    ['wrong contract', (a: any) => { a.manifest.contractVersion = '0.3.0'; }],
    ['missing operation', (a: any) => { a.manifest.allowedOperations = []; }],
    ['wrong operation version', (a: any) => { a.manifest.allowedOperations = [{ ...operation, version: '0.3.0' }]; }],
    ['duplicate operation', (a: any) => { a.manifest.allowedOperations.push(operation); }],
    ['wrong route', (a: any) => { a.manifest.documentPricing.route += '/other'; }],
    ['added pricing key', (a: any) => { a.manifest.documentPricing.chargeMicrousd = 1; }],
    ['missing pricing key', (a: any) => { delete a.manifest.documentPricing.configurationSha256; }],
    ['missing manifest budget', (a: any) => { delete a.manifest.budgets; }],
    ['changed manifest budget', (a: any) => { a.manifest.budgets = { ...a.budgets, maxToolCalls: 1 }; }],
    ['non-Git source pin', (a: any) => { a.manifest.documentPricing.coreSourceCommit = 'a'.repeat(64); }],
    ['non-digest image', (a: any) => { a.manifest.documentPricing.coreImageDigest = 'latest'; }],
    ['malformed config', (a: any) => { a.manifest.documentPricing.configurationSha256 = 'bad'; }],
    ['wrong charge', (a: any) => { a.schedule.operations[0].chargeMicrousd = 2; }],
    ['missing schedule entry', (a: any) => { a.schedule.operations = []; }],
  ])('keeps documents unavailable for %s', (_label, change) => {
    const value = allocation(); change(value); expect(qualify(value)).toBeNull();
  });
  it('refuses mismatched original allocation or manifest hashes', () => {
    const value = allocation();
    expect(readDocumentTextOnlyAllocation(value, 'f'.repeat(64))).toBeNull();
    value.manifestSha256 = 'e'.repeat(64);
    expect(readDocumentTextOnlyAllocation(value, canonicalSha256(value))).toBeNull();
  });
});
