import { receiveNativeMail } from './native-mail-execution.js';
import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EngagementService } from '../../engagement/engagement.service.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import type { CoreEd25519KeyConfig } from '../../auth/core-ed25519-key-config.js';
import type { MeriExecutionRequestIdentity } from '../../auth/meri-execution-request.js';
import { UUID, nativeCanonicalSha256, sameJson, parseApprovalProposal, parseRunBinding, parseObjectReference } from '../native-approvals/native-approval.contract.js';
import { nativeDecisionOf } from '../native-approvals/native-approval.service.js';
import {
  MERI_EXECUTION_KEY_CONFIG,
  lockMeriExecutionProposal,
  meriExecutionClientsVisible,
  meriExecutionDbNow,
  meriExecutionTrust,
} from './meri-execution-authority.js';
import { readMeriAdmittedRun } from './meri-admitted-run.reader.js';
import { NativeApprovalService } from '../native-approvals/native-approval.service.js';
import { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { receiveNativeTask } from './native-task-execution.js';
import { receiveNativeArtifactFile } from './native-artifact-file-execution.js';
import { prepareNativeArtifactFileAuthority } from './native-artifact-file-authority.js';
import type { NativeAttachmentRegistration } from '../meri.service.js';
import { MeriClientFilingService } from '../meri-client-filing.service.js';
import { retainedReadObject, retainedReadSnapshot } from '../retained-read-context.js';
import {
  taskClientWithinScopes,
  taskCreateArgumentsFromBody,
  verifyMeriExecutionCapability,
  type VerifiedMeriExecution,
} from './meri-execution-capability.js';

/** The one tool a Meri execution capability may run (`task.create`). */
export const MERI_EXECUTION_TOOL = 'create_task';

/**
 * dot #121 6247742665 item 3: Meri's agent never falls back to the ordinary
 * bearer path for an approved write. In the first-chat-preview profile, whose
 * only tool caller is Meri, `create_task` is accepted only on the capability
 * branch; a capability that fails admission is refused there and never
 * retried here. Other deployments keep their existing (post-compliance-gate)
 * orchestrator path unchanged.
 */
export function assertOrdinaryToolPathAllowed(name: string, profile: string | undefined = process.env.CORE_DEPLOYMENT_PROFILE): void {
  if (profile === 'first-chat-preview' && name === MERI_EXECUTION_TOOL) {
    throw new ForbiddenException('Approved execution capability required');
  }
}
/** `engagement_tasks.source_type` of an approved execution's task; with
 * `source_id = <proposalId>|<idempotencyKey>` it hits the existing partial
 * UNIQUE (tenant_id, source_type, source_id), a second effect identity. */
export const MERI_EXECUTION_TASK_SOURCE = 'meri_approved_execution';

const forbidden = () => new ForbiddenException('Execution capability refused');
const conflict = (reason: string) => new ConflictException(reason);

/**
 * Core's receiver for Meri's approved `create_task` (D016 #9). The tenant
 * middleware admitted the capability's signature and the actor's active
 * membership; this receiver re-verifies the whole capability and, under the
 * proposal's lock, compares it with Core's own state before any effect:
 *
 *  - ledger: the capability is Core's issuance row for exactly this request,
 *    binding, budgets, allocation, qualification, window and signer, and is
 *    the newest issuance for the proposal (no later attempt or fence);
 *  - run: Meri's run owner still holds the same admitted allocation and the
 *    same attempt, worker, fence and policy revision, before its deadline;
 *  - decision: the current stored decision hashes to the signed
 *    `decisionSha256`, is approved, unexpired, for this run and at the signed
 *    policy revision;
 *  - membership: active tenant, active membership, at least `standard_user`;
 *  - clients: every client in the scopes and the arguments is visible now;
 *  - body: exactly the signed `sourceBodySha256`, and Meri's null-omitting
 *    projection maps back to the signed arguments.
 *
 * The durable effect identity is (tenant, proposal, idempotency key), shared
 * by every capability for that proposal. The checks, the claim, the task
 * write and the completion with its JSON result are ONE transaction: either
 * all commit or none does, so a retry after any failure is safe and the task
 * is created at most once. A completed identity answers its stored result. A
 * claimed identity without a result cannot commit in this design; if one is
 * ever read it is UNKNOWN and is never dispatched again.
 *
 * The result has the exact shape of `MeriToolsService` `create_task`.
 */
@Injectable()
export class MeriExecutionReceiverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
    @Optional() @Inject(MERI_EXECUTION_KEY_CONFIG) private readonly config: CoreEd25519KeyConfig | null = null,
    @Optional() private readonly approvals?: NativeApprovalService,
    @Optional() private readonly tenant?: TenantContextMiddleware,
    @Optional() private readonly filing?: MeriClientFilingService,
  ) {}

  nativeApproved(req: Request, ctx: TenantContext, body: unknown, mode: 'execute' | 'read') {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const input = retainedReadSnapshot(body, 262144);
    if ((input as { proposal?: { command?: { action?: unknown } } })?.proposal?.command?.action === 'mail.send') {
      if (!this.approvals || !this.tenant) throw new ServiceUnavailableException('Native mail unavailable');
      return receiveNativeMail({ prisma: this.prisma, engagement: this.engagement, approvals: this.approvals, tenant: this.tenant }, req, ctx, input, mode);
    }
    if ((input as { proposal?: { command?: { action?: unknown } } })?.proposal?.command?.action !== 'artifact.file') {
      return this.nativeTask(req, ctx, input, mode);
    }
    if (!this.approvals || !this.tenant || !this.filing) throw new ServiceUnavailableException('Native filing unavailable');
    return receiveNativeArtifactFile({ prisma: this.prisma, approvals: this.approvals, tenant: this.tenant,
      filing: this.filing }, req, ctx, input, mode);
  }

  /** Idempotent DB-only custody for one exact approved original. */
  async nativeAttachmentRegistration<T>(req: Request, ctx: TenantContext, raw: unknown,
    register: (registration: NativeAttachmentRegistration) => Promise<T>): Promise<T> {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    if (!this.approvals || !this.tenant) throw new ServiceUnavailableException('Native filing unavailable');
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 262144) throw new BadRequestException('Invalid native filing context');
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { throw new BadRequestException('Invalid native filing context'); }
    const input = retainedReadSnapshot(retainedReadObject(decoded, ['proposal', 'binding', 'object']), 262144);
    const proposal = parseApprovalProposal(input.proposal), binding = parseRunBinding(input.binding, 'binding');
    const object = parseObjectReference(input.object);
    if (!proposal.command.attachments.some(approved => sameJson(approved, object))) throw conflict('File differs from the approved original');
    const { clientId, authorize, readCurrent } = await prepareNativeArtifactFileAuthority(
      { prisma: this.prisma, approvals: this.approvals, tenant: this.tenant }, req, ctx, proposal, binding);
    const digest = nativeCanonicalSha256(['meri-native-attachment-v1', ctx.tenantId, ctx.userId, clientId, object]);
    const attachmentId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const result = await this.prisma.withTenant(ctx.tenantId, async tx => {
      const beforeWrite = async () => { if (!await authorize(tx, true)) throw conflict('Approved original registration refused'); };
      await beforeWrite();
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('capiro-meri-native-attachment:' || ${attachmentId}::text, 0::bigint))::text AS locked`;
      await beforeWrite();
      const stored = await register({ tx, attachmentId, object, beforeWrite });
      await beforeWrite();
      return stored;
    });
    const current = await readCurrent();
    await this.prisma.withTenant(ctx.tenantId, async tx => {
      if (!await authorize(tx, true) || current.expiresAtMs <= await meriExecutionDbNow(tx)) throw forbidden();
      // Release only bytes visible after COMMIT, never the insert callback's
      // provisional result. A deferred commit failure can otherwise leave no
      // staged original even when the transaction client resolves successfully.
      await tx.$queryRaw`SELECT id::text FROM clio_attachments WHERE id=${attachmentId}::uuid
        AND tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
      const stored = await tx.clioAttachment.findFirst({ where: {
        id: attachmentId, tenantId: ctx.tenantId, userId: ctx.userId, messageId: null,
      }, select: { data: true, byteSize: true } });
      if (!stored?.data || stored.byteSize !== object.bytes || stored.data.byteLength !== object.bytes ||
          createHash('sha256').update(stored.data).digest('hex') !== object.sha256) {
        throw new ServiceUnavailableException('Approved original registration was not retained');
      }
    });
    return result;
  }

  /** Attended native tasks share this receiver's transaction and receipt owner. */
  nativeTask(req: Request, ctx: TenantContext, body: unknown, mode: 'execute' | 'read') {
    if (!this.approvals || !this.tenant) throw new ServiceUnavailableException('Native task execution unavailable');
    return receiveNativeTask({ prisma: this.prisma, engagement: this.engagement, approvals: this.approvals,
      tenant: this.tenant }, req, ctx, body, mode);
  }

  async receive(
    req: Request,
    ctx: TenantContext,
    name: string,
    body: unknown,
    identity: MeriExecutionRequestIdentity,
  ): Promise<Prisma.JsonValue> {
    const config = this.config;
    if (!config) throw new ServiceUnavailableException('Execution capabilities are not enabled');
    if (name !== MERI_EXECUTION_TOOL || !hasVerifiedToolServiceIdentity(req)) throw forbidden();
    let verified: VerifiedMeriExecution;
    try {
      verified = verifyMeriExecutionCapability(identity.token, meriExecutionTrust(config, Date.now()));
    } catch {
      throw new UnauthorizedException('Invalid execution capability');
    }
    const { claims, execution } = verified;
    if (claims.capabilityId !== identity.jti || claims.binding.tenantId !== ctx.tenantId || claims.binding.actorId !== ctx.userId ||
        identity.tenantId !== ctx.tenantId || identity.actorId !== ctx.userId) throw forbidden();
    let args: ReturnType<typeof taskCreateArgumentsFromBody>;
    try {
      args = taskCreateArgumentsFromBody(body);
    } catch {
      throw conflict('Execution body is not the approved command projection');
    }
    if (nativeCanonicalSha256(body) !== execution.sourceBodySha256 || nativeCanonicalSha256(args) !== execution.argumentsSha256) {
      throw conflict('Execution body differs from the approved command');
    }
    if (args.clientId !== null && !UUID.test(args.clientId)) throw conflict('Execution client is not a resolved client id');

    const key = { tenantId: ctx.tenantId, proposalId: execution.proposalId, idempotencyKey: execution.idempotencyKey };
    const capabilitySha256 = createHash('sha256').update(identity.token, 'utf8').digest('hex');
    return this.prisma.withTenant(ctx.tenantId, async (tx): Promise<Prisma.JsonValue> => {
      await lockMeriExecutionProposal(tx, ctx.tenantId, execution.proposalId);
      // Ledger.
      const issuance = await tx.clioMeriExecutionIssuance.findUnique({ where: { jti: claims.capabilityId } });
      if (!issuance || issuance.tenantId !== ctx.tenantId || issuance.proposalId !== execution.proposalId ||
          issuance.requestId !== execution.requestId || issuance.requestSha256 !== execution.requestSha256 ||
          issuance.commandSha256 !== execution.commandSha256 || issuance.decisionSha256 !== execution.decisionSha256 ||
          issuance.argumentsSha256 !== execution.argumentsSha256 || issuance.idempotencyKey !== execution.idempotencyKey ||
          issuance.runId !== claims.binding.runId || issuance.attemptId !== claims.binding.attemptId ||
          !sameJson(issuance.executorBinding, claims.binding) || !sameJson(issuance.budgets, claims.budgets) ||
          issuance.allocationSha256 !== execution.allocationSha256 || !sameJson(issuance.qualification, execution.qualification) ||
          issuance.signerIssuer !== claims.issuer || issuance.signerKeyId !== config.kid ||
          Number(issuance.iatSeconds) * 1000 !== Date.parse(claims.issuedAt) ||
          Number(issuance.expSeconds) * 1000 !== Date.parse(claims.expiresAt)) throw forbidden();
      const newest = await tx.clioMeriExecutionIssuance.findFirst({
        where: { tenantId: ctx.tenantId, proposalId: execution.proposalId },
        orderBy: [{ iatSeconds: 'desc' }, { recordedAt: 'desc' }],
      });
      if (!newest || newest.jti !== issuance.jti) throw conflict('Execution attempt superseded');
      // Current decision and its revocation.
      const row = await tx.clioMeriApprovalDecision.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: execution.proposalId } },
      });
      if (!row) throw conflict('Approval decision is not current');
      const decision = nativeDecisionOf(row);
      if (nativeCanonicalSha256(decision) !== execution.decisionSha256 || decision.decision !== 'approved' ||
          decision.policyRevision !== claims.policyRevision ||
          row.approverUserId !== ctx.userId || row.bindingActorUserId !== claims.binding.actorId ||
          row.conversationId !== claims.binding.conversationId || row.runId !== claims.binding.runId) {
        throw conflict('Approval decision is not current');
      }
      const revocation = await tx.clioMeriApprovalRevocation.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: execution.proposalId } },
      });
      if (revocation) throw conflict('Approval decision is revoked');
      // Meri's canonical admission under its budget lock (serialized with its
      // revoke/install/fence changes), including this capability's own ACTIVE
      // execution grant. From here every time check uses the database clock.
      const admitted = await readMeriAdmittedRun(tx, claims.binding, claims.policyRevision, {
        tenantId: ctx.tenantId, expect: { jti: claims.capabilityId, capabilitySha256 },
      });
      if (admitted.allocationSha256 !== execution.allocationSha256 || !sameJson(admitted.qualification, execution.qualification) ||
          !sameJson(admitted.budgets, claims.budgets)) throw conflict('Execution run is not current');
      const assertLive = (nowMs: number) => {
        if (nowMs >= identity.expMs) throw new UnauthorizedException('Invalid execution capability');
        if (nowMs >= row.expiresAt.getTime() || nowMs >= admitted.deadlineMs) throw conflict('Execution authority expired');
      };
      assertLive(admitted.dbNowMs);
      // Current membership.
      const membership = await tx.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
        include: { tenant: true },
      });
      if (!membership || membership.tenant.status !== 'active' || !Object.hasOwn(ROLE_RANK, membership.role) ||
          ROLE_RANK[membership.role as TenantRole] < ROLE_RANK.standard_user) throw forbidden();
      // Scope containment and the current client wall.
      if (!taskClientWithinScopes(args.clientId, claims.scopes, ctx.tenantId)) throw conflict('Execution client is outside the approved scope');
      const clients = [...execution.clientIds, ...(args.clientId === null ? [] : [args.clientId])];
      if (!(await meriExecutionClientsVisible(tx, ctx.tenantId, ctx.userId, clients))) throw forbidden();
      // Durable effect identity: a completed result is released only after
      // every check above passed on this transaction's clock.
      const existing = await tx.clioMeriExecutionConsumption.findUnique({ where: { tenantId_proposalId_idempotencyKey: key } });
      if (existing) {
        if (existing.commandSha256 !== execution.commandSha256 || existing.argumentsSha256 !== execution.argumentsSha256) {
          throw conflict('Execution identity belongs to another command');
        }
        if (existing.state === 'COMPLETED' && existing.result !== null) {
          // The release boundary: the database clock again (dot 6248171459 item 1).
          assertLive(await meriExecutionDbNow(tx));
          return existing.result;
        }
        throw conflict('Execution outcome unknown');
      }
      await tx.clioMeriExecutionConsumption.create({
        data: { ...key, commandSha256: execution.commandSha256, argumentsSha256: execution.argumentsSha256, jti: issuance.jti },
      });
      // The effect boundary: the database clock again, still under both locks.
      assertLive(await meriExecutionDbNow(tx));
      const task = await this.engagement.createTask(ctx, {
        title: args.title, clientId: args.clientId ?? undefined, dueDate: args.dueDate ?? undefined,
      }, { tx, sourceType: MERI_EXECUTION_TASK_SOURCE, sourceId: `${execution.proposalId}|${execution.idempotencyKey}` });
      const result = JSON.parse(JSON.stringify({
        tool: MERI_EXECUTION_TOOL, generatedAt: new Date().toISOString(), created: true,
        task: { id: task.id, title: task.title, status: task.status, dueDate: task.dueDate, clientId: task.clientId, createdAt: task.createdAt },
      })) as Prisma.JsonObject;
      const done = await tx.clioMeriExecutionConsumption.updateMany({
        where: { ...key, jti: issuance.jti, state: 'CLAIMED' },
        data: { state: 'COMPLETED', result: result as Prisma.InputJsonObject, completedAt: new Date() },
      });
      if (done.count !== 1) throw new ServiceUnavailableException('Execution outcome unavailable');
      return result;
    });
  }
}
