/**
 * Sequential Package E controller over the existing observation bridge.
 * The controller owns selection/leases/recovery only. The bridge still owns
 * archive materialization, parsing, verification, and durable evidence.
 */
import { randomUUID } from 'node:crypto';
import type {
  ObservationIngestionBridgeExecutionV1,
  ObservationIngestionBridgeResult,
} from '../observation-ingestion-bridge.service.js';
import type { IngestionManifestV1 } from './ingestion-manifest-contract-v1.js';
import {
  INGESTION_MANIFEST_HEARTBEAT_MS_V1,
  type IngestionManifestItemRecordV1,
  type IngestionManifestOperationRecordV1,
  type IngestionManifestRepositoryV1,
} from './ingestion-manifest-repository-v1.js';

export interface IngestionManifestBridgeV1 {
  bridge(
    observationId: string,
    execution?: ObservationIngestionBridgeExecutionV1,
  ): Promise<ObservationIngestionBridgeResult>;
}

export interface RunIngestionManifestDependenciesV1 {
  repository: IngestionManifestRepositoryV1;
  bridge: IngestionManifestBridgeV1;
  heartbeatMs?: number;
  leaseToken?: () => string;
}

export interface IngestionManifestSummaryV1 {
  operationId: string;
  manifestSha256: string;
  status: string;
  selected: number;
  archived: number;
  extracted: number;
  pending: number;
  running: number;
  retryWait: number;
  evidenceReady: number;
  review: number;
  passed: number;
  rejected: number;
  quarantined: number;
  uncertain: number;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number;
  resourceShape: IngestionManifestV1['limits']['resourceShape'];
  costCeiling: IngestionManifestV1['limits']['costCeiling'];
  failureGroups: Array<{
    errorClass: string;
    count: number;
    memberIds: string[];
    retryEligible: boolean;
  }>;
  approvals: 'not_performed';
  readiness: 'not_performed';
  canonicalPublication: 'not_performed';
  items: Array<{
    memberId: string;
    ordinal: number;
    documentKey: string;
    status: string;
    disposition: string | null;
    candidateId: string | null;
    verificationRunId: string | null;
    taskJobId: string | null;
    attempts: number;
    retryEligible: boolean;
    sourceSha256: string;
    archiveBucket: string;
    archiveObjectKey: string;
    archiveVersionId: string;
    artifactId: string | null;
    artifactContentSha256: string | null;
    artifactLocator: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    lastErrorClass: string | null;
    lastErrorMessage: string | null;
  }>;
}

export interface RunIngestionManifestResultV1 {
  outcome:
    | 'preview'
    | 'completed'
    | 'paused'
    | 'busy'
    | 'uncertain'
    | 'conflict'
    | 'ineligible';
  summary: IngestionManifestSummaryV1 | null;
  preflightIssues: Array<{ memberId: string; code: string; detail: string }>;
}

