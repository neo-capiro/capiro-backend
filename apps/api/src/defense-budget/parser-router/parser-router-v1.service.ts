/**
 * Workstream L — Parser Router V1 Service.
 *
 * Main orchestration service implementing the verification-driven loop:
 *   profile → plan → execute/replay local runs → compose → build V1 artifact
 *   → Phase 2 inspect verification → map correctable findings to pages
 *   → plan next escalation → repeat → terminal.
 *
 * Enforces max escalation rounds. No canonical writes.
 * Phase 2 verification runs in inspect mode by default (no audit persistence).
 *
 * L4: Verification inspect loop.
 * L5: Iteration history — one execution report per round.
 * L6: Verification persistence — inspect mode by default.
 * L7: Terminal output — final status, artifact locator, verifier decision,
 *     unresolved findings, paid pages used, local pages/engines, reused artifacts.
 */
import type { ParserPolicyV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type {
  VerificationRequestV1,
  DefenseBudgetVerificationResultV1,
} from '../verification/verification-contract-v1.js';
import type { BudgetVerificationV1Service } from '../verification/services/budget-verification-v1.service.js';
import {
  type DefenseBudgetParsePlanV1,
  buildInitialParsePlan,
  buildEscalationPlan,
  DEFAULT_MAX_ESCALATION_ROUNDS,
} from './route-planner.js';
import {
  mapCorrectableFindings,
  type VerificationResultMinimalV1,
  type VerificationFindingV1,
} from './escalation-planner.js';
import type { PageProfileV1 } from './page-profiler.js';
import {
  type ParserRuntimeResultV1,
  type ParserDocumentStateV1,
  isValidTransition,
  computeParserRunId,
  computeParserConfigSha256,
} from './parser-runtime-contract-v1.js';
import type {
  ComposedPageOutputV1,
  ParserRunResultEntry,
} from './page-result-compositor.js';
import { composePageResults } from './page-result-compositor.js';
import {
  buildExtractionArtifact,
  type ExtractionArtifactBridgeOutput,
} from './extraction-artifact-bridge.js';
import type { FilesystemParserArtifactStore } from './filesystem-parser-artifact-store.js';
import type { LocalParserRuntimeClient } from './local-parser-runtime-client.js';
import {
  executeLlamaParsePages,
  type PaidAuthorization,
} from './llamaparse-page-executor.js';
import { CostAccumulator, type ParserCostReportV1 } from './cost-accounting.js';
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* L5. Iteration history                                               */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* L7. Terminal output                                                 */
/* ------------------------------------------------------------------ */

export interface ParserRouterTerminalOutputV1 {
  executionId: string;
  finalState: ParserDocumentStateV1;
  artifactId: string;
  artifactLocator: string;
  artifactContentSha256: string;
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

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface ParserRouterConfigV1 {
  executionId: string;
  cycleId: string;
  manifestDocumentKey: string;
  sourcePath: string;
  sourceSha256: string;
  sourceLocator: string;
  parserPolicy: ParserPolicyV1;
  exhibitType: string;
  budgetFamily: string;
  fiscalYear: string;
  maxEscalationRounds: number;
  allowPaidParse: boolean;
  maxPaidPages: number;
  paidMode?: 'pdf_fast' | 'pdf_premium' | 'pdf_ocr';
  persistVerificationAudit: boolean;
  workDir: string;
}

/* ------------------------------------------------------------------ */
/* Dependencies                                                        */
/* ------------------------------------------------------------------ */

export interface ParserRouterDependencies {
  artifactStore: FilesystemParserArtifactStore;
  runtimeClient: LocalParserRuntimeClient;
  llamaparseAuthorization: PaidAuthorization | null;
  verificationService: BudgetVerificationV1Service | null;
}

/* ------------------------------------------------------------------ */
/* Parser Router V1 Service                                            */
/* ------------------------------------------------------------------ */

export class ParserRouterV1Service {
  private readonly config: ParserRouterConfigV1;
  private readonly deps: ParserRouterDependencies;
  private readonly costAccumulator: CostAccumulator;
  private state: ParserDocumentStateV1 = 'PLANNED';
  private readonly rounds: ExecutionRoundReportV1[] = [];
  private readonly allParserResults: ParserRunResultEntry[] = [];
  private readonly attemptedEnginesByPage = new Map<number, ExtractionMethodV1[]>();

  constructor(config: ParserRouterConfigV1, deps: ParserRouterDependencies) {
    this.config = config;
    this.deps = deps;
    this.costAccumulator = new CostAccumulator();
    this.costAccumulator.setPaidPageCap(config.maxPaidPages);
  }

  /**
   * Execute the full parser routing loop.
   */
  async execute(
    pageProfiles: PageProfileV1[],
    requestedPages: number[],
  ): Promise<ParserRouterTerminalOutputV1> {
    this.costAccumulator.setSourcePages(requestedPages.length);
    this.costAccumulator.setProfiledPages(pageProfiles.length);
    this.transitionTo('RUNNING_LOCAL');

    // Initial plan
    let plan = buildInitialParsePlan({
      executionId: this.config.executionId,
      cycleId: this.config.cycleId,
      manifestDocumentKey: this.config.manifestDocumentKey,
      sourceSha256: this.config.sourceSha256,
      parserPolicy: this.config.parserPolicy,
      pageProfiles,
      maxEscalationRounds: this.config.maxEscalationRounds,
    });

    let round = 0;
    let verificationResult: DefenseBudgetVerificationResultV1 | null = null;
    let bridgeOutput: ExtractionArtifactBridgeOutput | null = null;

    while (round < this.config.maxEscalationRounds) {
      round++;

      // Execute or replay parser runs for this plan
      const roundResults = await this.executePlan(plan);
      this.allParserResults.push(...roundResults);

      // Track attempted engines per page
      for (const result of roundResults) {
        for (const page of result.result.succeededPages) {
          const existing = this.attemptedEnginesByPage.get(page) ?? [];
          if (!existing.includes(result.method)) {
            existing.push(result.method);
          }
          this.attemptedEnginesByPage.set(page, existing);
        }
      }

      // Compose page results
      const composed = composePageResults({
        executionId: this.config.executionId,
        sourceSha256: this.config.sourceSha256,
        requestedPages,
        parserRunEntries: this.allParserResults,
        plan,
      });

      // Build V1 extraction artifact
      bridgeOutput = buildExtractionArtifact(
        {
          executionId: this.config.executionId,
          cycleId: this.config.cycleId,
          manifestDocumentKey: this.config.manifestDocumentKey,
          sourceSha256: this.config.sourceSha256,
          sourceLocator: this.config.sourceLocator,
          composedOutput: composed,
          exhibitType: this.config.exhibitType,
          budgetFamily: this.config.budgetFamily,
          fiscalYear: this.config.fiscalYear,
        },
        this.config.workDir,
      );

      // Run Phase 2 verification in inspect mode
      this.transitionTo('VERIFYING');
      verificationResult = await this.runVerification(bridgeOutput);
      this.costAccumulator.setFinalVerificationDecision(
        verificationResult.decision,
      );

      // Map findings to correctable pages
      const minimalResult = this.toMinimalVerificationResult(verificationResult);
      const correctableFindings = mapCorrectableFindings(minimalResult);

      // Record round
      const roundReport: ExecutionRoundReportV1 = {
        round,
        planSha256: plan.planSha256,
        parserRunIds: roundResults.map((r) => r.parserRunId),
        artifactId: bridgeOutput.artifactId,
        artifactContentSha256: bridgeOutput.artifactContentSha256,
        verifierDecision: verificationResult.decision,
        verifierRunIdentity: verificationResult.verificationRunId,
        correctableFindingCodes: correctableFindings.map((f) => f.findingCode),
        unresolvedFindingCodes: this.getUnresolvedFindingCodes(
          verificationResult,
          correctableFindings.map((f) => f.findingCode),
        ),
      };
      this.rounds.push(roundReport);

      // Check terminal conditions (C5)
      const terminalState = this.checkTerminalConditions(
        verificationResult,
        correctableFindings.length,
        round,
      );
      if (terminalState) {
        this.transitionTo(terminalState);
        break;
      }

      // Plan escalation
      this.transitionTo('ESCALATION_PLANNED');
      const escalation = buildEscalationPlan({
        executionId: this.config.executionId,
        cycleId: this.config.cycleId,
        manifestDocumentKey: this.config.manifestDocumentKey,
        sourceSha256: this.config.sourceSha256,
        parserPolicy: this.config.parserPolicy,
        pageProfiles,
        correctableFindings,
        attemptedEnginesByPage: this.attemptedEnginesByPage,
        allowPaidParse: this.config.allowPaidParse,
        maxPaidPages: this.config.maxPaidPages,
        maxEscalationRounds: this.config.maxEscalationRounds,
        currentRound: round,
      });

      if (escalation.terminal) {
        this.transitionTo(
          verificationResult.decision === 'PASS'
            ? 'TERMINAL_PASSED'
            : verificationResult.decision === 'REJECT'
              ? 'TERMINAL_REJECTED'
              : 'TERMINAL_REVIEW',
        );
        break;
      }

      // Check if escalation requires paid parsing
      const paidSteps = escalation.plan.steps.filter((s) => s.paid);
      if (paidSteps.length > 0) {
        if (!this.config.allowPaidParse) {
          this.transitionTo('TERMINAL_REVIEW');
          break;
        }

        const paidPages = paidSteps.flatMap((s) => s.pages);
        if (paidPages.length > this.config.maxPaidPages) {
          this.transitionTo('TERMINAL_REVIEW');
          break;
        }

        this.transitionTo('RUNNING_PAID');
      }

      plan = escalation.plan;
    }

    // Max rounds reached without terminal
    if (!this.isTerminal()) {
      this.transitionTo('TERMINAL_REVIEW');
    }

    return this.buildTerminalOutput(bridgeOutput, verificationResult);
  }

  /* ---------------------------------------------------------------- */
  /* Private helpers                                                   */
  /* ---------------------------------------------------------------- */

  private async executePlan(
    plan: DefenseBudgetParsePlanV1,
  ): Promise<ParserRunResultEntry[]> {
    const results: ParserRunResultEntry[] = [];

    for (const step of plan.steps) {
      if (step.paid) {
        // Paid step — LlamaParse
        if (!this.deps.llamaparseAuthorization) continue;

        const { result, proof } = await executeLlamaParsePages({
          sourceSha256: this.config.sourceSha256,
          sourcePdfBuffer: Buffer.from(''), // populated by caller
          sourceFilename: this.config.sourcePath,
          requestedPages: step.pages,
          pageType: 'complex_digital',
          authorization: this.deps.llamaparseAuthorization,
          paidModeConfig: this.config.paidMode
            ? { operatorOverride: this.config.paidMode }
            : undefined,
          jobId: `${this.config.executionId}-paid-${step.ordinal}`,
        });

        const runId = computeParserRunId({
          sourceSha256: this.config.sourceSha256,
          method: 'llamaparse',
          parserVersion: result.parserVersion,
          parserConfigSha256: result.parserConfigSha256,
          pages: step.pages,
          runtimeContractVersion: 'defense_budget_parser_job_v1',
        });

        results.push({
          parserRunId: runId,
          result,
          method: 'llamaparse',
          parserVersion: result.parserVersion,
          parserConfigSha256: result.parserConfigSha256,
          sourceSha256: this.config.sourceSha256,
          outputArtifactSha256: result.contentSha256,
        });

        this.costAccumulator.recordExecuted('llamaparse', step.pages.length);
      } else {
        // Local step — Python runtime
        const configSha = computeParserConfigSha256({});
        const job = {
          schemaVersion: 'defense_budget_parser_job_v1' as const,
          jobId: `${this.config.executionId}-${step.engine}-${step.ordinal}`,
          sourcePath: this.config.sourcePath,
          sourceSha256: this.config.sourceSha256,
          engine: step.engine as
            | 'deterministic_pdfplumber'
            | 'camelot'
            | 'docling'
            | 'paddleocr',
          requestedPages: step.pages,
          parserVersion: '1.0.0',
          parserConfig: {},
          parserConfigSha256: configSha,
          outputDirectory: this.config.workDir,
          includeDebugArtifacts: false,
        };

        const jobResult = await this.deps.runtimeClient.executeJob({ job });

        if (jobResult.exitCode === 0 || jobResult.exitCode === 5) {
          const runId = computeParserRunId({
            sourceSha256: this.config.sourceSha256,
            method: step.engine,
            parserVersion: jobResult.result.parserVersion,
            parserConfigSha256: jobResult.result.parserConfigSha256,
            pages: step.pages,
            runtimeContractVersion: 'defense_budget_parser_job_v1',
          });

          results.push({
            parserRunId: runId,
            result: jobResult.result,
            method: step.engine,
            parserVersion: jobResult.result.parserVersion,
            parserConfigSha256: jobResult.result.parserConfigSha256,
            sourceSha256: this.config.sourceSha256,
            outputArtifactSha256: jobResult.result.contentSha256,
          });

          this.costAccumulator.recordExecuted(
            step.engine,
            step.pages.length,
          );
          this.costAccumulator.addLocalRuntimeMillis(
            jobResult.result.metrics.durationMillis,
          );

          if (jobResult.result.failedPages.length > 0) {
            this.costAccumulator.incrementParserFailures();
          }
        }
      }
    }

    return results;
  }

  private async runVerification(
    bridgeOutput: ExtractionArtifactBridgeOutput,
  ): Promise<DefenseBudgetVerificationResultV1> {
    if (!this.deps.verificationService) {
      // No verification service available — synthetic pass for testing
      throw new Error(
        'BudgetVerificationV1Service is required for the verification loop',
      );
    }

    const request: VerificationRequestV1 = {
      manifestLocator: this.config.sourceLocator,
      manifestDocumentKey: this.config.manifestDocumentKey,
      extractionArtifactLocator: bridgeOutput.artifactLocator,
      sourceDocumentId: `sd_${this.config.sourceSha256.slice(0, 16)}`,
      mode: this.config.persistVerificationAudit
        ? 'persist_audit'
        : 'inspect',
      expectedSourcePdfSha256: this.config.sourceSha256,
      expectedExtractionArtifactSha256: bridgeOutput.artifactContentSha256,
    };

    return this.deps.verificationService.verify(request);
  }

  private toMinimalVerificationResult(
    result: DefenseBudgetVerificationResultV1,
  ): VerificationResultMinimalV1 {
    return {
      decision: result.decision,
      checks: result.checks.map((c) => ({
        code: c.code,
        outcome: c.outcome,
        assertionIds: c.assertionIds,
        evidenceIds: c.evidenceIds,
        blocking: c.blocking,
      })),
      discrepancies: result.discrepancies.map((d) => ({
        code: d.code,
        assertionIds: d.assertionIds,
        evidenceIds: d.evidenceIds,
        severity: d.severity,
      })),
    };
  }

  private getUnresolvedFindingCodes(
    result: DefenseBudgetVerificationResultV1,
    correctableCodes: string[],
  ): string[] {
    const correctable = new Set(correctableCodes);
    const allCodes: string[] = [];

    for (const check of result.checks) {
      if (check.outcome === 'FAIL' && !correctable.has(check.code)) {
        allCodes.push(check.code);
      }
    }
    for (const disc of result.discrepancies) {
      if (!correctable.has(disc.code)) {
        allCodes.push(disc.code);
      }
    }

    return allCodes;
  }

  private checkTerminalConditions(
    result: DefenseBudgetVerificationResultV1,
    correctableCount: number,
    currentRound: number,
  ): ParserDocumentStateV1 | null {
    // C5 terminal conditions
    if (result.decision === 'PASS') return 'TERMINAL_PASSED';
    if (result.decision === 'REVIEW' && correctableCount === 0)
      return 'TERMINAL_REVIEW';
    if (result.decision === 'REJECT' && correctableCount === 0)
      return 'TERMINAL_REJECTED';
    if (currentRound >= this.config.maxEscalationRounds)
      return 'TERMINAL_REVIEW';
    return null;
  }

  private transitionTo(newState: ParserDocumentStateV1): void {
    if (!isValidTransition(this.state, newState)) {
      throw new Error(`Invalid state transition: ${this.state} → ${newState}`);
    }
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
    for (const result of this.allParserResults) {
      if (result.method !== 'llamaparse') {
        const existing = localPages[result.method] ?? [];
        for (const p of result.result.succeededPages) {
          if (!existing.includes(p)) existing.push(p);
        }
        localPages[result.method] = existing;
      }
    }

    const paidPages = this.allParserResults
      .filter((r) => r.method === 'llamaparse')
      .flatMap((r) => r.result.succeededPages);

    const nextAction =
      this.state === 'TERMINAL_PASSED'
        ? 'No action required. Artifact verified.'
        : this.state === 'TERMINAL_REVIEW'
          ? 'Review unresolved findings. Consider paid parsing with --allow-paid-parse.'
          : 'Artifact rejected. Review findings and correct source data.';

    const lastRound =
      this.rounds.length > 0 ? this.rounds[this.rounds.length - 1] : null;

    return {
      executionId: this.config.executionId,
      finalState: this.state,
      artifactId: bridgeOutput?.artifactId ?? 'none',
      artifactLocator: bridgeOutput?.artifactLocator ?? 'none',
      artifactContentSha256: bridgeOutput?.artifactContentSha256 ?? '',
      verifierDecision: verificationResult?.decision ?? 'UNKNOWN',
      unresolvedFindings: lastRound?.unresolvedFindingCodes ?? [],
      reviewRequiredFindings:
        verificationResult?.decision === 'REVIEW'
          ? (verificationResult.checks ?? [])
              .filter((c) => c.outcome === 'FAIL')
              .map((c) => c.code)
          : [],
      paidPagesUsed: [...new Set(paidPages)].sort((a, b) => a - b),
      localPagesUsed: localPages,
      reusedArtifacts: [],
      rounds: this.rounds,
      costReport: this.costAccumulator.buildReport(),
      nextOperatorAction: nextAction,
    };
  }
}
