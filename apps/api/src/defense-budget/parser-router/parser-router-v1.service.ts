/**
 * Phase 3 parser router orchestration.
 *
 * profile → deterministic plan → execute/replay → compose → strict V1 artifact
 * → Phase 2 verification → bounded page-level escalation → terminal result.
 *
 * No canonical writes. Paid parsing is explicit, page-bounded and reuses a
 * proven cache before constructing or calling a provider client.
 */
import { readFileSync } from 'node:fs';
import type { ParserPolicyV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type {
  BudgetAuthorityV1,
  BudgetComponentV1,
  ExtractionMethodV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
  type JsonValue,
} from '../contracts/canonical-json.js';
import type {
  VerificationRequestV1,
  DefenseBudgetVerificationResultV1,
} from '../verification/verification-contract-v1.js';
import type { BudgetVerificationV1Service } from '../verification/services/budget-verification-v1.service.js';
import type { LlamaParseClient } from '../llamaparse.client.js';
import {
  type DefenseBudgetParsePlanV1,
  type ParserPlanStepV1,
  buildInitialParsePlan,
  buildEscalationPlan,
} from './route-planner.js';
import { mapCorrectableFindings, type VerificationResultMinimalV1 } from './escalation-planner.js';
import type { PageProfileV1 } from './page-profiler.js';
import {
  type ParserDocumentStateV1,
  type ParserRuntimeEngineV1,
  computeParserConfigSha256,
} from './parser-runtime-contract-v1.js';
import type { ComposedPageOutputV1, ParserRunResultEntry } from './page-result-compositor.js';
import { composePageResults } from './page-result-compositor.js';
import {
  buildExtractionArtifact,
  type ExtractionArtifactBridgeInput,
  type ExtractionArtifactBridgeOutput,
} from './extraction-artifact-bridge.js';
import type { LocalParserRuntimeClient } from './local-parser-runtime-client.js';
import {
  executeLlamaParsePages,
  selectParseMode,
  computeLlamaParseConfigSha,
  toLlamaTargetPages,
  type LlamaParsePageType,
  type LlamaParseRunProofV1,
  type PaidAuthorization,
} from './llamaparse-page-executor.js';
import {
  NoOpParserRunRecorder,
  providerJobIdFromArtifactLocator,
  reuseOrCreate,
  type ParserArtifactStoreV1,
  type ParserRunRecorderV1,
} from './parser-artifact-store.js';
import { getDefaultParserConfig } from './parser-engine-defaults.js';
import { CostAccumulator, type ParserCostReportV1 } from './cost-accounting.js';
import { assertRouterStateTransition } from './router-state-machine.js';

export interface ExecutionRoundReportV1 {
  round: number;
  planSha256: string;
  parserRunIds: string[];
  artifactId: string;
  artifactContentSha256: string;
  verifierDecision: string;
  verifierRunIdentity?: string;
  correctableFindingCodes: string[];
  unresolvedFindingCodes: string[];
}

export interface ParserRouterTerminalOutputV1 {
  executionId: string;
  finalState: ParserDocumentStateV1;
  artifactId: string;
  artifactLocator: string;
  artifactContentSha256: string;
  artifactByteSha256: string;
  verifierDecision: string;
  unresolvedFindings: string[];
  reviewRequiredFindings: string[];
  paidPagesUsed: number[];
  localPagesUsed: Record<string, number[]>;
  reusedArtifacts: string[];
  rounds: ExecutionRoundReportV1[];
  costReport: ParserCostReportV1;
  nextOperatorAction: string;
}

export interface ParserRouterConfigV1 {
  executionId: string;
  cycleId: string;
  manifestDocumentKey: string;
  manifestLocator?: string;
  sourceDocumentId?: string;
  sourcePath: string;
  sourceSha256: string;
  sourceLocator: string;
  sourceUrl?: string;
  parserPolicy: ParserPolicyV1;
  exhibitType: string;
  budgetFamily: string;
  fiscalYear: number | string;
  authority?: BudgetAuthorityV1 | string;
  component?: BudgetComponentV1 | string;
  budgetCycle?: string;
  documentType?: string;
  title?: string;
  maxEscalationRounds: number;
  allowPaidParse: boolean;
  maxPaidPages: number;
  paidMode?: 'pdf_fast' | 'pdf_premium' | 'pdf_ocr';
  persistVerificationAudit: boolean;
  workDir: string;
  parserVersions?: Partial<Record<ExtractionMethodV1, string>>;
}

export interface ParserRouterDependencies {
  artifactStore: ParserArtifactStoreV1;
  runtimeClient: LocalParserRuntimeClient;
  verificationService: BudgetVerificationV1Service;
  parserRunRecorder?: ParserRunRecorderV1;
  llamaparseAuthorization?: PaidAuthorization | null;
  llamaparseClient?: LlamaParseClient;
  llamaparseClientConfig?: {
    apiKey: string;
    baseUrl: string;
    pollIntervalMs?: number;
    pollTimeoutMs?: number;
  };
  artifactFactory?: (
    input: ExtractionArtifactBridgeInput,
    outputDir: string,
  ) => ExtractionArtifactBridgeOutput;
}

interface StepExecution {
  entry: ParserRunResultEntry;
  reused: boolean;
}

export class ParserRouterV1Service {
  private readonly costAccumulator = new CostAccumulator();
  private state: ParserDocumentStateV1 = 'PLANNED';
  private readonly rounds: ExecutionRoundReportV1[] = [];
  private readonly allParserResults: ParserRunResultEntry[] = [];
  private readonly attemptedEnginesByPage = new Map<number, ExtractionMethodV1[]>();
  private readonly reusedArtifacts = new Set<string>();
  private readonly providerJobIdsByParserRunId = new Map<string, string>();
  private readonly recorder: ParserRunRecorderV1;
  private readonly artifactFactory: NonNullable<ParserRouterDependencies['artifactFactory']>;

  constructor(
    private readonly config: ParserRouterConfigV1,
    private readonly dependencies: ParserRouterDependencies,
  ) {
    this.recorder = dependencies.parserRunRecorder ?? new NoOpParserRunRecorder();
    this.artifactFactory = dependencies.artifactFactory ?? buildExtractionArtifact;
    this.costAccumulator.setPaidPageCap(config.maxPaidPages);
  }

  async execute(
    pageProfiles: PageProfileV1[],
    requestedPages: number[],
  ): Promise<ParserRouterTerminalOutputV1> {
    this.validateExecutionInput(pageProfiles, requestedPages);
    this.costAccumulator.setSourcePages(requestedPages.length);
    this.costAccumulator.setProfiledPages(pageProfiles.length);

    let plan = buildInitialParsePlan({
      executionId: this.config.executionId,
      cycleId: this.config.cycleId,
      manifestDocumentKey: this.config.manifestDocumentKey,
      sourceSha256: this.config.sourceSha256,
      parserPolicy: this.config.parserPolicy,
      pageProfiles,
      maxEscalationRounds: this.config.maxEscalationRounds,
    });
    this.transitionTo('RUNNING_LOCAL');

    let verificationResult: DefenseBudgetVerificationResultV1 | null = null;
    let bridgeOutput: ExtractionArtifactBridgeOutput | null = null;

    for (let round = 1; round <= this.config.maxEscalationRounds; round++) {
      const activePlan = this.executablePlan(plan);
      const executed = await this.executePlan(activePlan, pageProfiles);
      this.allParserResults.push(...executed.map((item) => item.entry));
      for (const item of executed) {
        if (item.reused) this.reusedArtifacts.add(item.entry.parserRunId);
      }
      this.recordAttemptedEngines(executed.map((item) => item.entry));

      if (this.state === 'RUNNING_LOCAL') this.transitionTo('LOCAL_COMPLETE');
      else if (this.state === 'RUNNING_PAID') this.transitionTo('PAID_COMPLETE');
      else throw new Error(`router executed a plan from unexpected state ${this.state}`);

      const composed = composePageResults({
        executionId: this.config.executionId,
        sourceSha256: this.config.sourceSha256,
        requestedPages,
        parserRunEntries: this.allParserResults,
        plan: activePlan,
      });
      bridgeOutput = this.artifactFactory(this.buildBridgeInput(composed), this.config.workDir);

      this.transitionTo('VERIFYING');
      verificationResult = await this.runVerification(bridgeOutput);
      this.costAccumulator.setFinalVerificationDecision(verificationResult.decision);

      const correctable = mapCorrectableFindings(
        this.toMinimalVerificationResult(verificationResult),
      );
      this.rounds.push({
        round,
        planSha256: activePlan.planSha256,
        parserRunIds: executed.map((item) => item.entry.parserRunId).sort(),
        artifactId: bridgeOutput.artifactId,
        artifactContentSha256: bridgeOutput.artifactContentSha256,
        verifierDecision: verificationResult.decision,
        verifierRunIdentity: verificationResult.verificationRunId,
        correctableFindingCodes: correctable.map((finding) => finding.findingCode).sort(),
        unresolvedFindingCodes: this.getUnresolvedFindingCodes(
          verificationResult,
          correctable.map((finding) => finding.findingCode),
        ),
      });

      const terminalState = this.checkTerminalConditions(
        verificationResult,
        correctable.length,
        round,
      );
      if (terminalState) {
        this.transitionTo(terminalState);
        break;
      }

      this.transitionTo('ESCALATION_PLANNED');
      const escalation = buildEscalationPlan({
        executionId: this.config.executionId,
        cycleId: this.config.cycleId,
        manifestDocumentKey: this.config.manifestDocumentKey,
        sourceSha256: this.config.sourceSha256,
        parserPolicy: this.config.parserPolicy,
        pageProfiles,
        correctableFindings: correctable,
        attemptedEnginesByPage: this.attemptedEnginesByPage,
        allowPaidParse: this.config.allowPaidParse,
        maxPaidPages: this.config.maxPaidPages,
        maxEscalationRounds: this.config.maxEscalationRounds,
        currentRound: round,
      });
      if (escalation.terminal || escalation.plan.steps.length === 0) {
        this.transitionTo(
          verificationResult.decision === 'REJECT' ? 'TERMINAL_REJECTED' : 'TERMINAL_REVIEW',
        );
        break;
      }

      plan = escalation.plan;
      this.transitionTo(plan.steps.some((step) => !step.paid) ? 'RUNNING_LOCAL' : 'RUNNING_PAID');
    }

    if (!this.isTerminal()) this.transitionTo('TERMINAL_REVIEW');
    return this.buildTerminalOutput(bridgeOutput, verificationResult);
  }

  private validateExecutionInput(
    pageProfiles: readonly PageProfileV1[],
    requestedPages: readonly number[],
  ): void {
    if (requestedPages.length === 0) throw new Error('requestedPages must be nonempty');
    if (
      requestedPages.some(
        (page, index) => page < 1 || (index > 0 && page <= requestedPages[index - 1]!),
      )
    ) {
      throw new Error('requestedPages must be sorted, unique, one-based pages');
    }
    const profiled = new Set(pageProfiles.map((profile) => profile.page));
    const missing = requestedPages.filter((page) => !profiled.has(page));
    if (missing.length > 0) {
      throw new Error(`missing page profiles for requested pages: ${missing.join(',')}`);
    }
  }

  /**
   * Verify local output before paid output and split every real runtime job into
   * an exact contiguous page run for DocumentParseJob compatibility.
   */
  private executablePlan(plan: DefenseBudgetParsePlanV1): DefenseBudgetParsePlanV1 {
    const preferred = plan.steps.some((step) => !step.paid)
      ? plan.steps.filter((step) => !step.paid)
      : plan.steps;
    const steps: ParserPlanStepV1[] = [];
    for (const step of [...preferred].sort((a, b) => a.ordinal - b.ordinal)) {
      for (const pages of contiguousPageGroups(step.pages)) {
        steps.push({
          ...step,
          stepId: `step-${steps.length}`,
          ordinal: steps.length,
          pages,
        });
      }
    }
    const withoutHash = {
      ...plan,
      steps,
      plannedPaidPages: steps
        .filter((step) => step.paid)
        .flatMap((step) => step.pages)
        .sort((a, b) => a - b),
      paidAuthorizationRequired: steps.some((step) => step.paid),
    };
    const { planSha256: _oldHash, ...hashInput } = withoutHash;
    return {
      ...withoutHash,
      planSha256: sha256CanonicalJson(hashInput as unknown as JsonValue),
    };
  }

  private async executePlan(
    plan: DefenseBudgetParsePlanV1,
    pageProfiles: readonly PageProfileV1[],
  ): Promise<StepExecution[]> {
    const results: StepExecution[] = [];
    for (const step of [...plan.steps].sort((a, b) => a.ordinal - b.ordinal)) {
      if (step.pages.length === 0) continue;
      results.push(
        step.paid
          ? await this.executePaidStep(step, pageProfiles)
          : await this.executeLocalStep(step),
      );
    }
    if (results.length === 0) throw new Error('parser plan contained no executable steps');
    return results;
  }

  private async executeLocalStep(step: ParserPlanStepV1): Promise<StepExecution> {
    const engineCandidate = step.engine;
    if (
      engineCandidate !== 'deterministic_pdfplumber' &&
      engineCandidate !== 'camelot' &&
      engineCandidate !== 'docling' &&
      engineCandidate !== 'paddleocr'
    ) {
      throw new Error(`unsupported local parser engine in executable plan: ${engineCandidate}`);
    }
    const engine: ParserRuntimeEngineV1 = engineCandidate;
    const parserVersion = this.config.parserVersions?.[engine];
    if (!parserVersion) {
      throw new Error(
        `missing exact runtime version for ${engine}; call parser runtime version --json first`,
      );
    }
    const parserConfig = getDefaultParserConfig(engine);
    const parserConfigSha256 = computeParserConfigSha256(parserConfig);
    const identity = {
      sourceSha256: this.config.sourceSha256,
      method: engine,
      parserVersion,
      parserConfigSha256,
      pages: step.pages,
      runtimeContractVersion: 'defense_budget_parser_job_v1',
    } as const;

    const replay = await reuseOrCreate(this.dependencies.artifactStore, identity, async () => {
      const execution = await this.dependencies.runtimeClient.executeJob({
        job: {
          schemaVersion: 'defense_budget_parser_job_v1',
          jobId: `${this.config.executionId}-${engine}-${step.ordinal}`,
          sourcePath: this.config.sourcePath,
          sourceSha256: this.config.sourceSha256,
          engine,
          requestedPages: [...step.pages],
          parserVersion,
          parserConfig,
          parserConfigSha256,
          outputDirectory: this.config.workDir,
          includeDebugArtifacts: false,
        },
      });
      if (
        execution.result.parserVersion !== parserVersion ||
        execution.result.parserConfigSha256 !== parserConfigSha256
      ) {
        throw new Error(`${engine} result identity does not match planned identity`);
      }
      return {
        result: execution.result,
        resultJson: canonicalJsonStringify(execution.result as unknown as JsonValue),
      };
    });

    if (replay.reusedArtifact) {
      this.costAccumulator.recordReused(engine, step.pages.length);
    } else {
      this.costAccumulator.recordExecuted(engine, step.pages.length);
      this.costAccumulator.addLocalRuntimeMillis(replay.result.metrics.durationMillis);
      if (replay.result.failedPages.length > 0) this.costAccumulator.incrementParserFailures();
      await this.recordFreshRun({
        step,
        method: engine,
        parserVersion,
        parserConfigSha256,
        result: replay.result,
        outputLocator: replay.descriptor.resultLocator,
        outputByteSha256: replay.descriptor.byteSha256,
        outputContentSha256: replay.descriptor.contentSha256,
        mode: 'local',
      });
    }

    return {
      reused: replay.reusedArtifact,
      entry: {
        parserRunId: replay.descriptor.parserRunId,
        result: replay.result,
        method: engine,
        parserVersion,
        parserConfigSha256,
        sourceSha256: this.config.sourceSha256,
        outputArtifactSha256: replay.result.contentSha256,
      },
    };
  }

  private async executePaidStep(
    step: ParserPlanStepV1,
    pageProfiles: readonly PageProfileV1[],
  ): Promise<StepExecution> {
    const authorization = this.dependencies.llamaparseAuthorization;
    if (!authorization?.allowPaidParse || authorization.maxPaidPages <= 0) {
      throw new Error('paid parser step reached execution without explicit authorization and cap');
    }
    const profileByPage = new Map(pageProfiles.map((profile) => [profile.page, profile]));
    const pageType: LlamaParsePageType = step.pages.some(
      (page) => profileByPage.get(page)?.likelyImageOnly,
    )
      ? 'image_ocr'
      : 'complex_digital';
    const mode = selectParseMode(pageType, {
      ...(this.config.paidMode ? { operatorOverride: this.config.paidMode } : {}),
    });
    const parserConfigSha256 = computeLlamaParseConfigSha(
      mode,
      toLlamaTargetPages(step.pages),
      pageType,
    );
    const parserVersion = this.config.parserVersions?.llamaparse ?? 'llamaparse-v1';
    const identity = {
      sourceSha256: this.config.sourceSha256,
      method: 'llamaparse' as const,
      parserVersion,
      parserConfigSha256,
      pages: step.pages,
      runtimeContractVersion: 'defense_budget_parser_job_v1',
    };
    // Mutable box so proof assigned inside produce() remains visible to TS after await.
    const freshProofBox: { value: LlamaParseRunProofV1 | null } = { value: null };

    const replay = await reuseOrCreate(this.dependencies.artifactStore, identity, async () => {
      const execution = await executeLlamaParsePages({
        sourceSha256: this.config.sourceSha256,
        sourcePdfBuffer: readFileSync(this.config.sourcePath),
        sourceFilename: this.config.sourcePath,
        requestedPages: [...step.pages],
        pageType,
        authorization,
        paidModeConfig: {
          ...(this.config.paidMode ? { operatorOverride: this.config.paidMode } : {}),
        },
        ...(this.dependencies.llamaparseClient
          ? { client: this.dependencies.llamaparseClient }
          : {}),
        ...(this.dependencies.llamaparseClientConfig
          ? { clientConfig: this.dependencies.llamaparseClientConfig }
          : {}),
        jobId: `${this.config.executionId}-llamaparse-${step.ordinal}`,
      });
      if (!execution.proof) throw new Error('fresh paid parse did not return provider proof');
      freshProofBox.value = execution.proof;
      return {
        result: execution.result,
        resultJson: canonicalJsonStringify(execution.result as unknown as JsonValue),
        providerJobId: execution.proof.providerJobId,
      };
    });

    const freshProof = freshProofBox.value;
    const providerJobId =
      freshProof?.providerJobId ??
      providerJobIdFromArtifactLocator(replay.descriptor.resultLocator);
    if (providerJobId) {
      this.providerJobIdsByParserRunId.set(replay.descriptor.parserRunId, providerJobId);
    }

    if (replay.reusedArtifact) {
      this.costAccumulator.recordReused('llamaparse', step.pages.length);
    } else {
      this.costAccumulator.recordExecuted('llamaparse', step.pages.length);
      if (replay.result.failedPages.length > 0) this.costAccumulator.incrementParserFailures();
      if (!freshProof) throw new Error('missing provider proof after fresh paid execution');
      this.costAccumulator.setProviderCreditsUsed(freshProof.creditsUsed ?? null);
      await this.recordFreshRun({
        step,
        method: 'llamaparse',
        parserVersion,
        parserConfigSha256,
        result: replay.result,
        outputLocator: replay.descriptor.resultLocator,
        outputByteSha256: replay.descriptor.byteSha256,
        outputContentSha256: replay.descriptor.contentSha256,
        providerJobId: freshProof.providerJobId,
        mode,
        metadata: {
          providerRawOutputByteSha256: freshProof.outputByteSha256,
          ...(freshProof.s3Version ? { providerRawS3Version: freshProof.s3Version } : {}),
          creditsUsed: freshProof.creditsUsed ?? null,
        },
      });
    }

    return {
      reused: replay.reusedArtifact,
      entry: {
        parserRunId: replay.descriptor.parserRunId,
        result: replay.result,
        method: 'llamaparse',
        parserVersion,
        parserConfigSha256,
        sourceSha256: this.config.sourceSha256,
        outputArtifactSha256: replay.result.contentSha256,
      },
    };
  }

  private async recordFreshRun(input: {
    step: ParserPlanStepV1;
    method: ExtractionMethodV1;
    parserVersion: string;
    parserConfigSha256: string;
    result: ParserRunResultEntry['result'];
    outputLocator: string;
    outputByteSha256: string;
    outputContentSha256: string;
    providerJobId?: string;
    mode: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const hasSuccess = input.result.succeededPages.length > 0;
    await this.recorder.record({
      ...(this.config.sourceDocumentId ? { sourceDocumentId: this.config.sourceDocumentId } : {}),
      method: input.method,
      ...(input.providerJobId ? { providerJobId: input.providerJobId } : {}),
      mode: input.mode,
      pageStart: Math.min(...input.step.pages),
      pageEnd: Math.max(...input.step.pages),
      exactPageList: [...input.step.pages],
      inputSha256: this.config.sourceSha256,
      outputLocator: input.outputLocator,
      outputByteSha256: input.outputByteSha256,
      outputContentSha256: input.outputContentSha256,
      parserVersion: input.parserVersion,
      parserConfigSha256: input.parserConfigSha256,
      status: hasSuccess ? 'completed' : 'failed',
      ...(hasSuccess ? {} : { error: 'all requested pages failed' }),
      metrics: input.result.metrics as unknown as Record<string, unknown>,
      metadata: {
        reasonCodes: input.step.reasonCodes,
        failedPages: input.result.failedPages.map((failure) => failure.page),
        ...(input.metadata ?? {}),
      },
    });
  }

  private recordAttemptedEngines(entries: readonly ParserRunResultEntry[]): void {
    for (const entry of entries) {
      for (const page of entry.result.requestedPages) {
        const attempted = this.attemptedEnginesByPage.get(page) ?? [];
        if (!attempted.includes(entry.method)) attempted.push(entry.method);
        this.attemptedEnginesByPage.set(page, attempted);
      }
    }
  }

  private buildBridgeInput(composedOutput: ComposedPageOutputV1): ExtractionArtifactBridgeInput {
    return {
      executionId: this.config.executionId,
      cycleId: this.config.cycleId,
      manifestDocumentKey: this.config.manifestDocumentKey,
      ...(this.config.sourceDocumentId ? { sourceDocumentId: this.config.sourceDocumentId } : {}),
      sourceSha256: this.config.sourceSha256,
      sourceLocator: this.config.sourceLocator,
      ...(this.config.sourceUrl ? { sourceUrl: this.config.sourceUrl } : {}),
      composedOutput,
      exhibitType: this.config.exhibitType,
      budgetFamily: this.config.budgetFamily,
      fiscalYear: this.config.fiscalYear,
      ...(this.config.authority ? { authority: this.config.authority } : {}),
      ...(this.config.component ? { component: this.config.component } : {}),
      budgetCycle: this.config.budgetCycle ?? this.config.cycleId,
      documentType: this.config.documentType ?? this.config.exhibitType,
      ...(this.config.title ? { title: this.config.title } : {}),
      providerJobIdsByParserRunId: Object.fromEntries(this.providerJobIdsByParserRunId),
    };
  }

  private async runVerification(
    bridgeOutput: ExtractionArtifactBridgeOutput,
  ): Promise<DefenseBudgetVerificationResultV1> {
    if (!this.config.manifestLocator) {
      throw new Error('manifestLocator is required for the Phase 2 verification loop');
    }
    if (!this.config.sourceDocumentId) {
      throw new Error('sourceDocumentId is required for the Phase 2 verification loop');
    }
    const request: VerificationRequestV1 = {
      manifestLocator: this.config.manifestLocator,
      manifestDocumentKey: this.config.manifestDocumentKey,
      extractionArtifactLocator: bridgeOutput.artifactLocator,
      sourceDocumentId: this.config.sourceDocumentId,
      mode: this.config.persistVerificationAudit ? 'persist_audit' : 'inspect',
      expectedSourcePdfSha256: this.config.sourceSha256,
      expectedExtractionArtifactSha256: bridgeOutput.artifactByteSha256,
    };
    return this.dependencies.verificationService.verify(request);
  }

  private toMinimalVerificationResult(
    result: DefenseBudgetVerificationResultV1,
  ): VerificationResultMinimalV1 {
    return {
      decision: result.decision,
      checks: result.checks.map((check) => ({
        code: check.code,
        outcome: check.outcome,
        assertionIds: check.assertionIds,
        evidenceIds: check.evidenceIds,
        blocking: check.blocking,
      })),
      discrepancies: result.discrepancies.map((discrepancy) => ({
        code: discrepancy.code,
        assertionIds: discrepancy.assertionIds,
        evidenceIds: discrepancy.evidenceIds,
        severity: discrepancy.severity,
      })),
    };
  }

  private getUnresolvedFindingCodes(
    result: DefenseBudgetVerificationResultV1,
    correctableCodes: readonly string[],
  ): string[] {
    const correctable = new Set(correctableCodes);
    const unresolved = new Set<string>();
    for (const check of result.checks) {
      if (check.outcome !== 'PASS' && check.outcome !== 'SKIPPED' && !correctable.has(check.code)) {
        unresolved.add(check.code);
      }
    }
    for (const discrepancy of result.discrepancies) {
      if (!correctable.has(discrepancy.code)) unresolved.add(discrepancy.code);
    }
    return [...unresolved].sort();
  }

  private checkTerminalConditions(
    result: DefenseBudgetVerificationResultV1,
    correctableCount: number,
    currentRound: number,
  ): ParserDocumentStateV1 | null {
    if (result.decision === 'PASS') return 'TERMINAL_PASSED';
    if (result.decision === 'REVIEW' && correctableCount === 0) return 'TERMINAL_REVIEW';
    if (result.decision === 'REJECT' && correctableCount === 0) return 'TERMINAL_REJECTED';
    if (currentRound >= this.config.maxEscalationRounds) return 'TERMINAL_REVIEW';
    return null;
  }

  private transitionTo(newState: ParserDocumentStateV1): void {
    assertRouterStateTransition(this.state, newState);
    this.state = newState;
  }

  private isTerminal(): boolean {
    return (
      this.state === 'TERMINAL_PASSED' ||
      this.state === 'TERMINAL_REVIEW' ||
      this.state === 'TERMINAL_REJECTED' ||
      this.state === 'FAILED'
    );
  }

  private buildTerminalOutput(
    bridgeOutput: ExtractionArtifactBridgeOutput | null,
    verificationResult: DefenseBudgetVerificationResultV1 | null,
  ): ParserRouterTerminalOutputV1 {
    const localPages: Record<string, number[]> = {};
    for (const entry of this.allParserResults) {
      if (entry.method === 'llamaparse') continue;
      const pages = localPages[entry.method] ?? [];
      for (const page of entry.result.succeededPages) {
        if (!pages.includes(page)) pages.push(page);
      }
      localPages[entry.method] = pages.sort((a, b) => a - b);
    }
    const paidPages = this.allParserResults
      .filter((entry) => entry.method === 'llamaparse')
      .flatMap((entry) => entry.result.succeededPages);
    const lastRound = this.rounds.at(-1);
    return {
      executionId: this.config.executionId,
      finalState: this.state,
      artifactId: bridgeOutput?.artifactId ?? 'none',
      artifactLocator: bridgeOutput?.artifactLocator ?? 'none',
      artifactContentSha256: bridgeOutput?.artifactContentSha256 ?? '',
      artifactByteSha256: bridgeOutput?.artifactByteSha256 ?? '',
      verifierDecision: verificationResult?.decision ?? 'UNKNOWN',
      unresolvedFindings: lastRound?.unresolvedFindingCodes ?? [],
      reviewRequiredFindings:
        verificationResult?.decision === 'REVIEW'
          ? verificationResult.checks
              .filter((check) => check.outcome === 'FAIL' || check.outcome === 'NOT_RUN')
              .map((check) => check.code)
              .sort()
          : [],
      paidPagesUsed: [...new Set(paidPages)].sort((a, b) => a - b),
      localPagesUsed: localPages,
      reusedArtifacts: [...this.reusedArtifacts].sort(),
      rounds: [...this.rounds],
      costReport: this.costAccumulator.buildReport(),
      nextOperatorAction:
        this.state === 'TERMINAL_PASSED'
          ? 'Artifact passed Phase 2 verification. No canonical write is authorized.'
          : this.state === 'TERMINAL_REVIEW'
            ? 'Review unresolved findings or supply a registered family extractor/reference artifact.'
            : 'Correct the source, manifest, parser output, or artifact and create a new execution.',
    };
  }
}

function contiguousPageGroups(pages: readonly number[]): number[][] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const output: number[][] = [];
  let current = [sorted[0]!];
  for (let index = 1; index < sorted.length; index++) {
    const page = sorted[index]!;
    if (page === current[current.length - 1]! + 1) current.push(page);
    else {
      output.push(current);
      current = [page];
    }
  }
  output.push(current);
  return output;
}
