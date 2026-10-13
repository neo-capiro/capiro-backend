import type { ClientProfileFillCompletionTaskType } from './client-profile-fill-completion-projection.js';

export type CompletionTaskStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface CompletionTaskRow {
  id: string;
  runId: string;
  tenantId: string;
  clientId: string;
  taskType: ClientProfileFillCompletionTaskType;
  taskKey: string;
  status: CompletionTaskStatus;
  dependsOn: string[];
  attempt: number;
  maxAttempts: number;
  input: Record<string, unknown>;
  outputSummary: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  workerId: string | null;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
  nextAttemptAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId?: string | null;
}

export const TERMINAL_TASK_STATUSES = new Set<string>([
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);

export class TaskDeferredError extends Error {}