function summary(operation: IngestionManifestOperationRecordV1): IngestionManifestSummaryV1 {
  const count = (predicate: (item: IngestionManifestItemRecordV1) => boolean) =>
    operation.items.filter(predicate).length;
  const failures = new Map<string, { memberIds: string[]; retryEligible: boolean }>();
  for (const item of operation.items) {
    if (!item.lastErrorClass) continue;
    const existing = failures.get(item.lastErrorClass) ?? { memberIds: [], retryEligible: false };
    existing.memberIds.push(item.id);
    existing.retryEligible ||= item.status === 'retry_wait' && item.attempts < item.member.retry.maxAttempts;
    failures.set(item.lastErrorClass, existing);
  }
  const completedAt = operation.completedAt;
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  return {
    operationId: operation.id,
    manifestSha256: operation.manifestSha256,
    status: operation.status,
    selected: operation.items.length,
    archived: operation.items.length,
    extracted: count(item => item.candidateId != null),
    pending: count(item => item.status === 'pending'),
    running: count(item => item.status === 'running'),
    retryWait: count(item => item.status === 'retry_wait'),
    evidenceReady: count(item => item.status === 'evidence_ready'),
    review: count(item => item.parserDisposition === 'REVIEW'),
    passed: count(item => item.parserDisposition === 'PASS'),
    rejected: count(item => item.parserDisposition === 'REJECT'),
    quarantined: count(item => item.status === 'quarantined'),
    uncertain: count(item => item.status === 'uncertain'),
    startedAt: operation.startedAt,
    completedAt,
    elapsedMs: Math.max(0, end - new Date(operation.startedAt).getTime()),
    resourceShape: operation.manifest.limits.resourceShape,
    costCeiling: operation.manifest.limits.costCeiling,
    failureGroups: [...failures.entries()].map(([errorClass, value]) => ({
      errorClass, count: value.memberIds.length, memberIds: value.memberIds,
      retryEligible: value.retryEligible,
    })),
    approvals: 'not_performed', readiness: 'not_performed', canonicalPublication: 'not_performed',
    items: operation.items.map(item => {
      const terminal = item.terminal ?? {};
      return {
        memberId: item.id, ordinal: item.ordinal, documentKey: item.member.documentKey,
        status: item.status, disposition: item.parserDisposition,
        candidateId: item.candidateId, verificationRunId: item.verificationRunId,
        taskJobId: item.taskJobId, attempts: item.attempts,
        retryEligible: item.status === 'retry_wait' && item.attempts < item.member.retry.maxAttempts,
        sourceSha256: item.sourceSha256,
        archiveBucket: item.member.archive.bucket,
        archiveObjectKey: item.member.archive.objectKey,
        archiveVersionId: item.member.archive.versionId,
        artifactId: terminal.artifactId == null ? null : String(terminal.artifactId),
        artifactContentSha256: terminal.artifactContentSha256 == null ? null : String(terminal.artifactContentSha256),
        artifactLocator: terminal.artifactLocator == null ? null : String(terminal.artifactLocator),
        startedAt: item.startedAt, finishedAt: item.finishedAt,
        lastErrorClass: item.lastErrorClass, lastErrorMessage: item.lastErrorMessage,
      };
    }),
  };
}

function deterministicBridgeFailure(result: ObservationIngestionBridgeResult): boolean {
  return [
    'rejected', 'blocked', 'source_bytes_changed', 'verification_rejected',
  ].includes(result.status);
}

function errorDetail(result: ObservationIngestionBridgeResult): string {
  return result.reason ?? result.parserHandoffError ?? `bridge ended in ${result.status}`;
}

function backoffMs(item: IngestionManifestItemRecordV1): number {
  if (item.member.retry.classification !== 'transient_only') return 0;
  const exponent = Math.max(0, item.attempts - 1);
  return Math.min(item.member.retry.initialBackoffSeconds * 1_000 * 2 ** exponent, 60 * 60 * 1_000);
}

export class RunIngestionManifestV1 {
  constructor(private readonly deps: RunIngestionManifestDependenciesV1) {}

  async preview(manifest: IngestionManifestV1): Promise<RunIngestionManifestResultV1> {
    const preflight = await this.deps.repository.preflight(manifest);
    return {
      outcome: preflight.eligible ? 'preview' : 'ineligible',
      summary: null,
      preflightIssues: preflight.issues,
    };
  }

