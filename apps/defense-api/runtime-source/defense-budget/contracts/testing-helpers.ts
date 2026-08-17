/**
 * Shared test helper: builds a complete minimal artifact via the production builder.
 * Not a spec file — imported by contract specs.
 */
import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  parserRunIdV1,
} from './artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from './extraction-artifact-v1.js';

export const TEST_SOURCE_SHA = 'a'.repeat(64);
export const TEST_CONFIG_SHA = 'b'.repeat(64);
export const TEST_OUTPUT_SHA = 'c'.repeat(64);

export function testSource(): ExtractionSourceV1 {
  return {
    manifestDocumentKey: 'test-doc',
    sourcePdfSha256: TEST_SOURCE_SHA,
    sourceLocator: 'local/test.pdf',
    fiscalYear: 2099,
    family: 'rdte',
    exhibit: 'R-1',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'r1',
  };
}

export function testParserRun(): ParserRunV1 {
  const identity = {
    method: 'deterministic_pdfplumber',
    parserVersion: '0.0.0-test',
    parserConfigSha256: TEST_CONFIG_SHA,
    inputSourceSha256: TEST_SOURCE_SHA,
    outputArtifactSha256: TEST_OUTPUT_SHA,
    pageRanges: [{ startPage: 1, endPage: 10 }],
  };
  return {
    parserRunId: parserRunIdV1(identity),
    method: 'deterministic_pdfplumber',
    parserVersion: '0.0.0-test',
    parserConfigSha256: TEST_CONFIG_SHA,
    inputSourceSha256: TEST_SOURCE_SHA,
    outputArtifactSha256: TEST_OUTPUT_SHA,
    pageRanges: [{ startPage: 1, endPage: 10 }],
  };
}

export function buildMinimalArtifact(): DefenseBudgetExtractionArtifactV1 {
  const run = testParserRun();
  const evidenceId = evidenceIdV1({
    sourcePdfSha256: TEST_SOURCE_SHA,
    parserRunId: run.parserRunId,
    granularity: 'page_only',
    page: 3,
  });
  const factId = factIdV1({
    sourcePath: 'rows[0].peCode',
    category: 'identity',
    rawValue: '0602308A',
  });
  const builder = new ArtifactBuilderV1(testSource());
  builder.addParserRun(run);
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: TEST_SOURCE_SHA,
    parserRunId: run.parserRunId,
    granularity: 'page_only',
    page: 3,
  });
  builder.addSourceFact({
    factId,
    sourcePath: 'rows[0].peCode',
    category: 'identity',
    requiredForCompleteness: true,
    rawValue: '0602308A',
    evidenceIds: [evidenceId],
  });
  builder.addAssertion({
    assertionId: assertionIdV1({ kind: 'program_element_identity', peCode: '0602308A' }),
    assertionKind: 'program_element_identity',
    identity: { lineKind: 'RDTE_PE', peCode: '0602308A' },
    title: 'Test Program Element',
    component: 'ARMY',
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
  });
  return builder.finalize();
}
