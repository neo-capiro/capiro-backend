import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseBudgetCycleManifestV1,
  validateBudgetCycleManifestV1,
  type BudgetCycleManifestDocumentV1,
  type BudgetCycleManifestV1,
} from '../../src/defense-budget/contracts/budget-cycle-manifest-v1.js';
import { parseDefenseBudgetExtractionArtifactV1 } from '../../src/defense-budget/contracts/extraction-artifact-v1.semantic.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
} from '../../src/defense-budget/contracts/extraction-artifact-v1.js';
import type { Phase5ParserResultProofV1 } from '../../src/defense-budget/non-rdte/non-rdte-proof-bound-artifact-v1.js';
import { composeProcurementFamily } from '../../src/defense-budget/procurement/procurement-composer-v1.js';
import type { ProcurementFamilyReport } from '../../src/defense-budget/procurement/procurement-composer-v1.js';
import { composeOmFamily } from '../../src/defense-budget/om/om-composer-v1.js';
import type { OmFamilyReport } from '../../src/defense-budget/om/om-composer-v1.js';
import { composeProofBoundMilconFamily } from '../../src/defense-budget/milcon/proof-bound-milcon-composer-v1.js';
import type { MilconFamilyReport } from '../../src/defense-budget/milcon/milcon-composer-v1.js';

export type Phase5Family = 'procurement' | 'om' | 'milcon';
export type Phase5FamilyReport = ProcurementFamilyReport | OmFamilyReport | MilconFamilyReport;

export const PHASE5_EXIT = {
  ok: 0,
  needsReview: 2,
  incomplete: 3,
  rejected: 4,
  operational: 5,
} as const;

const SHA256_RE = /^[a-f0-9]{64}$/;

