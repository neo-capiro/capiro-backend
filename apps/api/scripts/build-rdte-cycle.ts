/**
 * Manifest-driven Phase 4 annual RDT&E build.
 *
 * source bytes → Phase 3 profile/router/replay → Phase 4 semantic artifact
 * → final all-artifact Phase 2 inspect verification → reconciliation
 * → guarded projection planning → final cycle certification.
 *
 * No canonical writes, source discovery, scheduling, deployment, or paid call
 * occur by default. Paid parsing remains explicitly authorized and capped.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseBudgetCycleManifestV1,
  validateBudgetCycleManifestV1,
  type BudgetCycleManifestDocumentV1,
  type BudgetCycleManifestV1,
} from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';
import type { ExtractionSourceV1 } from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import { sha256Bytes } from '../src/defense-budget/contracts/canonical-json.js';
import type { FetchLike } from '../src/defense-budget/llamaparse.client.js';
import {
  DEFAULT_PROFILING_THRESHOLDS,
  computeProfilingConfigSha256,
  parseDocumentProfileResultV1,
} from '../src/defense-budget/parser-router/page-profiler.js';
import { LocalParserRuntimeClient } from '../src/defense-budget/parser-router/local-parser-runtime-client.js';
import { FilesystemParserArtifactStore } from '../src/defense-budget/parser-router/parser-artifact-store.js';
import { ParserRouterV1Service } from '../src/defense-budget/parser-router/parser-router-v1.service.js';
import { CumulativePaidPageLlamaParseClient } from '../src/defense-budget/parser-router/cumulative-paid-parse-client-v1.js';
import { FilesystemProofResolver } from '../src/defense-budget/verification/trusted-proof/filesystem-proof-resolver.js';
import { FilesystemParserArtifactProofResolver } from '../src/defense-budget/verification/trusted-proof/filesystem-parser-artifact-proof-resolver.js';
import { BudgetVerificationV1Service } from '../src/defense-budget/verification/services/budget-verification-v1.service.js';
import type { VerificationRequestV1 } from '../src/defense-budget/verification/verification-contract-v1.js';
import {
  buildRdteCycleArtifacts,
  finalizeRdteCycle,
} from '../src/defense-budget/rdte/cycle/rdte-cycle-pipeline-v1.js';
import { createRdtePhase2VerificationAdapter } from '../src/defense-budget/rdte/cycle/rdte-phase2-verification-adapter-v1.js';
import { createRdteSemanticArtifactFactory } from '../src/defense-budget/rdte/cycle/rdte-phase3-semantic-artifact-factory-v1.js';
import type { RdteCycleDocumentInputV1 } from '../src/defense-budget/rdte/cycle/rdte-phase3-document-input-v1.js';
import {
  rdteVerificationRefFromResult,
  type RdteCycleVerificationRefV1,
} from '../src/defense-budget/rdte/rdte-cycle-bundle-v1.js';

const EXIT_OK = 0;
const EXIT_NEEDS_REVIEW = 2;
const EXIT_INCOMPLETE = 3;
const EXIT_REJECTED = 4;
const EXIT_ERROR = 5;

const VALUE_FLAGS = new Set([
  '--manifest',
  '--out',
  '--source-root',
  '--source-map',
  '--max-paid-pages',
  '--paid-mode',
  '--max-escalation-rounds',
]);
const BOOLEAN_FLAGS = new Set(['--allow-paid-parse']);

interface CommandArgs {
  manifest: string;
  out: string;
  sourceRoot?: string;
  sourceMap?: string;
  allowPaidParse: boolean;
  maxPaidPages: number;
  paidMode?: 'pdf_fast' | 'pdf_premium' | 'pdf_ocr';
  maxEscalationRounds: number;
}

interface SourceMapEntry {
  sourcePath: string;
  sourceDocumentId?: string;
}

type SourceMapFile = Record<string, string | SourceMapEntry>;

interface ResolvedDocument {
  original: BudgetCycleManifestDocumentV1;
  local: BudgetCycleManifestDocumentV1;
  sourcePath: string;
  sourceDocumentId: string;
  sourceSha256: string;
}

interface ParsedDocumentResult {
  input: RdteCycleDocumentInputV1;
  artifactLocator: string;
  sourceDocumentId: string;
  verificationResultCount: number;
  executionReport: unknown;
}

function parseArgs(argv: string[]): CommandArgs {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (BOOLEAN_FLAGS.has(flag)) {
      booleans.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown flag: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    values.set(flag, value);
  }
  const manifest = values.get('--manifest');
  const out = values.get('--out');
  if (!manifest || !out) throw new Error('--manifest and --out are required');
  if (!values.get('--source-root') && !values.get('--source-map')) {
    throw new Error('supply --source-root or --source-map');
  }
  const allowPaidParse = booleans.has('--allow-paid-parse');
  const maxPaidPages = Number(values.get('--max-paid-pages') ?? '0');
  if (!Number.isInteger(maxPaidPages) || maxPaidPages < 0) {
    throw new Error('--max-paid-pages must be a nonnegative integer');
  }
  if (allowPaidParse && maxPaidPages === 0) {
    throw new Error('--allow-paid-parse requires --max-paid-pages <positive integer>');
  }
  const paidMode = values.get('--paid-mode');
  if (
    paidMode !== undefined &&
    paidMode !== 'pdf_fast' &&
    paidMode !== 'pdf_premium' &&
    paidMode !== 'pdf_ocr'
  ) {
    throw new Error('--paid-mode must be pdf_fast, pdf_premium, or pdf_ocr');
  }
  const maxEscalationRounds = Number(values.get('--max-escalation-rounds') ?? '4');
  if (!Number.isInteger(maxEscalationRounds) || maxEscalationRounds < 1) {
    throw new Error('--max-escalation-rounds must be a positive integer');
  }
  return {
    manifest,
    out,
    ...(values.get('--source-root') ? { sourceRoot: values.get('--source-root')! } : {}),
    ...(values.get('--source-map') ? { sourceMap: values.get('--source-map')! } : {}),
    allowPaidParse,
    maxPaidPages,
    ...(paidMode ? { paidMode } : {}),
    maxEscalationRounds,
  };
}

function sha256File(filePath: string): string {
  return sha256Bytes(fs.readFileSync(filePath));
}

function readSourceMap(filePath: string | undefined): SourceMapFile {
  if (!filePath) return {};
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`source map not found: ${absolute}`);
  const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--source-map must contain a JSON object keyed by manifest document key');
  }
  return parsed as SourceMapFile;
}

function sourceMapEntry(value: string | SourceMapEntry | undefined): SourceMapEntry | null {
  if (typeof value === 'string') return { sourcePath: value };
  if (
    value &&
    typeof value === 'object' &&
    typeof value.sourcePath === 'string' &&
    value.sourcePath.trim()
  ) {
    return value;
  }
  return null;
}

function resolveSourcePath(input: {
  document: BudgetCycleManifestDocumentV1;
  sourceRoot?: string;
  sourceMap: SourceMapFile;
}): SourceMapEntry {
  const mapped = sourceMapEntry(input.sourceMap[input.document.documentKey]);
  if (mapped) return { ...mapped, sourcePath: path.resolve(mapped.sourcePath) };
  if (!input.sourceRoot) {
    throw new Error(`source map has no entry for ${input.document.documentKey}`);
  }
  const locator = input.document.sourceLocator.replace(/^file:\/\//, '');
  const filename = path.basename(locator);
  if (!filename || filename === '.' || filename === path.sep) {
    throw new Error(
      `document ${input.document.documentKey} has no deterministic source filename`,
    );
  }
  return { sourcePath: path.resolve(input.sourceRoot, filename) };
}

function exhibitRank(exhibit: string): number {
  return ({ 'R-1': 0, 'R-2': 1, 'R-2A': 2, 'R-3': 3, 'R-4': 4, 'R-4A': 5 } as Record<
    string,
    number
  >)[exhibit] ?? 99;
}

function resolveDocuments(input: {
  manifest: BudgetCycleManifestV1;
  sourceRoot?: string;
  sourceMap: SourceMapFile;
}): ResolvedDocument[] {
  return [...input.manifest.documents]
    .sort(
      (left, right) =>
        exhibitRank(left.exhibit) - exhibitRank(right.exhibit) ||
        left.documentKey.localeCompare(right.documentKey),
    )
    .flatMap((document) => {
      let resolved: SourceMapEntry;
      try {
        resolved = resolveSourcePath({
          document,
          sourceRoot: input.sourceRoot,
          sourceMap: input.sourceMap,
        });
      } catch (error) {
        if (!document.required) return [];
        throw error;
      }
      if (!fs.existsSync(resolved.sourcePath)) {
        if (!document.required) return [];
        throw new Error(`source file not found for ${document.documentKey}: ${resolved.sourcePath}`);
      }
      const sourceSha256 = sha256File(resolved.sourcePath);
      if (document.expectedSourceSha256 && document.expectedSourceSha256 !== sourceSha256) {
        throw new Error(
          `source SHA mismatch for ${document.documentKey}: expected ${document.expectedSourceSha256}, got ${sourceSha256}`,
        );
      }
      const sourceDocumentId = resolved.sourceDocumentId?.trim() || `local-${sourceSha256}`;
      return [
        {
          original: document,
          local: {
            ...document,
            sourceLocator: resolved.sourcePath,
            expectedSourceSha256: sourceSha256,
          },
          sourcePath: resolved.sourcePath,
          sourceDocumentId,
          sourceSha256,
        },
      ];
    });
}

function writeExecutionManifest(input: {
  original: BudgetCycleManifestV1;
  resolved: readonly ResolvedDocument[];
  outDir: string;
}): { manifest: BudgetCycleManifestV1; locator: string; contentSha256: string } {
  const localByKey = new Map(input.resolved.map((value) => [value.local.documentKey, value.local]));
  const manifest = parseBudgetCycleManifestV1({
    ...input.original,
    documents: input.original.documents.map(
      (document) => localByKey.get(document.documentKey) ?? document,
    ),
  });
  const findings = validateBudgetCycleManifestV1(manifest).filter(
    (finding) => finding.severity === 'error',
  );
  if (findings.length > 0) {
    throw new Error(
      `local execution manifest invalid: ${findings
        .map((finding) => `${finding.path}: ${finding.message}`)
        .join('; ')}`,
    );
  }
  const locator = path.join(input.outDir, 'execution-manifest.json');
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(locator, serialized, 'utf8');
  return {
    manifest,
    locator,
    contentSha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
  };
}

function sourceForDocument(input: {
  manifest: BudgetCycleManifestV1;
  document: ResolvedDocument;
}): ExtractionSourceV1 & { sourceDocumentId: string } {
  const value = input.document;
  return {
    manifestDocumentKey: value.local.documentKey,
    sourceDocumentId: value.sourceDocumentId,
    sourcePdfSha256: value.sourceSha256,
    sourceLocator: value.sourcePath,
    ...(value.original.sourceUrl ? { sourceUrl: value.original.sourceUrl } : {}),
    fiscalYear: input.manifest.fiscalYear,
    family: value.local.family,
    exhibit: value.local.exhibit,
    authority: value.local.authority,
    component: value.local.component,
    budgetCycle: value.local.budgetCycle,
    documentType: value.local.documentType,
    title: value.local.title,
  };
}

async function profileDocument(input: {
  runtimeClient: LocalParserRuntimeClient;
  document: ResolvedDocument;
  runtimeWorkDir: string;
  parserVersion: string;
}) {
  const profileJob = {
    schemaVersion: 'defense_budget_parser_job_v1' as const,
    jobId: `profile-${input.document.local.documentKey}`,
    sourcePath: input.document.sourcePath,
    sourceSha256: input.document.sourceSha256,
    engine: 'deterministic_pdfplumber' as const,
    requestedPages: [],
    parserVersion: input.parserVersion,
    parserConfig: DEFAULT_PROFILING_THRESHOLDS,
    parserConfigSha256: computeProfilingConfigSha256(DEFAULT_PROFILING_THRESHOLDS),
    outputDirectory: input.runtimeWorkDir,
    includeDebugArtifacts: false,
  };
  const jobPath = path.join(input.runtimeWorkDir, 'profile.job.json');
  const resultPath = path.join(input.runtimeWorkDir, 'profile.result.json');
  fs.writeFileSync(jobPath, `${JSON.stringify(profileJob, null, 2)}\n`, 'utf8');
  const execution = await input.runtimeClient.profileJob(jobPath, resultPath);
  if (execution.exitCode !== 0) {
    throw new Error(
      `profile failed for ${input.document.local.documentKey}: ${execution.stderr || execution.exitCode}`,
    );
  }
  const profile = parseDocumentProfileResultV1(
    JSON.parse(fs.readFileSync(resultPath, 'utf8')),
  );
  if (profile.sourceSha256 !== input.document.sourceSha256) {
    throw new Error(`profile source SHA mismatch for ${input.document.local.documentKey}`);
  }
  if (profile.pages.length === 0) {
    throw new Error(`profile returned zero pages for ${input.document.local.documentKey}`);
  }
  return profile;
}

function createLocalVerificationService(
  artifactStore: FilesystemParserArtifactStore,
): BudgetVerificationV1Service {
  return new BudgetVerificationV1Service(
    new FilesystemParserArtifactProofResolver(new FilesystemProofResolver(), artifactStore),
    null,
  );
}

async function parseDocument(input: {
  args: CommandArgs;
  executionManifest: BudgetCycleManifestV1;
  manifestLocator: string;
  document: ResolvedDocument;
  priorArtifacts: readonly {
    documentKey: string;
    artifactLocator: string;
    sourceDocumentId: string;
  }[];
  sharedArtifactStore: FilesystemParserArtifactStore;
  paidClient?: CumulativePaidPageLlamaParseClient;
  outDir: string;
}): Promise<ParsedDocumentResult> {
  if (input.document.local.parserPolicy === 'native_structured') {
    throw new Error(
      `annual RDT&E build requires a PDF parser policy for ${input.document.local.documentKey}; ` +
        'convert native structured sources to a manifest-specific PDF parser policy or run the native companion path separately',
    );
  }
  const documentWorkDir = path.join(input.outDir, 'work', input.document.local.documentKey);
  const runtimeWorkDir = path.join(documentWorkDir, 'runtime');
  fs.mkdirSync(runtimeWorkDir, { recursive: true });
  const runtimeClient = new LocalParserRuntimeClient({
    command: 'uv',
    commandArgs: ['run', 'capiro-defense-budget-parser'],
    cwd: path.resolve(__dirname, '../../defense-budget-parser'),
    workDir: runtimeWorkDir,
    timeoutMs: 15 * 60 * 1000,
  });
  const versions = await runtimeClient.getVersionInfo();
  const pdfplumberVersion = versions.engines.deterministic_pdfplumber;
  if (!pdfplumberVersion) {
    throw new Error('parser runtime did not report deterministic_pdfplumber version');
  }
  const profile = await profileDocument({
    runtimeClient,
    document: input.document,
    runtimeWorkDir,
    parserVersion: pdfplumberVersion,
  });
  const requestedPages = profile.pages.map((page) => page.page).sort((a, b) => a - b);
  const source = sourceForDocument({
    manifest: input.executionManifest,
    document: input.document,
  });
  const semantic = createRdteSemanticArtifactFactory({
    document: input.document.local,
    source,
    fiscalYear: input.executionManifest.fiscalYear,
  });
  const referenceArtifacts: VerificationRequestV1['referenceArtifacts'] = input.priorArtifacts.map(
    (artifact) => ({
      artifactLocator: artifact.artifactLocator,
      sourceDocumentId: artifact.sourceDocumentId,
      manifestDocumentKey: artifact.documentKey,
      manifestLocator: input.manifestLocator,
    }),
  );
  const verification = createRdtePhase2VerificationAdapter({
    delegate: createLocalVerificationService(input.sharedArtifactStore),
    referenceArtifacts,
  });
  const remainingPaidPages = input.paidClient?.getFreshPaidPagesRemaining() ?? 0;
  const router = new ParserRouterV1Service(
    {
      executionId: `${input.document.local.documentKey}-${input.document.sourceSha256.slice(0, 16)}`,
      cycleId: input.executionManifest.cycleId,
      manifestDocumentKey: input.document.local.documentKey,
      manifestLocator: input.manifestLocator,
      sourceDocumentId: input.document.sourceDocumentId,
      sourcePath: input.document.sourcePath,
      sourceSha256: input.document.sourceSha256,
      sourceLocator: input.document.sourcePath,
      ...(input.document.original.sourceUrl
        ? { sourceUrl: input.document.original.sourceUrl }
        : {}),
      parserPolicy: input.document.local.parserPolicy,
      exhibitType: input.document.local.exhibit,
      budgetFamily: input.document.local.family,
      fiscalYear: input.executionManifest.fiscalYear,
      authority: input.document.local.authority,
      component: input.document.local.component,
      budgetCycle: input.document.local.budgetCycle,
      documentType: input.document.local.documentType,
      title: input.document.local.title,
      maxEscalationRounds: input.args.maxEscalationRounds,
      allowPaidParse: input.args.allowPaidParse,
      maxPaidPages: remainingPaidPages,
      ...(input.args.paidMode ? { paidMode: input.args.paidMode } : {}),
      persistVerificationAudit: false,
      workDir: documentWorkDir,
      parserVersions: versions.engines,
    },
    {
      artifactStore: input.sharedArtifactStore,
      runtimeClient,
      verificationService: verification.service,
      artifactFactory: semantic.factory,
      llamaparseAuthorization: {
        allowPaidParse: input.args.allowPaidParse,
        maxPaidPages: remainingPaidPages,
        ...(input.args.paidMode ? { paidMode: input.args.paidMode } : {}),
      },
      ...(input.paidClient ? { llamaparseClient: input.paidClient } : {}),
    },
  );
  const terminal = await router.execute(profile.pages, requestedPages);
  if (!semantic.capture.documentInput || !semantic.capture.artifactLocator) {
    throw new Error(`semantic artifact capture missing for ${input.document.local.documentKey}`);
  }
  fs.writeFileSync(
    path.join(documentWorkDir, 'execution-report.json'),
    `${JSON.stringify(terminal, null, 2)}\n`,
    'utf8',
  );
  return {
    input: semantic.capture.documentInput,
    artifactLocator: semantic.capture.artifactLocator,
    sourceDocumentId: input.document.sourceDocumentId,
    verificationResultCount: verification.capture.results.length,
    executionReport: terminal,
  };
}

async function runFinalVerifications(input: {
  build: ReturnType<typeof buildRdteCycleArtifacts>;
  manifestLocator: string;
  artifactDirectory: string;
  artifactStore: FilesystemParserArtifactStore;
}): Promise<RdteCycleVerificationRefV1[]> {
  const delegate = createLocalVerificationService(input.artifactStore);
  const sourceDocumentIdByKey = new Map(
    input.build.documents.map((document) => [
      document.document.documentKey,
      document.source.sourceDocumentId,
    ]),
  );
  const artifactPathByKey = new Map<string, string>();
  fs.mkdirSync(input.artifactDirectory, { recursive: true });
  for (const built of input.build.artifacts) {
    const locator = path.join(input.artifactDirectory, `${built.documentKey}.extraction-v1.json`);
    fs.writeFileSync(locator, built.serializedArtifact, 'utf8');
    artifactPathByKey.set(built.documentKey, locator);
  }

  const output: RdteCycleVerificationRefV1[] = [];
  for (const built of input.build.artifacts) {
    const sourceDocumentId = sourceDocumentIdByKey.get(built.documentKey);
    const artifactLocator = artifactPathByKey.get(built.documentKey);
    if (!sourceDocumentId || !artifactLocator) {
      throw new Error(`final verification identity missing for ${built.documentKey}`);
    }
    const references: NonNullable<VerificationRequestV1['referenceArtifacts']> = input.build.artifacts
      .filter((candidate) => candidate.documentKey !== built.documentKey)
      .map((candidate) => {
        const candidateLocator = artifactPathByKey.get(candidate.documentKey);
        const candidateSourceDocumentId = sourceDocumentIdByKey.get(candidate.documentKey);
        if (!candidateLocator || !candidateSourceDocumentId) {
          throw new Error(`reference identity missing for ${candidate.documentKey}`);
        }
        return {
          artifactLocator: candidateLocator,
          sourceDocumentId: candidateSourceDocumentId,
          manifestDocumentKey: candidate.documentKey,
          manifestLocator: input.manifestLocator,
        };
      });
    const result = await delegate.verify({
      manifestLocator: input.manifestLocator,
      manifestDocumentKey: built.documentKey,
      extractionArtifactLocator: artifactLocator,
      sourceDocumentId,
      referenceArtifacts: references,
      mode: 'inspect',
      expectedSourcePdfSha256: built.artifact.source.sourcePdfSha256,
      expectedExtractionArtifactSha256: built.artifactRef.artifactByteSha256,
    });
    output.push(
      rdteVerificationRefFromResult({
        result,
        artifactContentSha256: built.artifact.contentSha256,
      }),
    );
  }
  return output.sort((left, right) =>
    left.manifestDocumentKey.localeCompare(right.manifestDocumentKey),
  );
}

function writeOutputs(input: {
  args: CommandArgs;
  result: ReturnType<typeof finalizeRdteCycle>;
  executionManifestLocator: string;
  parsedDocuments: readonly ParsedDocumentResult[];
  paidClient?: CumulativePaidPageLlamaParseClient;
}): void {
  const outputDirectory = path.resolve(input.args.out);
  fs.writeFileSync(
    path.join(outputDirectory, 'cycle-bundle.json'),
    `${JSON.stringify(input.result.bundle, null, 2)}\n`,
    'utf8',
  );
  if (input.result.projectionPlan) {
    fs.writeFileSync(
      path.join(outputDirectory, 'projection-plan.json'),
      `${JSON.stringify(input.result.projectionPlan, null, 2)}\n`,
      'utf8',
    );
  }
  fs.writeFileSync(
    path.join(outputDirectory, 'build-summary.json'),
    `${JSON.stringify(
      {
        cycleId: input.result.bundle.cycleId,
        fiscalYear: input.result.bundle.fiscalYear,
        certification: input.result.certification,
        reason: input.result.reason,
        counts: input.result.counts,
        bundleContentSha256: input.result.bundle.contentSha256,
        projectionPlanContentSha256: input.result.projectionPlan?.contentSha256 ?? null,
        executionManifestLocator: input.executionManifestLocator,
        paidAuthorization: {
          allowed: input.args.allowPaidParse,
          maxPaidPages: input.args.maxPaidPages,
          freshPaidPagesUsed: input.paidClient?.getFreshPaidPagesUsed() ?? 0,
          freshPaidPagesRemaining: input.paidClient?.getFreshPaidPagesRemaining() ?? 0,
          mode: input.args.paidMode ?? null,
        },
        parserExecutions: input.parsedDocuments.map((document) => ({
          documentKey: document.input.document.documentKey,
          parserRunIds: document.input.parserRuns.map((run) => run.parserRunId),
          unresolvedPages: document.input.unresolvedPages,
          verificationRounds: document.verificationResultCount,
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function createPaidClient(args: CommandArgs): CumulativePaidPageLlamaParseClient | undefined {
  if (!args.allowPaidParse) return undefined;
  const apiKey = process.env.LLAMAPARSE_API_KEY;
  const baseUrl = process.env.LLAMAPARSE_BASE_URL;
  if (!apiKey) throw new Error('LLAMAPARSE_API_KEY is required for paid parsing');
  if (!baseUrl) throw new Error('LLAMAPARSE_BASE_URL is required for paid parsing');
  return new CumulativePaidPageLlamaParseClient(
    { apiKey, baseUrl },
    globalThis.fetch as FetchLike,
    args.maxPaidPages,
  );
}

async function main(): Promise<void> {
  let args: CommandArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(EXIT_ERROR);
  }
  try {
    const manifestPath = path.resolve(args.manifest);
    if (!fs.existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
    const originalManifest = parseBudgetCycleManifestV1(
      JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    );
    const manifestErrors = validateBudgetCycleManifestV1(originalManifest).filter(
      (finding) => finding.severity === 'error',
    );
    if (manifestErrors.length > 0) {
      throw new Error(
        `manifest invalid: ${manifestErrors
          .map((finding) => `${finding.path}: ${finding.message}`)
          .join('; ')}`,
      );
    }
    const outDir = path.resolve(args.out);
    fs.mkdirSync(outDir, { recursive: true });
    const sourceMap = readSourceMap(args.sourceMap);
    const resolved = resolveDocuments({
      manifest: originalManifest,
      sourceRoot: args.sourceRoot,
      sourceMap,
    });
    const executionManifest = writeExecutionManifest({
      original: originalManifest,
      resolved,
      outDir,
    });
    const sharedArtifactStore = new FilesystemParserArtifactStore(
      path.join(outDir, 'parser-artifacts'),
    );
    const paidClient = createPaidClient(args);
    const parsedDocuments: ParsedDocumentResult[] = [];
    const priorArtifacts: Array<{
      documentKey: string;
      artifactLocator: string;
      sourceDocumentId: string;
    }> = [];
    for (const document of resolved) {
      const parsed = await parseDocument({
        args,
        executionManifest: executionManifest.manifest,
        manifestLocator: executionManifest.locator,
        document,
        priorArtifacts,
        sharedArtifactStore,
        ...(paidClient ? { paidClient } : {}),
        outDir,
      });
      parsedDocuments.push(parsed);
      priorArtifacts.push({
        documentKey: parsed.input.document.documentKey,
        artifactLocator: parsed.artifactLocator,
        sourceDocumentId: parsed.sourceDocumentId,
      });
    }

    const build = buildRdteCycleArtifacts({
      fiscalYear: executionManifest.manifest.fiscalYear,
      manifestContentSha256: executionManifest.contentSha256,
      manifestDocuments: executionManifest.manifest.documents,
      documents: parsedDocuments.map((document) => document.input),
    });
    const verifications = await runFinalVerifications({
      build,
      manifestLocator: executionManifest.locator,
      artifactDirectory: path.join(outDir, 'artifacts'),
      artifactStore: sharedArtifactStore,
    });
    const result = finalizeRdteCycle({
      cycleIdIdentity: {
        cycleId: executionManifest.manifest.cycleId,
        fiscalYear: executionManifest.manifest.fiscalYear,
        manifestContentSha256: executionManifest.contentSha256,
      },
      build,
      verifications,
    });
    writeOutputs({
      args,
      result,
      executionManifestLocator: executionManifest.locator,
      parsedDocuments,
      ...(paidClient ? { paidClient } : {}),
    });
    console.log(
      JSON.stringify({
        certification: result.certification,
        reason: result.reason,
        bundleContentSha256: result.bundle.contentSha256,
      }),
    );
    if (result.certification === 'CERTIFIED_RDTE_READY_FOR_PROJECTION') {
      process.exit(EXIT_OK);
    }
    if (result.certification === 'NEEDS_REVIEW') process.exit(EXIT_NEEDS_REVIEW);
    if (result.certification === 'INCOMPLETE') process.exit(EXIT_INCOMPLETE);
    process.exit(EXIT_REJECTED);
  } catch (error) {
    console.error((error as Error).stack ?? (error as Error).message);
    process.exit(EXIT_ERROR);
  }
}

void main();
