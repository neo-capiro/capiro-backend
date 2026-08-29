/**
 * Phase 10B-1 — small adapter that lets a REGISTERED SourceDocument (not just
 * a local file the operator points at) enter the EXISTING Phase 3
 * `ParserRouterV1Service` pipeline (route -> execute -> compose -> Phase 2
 * verify -> bounded escalation -> terminal result).
 *
 * This function is the refactor `apps/api/scripts/extract-defense-budget-cycle.ts`'s
 * `processParsedDocument` already needed: that script builds this exact same
 * request from a *manifest document entry* (`BudgetCycleManifestDocumentV1`).
 * This module extracts the manifest-independent core so a caller who instead
 * has an already-registered `SourceDocument` — the bridge's situation exactly
 * — can drive the identical production pipeline without needing a manifest
 * entry to exist for it. Nothing about `ParserRouterV1Service`,
 * `LocalParserRuntimeClient`, or the verification context is duplicated or
 * reimplemented; this is purely an input-shape adapter.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParserPolicyV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type { BudgetAuthorityV1, BudgetComponentV1, BudgetFamilyV1, ExhibitV1 } from '../contracts/extraction-artifact-v1.js';
import { DEFAULT_PROFILING_THRESHOLDS, computeProfilingConfigSha256, parseDocumentProfileResultV1 } from './page-profiler.js';
import { LocalParserRuntimeClient } from './local-parser-runtime-client.js';
import { ParserRouterV1Service, type ParserRouterDependencies } from './parser-router-v1.service.js';
import type { ParserArtifactStoreV1, ParserRunRecorderV1 } from './parser-artifact-store.js';
import { FilesystemParserArtifactStore } from './filesystem-parser-artifact-store.js';
import { FilesystemProofResolver } from '../verification/trusted-proof/filesystem-proof-resolver.js';
import { FilesystemParserArtifactProofResolver } from '../verification/trusted-proof/filesystem-parser-artifact-proof-resolver.js';
import { BudgetVerificationV1Service } from '../verification/services/budget-verification-v1.service.js';
import { createProductionParserVerificationContext } from './production-parser-verification-context.js';
import { FilesystemExtractionArtifactStore, type ExtractionArtifactStoreV1 } from './extraction-artifact-store.js';

export interface SourceDocumentParserHandoffInput {
  readonly executionId: string;
  readonly cycleId: string;
  readonly sourceDocumentId: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceLocator: string;
  readonly sourceUrl?: string;
  readonly parserPolicy: ParserPolicyV1;
  readonly exhibitType: ExhibitV1;
  readonly budgetFamily: BudgetFamilyV1;
  readonly fiscalYear: number;
  readonly authority: BudgetAuthorityV1;
  /** Defaults to 'UNKNOWN' when omitted — the bridge doesn't always know a service component. */
  readonly component?: BudgetComponentV1;
  readonly budgetCycle: string;
  readonly documentType: string;
  readonly title: string;
  readonly workDir: string;
  readonly maxEscalationRounds?: number;
  readonly allowPaidParse?: boolean;
  readonly maxPaidPages?: number;
  readonly persistVerificationAudit?: boolean;
  readonly parserProjectDir?: string;
}

export interface SourceDocumentParserHandoffResult {
  readonly decision: string;
  readonly finalState: string;
  readonly artifactLocator: string;
  readonly outputPath: string;
}

interface VerificationContext {
  service: BudgetVerificationV1Service;
  artifactStore: ParserArtifactStoreV1;
  parserRunRecorder?: ParserRunRecorderV1;
  extractionArtifactStore: ExtractionArtifactStoreV1;
  dispose(): Promise<void>;
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
      extractionArtifactStore: new FilesystemExtractionArtifactStore(path.join(input.parserArtifactRoot, 'extraction-artifacts')),
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
    extractionArtifactStore: production.extractionArtifactStore,
    dispose: production.dispose,
  };
}

function parserArtifactRoot(input: {
  persistVerificationAudit: boolean;
  workDir: string;
}): string {
  if (!input.persistVerificationAudit) {
    return path.join(input.workDir, 'parser-artifacts');
  }
  const configured = process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT?.trim();
  if (!configured) {
    throw new Error(
      'persisted audit requires BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT shared with Phase 2 proof wiring',
    );
  }
  return configured;
}

/**
 * Drives the EXISTING Phase 3 router over an already-materialized local PDF
 * path, for a document that is a registered `SourceDocument` rather than a
 * manifest entry. Returns the same terminal shape the CLI script's per-
 * document report carries.
 */
