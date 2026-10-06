import type { StreamResolutionState } from './stream-resolution-policy.js';

export interface StreamPreflightConfig {
  leadTimesMs: number[];
  rapidPollLeadMs: number;
  rapidPollIntervalMs: number;
  delayedStartGraceMs: number;
  sourceErrorBaseBackoffMs: number;
  sourceErrorMaxBackoffMs: number;
}

export const DEFAULT_STREAM_PREFLIGHT_CONFIG: Readonly<StreamPreflightConfig> = Object.freeze({
  leadTimesMs: [24 * 60 * 60 * 1000, 60 * 60 * 1000, 15 * 60 * 1000, 5 * 60 * 1000],
  rapidPollLeadMs: 5 * 60 * 1000,
  rapidPollIntervalMs: 20 * 1000,
  delayedStartGraceMs: 90 * 60 * 1000,
  sourceErrorBaseBackoffMs: 30 * 1000,
  sourceErrorMaxBackoffMs: 5 * 60 * 1000,
});

export interface NextPreflightInput {
  now: Date;
  scheduledStart?: Date;
  eventStatus?: string;
  resolutionState: StreamResolutionState;
  lastAttemptAt?: Date;
  consecutiveSourceErrors?: number;
  config?: Partial<StreamPreflightConfig>;
}

export type StreamPreflightWindow =
  | 'UNSCHEDULED'
  | 'EARLY'
  | 'RAPID_POLL'
  | 'DELAYED_START_GRACE'
  | 'EXPIRED';

export function buildStreamPreflightSchedule(
  scheduledStart: Date,
  config?: Partial<StreamPreflightConfig>,
): Date[] {
  const resolved = resolveConfig(config);
  const startMs = scheduledStart.getTime();
  if (!Number.isFinite(startMs)) throw new Error('scheduledStart must be a valid date');
  return [...new Set(resolved.leadTimesMs.map((leadMs) => startMs - leadMs))]
    .sort((left, right) => left - right)
    .map((value) => new Date(value));
}

export function classifyStreamPreflightWindow(
  now: Date,
  scheduledStart: Date | undefined,
  config?: Partial<StreamPreflightConfig>,
): StreamPreflightWindow {
  if (!scheduledStart || !Number.isFinite(scheduledStart.getTime())) return 'UNSCHEDULED';
  const resolved = resolveConfig(config);
  const delta = scheduledStart.getTime() - now.getTime();
  if (delta > resolved.rapidPollLeadMs) return 'EARLY';
  if (delta >= 0) return 'RAPID_POLL';
  if (-delta <= resolved.delayedStartGraceMs) return 'DELAYED_START_GRACE';
  return 'EXPIRED';
}

/**
 * Return the next resolver attempt time, or null when the event is terminal or
 * capture-ready. This is deterministic so schedulers can rebuild missing jobs
 * instead of relying on one fragile chain of delayed queue messages.
 */
export function nextStreamPreflightAt(input: NextPreflightInput): Date | null {
  const eventStatus = (input.eventStatus ?? '').trim().toUpperCase();
  if (
    eventStatus === 'CANCELED' ||
    eventStatus === 'CANCELLED' ||
    eventStatus === 'COMPLETED' ||
    eventStatus === 'POSTPONED' ||
    input.resolutionState === 'READY_FOR_SERVER_CAPTURE' ||
    input.resolutionState === 'BROWSER_CAPTURE_ONLY' ||
    input.resolutionState === 'NO_PUBLIC_STREAM' ||
    input.resolutionState === 'POLICY_BLOCKED' ||
    input.resolutionState === 'CANCELED'
  ) {
    return null;
  }

  const config = resolveConfig(input.config);
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('now must be a valid date');

  if (!input.scheduledStart || !Number.isFinite(input.scheduledStart.getTime())) {
    return new Date(nowMs + sourceErrorBackoff(input.consecutiveSourceErrors ?? 0, config));
  }

  const startMs = input.scheduledStart.getTime();
  if (nowMs > startMs + config.delayedStartGraceMs) return null;

  const window = classifyStreamPreflightWindow(input.now, input.scheduledStart, config);
  const lastAttemptMs = input.lastAttemptAt?.getTime();
  if (window === 'EARLY') {
    const checkpoints = buildStreamPreflightSchedule(input.scheduledStart, config)
      .map((date) => date.getTime());
    // A due checkpoint must be attempted, not moved to the next checkpoint by
    // the scheduler's pre-resolve check. One actual attempt covers all elapsed
    // checkpoints, so late discovery does not cause a burst of duplicate work.
    if (checkpoints.some((value) => value <= nowMs &&
      (!Number.isFinite(lastAttemptMs) || value > lastAttemptMs!))) return new Date(nowMs);
    const futureCheckpoints = checkpoints.filter((value) => value > nowMs);
    if (futureCheckpoints.length > 0) return new Date(Math.min(...futureCheckpoints));
    return new Date(Math.max(nowMs, startMs - config.rapidPollLeadMs));
  }

  if (!Number.isFinite(lastAttemptMs)) return new Date(nowMs);
  const delay =
    input.resolutionState === 'SOURCE_ERROR'
      ? sourceErrorBackoff(input.consecutiveSourceErrors ?? 0, config)
      : config.rapidPollIntervalMs;
  // The deadline is anchored to the actual attempt. Rechecking a due job must
  // not perpetually push its retry into the future.
  const nextMs = Math.max(nowMs, lastAttemptMs! + delay);
  const graceEnd = startMs + config.delayedStartGraceMs;
  return nextMs <= graceEnd ? new Date(nextMs) : null;
}

export function sourceErrorBackoff(
  consecutiveErrors: number,
  config?: Partial<StreamPreflightConfig>,
): number {
  const resolved = resolveConfig(config);
  const exponent = Math.max(0, Math.min(10, Math.floor(consecutiveErrors)));
  return Math.min(
    resolved.sourceErrorMaxBackoffMs,
    resolved.sourceErrorBaseBackoffMs * 2 ** exponent,
  );
}

function resolveConfig(config?: Partial<StreamPreflightConfig>): StreamPreflightConfig {
  const merged: StreamPreflightConfig = {
    ...DEFAULT_STREAM_PREFLIGHT_CONFIG,
    ...config,
    leadTimesMs: config?.leadTimesMs ?? [...DEFAULT_STREAM_PREFLIGHT_CONFIG.leadTimesMs],
  };
  const sourceErrorBaseBackoffMs = positiveInteger(
    merged.sourceErrorBaseBackoffMs,
    30 * 1000,
  );
  return {
    leadTimesMs: [...new Set(
      merged.leadTimesMs.map((value) => Math.max(0, Math.floor(value))),
    )].sort((left, right) => right - left),
    rapidPollLeadMs: positiveInteger(merged.rapidPollLeadMs, 5 * 60 * 1000),
    rapidPollIntervalMs: positiveInteger(merged.rapidPollIntervalMs, 20 * 1000),
    delayedStartGraceMs: positiveInteger(merged.delayedStartGraceMs, 90 * 60 * 1000),
    sourceErrorBaseBackoffMs,
    sourceErrorMaxBackoffMs: Math.max(
      sourceErrorBaseBackoffMs,
      positiveInteger(merged.sourceErrorMaxBackoffMs, 5 * 60 * 1000),
    ),
  };
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
