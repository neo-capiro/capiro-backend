import type { PrismaClient } from '@prisma/client';
import type { SourceFamily } from '@capiro/defense-domain';
import { z } from 'zod';
import { routingForSourceFamily } from '../parser-router/source-family-routing.js';
import { toBudgetComponentOrThrow } from '../default-parser-handoff.adapter.js';
import type { ReextractionRequestV1, ReextractionSnapshotV1 } from './reextraction-repository-v1.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const reextractionRequestSchemaV1 = z.object({
  operationId: z.string().uuid(), outboxRowId: z.string().uuid(), oldCandidateId: z.string().uuid(),
  expectedOldVerificationRunId: z.string().uuid(), expectedSourceSha256: sha256,
  expectedOldExtractionArtifactSha256: sha256,
  actor: z.string().trim().min(1).max(256), reason: z.string().trim().min(1).max(16000),
  releaseRevision: z.string().regex(/^[0-9a-f]{40}$/),
}).strict();

export interface ReextractionTargetV1 extends ReextractionSnapshotV1 {
  observationId: string;
  sourceKey: string;
  component: string | null;
  sourceUrl: string;
  title: string;
  fiscalYear: number;
  sourceFamily: SourceFamily;
  budgetCycle: string;
  documentType: string;
  archiveBucket: string;
  archiveS3Key: string;
  archiveVersionId: string;
  byteSize: number;
}

/** Resolve only the explicitly named row/candidate/run; never choose the newest candidate. */
export async function resolveReextractionTargetV1(
  prisma: PrismaClient, request: ReextractionRequestV1,
): Promise<ReextractionTargetV1> {
  reextractionRequestSchemaV1.parse(request);
  const [outbox, candidate] = await Promise.all([
    prisma.defenseBudgetIngestionOutbox.findUnique({
      where: { id: request.outboxRowId }, include: { observation: { include: { sourceDocument: true } }, cycle: true },
    }),
    prisma.budgetExtractionCandidateV1.findUnique({
      where: { id: request.oldCandidateId }, include: { correctedBy: true, reviewDecisions: true },
    }),
  ]);
  const refuse = (message: string): never => { throw new Error(`Re-extraction refused: ${message}`); };
  if (!outbox || !candidate) return refuse('named outbox or candidate does not exist');
  const metadata = outbox.metadata as Record<string, unknown>;
  if (outbox.state !== 'dead_letter' || outbox.leasedBy !== null || outbox.leasedUntil !== null ||
      metadata.verifierDecision !== 'REVIEW' || metadata.governedDisposition !== 'review_required') {
    return refuse('requires the unleased REVIEW/review_required dead-letter row');
  }
  if (candidate.status !== 'NEEDS_REVIEW' || candidate.currentRunId !== request.expectedOldVerificationRunId ||
      candidate.correctedBy || candidate.reviewDecisions.length !== 0) {
    return refuse('old candidate is no longer the named unaccepted, uncorrected review candidate');
  }
  const run = await prisma.budgetVerificationRunV1.findUnique({ where: { id: request.expectedOldVerificationRunId } });
  if (!run || run.candidateId !== candidate.id || run.decision !== 'REVIEW' || run.status !== 'NEEDS_REVIEW') {
    return refuse('old verification run does not match the candidate and REVIEW decision');
  }
  const observation = outbox.observation;
  const source = observation.sourceDocument;
  if (!source || source.supersededByDocumentId || observation.supersededByObservationId) {
    return refuse('observation has no current registered source');
  }
  if (candidate.cycleId !== outbox.cycleId || observation.cycleId !== outbox.cycleId ||
      candidate.sourceDocumentId !== source.id || metadata.sourceDocumentId !== source.id ||
      candidate.sourceSha256 !== request.expectedSourceSha256 || source.sha256 !== request.expectedSourceSha256 ||
      observation.contentSha256 !== request.expectedSourceSha256 || run.sourceSha256 !== request.expectedSourceSha256 ||
      candidate.extractionArtifactSha256 !== request.expectedOldExtractionArtifactSha256 ||
      run.extractionArtifactSha256 !== request.expectedOldExtractionArtifactSha256) {
    return refuse('cycle, source bytes, old artifact, or candidate/run binding changed');
  }
  if (!source.archiveBucket || !source.archiveS3Key || !source.archiveVersionId || source.archiveVersionId === 'null' ||
      !source.byteSize || source.byteSize <= 0) return refuse('versioned archive identity and byte size are required');
  if (!source.fiscalYear || source.fiscalYear !== observation.classifiedFiscalYear || source.fiscalYear !== outbox.cycle.fiscalYear) {
    return refuse('fiscal year does not agree across source, observation and raw lifecycle cycle');
  }
  const sourceFamily = observation.classifiedSourceFamily as SourceFamily;
  const routing = routingForSourceFamily(sourceFamily);
  if (!routing || routing.budgetCycle !== source.budgetCycle || routing.documentType !== source.documentType) {
    return refuse('classified source family does not match the registered document');
  }
  toBudgetComponentOrThrow(source.component);
  return {
    observationId: observation.id, cycleId: outbox.cycleId, sourceDocumentId: source.id,
    sourceSha256: request.expectedSourceSha256,
    // Manifest identity includes this path. Keep it stable across hosts and retry leases.
    sourcePath: `/tmp/capiro-reextraction-v1/sources/${request.expectedSourceSha256}.pdf`,
    sourceKey: source.sourceKey, component: source.component, sourceUrl: source.sourceUrl, title: source.title,
    fiscalYear: source.fiscalYear, sourceFamily, budgetCycle: source.budgetCycle, documentType: source.documentType,
    archiveBucket: source.archiveBucket, archiveS3Key: source.archiveS3Key, archiveVersionId: source.archiveVersionId,
    byteSize: source.byteSize,
  };
}