export function sha256Bytes(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readJsonFile(filePath: string): unknown {
  const bytes = fs.readFileSync(filePath);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

export interface LoadedPhase5Manifest {
  manifest: BudgetCycleManifestV1;
  contentSha256: string;
  rawBytes: Buffer;
}

export function loadPhase5Manifest(filePath: string): LoadedPhase5Manifest {
  const rawBytes = fs.readFileSync(filePath);
  const manifest = parseBudgetCycleManifestV1(JSON.parse(rawBytes.toString('utf8')));
  const findings = validateBudgetCycleManifestV1(manifest);
  const blocking = findings.filter((finding) => finding.severity === 'error');
  if (blocking.length > 0) {
    throw new Error(
      `manifest failed semantic validation:\n${blocking
        .map((finding) => `${finding.code} ${finding.path}: ${finding.message}`)
        .join('\n')}`,
    );
  }
  return { manifest, contentSha256: sha256Bytes(rawBytes), rawBytes };
}

export function selectPhase5Documents(
  manifest: BudgetCycleManifestV1,
  family?: Phase5Family,
): BudgetCycleManifestDocumentV1[] {
  return manifest.documents.filter((document) => {
    if (family != null && document.family !== family) return false;
    return (
      document.family === 'procurement' || document.family === 'om' || document.family === 'milcon'
    );
  });
}

export function extractionSourceFromManifestDocument(input: {
  document: BudgetCycleManifestDocumentV1;
  fiscalYear: number;
  sourceDocumentId?: string;
}): ExtractionSourceV1 {
  const { document } = input;
  if (document.expectedSourceSha256 == null) {
    throw new Error(
      `document ${document.documentKey} requires expectedSourceSha256 before extraction`,
    );
  }
  return {
    manifestDocumentKey: document.documentKey,
    ...(input.sourceDocumentId != null ? { sourceDocumentId: input.sourceDocumentId } : {}),
    sourcePdfSha256: document.expectedSourceSha256,
    sourceLocator: document.sourceLocator,
    ...(document.sourceUrl != null ? { sourceUrl: document.sourceUrl } : {}),
    fiscalYear: input.fiscalYear,
    family: document.family,
    exhibit: document.exhibit,
    authority: document.authority,
    component: document.component,
    budgetCycle: document.budgetCycle,
    documentType: document.documentType,
    title: document.title,
  };
}

export interface ArtifactParserResultProofEntry {
  parserRunId: string;
  parserResultPath: string;
  parserResultByteSha256?: string;
}

export interface ArtifactMapEntry {
  artifactPath: string;
  /** Legacy one-run descriptor. Multi-run artifacts must use parserResultProofs. */
  parserResultPath?: string;
  parserResultByteSha256?: string;
  parserResultProofs?: ArtifactParserResultProofEntry[];
  composedOutputPath?: string;
  composedOutputByteSha256?: string;
  sourceDocumentId?: string;
}

export type ArtifactMap = Record<string, ArtifactMapEntry>;

function optionalSha(value: unknown, pathLabel: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error(`${pathLabel} must be a lowercase 64-character SHA-256`);
  }
  return value;
}

function optionalNonblank(value: unknown, pathLabel: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${pathLabel} must be a nonblank string`);
  }
  return value;
}

function parseParserResultProofEntries(
  value: unknown,
  documentKey: string,
): ArtifactParserResultProofEntry[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`artifact map entry ${documentKey}.parserResultProofs must be an array`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(
        `artifact map entry ${documentKey}.parserResultProofs[${index}] must be an object`,
      );
    }
    const record = raw as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter(
      (key) => !['parserRunId', 'parserResultPath', 'parserResultByteSha256'].includes(key),
    );
    if (unknownKeys.length > 0) {
      throw new Error(
        `artifact map entry ${documentKey}.parserResultProofs[${index}] has unknown keys: ${unknownKeys.join(', ')}`,
      );
    }
    const parserRunId = optionalNonblank(
      record.parserRunId,
      `artifact map entry ${documentKey}.parserResultProofs[${index}].parserRunId`,
    );
    const parserResultPath = optionalNonblank(
      record.parserResultPath,
      `artifact map entry ${documentKey}.parserResultProofs[${index}].parserResultPath`,
    );
    if (parserRunId == null || parserResultPath == null) {
      throw new Error(
        `artifact map entry ${documentKey}.parserResultProofs[${index}] requires parserRunId and parserResultPath`,
      );
    }
    if (seen.has(parserRunId)) {
      throw new Error(
        `artifact map entry ${documentKey}.parserResultProofs duplicates ${parserRunId}`,
      );
    }
    seen.add(parserRunId);
    return {
      parserRunId,
      parserResultPath,
      ...(optionalSha(
        record.parserResultByteSha256,
        `artifact map entry ${documentKey}.parserResultProofs[${index}].parserResultByteSha256`,
      ) != null
        ? {
            parserResultByteSha256: optionalSha(
              record.parserResultByteSha256,
              `artifact map entry ${documentKey}.parserResultProofs[${index}].parserResultByteSha256`,
            )!,
          }
        : {}),
    };
  });
}

export function loadArtifactMap(filePath: string): ArtifactMap {
  const input = readJsonFile(filePath);
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('artifact map must be a JSON object keyed by manifest document key');
  }
  const output: ArtifactMap = {};
  for (const [documentKey, raw] of Object.entries(input as Record<string, unknown>)) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`artifact map entry ${documentKey} must be an object`);
    }
    const record = raw as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter(
      (key) =>
        ![
          'artifactPath',
          'parserResultPath',
          'parserResultByteSha256',
          'parserResultProofs',
          'composedOutputPath',
          'composedOutputByteSha256',
          'sourceDocumentId',
        ].includes(key),
    );
    if (unknownKeys.length > 0) {
      throw new Error(
        `artifact map entry ${documentKey} has unknown keys: ${unknownKeys.join(', ')}`,
      );
    }
    const artifactPath = optionalNonblank(
      record.artifactPath,
      `artifact map entry ${documentKey}.artifactPath`,
    );
    if (artifactPath == null) {
      throw new Error(`artifact map entry ${documentKey}.artifactPath is required`);
    }
    const parserResultPath = optionalNonblank(
      record.parserResultPath,
      `artifact map entry ${documentKey}.parserResultPath`,
    );
    const parserResultProofs = parseParserResultProofEntries(
      record.parserResultProofs,
      documentKey,
    );
    const composedOutputPath = optionalNonblank(
      record.composedOutputPath,
      `artifact map entry ${documentKey}.composedOutputPath`,
    );
    output[documentKey] = {
      artifactPath,
      ...(parserResultPath != null ? { parserResultPath } : {}),
      ...(optionalSha(
        record.parserResultByteSha256,
        `artifact map entry ${documentKey}.parserResultByteSha256`,
      ) != null
        ? {
            parserResultByteSha256: optionalSha(
              record.parserResultByteSha256,
              `artifact map entry ${documentKey}.parserResultByteSha256`,
            )!,
          }
        : {}),
      ...(parserResultProofs != null ? { parserResultProofs } : {}),
      ...(composedOutputPath != null ? { composedOutputPath } : {}),
      ...(optionalSha(
        record.composedOutputByteSha256,
        `artifact map entry ${documentKey}.composedOutputByteSha256`,
      ) != null
        ? {
            composedOutputByteSha256: optionalSha(
              record.composedOutputByteSha256,
              `artifact map entry ${documentKey}.composedOutputByteSha256`,
            )!,
          }
        : {}),
      ...(optionalNonblank(
        record.sourceDocumentId,
        `artifact map entry ${documentKey}.sourceDocumentId`,
      ) != null
        ? {
            sourceDocumentId: optionalNonblank(
              record.sourceDocumentId,
              `artifact map entry ${documentKey}.sourceDocumentId`,
            )!,
          }
        : {}),
    };
  }
  return output;
}

export function loadArtifact(entry: ArtifactMapEntry): DefenseBudgetExtractionArtifactV1 {
  return parseDefenseBudgetExtractionArtifactV1(readJsonFile(entry.artifactPath));
}

function readProofDescriptor(
  descriptor: ArtifactParserResultProofEntry,
): Phase5ParserResultProofV1 {
  const bytes = fs.readFileSync(descriptor.parserResultPath);
  const byteSha = sha256Bytes(bytes);
  if (descriptor.parserResultByteSha256 != null && descriptor.parserResultByteSha256 !== byteSha) {
    throw new Error(
      `parser-result byte SHA mismatch for ${descriptor.parserRunId}: expected ${descriptor.parserResultByteSha256}, got ${byteSha}`,
    );
  }
  let result: unknown;
  try {
    result = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `invalid parser-result JSON ${descriptor.parserResultPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    parserRunId: descriptor.parserRunId,
    result,
    resultByteSha256: byteSha,
    resultLocator: descriptor.parserResultPath,
  };
}

/**
 * Independently load one exact persisted parser result for every artifact run.
 * A one-run legacy artifact map may use parserResultPath; multi-run artifacts
 * must enumerate parserResultProofs explicitly. Missing, duplicate, and extra
 * run proofs fail closed.
 */
export function loadArtifactParserResultProofs(input: {
  entry: ArtifactMapEntry;
  artifact: DefenseBudgetExtractionArtifactV1;
}): Phase5ParserResultProofV1[] {
  let descriptors = input.entry.parserResultProofs;
  if (descriptors == null) {
    if (input.entry.parserResultPath == null) {
      throw new Error(
        `artifact ${input.artifact.artifactId} has no parser-result proof descriptors`,
      );
    }
    if (input.artifact.parserRuns.length !== 1) {
      throw new Error(
        `artifact ${input.artifact.artifactId} has ${input.artifact.parserRuns.length} parser runs; parserResultProofs is required`,
      );
    }
    descriptors = [
      {
        parserRunId: input.artifact.parserRuns[0]!.parserRunId,
        parserResultPath: input.entry.parserResultPath,
        ...(input.entry.parserResultByteSha256 != null
          ? { parserResultByteSha256: input.entry.parserResultByteSha256 }
          : {}),
      },
    ];
  }

  const expectedRunIds = new Set(input.artifact.parserRuns.map((run) => run.parserRunId));
  const descriptorRunIds = new Set(descriptors.map((descriptor) => descriptor.parserRunId));
  const missing = [...expectedRunIds].filter((runId) => !descriptorRunIds.has(runId));
  const extra = [...descriptorRunIds].filter((runId) => !expectedRunIds.has(runId));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `artifact ${input.artifact.artifactId} parser-result proof set mismatch; missing=${missing.sort().join(',') || 'none'}; extra=${extra.sort().join(',') || 'none'}`,
    );
  }
  return descriptors
    .map(readProofDescriptor)
    .sort((left, right) => left.parserRunId.localeCompare(right.parserRunId));
}

