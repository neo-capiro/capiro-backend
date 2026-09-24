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
import { BUDGET_COMPONENT_V1_VALUES } from './contracts/extraction-artifact-v1.js';
import type { BudgetComponentV1 } from './contracts/extraction-artifact-v1.js';

export interface DefaultParserHandoffAdapterOptions {
  readonly workDir: string;
  readonly maxEscalationRounds?: number;
}

function toVerifierDecision(decision: string): VerifierDecision {
  return (VERIFIER_DECISION_VALUES as readonly string[]).includes(decision)
    ? (decision as VerifierDecision)
    : 'UNKNOWN';
}

/**
 * Phase 10B-31: translate the bridge's raw, persisted `component` (a free
 * string column, `null` legitimate for all-component/committee documents)
 * into the parser/manifest pipeline's closed `BudgetComponentV1` vocabulary.
 *
 * `null` -> `undefined` (the manifest builder's own documented default to
 * `'UNKNOWN'` already covers "no component applies"). A non-null value that
 * is NOT one of the 12 known component codes is a genuine data problem --
 * the persisted SourceDocument disagrees with the closed vocabulary the
 * manifest/artifact contract requires -- and fails closed with a precise
 * error rather than silently coercing an unrecognized value to `'UNKNOWN'`,
 * which would hide exactly the kind of real-vs-reported disagreement this
 * repair exists to catch.
 */
export function toBudgetComponentOrThrow(component: string | null): BudgetComponentV1 | undefined {
  if (component == null) return undefined;
  if ((BUDGET_COMPONENT_V1_VALUES as readonly string[]).includes(component)) {
    return component as BudgetComponentV1;
  }
  throw new Error(
    `SourceDocument component "${component}" is not a recognized BudgetComponentV1 value ` +
      `(${BUDGET_COMPONENT_V1_VALUES.join(', ')}); refusing to silently coerce it to UNKNOWN`,
  );
}

@Injectable()
export class DefaultParserHandoffAdapter implements ParserHandoffPort {
  constructor(private readonly options: DefaultParserHandoffAdapterOptions) {}

  async handoff(input: ParserHandoffInput): Promise<ParserHandoffResult> {
    const routing = routingForSourceFamily(input.sourceFamily);
    const terminal = await runParserHandoffForSourceDocument({
      executionId: input.governedExecution?.executionId ??
        `phase10b1-bridge-${input.sourceDocumentId}-${randomUUID().slice(0, 8)}`,
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
      // Phase 10B-31: the authoritative sourceKey/component this
      // SourceDocument actually carries, propagated so the synthetic manifest
      // built inside `runParserHandoffForSourceDocument` agrees with what
      // production-proof verification will load back out of the row itself,
      // instead of silently defaulting an absent/never-passed component to
      // 'UNKNOWN' or comparing sourceKey against an unrelated scratch path.
      sourceKey: input.sourceKey,
      component: toBudgetComponentOrThrow(input.component),
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
      verificationPersistenceFence: input.governedExecution?.verificationPersistenceFence,
      onTerminal: input.governedExecution?.onTerminal,
      ...(input.governedExecution?.abortSignal
        ? { abortSignal: input.governedExecution.abortSignal }
        : {}),
    });
    return {
      invoked: true,
      decision: toVerifierDecision(terminal.decision),
      finalState: terminal.finalState,
      artifactLocator: terminal.artifactLocator,
      candidateId: terminal.candidateId,
      verificationRunId: terminal.verificationRunId,
      artifactId: terminal.artifactId,
      artifactContentSha256: terminal.artifactContentSha256,
      artifactByteSha256: terminal.artifactByteSha256,
    };
  }
}
