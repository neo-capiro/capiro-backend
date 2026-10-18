import { HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlannerService } from './planner.service.js';
import { canonicalMaterializationReceiptId, type CanonicalMaterializationBinding,
  type CanonicalMaterializationPredecessor } from './strategy-materialization.js';
import { ObjectiveCanonicalWorkloadAuthority, type CanonicalAuthoritySubject } from './objective-canonical-authority.js';
import { requireCanonicalApplicationFence, requireCanonicalApplicationRead } from './objective-canonical-fence.js';
import { readCanonicalSavedGeneration, requireSavedGenerationApplication } from '../meri/objective-canonical-saved-generation.js';
import { applicationHash, applicationHeadId, applicationObservation, applicationReceiptId, applicationUuid,
  CANONICAL_APPLICATION_HEAD, CANONICAL_APPLICATION_RECEIPT, CanonicalApplicationError,
  canonicalApplicationRequestId, checkStoredApplication, executeCanonicalApplicationTransaction, parseCanonicalApplication,
  type CanonicalApplicationGrant, type CanonicalApplicationRequest, type StoredCanonicalApplication } from './objective-canonical-application.js';

type Tx = Prisma.TransactionClient;
const STATUS = { INPUT_INVALID: 400, NOT_AVAILABLE: 404, REQUEST_CONFLICT: 409,
  SOURCE_STALE: 409, AUTHORITY_UNAVAILABLE: 503, OUTCOME_UNCONFIRMED: 503 } as const;

