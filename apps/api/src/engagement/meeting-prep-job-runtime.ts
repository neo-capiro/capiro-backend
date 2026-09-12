import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';
import type { MeetingPrepDepth } from './meeting-prep-policy.js';

export interface MeetingPrepExecution {
  jobId: string;
  depth: MeetingPrepDepth;
  deadlineAt: number;
  signal: AbortSignal;
  checkpoint(stage: string, value?: unknown): Promise<void>;
  loadCheckpoint<T>(stage: string): T | undefined;
  /** Runs in the same transaction as the artifact write; lost leases roll it back. */
  commit(tx: Prisma.TransactionClient, prepId: string): Promise<void>;
}
const execution = new AsyncLocalStorage<MeetingPrepExecution>();
export const currentMeetingPrepExecution = () => execution.getStore();
export const withMeetingPrepExecution = <T>(value: MeetingPrepExecution, run: () => T): T =>
  execution.run(value, run);

export function prepStageTimeout(maxMs: number, reserveMs = 0): number {
  const run = execution.getStore();
  run?.signal.throwIfAborted();
  const remaining = run ? run.deadlineAt - Date.now() - reserveMs : maxMs;
  if (remaining <= 0) throw new Error('meeting_prep_deadline_exceeded');
  return Math.min(maxMs, remaining);
}
