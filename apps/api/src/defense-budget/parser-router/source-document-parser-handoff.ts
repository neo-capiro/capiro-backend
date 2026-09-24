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
import type {
  BudgetAuthorityV1,
  BudgetComponentV1,
  BudgetFamilyV1,
  ExhibitV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  DEFAULT_PROFILING_THRESHOLDS,
  computeProfilingConfigSha256,
  parseDocumentProfileResultV1,
} from './page-profiler.js';
import { LocalParserRuntimeClient } from './local-parser-runtime-client.js';
import {
  ParserRouterV1Service,
  type ParserRouterDependencies,
  type ParserRouterTerminalOutputV1,
} from './parser-router-v1.service.js';
import type { ParserArtifactStoreV1, ParserRunRecorderV1 } from './parser-artifact-store.js';
import { FilesystemParserArtifactStore } from './filesystem-parser-artifact-store.js';
import { FilesystemProofResolver } from '../verification/trusted-proof/filesystem-proof-resolver.js';
import { FilesystemParserArtifactProofResolver } from '../verification/trusted-proof/filesystem-parser-artifact-proof-resolver.js';
import { BudgetVerificationV1Service } from '../verification/services/budget-verification-v1.service.js';
import { createProductionParserVerificationContext } from './production-parser-verification-context.js';
import {
  FilesystemExtractionArtifactStore,
  type ExtractionArtifactStoreV1,
} from './extraction-artifact-store.js';
import { resolveArtifactFactoryForFamilyV1 } from './rdte-durable-semantic-artifact-factory-v1.js';
import { lifecycleBridgeManifestCycleIdV1 } from './lifecycle-bridge-manifest-cycle-id-v1.js';
import type { VerificationPersistenceFenceV1 } from '../verification/persistence/verification-persistence-fence-v1.js';

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
  /** Account identity for account-scoped procurement, O&M, and MILCON documents. */
  readonly account?: string;
  /**
   * Phase 10B-31: the SourceDocument.sourceKey this document is registered
   * under. Required (not defaulted) -- every caller of this function already
   * has a real, registered `sourceDocumentId` and so already has its
   * corresponding `sourceKey` (the column is non-nullable), whereas silently
   * defaulting or omitting it is exactly how the synthetic manifest's
   * `expectedSourceKey` would end up disagreeing with the persisted row that
   * production-proof verification loads back out of the database.
   */
  readonly sourceKey: string;
  readonly budgetCycle: string;
  readonly documentType: string;
  readonly title: string;
  readonly workDir: string;
  readonly maxEscalationRounds?: number;
  readonly allowPaidParse?: boolean;
  readonly maxPaidPages?: number;
  readonly persistVerificationAudit?: boolean;
  readonly parserProjectDir?: string;
  readonly verificationPersistenceFence?: VerificationPersistenceFenceV1;
  readonly abortSignal?: AbortSignal;
  /** Persist the router terminal before any fallible local artifact copy. */
  readonly onTerminal?: (output: ParserRouterTerminalOutputV1) => Promise<void>;
}

export interface SourceDocumentParserHandoffResult {
  readonly decision: string;
  readonly finalState: string;
  readonly artifactLocator: string;
  readonly outputPath: string;
  readonly candidateId?: string;
  readonly verificationRunId?: string;
  readonly artifactId?: string;
  readonly artifactContentSha256?: string;
  readonly artifactByteSha256?: string;
}

/**
 * Phase 10B-28R: the production launcher for the isolated Python parser
 * runtime on the lifecycle-bridge path (version, profiling, and parsing all
 * go through it via `LocalParserRuntimeClient`).
 *
 * `--no-sync` is load-bearing. Without it `uv run` first syncs the project
 * environment, and in the ingestion-drain image that sync never finds the
 * build-time cache (the image's runtime `UV_CACHE_DIR` is empty by design:
 * the non-root task user cannot use the root-owned build cache), so uv
 * rebuilds the editable root project and fetches its build backend
 * (`hatchling`) from PyPI at task start -- a runtime package download that
 * fails hard in a network-less container and is a silent supply-chain
 * dependency everywhere else. The environment this launcher needs was fully
 * installed at image build time (`uv sync --locked`), so the launcher must
 * only RUN it, never re-sync it. The drain image additionally sets
 * `UV_OFFLINE=1`, so a regression that reintroduces a runtime sync fails
 * closed at startup instead of downloading.
 *
 * Developer workflow: run `uv sync --locked` once in
 * `apps/defense-budget-parser` (see its README); the specs that drive this
 * handoff need that pre-synced environment for exactly the reason production
 * does.
 */
