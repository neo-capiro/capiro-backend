import { HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { applicationHash, applicationUuid, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { ObjectiveCanonicalWorkloadAuthority, type CanonicalGenerationGrant,
  type CanonicalGenerationSubject } from '../planner/objective-canonical-authority.js';
import { MeriService } from './meri.service.js';
import { ObjectiveCanonicalResultOwner } from './objective-canonical-result-owner.js';
import { ObjectiveCanonicalOwnerDirectory } from './objective-canonical-owner-directory.js';
import { StrategyContextPlaneClient } from './strategy-context-plane.client.js';
import { objectivePersistence } from './objective-generation-completion.js';
import { normalizeCanonicalDraft, normalizeCanonicalRegenerationDraft } from './objective-canonical-draft.js';
import { verifyRetainedCanonicalCompletion } from './objective-canonical-completion-receipt.js';
import { verifyRetainedCanonicalRegenerationCompletion } from './objective-canonical-regeneration-completion-receipt.js';
import { generationAssociation } from './objective-canonical-producer-ledger.js';
import { canonicalGenerationAdmissionSha256 } from './objective-canonical-generation.js';
import { readCanonicalSavedGeneration, requireCanonicalBasisCustody } from './objective-canonical-saved-generation.js';
import { readCanonicalRequestPublication } from './objective-canonical-request-ledger.js';
import { CORE_CANONICAL_REGENERATION_REQUEST_VERSION } from './objective-canonical-regeneration-request.js';
import { deriveCanonicalJobInput } from './objective-canonical-job-input.js';
import { requireCanonicalGenerationEffectWithinTx, requireCanonicalGenerationReadWithinTx } from './objective-canonical-generation-fence.js';
import type { DraftJobInput, DraftJobRuntime } from './draft-job.types.js';

type Tx = Prisma.TransactionClient;
const fail = (code: CanonicalApplicationError['code'] = 'OUTCOME_UNCONFIRMED'): never => { throw new CanonicalApplicationError(code); };

/** The actual Core application composition: retained SDK custody -> original
 * typed request -> existing normalizer -> existing atomic Strategy writer.
 * No model query, fresh job, issue/resolve call or separate completion write. */
@Injectable()
export class ObjectiveCanonicalCompletionService {
  constructor(private readonly prisma: PrismaService, private readonly authority: ObjectiveCanonicalWorkloadAuthority,
    private readonly results: ObjectiveCanonicalResultOwner, private readonly meri: MeriService,
    private readonly contextPlane: StrategyContextPlaneClient, private readonly owners: ObjectiveCanonicalOwnerDirectory) {}

  private async retained(source: Parameters<ObjectiveCanonicalResultOwner['read']>[0]) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.results.read(source, { signal: controller.signal }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'));
        }, 3000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }

  private body(raw: unknown) {
    applicationHash(raw);
    const b = raw as { schemaVersion: number; generationJobId: string };
    if (!b || Object.keys(b).sort().join(',') !== 'generationJobId,schemaVersion' || b.schemaVersion !== 1) return fail('INPUT_INVALID');
    return { schemaVersion: 1 as const, generationJobId: applicationUuid(b.generationJobId) };
  }
  private async clock(tx: Tx) {
    const rows = await tx.$queryRaw<Array<{ ms: string }>>`SELECT ceil(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
    const n = Number(rows[0]?.ms);
    if (rows.length !== 1 || !Number.isSafeInteger(n) || n < 0) return fail('AUTHORITY_UNAVAILABLE');
    return n;
  }
  private async proof(tx: Tx, grant: CanonicalGenerationGrant, subject: CanonicalGenerationSubject,
    effect: boolean, readExpiresAtMs?: number) {
    await this.authority.assertGenerationCurrent(tx, grant, subject);
    const now = await this.clock(tx);
    if (grant.requestSha256 !== subject.requestSha256 || !Number.isSafeInteger(grant.checkedAtMs) || grant.checkedAtMs > now ||
        [grant.expiresAtMs, grant.delegationExpiresAtMs, grant.claimExpiresAtMs, ...(readExpiresAtMs === undefined ? [] : [readExpiresAtMs])]
          .some(n => !Number.isSafeInteger(n) || n <= now)) return fail('AUTHORITY_UNAVAILABLE');
    // `effect` is explicit at each callsite; historical lookup never revives
    // an original issuance/consent or uses absence as eligibility.
    if (effect && subject.phase !== 'complete') return fail('AUTHORITY_UNAVAILABLE');
    return now;
  }
  private async inspect(tx: Tx, grant: CanonicalGenerationGrant, subject: CanonicalGenerationSubject, lock: boolean) {
    if (lock) await tx.$queryRaw`SELECT id FROM sp_draft_job WHERE tenant_id=${grant.tenantId}::uuid
      AND id=${subject.generationJobId}::uuid FOR UPDATE`;
    const job = await tx.spDraftJob.findFirst({ where: { tenantId: grant.tenantId, id: subject.generationJobId, ownerUserId: grant.clerkUserId } });
    if (!job) return fail('NOT_AVAILABLE');
    await this.proof(tx, grant, subject, false);
    const association = await generationAssociation(tx, grant.tenantId, grant.clerkUserId, job.id), a = association.admission;
    if (a.actorUserId !== grant.actorUserId || a.consentId !== grant.consentId || a.controlVersion !== grant.controlVersion ||
        a.canonical.tenantId !== grant.tenantId || a.clerkUserId !== grant.clerkUserId) return fail('REQUEST_CONFLICT');
    await requireCanonicalGenerationReadWithinTx(tx, a, grant.clerkUserId);
    const stored = await readCanonicalRequestPublication(tx, a);
    if (!stored) return fail();
    const request = stored.publication.request;
    if (a.expectedStrategyVersionId === null) {
      if ('requestVersion' in request || request.basis !== null) return fail('AUTHORITY_UNAVAILABLE');
    } else if (!('requestVersion' in request) || request.requestVersion !== CORE_CANONICAL_REGENERATION_REQUEST_VERSION ||
        request.applicationTarget.expectedStrategyVersionId !== a.expectedStrategyVersionId ||
        request.basisSha256 !== applicationHash(request.basis)) return fail('AUTHORITY_UNAVAILABLE');
    const input = job.input as unknown as DraftJobInput;
    if (!input.objectiveGeneration) return fail();
    const publication = stored.publication;
    return { job, input, association, admission: a, stored, publication };
  }
  private async receipt(tx: Tx, grant: CanonicalGenerationGrant, subject: CanonicalGenerationSubject,
    state: Awaited<ReturnType<ObjectiveCanonicalCompletionService['inspect']>>) {
    if (state.job.status !== 'completed') return null;
    const { admission: a } = state;
    const saved = await readCanonicalSavedGeneration(tx, { tenantId: grant.tenantId,
      clerkUserId: grant.clerkUserId, generationJobId: state.job.id });
    if (applicationHash(saved.admission) !== applicationHash(a) ||
        applicationHash(saved.acceptance) !== applicationHash(state.association.acceptance) ||
        applicationHash(saved.publication) !== applicationHash(state.publication)) return fail('REQUEST_CONFLICT');
    await requireCanonicalGenerationReadWithinTx(tx, a, grant.clerkUserId);
    await this.proof(tx, grant, subject, false);
    return saved.receipt;
  }
  async lookup(http: Request, rawId: string) {
    return this.safe(async () => {
      const body = this.body({ schemaVersion: 1, generationJobId: rawId });
      const subject: CanonicalGenerationSubject = { phase: 'completion-read', generationJobId: body.generationJobId, requestSha256: applicationHash(body) };
      const grant = await this.authority.verifyGeneration(http, subject);
      return this.prisma.withTenant(grant.tenantId, async tx => {
        const state = await this.inspect(tx, grant, subject, false);
        return await this.receipt(tx, grant, subject, state) ?? fail();
      }, { timeoutMs: 15_000 });
    });
  }
  async complete(http: Request, raw: unknown) {
    return this.safe(async () => {
      const body = this.body(raw), subject: CanonicalGenerationSubject = {
        phase: 'complete', generationJobId: body.generationJobId, requestSha256: applicationHash(body) };
      const grant = await this.authority.verifyGeneration(http, subject);
      const first = await this.prisma.withTenant(grant.tenantId, async tx => {
        const state = await this.inspect(tx, grant, subject, true);
        const receipt = await this.receipt(tx, grant, subject, state);
        if (receipt) return { receipt, state };
        if (state.input.canonicalCompletion !== undefined || state.input.canonicalTerminal !== undefined) return fail();
        deriveCanonicalJobInput(state.job, state.admission, state.input.objectiveGeneration,
          `canonical:${state.association.acceptance.issuance.issuanceKey}`);
        await requireCanonicalGenerationEffectWithinTx(tx, state.admission, {
          generationJobId: body.generationJobId, generationRequestId: state.admission.generationRequestId });
        await this.proof(tx, grant, subject, true,
          Math.min(state.admission.effectExpiresAtMs, state.association.acceptance.issuance.expiresAtMs));
        return { receipt: null, state };
      }, { timeoutMs: 15_000 });
      if (first.receipt) return first.receipt;
      // IO to the genuine retained journal/object owner is OUTSIDE all DB txs.
      const rawResult = await this.retained({ generationJobId: body.generationJobId,
        binding: first.state.association.acceptance.sourceBinding,
        sourceAdmissionSha256: canonicalGenerationAdmissionSha256(first.state.admission) });
      const prepared = await this.prisma.withTenant(grant.tenantId, async tx => {
        const state = await this.inspect(tx, grant, subject, true);
        const receipt = await this.receipt(tx, grant, subject, state);
        if (receipt) return { receipt, state, verified: null, normalized: null, ownerBindings: [], now: 0 };
        if (state.stored.publicationSha256 !== first.state.stored.publicationSha256 ||
            applicationHash(state.association) !== applicationHash(first.state.association) ||
            state.input.canonicalCompletion !== undefined || state.input.canonicalTerminal !== undefined) return fail('REQUEST_CONFLICT');
        deriveCanonicalJobInput(state.job, state.admission, state.input.objectiveGeneration,
          `canonical:${state.association.acceptance.issuance.issuanceKey}`);
        const now = await this.proof(tx, grant, subject, true,
          Math.min(state.admission.effectExpiresAtMs, state.association.acceptance.issuance.expiresAtMs));
        await requireCanonicalGenerationEffectWithinTx(tx, state.admission, {
          generationJobId: body.generationJobId, generationRequestId: state.admission.generationRequestId });
        const regeneration = 'requestVersion' in state.publication.request;
        const verified = (regeneration ? verifyRetainedCanonicalRegenerationCompletion : verifyRetainedCanonicalCompletion)(rawResult,
          { admission: state.admission, acceptance: state.association.acceptance, publication: state.publication, nowMs: now });
        const ownerRows = await this.owners.read(tx, grant.tenantId);
        const options = { admission: state.admission, queuedType: state.input.dto.type,
          ownerMap: new Map(ownerRows.map(o => [o.ownerRef, o.clerkUserId])) };
        // The original published basis is immutable input. Never substitute a
        // newer head or infer source-key identity from a title/array position.
        const normalized = 'requestVersion' in state.publication.request
          ? normalizeCanonicalRegenerationDraft(verified.payload, { ...options, basis: state.publication.request.basis })
          : normalizeCanonicalDraft(verified.payload, options);
        if ('requestVersion' in state.publication.request)
          await requireCanonicalBasisCustody(tx, state.publication.request.basis);
        const referencedOwners = new Set([grant.clerkUserId, state.publication.request.principal.ownerActorId,
          ...normalized.response.nodes.map(n => n.ownerUserId)].filter((id): id is string => typeof id === 'string' && id.length > 0));
        const ownerBindings = ownerRows.filter(o => referencedOwners.has(o.clerkUserId));
        if ([...referencedOwners].some(id => !ownerBindings.some(o => o.clerkUserId === id))) return fail('AUTHORITY_UNAVAILABLE');
        await this.proof(tx, grant, subject, true,
          Math.min(verified.expiresAtMs, state.admission.effectExpiresAtMs, state.association.acceptance.issuance.expiresAtMs));
        return { receipt: null, state, verified, normalized, ownerBindings, now };
      }, { timeoutMs: 15_000 });
      if (prepared.receipt) return prepared.receipt;
      if (!prepared.verified || !prepared.normalized) return fail();
      const state = prepared.state, a = state.admission, witness = Object.freeze(prepared.verified.witness);
      const resultExpires = Math.min(prepared.verified.expiresAtMs, a.effectExpiresAtMs, state.association.acceptance.issuance.expiresAtMs);
      const envelope = JSON.parse(JSON.stringify(state.input.objectiveGeneration)) as NonNullable<DraftJobInput['objectiveGeneration']>;
      const runtime: DraftJobRuntime = {
        timeoutMs: Math.min(a.effectExpiresAtMs, state.association.acceptance.issuance.expiresAtMs, grant.expiresAtMs) - prepared.now,
        onStage: () => {}, onStreamDelta: () => {},
        objective: { envelope, onCompiled: async () => fail('REQUEST_CONFLICT') },
      };
      const persistence = objectivePersistence({ id: state.job.id, tenantId: grant.tenantId, ownerUserId: grant.clerkUserId,
        claimToken: `canonical:${state.association.acceptance.issuance.issuanceKey}`, attempt: 2,
        input: { ...state.input, objectiveGeneration: envelope }, completion: witness }, this.contextPlane, () => state.stored.compiled);
      runtime.persistence = { ...persistence,
        beforeWrite: async tx => {
          await persistence.beforeWrite(tx);
          const fresh = await readCanonicalRequestPublication(tx, a);
          if (!fresh || fresh.publicationSha256 !== state.stored.publicationSha256) return fail('REQUEST_CONFLICT');
          if ('requestVersion' in fresh.publication.request)
            await requireCanonicalBasisCustody(tx, fresh.publication.request.basis);
          // Preparation locks ended before the writer started. Re-resolve the
          // referenced assignments under THIS transaction; the real directory
          // holds membership/user FOR SHARE locks through the actual commit.
          // Unrelated new tenant members do not invalidate an existing map.
          const currentOwners = new Map((await this.owners.read(tx, grant.tenantId)).map(o => [o.ownerRef, o.clerkUserId]));
          if (prepared.ownerBindings.some(o => currentOwners.get(o.ownerRef) !== o.clerkUserId)) return fail('SOURCE_STALE');
          await this.proof(tx, grant, subject, true, resultExpires);
        },
        afterWrite: async (tx, saved) => {
          await persistence.afterWrite(tx, saved);
          await this.proof(tx, grant, subject, true, resultExpires);
        },
      };
      if (a.expectedStrategyVersionId === null)
        await this.meri.applyCanonicalDraft(grant.tenantId, grant.clerkUserId, a, prepared.normalized, runtime);
      else await this.meri.applyCanonicalRegeneration(grant.tenantId, grant.clerkUserId, a, prepared.normalized, runtime);
      // Reply only with actual durable owner evidence. A lost reply repeats
      // the same lookup; no model rerun, new job or post-completion update.
      return this.prisma.withTenant(grant.tenantId, async tx => {
        const current = await this.inspect(tx, grant, subject, false);
        return await this.receipt(tx, grant, subject, current) ?? fail();
      }, { timeoutMs: 15_000 });
    });
  }
  private async safe<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      const code = error instanceof CanonicalApplicationError ? error.code : 'OUTCOME_UNCONFIRMED';
      const status = { INPUT_INVALID: 400, REQUEST_CONFLICT: 409, NOT_AVAILABLE: 404,
        SOURCE_STALE: 409, AUTHORITY_UNAVAILABLE: 503, OUTCOME_UNCONFIRMED: 503 }[code];
      throw new HttpException({ schemaVersion: 1, code, message: 'Objective Strategy application is unavailable.', outcome: 'unconfirmed' }, status);
    }
  }
}
