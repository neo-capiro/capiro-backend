/** Bounded execution facts safe to show with an answer; never reasoning text. */
export interface MeriRuntimeStatus {
  /** User selection for this turn, never inferred from orchestration tier. */
  selectedMode?: 'fast' | 'standard' | 'deep' | 'max';
  requestedModel?: string | null;
  effectiveModel?: string | null;
  fallbackReasons?: string[];
  requestedEffort: string | null;
  effectiveEffort: string | null;
  adjusted: boolean;
  partial: boolean;
  stopped: boolean;
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODES = new Set(['fast', 'standard', 'deep', 'max']);
const FALLBACK_REASONS: Record<string, string> = {
  max_unsupported: 'The provider does not support Max effort.',
  xhigh_unsupported: 'The provider does not support extra-high effort.',
  reasoning_parameter_unsupported: 'The provider does not accept an explicit reasoning effort.',
};
const effort = (value: unknown): string | null =>
  typeof value === 'string' && EFFORTS.has(value) ? value : null;
const model = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value) ? value : null;

/** Accepts either a live runtime/done frame or persisted message metadata. */
export function meriRuntimeStatus(value: unknown): MeriRuntimeStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const telemetry =
    record.telemetry && typeof record.telemetry === 'object'
      ? (record.telemetry as Record<string, unknown>)
      : undefined;
  const selectedMode =
    typeof record.reasoningMode === 'string' && MODES.has(record.reasoningMode)
      ? (record.reasoningMode as MeriRuntimeStatus['selectedMode'])
      : undefined;
  if (!telemetry && record.partial !== true && !selectedMode) return undefined;
  const finish = record.finishReason ?? telemetry?.finishReason;
  const fallbackCodes = Array.isArray(telemetry?.reasoningFallbackReasons)
    ? telemetry.reasoningFallbackReasons
    : [];
  return {
    ...(selectedMode ? { selectedMode } : {}),
    ...(telemetry
      ? {
          requestedModel: model(telemetry.requestedModel),
          effectiveModel: model(telemetry.effectiveModel),
          // Provider error bodies must never become UI copy. Known reason codes
          // have bounded, user-facing descriptions; unknown codes stay generic.
          fallbackReasons: [
            ...new Set(
              fallbackCodes.map((reason) =>
                typeof reason === 'string' && Object.hasOwn(FALLBACK_REASONS, reason)
                  ? FALLBACK_REASONS[reason]!
                  : 'The provider changed the requested reasoning settings.',
              ),
            ),
          ],
        }
      : {}),
    requestedEffort: effort(telemetry?.requestedReasoningEffort),
    effectiveEffort: effort(telemetry?.effectiveReasoningEffort),
    adjusted: fallbackCodes.length > 0,
    partial: record.partial === true || telemetry?.partial === true,
    stopped: finish === 'aborted' || finish === 'cancelled',
  };
}

/** Repair the exact old cancellation placeholder while retaining real errors. */
export function meriRuntimeMessageContent(
  content: string,
  status: MeriRuntimeStatus | undefined,
): string {
  return status?.stopped &&
    content.trim() === 'MeriV3 could not complete this turn. Please try again.'
    ? 'Stopped before an answer was generated.'
    : content;
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