export function loadComposedOutput(entry: ArtifactMapEntry): {
  value: unknown;
  byteSha256: string;
  path: string;
} {
  if (entry.composedOutputPath == null) {
    throw new Error('artifact map entry has no composedOutputPath');
  }
  const bytes = fs.readFileSync(entry.composedOutputPath);
  const byteSha256 = sha256Bytes(bytes);
  if (entry.composedOutputByteSha256 != null && entry.composedOutputByteSha256 !== byteSha256) {
    throw new Error(
      `composed-output byte SHA mismatch: expected ${entry.composedOutputByteSha256}, got ${byteSha256}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `invalid composed-output JSON ${entry.composedOutputPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { value, byteSha256, path: entry.composedOutputPath };
}

function requiredIdentityKeysFromManifest(
  manifest: BudgetCycleManifestV1,
  family: Phase5Family,
): string[] {
  const fromManifest = manifest.metadata?.requiredIdentityKeys;
  if (Array.isArray(fromManifest)) {
    return fromManifest.filter((value): value is string => typeof value === 'string').sort();
  }
  const familyObject = manifest.metadata?.[`${family}RequiredIdentityKeys`];
  return Array.isArray(familyObject)
    ? familyObject.filter((value): value is string => typeof value === 'string').sort()
    : [];
}

function unionStrings(
  documents: readonly BudgetCycleManifestDocumentV1[],
  key: 'requiredQuantityCategories' | 'requiredUnitCostCategories' | 'requiredNarrativeSections',
): string[] {
  return [...new Set(documents.flatMap((document) => document[key] ?? []))].sort();
}

export function composePhase5FamilyReport(input: {
  manifest: BudgetCycleManifestV1;
  family: Phase5Family;
  artifactsByDocumentKey: ReadonlyMap<string, DefenseBudgetExtractionArtifactV1>;
}): Phase5FamilyReport {
  const documents = selectPhase5Documents(input.manifest, input.family);
  const requiredIdentityKeys = requiredIdentityKeysFromManifest(input.manifest, input.family);
  const artifactsForExhibit = (exhibits: readonly string[]) =>
    documents
      .filter((document) => exhibits.includes(document.exhibit))
      .map((document) => input.artifactsByDocumentKey.get(document.documentKey))
      .filter((artifact): artifact is DefenseBudgetExtractionArtifactV1 => artifact != null);
  const required = (exhibit: string) =>
    documents.some((document) => document.exhibit === exhibit && document.required);

  if (input.family === 'procurement') {
    return composeProcurementFamily({
      artifacts: {
        p1Artifacts: artifactsForExhibit(['P-1']),
        p40Artifacts: artifactsForExhibit(['P-40']),
        p5Artifacts: artifactsForExhibit(['P-5', 'P-5A']),
        p21Artifacts: artifactsForExhibit(['P-21']),
        p3aArtifacts: artifactsForExhibit(['P-3A']),
      },
      requiredIdentityKeys,
      p40Required: required('P-40'),
      enrichmentRequired: documents.some(
        (document) =>
          ['P-5', 'P-5A', 'P-21', 'P-3A'].includes(document.exhibit) && document.required,
      ),
      requiredQuantityCategories: unionStrings(documents, 'requiredQuantityCategories'),
      requiredUnitCostCategories: unionStrings(documents, 'requiredUnitCostCategories'),
      requiredNarrativeSections: unionStrings(documents, 'requiredNarrativeSections'),
    });
  }
  if (input.family === 'om') {
    return composeOmFamily({
      artifacts: {
        o1Artifacts: artifactsForExhibit(['O-1']),
        op5Artifacts: artifactsForExhibit(['OP-5']),
      },
      requiredIdentityKeys,
      op5Required: required('OP-5'),
      requiredNarrativeSections: unionStrings(documents, 'requiredNarrativeSections'),
      requiredQuantityCategories: unionStrings(documents, 'requiredQuantityCategories'),
    });
  }
  const accountByDocumentKey = new Map(
    documents.map((document) => [document.documentKey, document.account ?? '']),
  );
  return composeProofBoundMilconFamily({
    artifacts: {
      c1Artifacts: artifactsForExhibit(['C-1']),
      dd1391Artifacts: artifactsForExhibit(['DD1391']),
    },
    accountByDocumentKey,
    requiredIdentityKeys,
    dd1391Required: required('DD1391'),
    requiredNarrativeSections: unionStrings(documents, 'requiredNarrativeSections'),
  });
}

export function parseFamily(value: string | undefined): Phase5Family | undefined {
  if (value == null) return undefined;
  if (value === 'procurement' || value === 'om' || value === 'milcon') return value;
  throw new Error(`invalid family ${value}; expected procurement, om, or milcon`);
}

export function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value == null || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function requireValue(argv: readonly string[], flag: string): string {
  const value = valueAfter(argv, flag);
  if (value == null) throw new Error(`missing ${flag}`);
  return value;
}

export function refuseUnknownFlags(argv: readonly string[], allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const token of argv) {
    if (token.startsWith('--') && !allowedSet.has(token)) {
      throw new Error(`unknown flag ${token}`);
    }
  }
  if (argv.includes('--commit')) {
    throw new Error('Phase 5 has no --commit or promotion mode');
  }
}
