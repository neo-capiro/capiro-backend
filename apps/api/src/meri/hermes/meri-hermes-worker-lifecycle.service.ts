/**
 * Worker provisioning + lifecycle service — Phase 1 backlog #2
 * ("Fargate RunTask per execution scope from the pinned arm64 digest, scope
 * EFS/EBS volume, scope token mint/rotate, health wait, idle grace, teardown
 * gated on background_queues idle").
 *
 * Implements `MeriHermesWorkerResolverPort` (see that file's doc for why the
 * dependency runs client -> port -> this service, never client -> this
 * service directly, avoiding a circular class dependency with
 * `MeriHermesRuntimeClient`).
 *
 * ## Persistence: `MeriExecutionScope.workerState`, not a new table
 *
 * The orchestrator added `workerState Json @default("{}")` on
 * `MeriExecutionScope` anticipating this ticket; this service reads/writes it
 * directly via `PrismaService` rather than adding a `meri_worker_leases`
 * table (contracts.md §7 lists that table as a PROPOSED Phase 1+ record, not
 * something already built). A dedicated `MeriHermesWorkerStateStore`-shaped
 * concern lives entirely in this file rather than being folded into
 * `MeriHermesRunRepository`: that interface's own doc header scopes it to
 * run/event/interaction persistence, and its in-memory test double
 * (`MeriHermesRunStore`) has no execution-scope modeling at all — extending
 * the shared interface just for worker state would force a meaningless
 * implementation onto every other Hermes spec that constructs the fast
 * in-memory double. This service still depends on `MERI_HERMES_RUN_REPOSITORY`
 * for exactly one thing: `listActiveForScope()`, to answer "does this scope
 * have an active run" for idle-grace teardown.
 *
 * ## ECS RunTask + per-scope EFS access points: the real constraint
 *
 * See `MeriHermesWorkerFleet`'s class doc (infra/cdk) for the full
 * investigation. Summary: ECS `RunTask` overrides cannot change a task
 * definition's `volumes[]` (and therefore cannot select a different EFS
 * access point) per call — that is fixed at task-definition REGISTRATION
 * time. So `ensureScopeTaskDefinition()` below registers one task definition
 * FAMILY per execution scope (derived deterministically from the scope id),
 * cloning the CDK-managed template's container/role/logging shape via
 * `DescribeTaskDefinition` and adding only the EFS volume + mount point. The
 * resulting ARN is cached on `workerState.taskDefinitionArn` and reused
 * (never re-registered) unless it's missing.
 *
 * ## Single-writer-per-scope provisioning fence (Phase 1 required fix 2c)
 *
 * `resolveWorker()` used to have no fencing at all: two concurrent FIRST
 * requests for the same brand-new scope could each observe "no worker", each
 * `RegisterTaskDefinition` + `RunTask`, and produce two competing workers for
 * one execution scope — a direct violation of single-writer-per-profile and a
 * wasted Fargate task. It is now serialized per scope with the SAME mechanism
 * the run admission path uses (`MeriHermesPrismaRunRepository.create` takes
 * `pg_advisory_xact_lock(hashtext(conversationId))`): a transaction-scoped
 * Postgres advisory lock, here keyed by execution scope
 * (`workerProvisioningLockKey()`, hashed with `hashtextextended` into its own
 * key namespace so it can never collide with an admission lock).
 *
 * Only the CLAIM is taken under the lock — read the current `workerState`,
 * and either return the healthy URL, or mark the row `provisioning` and
 * become the owner, or observe someone else's live claim and become a waiter.
 * The lock is released when that short transaction commits, so the slow part
 * (EFS access point, RegisterTaskDefinition, RunTask, wait-for-RUNNING,
 * wait-for-healthy — up to `provisionTimeoutMs`) NEVER runs inside a
 * transaction and never pins a pool connection. Waiters poll the row and
 * return the winner's URL, so every concurrent caller gets the same worker.
 *
 * A claim is not permanent: if the owning replica dies mid-provision, its
 * `provisioning` row goes stale after `provisionTimeoutMs +
 * PROVISION_CLAIM_SLACK_MS` and the next caller takes the claim over rather
 * than waiting forever.
 *
 * ## Known limitations (deliberately deferred, not silently dropped)
 *
 * - A replica that dies between "row marked `stopped`" and `StopTask`
 *   returning leaves a Fargate task nothing references. The stopped row keeps
 *   its `taskArn` for exactly this reason, and the next `provision()` for the
 *   scope best-effort stops that old task before starting a new one, so the
 *   leak is bounded by the scope's next use rather than permanent.
 * - `resolveWorker()` trusts a cached `status: 'healthy'` row without an
 *   actual live `/health` re-check on every call (only during provisioning).
 *   A heartbeat/re-verify pass is Phase 1 hardening (backlog #20), not this
 *   ticket.
 * - Idle-grace teardown gates on "no active `MeriAgentRun`" only.
 *   Background-review completion tracking does not exist anywhere in this
 *   codebase yet (Phase 0's own D3d finding — `checks-report.md`), so there
 *   is nothing to gate on there; inventing a check against a table that
 *   doesn't exist would be worse than omitting it.
 * - The tenant persona (`MERI_SOUL_B64`) is read from a single process-wide
 *   env var here, not rendered per-tenant. Phase 1's actual persona
 *   materialization (contracts.md §8, backlog #15) is a separate ticket;
 *   wiring a real per-tenant renderer into `runTask()`'s override is a
 *   drop-in change to `buildSoulOverride()` below once that exists.
 */
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ECSClient, DescribeTasksCommand, DescribeTaskDefinitionCommand, RegisterTaskDefinitionCommand, RunTaskCommand, StopTaskCommand, type ContainerDefinition, type Task } from '@aws-sdk/client-ecs';
import { EFSClient, CreateAccessPointCommand, DescribeAccessPointsCommand } from '@aws-sdk/client-efs';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { mintMeriHermesWorkerToken } from './meri-hermes-worker-token.js';
import { MeriHermesRuntimeClient } from './meri-hermes-runtime.client.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import {
  MERI_HERMES_RUN_REPOSITORY,
  type MeriHermesRunRepository,
} from './meri-hermes-run-store.js';
import type {
  MeriHermesResolvedWorker,
  MeriHermesWorkerResolverPort,
  MeriHermesWorkerScopeRef,
} from './meri-hermes-worker-resolver.port.js';