export async function runParserHandoffForSourceDocument(
  input: SourceDocumentParserHandoffInput,
): Promise<SourceDocumentParserHandoffResult> {
  if (!fs.existsSync(input.sourcePath)) {
    throw new Error(`source file not found: ${input.sourcePath}`);
  }

  const documentWorkDir = path.join(input.workDir, input.sourceDocumentId);
  const runtimeWorkDir = path.join(documentWorkDir, 'runtime');
  fs.mkdirSync(runtimeWorkDir, { recursive: true });

  // Production one-shot drain runs from the API image layout, where the
  // monorepo-relative default below does not exist. Prefer an explicit
  // input, then DEFENSE_BUDGET_PARSER_PROJECT_DIR (set on the drain worker
  // image that layers apps/defense-budget-parser + uv), then the local
  // monorepo layout used by developer CLIs.
  const envParserProjectDir = process.env.DEFENSE_BUDGET_PARSER_PROJECT_DIR?.trim();
  const parserProjectDir =
    input.parserProjectDir ??
    (envParserProjectDir && envParserProjectDir.length > 0
      ? envParserProjectDir
      : path.resolve(input.workDir, '../../../defense-budget-parser'));
  if (!fs.existsSync(parserProjectDir)) {
    throw new Error(
      `parser project directory not found: ${parserProjectDir} ` +
        `(set DEFENSE_BUDGET_PARSER_PROJECT_DIR or pass parserProjectDir; ` +
        `API runtime images intentionally omit the Python parser package)`,
    );
  }
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
    jobId: `profile-${input.sourceDocumentId}`,
    sourcePath: input.sourcePath,
    sourceSha256: input.sourceSha256,
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
  const profile = parseDocumentProfileResultV1(JSON.parse(fs.readFileSync(profileResultPath, 'utf8')));
  if (profile.sourceSha256 !== input.sourceSha256) {
    throw new Error('profile source SHA does not match supplied source bytes');
  }
  const requestedPages = profile.pages.map((page) => page.page).sort((a, b) => a - b);
  if (requestedPages.length === 0) throw new Error('profiler returned zero physical pages');

  const persistVerificationAudit = input.persistVerificationAudit ?? false;
  const allowPaidParse = input.allowPaidParse ?? false;
  const verification = await createVerificationContext({
    persist: persistVerificationAudit,
    sourcePdfPath: input.sourcePath,
    parserArtifactRoot: parserArtifactRoot({ persistVerificationAudit, workDir: input.workDir }),
    allowPaidParse,
  });
  try {
    // Phase 2 verification requires a cycle-manifest locator + documentKey.
    // The lifecycle bridge path has a SourceDocument, not a curated annual
    // package file, so synthesize a strict single-document manifest that
    // names this exact SourceDocument and points at the local PDF path.
    // CLI extract paths still pass a real curated package via extract-*.ts.
    const component = (input.component ?? 'UNKNOWN') as
      | 'ARMY'
      | 'NAVY'
      | 'AF'
      | 'SF'
      | 'USMC'
      | 'DW'
      | 'DARPA'
      | 'DHA'
      | 'MDA'
      | 'SOCOM'
      | 'OTHER'
      | 'UNKNOWN';
    const syntheticManifest = {
      schemaVersion: 'defense_budget_cycle_manifest_v1' as const,
      cycleId: input.cycleId,
      fiscalYear: Number(input.fiscalYear),
      domain: 'defense' as const,
      documents: [
        {
          documentKey: input.sourceDocumentId,
          required: true,
          title: input.title,
          sourceLocator: input.sourcePath,
          ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
          expectedSourceSha256: input.sourceSha256,
          family: input.budgetFamily,
          exhibit: input.exhibitType,
          authority: input.authority,
          component,
          budgetCycle: input.budgetCycle,
          documentType: input.documentType,
          parserPolicy: input.parserPolicy,
          requiredDataCategories:
            input.budgetFamily === 'rdte'
              ? (['identity', 'funding'] as const)
              : (['identity', 'funding'] as const),
          requiredFundingFields: ['request'] as const,
          expectedLineKinds:
            input.budgetFamily === 'rdte'
              ? (['RDTE_PE'] as const)
              : input.budgetFamily === 'procurement'
                ? (['PROCUREMENT_BLIN'] as const)
                : input.budgetFamily === 'om'
                  ? (['OM_SAG'] as const)
                  : input.budgetFamily === 'milcon'
                    ? (['MILCON_PROJECT'] as const)
                    : (['UNKNOWN'] as const),
          allowEmpty: false,
        },
      ],
    };
    const manifestPath = path.join(documentWorkDir, 'lifecycle-bridge-manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(syntheticManifest, null, 2)}\n`, 'utf8');

    const dependencies: ParserRouterDependencies = {
      artifactStore: verification.artifactStore,
      runtimeClient,
      verificationService: verification.service,
      extractionArtifactStore: verification.extractionArtifactStore,
      ...(verification.parserRunRecorder ? { parserRunRecorder: verification.parserRunRecorder } : {}),
    };
    const router = new ParserRouterV1Service(
      {
        executionId: input.executionId,
        cycleId: input.cycleId,
        manifestDocumentKey: input.sourceDocumentId,
        manifestLocator: manifestPath,
        sourceDocumentId: input.sourceDocumentId,
        sourcePath: input.sourcePath,
        sourceSha256: input.sourceSha256,
        sourceLocator: input.sourceLocator,
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        parserPolicy: input.parserPolicy,
        exhibitType: input.exhibitType,
        budgetFamily: input.budgetFamily,
        fiscalYear: input.fiscalYear,
        authority: input.authority,
        component,
        budgetCycle: input.budgetCycle,
        documentType: input.documentType,
        title: input.title,
        maxEscalationRounds: input.maxEscalationRounds ?? 4,
        allowPaidParse,
        maxPaidPages: input.maxPaidPages ?? 0,
        persistVerificationAudit,
        workDir: documentWorkDir,
        parserVersions: versionInfo.engines,
      },
      dependencies,
    );
    const terminal = await router.execute(profile.pages, requestedPages);
    const outputPath = path.join(documentWorkDir, `${input.sourceDocumentId}.extraction-v1.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const scratch = await verification.extractionArtifactStore.materializeForLocalConsumer({
      locator: terminal.artifactLocator,
      expectedByteSha256: terminal.artifactByteSha256,
    });
    try { fs.copyFileSync(scratch.localPath, outputPath); } finally { await scratch.cleanup(); }
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
