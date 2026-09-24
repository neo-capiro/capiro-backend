import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { SourceDocumentArchiveReadPort } from '../observation-ingestion-bridge.ports.js';
import { toBudgetComponentOrThrow } from '../default-parser-handoff.adapter.js';
import { routingForSourceFamily } from '../parser-router/source-family-routing.js';
import type {
  SourceDocumentParserHandoffInput,
  SourceDocumentParserHandoffResult,
} from '../parser-router/source-document-parser-handoff.js';
import type { VerificationPersistenceFenceV1 } from '../verification/persistence/verification-persistence-fence-v1.js';
import {
  REEXTRACTION_HEARTBEAT_MS_V1,
  reextractionRequestHashV1,
  type ReextractionRequestV1,
  type ReextractionRepositoryV1,
  type ReextractionOperationV1,
  type ReextractionLeaseContextV1,
} from './reextraction-repository-v1.js';
import {
  reextractionRequestSchemaV1,
  type ReextractionTargetV1,
} from './reextraction-target-v1.js';

export interface ReviewCandidateReextractionDependenciesV1 {
  repository: ReextractionRepositoryV1;
  resolveTarget(request: ReextractionRequestV1): Promise<ReextractionTargetV1>;
  archive: SourceDocumentArchiveReadPort;
  parse(input: SourceDocumentParserHandoffInput): Promise<SourceDocumentParserHandoffResult>;
  persistenceFence(context: ReextractionLeaseContextV1): VerificationPersistenceFenceV1;
  /** Hash of non-secret effective runtime settings, pinned with the release on resume. */
  runtimeConfigSha256: string;
  /** Same approved filesystem root used by production proof resolution. */
  parserArtifactRoot: string;
  heartbeatMs?: number;
}

export interface ReextractionOperatorResultV1 {
  outcome: 'preview' | 'completed' | 'busy' | 'blocked' | 'conflict' | 'ineligible';
  operation: ReextractionOperationV1 | null;
  target?: ReextractionTargetV1;
  extractionChanged?: boolean;
  persistedForReview?: boolean;
  /** This operation never accepts, supersedes, or publishes any fact. */
  publication: 'not_performed';
  nextAction: string;
}

function completed(operation: ReextractionOperationV1): ReextractionOperatorResultV1 {
  const terminal = operation.terminal!;
  const changed =
    terminal.artifactContentSha256 !== operation.request.expectedOldExtractionArtifactSha256;
  const decision = terminal.verifierDecision;
  return {
    outcome: 'completed',
    operation,
    extractionChanged: changed,
    persistedForReview: decision === 'REVIEW',
    publication: 'not_performed',
    nextAction:
      decision === 'REJECT'
        ? 'Inspect the recorded verification findings. No correction or approval is eligible from this result.'
        : !changed || operation.candidateId === operation.oldCandidateId
          ? 'Extraction evidence is unchanged. Inspect the result; do not record a self-correction or approve it automatically.'
          : `Inspect candidate ${operation.candidateId} and run ${operation.verificationRunId}; then use correct:defense-budget-candidate-v1 for the explicit old/new pair and fresh scoped reviews for verified totals.`,
  };
}

/** One named operation; same-cycle fresh extraction, never an outbox-state rewrite. */
export class ReviewCandidateReextractionV1 {
  constructor(private readonly deps: ReviewCandidateReextractionDependenciesV1) {
    if (!isAbsolute(deps.parserArtifactRoot))
      throw new Error('Re-extraction requires the absolute production parser artifact root');
  }

