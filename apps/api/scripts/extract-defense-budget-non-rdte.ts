#!/usr/bin/env tsx
/**
 * Build proof-bound Phase 5 artifacts from already-produced Phase 3 parser
 * results or a Phase 3 composed-output ledger. This command never invokes a
 * provider and exposes no paid-parser authorization flag. Parsing/routing
 * remains a separate Phase 3 action.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PHASE5_EXIT,
  extractionSourceFromManifestDocument,
  loadPhase5Manifest,
  parseFamily,
  readJsonFile,
  refuseUnknownFlags,
  requireValue,
  selectPhase5Documents,
  sha256Bytes,
  valueAfter,
  writeJsonFile,
  type ArtifactMap,
  type ArtifactParserResultProofEntry,
} from './lib/non-rdte-phase5-operator-lib.js';
import { buildProofBoundNonRdteArtifact } from '../src/defense-budget/non-rdte/non-rdte-semantic-artifact-factory-v1.js';
import { buildProofBoundNonRdteArtifactFromComposedOutput } from '../src/defense-budget/non-rdte/non-rdte-phase3-composed-artifact-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import type { Phase5ParserResultProofV1 } from '../src/defense-budget/non-rdte/non-rdte-proof-bound-artifact-v1.js';
import { inspectPhase5DocumentCompleteness } from '../src/defense-budget/non-rdte/non-rdte-document-completeness-v1.js';

const SHA256_RE = /^[a-f0-9]{64}$/;

interface SingleParserMapEntry {
  mode: 'single';
  parserResultPath: string;
  parserResultByteSha256?: string;
  sourceDocumentId?: string;
}

interface ComposedParserMapEntry {
  mode: 'composed';
  composedOutputPath: string;
  composedOutputByteSha256?: string;
  parserResultProofs: ArtifactParserResultProofEntry[];
  sourceDocumentId?: string;
}

type ParserMapEntry = SingleParserMapEntry | ComposedParserMapEntry;
type ParserMap = Record<string, ParserMapEntry>;

function nonblank(value: unknown, label: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a nonblank string`);
  }
  return value;
}

function sha(value: unknown, label: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lowercase 64-character SHA-256`);
  }
  return value;
}

function parseProofDescriptors(
  value: unknown,
  documentKey: string,
): ArtifactParserResultProofEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`parser map entry ${documentKey}.parserResultProofs must be a nonempty array`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(
        `parser map entry ${documentKey}.parserResultProofs[${index}] must be an object`,
      );
    }
    const record = raw as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter(
      (key) => !['parserRunId', 'parserResultPath', 'parserResultByteSha256'].includes(key),
    );
    if (unknownKeys.length > 0) {
      throw new Error(
        `parser map entry ${documentKey}.parserResultProofs[${index}] has unknown keys: ${unknownKeys.join(', ')}`,
      );
    }
    const parserRunId = nonblank(
      record.parserRunId,
      `parser map entry ${documentKey}.parserResultProofs[${index}].parserRunId`,
    );
    const parserResultPath = nonblank(
      record.parserResultPath,
      `parser map entry ${documentKey}.parserResultProofs[${index}].parserResultPath`,
    );
    if (parserRunId == null || parserResultPath == null) {
      throw new Error(
        `parser map entry ${documentKey}.parserResultProofs[${index}] requires parserRunId and parserResultPath`,
      );
    }
    if (seen.has(parserRunId)) {
      throw new Error(`parser map entry ${documentKey} duplicates parser run ${parserRunId}`);
    }
    seen.add(parserRunId);
    const expectedByteSha = sha(
      record.parserResultByteSha256,
      `parser map entry ${documentKey}.parserResultProofs[${index}].parserResultByteSha256`,
    );
    return {
      parserRunId,
      parserResultPath,
      ...(expectedByteSha != null ? { parserResultByteSha256: expectedByteSha } : {}),
    };
  });
}

function loadParserMap(filePath: string): ParserMap {
  const input = readJsonFile(filePath);
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('parser map must be a JSON object keyed by manifest document key');
  }
  const output: ParserMap = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`parser map entry ${key} must be an object`);
    }
    const record = raw as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter(
      (field) =>
        ![
          'parserResultPath',
          'parserResultByteSha256',
          'composedOutputPath',
          'composedOutputByteSha256',
          'parserResultProofs',
          'sourceDocumentId',
        ].includes(field),
    );
    if (unknownKeys.length > 0) {
      throw new Error(`parser map entry ${key} has unknown keys: ${unknownKeys.join(', ')}`);
    }
    const parserResultPath = nonblank(
      record.parserResultPath,
      `parser map entry ${key}.parserResultPath`,
    );
    const composedOutputPath = nonblank(
      record.composedOutputPath,
      `parser map entry ${key}.composedOutputPath`,
    );
    if ((parserResultPath == null) === (composedOutputPath == null)) {
      throw new Error(
        `parser map entry ${key} must supply exactly one of parserResultPath or composedOutputPath`,
      );
    }
    const sourceDocumentId = nonblank(
      record.sourceDocumentId,
      `parser map entry ${key}.sourceDocumentId`,
    );
    if (parserResultPath != null) {
      if (record.parserResultProofs != null || record.composedOutputByteSha256 != null) {
        throw new Error(
          `single-result parser map entry ${key} must not supply composed-output proof fields`,
        );
      }
      const expectedByteSha = sha(
        record.parserResultByteSha256,
        `parser map entry ${key}.parserResultByteSha256`,
      );
      output[key] = {
        mode: 'single',
        parserResultPath,
        ...(expectedByteSha != null ? { parserResultByteSha256: expectedByteSha } : {}),
        ...(sourceDocumentId != null ? { sourceDocumentId } : {}),
      };
      continue;
    }
    if (record.parserResultByteSha256 != null) {
      throw new Error(
        `composed parser map entry ${key} must not use the single-result byte-SHA field`,
      );
    }
    const expectedComposedSha = sha(
      record.composedOutputByteSha256,
      `parser map entry ${key}.composedOutputByteSha256`,
    );
    output[key] = {
      mode: 'composed',
      composedOutputPath: composedOutputPath!,
      ...(expectedComposedSha != null ? { composedOutputByteSha256: expectedComposedSha } : {}),
      parserResultProofs: parseProofDescriptors(record.parserResultProofs, key),
      ...(sourceDocumentId != null ? { sourceDocumentId } : {}),
    };
  }
  return output;
}

function readJsonBytes(input: { filePath: string; expectedByteSha256?: string; label: string }): {
  bytes: Buffer;
  value: unknown;
  byteSha256: string;
} {
  const bytes = fs.readFileSync(input.filePath);
  const byteSha256 = sha256Bytes(bytes);
  if (input.expectedByteSha256 != null && input.expectedByteSha256 !== byteSha256) {
    throw new Error(
      `${input.label} byte SHA mismatch: expected ${input.expectedByteSha256}, got ${byteSha256}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `invalid ${input.label} JSON ${input.filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { bytes, value, byteSha256 };
}

function loadProofs(
  descriptors: readonly ArtifactParserResultProofEntry[],
): Array<Phase5ParserResultProofV1 & { parserResultPath: string }> {
  return descriptors.map((descriptor) => {
    const loaded = readJsonBytes({
      filePath: descriptor.parserResultPath,
      expectedByteSha256: descriptor.parserResultByteSha256,
      label: `parser result ${descriptor.parserRunId}`,
    });
    return {
      parserRunId: descriptor.parserRunId,
      result: loaded.value,
      resultByteSha256: loaded.byteSha256,
      resultLocator: path.resolve(descriptor.parserResultPath),
      parserResultPath: path.resolve(descriptor.parserResultPath),
    };
  });
}

function main(): void {
  const argv = process.argv.slice(2);
  refuseUnknownFlags(argv, ['--manifest', '--parser-map', '--out-dir', '--family']);
  const manifestPath = requireValue(argv, '--manifest');
  const parserMapPath = requireValue(argv, '--parser-map');
  const outDir = requireValue(argv, '--out-dir');
  const family = parseFamily(valueAfter(argv, '--family'));
  const loaded = loadPhase5Manifest(manifestPath);
  const parserMap = loadParserMap(parserMapPath);
  const documents = selectPhase5Documents(loaded.manifest, family);
  if (documents.length === 0) throw new Error('manifest selection contains no Phase 5 documents');

  fs.mkdirSync(outDir, { recursive: true });
  const artifactMap: ArtifactMap = {};
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  const blockingDocumentFindings: Array<{
    documentKey: string;
    code: string;
    message: string;
  }> = [];
  const results: Array<Record<string, unknown>> = [];

  for (const document of documents) {
    const parserEntry = parserMap[document.documentKey];
    if (parserEntry == null) {
      (document.required ? missingRequired : missingOptional).push(document.documentKey);
      continue;
    }
    const source = extractionSourceFromManifestDocument({
      document,
      fiscalYear: loaded.manifest.fiscalYear,
      ...(parserEntry.sourceDocumentId != null
        ? { sourceDocumentId: parserEntry.sourceDocumentId }
        : {}),
    });

    /* Both branches below assign a DefenseBudgetExtractionArtifactV1. Without the
     * annotation, noImplicitAny cannot infer the type at the declaration. */
    let artifact: DefenseBudgetExtractionArtifactV1;
    let normalizedProofDescriptors: ArtifactParserResultProofEntry[];
    let composedOutputPath: string | undefined;
    let composedOutputByteSha256: string | undefined;
    let legacyParserResultPath: string | undefined;
    let legacyParserResultByteSha256: string | undefined;

    if (parserEntry.mode === 'single') {
      const loadedResult = readJsonBytes({
        filePath: parserEntry.parserResultPath,
        expectedByteSha256: parserEntry.parserResultByteSha256,
        label: `parser result for ${document.documentKey}`,
      });
      artifact = buildProofBoundNonRdteArtifact({
        document,
        source,
        parserResult: loadedResult.value,
        parserResultByteSha256: loadedResult.byteSha256,
      });
      if (artifact.parserRuns.length !== 1) {
        throw new Error(
          `single-result extraction produced ${artifact.parserRuns.length} parser runs for ${document.documentKey}`,
        );
      }
      legacyParserResultPath = path.resolve(parserEntry.parserResultPath);
      legacyParserResultByteSha256 = loadedResult.byteSha256;
      normalizedProofDescriptors = [
        {
          parserRunId: artifact.parserRuns[0]!.parserRunId,
          parserResultPath: legacyParserResultPath,
          parserResultByteSha256: loadedResult.byteSha256,
        },
      ];
    } else {
      const loadedComposed = readJsonBytes({
        filePath: parserEntry.composedOutputPath,
        expectedByteSha256: parserEntry.composedOutputByteSha256,
        label: `composed output for ${document.documentKey}`,
      });
      const loadedProofs = loadProofs(parserEntry.parserResultProofs);
      artifact = buildProofBoundNonRdteArtifactFromComposedOutput({
        document,
        source,
        composedOutput: loadedComposed.value,
        parserResultProofs: loadedProofs,
      });
      const proofByRunId = new Map(
        loadedProofs.map((proof) => [proof.parserRunId, proof] as const),
      );
      normalizedProofDescriptors = artifact.parserRuns.map((run) => {
        const proof = proofByRunId.get(run.parserRunId);
        if (proof == null) {
          throw new Error(
            `composed artifact ${artifact.artifactId} is missing parser proof ${run.parserRunId}`,
          );
        }
        return {
          parserRunId: run.parserRunId,
          parserResultPath: proof.parserResultPath,
          parserResultByteSha256: proof.resultByteSha256!,
        };
      });
      composedOutputPath = path.resolve(parserEntry.composedOutputPath);
      composedOutputByteSha256 = loadedComposed.byteSha256;
    }

    const completenessFindings = inspectPhase5DocumentCompleteness({ document, artifact });
    for (const finding of completenessFindings) {
      if (finding.blocking) {
        blockingDocumentFindings.push({
          documentKey: document.documentKey,
          code: finding.code,
          message: finding.message,
        });
      }
    }
    const artifactPath = path.resolve(outDir, `${document.documentKey}.extraction-v1.json`);
    writeJsonFile(artifactPath, artifact);
    artifactMap[document.documentKey] = {
      artifactPath,
      parserResultProofs: normalizedProofDescriptors,
      ...(legacyParserResultPath != null ? { parserResultPath: legacyParserResultPath } : {}),
      ...(legacyParserResultByteSha256 != null
        ? { parserResultByteSha256: legacyParserResultByteSha256 }
        : {}),
      ...(composedOutputPath != null ? { composedOutputPath } : {}),
      ...(composedOutputByteSha256 != null ? { composedOutputByteSha256 } : {}),
      ...(parserEntry.sourceDocumentId != null
        ? { sourceDocumentId: parserEntry.sourceDocumentId }
        : {}),
    };
    results.push({
      documentKey: document.documentKey,
      exhibit: document.exhibit,
      inputMode: parserEntry.mode,
      artifactId: artifact.artifactId,
      artifactContentSha256: artifact.contentSha256,
      parserRunCount: artifact.parserRuns.length,
      parserResultProofCount: normalizedProofDescriptors.length,
      ...(composedOutputByteSha256 != null ? { composedOutputByteSha256 } : {}),
      assertionCount: artifact.summary.assertionCount,
      omissionCount: artifact.summary.omissionCount,
      warningCount: artifact.summary.warningCount,
      completenessStatus: artifact.summary.completenessStatus,
      completenessFindings,
      artifactPath,
    });
  }

  const artifactMapPath = path.resolve(outDir, 'artifact-map.json');
  writeJsonFile(artifactMapPath, artifactMap);
  const output = {
    command: 'extract-defense-budget-non-rdte',
    mode: 'semantic_from_phase3_results_or_composition',
    manifestContentSha256: loaded.contentSha256,
    cycleId: loaded.manifest.cycleId,
    fiscalYear: loaded.manifest.fiscalYear,
    family: family ?? 'all',
    artifactMapPath,
    artifacts: results.sort((a, b) => String(a.documentKey).localeCompare(String(b.documentKey))),
    missingRequired: missingRequired.sort(),
    missingOptional: missingOptional.sort(),
    blockingDocumentFindings: blockingDocumentFindings.sort(
      (a, b) => a.documentKey.localeCompare(b.documentKey) || a.code.localeCompare(b.code),
    ),
    providerCalls: false,
    paidParserCalls: false,
    canonicalWrites: false,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode =
    missingRequired.length === 0 && blockingDocumentFindings.length === 0
      ? PHASE5_EXIT.ok
      : PHASE5_EXIT.incomplete;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = PHASE5_EXIT.operational;
}