export type MeriHermesWorkerStatus = 'provisioning' | 'healthy' | 'stopped' | 'failed';

/** The exact shape persisted at `MeriExecutionScope.workerState`. */
export interface MeriHermesWorkerState {
  status: MeriHermesWorkerStatus;
  taskArn: string | null;
  taskDefinitionArn: string | null;
  accessPointId: string | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
  lastHealthCheckAt: string | null;
  lastActivityAt: string | null;
  lastError: string | null;
}

export class MeriHermesWorkerProvisioningError extends Error {}
export class MeriHermesWorkerProvisioningTimeoutError extends MeriHermesWorkerProvisioningError {}

export type MeriHermesIdleTeardownOutcome = 'stopped' | 'skipped_no_worker' | 'skipped_not_idle' | 'skipped_active';

interface ResolvedLifecycleConfig {
  clusterArn: string;
  taskDefinitionFamily: string;
  subnetIds: string[];
  securityGroupId: string;
  fileSystemId: string;
  containerName: string;
  workerPort: number;
  provisionTimeoutMs: number;
  idleGraceMs: number;
}

const DEFAULT_WORKER_PORT = 8642;
const DEFAULT_PROVISION_TIMEOUT_MS = 120_000; // generous over the measured cold-start + 30s acceptance target
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Phase 1 decision D2 (docs/meri/hermes/phase-1/decisions.md): no warm pool, 10 minute idle grace. */
const DEFAULT_IDLE_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_CONTAINER_NAME = 'hermes-worker';
/**
 * Extra time beyond `provisionTimeoutMs` before another caller treats a
 * `provisioning` claim as abandoned. The owner's own wait loops are bounded
 * by `provisionTimeoutMs`, so without slack a waiter and a live owner would
 * expire at the same instant and could both provision.
 */
const PROVISION_CLAIM_SLACK_MS = 30_000;
/** How many times a caller may re-enter the claim after inheriting an abandoned one, before giving up. */
const MAX_PROVISION_HANDOFFS = 2;
/** Upper bound on scopes torn down per `sweepIdleWorkers()` call (bounded work per scheduler tick). */
const DEFAULT_IDLE_SWEEP_BATCH = 50;

function emptyState(now: Date): MeriHermesWorkerState {
  const iso = now.toISOString();
  return {
    status: 'provisioning',
    taskArn: null,
    taskDefinitionArn: null,
    accessPointId: null,
    url: null,
    createdAt: iso,
    updatedAt: iso,
    lastHealthCheckAt: null,
    lastActivityAt: iso,
    lastError: null,
  };
}

function parseWorkerState(value: unknown): MeriHermesWorkerState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.status !== 'string') return null;
  return {
    status: v.status as MeriHermesWorkerStatus,
    taskArn: typeof v.taskArn === 'string' ? v.taskArn : null,
    taskDefinitionArn: typeof v.taskDefinitionArn === 'string' ? v.taskDefinitionArn : null,
    accessPointId: typeof v.accessPointId === 'string' ? v.accessPointId : null,
    url: typeof v.url === 'string' ? v.url : null,
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date(0).toISOString(),
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : new Date(0).toISOString(),
    lastHealthCheckAt: typeof v.lastHealthCheckAt === 'string' ? v.lastHealthCheckAt : null,
    lastActivityAt: typeof v.lastActivityAt === 'string' ? v.lastActivityAt : null,
    lastError: typeof v.lastError === 'string' ? v.lastError : null,
  };
}

/** Deterministic, collision-safe per-scope EFS root path (colons in `tenant:<id>:user:<id>` are legal POSIX but hashed anyway for a short, opaque, fixed-width path). */
export function scopeHomePath(executionScopeId: string): string {
  return `/scopes/${createHash('sha256').update(executionScopeId).digest('hex').slice(0, 40)}`;
}

/** EFS `CreateAccessPoint` idempotency token: deterministic so a retried create for the same scope is naturally deduped by the API itself. */
export function scopeAccessPointClientToken(executionScopeId: string): string {
  return `mh-ap-${createHash('sha256').update(executionScopeId).digest('hex').slice(0, 48)}`;
}

/**
 * Advisory-lock key for the per-scope provisioning fence.
 *
 * Its own string namespace (and `hashtextextended`, a 64-bit hash, rather
 * than the 32-bit `hashtext` the admission lock uses) so a scope's
 * provisioning lock can never alias a conversation's admission lock in
 * Postgres's single global advisory-lock space.
 */
export function workerProvisioningLockKey(executionScopeId: string): string {
  return `meri-hermes-worker-provisioning:${executionScopeId}`;
}

/** Deterministic per-scope task definition family, derived from the shared template family so every scope's revisions are independently addressable and never collide. */
export function scopeTaskDefinitionFamily(baseFamily: string, executionScopeId: string): string {
  return `${baseFamily}-${createHash('sha256').update(executionScopeId).digest('hex').slice(0, 32)}`;
}

