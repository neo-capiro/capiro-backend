import type { TenantContext } from '@capiro/shared';
import type { HttpAdapterHost } from '@nestjs/core';
import type { IntelligenceService } from '../intelligence/intelligence.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientFacilitiesService } from './client-facilities.service.js';
import type { ClientProfileFillService } from './client-profile-fill.service.js';
import type { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';
import type { ClientProfileFillWorkflowService } from './client-profile-fill-workflow.service.js';
import type { RefreshScheduleRow } from './client-profile-fill-completion.exports.js';
import type { CompletionTaskRow } from './client-profile-fill-completion-runtime.shared.js';
import type { DiscoveryFinding } from './client-profile-fill-advocacy-discovery.shared.js';
import { MAX_ADVOCACY_FINDINGS } from './client-profile-fill-advocacy-discovery.shared.js';
import { ClientProfileFillAdvocacyHistory } from './client-profile-fill-advocacy-history.js';
import {
  ClientProfileFillFindingReview,
  type FindingReviewPorts,
} from './client-profile-fill-finding-review.js';
import { ClientProfileFillRegulatoryCommentDiscovery } from './client-profile-fill-regulatory-comment-discovery.js';
import { ClientProfileFillRegulatoryCommentSource } from './client-profile-fill-regulatory-comment-source.js';
import {
  ClientProfileFillCompletionPersistence,
  type CompletionFindingInput,
} from './client-profile-fill-completion-persistence.js';
import { ClientProfileFillProfileDiscovery } from './client-profile-fill-profile-discovery.js';
import { ClientProfileFillLifecycleOutcomes } from './client-profile-fill-lifecycle-outcomes.js';
import { ClientProfileFillReconciliation } from './client-profile-fill-reconciliation.js';
import { ClientProfileFillCompletionAudit } from './client-profile-fill-completion-audit.js';
import { ClientProfileFillCompletionRuntime } from './client-profile-fill-completion-runtime.js';
import {
  ClientProfileFillRefreshSchedule,
  type RefreshSchedulePorts,
} from './client-profile-fill-refresh-schedule.js';
import { ClientProfileFillRunReadModel } from './client-profile-fill-run-read-model.js';
import { ClientProfileFillRunLifecycle } from './client-profile-fill-run-lifecycle.js';
import {
  ClientProfileFillTaskRuntime,
  type TaskRuntimePorts,
} from './client-profile-fill-task-runtime.js';
import { ClientProfileFillTaskLedger } from './client-profile-fill-task-ledger.js';

export interface CompletionOwnerDependencies {
  prisma: PrismaService;
  workflow: ClientProfileFillWorkflowService;
  fill: ClientProfileFillService;
  intelligence: IntelligenceService;
  facilities: ClientFacilitiesService;
  httpAdapterHost: HttpAdapterHost;
  advocacyMatters: ClientAdvocacyMatterService;
  workerId: string;
}

/** Explicit late-bound facade seams; construction invokes none of these callbacks. */
export interface CompletionOwnerPorts {
  warn(message: string): void;
  log(message: string): void;
  error(message: string): void;
  safeError(error: unknown): string;
  assertClient(ctx: TenantContext, clientId: string): Promise<void>;
  getRun: FindingReviewPorts['getRun'];
  startRun: RefreshSchedulePorts['startRun'];
  getSchedule(ctx: TenantContext, clientId: string): Promise<RefreshScheduleRow>;
  loadCompletionTasks(
    tenantId: string,
    clientId: string,
    runId: string,
  ): Promise<CompletionTaskRow[]>;
  resolveClientName(ctx: TenantContext, clientId: string): Promise<string | null>;
  confirmedMappingKeys(ctx: TenantContext, clientId: string, source: string): Promise<Set<string>>;
  emitFinding(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    input: DiscoveryFinding,
  ): Promise<boolean>;
  persistFinding(
    tenantId: string,
    clientId: string,
    runId: string,
    input: CompletionFindingInput,
    task?: Pick<CompletionTaskRow, 'id' | 'workerId'>,
  ): Promise<boolean>;
  getCursor(tenantId: string, clientId: string, source: string): Promise<Record<string, unknown>>;
  recordCursor(
    tenantId: string,
    clientId: string,
    source: string,
    watermark: Record<string, unknown>,
  ): Promise<void>;
  executeTask: TaskRuntimePorts['executeTask'];
  requestTaskSweep(): void;
  requestScheduleSweep(): void;
  sweepOnce(): Promise<void>;
  sweepSchedulesOnce(): Promise<void>;
}

function createDiscoveryOwners(
  dependencies: CompletionOwnerDependencies,
  ports: CompletionOwnerPorts,
) {
  const { prisma, fill, advocacyMatters } = dependencies;
  const reporter = { warn: ports.warn, safeError: ports.safeError };
  const regulatoryCommentSource = new ClientProfileFillRegulatoryCommentSource(prisma, reporter);
  const discoveryPorts = {
    ...reporter,
    resolveClientName: ports.resolveClientName,
    confirmedMappingKeys: ports.confirmedMappingKeys,
    emitFinding: ports.emitFinding,
  };
  const regulatoryCommentDiscovery = new ClientProfileFillRegulatoryCommentDiscovery(
    regulatoryCommentSource,
    discoveryPorts,
    MAX_ADVOCACY_FINDINGS,
  );
  const advocacyHistory = new ClientProfileFillAdvocacyHistory(
    prisma,
    advocacyMatters,
    regulatoryCommentDiscovery,
    {
      ...discoveryPorts,
      persistFinding: ports.persistFinding,
      readCursor: ports.getCursor,
      recordCursor: ports.recordCursor,
      readSchedule: ports.getSchedule,
    },
  );
  const findingReview = new ClientProfileFillFindingReview(prisma, fill, advocacyMatters, {
    ...reporter,
    getRun: ports.getRun,
    confirmedMappingKeys: ports.confirmedMappingKeys,
  });
  return { regulatoryCommentSource, regulatoryCommentDiscovery, advocacyHistory, findingReview };
}

function createRuntimeOwners(
  dependencies: CompletionOwnerDependencies,
  ports: CompletionOwnerPorts,
) {
  const { prisma, workflow, httpAdapterHost, workerId } = dependencies;
  const taskLedger = new ClientProfileFillTaskLedger(prisma, workerId, {
    safeError: ports.safeError,
  });
  const runReadModel = new ClientProfileFillRunReadModel(prisma, workflow, {
    loadCompletionTasks: ports.loadCompletionTasks,
    getSchedule: ports.getSchedule,
    assertClient: ports.assertClient,
    getCursor: ports.getCursor,
  });
  const runLifecycle = new ClientProfileFillRunLifecycle(prisma, workflow, {
    assertClient: ports.assertClient,
    hasCompletionTasks: (tenantId, runId) => runReadModel.hasCompletionTasks(tenantId, runId),
    getRun: ports.getRun,
    requestTaskSweep: ports.requestTaskSweep,
  });
  const taskRuntime: ClientProfileFillTaskRuntime = new ClientProfileFillTaskRuntime({
    recoverStaleTasks: () => taskLedger.recoverStaleTasks(),
    claimTasks: () => taskLedger.claimTasks(),
    executeClaimedTask: (task) => taskRuntime.executeClaimedTask(task),
    finalizeRuns: () => runLifecycle.finalizeRuns(),
    loadRunActor: (task) => taskLedger.loadRunActor(task),
    executeTask: ports.executeTask,
    finishTask: (task, status, summary) => taskLedger.finishTask(task, status, summary),
    deferTask: (task, reason) => taskLedger.deferTask(task, reason),
    failTask: (task, error) => taskLedger.failTask(task, error),
    heartbeat: (task) => taskLedger.heartbeat(task),
  });
  const refreshSchedule = new ClientProfileFillRefreshSchedule(prisma, {
    assertClient: ports.assertClient,
    startRun: ports.startRun,
    warn: ports.warn,
    safeError: ports.safeError,
  });
  const completionRuntime = new ClientProfileFillCompletionRuntime(httpAdapterHost, workerId, {
    requestTaskSweep: ports.requestTaskSweep,
    requestScheduleSweep: ports.requestScheduleSweep,
    sweepOnce: ports.sweepOnce,
    sweepSchedulesOnce: ports.sweepSchedulesOnce,
    log: ports.log,
    error: ports.error,
    safeError: ports.safeError,
  });
  return {
    taskLedger,
    runReadModel,
    runLifecycle,
    taskRuntime,
    refreshSchedule,
    completionRuntime,
  };
}

/** Static construction only: ordinary owners retain their own rules, SQL and state. */
export function createClientProfileFillCompletionOwners(
  dependencies: CompletionOwnerDependencies,
  ports: CompletionOwnerPorts,
) {
  const { prisma, intelligence, facilities, advocacyMatters } = dependencies;
  const persistence = new ClientProfileFillCompletionPersistence(prisma);
  const discovery = createDiscoveryOwners(dependencies, ports);
  const runtime = createRuntimeOwners(dependencies, ports);
  const profileDiscovery = new ClientProfileFillProfileDiscovery(prisma, intelligence, facilities, {
    persistFinding: ports.persistFinding,
    recordCursor: ports.recordCursor,
    safeError: ports.safeError,
  });
  const lifecycleOutcomes = new ClientProfileFillLifecycleOutcomes(prisma, {
    persistFinding: ports.persistFinding,
    recordCursor: ports.recordCursor,
  });
  const reconciliation = new ClientProfileFillReconciliation(prisma, advocacyMatters, {
    persistFinding: ports.persistFinding,
    warn: ports.warn,
    safeError: ports.safeError,
  });
  const completionAudit = new ClientProfileFillCompletionAudit(prisma, {
    persistFinding: ports.persistFinding,
  });
  return {
    persistence,
    ...discovery,
    ...runtime,
    profileDiscovery,
    lifecycleOutcomes,
    reconciliation,
    completionAudit,
  };
}
