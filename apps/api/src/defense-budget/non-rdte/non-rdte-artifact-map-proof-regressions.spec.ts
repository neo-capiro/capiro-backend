import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  loadArtifactParserResultProofs,
  sha256Bytes,
  type ArtifactMapEntry,
} from '../../../scripts/lib/non-rdte-phase5-operator-lib.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ParserRunV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  computeParserRunId,
  sealParserRuntimeResult,
  type ParserRuntimeResultV1,
} from '../parser-router/parser-runtime-contract-v1.js';

const SOURCE_SHA = 'a'.repeat(64);

function result(page: number, configCharacter: string): ParserRuntimeResultV1 {
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: `proof-map-${page}`,
    engine: 'deterministic_pdfplumber',
    parserVersion: 'test',
    parserConfigSha256: configCharacter.repeat(64),
    inputSourceSha256: SOURCE_SHA,
    requestedPages: [page],
    succeededPages: [page],
    failedPages: [],
    pages: [
      {
        page,
        text: `page ${page}`,
        blocks: [],
        tables: [],
        images: [],
        evidencePrecision: 'page_only',
        warnings: [],
      },
    ],
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: 1,
      pagesSucceeded: 1,
      pagesFailed: 0,
      engineVersion: 'test',
    },
  });
}

function run(value: ParserRuntimeResultV1): ParserRunV1 {
  const parserRunId = computeParserRunId({
    sourceSha256: value.inputSourceSha256,
    method: value.engine,
    parserVersion: value.parserVersion,
    parserConfigSha256: value.parserConfigSha256,
    pages: value.succeededPages,
    runtimeContractVersion: value.schemaVersion,
  });
  return {
    parserRunId,
    method: value.engine,
    parserVersion: value.parserVersion,
    parserConfigSha256: value.parserConfigSha256,
    inputSourceSha256: value.inputSourceSha256,
    outputArtifactSha256: value.contentSha256,
    pageRanges: value.succeededPages.map((page) => ({ startPage: page, endPage: page })),
  };
}

function artifact(runs: ParserRunV1[]): DefenseBudgetExtractionArtifactV1 {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: 'dbx1_proof_map_test',
    contentSha256: 'f'.repeat(64),
    source: {
      manifestDocumentKey: 'proof-map-test',
      sourcePdfSha256: SOURCE_SHA,
      sourceLocator: 'fixture://proof-map.pdf',
      fiscalYear: 2027,
      family: 'procurement',
      exhibit: 'P-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb_fy2027',
      documentType: 'pb_exhibit',
    },
    parserRuns: runs,
    evidence: [],
    sourceFacts: [],
    assertions: [],
    warnings: [],
    omissions: [],
    summary: {
      sourceFactCount: 0,
      requiredSourceFactCount: 0,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: 0,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
  };
}

function writeResult(
  directory: string,
  value: ParserRuntimeResultV1,
): {
  filePath: string;
  byteSha256: string;
} {
  const filePath = path.join(directory, `${value.jobId}.json`);
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  fs.writeFileSync(filePath, bytes);
  return { filePath, byteSha256: sha256Bytes(bytes) };
}

describe('Phase 5 artifact-map parser proof loading', () => {
  it('loads exactly one independently hashed result per contributing parser run', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capiro-phase5-proof-map-'));
    const first = result(1, 'b');
    const second = result(2, 'c');
    const firstRun = run(first);
    const secondRun = run(second);
    const firstFile = writeResult(directory, first);
    const secondFile = writeResult(directory, second);
    const entry: ArtifactMapEntry = {
      artifactPath: path.join(directory, 'artifact.json'),
      parserResultProofs: [
        {
          parserRunId: firstRun.parserRunId,
          parserResultPath: firstFile.filePath,
          parserResultByteSha256: firstFile.byteSha256,
        },
        {
          parserRunId: secondRun.parserRunId,
          parserResultPath: secondFile.filePath,
          parserResultByteSha256: secondFile.byteSha256,
        },
      ],
    };

    const proofs = loadArtifactParserResultProofs({
      entry,
      artifact: artifact([firstRun, secondRun]),
    });
    expect(proofs.map((proof) => proof.parserRunId)).toEqual(
      [firstRun.parserRunId, secondRun.parserRunId].sort(),
    );
    expect(proofs.every((proof) => proof.resultByteSha256 != null)).toBe(true);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('rejects one legacy parserResultPath as proof for a multi-run artifact', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capiro-phase5-proof-map-'));
    const first = result(1, 'b');
    const second = result(2, 'c');
    const firstRun = run(first);
    const secondRun = run(second);
    const firstFile = writeResult(directory, first);

    expect(() =>
      loadArtifactParserResultProofs({
        entry: {
          artifactPath: path.join(directory, 'artifact.json'),
          parserResultPath: firstFile.filePath,
          parserResultByteSha256: firstFile.byteSha256,
        },
        artifact: artifact([firstRun, secondRun]),
      }),
    ).toThrow(/has 2 parser runs; parserResultProofs is required/);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('rejects missing and extra proof descriptors before reading files', () => {
    const first = result(1, 'b');
    const second = result(2, 'c');
    const firstRun = run(first);
    const secondRun = run(second);
    const multiRunArtifact = artifact([firstRun, secondRun]);

    expect(() =>
      loadArtifactParserResultProofs({
        entry: {
          artifactPath: 'artifact.json',
          parserResultProofs: [
            { parserRunId: firstRun.parserRunId, parserResultPath: 'first.json' },
          ],
        },
        artifact: multiRunArtifact,
      }),
    ).toThrow(/missing=.*extra=none/);

    expect(() =>
      loadArtifactParserResultProofs({
        entry: {
          artifactPath: 'artifact.json',
          parserResultProofs: [
            { parserRunId: firstRun.parserRunId, parserResultPath: 'first.json' },
            { parserRunId: secondRun.parserRunId, parserResultPath: 'second.json' },
            { parserRunId: 'pr1_extra', parserResultPath: 'extra.json' },
          ],
        },
        artifact: multiRunArtifact,
      }),
    ).toThrow(/missing=none; extra=pr1_extra/);
  });

  it('rejects a persisted parser-result byte SHA mismatch', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capiro-phase5-proof-map-'));
    const first = result(1, 'b');
    const firstRun = run(first);
    const firstFile = writeResult(directory, first);

    expect(() =>
      loadArtifactParserResultProofs({
        entry: {
          artifactPath: path.join(directory, 'artifact.json'),
          parserResultProofs: [
            {
              parserRunId: firstRun.parserRunId,
              parserResultPath: firstFile.filePath,
              parserResultByteSha256: '0'.repeat(64),
            },
          ],
        },
        artifact: artifact([firstRun]),
      }),
    ).toThrow(/byte SHA mismatch/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