function extractPrivateIp(task: Task): string | null {
  for (const attachment of task.attachments ?? []) {
    if (attachment.type !== 'ElasticNetworkInterface') continue;
    const detail = attachment.details?.find((d) => d.name === 'privateIPv4Address');
    if (detail?.value) return detail.value;
  }
  return null;
}

@Injectable()
export class MeriHermesWorkerLifecycleService implements MeriHermesWorkerResolverPort {
  private readonly logger = new Logger(MeriHermesWorkerLifecycleService.name);

  // Test seams (same pattern as MeriHermesRuntimeClient/MeriHermesBrokerService
  // in this module: settable fields, not constructor params, so a spec can
  // swap in a fake AWS client / env / clock without a DI container).
  env: NodeJS.ProcessEnv = process.env;
  ecs: Pick<ECSClient, 'send'> = new ECSClient({ region: process.env.AWS_REGION_DEFAULT || 'us-east-1' });
  efs: Pick<EFSClient, 'send'> = new EFSClient({ region: process.env.AWS_REGION_DEFAULT || 'us-east-1' });
  fetchImpl: typeof fetch = fetch;
  clock: () => Date = () => new Date();
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MERI_HERMES_RUN_REPOSITORY) private readonly runs: MeriHermesRunRepository,
  ) {}

  // ---------------------------------------------------------------------------
  // MeriHermesWorkerResolverPort
  // ---------------------------------------------------------------------------

  async resolveWorker(scope: MeriHermesWorkerScopeRef): Promise<MeriHermesResolvedWorker> {
    return this.resolveWorkerFenced(scope, 0);
  }

  /**
   * One attempt at the per-scope fence (see the class doc). `handoff` counts
   * how many times this call has inherited an ABANDONED provisioning claim;
   * it exists purely to bound an adversarial "owner keeps dying" loop.
   */
  private async resolveWorkerFenced(
    scope: MeriHermesWorkerScopeRef,
    handoff: number,
  ): Promise<MeriHermesResolvedWorker> {
    const cfg = this.resolveConfig();
    const claim = await this.claimProvisioningSlot(scope, cfg, this.clock());
    if (claim.role === 'cached') return { url: claim.url };
    if (claim.role === 'waiter') return this.awaitProvisionedWorker(scope, cfg, handoff);
    return this.provision(scope, claim.claim, claim.previous, cfg);
  }

  /**
   * The ONLY place a scope's worker provisioning is decided, and the only
   * thing that runs under the advisory lock. Short by construction: one lock,
   * one upsert, one read, one write. No network call, no AWS call, no sleep.
   */
  private async claimProvisioningSlot(
    scope: MeriHermesWorkerScopeRef,
    cfg: ResolvedLifecycleConfig,
    now: Date,
  ): Promise<
    | { role: 'cached'; url: string }
    | { role: 'waiter' }
    | { role: 'owner'; claim: MeriHermesWorkerState; previous: MeriHermesWorkerState | null }
  > {
    const lockKey = workerProvisioningLockKey(scope.executionScopeId);
    return this.prisma.withTenant(scope.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      // Inside the lock, so two concurrent first-use requests cannot race on
      // creating the scope row either.
      await tx.meriExecutionScope.upsert({
        where: { id: scope.executionScopeId },
        create: {
          id: scope.executionScopeId,
          tenantId: scope.tenantId,
          principalType: scope.actorType,
          principalId: scope.actorId,
          kind: 'private',
          authorizationVersion: scope.authorizationVersion,
        },
        update: { authorizationVersion: scope.authorizationVersion },
      });
      const row = await tx.meriExecutionScope.findUnique({
        where: { id: scope.executionScopeId },
        select: { workerState: true },
      });
      const state = parseWorkerState(row?.workerState);

      if (state?.status === 'healthy' && state.url) {
        await tx.meriExecutionScope.update({
          where: { id: scope.executionScopeId },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { workerState: { ...state, lastActivityAt: now.toISOString() } as any },
        });
        return { role: 'cached' as const, url: state.url };
      }

      if (state?.status === 'provisioning' && !this.provisioningClaimAbandoned(state, cfg, now)) {
        // Someone else is already provisioning this scope RIGHT NOW. Do not
        // start a second worker; wait for theirs.
        return { role: 'waiter' as const };
      }

      const claim: MeriHermesWorkerState = {
        ...emptyState(now),
        taskArn: state?.taskArn ?? null,
        taskDefinitionArn: state?.taskDefinitionArn ?? null,
        accessPointId: state?.accessPointId ?? null,
        createdAt: state?.createdAt ?? now.toISOString(),
        status: 'provisioning',
      };
      await tx.meriExecutionScope.update({
        where: { id: scope.executionScopeId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { workerState: claim as any },
      });
      return { role: 'owner' as const, claim, previous: state };
    });
  }

  /** A `provisioning` row nobody has touched for longer than an owner could legitimately take. */
  private provisioningClaimAbandoned(
    state: MeriHermesWorkerState,
    cfg: ResolvedLifecycleConfig,
    now: Date,
  ): boolean {
    const claimedAtMs = Date.parse(state.updatedAt);
    if (!Number.isFinite(claimedAtMs)) return true;
    return now.getTime() - claimedAtMs > cfg.provisionTimeoutMs + PROVISION_CLAIM_SLACK_MS;
  }

  /**
   * The waiter side of the fence: poll the row the owner is writing. Returns
   * the owner's URL (so every concurrent caller resolves to the SAME worker),
   * surfaces the owner's failure, or — if the owner disappears — re-enters the
   * claim and may provision after all.
   */
  private async awaitProvisionedWorker(
    scope: MeriHermesWorkerScopeRef,
    cfg: ResolvedLifecycleConfig,
    handoff: number,
  ): Promise<MeriHermesResolvedWorker> {
    const deadline = this.clock().getTime() + cfg.provisionTimeoutMs + PROVISION_CLAIM_SLACK_MS;
    for (;;) {
      await this.sleep(this.pollIntervalMs);
      const state = await this.readWorkerState(scope.tenantId, scope.executionScopeId);
      if (state?.status === 'healthy' && state.url) {
        await this.touchActivity(scope, state);
        return { url: state.url };
      }
      if (state?.status === 'failed') {
        throw new MeriHermesWorkerProvisioningError(
          state.lastError ?? `worker provisioning failed for scope ${scope.executionScopeId}`,
        );
      }
      const abandoned =
        !state ||
        state.status === 'stopped' ||
        (state.status === 'provisioning' && this.provisioningClaimAbandoned(state, cfg, this.clock()));
      if (abandoned) {
        if (handoff >= MAX_PROVISION_HANDOFFS) {
          throw new MeriHermesWorkerProvisioningTimeoutError(
            `Provisioning for scope ${scope.executionScopeId} was abandoned repeatedly`,
          );
        }
        return this.resolveWorkerFenced(scope, handoff + 1);
      }
      if (this.clock().getTime() >= deadline) {
        throw new MeriHermesWorkerProvisioningTimeoutError(
          `Timed out waiting for another request to finish provisioning the worker for scope ${scope.executionScopeId}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Provisioning
  // ---------------------------------------------------------------------------

  /** Called ONLY by the winner of `claimProvisioningSlot()`; the row is already marked `provisioning`. */
  private async provision(
    scope: MeriHermesWorkerScopeRef,
    claim: MeriHermesWorkerState,
    previous: MeriHermesWorkerState | null,
    cfg: ResolvedLifecycleConfig,
  ): Promise<MeriHermesResolvedWorker> {
    const now = this.clock();
    await this.stopSupersededTask(previous, cfg);

    try {
      const signingKey = this.env.MERI_HERMES_BROKER_SIGNING_KEY?.trim() ?? '';
      const { token } = mintMeriHermesWorkerToken(
        {
          executionScopeId: scope.executionScopeId,
          tenantId: scope.tenantId,
          actorType: scope.actorType,
          actorId: scope.actorId,
          authorizationVersion: scope.authorizationVersion,
        },
        signingKey,
        now,
      );

      const accessPointId = claim.accessPointId ?? (await this.ensureAccessPoint(scope, cfg));
      const taskDefinitionArn =
        claim.taskDefinitionArn ?? (await this.ensureScopeTaskDefinition(scope, accessPointId, cfg));

      const taskArn = await this.runTask(scope, taskDefinitionArn, token, cfg);
      const ip = await this.waitForRunningIp(cfg, taskArn);
      const url = `http://${ip}:${cfg.workerPort}`;
      await this.waitForHealthy(url, cfg);

      const finalNow = this.clock();
      const finalState: MeriHermesWorkerState = {
        status: 'healthy',
        taskArn,
        taskDefinitionArn,
        accessPointId,
        url,
        createdAt: claim.createdAt,
        updatedAt: finalNow.toISOString(),
        lastHealthCheckAt: finalNow.toISOString(),
        lastActivityAt: finalNow.toISOString(),
        lastError: null,
      };
      await this.writeWorkerState(scope.tenantId, scope.executionScopeId, finalState);
      return { url };
    } catch (error) {
      const wrapped =
        error instanceof MeriHermesWorkerProvisioningError
          ? error
          : new MeriHermesWorkerProvisioningError(error instanceof Error ? error.message : String(error));
      this.logger.error(`worker provisioning failed for scope ${scope.executionScopeId}: ${wrapped.message}`);
      // Structured single-line JSON so the CDK-side CloudWatch metric filter
      // (MeriHermesWorkerFleet's optional apiLogGroup alarm) can find it.
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          event: 'meri_hermes_worker_provisioning',
          failed: 1,
          executionScopeId: scope.executionScopeId,
          tenantId: scope.tenantId,
          reason: wrapped.message,
        }),
      );
      await this.writeWorkerState(scope.tenantId, scope.executionScopeId, {
        ...claim,
        status: 'failed',
        lastError: wrapped.message,
        updatedAt: this.clock().toISOString(),
      }).catch(() => undefined);
      throw wrapped;
    }
  }

  /**
   * Best-effort stop of a task left behind by a previous lifecycle of this
   * scope. `teardownIfIdle()` marks the row `stopped` BEFORE calling
   * `StopTask` (so two replicas can never both issue the stop) and keeps the
   * `taskArn`, which means a replica that died in that window leaves a task
   * nothing references. Re-provisioning the same scope is exactly when that
   * can be cleaned up, and it is also what keeps the single-writer-per-scope
   * invariant true if the old task somehow survived.
   */
  private async stopSupersededTask(
    previous: MeriHermesWorkerState | null,
    cfg: ResolvedLifecycleConfig,
  ): Promise<void> {
    if (!previous?.taskArn) return;
    if (previous.status !== 'stopped' && previous.status !== 'failed') return;
    await this.ecs
      .send(
        new StopTaskCommand({
          cluster: cfg.clusterArn,
          task: previous.taskArn,
          reason: 'meri-hermes superseded worker task',
        }),
      )
      .catch(() => undefined); // already gone in the overwhelming majority of cases
  }

  private async ensureAccessPoint(scope: MeriHermesWorkerScopeRef, cfg: ResolvedLifecycleConfig): Promise<string> {
    const path = scopeHomePath(scope.executionScopeId);
    const described = await this.efs.send(new DescribeAccessPointsCommand({ FileSystemId: cfg.fileSystemId }));
    const found = described.AccessPoints?.find((ap) => ap.RootDirectory?.Path === path);
    if (found?.AccessPointId) return found.AccessPointId;

    const created = await this.efs.send(
      new CreateAccessPointCommand({
        FileSystemId: cfg.fileSystemId,
        ClientToken: scopeAccessPointClientToken(scope.executionScopeId),
        PosixUser: { Uid: 1000, Gid: 1000 },
        RootDirectory: {
          Path: path,
          CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '0755' },
        },
        Tags: [
          { Key: 'capiro:executionScopeId', Value: scope.executionScopeId },
          { Key: 'capiro:tenantId', Value: scope.tenantId },
        ],
      }),
    );
    if (!created.AccessPointId) {
      throw new MeriHermesWorkerProvisioningError('EFS CreateAccessPoint returned no access point id');
    }
    return created.AccessPointId;
  }

  /**
   * Clone the CDK-managed template task definition, adding an EFS volume
   * bound to this scope's access point (see class doc: RunTask cannot select
   * a volume per call, so a per-scope revision is the real mechanism).
   */
  private async ensureScopeTaskDefinition(
    scope: MeriHermesWorkerScopeRef,
    accessPointId: string,
    cfg: ResolvedLifecycleConfig,
  ): Promise<string> {
    const described = await this.ecs.send(
      new DescribeTaskDefinitionCommand({ taskDefinition: cfg.taskDefinitionFamily }),
    );
    const template = described.taskDefinition;
    if (!template) {
      throw new MeriHermesWorkerProvisioningError(
        `ECS task definition family "${cfg.taskDefinitionFamily}" was not found`,
      );
    }
    const volumeName = 'hermes-home';
    const containerDefinitions: ContainerDefinition[] = (template.containerDefinitions ?? []).map((c) => {
      if (c.name !== cfg.containerName) return c;
      return {
        ...c,
        mountPoints: [...(c.mountPoints ?? []), { sourceVolume: volumeName, containerPath: '/opt/data', readOnly: false }],
      };
    });
    const registered = await this.ecs.send(
      new RegisterTaskDefinitionCommand({
        family: scopeTaskDefinitionFamily(cfg.taskDefinitionFamily, scope.executionScopeId),
        taskRoleArn: template.taskRoleArn,
        executionRoleArn: template.executionRoleArn,
        networkMode: template.networkMode,
        cpu: template.cpu,
        memory: template.memory,
        requiresCompatibilities: template.requiresCompatibilities,
        runtimePlatform: template.runtimePlatform,
        containerDefinitions,
        volumes: [
          {
            name: volumeName,
            efsVolumeConfiguration: {
              fileSystemId: cfg.fileSystemId,
              transitEncryption: 'ENABLED',
              authorizationConfig: { accessPointId, iam: 'ENABLED' },
            },
          },
        ],
        tags: [{ key: 'capiro:executionScopeId', value: scope.executionScopeId }],
      }),
    );
    const arn = registered.taskDefinition?.taskDefinitionArn;
    if (!arn) throw new MeriHermesWorkerProvisioningError('ECS RegisterTaskDefinition returned no ARN');
    return arn;
  }

  /** Phase 1 persona materialization (contracts.md §8) is a separate ticket; this reads a single process-wide override, not a per-tenant render. */
  private buildSoulOverride(): { name: string; value: string }[] {
    const soul = this.env.MERI_HERMES_SOUL_B64?.trim();
    return soul ? [{ name: 'MERI_SOUL_B64', value: soul }] : [];
  }

  private async runTask(
    scope: MeriHermesWorkerScopeRef,
    taskDefinitionArn: string,
    token: string,
    cfg: ResolvedLifecycleConfig,
  ): Promise<string> {
    const result = await this.ecs.send(
      new RunTaskCommand({
        cluster: cfg.clusterArn,
        taskDefinition: taskDefinitionArn,
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: cfg.subnetIds,
            securityGroups: [cfg.securityGroupId],
            assignPublicIp: 'DISABLED',
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: cfg.containerName,
              environment: [
                { name: 'MERI_EXECUTION_SCOPE_ID', value: scope.executionScopeId },
                { name: 'MERI_WORKER_TOKEN', value: token },
                ...this.buildSoulOverride(),
              ],
            },
          ],
        },
        tags: [{ key: 'capiro:executionScopeId', value: scope.executionScopeId }],
      }),
    );
    const failure = result.failures?.[0];
    if (failure) {
      throw new MeriHermesWorkerProvisioningError(
        `ECS RunTask failed: ${failure.reason ?? 'unknown'}${failure.detail ? ` (${failure.detail})` : ''}`,
      );
    }
    const taskArn = result.tasks?.[0]?.taskArn;
    if (!taskArn) throw new MeriHermesWorkerProvisioningError('ECS RunTask returned no task ARN');
    return taskArn;
  }

  private async waitForRunningIp(cfg: ResolvedLifecycleConfig, taskArn: string): Promise<string> {
    const deadline = this.clock().getTime() + cfg.provisionTimeoutMs;
    for (;;) {
      const described = await this.ecs.send(
        new DescribeTasksCommand({ cluster: cfg.clusterArn, tasks: [taskArn] }),
      );
      const task = described.tasks?.[0];
      if (task?.lastStatus === 'STOPPED') {
        throw new MeriHermesWorkerProvisioningError(
          `ECS task stopped before becoming RUNNING (${task.stoppedReason ?? 'unknown reason'})`,
        );
      }
      if (task?.lastStatus === 'RUNNING') {
        const ip = extractPrivateIp(task);
        if (!ip) throw new MeriHermesWorkerProvisioningError('ECS task is RUNNING but reported no private IP address');
        return ip;
      }
      if (this.clock().getTime() >= deadline) {
        throw new MeriHermesWorkerProvisioningTimeoutError(
          `Timed out waiting for ECS task ${taskArn} to reach RUNNING`,
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async waitForHealthy(url: string, cfg: ResolvedLifecycleConfig): Promise<void> {
    const deadline = this.clock().getTime() + cfg.provisionTimeoutMs;
    const probe = MeriHermesRuntimeClient.withEnv({ ...this.env, MERI_HERMES_RUNTIME_URL: url }, this.fetchImpl);
    for (;;) {
      const health = await probe.health();
      if (health.ok) return;
      if (this.clock().getTime() >= deadline) {
        throw new MeriHermesWorkerProvisioningTimeoutError(`Timed out waiting for ${url}/health to become healthy`);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // Idle-grace teardown (P1-04; NOT wired to a scheduler in this pass)
  // ---------------------------------------------------------------------------

  /**
   * Stops a single scope's worker if it has been idle at least `idleGraceMs`
   * AND the scope has no active (non-terminal) `MeriAgentRun`. There is no
   * background-review tracking in this codebase yet (see class doc), so that
   * is the only gate — deliberately, not an oversight.
   */
  async teardownIfIdle(
    scope: { tenantId: string; executionScopeId: string },
    idleGraceMs?: number,
    now: Date = this.clock(),
  ): Promise<MeriHermesIdleTeardownOutcome> {
    const cfg = this.resolveConfig();
    const grace = idleGraceMs ?? cfg.idleGraceMs;

    const active = await this.runs.listActiveForScope(scope.executionScopeId);
    if (active.length > 0) {
      // Cheap pre-check outside the lock; re-checking inside would mean
      // holding the lock across another query for no added safety — an active
      // run can only APPEAR after this point, and `resolveWorker()` takes the
      // same lock, so a scope that wakes up re-provisions rather than racing.
      const state = await this.readWorkerState(scope.tenantId, scope.executionScopeId);
      if (state && state.taskArn && state.status !== 'stopped') return 'skipped_active';
    }

    /**
     * The teardown decision is claimed under the SAME per-scope advisory lock
     * `resolveWorker()` uses, and the row is marked `stopped` INSIDE that
     * transaction — before `StopTask` is called. Two replicas sweeping the
     * same idle scope therefore cannot both issue a stop: the loser reads
     * `stopped` and reports `skipped_no_worker`. `taskArn` is deliberately
     * retained on the stopped row so a replica that dies before `StopTask`
     * returns still leaves a trail (`stopSupersededTask()`).
     */
    const lockKey = workerProvisioningLockKey(scope.executionScopeId);
    const claimed = await this.prisma.withTenant(scope.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const row = await tx.meriExecutionScope.findUnique({
        where: { id: scope.executionScopeId },
        select: { workerState: true },
      });
      const state = parseWorkerState(row?.workerState);
      if (!state || !state.taskArn || state.status === 'stopped') {
        return { outcome: 'skipped_no_worker' as const, taskArn: null };
      }
      const lastActivityMs = state.lastActivityAt ? new Date(state.lastActivityAt).getTime() : 0;
      if (now.getTime() - lastActivityMs < grace) {
        return { outcome: 'skipped_not_idle' as const, taskArn: null };
      }
      await tx.meriExecutionScope.update({
        where: { id: scope.executionScopeId },
        data: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          workerState: { ...state, status: 'stopped', url: null, updatedAt: now.toISOString() } as any,
        },
      });
      return { outcome: 'stopped' as const, taskArn: state.taskArn };
    });

    if (!claimed.taskArn) return claimed.outcome;

    await this.ecs
      .send(new StopTaskCommand({ cluster: cfg.clusterArn, task: claimed.taskArn, reason: 'meri-hermes idle grace teardown' }))
      .catch((error) => {
        this.logger.warn(
          `StopTask for idle scope ${scope.executionScopeId} failed (task may already be gone): ${String(error)}`,
        );
      });
    return 'stopped';
  }

  /**
   * Cross-tenant sweep over every scope with a currently-healthy worker,
   * tearing down the idle ones.
   *
   * Phase 1 required fix 2a: this now HAS a production caller —
   * `MeriHermesMaintenanceService` (bottom of this file) runs it on an
   * interval. It is bounded (`limit`, oldest-idle first) so one tick can
   * never turn into an unbounded fleet-wide stop storm, and each individual
   * teardown is fenced per scope, so several replicas sweeping at once still
   * issue at most one `StopTask` per worker.
   */
  async sweepIdleWorkers(
    idleGraceMs?: number,
    now: Date = this.clock(),
    limit: number = DEFAULT_IDLE_SWEEP_BATCH,
  ): Promise<{ scanned: number; stopped: number }> {
    const cfg = this.resolveConfig();
    const grace = idleGraceMs ?? cfg.idleGraceMs;
    const cutoff = new Date(now.getTime() - grace);
    const candidates = await this.prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ id: string; tenant_id: string }>>`
        SELECT id, tenant_id FROM meri_execution_scopes
        WHERE worker_state_jsonb ->> 'status' = 'healthy'
          AND worker_state_jsonb ->> 'lastActivityAt' IS NOT NULL
          AND (worker_state_jsonb ->> 'lastActivityAt')::timestamptz < ${cutoff}
        ORDER BY (worker_state_jsonb ->> 'lastActivityAt')::timestamptz ASC
        LIMIT ${limit}
      `,
    );
    let stopped = 0;
    for (const row of candidates) {
      const outcome = await this.teardownIfIdle({ tenantId: row.tenant_id, executionScopeId: row.id }, grace, now);
      if (outcome === 'stopped') stopped += 1;
    }
    return { scanned: candidates.length, stopped };
  }

  /**
   * Whether the Fargate worker fleet is configured in THIS process's
   * environment. The maintenance scheduler uses it to skip the idle sweep
   * (which needs a cluster ARN to stop anything) instead of throwing once a
   * minute in every environment where the fleet does not exist yet.
   */
  fleetConfigured(): boolean {
    try {
      this.resolveConfig();
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Worker state persistence (MeriExecutionScope.workerState)
  // ---------------------------------------------------------------------------

  private async touchActivity(scope: MeriHermesWorkerScopeRef, state: MeriHermesWorkerState): Promise<void> {
    await this.writeWorkerState(scope.tenantId, scope.executionScopeId, {
      ...state,
      lastActivityAt: this.clock().toISOString(),
    });
  }

  // (The scope row upsert that used to live here moved INTO
  // `claimProvisioningSlot()` so it happens under the per-scope advisory
  // lock, together with the claim it belongs to.)

  private async readWorkerState(tenantId: string, executionScopeId: string): Promise<MeriHermesWorkerState | null> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.meriExecutionScope.findUnique({ where: { id: executionScopeId }, select: { workerState: true } }),
    );
    return row ? parseWorkerState(row.workerState) : null;
  }

  private async writeWorkerState(
    tenantId: string,
    executionScopeId: string,
    state: MeriHermesWorkerState,
  ): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.meriExecutionScope.update({
        where: { id: executionScopeId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { workerState: state as any },
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Configuration (env-var names only; values live in the task definition —
  // see infra/cdk MeriHermesWorkerFleet's CfnOutputs for what to set them to)
  // ---------------------------------------------------------------------------

  private resolveConfig(): ResolvedLifecycleConfig {
    const subnetIds = (this.env.MERI_HERMES_SUBNET_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (subnetIds.length === 0) throw new Error('MERI_HERMES_SUBNET_IDS is not configured');
    const workerPort = Number(this.env.MERI_HERMES_WORKER_PORT ?? '');
    const provisionTimeoutMs = Number(this.env.MERI_HERMES_PROVISION_TIMEOUT_MS ?? '');
    const idleGraceMs = Number(this.env.MERI_HERMES_WORKER_IDLE_GRACE_MS ?? '');
    return {
      clusterArn: this.requireEnv('MERI_HERMES_ECS_CLUSTER_ARN'),
      taskDefinitionFamily: this.requireEnv('MERI_HERMES_TASK_DEFINITION_FAMILY'),
      subnetIds,
      securityGroupId: this.requireEnv('MERI_HERMES_SECURITY_GROUP_ID'),
      fileSystemId: this.requireEnv('MERI_HERMES_EFS_FILE_SYSTEM_ID'),
      containerName: this.env.MERI_HERMES_WORKER_CONTAINER_NAME?.trim() || DEFAULT_CONTAINER_NAME,
      workerPort: Number.isFinite(workerPort) && workerPort > 0 ? workerPort : DEFAULT_WORKER_PORT,
      provisionTimeoutMs:
        Number.isFinite(provisionTimeoutMs) && provisionTimeoutMs > 0
          ? provisionTimeoutMs
          : DEFAULT_PROVISION_TIMEOUT_MS,
      idleGraceMs: Number.isFinite(idleGraceMs) && idleGraceMs > 0 ? idleGraceMs : DEFAULT_IDLE_GRACE_MS,
    };
  }

  private requireEnv(name: string): string {
    const value = this.env[name]?.trim();
    if (!value) throw new Error(`${name} is not configured`);
    return value;
  }
}

// =============================================================================
// Scheduled maintenance — the PRODUCTION CALLER for crash recovery and
// idle-worker reclamation (Phase 1 required fix 2a)
// =============================================================================

/** Default gap between maintenance ticks. */
const DEFAULT_MAINTENANCE_SWEEP_MS = 60_000;
/** Upper bound on runs recovered per tick, so one replica can never take over the whole fleet's backlog at once. */
const DEFAULT_MAINTENANCE_TAKEOVER_BATCH = 20;

/**
 * The background owner of Hermes crash recovery and worker reclamation.
 *
 * ## Why this exists
 *
 * `MeriHermesRuntimeAdapter.takeOverStaleRuns()` and
 * `MeriHermesWorkerLifecycleService.sweepIdleWorkers()` were both implemented
 * and unit-tested with NOTHING in production calling them. The consequences
 * were real, not theoretical: a run whose owning replica died was never
 * finished by anybody, and an idle Fargate worker was never reclaimed — the
 * first is a user staring at a turn that will never end, the second is a bill.
 * The request-driven half (`sweepStaleConsumers()` on the conversation
 * discovery endpoint, `reconcileStuckDispatches()` on admission) only fires
 * when a client happens to ask, and a crashed replica's orphan is precisely
 * the case where nobody asks — the user's tab is gone.
 *
 * ## Mechanism: the established in-process one, not a new invention
 *
 * apps/api has no `@nestjs/schedule` dependency and no scheduler service. The
 * established mechanism for recurring in-process work here is
 * `OnModuleInit` + `setInterval().unref()` + a re-entrancy flag + an explicit
 * enablement guard — see `src/engagement-workers/*.service.ts` (the module
 * whose doc calls itself "explicit owner of every Engagement background
 * timer") and `ClientProfileFillCompletionService`. This class follows that
 * pattern exactly, including the `HttpAdapterHost` guard those services use.
 *
 * ## Guards (this must never start by accident)
 *
 *  - `NODE_ENV === 'test'`: jest sets it, so no unit test ever starts a
 *    timer. Specs that mean to exercise the scheduler override `env`
 *    explicitly, which is deliberate, visible and impossible to do by
 *    accident.
 *  - No HTTP adapter: `NestFactory.createApplicationContext()` CLI
 *    bootstraps reuse AppModule, run for ~1s and close Prisma underneath any
 *    timer. Same guard, same reason as `ClientProfileFillWorkflowService`.
 *  - `MERI_HERMES_MAINTENANCE_ENABLED=false`: explicit operator kill switch.
 *
 * It is deliberately NOT gated on `MERI_HERMES_ENABLED` / the pilot flags.
 * Those gates stop NEW work being admitted; closing them during a rollback
 * must not strand runs that were already admitted (the same argument
 * `deployment-validation-and-rollback.md` makes for Stop, and the same reason
 * `MeriHermesController.ownedRun()` does not gate control of an existing
 * run). With no Hermes traffic the tick costs one indexed query.
 *
 * ## Multiple replicas
 *
 * Every replica runs this, and that is safe:
 *
 *  - NO DUPLICATE TAKEOVERS. Each run is claimed with the atomic, fenced
 *    `claimConsumer()` compare-and-set; the losers get `not_claimed` and do
 *    nothing. Proved in `meri-hermes-maintenance.worker.spec.ts`.
 *  - NO DUPLICATE STOPS. Idle teardown claims the scope under the per-scope
 *    advisory lock and marks the row `stopped` before calling `StopTask`.
 *  - BOUNDED PER TICK. At most `DEFAULT_MAINTENANCE_TAKEOVER_BATCH` runs and
 *    `DEFAULT_IDLE_SWEEP_BATCH` scopes per tick, and a re-entrancy flag means
 *    a slow tick delays the next one instead of overlapping it.
 *  - NO THUNDERING HERD. The first tick is delayed by a random fraction of
 *    the interval, so N replicas that booted together do not scan in
 *    lockstep. (A distributed tick lock would add nothing: the herd is one
 *    indexed SELECT, and every unit of real work is individually fenced.)
 */
@Injectable()
export class MeriHermesMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeriHermesMaintenanceService.name);

  /** Settable rather than a constructor parameter, like every other seam in this module. */
  env: NodeJS.ProcessEnv = process.env;

  private timer?: ReturnType<typeof setInterval>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(
    private readonly adapter: MeriHermesRuntimeAdapter,
    private readonly workers: MeriHermesWorkerLifecycleService,
    @Optional() private readonly httpAdapterHost?: HttpAdapterHost,
  ) {}

  /** The one place the start decision is made, so the spec can assert it without starting anything. */
  shouldStart(): boolean {
    if (this.env.NODE_ENV === 'test') return false;
    if (this.env.MERI_HERMES_MAINTENANCE_ENABLED === 'false') return false;
    if (!this.httpAdapterHost?.httpAdapter) return false;
    return true;
  }

  sweepIntervalMs(): number {
    const configured = Number(this.env.MERI_HERMES_MAINTENANCE_SWEEP_MS ?? '');
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAINTENANCE_SWEEP_MS;
  }

  onModuleInit(): void {
    if (this.timer || this.startTimer || !this.shouldStart()) return;
    const everyMs = this.sweepIntervalMs();
    // Random phase offset: replicas that boot together must not sweep together.
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      this.timer = setInterval(() => void this.tick(), everyMs);
      this.timer.unref?.();
      void this.tick();
    }, Math.floor(Math.random() * everyMs));
    this.startTimer.unref?.();
    this.logger.log(`Meri/Hermes maintenance sweep started (every ${everyMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.timer) clearInterval(this.timer);
    this.startTimer = undefined;
    this.timer = undefined;
  }

  /** One maintenance pass. Public so a spec can drive it deterministically; the timer calls exactly this. */
  async runOnce(): Promise<{ reconciled: number; recovered: number; workersStopped: number }> {
    let reconciled = 0;
    let recovered = 0;
    let workersStopped = 0;

    // 1. Admitted-but-never-dispatched runs (P1-07). Already wired on the
    //    admission and discovery paths; a crashed replica's row still needs
    //    clearing when no request ever comes.
    reconciled = await this.adapter
      .reconcileStuckDispatches()
      .catch((error) => {
        this.logger.warn(`scheduled dispatch reconciliation failed: ${String(error)}`);
        return 0;
      });

    // 2. Runs whose consuming replica died (P1-09). Cross-tenant on purpose:
    //    this is a background owner, not a tenant's request, and an orphan
    //    must not depend on its own tenant generating traffic.
    const results = await this.adapter
      .takeOverStaleRuns(undefined, { limit: DEFAULT_MAINTENANCE_TAKEOVER_BATCH })
      .catch((error) => {
        this.logger.warn(`scheduled stale-consumer recovery failed: ${String(error)}`);
        return [] as Array<{ runId: string; outcome: string }>;
      });
    recovered = results.filter((r) => r.outcome !== 'not_claimed').length;
    if (recovered > 0) this.logger.warn(`recovered ${recovered} orphaned Hermes run(s) from a dead replica`);

    // 3. Idle workers (P1-04). Needs the fleet configuration to stop anything.
    if (this.workers.fleetConfigured()) {
      const swept = await this.workers.sweepIdleWorkers().catch((error) => {
        this.logger.warn(`scheduled idle-worker sweep failed: ${String(error)}`);
        return { scanned: 0, stopped: 0 };
      });
      workersStopped = swept.stopped;
      if (workersStopped > 0) this.logger.log(`stopped ${workersStopped} idle Hermes worker(s)`);
    }

    return { reconciled, recovered, workersStopped };
  }

  private async tick(): Promise<void> {
    if (this.running) return; // a slow tick delays the next one, never overlaps it
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(`Meri/Hermes maintenance tick failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
