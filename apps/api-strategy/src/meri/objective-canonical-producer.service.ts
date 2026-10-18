import { HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ObjectiveCanonicalWorkloadAuthority, type CanonicalGenerationGrant,
  type CanonicalGenerationSubject, type CanonicalAuthoritySubject } from '../planner/objective-canonical-authority.js';
import { applicationHash, applicationUuid, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { requireCanonicalApplicationFence, requireCanonicalApplicationRead } from '../planner/objective-canonical-fence.js';
import { GENERATION_ADMISSION, GENERATION_ACCEPTANCE, GENERATION_PRODUCER, canonicalGenerationAdmissionSha256,
  parseCanonicalGenerationAdmission, requireGenerationAcceptanceForAdmission, type CanonicalGenerationAdmission } from './objective-canonical-generation.js';
import { admitCanonicalGenerationWithinTx, requireCanonicalGenerationEffectWithinTx, requireCanonicalGenerationReadWithinTx } from './objective-canonical-generation-fence.js';
import { generationMarker, insertGenerationLedger, readGenerationLedger, readCanonicalGenerationProducer } from './objective-canonical-producer-ledger.js';
import { parseCanonicalProducerRequest, producerApplication, requireCanonicalProducerWork } from './objective-canonical-producer.js';
import type { DraftJobInput } from './draft-job.types.js';
import { readCanonicalRequestPublication } from './objective-canonical-request-ledger.js';
import { candidateJcsSha256 } from './objective-canonical-request.js';
import { readCanonicalSavedGeneration } from './objective-canonical-saved-generation.js';

type Tx = Prisma.TransactionClient;
const fail = (code: CanonicalApplicationError['code'] = 'AUTHORITY_UNAVAILABLE'): never => { throw new CanonicalApplicationError(code); };
@Injectable()
export class ObjectiveCanonicalProducerService {
  constructor(private readonly prisma: PrismaService, private readonly authority: ObjectiveCanonicalWorkloadAuthority) {}
  private async now(tx: Tx) {
    const rows = await tx.$queryRaw<Array<{ ms: string }>>`SELECT ceil(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const n = Number(rows[0]?.ms);
    if (rows.length !== 1 || !Number.isSafeInteger(n) || n < 0) return fail();
    return n;
  }
  private async generationProof(tx: Tx, grant: CanonicalGenerationGrant, subject: CanonicalGenerationSubject,
    a?: CanonicalGenerationAdmission) {
    await this.authority.assertGenerationCurrent(tx, grant, subject);
    const n = await this.now(tx);
    if (grant.requestSha256 !== subject.requestSha256 || !Number.isSafeInteger(grant.checkedAtMs) || grant.checkedAtMs > n ||
        [grant.expiresAtMs,grant.delegationExpiresAtMs,grant.claimExpiresAtMs].some(x => !Number.isSafeInteger(x) || x <= n) ||
        a && (a.actorUserId !== grant.actorUserId || a.clerkUserId !== grant.clerkUserId ||
          a.canonical.tenantId !== grant.tenantId || a.consentId !== grant.consentId || a.controlVersion !== grant.controlVersion)) return fail();
  }
  private async job(tx: Tx, grant: { tenantId: string; clerkUserId: string }, id: string) {
    await tx.$queryRaw`SELECT id FROM sp_draft_job WHERE tenant_id=${grant.tenantId}::uuid AND id=${id}::uuid FOR UPDATE`;
    const job = await tx.spDraftJob.findFirst({ where: { tenantId: grant.tenantId, id, ownerUserId: grant.clerkUserId } });
    if (!job || !(job.input as unknown as DraftJobInput).objectiveGeneration) return fail('NOT_AVAILABLE');
    return job;
  }
  private jobRequest(raw: unknown) {
    applicationHash(raw);
    const b = raw as { schemaVersion: number; generationJobId: string };
    if (!b || Object.keys(b).sort().join(',') !== 'generationJobId,schemaVersion' || b.schemaVersion !== 1) return fail('INPUT_INVALID');
    return { schemaVersion: 1 as const, generationJobId: applicationUuid(b.generationJobId) };
  }
  /** Capture a QUEUED, never previously claimed actual Objective job before
   * Meri acceptance. No body-supplied actor, canonical target or consent. */
  async capture(http: Request, raw: unknown) {
    return this.safe(async () => {
      const body = this.jobRequest(raw), subject: CanonicalGenerationSubject = {
        phase: 'admit', generationJobId: body.generationJobId, requestSha256: applicationHash(body) };
      const grant = await this.authority.verifyGeneration(http, subject);
      return this.prisma.withTenant(grant.tenantId, async tx => {
        const job = await this.job(tx, grant, body.generationJobId), input = job.input as unknown as DraftJobInput;
        await this.generationProof(tx, grant, subject);
        const req = input.objectiveGeneration!.request;
        const fresh = await admitCanonicalGenerationWithinTx(tx, { tenantId: grant.tenantId, clerkUserId: grant.clerkUserId,
          clientId: job.clientId, objectiveId: req.objective.objectiveId, generationJobId: job.id, generationRequestId: req.requestId });
        if (fresh.expectedStrategyVersionId) {
          // Existence of the reserved ID is not provenance. Find and rebuild a
          // genuine earlier producer for this SAME canonical Strategy first.
          const prior = await tx.spPlannerResource.findMany({ where: { tenantId: grant.tenantId,
            kind: GENERATION_PRODUCER, archived: false,
            data: { path: ['sourceAdmission','canonical','canonicalPlanId'], equals: fresh.canonical.canonicalPlanId } }, select: { data: true, ownerId: true } });
          const candidates = prior.filter(p => {
            const a = (p.data as any)?.sourceAdmission;
            return a?.canonical?.canonicalPlanId === fresh.canonical.canonicalPlanId &&
              a.canonical.canonicalStrategyId === fresh.canonical.canonicalStrategyId &&
              a.canonical.bindingVersion < fresh.canonical.bindingVersion;
          });
          if (!candidates.length) return fail('OUTCOME_UNCONFIRMED');
          for (const p of candidates) await readCanonicalSavedGeneration(tx, { tenantId: grant.tenantId,
            clerkUserId: p.ownerId, generationJobId: (p.data as any).sourceAdmission.generationJobId });
        }
        const previous = await readGenerationLedger(tx, GENERATION_ADMISSION, grant.tenantId, grant.clerkUserId, job.id);
        const admission = previous ? parseCanonicalGenerationAdmission(previous) : parseCanonicalGenerationAdmission({ ...fresh,
          effectExpiresAtMs: Math.min(fresh.effectExpiresAtMs, grant.expiresAtMs, grant.delegationExpiresAtMs, grant.claimExpiresAtMs) });
        if (previous && (applicationHash(admission.canonical) !== applicationHash(fresh.canonical) ||
            admission.expectedStrategyVersionId !== fresh.expectedStrategyVersionId || admission.effectExpiresAtMs > fresh.effectExpiresAtMs))
          return fail('REQUEST_CONFLICT');
        await this.generationProof(tx, grant, subject, admission);
        if (!previous) {
          // Clip the source effect deadline to the actual original workload
          // token/claim/delegation; never extend it at acceptance or retry.
          if (admission.effectExpiresAtMs <= await this.now(tx)) return fail();
          await insertGenerationLedger(tx, GENERATION_ADMISSION, grant.tenantId, grant.clerkUserId, job.id, admission);
          const changed = await tx.spDraftJob.updateMany({ where: { id: job.id, tenantId: grant.tenantId,
            ownerUserId: grant.clerkUserId, status: 'queued', attempt: 1, claimedBy: null, claimedAt: null },
            data: { input: { ...input, canonicalGeneration: generationMarker(admission) } as unknown as Prisma.InputJsonValue } });
          if (changed.count !== 1) return fail('OUTCOME_UNCONFIRMED');
        } else if (applicationHash(input.canonicalGeneration) !== applicationHash(generationMarker(admission))) return fail('OUTCOME_UNCONFIRMED');
        await this.generationProof(tx, grant, subject, admission);
        return { schemaVersion: 1, sourceAdmission: admission, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission) };
      }, { timeoutMs: 15_000 });
    });
  }
  /** Actual issuer owner readback happens outside this tx in the verifier.
   * The body contains only job identity; it cannot select a run to pair. */
  async accept(http: Request, raw: unknown) {
    return this.safe(async () => {
      const body = this.jobRequest(raw), subject: CanonicalGenerationSubject = {
        phase: 'accept', generationJobId: body.generationJobId, requestSha256: applicationHash(body) };
      const proof = await this.authority.verifyGenerationAcceptance(http, subject), grant = proof.grant;
      return this.prisma.withTenant(grant.tenantId, async tx => {
        const job = await this.job(tx, grant, body.generationJobId);
        const rawAdmission = await readGenerationLedger(tx, GENERATION_ADMISSION, grant.tenantId, grant.clerkUserId, job.id);
        if (!rawAdmission) return fail('OUTCOME_UNCONFIRMED');
        const admission = parseCanonicalGenerationAdmission(rawAdmission);
        await this.generationProof(tx, grant, subject, admission);
        if (applicationHash(proof.sourceAdmission) !== applicationHash(admission) ||
            proof.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(admission)) return fail('REQUEST_CONFLICT');
        const published = await readCanonicalRequestPublication(tx, admission);
        if (!published) return fail('OUTCOME_UNCONFIRMED');
        if (proof.typedRequestSha256 !== published.publication.requestSha256 ||
            proof.executionContextSha256 !== candidateJcsSha256(published.publication.executionContext) ||
            proof.acceptedRequestId !== admission.generationRequestId ||
            proof.acceptedPromptSha256 !== published.publication.executionContext.promptSha256 ||
            proof.issuance.expiresAtMs > published.publication.request.originalExpiresAtMs)
          return fail('REQUEST_CONFLICT');
        const old = await readGenerationLedger(tx, GENERATION_ACCEPTANCE, grant.tenantId, grant.clerkUserId, job.id);
        const observed = { schemaVersion: 1, sourceAdmissionSha256: proof.sourceAdmissionSha256,
          sourceBinding: proof.sourceBinding, sourceRequestSha256: proof.sourceRequestSha256,
          issuance: proof.issuance, acceptedAtMs: old ? (old as any).acceptedAtMs : await this.now(tx) };
        const accepted = requireGenerationAcceptanceForAdmission(observed, admission);
        if (accepted.acceptedAtMs >= published.publication.request.originalExpiresAtMs) return fail('SOURCE_STALE');
        if (old && applicationHash(old) !== applicationHash(accepted)) return fail('REQUEST_CONFLICT');
        if (!old) {
          if (job.status !== 'queued' || job.attempt !== 1 || job.claimedBy !== null || job.claimedAt !== null ||
              applicationHash((job.input as unknown as DraftJobInput).canonicalGeneration) !== applicationHash(generationMarker(admission))) return fail('OUTCOME_UNCONFIRMED');
          const req = (job.input as unknown as DraftJobInput).objectiveGeneration!.request;
          const current = await admitCanonicalGenerationWithinTx(tx, { tenantId: grant.tenantId, clerkUserId: grant.clerkUserId,
            clientId: job.clientId, objectiveId: req.objective.objectiveId, generationJobId: job.id, generationRequestId: req.requestId });
          if (current.actorUserId !== admission.actorUserId || current.consentId !== admission.consentId ||
              current.controlVersion !== admission.controlVersion || applicationHash(current.canonical) !== applicationHash(admission.canonical) ||
              current.expectedStrategyVersionId !== admission.expectedStrategyVersionId || current.effectExpiresAtMs < admission.effectExpiresAtMs)
            return fail('SOURCE_STALE');
          await insertGenerationLedger(tx, GENERATION_ACCEPTANCE, grant.tenantId, grant.clerkUserId, job.id, accepted);
          const changed = await tx.spDraftJob.updateMany({ where: { id: job.id, tenantId: grant.tenantId, status: 'queued',
            attempt: 1, claimedBy: null }, data: { status: 'running', stage: 'drafting',
            claimedBy: `canonical:${accepted.issuance.issuanceKey}`, claimedAt: new Date(accepted.acceptedAtMs), attempt: 2 } });
          if (changed.count !== 1) return fail('OUTCOME_UNCONFIRMED');
        }
        if (job.status !== 'completed') await requireCanonicalGenerationEffectWithinTx(tx, admission, {
          generationJobId: job.id, generationRequestId: admission.generationRequestId });
        await this.generationProof(tx, grant, subject, admission);
        if (await this.now(tx) >= Math.min(admission.effectExpiresAtMs, accepted.issuance.expiresAtMs)) return fail();
        return { schemaVersion: 1, sourceAdmissionSha256: proof.sourceAdmissionSha256,
          sourceBinding: accepted.sourceBinding, sourceRequestSha256: accepted.sourceRequestSha256,
          issuance: accepted.issuance };
      }, { timeoutMs: 15_000 });
    });
  }
  async readAdmission(http: Request, rawJobId: string) {
    return this.safe(async () => {
      const body = { schemaVersion: 1 as const, generationJobId: applicationUuid(rawJobId) };
      // GET has no body. Its verifier binds this fixed path-identity object,
      // explicitly distinct from both producer POST and application POST.
      const subject: CanonicalGenerationSubject = { phase: 'admission-read',
        generationJobId: body.generationJobId, requestSha256: applicationHash(body) };
      const grant = await this.authority.verifyGeneration(http, subject);
      return this.prisma.withTenant(grant.tenantId, async tx => {
        await this.job(tx, grant, body.generationJobId);
        const rawAdmission = await readGenerationLedger(tx, GENERATION_ADMISSION, grant.tenantId, grant.clerkUserId, body.generationJobId);
        if (!rawAdmission) return fail('OUTCOME_UNCONFIRMED');
        const admission = parseCanonicalGenerationAdmission(rawAdmission);
        await this.generationProof(tx, grant, subject, admission);
        await requireCanonicalGenerationReadWithinTx(tx, admission, grant.clerkUserId);
        const rawAccepted = await readGenerationLedger(tx, GENERATION_ACCEPTANCE, grant.tenantId, grant.clerkUserId, body.generationJobId);
        const acceptance = rawAccepted ? requireGenerationAcceptanceForAdmission(rawAccepted, admission) : null;
        await this.generationProof(tx, grant, subject, admission);
        await requireCanonicalGenerationReadWithinTx(tx, admission, grant.clerkUserId);
        return { schemaVersion: 1, sourceAdmission: admission, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
          acceptance: acceptance ? { availability: 'available' as const, value: acceptance } :
            { availability: 'unavailable' as const, value: null } };
      }, { timeoutMs: 15_000 });
    });
  }
  async admit(http: Request, raw: unknown) {
    return this.safe(async () => {
      const request = parseCanonicalProducerRequest(raw), work = request.work;
      const effect = request.phase === 'start' || request.phase === 'prepare';
      const subject: CanonicalAuthoritySubject = { purpose: effect ? 'effect' : 'retained-result-read',
        producerPhase: request.phase, applicationRequestId: work.applicationRequestId, requestSha256: applicationHash(request) };
      const grant = await this.authority.verify(http, subject);
      if (grant.requestSha256 !== subject.requestSha256 || grant.actorUserId !== work.actorUserId ||
          grant.tenantId !== work.canonical.tenantId || grant.canonicalSha256 !== applicationHash(work.canonical) ||
          grant.consentId !== work.consentId || grant.controlVersion !== work.controlVersion) return fail('REQUEST_CONFLICT');
      return this.prisma.withTenant(grant.tenantId, async tx => {
        await this.job(tx, grant, work.generationJobId);
        await tx.$queryRaw`SELECT id FROM sp_strategy WHERE tenant_id=${grant.tenantId}::uuid AND id=${work.strategyId}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM sp_version WHERE tenant_id=${grant.tenantId}::uuid AND id=${work.strategyVersionId}::uuid FOR SHARE`;
        // A new dispatch needs the actual retained-result completion witness.
        // Historical read/stop keeps its existing separate read admission:
        // old effect evidence is not reminted and no new write is authorized.
        const stored = effect
          ? (await readCanonicalSavedGeneration(tx, { tenantId: grant.tenantId,
            clerkUserId: grant.clerkUserId, generationJobId: work.generationJobId })).producer
          : await readCanonicalGenerationProducer(tx, grant.tenantId, grant.clerkUserId, work.generationJobId);
        requireCanonicalProducerWork(stored, work);
        const current = async () => {
          await this.authority.assertCurrent(tx, grant, subject);
          await requireCanonicalGenerationReadWithinTx(tx, stored.sourceAdmission, grant.clerkUserId);
          if (effect) await requireCanonicalApplicationFence(tx, grant, producerApplication(work), subject.requestSha256!);
          else await requireCanonicalApplicationRead(tx, grant, work.canonical);
        };
        await current();
        let expiresAtMs = Math.min(grant.tokenExpiresAtMs, grant.delegationExpiresAtMs, grant.claimExpiresAtMs);
        if (effect) {
          const cs = await tx.$queryRaw<Array<{ expires: string }>>`SELECT floor(extract(epoch FROM expires_at)*1000)::text AS expires
            FROM client_objective_work_consents WHERE tenant_id=${grant.tenantId}::uuid AND id=${grant.consentId}::uuid
              AND work_action='objective.plan.prepare'`;
          if (cs.length !== 1) return fail();
          expiresAtMs = Math.min(expiresAtMs, Number(cs[0]!.expires), stored.sourceAdmission.effectExpiresAtMs,
            stored.acceptance.issuance.expiresAtMs);
        }
        await current();
        const checkedAtMs = await this.now(tx);
        if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= checkedAtMs) return fail();
        return { workSha256: applicationHash(work), sourceBinding: stored.acceptance.sourceBinding,
          sourceRequestSha256: stored.acceptance.sourceRequestSha256, generationStatus: 'completed' as const,
          objectiveReceipt: stored.objectiveReceipt, checkedAtMs, expiresAtMs };
      }, { timeoutMs: 15_000 });
    });
  }
  private async safe<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      const code = error instanceof CanonicalApplicationError ? error.code : 'OUTCOME_UNCONFIRMED';
      const status = { INPUT_INVALID: 400, NOT_AVAILABLE: 404, REQUEST_CONFLICT: 409,
        SOURCE_STALE: 409, AUTHORITY_UNAVAILABLE: 503, OUTCOME_UNCONFIRMED: 503 }[code];
      throw new HttpException({ schemaVersion: 1, code, message: 'Objective generation evidence is unavailable.', outcome: 'unconfirmed' }, status);
    }
  }
}
