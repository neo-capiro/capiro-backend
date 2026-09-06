import { assertToolExecutionActive, type ToolExecutionControl } from '@capiro/meriv2-core';

/** Link transport cancellation and the turn deadline; release listeners after use. */
export function createMeriExecutionControl(
  parent: ToolExecutionControl = {},
  timeoutMs?: number,
): ToolExecutionControl & { signal: AbortSignal; assertActive: () => void; dispose: () => void } {
  const deadlineAt = Math.min(
    parent.deadlineAt ?? Number.POSITIVE_INFINITY,
    timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs,
  );
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.signal?.reason);
  if (parent.signal?.aborted) onAbort();
  else parent.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = Number.isFinite(deadlineAt)
    ? setTimeout(
        () => controller.abort(new DOMException('Turn deadline exceeded', 'TimeoutError')),
        Math.max(0, deadlineAt - Date.now()),
      )
    : undefined;
  return {
    signal: controller.signal,
    ...(Number.isFinite(deadlineAt) ? { deadlineAt } : {}),
    assertActive: () => assertToolExecutionActive({ signal: controller.signal, deadlineAt }),
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parent.signal?.removeEventListener('abort', onAbort);
    },
  };
}
