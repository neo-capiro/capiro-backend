import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactBuilderV1 } from '../contracts/artifact-builders.js';
import type {
  BudgetCycleManifestDocumentV1,
  BudgetCycleManifestV1,
} from '../contracts/budget-cycle-manifest-v1.js';
import type { BudgetVerificationV1Service } from '../verification/services/budget-verification-v1.service.js';
import { verifyNativeStructuredCompanion } from './native-structured-companion.js';

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'native-companion-'));
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

const sourceSha = 'a'.repeat(64);
const sourceDocumentId = '00000000-0000-0000-0000-000000000001';
const document = {
  documentKey: 'r1-structured',
  family: 'rdte',
  exhibit: 'R-1',
  required: true,
  title: 'Official R-1 companion',
  sourceLocator: '/sources/r1.pdf',
  sourceUrl: 'https://example.test/r1.pdf',
  authority: 'dod-comptroller',
  component: 'ARMY',
  budgetCycle: 'pb',
  documentType: 'r1',
  parserPolicy: 'native_structured',
  requiredDataCategories: ['identity', 'funding'],
  requiredFundingFields: ['request'],
  expectedLineKinds: ['RDTE_PE'],
  allowEmpty: false,
} as BudgetCycleManifestDocumentV1;
const manifest = {
  schemaVersion: 'defense_budget_cycle_manifest_v1',
  cycleId: 'fy2027-pb',
  fiscalYear: 2027,
  domain: 'defense',
  documents: [document],
} as BudgetCycleManifestV1;

function writeCompanion(overrides?: { sourceSha?: string; method?: 'native_structured' | 'manual' }) {
  const builder = new ArtifactBuilderV1({
    manifestDocumentKey: document.documentKey,
    sourceDocumentId,
    sourcePdfSha256: overrides?.sourceSha ?? sourceSha,
    sourceLocator: document.sourceLocator,
    sourceUrl: document.sourceUrl,
    fiscalYear: 2027,
    family: 'rdte',
    exhibit: 'R-1',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'r1',
  });
  builder.addParserRun({
    parserRunId: 'native-run-1',
    method: overrides?.method ?? 'native_structured',
    parserVersion: 'structured-companion-v1',
    parserConfigSha256: 'b'.repeat(64),
    inputSourceSha256: overrides?.sourceSha ?? sourceSha,
    outputArtifactSha256: 'c'.repeat(64),
    pageRanges: [{ startPage: 1, endPage: 1 }],
  });
  const artifact = builder.finalize();
  const locator = join(workDir, 'companion.extraction-v1.json');
  writeFileSync(locator, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return { artifact, locator };
}

function verifier() {
  const verify = jest.fn(async (request) => ({
    verifierVersion: 'defense_budget_verifier_v1',
    policyVersion: 'defense_budget_verification_policy_v1',
    policySha256: 'd'.repeat(64),
    verificationRunId: 'run-1',
    candidateId: 'candidate-1',
    cycleId: manifest.cycleId,
    manifestContentSha256: 'e'.repeat(64),
    manifestDocumentKey: request.manifestDocumentKey,
    extractionArtifactId: 'artifact-1',
    extractionArtifactSha256: request.expectedExtractionArtifactSha256!,
    sourceDocumentId: request.sourceDocumentId,
    sourcePdfSha256: sourceSha,
    decision: 'PASS' as const,
    status: 'VERIFICATION_PASSED' as const,
    route: 'none' as const,
    riskScore: 0,
    checks: [],
    discrepancies: [],
    acceptedAssertionIds: [],
    rejectedAssertionIds: [],
    referenceArtifactIds: [],
    startedAt: '2026-08-04T00:00:00Z',
    completedAt: '2026-08-04T00:00:01Z',
  }));
  return { verify, service: { verify } as unknown as BudgetVerificationV1Service };
}

describe('native structured companion', () => {
  it('validates source/manifest identity and calls the same Phase 2 gate', async () => {
    const companion = writeCompanion();
    const verification = verifier();
    const result = await verifyNativeStructuredCompanion({
      manifest,
      manifestLocator: '/manifests/fy2027.json',
      manifestDocument: document,
      companionLocator: companion.locator,
      sourceDocumentId,
      sourcePdfSha256: sourceSha,
      persistVerificationAudit: false,
      verificationService: verification.service,
    });
    expect(result.artifactId).toBe(companion.artifact.artifactId);
    expect(result.artifactByteSha256).toHaveLength(64);
    expect(verification.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestLocator: '/manifests/fy2027.json',
        extractionArtifactLocator: companion.locator,
        sourceDocumentId,
        mode: 'inspect',
      }),
    );
  });

  it('rejects a companion with the wrong source SHA', async () => {
    const companion = writeCompanion({ sourceSha: 'f'.repeat(64) });
    await expect(
      verifyNativeStructuredCompanion({
        manifest,
        manifestLocator: '/manifest.json',
        manifestDocument: document,
        companionLocator: companion.locator,
        sourceDocumentId,
        sourcePdfSha256: sourceSha,
        persistVerificationAudit: false,
        verificationService: verifier().service,
      }),
    ).rejects.toThrow(/sourcePdfSha256/);
  });

  it('rejects a companion that does not declare native_structured lineage', async () => {
    const companion = writeCompanion({ method: 'manual' });
    await expect(
      verifyNativeStructuredCompanion({
        manifest,
        manifestLocator: '/manifest.json',
        manifestDocument: document,
        companionLocator: companion.locator,
        sourceDocumentId,
        sourcePdfSha256: sourceSha,
        persistVerificationAudit: false,
        verificationService: verifier().service,
      }),
    ).rejects.toThrow(/native_structured parser run/);
  });
});