@Injectable()
export class ObjectiveCanonicalApplicationService {
  constructor(private readonly prisma: PrismaService, private readonly planner: PlannerService,
    private readonly authority: ObjectiveCanonicalWorkloadAuthority) {}
  private ctx(grant: CanonicalApplicationGrant): AuthTenantContext {
    // Role is independently re-resolved by the shared Core owner/fence. This
    // adapter never accepts a caller-supplied role or uses an admin bypass.
    return { tenantId: grant.tenantId, clerkUserId: grant.clerkUserId, role: 'standard_user' };
  }
  private binding(request: CanonicalApplicationRequest): CanonicalMaterializationBinding {
    return { canonical: request.canonical, generationRequestId: request.generationRequestId,
      objectiveReceiptSha256: request.objectiveReceiptSha256, snapshotDigest: request.snapshotDigest };
  }
  private async lock(tx: Tx, tenantId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`planner:${tenantId}`}, 0))`;
  }
  private async owner(tx: Tx, grant: CanonicalApplicationGrant, request: CanonicalApplicationRequest) {
    return this.planner.canonicalStrategyPlanCreationInTransaction(tx, this.ctx(grant),
      request.applicationRequestId, this.binding(request));
  }
  private async receipt(tx: Tx, grant: CanonicalApplicationGrant, requestId: string) {
    return tx.spPlannerResource.findFirst({ where: {
      id: applicationReceiptId(grant.tenantId, grant.clerkUserId, requestId), tenantId: grant.tenantId,
      ownerId: grant.clerkUserId, kind: CANONICAL_APPLICATION_RECEIPT, archived: false,
    } });
  }
  private async read(tx: Tx, grant: CanonicalApplicationGrant, subject: CanonicalAuthoritySubject,
    row: { data: unknown }, expectedRequest?: CanonicalApplicationRequest) {
    // Decode the closed source before deriving any DB IDs. Stored data cannot
    // broaden the verified original request or current read authority.
    const request = parseCanonicalApplication((row.data as StoredCanonicalApplication | null)?.request);
    if (request.applicationRequestId !== subject.applicationRequestId ||
        request.canonical.tenantId !== grant.tenantId ||
        grant.requestSha256 !== applicationHash(request) ||
        grant.canonicalSha256 !== applicationHash(request.canonical) ||
        canonicalApplicationRequestId(request.canonical, grant.actorUserId) !== subject.applicationRequestId ||
        (expectedRequest && applicationHash(expectedRequest) !== applicationHash(request)))
      throw new CanonicalApplicationError('REQUEST_CONFLICT');
    await this.authority.assertCurrent(tx, grant, { ...subject, purpose: 'retained-result-read' });
    await requireCanonicalApplicationRead(tx, grant, request.canonical);
    const owner = await this.owner(tx, grant, request);
    if (!owner) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
    const stored = checkStoredApplication(row.data, owner,
      canonicalMaterializationReceiptId(grant.tenantId, grant.clerkUserId, subject.applicationRequestId));
    if (stored.ack.actorUserId !== grant.actorUserId) throw new CanonicalApplicationError('NOT_AVAILABLE');
    const current = await this.planner.canonicalStrategyPlanObservationInTransaction(tx, this.ctx(grant), owner);
    // Release fence checks current read authority, independently of old effect
    // expiry/cancel/source-current status. Human edits are projected, never reset.
    await this.authority.assertCurrent(tx, grant, { ...subject, purpose: 'retained-result-read' });
    await requireCanonicalApplicationRead(tx, grant, request.canonical);
    return applicationObservation(stored, current);
  }
  async prepare(http: Request, raw: unknown) {
    return this.safe(async () => {
      const request = parseCanonicalApplication(raw);
      const subject: CanonicalAuthoritySubject = { purpose: 'effect',
        applicationRequestId: request.applicationRequestId, requestSha256: applicationHash(request) };
      const grant = await this.authority.verify(http, subject);
      if (grant.tenantId !== request.canonical.tenantId || grant.requestSha256 !== subject.requestSha256 ||
          grant.canonicalSha256 !== applicationHash(request.canonical) ||
          canonicalApplicationRequestId(request.canonical, grant.actorUserId) !== request.applicationRequestId)
        throw new CanonicalApplicationError('REQUEST_CONFLICT');
      return this.prisma.withTenant(grant.tenantId, async tx => executeCanonicalApplicationTransaction(request, grant, {
        lockPlanner: () => this.lock(tx, grant.tenantId),
        previous: () => this.receipt(tx, grant, request.applicationRequestId),
        read: previous => this.read(tx, grant, subject, previous as { data: unknown }, request),
        assertEffect: () => this.authority.assertCurrent(tx, grant, subject),
        // Owner locks: Planner -> job -> Strategy -> exact saved version ->
        // current Core authority/Objective -> canonical -> current consent.
        prepare: async beforeWrite => {
          // New effects only: historical ACK replay returns above, under its
          // independent current read admission. Hold the original job stable
          // while joining cd376's custody witness to the ACTUAL saved version.
          await tx.$queryRaw`SELECT id FROM sp_draft_job WHERE tenant_id=${grant.tenantId}::uuid
            AND owner_user_id=${grant.clerkUserId} AND id=${request.generationJobId}::uuid FOR SHARE`;
          const saved = await readCanonicalSavedGeneration(tx, { tenantId: grant.tenantId,
            clerkUserId: grant.clerkUserId, generationJobId: request.generationJobId });
          const actual = requireSavedGenerationApplication(saved, grant.actorUserId, request);
          const predecessor = await this.predecessor(tx, grant, request);
          return this.planner.prepareCanonicalStrategyPlanInTransaction(tx, this.ctx(grant), {
            requestId: actual.applicationRequestId, generationJobId: actual.generationJobId,
            expected: { strategyId: actual.strategyId, strategyVersionId: actual.strategyVersionId,
              objectiveRevisionId: actual.canonical.requestedObjectiveRevisionId },
          }, this.binding(actual), beforeWrite, predecessor);
        },
        fence: () => requireCanonicalApplicationFence(tx, grant, request),
        clock: async () => {
          const clocks = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
          const recordedAt = clocks[0]?.now.toISOString();
          if (!recordedAt) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
          return recordedAt;
        },
        ownerReceiptId: canonicalMaterializationReceiptId(grant.tenantId, grant.clerkUserId, request.applicationRequestId),
        insert: async stored => { await tx.spPlannerResource.create({ data: {
          id: applicationReceiptId(grant.tenantId, grant.clerkUserId, request.applicationRequestId),
          tenantId: grant.tenantId, ownerId: grant.clerkUserId, kind: CANONICAL_APPLICATION_RECEIPT,
          name: 'Objective canonical application receipt',
          data: stored as unknown as Prisma.InputJsonValue,
        } }); },
        advanceHead: stored => this.advanceHead(tx, grant, stored),
      }), { timeoutMs: 15_000 });
    });
  }
  /** Planner lock is already held. A mutable head is accepted only after
   * reconstructing its complete paired immutable application/owner evidence.
   * Original receipt actors remain original; fresh output editor authority is
   * checked by the new owner operation, not inherited from an old actor. */
  private async predecessor(tx: Tx, grant: CanonicalApplicationGrant,
    request: CanonicalApplicationRequest): Promise<CanonicalMaterializationPredecessor | undefined> {
    const c = request.canonical;
    const head = await tx.spPlannerResource.findFirst({ where: { tenantId: grant.tenantId, id: applicationHeadId(c) } });
    if (!head) return undefined;
    const data = head.data as { applicationRequestId?: string; canonical?: CanonicalApplicationRequest['canonical'] };
    if (head.kind !== CANONICAL_APPLICATION_HEAD || head.archived || !data.canonical ||
        data.canonical.tenantId !== c.tenantId || data.canonical.clientId !== c.clientId || data.canonical.objectiveId !== c.objectiveId ||
        data.canonical.canonicalPlanId !== c.canonicalPlanId || data.canonical.epoch !== c.epoch ||
        data.canonical.canonicalStrategyId !== c.canonicalStrategyId || data.canonical.canonicalProjectId !== c.canonicalProjectId ||
        data.canonical.bindingVersion >= c.bindingVersion) throw new CanonicalApplicationError('REQUEST_CONFLICT');
    const oldId = applicationUuid(data.applicationRequestId);
    const oldRow = await tx.spPlannerResource.findFirst({ where: { tenantId: grant.tenantId,
      id: applicationReceiptId(grant.tenantId, head.ownerId, oldId), ownerId: head.ownerId,
      kind: CANONICAL_APPLICATION_RECEIPT, archived: false } });
    if (!oldRow) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
    const oldRequest = parseCanonicalApplication((oldRow.data as unknown as StoredCanonicalApplication).request);
    const oldOwner = await this.planner.canonicalStrategyPlanCreationInTransaction(tx,
      { ...this.ctx(grant), clerkUserId: head.ownerId }, oldId, this.binding(oldRequest));
    if (!oldOwner) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
    const ownerId = canonicalMaterializationReceiptId(grant.tenantId, head.ownerId, oldId);
    const old = checkStoredApplication(oldRow.data, oldOwner, ownerId);
    const expected = { schemaVersion: 1, canonical: old.request.canonical, applicationRequestId: oldId,
      ackSha256: old.ackSha256, source: old.ack.source, strategyId: old.ack.source.strategyId,
      projectId: old.request.canonical.canonicalProjectId };
    if (old.request.canonical.tenantId !== grant.tenantId || applicationHash(head.data) !== applicationHash(expected))
      throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
    return { owner: oldOwner, applicationRequestId: oldId, applicationAckSha256: old.ackSha256,
      ownerReceiptId: ownerId, ownerReceiptSha256: applicationHash(oldOwner) };
  }
  private async advanceHead(tx: Tx, grant: CanonicalApplicationGrant, stored: StoredCanonicalApplication) {
    const c = stored.request.canonical;
    const id = applicationHeadId(c);
    const prior = await tx.spPlannerResource.findFirst({ where: { tenantId: grant.tenantId, id } });
    const head = { schemaVersion: 1, canonical: c, applicationRequestId: stored.request.applicationRequestId,
      ackSha256: stored.ackSha256, source: stored.ack.source,
      strategyId: stored.ack.source.strategyId, projectId: c.canonicalProjectId };
    if (prior) {
      if (!await this.predecessor(tx, grant, stored.request)) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
      const changed = await tx.spPlannerResource.updateMany({ where: { tenantId: grant.tenantId,
        id, kind: CANONICAL_APPLICATION_HEAD, version: prior.version, ownerId: prior.ownerId, archived: false },
        data: { ownerId: grant.clerkUserId, data: head as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
      if (changed.count !== 1) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
    } else await tx.spPlannerResource.create({ data: { id, tenantId: grant.tenantId,
      ownerId: grant.clerkUserId, kind: CANONICAL_APPLICATION_HEAD,
      name: 'Objective canonical application head', data: head as unknown as Prisma.InputJsonValue } });
  }
  async lookup(http: Request, rawId: string) {
    return this.safe(async () => {
      const requestId = applicationUuid(rawId);
      const subject: CanonicalAuthoritySubject = { purpose: 'retained-result-read',
        applicationRequestId: requestId, requestSha256: null };
      const grant = await this.authority.verify(http, subject);
      return this.prisma.withTenant(grant.tenantId, async tx => {
        await this.lock(tx, grant.tenantId);
        await this.authority.assertCurrent(tx, grant, subject);
        const previous = await this.receipt(tx, grant, requestId);
        // No authoritative eligibility/empty state is exported. Missing receipt
        // is uncertainty; it is never permission to dispatch a new model/effect.
        if (!previous) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
        return this.read(tx, grant, subject, previous);
      }, { timeoutMs: 15_000 });
    });
  }
  private async safe<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof CanonicalApplicationError)
        throw new HttpException({ schemaVersion: 1, code: error.code,
          message: 'Objective plan application is unavailable.', outcome: 'unconfirmed' }, STATUS[error.code]);
      // Existing owner validation remains truthful and bounded. No raw DB,
      // identity, provider or saved content is exposed by an unexpected failure.
      if (error instanceof HttpException) {
        const code = (error.getResponse() as { code?: string })?.code;
        if (code === 'MATERIALIZATION_SOURCE_INVALID') throw new HttpException({ schemaVersion: 1,
          code: 'SOURCE_INVALID', message: 'The saved plan needs review before preparation.', outcome: 'unconfirmed' }, 422);
        const mapped = code === 'MATERIALIZATION_SOURCE_STALE' ? 'SOURCE_STALE'
          : code === 'MATERIALIZATION_REQUEST_CONFLICT' ? 'REQUEST_CONFLICT'
          : code === 'MATERIALIZATION_NOT_AVAILABLE' ? 'NOT_AVAILABLE'
          : code === 'MATERIALIZATION_INPUT_INVALID' ? 'INPUT_INVALID' : null;
        if (mapped) throw new HttpException({ schemaVersion: 1, code: mapped,
          message: 'Objective plan application is unavailable.', outcome: 'unconfirmed' }, STATUS[mapped]);
      }
      throw new HttpException({ schemaVersion: 1, code: 'OUTCOME_UNCONFIRMED',
        message: 'Objective plan application is unavailable.', outcome: 'unconfirmed' }, 503);
    }
  }
}
