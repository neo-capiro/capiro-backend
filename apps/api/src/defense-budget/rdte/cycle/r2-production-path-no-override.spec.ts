/**
 * Phase 10B-17 Part C -- exact production-path R-2 E2E, no engine override.
 *
 * Drives the REAL `runParserHandoffForSourceDocument` entrypoint with
 * default production configuration (no `maxEscalationRounds` override, no
 * pre-generated raw parser fixture) against the exact official Army
 * FY2024 R-2 Volume 1 BA1 PDF -- the same path `DefaultParserHandoffAdapter`
 * calls in production: real page profiler -> real route planner -> real
 * engine execution (with the Blocker 1 fix in
 * `local-parser-runtime-client.ts` letting a single escalation-tier
 * engine's total failure degrade to per-page failures instead of aborting
 * the whole plan) -> real composition -> real Zod schema -> real R-2
 * segmenter/context-resolver/identity-extractor/funding-extractor/
 * artifact-builder -> real verifier.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runParserHandoffForSourceDocument } from '../../parser-router/source-document-parser-handoff.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';

const SOURCE_SHA = '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6';
const SOURCE_DOCUMENT_ID = '1d20fc43-b6c0-4212-b6fd-aa95cbc3c342';
const CYCLE_ID = 'phase10b17-partc-production-path';
const SOURCE_URL =
  'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf';
const TARGET_PE = '0601102A';
const FIXTURE_PDF_PATH = join(
  __dirname,
  '__fixtures__',
  'production-fy2024-army-r2-vol1-ba1-official.pdf',
);
const PARSER_PROJECT_DIR = resolve(__dirname, '../../../../..', 'defense-budget-parser');

function requireRealPdfFixture(): string {
  if (!existsSync(FIXTURE_PDF_PATH)) {
    throw new Error(`missing real-PDF fixture at ${FIXTURE_PDF_PATH}`);
  }
  const bytes = readFileSync(FIXTURE_PDF_PATH);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== SOURCE_SHA) {
    throw new Error(`real-PDF fixture SHA drifted: expected ${SOURCE_SHA}, got ${sha}`);
  }
  return FIXTURE_PDF_PATH;
}

describe('Phase 10B-17 Part C -- real production router path, no engine override', () => {
  jest.setTimeout(600_000);

  it('processes the full real 170-page R-2 document through runParserHandoffForSourceDocument with default escalation config', async () => {
    const pdfPath = requireRealPdfFixture();
    const workDir = mkdtempSync(join(tmpdir(), 'phase10b17-partc-'));
    const sourcePath = join(workDir, 'source.pdf');
    writeFileSync(sourcePath, readFileSync(pdfPath));

    let thrown: unknown = null;
    let result: Awaited<ReturnType<typeof runParserHandoffForSourceDocument>> | null = null;
    try {
      result = await runParserHandoffForSourceDocument({
        executionId: 'phase10b17-partc-production-path',
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
        fiscalYear: 2024,
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
        // Deliberately NOT overriding maxEscalationRounds -- this is the
        // real production default (4 rounds), proving Blocker 1's fix
        // without a test-only engine override.
      });
    } catch (error) {
      thrown = error;
    }

    // eslint-disable-next-line no-console
    console.log(
      '=== Phase 10B-17 Part C production-path result ===',
      JSON.stringify(
        {
          threw: thrown != null,
          errorMessage: thrown instanceof Error ? thrown.message.slice(0, 4000) : thrown ? String(thrown) : null,
          decision: result?.decision ?? null,
          finalState: result?.finalState ?? null,
          outputPath: result?.outputPath ?? null,
        },
        null,
        2,
      ),
    );

    expect(thrown).toBeNull();
    expect(result).not.toBeNull();

    const artifact = JSON.parse(
      readFileSync(result!.outputPath, 'utf8'),
    ) as DefenseBudgetExtractionArtifactV1;

    expect(artifact.source.sourcePdfSha256).toBe(SOURCE_SHA);

    const identities = artifact.assertions.filter(
      (a) => a.assertionKind === 'program_element_identity',
    );
    const documentFacts = artifact.assertions.filter((a) => a.assertionKind === 'document_fact');

    const targetIdentity = identities.find(
      (a) => (a as { identity?: { peCode?: string } }).identity?.peCode === TARGET_PE,
    ) as { title?: string } | undefined;
    const targetTotalComponent = documentFacts.find(
      (a) =>
        (a as { fieldName?: string }).fieldName === 'r2_total_component' &&
        (a as { value?: { peCode?: string; fiscalYear?: number; rowKind?: string } }).value
          ?.peCode === TARGET_PE &&
        (a as { value?: { peCode?: string; fiscalYear?: number; rowKind?: string } }).value
          ?.fiscalYear === 2024 &&
        (a as { value?: { peCode?: string; fiscalYear?: number; rowKind?: string } }).value
          ?.rowKind === 'pe_total',
    ) as { value?: { valueMillions?: string } } | undefined;

    // Which parser method actually processed which pages, per the real
    // recorded parserRuns -- proves no test-only override was used and
    // reports the real per-page engine assignment the brief asks for.
    const engineByPageRange = artifact.parserRuns.map((run) => ({
      method: run.method,
      pageRanges: run.pageRanges,
    }));

    // eslint-disable-next-line no-console
    console.log(
      'Phase 10B-17 Part C -- real production-path aggregate result:',
      JSON.stringify(
        {
          identityCount: identities.length,
          totalAssertions: artifact.assertions.length,
          documentFactCount: documentFacts.length,
          targetPe: TARGET_PE,
          targetPeTitle: targetIdentity?.title,
          targetPeFy2024TotalMillions: targetTotalComponent?.value?.valueMillions,
          parserRunsByMethod: engineByPageRange,
          omissionCount: artifact.omissions.length,
        },
        null,
        2,
      ),
    );

    expect(identities.length).toBeGreaterThanOrEqual(5);
    expect(targetIdentity).toBeDefined();
    expect(targetIdentity?.title).toBe('Defense Research Sciences');
    expect(targetTotalComponent).toBeDefined();
    expect(Number(targetTotalComponent?.value?.valueMillions)).toBeCloseTo(296.67, 2);
  });
});
