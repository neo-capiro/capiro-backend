import type { DefenseBudgetExtractionArtifactV1 } from '../contracts/extraction-artifact-v1.js';
import { composeProofBoundMilconFamily } from './proof-bound-milcon-composer-v1.js';

const SHA = 'a'.repeat(64);

function artifact(documentKey: string): DefenseBudgetExtractionArtifactV1 {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: `dbx_${documentKey}`,
    contentSha256: SHA,
    source: {
      manifestDocumentKey: documentKey,
      sourcePdfSha256: SHA,
      sourceLocator: `fixture://${documentKey}.pdf`,
      fiscalYear: 2027,
      family: 'milcon',
      exhibit: 'C-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb_fy2027',
      documentType: 'pb_exhibit',
    },
    parserRuns: [],
    evidence: [],
    sourceFacts: [],
    assertions: [
      {
        assertionKind: 'milcon_project',
        assertionId: `as_${documentKey}`,
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        identity: {
          lineKind: 'MILCON_PROJECT',
          projectCode: 'ABC-12345',
          component: 'ARMY',
          location: 'Fort Liberty',
        },
        title: 'Operations Facility',
        location: 'Fort Liberty',
        metadata: { physicalPage: 1, installation: 'Fort Liberty' },
      },
    ],
    warnings: [],
    omissions: [],
    summary: {
      sourceFactCount: 0,
      requiredSourceFactCount: 0,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: 1,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: { milcon_project: 1 },
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
  };
}

describe('composeProofBoundMilconFamily', () => {
  it('keeps the same project/location distinct across accounts', () => {
    const report = composeProofBoundMilconFamily({
      artifacts: {
        c1Artifacts: [artifact('c1-mca'), artifact('c1-afhc')],
        dd1391Artifacts: [],
      },
      accountByDocumentKey: new Map([
        ['c1-mca', 'Military Construction, Army'],
        ['c1-afhc', 'Army Family Housing Construction'],
      ]),
      requiredIdentityKeys: [],
      dd1391Required: false,
      requiredNarrativeSections: [],
    });
    expect(report.identities).toHaveLength(2);
    expect(new Set(report.identities.map((identity) => identity.naturalKey)).size).toBe(2);
    expect(
      report.identities.some((identity) =>
        identity.naturalKey.includes('MILITARY CONSTRUCTION, ARMY'),
      ),
    ).toBe(true);
    expect(
      report.identities.some((identity) =>
        identity.naturalKey.includes('ARMY FAMILY HOUSING CONSTRUCTION'),
      ),
    ).toBe(true);
  });

  it('fails closed when a MILCON document has no manifest account', () => {
    expect(() =>
      composeProofBoundMilconFamily({
        artifacts: { c1Artifacts: [artifact('c1-missing')], dd1391Artifacts: [] },
        accountByDocumentKey: new Map(),
        requiredIdentityKeys: [],
        dd1391Required: false,
        requiredNarrativeSections: [],
      }),
    ).toThrow(/no manifest account/);
  });
});
