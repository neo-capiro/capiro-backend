import { HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ObjectiveCanonicalWorkloadAuthority, type CanonicalGenerationGrant, type CanonicalGenerationSubject } from '../planner/objective-canonical-authority.js';
import { applicationHash, applicationUuid, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { GENERATION_ADMISSION, GENERATION_REQUEST, canonicalGenerationAdmissionSha256,
  parseCanonicalGenerationAdmission, type CanonicalGenerationAdmission } from './objective-canonical-generation.js';
import { readGenerationLedger, insertGenerationLedger } from './objective-canonical-producer-ledger.js';
import { deriveCanonicalPublicationInput } from './objective-canonical-job-input.js';
import { admitCanonicalGenerationWithinTx, requireCanonicalGenerationReadWithinTx } from './objective-canonical-generation-fence.js';
import { createCanonicalRequestPublication } from './objective-canonical-request.js';
import { createCanonicalRegenerationRequestPublication } from './objective-canonical-regeneration-request.js';
import { readCanonicalRequestPublication, canonicalPublicationInputHash, canonicalPublicationSha256, type StoredCanonicalRequest } from './objective-canonical-request-ledger.js';
import { captureCanonicalStrategyBasis } from './objective-canonical-basis.js';
import { ObjectiveCanonicalOwnerDirectory } from './objective-canonical-owner-directory.js';
import { StrategyContextPlaneClient } from './strategy-context-plane.client.js';
import type { ObjectiveAdmission } from './objective-generation.types.js';
import type { DraftJobInput } from './draft-job.types.js';

type Tx = Prisma.TransactionClient;
const fail = (code: CanonicalApplicationError['code'] = 'AUTHORITY_UNAVAILABLE'): never => { throw new CanonicalApplicationError(code); };
/** Actual server-owned initial typed-request publisher. It executes no model
 * and opens no transaction around network/context compilation. Genuine named
 * workload/delegation verification is the existing unavailable-by-default owner.
 * The shared-secret Context Plane is a data reader, not that workload verifier.
 */
@Injectable()
export class ObjectiveCanonicalRequestService {
  constructor(private readonly prisma: PrismaService, private readonly authority: ObjectiveCanonicalWorkloadAuthority,
    private readonly contextPlane: StrategyContextPlaneClient, private readonly owners: ObjectiveCanonicalOwnerDirectory) {}
  private identity(raw: unknown) {
    applicationHash(raw);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'generationJobId,schemaVersion' ||
        (raw as any).schemaVersion !== 1) return fail('INPUT_INVALID');
    return { schemaVersion: 1 as const, generationJobId: applicationUuid((raw as any).generationJobId) };
  }
  private async now(tx: Tx) {
    const rows = await tx.$queryRaw<Array<{ ms: string }>>`SELECT ceil(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const value = Number(rows[0]?.ms);
    if (rows.length !== 1 || !Number.isSafeInteger(value) || value < 0) return fail();
    return value;
  }
  private async proof(tx: Tx, grant: CanonicalGenerationGrant, subject: CanonicalGenerationSubject, a: CanonicalGenerationAdmission) {
    await this.authority.assertGenerationCurrent(tx, grant, subject);
    const now = await this.now(tx);
    if (grant.requestSha256 !== subject.requestSha256 || grant.tenantId !== a.canonical.tenantId ||
        grant.actorUserId !== a.actorUserId || grant.clerkUserId !== a.clerkUserId ||
        grant.consentId !== a.consentId || grant.controlVersion !== a.controlVersion ||
        !Number.isSafeInteger(grant.checkedAtMs) || grant.checkedAtMs > now ||
        [grant.expiresAtMs, grant.delegationExpiresAtMs, grant.claimExpiresAtMs].some(t => !Number.isSafeInteger(t) || t <= now)) return fail();
    if (subject.phase === 'publish' && grant.delegation &&
        (!Number.isSafeInteger(grant.delegation.issuedAtMs) || grant.delegation.issuedAtMs > grant.checkedAtMs)) return fail();
  }
  private async admission(tx: Tx, grant: CanonicalGenerationGrant, jobId: string) {
    const value = await readGenerationLedger(tx, GENERATION_ADMISSION, grant.tenantId, grant.clerkUserId, jobId);
    if (!value) return fail('OUTCOME_UNCONFIRMED');
    const a = parseCanonicalGenerationAdmission(value);
    if (a.generationJobId !== jobId || a.canonical.tenantId !== grant.tenantId || a.clerkUserId !== grant.clerkUserId)
      return fail('OUTCOME_UNCONFIRMED');
    return a;
  }
  private async job(tx: Tx, grant: CanonicalGenerationGrant, id: string, lock: boolean) {
    if (lock) await tx.$queryRaw`SELECT id FROM sp_draft_job WHERE tenant_id=${grant.tenantId}::uuid AND id=${id}::uuid FOR UPDATE`;
    const job = await tx.spDraftJob.findFirst({ where: { tenantId: grant.tenantId, id, ownerUserId: grant.clerkUserId } });
    if (!job) return fail('NOT_AVAILABLE');
    return job;
  }
  private async retained(tx: Tx, grant: CanonicalGenerationGrant, subject: CanonicalGenerationSubject, a: CanonicalGenerationAdmission) {
    await this.proof(tx, grant, subject, a);
    await requireCanonicalGenerationReadWithinTx(tx, a, grant.clerkUserId);
    const stored = await readCanonicalRequestPublication(tx, a);
    if (!stored) return null;
    await requireCanonicalGenerationReadWithinTx(tx, a, grant.clerkUserId);
    await this.proof(tx, grant, subject, a);
    return stored.publication;
  }
  private async effect(tx: Tx, grant: CanonicalGenerationGrant, subject: CanonicalGenerationSubject, a: CanonicalGenerationAdmission) {
    await this.proof(tx, grant, subject, a);
    const fresh = await admitCanonicalGenerationWithinTx(tx, { tenantId: a.canonical.tenantId, clerkUserId: a.clerkUserId,
      clientId: a.canonical.clientId, objectiveId: a.canonical.objectiveId, generationJobId: a.generationJobId,
      generationRequestId: a.generationRequestId });
    if (applicationHash(fresh.canonical) !== applicationHash(a.canonical) || fresh.actorUserId !== a.actorUserId ||
        fresh.consentId !== a.consentId || fresh.controlVersion !== a.controlVersion ||
        fresh.expectedStrategyVersionId !== a.expectedStrategyVersionId || fresh.effectExpiresAtMs < a.effectExpiresAtMs ||
        await this.now(tx) >= a.effectExpiresAtMs) return fail('SOURCE_STALE');
  }
  /** Fixed POST, job identity only. An exact committed publication is returned
   * before any new compilation. Competing calls return the one lock winner;
   * context compilation itself is not a model run or a provider operation. */
  async publish(http: Request, raw: unknown) {
    return this.safe(async () => {
      const body = this.identity(raw), subject: CanonicalGenerationSubject = { phase: 'publish',
        generationJobId: body.generationJobId, requestSha256: applicationHash(body) };
      const grant = await this.authority.verifyGeneration(http, subject);
      const initial = await this.prisma.withTenantUser(grant.tenantId, grant.clerkUserId, async tx => {
        const job = await this.job(tx, grant, body.generationJobId, true), a = await this.admission(tx, grant, job.id);
        const previous = await this.retained(tx, grant, subject, a);
        if (previous) return { kind: 'retained' as const, publication: previous };
        await this.effect(tx, grant, subject, a);
        const input = deriveCanonicalPublicationInput(job, a);
        const basis = await captureCanonicalStrategyBasis(tx, a);
        if (!grant.delegation) return fail();
        return { kind: 'new' as const, a, input, basis };
      }, { timeoutMs: 15_000 });
      if (initial.kind === 'retained') return initial.publication;
      const { a, input, basis } = initial;
      let compiled: ObjectiveAdmission | undefined, typedContext: unknown;
      const contextRequest = { tenantId: grant.tenantId, clerkUserId: grant.clerkUserId, clientId: a.canonical.clientId,
        mode: 'draft' as const, objective: input.envelope.request.objective, generationRequestId: a.generationRequestId,
        generationType: input.dto.type, query: [input.dto.goal, input.dto.meriContext].filter(Boolean).join('\n'),
        traceId: a.generationRequestId };
      const governed = await this.contextPlane.compile(contextRequest, async value => {
        if (compiled) return fail('OUTCOME_UNCONFIRMED'); compiled = value;
      }, async value => { if (typedContext !== undefined) return fail('OUTCOME_UNCONFIRMED'); typedContext = value; });
      if (!compiled || typedContext === undefined) return fail('OUTCOME_UNCONFIRMED');
      const observed = compiled;
      // Re-observation is outside the final tx. Required mutable Core sources
      // remain separately fenced by the mature final Strategy output hooks.
      await this.contextPlane.recheckObjective(contextRequest, observed);
      return this.prisma.withTenantUser(grant.tenantId, grant.clerkUserId, async tx => {
        const job = await this.job(tx, grant, body.generationJobId, true);
        const actual = await this.admission(tx, grant, job.id);
        if (applicationHash(actual) !== applicationHash(a)) return fail('REQUEST_CONFLICT');
        const previous = await this.retained(tx, grant, subject, a);
        if (previous) return previous;
        await this.effect(tx, grant, subject, a);
        const current = deriveCanonicalPublicationInput(job, a);
        if (current.inputHash !== input.inputHash || applicationHash(observed.source) !== applicationHash(current.envelope.receipt.source))
          return fail('REQUEST_CONFLICT');
        const owners = await this.owners.read(tx, grant.tenantId);
        const currentBasis = await captureCanonicalStrategyBasis(tx, a);
        if (applicationHash(currentBasis) !== applicationHash(basis)) return fail('SOURCE_STALE');
        const requestedAtMs = await this.now(tx);
        const publicationInput = { admission: a, dto: current.dto, context: typedContext,
          prompt: governed.prompt, owners, delegation: grant.delegation, requestedAtMs,
          effectExpiresAtMs: Math.min(a.effectExpiresAtMs, grant.expiresAtMs, grant.delegationExpiresAtMs, grant.claimExpiresAtMs) };
        const publication = basis === null ? createCanonicalRequestPublication(publicationInput)
          : createCanonicalRegenerationRequestPublication({ ...publicationInput, basis });
        const stored: StoredCanonicalRequest = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(a),
          inputSha256: current.inputHash, publicationSha256: canonicalPublicationSha256(publication), compiled: observed, publication };
        const updatedInput: DraftJobInput = { ...(job.input as unknown as DraftJobInput), objectiveGeneration: {
          ...current.envelope, receipt: { ...current.envelope.receipt, context: observed.context },
          localDigest: observed.localDigest, externalDigest: observed.externalDigest, historyDigest: observed.historyDigest,
          historyObservedAt: observed.historyObservedAt, coverage: observed.coverage, contactIds: observed.contactIds } };
        if (canonicalPublicationInputHash(updatedInput) !== stored.inputSha256) return fail('REQUEST_CONFLICT');
        const changed = await tx.spDraftJob.updateMany({ where: { tenantId: grant.tenantId, id: job.id, ownerUserId: grant.clerkUserId,
          status: 'queued', attempt: 1, claimedBy: null, claimedAt: null, strategyId: null },
          data: { input: updatedInput as unknown as Prisma.InputJsonValue } });
        if (changed.count !== 1) return fail('OUTCOME_UNCONFIRMED');
        await insertGenerationLedger(tx, GENERATION_REQUEST, grant.tenantId, grant.clerkUserId, job.id, stored);
        await this.effect(tx, grant, subject, a);
        if (await this.now(tx) >= publication.request.originalExpiresAtMs) return fail();
        const checked = await readCanonicalRequestPublication(tx, a);
        if (!checked || checked.publicationSha256 !== stored.publicationSha256) return fail('OUTCOME_UNCONFIRMED');
        await this.effect(tx, grant, subject, a);
        if (await this.now(tx) >= publication.request.originalExpiresAtMs) return fail();
        return checked.publication;
      }, { timeoutMs: 15_000 });
    });
  }
  /** Read-only GET. Missing publication is 503/unconfirmed, never absence or
   * permission to accept another request, issue a new grant or start a query. */
  async lookup(http: Request, rawJobId: string) {
    return this.safe(async () => {
      const body = { schemaVersion: 1 as const, generationJobId: applicationUuid(rawJobId) };
      const subject: CanonicalGenerationSubject = { phase: 'request-read', generationJobId: body.generationJobId,
        requestSha256: applicationHash(body) };
      const grant = await this.authority.verifyGeneration(http, subject);
      return this.prisma.withTenantUser(grant.tenantId, grant.clerkUserId, async tx => {
        await this.job(tx, grant, body.generationJobId, false);
        const a = await this.admission(tx, grant, body.generationJobId);
        const result = await this.retained(tx, grant, subject, a);
        if (!result) return fail('OUTCOME_UNCONFIRMED');
        return result;
      }, { timeoutMs: 15_000 });
    });
  }
  private async safe<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      const code = error instanceof CanonicalApplicationError ? error.code : 'OUTCOME_UNCONFIRMED';
      const status = { INPUT_INVALID: 400, NOT_AVAILABLE: 404, REQUEST_CONFLICT: 409, SOURCE_STALE: 409,
        AUTHORITY_UNAVAILABLE: 503, OUTCOME_UNCONFIRMED: 503 }[code];
      throw new HttpException({ schemaVersion: 1, code, message: 'Objective typed request is unavailable.', outcome: 'unconfirmed' }, status);
    }
  }
}
