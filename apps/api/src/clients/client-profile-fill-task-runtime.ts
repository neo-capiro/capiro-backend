import type { TenantContext } from '@capiro/shared';
import type { AdvocacyHistoryTaskResult } from './client-profile-fill-advocacy-discovery.shared.js';
import type { RunActorRow } from './client-profile-fill-task-ledger.js';
import {
  TaskDeferredError,
  type CompletionTaskRow,
  type CompletionTaskStatus,
} from './client-profile-fill-completion-runtime.shared.js';

const TASK_TIMEOUT_MS = 5 * 60_000;

export interface TaskRuntimePorts {
  recoverStaleTasks(): Promise<void>;
  claimTasks(): Promise<CompletionTaskRow[]>;
  executeClaimedTask(task: CompletionTaskRow): Promise<void>;
  finalizeRuns(): Promise<void>;
  loadRunActor(task: CompletionTaskRow): Promise<RunActorRow[]>;
  executeTask(
    ctx: TenantContext,
    task: CompletionTaskRow,
  ): Promise<number | AdvocacyHistoryTaskResult>;
  finishTask(
    task: CompletionTaskRow,
    status: Extract<CompletionTaskStatus, 'completed' | 'skipped' | 'cancelled'>,
    summary: Record<string, unknown>,
  ): Promise<void>;
  deferTask(task: CompletionTaskRow, reason: string): Promise<void>;
  failTask(task: CompletionTaskRow, error: unknown): Promise<void>;
  heartbeat(task: CompletionTaskRow): Promise<void>;
}

/** Runs claimed tasks with the existing actor, heartbeat, timeout and completion semantics. */
export class ClientProfileFillTaskRuntime {
  private taskSweepRunning = false;

  constructor(private readonly ports: TaskRuntimePorts) {}

  async sweepOnce(): Promise<void> {
    if (this.taskSweepRunning) return;
    this.taskSweepRunning = true;
    try {
      await this.ports.recoverStaleTasks();
      const tasks = await this.ports.claimTasks();
      await Promise.all(tasks.map((task) => this.ports.executeClaimedTask(task)));
      await this.ports.finalizeRuns();
    } finally {
      this.taskSweepRunning = false;
    }
  }

  async executeClaimedTask(task: CompletionTaskRow): Promise<void> {
    const runRows = await this.ports.loadRunActor(task);
    const run = runRows[0];
    if (!run || run.status === 'cancelled') {
      await this.ports.finishTask(task, 'cancelled', { count: 0 });
      return;
    }
    if (!run.createdByUserId) {
      await this.ports.failTask(task, new Error('Fill run has no actor for governed execution'));
      return;
    }
    const ctx: TenantContext = {
      tenantId: task.tenantId,
      tenantSlug: '',
      userId: run.createdByUserId,
      clerkUserId: '',
      role: 'standard_user',
    };
    const heartbeat = setInterval(() => {
      void this.ports.heartbeat(task).catch(() => undefined);
    }, 15_000);
    heartbeat.unref?.();
    try {
      const result = await this.withTaskTimeout(this.ports.executeTask(ctx, task));
      await this.ports.finishTask(
        task,
        'completed',
        typeof result === 'number' ? { count: result } : result,
      );
    } catch (error) {
      if (error instanceof TaskDeferredError) {
        await this.ports.deferTask(task, error.message);
      } else {
        await this.ports.failTask(task, error);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  async withTaskTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Fill completion specialist exceeded its task budget')),
            TASK_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
