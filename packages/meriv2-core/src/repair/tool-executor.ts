import { createHash } from 'node:crypto';
import { canonicalJson } from './plan-remedy';
import type { RepairToolCall, RepairToolResult } from './types';

export interface ToolExecutor {
  execute(call: RepairToolCall, options: { signal?: AbortSignal }): Promise<RepairToolResult>;
}

export interface RecordedToolResult {
  key: string;
  result: RepairToolResult;
}

export function toolRecordingKey(call: RepairToolCall): string {
  return createHash('sha256').update(`${call.name}:${canonicalJson(call.args)}`).digest('hex');
}

export class ReplayToolExecutor implements ToolExecutor {
  private readonly results: ReadonlyMap<string, RepairToolResult>;

  constructor(results: readonly RecordedToolResult[] | ReadonlyMap<string, RepairToolResult>) {
    this.results = Array.isArray(results)
      ? new Map(results.map((entry) => [entry.key, entry.result]))
      : (results as ReadonlyMap<string, RepairToolResult>);
  }

  async execute(call: RepairToolCall, options: { signal?: AbortSignal }): Promise<RepairToolResult> {
    if (options.signal?.aborted) return { ok: false, state: 'retrieval_failed', reason: 'cancelled' };
    return this.results.get(toolRecordingKey(call)) ?? {
      ok: false,
      state: 'retrieval_failed',
      reason: 'no_recording',
    };
  }
}

export class RecordingToolExecutor implements ToolExecutor {
  readonly recordings: RecordedToolResult[] = [];

  constructor(private readonly delegate: ToolExecutor) {}

  async execute(call: RepairToolCall, options: { signal?: AbortSignal }): Promise<RepairToolResult> {
    const result = await this.delegate.execute(call, options);
    this.recordings.push({ key: toolRecordingKey(call), result });
    return result;
  }
}

/** Turn-scoped wrapper: failed identical calls are returned from memory, never re-executed. */
export class DeduplicatingToolExecutor implements ToolExecutor {
  private readonly failures = new Map<string, RepairToolResult>();

  constructor(private readonly delegate: ToolExecutor) {}

  async execute(call: RepairToolCall, options: { signal?: AbortSignal }): Promise<RepairToolResult> {
    const key = toolRecordingKey(call);
    const previous = this.failures.get(key);
    if (previous) return previous;
    const result = await this.delegate.execute(call, options);
    if (!result.ok) this.failures.set(key, result);
    return result;
  }
}
