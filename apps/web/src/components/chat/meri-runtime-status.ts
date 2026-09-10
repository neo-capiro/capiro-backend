/** Bounded execution facts safe to show with an answer; never reasoning text. */
export interface MeriRuntimeStatus {
  /** Turn outcome from the public stream receipt or persisted finish reason. */
  lifecycle?: 'running' | 'completed' | 'stopped' | 'failed' | 'incomplete';
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

/** Provider rounds can finish while the turn is still using tools. Only the
 * final done receipt or saved metadata establishes the terminal turn outcome. */
function lifecycle(
  record: Record<string, unknown>,
  telemetry: Record<string, unknown> | undefined,
): MeriRuntimeStatus['lifecycle'] {
  if (record.type === 'start' || record.type === 'runtime') return 'running';
  if (record.type === 'error') return 'failed';
  const finish = record.finishReason ?? telemetry?.finishReason;
  if (finish === 'aborted' || finish === 'cancelled') return 'stopped';
  if (finish === 'error' || finish === 'failed' || finish === 'runtime_error') return 'failed';
  if (record.partial === true || telemetry?.partial === true) return 'incomplete';
  if (finish === 'stop' || finish === 'completed' || finish === 'end_turn') return 'completed';
  if (record.type === 'done') return finish == null ? 'completed' : 'incomplete';
  // Legacy rows without a recognized outcome remain neutral. Intent, tier,
  // provider selection and a tool's status are not a turn-completion receipt.
  return undefined;
}

export function meriTurnLifecycleLabel(status: MeriRuntimeStatus | undefined): string {
  const labels: Record<NonNullable<MeriRuntimeStatus['lifecycle']>, string> = {
    running: 'Working', completed: 'Completed', stopped: 'Stopped',
    failed: 'Failed', incomplete: 'Incomplete',
  };
  return status?.lifecycle ? labels[status.lifecycle] : 'Turn details';
}

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
  const turnLifecycle = lifecycle(record, telemetry);
  if (!telemetry && record.partial !== true && !selectedMode && !turnLifecycle) return undefined;
  const fallbackCodes = Array.isArray(telemetry?.reasoningFallbackReasons)
    ? telemetry.reasoningFallbackReasons
    : [];
  return {
    ...(turnLifecycle ? { lifecycle: turnLifecycle } : {}),
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
    stopped: turnLifecycle === 'stopped',
  };
}

/** Reconcile execution facts without allowing a delayed provider update to
 * reopen a terminal turn or erase its final partial/cancellation receipt. */
export function mergeMeriRuntimeStatus(
  previous: MeriRuntimeStatus | undefined,
  incoming: MeriRuntimeStatus,
): MeriRuntimeStatus {
  if (!previous) return incoming;
  const merged = { ...previous, ...incoming };
  if (!Object.hasOwn(incoming, 'requestedModel')) {
    // A lifecycle-only frame carries no provider telemetry. Explicit provider
    // omissions still replace older values because telemetry owns this key.
    merged.requestedEffort = previous.requestedEffort;
    merged.effectiveEffort = previous.effectiveEffort;
    merged.adjusted = previous.adjusted;
  }
  if (previous.lifecycle && previous.lifecycle !== 'running' &&
      (!incoming.lifecycle || incoming.lifecycle === 'running')) {
    merged.lifecycle = previous.lifecycle;
    merged.partial = previous.partial;
    merged.stopped = previous.stopped;
  }
  return merged;
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
  if (status.lifecycle === 'completed') parts.push('Completed.');
  else if (status.lifecycle === 'failed')
    parts.push(status.partial ? 'Failed. This response is incomplete.' : 'Failed.');
  else if (status.partial)
    parts.push(
      status.stopped ? 'Stopped. This response is partial.' : 'This response is incomplete.',
    );
  else if (status.lifecycle === 'stopped') parts.push('Stopped.');
  else if (status.lifecycle === 'incomplete') parts.push('This response is incomplete.');
  if (status.adjusted)
    parts.push(
      status.effectiveEffort
        ? `The provider adjusted reasoning during this turn. Final effort: ${status.effectiveEffort}.`
        : 'The provider adjusted reasoning during this turn. Final effort was not confirmed.',
    );
  return parts.join(' ') || null;
}