  async run(
    manifest: IngestionManifestV1,
    options: { taskJobId: string; resume?: boolean },
  ): Promise<RunIngestionManifestResultV1> {
    if (!options.taskJobId.trim()) throw new Error('taskJobId is required');
    if (options.resume) {
      const existing = await this.deps.repository.read(manifest.operationId);
      if (!existing) return {
        outcome: 'ineligible', summary: null, preflightIssues: [{
          memberId: manifest.operationId,
          code: 'RESUME_OPERATION_NOT_FOUND',
          detail: 'resume requires an already-registered operation; use start for new work',
        }],
      };
      if (existing.manifestSha256 !== manifest.contentSha256) return {
        outcome: 'conflict', summary: summary(existing), preflightIssues: [{
          memberId: manifest.operationId,
          code: 'RESUME_MANIFEST_HASH_CONFLICT',
          detail: 'stored operation manifest hash differs from the supplied manifest',
        }],
      };
      const resumed = await this.deps.repository.resume(manifest.operationId);
      if (resumed === 'uncertain') {
        const operation = await this.deps.repository.read(manifest.operationId);
        return { outcome: 'uncertain', summary: operation ? summary(operation) : null, preflightIssues: [] };
      }
    } else {
      const registered = await this.deps.repository.register(manifest);
      if (registered.outcome === 'conflict' || registered.outcome === 'ineligible') {
        return {
          outcome: registered.outcome,
          summary: registered.operation ? summary(registered.operation) : null,
          preflightIssues: registered.issues,
        };
      }
    }

    while (true) {
      const leaseToken = (this.deps.leaseToken ?? randomUUID)();
      const claim = await this.deps.repository.claimNext({
        operationId: manifest.operationId, leaseToken, taskJobId: options.taskJobId,
      });
      if (claim.outcome !== 'claimed' && claim.outcome !== 'evidence_ready') {
        const operation = await this.deps.repository.read(manifest.operationId);
        const resultSummary = operation ? summary(operation) : null;
        const outcome = claim.outcome === 'complete' || operation?.status === 'completed'
          ? 'completed'
          : claim.outcome === 'busy' ? 'busy'
            : claim.outcome === 'uncertain' || (resultSummary?.uncertain ?? 0) > 0 ? 'uncertain' : 'paused';
        return { outcome, summary: resultSummary, preflightIssues: [] };
      }
      const item = claim.item!;
      const context = { operationId: manifest.operationId, itemId: item.id, leaseToken };
      if (claim.outcome === 'evidence_ready') {
        if (!await this.deps.repository.finalizeEvidence(context)) {
          const operation = await this.deps.repository.read(manifest.operationId);
          return { outcome: 'uncertain', summary: operation ? summary(operation) : null, preflightIssues: [] };
        }
        continue;
      }

      let leaseLost = false;
      let heartbeatInFlight: Promise<void> | null = null;
      const abortController = new AbortController();
      const heartbeat = setInterval(() => {
        if (heartbeatInFlight) return;
        heartbeatInFlight = this.deps.repository.heartbeat(context)
          .then(ok => { if (!ok) leaseLost = true; })
          .catch(() => { leaseLost = true; })
          .finally(() => { heartbeatInFlight = null; });
      }, this.deps.heartbeatMs ?? INGESTION_MANIFEST_HEARTBEAT_MS_V1);
      heartbeat.unref();
      const claimedOperation = await this.deps.repository.read(manifest.operationId);
      const operationRemainingMs = claimedOperation
        ? new Date(claimedOperation.deadlineAt).getTime() - Date.now()
        : 0;
      const documentDeadlineMs =
        new Date(item.startedAt ?? new Date().toISOString()).getTime() +
        item.member.timeoutSeconds * 1_000;
      const executionBudgetMs = Math.max(
        1,
        Math.min(item.member.timeoutSeconds * 1_000, operationRemainingMs, documentDeadlineMs - Date.now()),
      );
      let executionTimedOut = false;
      let timeoutStopInFlight: Promise<void> | null = null;
      let rejectAtDeadline: ((reason: Error) => void) | null = null;
      const executionDeadline = new Promise<never>((_resolve, reject) => {
        rejectAtDeadline = reject;
      });
      const timeout = setTimeout(() => {
        executionTimedOut = true;
        const deadlineError = new Error('Package E execution deadline exceeded');
        abortController.abort(deadlineError);
        timeoutStopInFlight = this.deps.repository.requestStop(manifest.operationId)
          .then(() => undefined)
          .catch(() => undefined);
        rejectAtDeadline?.(deadlineError);
      }, executionBudgetMs);
      timeout.unref();
      try {
        const governedExecution = {
          executionId: `manifest-${manifest.operationId}-${item.id}`,
          abortSignal: abortController.signal,
          verificationPersistenceFence: this.deps.repository.persistenceFence(context),
          onTerminal: async (terminal: Parameters<NonNullable<ObservationIngestionBridgeExecutionV1['governedExecution']>['onTerminal']>[0]) => {
            if (leaseLost || executionTimedOut || abortController.signal.aborted) {
              throw new Error('manifest ownership or execution deadline was lost; refusing terminal checkpoint');
            }
            if (!await this.deps.repository.checkpointTerminal(context, { ...terminal })) {
              throw new Error('manifest terminal checkpoint refused');
            }
          },
        } satisfies ObservationIngestionBridgeExecutionV1['governedExecution'];
        // The bridge receives the same abort signal for cooperative cleanup,
        // but the controller also races it against the durable deadline. A
        // stuck DB/S3/runtime dependency therefore cannot keep the owning
        // task blocked past the execution envelope. Any late bridge work is
        // fenced by the aborted signal, expired/cleared lease, and the
        // repository persistence fence before it can become authoritative.
        const bridge = await Promise.race([
          this.deps.bridge.bridge(item.observationId, { governedExecution }),
          executionDeadline,
        ]);
        const current = await this.deps.repository.read(manifest.operationId);
        const currentItem = current?.items.find(candidate => candidate.id === item.id);
        if (currentItem?.status === 'evidence_ready') {
          if (!await this.deps.repository.finalizeEvidence(context)) {
            return { outcome: 'uncertain', summary: current ? summary(current) : null, preflightIssues: [] };
          }
          continue;
        }
        if (executionTimedOut || leaseLost) {
          if (timeoutStopInFlight) await timeoutStopInFlight;
          await this.deps.repository.markUncertain({
            ...context,
            errorClass: executionTimedOut ? 'EXECUTION_DEADLINE_EXCEEDED' : 'LEASE_OWNERSHIP_LOST',
            detail: executionTimedOut
              ? `document or operation deadline expired after ${executionBudgetMs}ms; task requires exact reconciliation`
              : 'manifest heartbeat could not retain exact item and outbox ownership',
          });
          const latest = await this.deps.repository.read(manifest.operationId);
          return { outcome: 'uncertain', summary: latest ? summary(latest) : null, preflightIssues: [] };
        }
        const detail = errorDetail(bridge);
        if (deterministicBridgeFailure(bridge)) {
          await this.deps.repository.quarantineFailure({ ...context, errorClass: bridge.status, detail });
        } else {
          const state = await this.deps.repository.recordTransientFailure({
            ...context, errorClass: bridge.status, detail, backoffMs: backoffMs(item),
          });
          if (state === 'uncertain' || state === 'lease_lost') {
            const operation = await this.deps.repository.read(manifest.operationId);
            return { outcome: 'uncertain', summary: operation ? summary(operation) : null, preflightIssues: [] };
          }
        }
      } catch (error) {
        const operation = await this.deps.repository.read(manifest.operationId);
        const currentItem = operation?.items.find(candidate => candidate.id === item.id);
        if (currentItem?.status === 'evidence_ready') {
          if (await this.deps.repository.finalizeEvidence(context)) continue;
        }
        if (executionTimedOut || leaseLost) {
          if (timeoutStopInFlight) await timeoutStopInFlight;
          await this.deps.repository.markUncertain({
            ...context,
            errorClass: executionTimedOut ? 'EXECUTION_DEADLINE_EXCEEDED' : 'LEASE_OWNERSHIP_LOST',
            detail: executionTimedOut
              ? `document or operation deadline expired after ${executionBudgetMs}ms; task requires exact reconciliation`
              : 'manifest heartbeat could not retain exact item and outbox ownership',
          });
          const latest = await this.deps.repository.read(manifest.operationId);
          return { outcome: 'uncertain', summary: latest ? summary(latest) : null, preflightIssues: [] };
        }
        if (currentItem?.verificationCorrelations.length) {
          await this.deps.repository.markUncertain({
            ...context,
            errorClass: 'PERSISTED_RESULT_REQUIRES_RECONCILIATION',
            detail: 'bridge failed after fenced verification persistence but before terminal acknowledgement',
          });
          const latest = await this.deps.repository.read(manifest.operationId);
          return { outcome: 'uncertain', summary: latest ? summary(latest) : null, preflightIssues: [] };
        }
        const detail = error instanceof Error ? error.message : String(error);
        const state = await this.deps.repository.recordTransientFailure({
          ...context, errorClass: 'UNCAUGHT_BRIDGE_ERROR', detail, backoffMs: backoffMs(item),
        });
        if (state === 'uncertain' || state === 'lease_lost') {
          const latest = await this.deps.repository.read(manifest.operationId);
          return { outcome: 'uncertain', summary: latest ? summary(latest) : null, preflightIssues: [] };
        }
      } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        if (heartbeatInFlight) await heartbeatInFlight;
        if (timeoutStopInFlight) await timeoutStopInFlight;
      }
    }
  }
}

export function summarizeIngestionManifestV1(operation: IngestionManifestOperationRecordV1): IngestionManifestSummaryV1 {
  return summary(operation);
}
