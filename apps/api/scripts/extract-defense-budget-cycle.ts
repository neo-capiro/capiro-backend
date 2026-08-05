/**
 * Manifest-driven Phase 3 parser-router command.
 *
 * Default: local parsers + Phase 2 inspect verification, no DB/AWS/paid or
 * canonical writes. Paid parsing and audit persistence are separate explicit
 * operator authorizations. Native-structured documents require an explicitly
 * supplied Phase 1 V1 companion and never fall back to PDF parsing.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseBudgetCycleManifestV1,
  type BudgetCycleManifestDocumentV1,
  type BudgetCycleManifestV1,
} from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';
import type { FetchLike } from '../src/defense-budget/llamaparse.client.js';
import {
  DEFAULT_PROFILING_THRESHOLDS,
  computeProfilingConfigSha256,
  parseDocumentProfileResultV1,
} from '../src/defense-budget/parser-router/page-profiler.js';
import { LocalParserRuntimeClient } from '../src/defense-budget/parser-router/local-parser-runtime-client.js';
import {
  FilesystemParserArtifactStore,
  type ParserArtifactStoreV1,
  type ParserRunRecorderV1,
} from '../src/defense-budget/parser-router/parser-artifact-store.js';
import { ParserRouterV1Service } from '../src/defense-budget/parser-router/parser-router-v1.service.js';
import { CumulativePaidPageLlamaParseClient } from '../src/defense-budget/parser-router/cumulative-paid-parse-client-v1.js';
import { verifyNativeStructuredCompanion } from '../src/defense-budget/parser-router/native-structured-companion.js';
import { createProductionParserVerificationContext } from '../src/defense-budget/parser-router/production-parser-verification-context.js';
import { FilesystemProofResolver } from '../src/defense-budget/verification/trusted-proof/filesystem-proof-resolver.js';
import { FilesystemParserArtifactProofResolver } from '../src/defense-budget/verification/trusted-proof/filesystem-parser-artifact-proof-resolver.js';
import { BudgetVerificationV1Service } from '../src/defense-budget/verification/services/budget-verification-v1.service.js';

const EXIT_OK = 0;
const EXIT_ARGUMENT = 2;
const EXIT_PROOF = 3;
const EXIT_RUNTIME = 4;
const EXIT_INCOMPLETE = 5;
const EXIT_REJECTED = 6;
const EXIT_REVIEW = 7;
const EXIT_PAID_CAP = 8;
const EXIT_INTERNAL = 9;
const EXIT_PRIORITY = new Map<number, number>([
  [EXIT_OK, 0],
  [EXIT_REVIEW, 1],
  [EXIT_REJECTED, 2],
  [EXIT_INCOMPLETE, 3],
  [EXIT_PAID_CAP, 4],
  [EXIT_PROOF, 5],
  [EXIT_RUNTIME, 6],
  [EXIT_ARGUMENT, 7],
  [EXIT_INTERNAL, 8],
]);

interface CommandArgs {
  manifest: string;
  document?: string;
  source?: string;
  sourceRoot?: string;
  sourceDocumentId?: string;
  structuredCompanion?: string;
  structuredCompanionRoot?: string;
  workDir: string;
  out?: string;
  allDocuments: boolean;
  allowPaidParse: boolean;
  maxPaidPages: number;
  paidMode?: 'pdf_fast' | 'pdf_premium' | 'pdf_ocr';
  persistVerificationAudit: boolean;
  maxEscalationRounds: number;
}

interface VerificationContext {
  service: BudgetVerificationV1Service;
  artifactStore: ParserArtifactStoreV1;
  parserRunRecorder?: ParserRunRecorderV1;
  dispose(): Promise<void>;
}

const VALUE_FLAGS = new Set([
  '--manifest',
  '--document',
  '--source',
  '--source-root',
  '--source-document-id',
  '--structured-companion',
  '--structured-companion-root',
  '--work-dir',
  '--out',
  '--max-paid-pages',
  '--paid-mode',
  '--max-escalation-rounds',
]);
const BOOLEAN_FLAGS = new Set([
  '--all-documents',
  '--allow-paid-parse',
  '--persist-verification-audit',
]);

function strongerExit(current: number, candidate: number): number {
  return (EXIT_PRIORITY.get(candidate) ?? 99) > (EXIT_PRIORITY.get(current) ?? 99)
    ? candidate
    : current;
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
  const workDir = values.get('--work-dir');
  if (!manifest || !workDir) throw new Error('--manifest and --work-dir are required');
  const allDocuments = booleans.has('--all-documents');
  const document = values.get('--document');
  if (allDocuments === Boolean(document)) {
    throw new Error('supply exactly one of --document or --all-documents');
  }
  if (allDocuments && !values.get('--source-root')) {
    throw new Error('--all-documents requires --source-root');
  }
  if (!allDocuments && !values.get('--source')) {
    throw new Error('--document requires --source');
  }
  if (!allDocuments && !values.get('--out')) {
    throw new Error('single-document extraction requires --out');
  }

  const allowPaidParse = booleans.has('--allow-paid-parse');
  const maxPaidPagesRaw = values.get('--max-paid-pages');
  if (allowPaidParse && !maxPaidPagesRaw) {
    throw new Error('--allow-paid-parse requires --max-paid-pages');
  }
  const maxPaidPages = maxPaidPagesRaw ? Number(maxPaidPagesRaw) : 0;
  if (!Number.isInteger(maxPaidPages) || maxPaidPages < 0) {
    throw new Error('--max-paid-pages must be a nonnegative integer');
  }
  if (allowPaidParse && maxPaidPages === 0) {
    throw new Error('--max-paid-pages must be positive when paid parsing is authorized');
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
    ...(document ? { document } : {}),
    ...(values.get('--source') ? { source: values.get('--source')! } : {}),
    ...(values.get('--source-root') ? { sourceRoot: values.get('--source-root')! } : {}),
    ...(values.get('--source-document-id')
      ? { sourceDocumentId: values.get('--source-document-id')! }
      : {}),
    ...(values.get('--structured-companion')
      ? { structuredCompanion: values.get('--structured-companion')! }
      : {}),
    ...(values.get('--structured-companion-root')
      ? { structuredCompanionRoot: values.get('--structured-companion-root')! }
      : {}),
    workDir,
    ...(values.get('--out') ? { out: values.get('--out')! } : {}),
    allDocuments,
    allowPaidParse,
    maxPaidPages,
    ...(paidMode ? { paidMode } : {}),
    persistVerificationAudit: booleans.has('--persist-verification-audit'),
    maxEscalationRounds,
  };
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sourcePathForDocument(
  document: BudgetCycleManifestDocumentV1,
  args: CommandArgs,
): string {
  if (!args.allDocuments) return path.resolve(args.source!);
  const filename = path.basename(document.sourceLocator.replace(/^file:\/\//, ''));
  if (!filename || filename === '.' || filename === path.sep) {
    throw new Error(
      `document ${document.documentKey} sourceLocator has no deterministic filename`,
    );
  }
  return path.resolve(args.sourceRoot!, filename);
}

function companionPathForDocument(
  document: BudgetCycleManifestDocumentV1,
  args: CommandArgs,
): string {
  if (!args.allDocuments) {
    if (!args.structuredCompanion) {
      throw new Error(
        'native_structured requires --structured-companion <Phase 1 V1 artifact>',
      );
    }
    return path.resolve(args.structuredCompanion);
  }
  if (!args.structuredCompanionRoot) {
    throw new Error(
      'native_structured in --all-documents mode requires --structured-companion-root',
    );
  }
  return path.resolve(
    args.structuredCompanionRoot,
    `${document.documentKey}.extraction-v1.json`,
  );
}

function outputPathForDocument(
  args: CommandArgs,
  document: BudgetCycleManifestDocumentV1,
): string {
  return args.allDocuments
    ? path.join(args.workDir, `${document.documentKey}.extraction-v1.json`)
    : path.resolve(args.out!);
}

async function createVerificationContext(input: {
  persist: boolean;
  sourcePdfPath: string;
  parserArtifactRoot: string;
  allowPaidParse: boolean;
}): Promise<VerificationContext> {
  if (!input.persist) {
    const artifactStore = new FilesystemParserArtifactStore(input.parserArtifactRoot);
    return {
      service: new BudgetVerificationV1Service(
        new FilesystemParserArtifactProofResolver(
          new FilesystemProofResolver({ sourcePdfPath: input.sourcePdfPath }),
          artifactStore,
        ),
        null,
      ),
      artifactStore,
      dispose: async () => undefined,
    };
  }
  const production = await createProductionParserVerificationContext({
    parserArtifactRoot: input.parserArtifactRoot,
    allowPaidParse: input.allowPaidParse,
  });
  return {
    service: production.verificationService,
    artifactStore: production.artifactStore,
    parserRunRecorder: production.parserRunRecorder,
    dispose: production.dispose,
  };
}

function parserArtifactRoot(args: CommandArgs): string {
  if (!args.persistVerificationAudit) {
    return path.join(args.workDir, 'parser-artifacts');
  }
  const configured = process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT?.trim();
  if (!configured) {
    throw new Error(
      'persisted audit requires BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT shared with Phase 2 proof wiring',
    );
  }
  return configured;
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

async function processNativeStructured(input: {
  args: CommandArgs;
  manifest: BudgetCycleManifestV1;
  manifestPath: string;
  document: BudgetCycleManifestDocumentV1;
  sourcePath: string;
}) {
  const sourceSha256 = sha256File(input.sourcePath);
  const sourceDocumentId = input.args.sourceDocumentId ?? `local-${sourceSha256}`;
  if (input.args.persistVerificationAudit && !input.args.sourceDocumentId) {
    throw new Error('--persist-verification-audit requires --source-document-id');
  }
  const companionLocator = companionPathForDocument(input.document, input.args);
  if (!fs.existsSync(companionLocator)) {
    throw new Error(`structured companion not found: ${companionLocator}`);
  }
  const verification = await createVerificationContext({
    persist: input.args.persistVerificationAudit,
    sourcePdfPath: input.sourcePath,
    parserArtifactRoot: parserArtifactRoot(input.args),
    allowPaidParse: false,
  });
  try {
    const result = await verifyNativeStructuredCompanion({
      manifest: input.manifest,
      manifestLocator: input.manifestPath,
      manifestDocument: input.document,
      companionLocator,
      sourceDocumentId,
      sourcePdfSha256: sourceSha256,
      persistVerificationAudit: input.args.persistVerificationAudit,
      verificationService: verification.service,
    });
    const outputPath = outputPathForDocument(input.args, input.document);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(companionLocator, outputPath);
    const reportPath = path.join(
      input.args.workDir,
      input.document.documentKey,
      'execution-report.json',
    );
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          executionMode: 'native_structured',
          sourceSha256,
          companion: result,
          verification: result.verificationResult,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return {
      decision: result.verificationResult.decision,
      finalState:
        result.verificationResult.decision === 'PASS'
          ? 'TERMINAL_PASSED'
          : result.verificationResult.decision === 'REJECT'
            ? 'TERMINAL_REJECTED'
            : 'TERMINAL_REVIEW',
      artifactLocator: companionLocator,
      outputPath,
    };
  } finally {
    await verification.dispose();
  }
}

async function processParsedDocument(input: {
  args: CommandArgs;
  manifest: BudgetCycleManifestV1;
  manifestPath: string;
  document: BudgetCycleManifestDocumentV1;
  sourcePath: string;
  paidClient?: CumulativePaidPageLlamaParseClient;
}) {
  const { args, document, manifest } = input;
  const sourceSha256 = sha256File(input.sourcePath);
  const documentWorkDir = path.join(args.workDir, document.documentKey);
  const runtimeWorkDir = path.join(documentWorkDir, 'runtime');
  fs.mkdirSync(runtimeWorkDir, { recursive: true });

  const parserProjectDir = path.resolve(__dirname, '../../defense-budget-parser');
  const runtimeClient = new LocalParserRuntimeClient({
    command: 'uv',
    commandArgs: ['run', 'capiro-defense-budget-parser'],
    cwd: parserProjectDir,
    workDir: runtimeWorkDir,
    timeoutMs: 15 * 60 * 1000,
  });
  const versionInfo = await runtimeClient.getVersionInfo();
  const pdfplumberVersion = versionInfo.engines.deterministic_pdfplumber;
  if (!pdfplumberVersion) throw new Error('runtime did not report pdfplumber version');

  const profileJob = {
    schemaVersion: 'defense_budget_profile_job_v1' as const,
    jobId: `profile-${document.documentKey}`,
    sourcePath: input.sourcePath,
    sourceSha256,
    engine: 'deterministic_pdfplumber' as const,
    allPages: true,
    requestedPages: [],
    parserVersion: pdfplumberVersion,
    parserConfig: DEFAULT_PROFILING_THRESHOLDS,
    parserConfigSha256: computeProfilingConfigSha256(DEFAULT_PROFILING_THRESHOLDS),
    outputDirectory: runtimeWorkDir,
    includeDebugArtifacts: false,
  };
  const profileJobPath = path.join(runtimeWorkDir, 'profile.job.json');
  const profileResultPath = path.join(runtimeWorkDir, 'profile.result.json');
  fs.writeFileSync(profileJobPath, `${JSON.stringify(profileJob, null, 2)}\n`, 'utf8');
  const profileRun = await runtimeClient.profileJob(profileJobPath, profileResultPath);
  if (profileRun.exitCode !== 0) {
    throw new Error(`profile failed: ${profileRun.stderr || `exit ${profileRun.exitCode}`}`);
  }
  const profile = parseDocumentProfileResultV1(
    JSON.parse(fs.readFileSync(profileResultPath, 'utf8')),
  );
  if (profile.sourceSha256 !== sourceSha256) {
    throw new Error('profile source SHA does not match supplied source bytes');
  }
  const requestedPages = profile.pages.map((page) => page.page).sort((a, b) => a - b);
  if (requestedPages.length === 0) throw new Error('profiler returned zero physical pages');

  const sourceDocumentId = args.sourceDocumentId ?? `local-${sourceSha256}`;
  if (args.persistVerificationAudit && !args.sourceDocumentId) {
    throw new Error('--persist-verification-audit requires --source-document-id');
  }
  if (args.persistVerificationAudit && args.allDocuments) {
    throw new Error('persisted audit currently requires single-document execution');
  }

  const verification = await createVerificationContext({
    persist: args.persistVerificationAudit,
    sourcePdfPath: input.sourcePath,
    parserArtifactRoot: parserArtifactRoot(args),
    allowPaidParse: args.allowPaidParse,
  });
  try {
    const remainingPaidPages = input.paidClient?.getFreshPaidPagesRemaining() ?? 0;
    const router = new ParserRouterV1Service(
      {
        executionId: `${document.documentKey}-${sourceSha256.slice(0, 16)}`,
        cycleId: manifest.cycleId,
        manifestDocumentKey: document.documentKey,
        manifestLocator: input.manifestPath,
        sourceDocumentId,
        sourcePath: input.sourcePath,
        sourceSha256,
        sourceLocator: document.sourceLocator,
        ...(document.sourceUrl ? { sourceUrl: document.sourceUrl } : {}),
        parserPolicy: document.parserPolicy,
        exhibitType: document.exhibit,
        budgetFamily: document.family,
        fiscalYear: manifest.fiscalYear,
        authority: document.authority,
        component: document.component,
        budgetCycle: document.budgetCycle,
        documentType: document.documentType,
        title: document.title,
        maxEscalationRounds: args.maxEscalationRounds,
        allowPaidParse: args.allowPaidParse,
        maxPaidPages: remainingPaidPages,
        ...(args.paidMode ? { paidMode: args.paidMode } : {}),
        persistVerificationAudit: args.persistVerificationAudit,
        workDir: documentWorkDir,
        parserVersions: versionInfo.engines,
      },
      {
        artifactStore: verification.artifactStore,
        runtimeClient,
        verificationService: verification.service,
        ...(verification.parserRunRecorder
          ? { parserRunRecorder: verification.parserRunRecorder }
          : {}),
        llamaparseAuthorization: {
          allowPaidParse: args.allowPaidParse,
          maxPaidPages: remainingPaidPages,
          ...(args.paidMode ? { paidMode: args.paidMode } : {}),
        },
        ...(input.paidClient ? { llamaparseClient: input.paidClient } : {}),
      },
    );
    const terminal = await router.execute(profile.pages, requestedPages);
    const outputPath = outputPathForDocument(args, document);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(terminal.artifactLocator, outputPath);
    fs.writeFileSync(
      path.join(documentWorkDir, 'execution-report.json'),
      `${JSON.stringify(terminal, null, 2)}\n`,
      'utf8',
    );
    return {
      decision: terminal.verifierDecision,
      finalState: terminal.finalState,
      artifactLocator: terminal.artifactLocator,
      outputPath,
    };
  } finally {
    await verification.dispose();
  }
}

async function processDocument(input: {
  args: CommandArgs;
  manifest: BudgetCycleManifestV1;
  manifestPath: string;
  document: BudgetCycleManifestDocumentV1;
  sourcePath: string;
  paidClient?: CumulativePaidPageLlamaParseClient;
}) {
  if (!fs.existsSync(input.sourcePath)) {
    throw new Error(`source file not found: ${input.sourcePath}`);
  }
  return input.document.parserPolicy === 'native_structured'
    ? processNativeStructured(input)
    : processParsedDocument(input);
}

async function main(): Promise<void> {
  let args: CommandArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(EXIT_ARGUMENT);
  }

  let manifest: BudgetCycleManifestV1;
  try {
    manifest = parseBudgetCycleManifestV1(
      JSON.parse(fs.readFileSync(path.resolve(args.manifest), 'utf8')),
    );
  } catch (error) {
    console.error(`manifest validation failed: ${(error as Error).message}`);
    process.exit(EXIT_ARGUMENT);
  }
  const selected = args.allDocuments
    ? manifest.documents
    : manifest.documents.filter((document) => document.documentKey === args.document);
  if (selected.length === 0) {
    console.error(`document not found in manifest: ${args.document}`);
    process.exit(EXIT_ARGUMENT);
  }

  fs.mkdirSync(args.workDir, { recursive: true });
  let finalExit = EXIT_OK;
  const reports: Array<Record<string, unknown>> = [];
  const paidClient = createPaidClient(args);
  for (const document of selected) {
    try {
      const result = await processDocument({
        args,
        manifest,
        manifestPath: path.resolve(args.manifest),
        document,
        sourcePath: sourcePathForDocument(document, args),
        ...(paidClient ? { paidClient } : {}),
      });
      reports.push({ documentKey: document.documentKey, ...result });
      if (result.decision === 'REJECT') finalExit = strongerExit(finalExit, EXIT_REJECTED);
      else if (result.decision === 'REVIEW') finalExit = strongerExit(finalExit, EXIT_REVIEW);
    } catch (error) {
      const message = (error as Error).message;
      console.error(`${document.documentKey}: ${message}`);
      reports.push({ documentKey: document.documentKey, error: message });
      if (/paid.*cap|exceed.*cap/i.test(message)) {
        finalExit = strongerExit(finalExit, EXIT_PAID_CAP);
      } else if (/SHA|proof|manifest|companion/i.test(message)) {
        finalExit = strongerExit(finalExit, EXIT_PROOF);
      } else if (/runtime|parser|uv|Docling|Paddle|Camelot|pdfplumber/i.test(message)) {
        finalExit = strongerExit(finalExit, EXIT_RUNTIME);
      } else {
        finalExit = strongerExit(finalExit, EXIT_INCOMPLETE);
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        manifest: path.resolve(args.manifest),
        paidPageBudget: {
          authorized: args.maxPaidPages,
          freshUsed: paidClient?.getFreshPaidPagesUsed() ?? 0,
          freshRemaining: paidClient?.getFreshPaidPagesRemaining() ?? 0,
        },
        documents: reports,
      },
      null,
      2,
    ),
  );
  process.exit(finalExit);
}

main().catch((error) => {
  console.error(`internal failure: ${(error as Error).stack ?? (error as Error).message}`);
  process.exit(EXIT_INTERNAL);
});
