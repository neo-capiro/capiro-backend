/**
 * Phase 10B-10 Part A — local reproduction of the production REJECT for the
 * FY2024 pb_r1/DW/dod-comptroller canary (outbox row
 * 1c6b97bf-e978-4d14-b015-97b88d6b8de3, verification run
 * fb2e23bf-9bfa-5f91-94c2-6f53b43c7006) BEFORE any wiring fix.
 *
 * The fixture below is the EXACT durable production extraction artifact --
 * pulled byte-for-byte from
 * s3://capiro-dev-defense-budget-extraction-artifacts-967807252336/phase10/parser-artifacts/af0833050dd7f3f5a87608aabb5a504bacd784d03500d2801c722e48f94ce8f7?versionId=yC2a7TFb9DSy2_I4GH9OPbOcqReluxNi,
 * SHA-256 verified against its own artifactId/contentSha256
 * (af0833050dd7f3f5a87608aabb5a504bacd784d03500d2801c722e48f94ce8f7) before
 * being committed here -- not hand-built. This test runs the REAL rule set
 * and REAL decision engine (BudgetVerificationV1Service.verify) against it,
 * bypassing only I/O-level proof resolution (which just locates/hashes bytes
 * this test already has verified), to prove the documented production
 * decision is exactly reproducible outside of AWS.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BudgetVerificationV1Service } from '../../verification/services/budget-verification-v1.service.js';
import type {
  BudgetVerificationRepositoryV1,
} from '../../verification/persistence/verification-repository.js';
import type {
  TrustedProofResolutionV1,
  TrustedVerificationProofResolverV1,
} from '../../verification/trusted-proof/trusted-proof-types.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';

const FIXTURE_PATH = join(__dirname, '__fixtures__', 'production-fy2024-r1-lineage-only-artifact.json');

const SOURCE_DOCUMENT_ID = '62e8a102-4f01-471b-9cb6-eab58cb41270';
const SOURCE_PDF_SHA256 = 'ed9f94b6068c8f1ce40483adfe69d644cc3f033bbcc8271537db39ca91101425';
const MANIFEST_DOCUMENT_KEY = SOURCE_DOCUMENT_ID;
const CYCLE_ID = 'cff02efd-45e7-4ae4-8f7f-dacd12bdb84c';

function loadProductionArtifact(): DefenseBudgetExtractionArtifactV1 {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  const bytes = Buffer.from(raw, 'utf8');
  const byteSha256 = createHash('sha256').update(bytes).digest('hex');
  // This is the same "verify SHA before use" step run against the live S3
  // object when this fixture was captured -- re-asserted here so the fixture
  // can never silently drift from what production actually persisted.
  if (byteSha256 !== 'af0833050dd7f3f5a87608aabb5a504bacd784d03500d2801c722e48f94ce8f7') {
    throw new Error(`fixture byte SHA-256 drifted: got ${byteSha256}`);
  }
  const artifact = JSON.parse(raw) as DefenseBudgetExtractionArtifactV1;
  if (artifact.contentSha256 !== '30bf7a84ddd0d05295bd38a12777fef8abe25abe7d5c73d2e43edfe41d7665d4') {
    throw new Error(`fixture contentSha256 drifted: got ${artifact.contentSha256}`);
  }
  return artifact;
}

class ProductionCanaryResolver implements TrustedVerificationProofResolverV1 {
  constructor(private readonly artifact: DefenseBudgetExtractionArtifactV1) {}

  async resolve(): Promise<TrustedProofResolutionV1> {
    const manifestDocument = {
      documentKey: MANIFEST_DOCUMENT_KEY,
      required: true,
      title: 'r1',
      sourceLocator: 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
      sourceUrl: 'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
      expectedSourceSha256: SOURCE_PDF_SHA256,
      family: 'rdte',
      exhibit: 'R-1',
      authority: 'dod-comptroller',
      component: 'UNKNOWN',
      budgetCycle: 'pb',
      documentType: 'r1',
      parserPolicy: 'deterministic_table',
      requiredDataCategories: ['identity', 'funding'],
      requiredFundingFields: ['request'],
      expectedLineKinds: ['RDTE_PE'],
      allowEmpty: false,
    };
    return {
      manifest: {
        schemaVersion: 'defense_budget_cycle_manifest_v1',
        cycleId: CYCLE_ID,
        fiscalYear: 2024,
        domain: 'defense',
        documents: [manifestDocument],
      } as never,
      manifestDocument: manifestDocument as never,
      manifestContentSha256: '83193a9d208cdb98e3f06b6b2cfa1ac2fc529e33ff6493c8dbf994470747dd95',
      artifact: this.artifact,
      extractionArtifactByteSha256: 'af0833050dd7f3f5a87608aabb5a504bacd784d03500d2801c722e48f94ce8f7',
      extractionArtifactContentSha256: this.artifact.contentSha256,
      proofBundle: {
        manifest: {
          locator: 'synthetic://manifest',
          contentSha256: '83193a9d208cdb98e3f06b6b2cfa1ac2fc529e33ff6493c8dbf994470747dd95',
          cycleId: CYCLE_ID,
          fiscalYear: 2024,
          documentKey: MANIFEST_DOCUMENT_KEY,
        },
        extractionArtifact: {
          artifactId: this.artifact.artifactId,
          locator:
            's3://capiro-dev-defense-budget-extraction-artifacts-967807252336/phase10/parser-artifacts/af0833050dd7f3f5a87608aabb5a504bacd784d03500d2801c722e48f94ce8f7?versionId=yC2a7TFb9DSy2_I4GH9OPbOcqReluxNi',
          contentSha256: this.artifact.contentSha256,
          byteSha256: 'af0833050dd7f3f5a87608aabb5a504bacd784d03500d2801c722e48f94ce8f7',
        },
        sourceDocument: {
          id: SOURCE_DOCUMENT_ID,
          sourceKey: SOURCE_DOCUMENT_ID,
          sourceSha256: SOURCE_PDF_SHA256,
        },
        archive: { status: 'not_applicable' },
        parserRuns: [],
        resolvedReferenceArtifacts: [],
      } as never,
      proofFindings: [],
      referenceArtifacts: [],
      referenceArtifactsProofBundles: [],
      referenceArtifactsFindings: [],
    };
  }
}

describe('Phase 10B-10 Part A -- production REJECT reproduces locally (BEFORE the wiring fix)', () => {
  it('reproduces decision=REJECT with completeness+r1_specific FAIL on the exact production artifact', async () => {
    const artifact = loadProductionArtifact();
    expect(artifact.assertions.length).toBe(0);
    expect(artifact.evidence.length).toBe(114);
    expect(artifact.parserRuns.length).toBe(1);
    expect(artifact.warnings.map((w) => w.code)).toContain('router_family_assertion_mapping_deferred');

    const service = new BudgetVerificationV1Service(
      new ProductionCanaryResolver(artifact),
      null as unknown as BudgetVerificationRepositoryV1,
    );
    const result = await service.verify({
      manifestLocator: 'synthetic://manifest',
      manifestDocumentKey: MANIFEST_DOCUMENT_KEY,
      extractionArtifactLocator:
        's3://capiro-dev-defense-budget-extraction-artifacts-967807252336/phase10/parser-artifacts/af0833050dd7f3f5a87608aabb5a504bacd784d03500d2801c722e48f94ce8f7?versionId=yC2a7TFb9DSy2_I4GH9OPbOcqReluxNi',
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      mode: 'inspect',
      expectedSourcePdfSha256: SOURCE_PDF_SHA256,
      expectedExtractionArtifactSha256: artifact.contentSha256,
    });

    expect(result.decision).toBe('REJECT');
    const byCode = new Map(result.checks.map((c) => [c.code, c]));
    expect(byCode.get('completeness')?.outcome).toBe('FAIL');
    expect(byCode.get('r1_specific')?.outcome).toBe('FAIL');
    expect(byCode.get('completeness')?.required).toBe(true);
    expect(byCode.get('completeness')?.blocking).toBe(true);
    expect(byCode.get('r1_specific')?.required).toBe(true);
    expect(byCode.get('r1_specific')?.blocking).toBe(true);
    const discrepancyCodes = result.discrepancies.map((d) => d.code);
    expect(discrepancyCodes).toEqual(
      expect.arrayContaining(['empty_document_violation', 'r1_zero_pe_identities']),
    );
  });
});
