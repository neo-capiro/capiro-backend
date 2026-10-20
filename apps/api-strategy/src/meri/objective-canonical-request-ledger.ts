import type { Prisma } from '../../generated/prisma-client/index.js';
import { applicationHash, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { GENERATION_REQUEST, canonicalGenerationAdmissionSha256, type CanonicalGenerationAdmission } from './objective-canonical-generation.js';
import { readGenerationLedger, generationMarker } from './objective-canonical-producer-ledger.js';
import { candidateJcsSha256, privateRequestJcsSha256, checkCanonicalRequestPublication, type CanonicalRequestPublication } from './objective-canonical-request.js';
import { checkCanonicalRegenerationRequestPublication, type CanonicalRegenerationRequestPublication } from './objective-canonical-regeneration-request.js';
import type { DraftJobInput } from './draft-job.types.js';
import type { ObjectiveAdmission } from './objective-generation.types.js';

export interface StoredCanonicalRequest {
  schemaVersion: 1;
  sourceAdmissionSha256: string;
  inputSha256: string;
  publicationSha256: string;
  compiled: ObjectiveAdmission;
  publication: CanonicalRequestPublication | CanonicalRegenerationRequestPublication;
}
const unavailable = (): never => { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); };
/** Initial candidate domain stays unchanged. Versioned private bases contain
 * real opaque JSON such as fractional provenance confidence; their JCS domain
 * permits finite numbers while semantic times/identities remain checked. */
export function canonicalPublicationSha256(publication: StoredCanonicalRequest['publication']): string {
  return 'requestVersion' in publication.request ? privateRequestJcsSha256(publication) : candidateJcsSha256(publication);
}
/** Hash only immutable owner input. Completion changes result/history fields;
 * it must not change the actual original DTO, request, source or marker. */
export function canonicalPublicationInputHash(input: DraftJobInput): string {
  applicationHash(input);
  const e = input.objectiveGeneration;
  if (input.bearer !== null || !e || e.fingerprint !== applicationHash(e.request)) return unavailable();
  return applicationHash({ dto: input.dto, request: e.request, fingerprint: e.fingerprint,
    source: e.receipt.source, canonicalGeneration: input.canonicalGeneration });
}
/** Retained custody reconstruction only. The service supplies independent fresh
 * Core read authority before and after this call. It performs no HTTP/model,
 * renewals, context compilation or current effect-eligibility inference. */
export async function readCanonicalRequestPublication(tx: Prisma.TransactionClient, a: CanonicalGenerationAdmission): Promise<StoredCanonicalRequest | null> {
  const raw = await readGenerationLedger(tx, GENERATION_REQUEST, a.canonical.tenantId, a.clerkUserId, a.generationJobId);
  if (!raw) return null;
  applicationHash(raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !==
      'compiled,inputSha256,publication,publicationSha256,schemaVersion,sourceAdmissionSha256') return unavailable();
  const s = raw as StoredCanonicalRequest;
  if (s.schemaVersion !== 1 || s.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(a)) return unavailable();
  const job = await tx.spDraftJob.findFirst({ where: { tenantId: a.canonical.tenantId, id: a.generationJobId, ownerUserId: a.clerkUserId } });
  const input = job?.input as unknown as DraftJobInput | undefined;
  const e = input?.objectiveGeneration;
  if (!job || job.clientId !== a.canonical.clientId || !input || !e ||
      canonicalPublicationInputHash(input) !== s.inputSha256 ||
      applicationHash(input.canonicalGeneration) !== applicationHash(generationMarker(a)) ||
      e.request.requestId !== a.generationRequestId || e.receipt.source.clientId !== a.canonical.clientId ||
      e.receipt.source.objectiveId !== a.canonical.objectiveId || e.receipt.source.objectiveVersion !== a.canonical.requestedObjectiveVersion ||
      e.receipt.source.objectiveRevisionId !== a.canonical.requestedObjectiveRevisionId ||
      s.compiled.tenantId !== a.canonical.tenantId || s.compiled.clerkUserId !== a.clerkUserId ||
      s.compiled.requestId !== a.generationRequestId || s.compiled.type !== input.dto.type ||
      applicationHash(s.compiled.source) !== applicationHash(e.receipt.source) ||
      s.compiled.context.state !== 'complete' || s.compiled.context.issues.length !== 0 || s.compiled.context.reobservedAt !== null ||
      applicationHash({ ...e.receipt.context, reobservedAt: null }) !== applicationHash(s.compiled.context)) return unavailable();
  const publication = a.expectedStrategyVersionId === null
    ? checkCanonicalRequestPublication(s.publication, { admission: a, dto: input.dto })
    : checkCanonicalRegenerationRequestPublication(s.publication, { admission: a, dto: input.dto });
  const revisions = await tx.$queryRaw<Array<{ snapshot: unknown }>>`
    SELECT snapshot FROM client_objective_revisions WHERE tenant_id=${a.canonical.tenantId}::uuid
      AND client_id=${a.canonical.clientId}::uuid AND objective_id=${a.canonical.objectiveId}::uuid
      AND id=${a.canonical.requestedObjectiveRevisionId}::uuid AND version=${a.canonical.requestedObjectiveVersion}`;
  const snapshot = revisions[0]?.snapshot as Record<string, unknown> | undefined;
  if (revisions.length !== 1 || !snapshot || applicationHash(snapshot) !== a.canonical.snapshotHash ||
      snapshot.id !== a.canonical.objectiveId || snapshot.clientId !== a.canonical.clientId ||
      snapshot.version !== a.canonical.requestedObjectiveVersion) return unavailable();
  const intent = { outcome: snapshot.outcome, governmentProblem: snapshot.governmentProblem,
    askType: snapshot.askType, minimumWin: snapshot.minimumWin, limits: snapshot.limits };
  if (applicationHash(intent) !== applicationHash(publication.request.source.intent) ||
      applicationHash(s.compiled.intent) !== applicationHash(intent) ||
      applicationHash({ source: s.compiled.source, intent }) !== s.compiled.context.sourceDigest) return unavailable();
  const inputDigest = applicationHash({ sourceDigest: s.compiled.context.sourceDigest,
    coverageDigest: s.compiled.context.coverageDigest, packetId: s.compiled.context.packetId,
    requestId: a.generationRequestId, type: input.dto.type, localDigest: s.compiled.localDigest,
    externalDigest: s.compiled.externalDigest, historyDigest: s.compiled.historyDigest,
    promptDigest: applicationHash(publication.executionContext.prompt) });
  if (publication.request.context.packetId !== s.compiled.context.packetId ||
      publication.request.context.coverageSha256 !== s.compiled.context.coverageDigest ||
      publication.request.context.asOfMs !== Date.parse(s.compiled.context.compiledAt!) ||
      s.compiled.context.inputDigest !== inputDigest ||
      s.publicationSha256 !== canonicalPublicationSha256(publication) ||
      canonicalPublicationSha256(publication) !== canonicalPublicationSha256(s.publication)) return unavailable();
  return { ...s, publication };
}
