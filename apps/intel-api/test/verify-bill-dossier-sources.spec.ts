import {
  isKnownVerb,
  verifyBillDossierSources,
  type DossierSourceDeps,
} from '../src/tasks/task-runner.js';
import {
  HR_8800_ID,
  hr8800Actions,
  hr8800Freshness,
  hr8800GoverningRules,
  hr8800Identity,
} from './fixtures/hr-8800-rule-failed.fixture.js';

/**
 * Bill 360 source-availability gate (§0.5). Exercises the exported handler with
 * injected fakes (no DB): SOURCE_OK marker on success, throw + failure marker on
 * a missing invariant, and registry wiring.
 */
function makeDeps(overrides: Partial<DossierSourceDeps['repo']> = {}): {
  deps: DossierSourceDeps;
  logs: string[];
} {
  const logs: string[] = [];
  const repo: DossierSourceDeps['repo'] = {
    getBillDossierIdentity: async () => hr8800Identity,
    getBillActions: async () => hr8800Actions,
    getBillVotes: async () => [],
    getGoverningRules: async () => hr8800GoverningRules,
    getBillSourceFreshness: async () => hr8800Freshness,
    ...overrides,
  };
  return { deps: { repo, log: (m) => logs.push(m) }, logs };
}

describe('verify-bill-dossier-sources', () => {
  it('is a registered verb', () => {
    expect(isKnownVerb('verify-bill-dossier-sources')).toBe(true);
  });

  it('emits SOURCE_OK for a bill with all required sources present', async () => {
    const { deps, logs } = makeDeps();
    await verifyBillDossierSources([HR_8800_ID], deps);
    expect(logs.some((l) => l.startsWith(`SOURCE_OK billId=${HR_8800_ID}`))).toBe(true);
    expect(logs.some((l) => l.includes('"sourcesUnavailable":0'))).toBe(true);
  });

  it('throws (non-zero exit) when the bill row is absent', async () => {
    const { deps, logs } = makeDeps({ getBillDossierIdentity: async () => null });
    await expect(verifyBillDossierSources([HR_8800_ID], deps)).rejects.toThrow(
      /DOSSIER_SOURCES_FAILED/,
    );
    expect(logs.some((l) => l.includes('reason=bill_row_absent'))).toBe(true);
  });

  it('throws when the canonical status is missing', async () => {
    const { deps } = makeDeps({
      getBillDossierIdentity: async () => ({ ...hr8800Identity, status: null }),
    });
    await expect(verifyBillDossierSources([HR_8800_ID], deps)).rejects.toThrow(
      /DOSSIER_SOURCES_FAILED/,
    );
  });

  it('throws when there are no actions', async () => {
    const { deps } = makeDeps({ getBillActions: async () => [] });
    await expect(verifyBillDossierSources([HR_8800_ID], deps)).rejects.toThrow(
      /DOSSIER_SOURCES_FAILED/,
    );
  });

  it('requires at least one billId', async () => {
    const { deps } = makeDeps();
    await expect(verifyBillDossierSources([], deps)).rejects.toThrow(/requires at least one/);
  });
});