export const LIFECYCLE_BRIDGE_PARSER_RUNTIME_COMMAND_V1 = Object.freeze({
  command: 'uv',
  commandArgs: Object.freeze(['run', '--no-sync', 'capiro-defense-budget-parser'] as const),
});

export type LifecycleBridgeSyntheticManifestInputV1 = Pick<
  SourceDocumentParserHandoffInput,
  | 'cycleId'
  | 'fiscalYear'
  | 'sourceDocumentId'
  | 'title'
  | 'sourcePath'
  | 'sourceUrl'
  | 'sourceSha256'
  | 'sourceKey'
  | 'budgetFamily'
  | 'exhibitType'
  | 'authority'
  | 'component'
  | 'account'
  | 'budgetCycle'
  | 'documentType'
  | 'parserPolicy'
>;

/**
 * Phase 2 verification requires a cycle-manifest locator + documentKey. The
 * lifecycle bridge path has a SourceDocument, not a curated annual package
 * file, so synthesize a strict single-document manifest that names this exact
 * SourceDocument and points at the local PDF path. CLI extract paths still
 * pass a real curated package via extract-*.ts.
 *
 * Phase 10B-28R: extracted verbatim (key order included -- the manifest's
 * content hash is taken over its serialized bytes) from the body of
 * `runParserHandoffForSourceDocument` so persistence/readiness tests can
 * exercise the exact production manifest shape without running the parser.
 */
export function buildLifecycleBridgeSyntheticManifestV1(
  input: LifecycleBridgeSyntheticManifestInputV1,
) {
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
  // Phase 10B-27: proof resolvers validate the synthetic lifecycle-bridge
  // manifest with validateBudgetCycleManifestV1, which requires cycleId to
  // contain String(fiscalYear). Lifecycle cycle ids (UUIDs in production;
  // harness labels in qualification) do not. Translate only the proof-facing
  // cycleId here — do not mutate the lifecycle row or weaken the validator.
  // Phase 10B-28R: the router (and therefore the persisted candidate identity)
  // keeps the untranslated lifecycle cycleId; see runVerification in
  // parser-router-v1.service.ts and BudgetVerificationV1Service.
  return {
    schemaVersion: 'defense_budget_cycle_manifest_v1' as const,
    cycleId: lifecycleBridgeManifestCycleIdV1({
      cycleId: input.cycleId,
      fiscalYear: Number(input.fiscalYear),
    }),
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
        // Phase 10B-31: the authoritative sourceKey this SourceDocument is
        // registered under, so the metadata-agreement check in
        // CompositeProofResolver compares against the real identity key
        // instead of `sourceLocator` above -- which, for this synthetic,
        // lifecycle-bridge manifest, is only the ephemeral local scratch path
        // the bridge materialized bytes to, structurally never equal to the
        // persisted sourceKey. See `expectedSourceKey` on
        // `BudgetCycleManifestDocumentV1` for the full rationale.
        expectedSourceKey: input.sourceKey,
        family: input.budgetFamily,
        exhibit: input.exhibitType,
        authority: input.authority,
        component,
        ...(input.account?.trim() ? { account: input.account.trim() } : {}),
        budgetCycle: input.budgetCycle,
        documentType: input.documentType,
        parserPolicy: input.parserPolicy,
        // Both branches of the old ternary here produced the identical
        // array; a plain (mutable) literal is both simpler and required --
        // `BudgetCycleManifestDocumentV1.requiredDataCategories` is a
        // mutable array type, which an `as const` tuple cannot satisfy.
        // This document is now also passed as `document` to the durable
        // RDT&E semantic factory below (Phase 10B-10), so it must
        // structurally match that type, not just survive a JSON.stringify.
        requiredDataCategories: ['identity', 'funding'] as Array<'identity' | 'funding'>,
        requiredFundingFields: ['request'] as Array<'request'>,
        expectedLineKinds: (input.budgetFamily === 'rdte'
          ? ['RDTE_PE']
          : input.budgetFamily === 'procurement'
            ? ['PROCUREMENT_BLIN']
            : input.budgetFamily === 'om'
              ? ['OM_SAG']
              : input.budgetFamily === 'milcon'
                ? ['MILCON_PROJECT']
                : ['UNKNOWN']) as Array<
          'RDTE_PE' | 'PROCUREMENT_BLIN' | 'OM_SAG' | 'MILCON_PROJECT' | 'UNKNOWN'
        >,
        allowEmpty: false,
      },
    ],
  };
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
  verificationPersistenceFence?: VerificationPersistenceFenceV1;
}): Promise<VerificationContext> {
  if (input.verificationPersistenceFence && !input.persist) {
    throw new Error('verification persistence fencing requires persisted verification audit');
  }
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
      extractionArtifactStore: new FilesystemExtractionArtifactStore(
        path.join(input.parserArtifactRoot, 'extraction-artifacts'),
      ),
      dispose: async () => undefined,
    };
  }
  const production = await createProductionParserVerificationContext({
    parserArtifactRoot: input.parserArtifactRoot,
    allowPaidParse: input.allowPaidParse,
    verificationPersistenceFence: input.verificationPersistenceFence,
  });
  return {
    service: production.verificationService,
    artifactStore: production.artifactStore,
    parserRunRecorder: production.parserRunRecorder,
    extractionArtifactStore: production.extractionArtifactStore,
    dispose: production.dispose,
  };
}