  async run(
    rawRequest: ReextractionRequestV1,
    options: { commit: boolean },
  ): Promise<ReextractionOperatorResultV1> {
    const request = reextractionRequestSchemaV1.parse(rawRequest);
    const previous = await this.deps.repository.read(request.operationId);
    if (
      previous &&
      reextractionRequestHashV1(request, previous.snapshot) !== previous.requestHash
    ) {
      return {
        outcome: 'conflict',
        operation: previous,
        publication: 'not_performed',
        nextAction: 'Operation ID is already bound to a different request or release.',
      };
    }
    // Reading an already completed operation remains useful after later review/correction.
    if (previous?.status === 'completed') return completed(previous);
    const target = await this.deps.resolveTarget(request);
    const snapshot = {
      ...target,
      runtimeConfigSha256: this.deps.runtimeConfigSha256,
      parserArtifactRoot: this.deps.parserArtifactRoot,
      parserConfig: { maxEscalationRounds: 4, allowPaidParse: false, maxPaidPages: 0 },
    };
    if (previous && reextractionRequestHashV1(request, snapshot) !== previous.requestHash) {
      return {
        outcome: 'conflict',
        operation: previous,
        publication: 'not_performed',
        nextAction:
          'Source bindings or runtime settings changed. Preserve this operation and investigate the mismatch.',
      };
    }
    if (!options.commit)
      return {
        outcome: 'preview',
        operation: previous,
        target,
        publication: 'not_performed',
        nextAction:
          'Eligible for one named re-extraction. Preview performed no archive read, parser execution, or write.',
      };
    const context = { operationId: request.operationId, leaseToken: randomUUID() };
    const claim = await this.deps.repository.claim({
      request,
      snapshot,
      leaseToken: context.leaseToken,
    });
    if (claim.outcome === 'completed' && claim.operation) return completed(claim.operation);
    if (claim.outcome !== 'claimed')
      return {
        outcome: claim.outcome,
        operation: claim.operation,
        publication: 'not_performed',
        nextAction:
          'No parser was started. Inspect the operation and its existing lease or refusal before continuing.',
      };
    let leaseLost = false;
    let heartbeatInFlight: Promise<void> | null = null;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = this.deps.repository
        .heartbeat(context)
        .then((ok) => {
          if (!ok) leaseLost = true;
        })
        .catch(() => {
          leaseLost = true;
        })
        .finally(() => {
          heartbeatInFlight = null;
        });
    }, this.deps.heartbeatMs ?? REEXTRACTION_HEARTBEAT_MS_V1);
    heartbeat.unref();
    try {
      const archived = await this.deps.archive.readMaterializedBytes({
        bucket: target.archiveBucket,
        key: target.archiveS3Key,
        versionId: target.archiveVersionId,
      });
      const actualSha = createHash('sha256').update(archived.bytes).digest('hex');
      if (
        actualSha !== target.sourceSha256 ||
        archived.contentSha256 !== actualSha ||
        archived.bytes.length !== target.byteSize
      ) {
        await this.deps.repository.block(
          context,
          'Archived bytes or byte size disagree with the pinned SourceDocument',
        );
        throw new Error('Archived source identity mismatch; parser was not started');
      }
      if (leaseLost || !(await this.deps.repository.heartbeat(context)))
        throw new Error('Re-extraction lease lost before parsing');
      await mkdir(dirname(target.sourcePath), { recursive: true });
      // Identical verified bytes may share a stable manifest locator; attempts never share runtime work files.
      const temporary = `${target.sourcePath}.${context.leaseToken}`;
      await writeFile(temporary, archived.bytes, { mode: 0o600 });
      await rename(temporary, target.sourcePath);
      const routing = routingForSourceFamily(target.sourceFamily);
      const fence = this.deps.persistenceFence(context);
      await this.deps.parse({
        executionId: `reextract-${request.operationId}`,
        cycleId: target.cycleId,
        sourceDocumentId: target.sourceDocumentId,
        sourceSha256: target.sourceSha256,
        sourcePath: target.sourcePath,
        sourceLocator: target.sourceUrl,
        sourceUrl: target.sourceUrl,
        sourceKey: target.sourceKey,
        ...(target.account ? { account: target.account } : {}),
        component: toBudgetComponentOrThrow(target.component),
        fiscalYear: target.fiscalYear,
        title: target.title,
        budgetCycle: target.budgetCycle,
        documentType: target.documentType,
        parserPolicy: routing.parserPolicy,
        exhibitType: routing.exhibit,
        budgetFamily: routing.family,
        authority: routing.authority,
        workDir: join(
          this.deps.parserArtifactRoot,
          'reextraction-v1',
          request.operationId,
          context.leaseToken,
        ),
        persistVerificationAudit: true,
        maxEscalationRounds: 4,
        allowPaidParse: false,
        maxPaidPages: 0,
        verificationPersistenceFence: async (...args) => {
          if (leaseLost)
            throw new Error('Re-extraction heartbeat failed; refusing verification persistence');
          await fence(...args);
        },
        onTerminal: async (terminal) => {
          if (
            leaseLost ||
            !terminal.candidateId ||
            !terminal.verificationRunId ||
            !/^[0-9a-f]{64}$/.test(terminal.artifactContentSha256) ||
            !/^[0-9a-f]{64}$/.test(terminal.artifactByteSha256) ||
            !['PASS', 'REVIEW', 'REJECT'].includes(terminal.verifierDecision)
          ) {
            throw new Error('Re-extraction has no complete, fenced persisted terminal result');
          }
          // Re-check operational eligibility after OCR; repository completion also checks under its transaction lock.
          const current = await this.deps.resolveTarget(request);
          if (
            reextractionRequestHashV1(request, { ...snapshot, ...current }) !==
            reextractionRequestHashV1(request, snapshot)
          ) {
            throw new Error('Original review/source bindings changed while re-extraction ran');
          }
          if (!(await this.deps.repository.complete(context, { ...terminal })))
            throw new Error('Terminal checkpoint refused');
        },
      });
      const operation = await this.deps.repository.read(request.operationId);
      if (operation?.status !== 'completed')
        throw new Error('Parser returned without a durable terminal checkpoint');
      return completed(operation);
    } catch (error) {
      // Scratch-file copies may fail after the real result is durably checkpointed. Recover that exact result.
      const operation = await this.deps.repository.read(request.operationId);
      if (operation?.status === 'completed') return completed(operation);
      await this.deps.repository.fail(
        context,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
    }
  }
}
