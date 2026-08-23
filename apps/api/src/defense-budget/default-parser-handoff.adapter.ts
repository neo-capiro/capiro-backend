/**
 * Phase 10B-1 — ParserHandoffPort implementation over the existing Phase 1-7
 * pipeline entrypoint (`runParserHandoffForSourceDocument`).
 *
 * This adapter ALWAYS drives the pipeline in its durable persist-audit mode
 * (`persistVerificationAudit: true`). The governed one-shot ingestion worker
 * this bridge serves runs in an ephemeral container: filesystem-only parser
 * output (`FilesystemParserArtifactStore` alone, `persistVerificationAudit:
 * false`) disappears with that container and can never back a durable
 * `ingestionSucceeded=true`. Persist-audit mode instead routes through
 * `createProductionParserVerificationContext`, which persists:
 *   - parser run identity + output locator/hashes to Prisma `DocumentParseJob`
 *     (`PrismaParserRunRecorder`, re-verified byte-for-byte before recording
 *     by `ProofBoundParserRunRecorder`);
 *   - the verification candidate/run/checks/discrepancies rows via
 *     `BudgetVerificationRepositoryV1.persistCompletedVerification`
 *     (`mode: 'persist_audit'` on the verification request);
 *   - any paid (LlamaParse) normalized output to immutable versioned S3.
 * This is the "already-existing durable mechanism" the bridge is required to
 * use — no second evidence store is introduced here.
 *
 * `persistVerificationAudit: true` requires
 * `BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT` (an absolute shared filesystem
 * root) to be configured for the serving process; `createProductionParserVerificationContext`
 * throws a precise error naming the missing configuration when it is not.
 * This adapter does NOT catch that error and fall back to ephemeral-only
 * parsing — it propagates it so the bridge reports the exact missing
 * capability as a retryable downstream failure (see
 * `ObservationIngestionBridgeService.runDownstream`).
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { runParserHandoffForSourceDocument } from './parser-router/source-document-parser-handoff.js';
import { routingForSourceFamily } from './parser-router/source-family-routing.js';
import { VERIFIER_DECISION_VALUES } from './observation-ingestion-bridge.ports.js';
import type {
  ParserHandoffInput,
  ParserHandoffPort,
  ParserHandoffResult,
  VerifierDecision,
} from './observation-ingestion-bridge.ports.js';

export interface DefaultParserHandoffAdapterOptions {
  readonly workDir: string;
  readonly maxEscalationRounds?: number;
}

function toVerifierDecision(decision: string): VerifierDecision {
  return (VERIFIER_DECISION_VALUES as readonly string[]).includes(decision)
    ? (decision as VerifierDecision)
    : 'UNKNOWN';
}

@Injectable()
export class DefaultParserHandoffAdapter implements ParserHandoffPort {
  constructor(private readonly options: DefaultParserHandoffAdapterOptions) {}

  async handoff(input: ParserHandoffInput): Promise<ParserHandoffResult> {
    const routing = routingForSourceFamily(input.sourceFamily);
    const terminal = await runParserHandoffForSourceDocument({
      executionId: `phase10b1-bridge-${input.sourceDocumentId}-${randomUUID().slice(0, 8)}`,
      cycleId: input.cycleId,
      sourceDocumentId: input.sourceDocumentId,
      sourcePath: input.sourcePath,
      sourceSha256: input.sourceSha256,
      sourceLocator: input.sourceUrl,
      sourceUrl: input.sourceUrl,
      parserPolicy: routing.parserPolicy,
      exhibitType: routing.exhibit,
      budgetFamily: routing.family,
      fiscalYear: input.fiscalYear,
      authority: routing.authority,
      budgetCycle: routing.budgetCycle,
      documentType: routing.documentType,
      title: input.title,
      workDir: this.options.workDir,
      maxEscalationRounds: this.options.maxEscalationRounds ?? 4,
      allowPaidParse: false,
      maxPaidPages: 0,
      // Always durable: see the file header for why this must never be false
      // on the governed bridge's production path.
      persistVerificationAudit: true,
    });
    return {
      invoked: true,
      decision: toVerifierDecision(terminal.decision),
      finalState: terminal.finalState,
      artifactLocator: terminal.artifactLocator,
    };
  }
}