function parserArtifactRoot(input: { persistVerificationAudit: boolean; workDir: string }): string {
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
    command: LIFECYCLE_BRIDGE_PARSER_RUNTIME_COMMAND_V1.command,
    commandArgs: [...LIFECYCLE_BRIDGE_PARSER_RUNTIME_COMMAND_V1.commandArgs],
    cwd: parserProjectDir,
    workDir: runtimeWorkDir,
    timeoutMs: 15 * 60 * 1000,
    ...(input.abortSignal ? { signal: input.abortSignal } : {}),
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
  const profile = parseDocumentProfileResultV1(
    JSON.parse(fs.readFileSync(profileResultPath, 'utf8')),
  );
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
    verificationPersistenceFence: input.verificationPersistenceFence,
  });
  try {
    // See buildLifecycleBridgeSyntheticManifestV1 for why this manifest exists
    // and how its proof-facing cycleId relates to the lifecycle cycleId.
    const syntheticManifest = buildLifecycleBridgeSyntheticManifestV1(input);
    const component = syntheticManifest.documents[0]!.component;
    const manifestPath = path.join(documentWorkDir, 'lifecycle-bridge-manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(syntheticManifest, null, 2)}\n`, 'utf8');

    // Phase 10B-10: for RDT&E, replace the generic lineage-only default
    // (`buildExtractionArtifact`) with the real, already-tested R-1/R-2/R-2A/
    // R-3/R-4 semantic extractor -- durably wrapped so the persisted locator
    // is always the caller-supplied `ExtractionArtifactStoreV1`'s (S3-backed
    // in production), never the underlying factory's local scratch path. See
    // `rdte-durable-semantic-artifact-factory-v1.ts` for why the raw factory
    // cannot be assigned here directly. Procurement, O&M and MILCON resolve
    // to their proof-bound durable factory below; unsupported families still
    // fall back to the generic lineage builder.
    const artifactFactory = resolveArtifactFactoryForFamilyV1(input.budgetFamily, {
      document: syntheticManifest.documents[0]!,
      source: {
        manifestDocumentKey: input.sourceDocumentId,
        sourceDocumentId: input.sourceDocumentId,
        sourcePdfSha256: input.sourceSha256,
        sourceLocator: input.sourceLocator,
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        fiscalYear: Number(input.fiscalYear),
        family: input.budgetFamily,
        exhibit: input.exhibitType,
        authority: input.authority,
        component,
        budgetCycle: input.budgetCycle,
        documentType: input.documentType,
        ...(input.title ? { title: input.title } : {}),
      },
      fiscalYear: Number(input.fiscalYear),
      parserArtifactStore: verification.artifactStore,
    });

    const dependencies: ParserRouterDependencies = {
      artifactStore: verification.artifactStore,
      runtimeClient,
      verificationService: verification.service,
      extractionArtifactStore: verification.extractionArtifactStore,
      ...(verification.parserRunRecorder
        ? { parserRunRecorder: verification.parserRunRecorder }
        : {}),
      ...(artifactFactory ? { artifactFactory } : {}),
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
    await input.onTerminal?.(terminal);
    const outputPath = path.join(documentWorkDir, `${input.sourceDocumentId}.extraction-v1.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const scratch = await verification.extractionArtifactStore.materializeForLocalConsumer({
      locator: terminal.artifactLocator,
      expectedByteSha256: terminal.artifactByteSha256,
    });
    try {
      fs.copyFileSync(scratch.localPath, outputPath);
    } finally {
      await scratch.cleanup();
    }
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
      ...(terminal.candidateId ? { candidateId: terminal.candidateId } : {}),
      ...(terminal.verificationRunId ? { verificationRunId: terminal.verificationRunId } : {}),
      artifactId: terminal.artifactId,
      artifactContentSha256: terminal.artifactContentSha256,
      artifactByteSha256: terminal.artifactByteSha256,
    };
  } finally {
    await verification.dispose();
  }
}
