/** Bounded execution facts safe to show with an answer; never reasoning text. */
export interface MeriRuntimeStatus {
  requestedEffort: string | null;
  effectiveEffort: string | null;
  adjusted: boolean;
  partial: boolean;
  stopped: boolean;
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const effort = (value: unknown): string | null =>
  typeof value === 'string' && EFFORTS.has(value) ? value : null;

/** Accepts either a live runtime/done frame or persisted message metadata. */
export function meriRuntimeStatus(value: unknown): MeriRuntimeStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const telemetry =
    record.telemetry && typeof record.telemetry === 'object'
      ? (record.telemetry as Record<string, unknown>)
      : undefined;
  if (!telemetry && record.partial !== true) return undefined;
  const finish = record.finishReason ?? telemetry?.finishReason;
  return {
    requestedEffort: effort(telemetry?.requestedReasoningEffort),
    effectiveEffort: effort(telemetry?.effectiveReasoningEffort),
    adjusted:
      Array.isArray(telemetry?.reasoningFallbackReasons) &&
      telemetry.reasoningFallbackReasons.length > 0,
    partial: record.partial === true || telemetry?.partial === true,
    stopped: finish === 'aborted' || finish === 'cancelled',
  };
}

export function meriRuntimeStatusText(status: MeriRuntimeStatus | undefined): string | null {
  if (!status) return null;
  const parts: string[] = [];
  if (status.partial)
    parts.push(
      status.stopped ? 'Stopped. This response is partial.' : 'This response is incomplete.',
    );
  if (status.adjusted)
    parts.push(
      status.effectiveEffort
        ? `The provider adjusted reasoning during this turn. Final effort: ${status.effectiveEffort}.`
        : 'The provider adjusted reasoning during this turn. Final effort was not confirmed.',
    );
  return parts.join(' ') || null;
}
