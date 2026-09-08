/**
 * Phase 10B-27 — real filesystem-proof-resolver seam regression.
 *
 * The unit spec (`lifecycle-bridge-manifest-cycle-id-v1.spec.ts`) only proves
 * the pure helper + `validateBudgetCycleManifestV1` in isolation. It never
 * drives the real production seam: `runParserHandoffForSourceDocument` writing
 * the synthetic manifest to disk, then `FilesystemParserArtifactProofResolver`
 * wrapping the real `FilesystemProofResolver` reading it back. That gap is
 * exactly how the original defect escaped the (stub-resolver) test that
 * preceded this phase -- see the file header of
 * `r1-text-reconstruction-e2e-acceptance.spec.ts` for that history.
 *
 * This test closes the gap: production-shaped UUID cycleId, fiscalYear 2024,
 * the real handoff, the real (non-stub) resolver chain. No mocks on the
 * proof-resolution boundary.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runParserHandoffForSourceDocument } from './source-document-parser-handoff.js';
import { FilesystemProofResolver } from '../verification/trusted-proof/filesystem-proof-resolver.js';
import { FilesystemParserArtifactProofResolver } from '../verification/trusted-proof/filesystem-parser-artifact-proof-resolver.js';
import { FilesystemParserArtifactStore } from './filesystem-parser-artifact-store.js';
import type { BudgetCycleManifestV1 } from '../contracts/budget-cycle-manifest-v1.js';

const SOURCE_SHA = '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6';
const SOURCE_DOCUMENT_ID = '1d20fc43-b6c0-4212-b6fd-aa95cbc3c342';
// Production-shaped UUID -- exactly the DefenseBudgetCycle.id shape (Prisma
// gen_random_uuid()), not a qualification-harness label.
const CYCLE_ID = 'cff02efd-45e7-4ae4-8f7f-dacd12bdb84c';
const FISCAL_YEAR = 2024;
const SOURCE_URL =
  'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf';
const FIXTURE_PDF_PATH = resolve(
  __dirname,
  '../rdte/cycle/__fixtures__/production-fy2024-army-r2-vol1-ba1-official.pdf',
);
// parser-router/ is one level shallower than rdte/cycle/ -- 4 levels up to
// apps/, not 5.
const PARSER_PROJECT_DIR = resolve(__dirname, '../../../..', 'defense-budget-parser');

function requireRealPdfFixture(): string {
  if (!existsSync(FIXTURE_PDF_PATH)) {
    throw new Error(`missing real-PDF fixture at ${FIXTURE_PDF_PATH}`);
  }
  const bytes = readFileSync(FIXTURE_PDF_PATH);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== SOURCE_SHA) throw new Error(`real-PDF fixture SHA drifted: got ${sha}`);
  return FIXTURE_PDF_PATH;
}

describe('Phase 10B-27 -- real handoff + real FilesystemProofResolver, production-shaped UUID cycleId', () => {
  jest.setTimeout(300_000);

  let workDir: string;
  let manifestPath: string;
  let extractionArtifactPath: string;

  beforeAll(async () => {
    const pdfPath = requireRealPdfFixture();
    workDir = mkdtempSync(join(tmpdir(), 'phase10b27-real-seam-'));
    const sourcePath = join(workDir, 'source.pdf');
    writeFileSync(sourcePath, readFileSync(pdfPath));

    // Real production entrypoint, persistVerificationAudit: false only to
    // avoid needing a live DB/S3 -- the internal FilesystemProofResolver
    // wiring is identical to the persist:true production path (see
    // createVerificationContext in source-document-parser-handoff.ts).
    await runParserHandoffForSourceDocument({
      executionId: 'phase10b27-real-seam',
      cycleId: CYCLE_ID,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      sourcePath,
      sourceSha256: SOURCE_SHA,
      sourceLocator: SOURCE_URL,
      sourceUrl: SOURCE_URL,
      sourceKey: SOURCE_DOCUMENT_ID,
      parserPolicy: 'deterministic_table',
      exhibitType: 'R-2',
      budgetFamily: 'rdte',
      fiscalYear: FISCAL_YEAR,
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r2',
      title: 'r2',
      workDir,
      persistVerificationAudit: false,
      allowPaidParse: false,
      maxPaidPages: 0,
      parserProjectDir: PARSER_PROJECT_DIR,
    });

    manifestPath = join(workDir, SOURCE_DOCUMENT_ID, 'lifecycle-bridge-manifest.json');
    extractionArtifactPath = join(
      workDir,
      SOURCE_DOCUMENT_ID,
      `${SOURCE_DOCUMENT_ID}.extraction-v1.json`,
    );
  });

  it('writes a synthetic manifest with cycleId translated to fy2024:<uuid>, raw UUID preserved as a substring', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BudgetCycleManifestV1;
    expect(manifest.cycleId).toBe(`fy${FISCAL_YEAR}:${CYCLE_ID}`);
    expect(manifest.cycleId.includes(CYCLE_ID)).toBe(true);
    expect(manifest.fiscalYear).toBe(FISCAL_YEAR);
  });

  it('resolves through the REAL (non-stub) FilesystemProofResolver with zero blocking findings and no manifest_sha_mismatch', async () => {
    const store = new FilesystemParserArtifactStore(join(workDir, 'parser-artifacts'));
    const resolver = new FilesystemParserArtifactProofResolver(
      new FilesystemProofResolver({ sourcePdfPath: join(workDir, 'source.pdf') }),
      store,
    );
    const resolution = await resolver.resolve({
      manifestLocator: manifestPath,
      manifestDocumentKey: SOURCE_DOCUMENT_ID,
      extractionArtifactLocator: extractionArtifactPath,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      referenceArtifacts: [],
    });

    expect(resolution.proofFindings).toEqual([]);
    expect(resolution.proofFindings.some((f) => f.code === 'manifest_sha_mismatch')).toBe(false);

    // Parser-run proof identities remain verified -- this fix never touches
    // parser-run identity/content-hash machinery.
    expect(resolution.proofBundle.parserRuns.length).toBeGreaterThan(0);
    for (const run of resolution.proofBundle.parserRuns) {
      expect(run.proofStatus).toBe('verified');
    }
  });

  it('still fails closed: a manifest whose declared fiscalYear no longer matches its own cycleId tag is rejected by the real resolver', async () => {
    // Simulate external tampering / a wrong-year manifest: same real
    // artifact and parser-run proof, but the manifest's fiscalYear field is
    // mutated to 2023 while cycleId still says fy2024:<uuid> -- the exact
    // "wrong-year manifest" shape the validator must still reject.
    const realManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BudgetCycleManifestV1;
    const tamperedManifest: BudgetCycleManifestV1 = { ...realManifest, fiscalYear: 2023 };
    const tamperedManifestPath = join(workDir, 'tampered-wrong-year-manifest.json');
    writeFileSync(tamperedManifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`, 'utf8');

    const store = new FilesystemParserArtifactStore(join(workDir, 'parser-artifacts'));
    const resolver = new FilesystemParserArtifactProofResolver(
      new FilesystemProofResolver({ sourcePdfPath: join(workDir, 'source.pdf') }),
      store,
    );
    const resolution = await resolver.resolve({
      manifestLocator: tamperedManifestPath,
      manifestDocumentKey: SOURCE_DOCUMENT_ID,
      extractionArtifactLocator: extractionArtifactPath,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      referenceArtifacts: [],
    });

    expect(
      resolution.proofFindings.some(
        (f) => f.code === 'manifest_sha_mismatch' && f.severity === 'blocking',
      ),
    ).toBe(true);
  });
});
