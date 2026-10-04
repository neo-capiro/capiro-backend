import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';
import { assertToolExecutionActive, type ToolExecutionControl } from '@capiro/meriv2-core';
import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import { decodeMeriMemoryCaptureRequest, memoryCaptureSourcePolicyEnabled, MERI_MEMORY_CAPTURE_REQUEST_HEADER, type MeriMemoryCaptureRequest } from '@capiro/meriv2-core';

interface MeriToolRequestState extends ToolExecutionControl {
  capturePolicy?: MeriServerReadonlyCapturePolicy;
  memoryCaptureRequest?: MeriMemoryCaptureRequest;
}

const execution = new AsyncLocalStorage<MeriToolRequestState>();

/** Cooperative dispatch guard. Already-started database work is not rolled back. */
export function assertMeriToolRequestActive(): void {
  assertToolExecutionActive(execution.getStore());
}

export function meriToolRequestControl(): ToolExecutionControl | undefined {
  return execution.getStore();
}

export function currentMeriToolCapturePolicy(): MeriServerReadonlyCapturePolicy | null {
  return execution.getStore()?.capturePolicy ?? null;
}
export function currentMeriMemoryCaptureRequest(): MeriMemoryCaptureRequest | undefined {
  return execution.getStore()?.memoryCaptureRequest;
}

export async function withMeriToolExecutionControl<T>(
  control: ToolExecutionControl,
  run: () => Promise<T>,
): Promise<T> {
  return execution.run(control, async () => {
    assertMeriToolRequestActive();
    return run();
  });
}

export async function withMeriToolRequestControl<T>(
  req: Request,
  run: () => Promise<T>,
  capturePolicy?: MeriServerReadonlyCapturePolicy | null,
): Promise<T> {
  const memoryCaptureRequest = memoryCaptureSourcePolicyEnabled(capturePolicy) && req.params?.name === 'search_memory'
    ? decodeMeriMemoryCaptureRequest(capturePolicy, req.headers[MERI_MEMORY_CAPTURE_REQUEST_HEADER], req.body, process.env.INTERNAL_SERVICE_SECRET)
    : undefined;
  const controller = new AbortController();
  const raw = req.headers['x-meri-deadline-at'];
  const parsed = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : undefined;
  // The header can only shorten execution. Identity/authority still come from the guards.
  const deadlineAt = parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
  const onAbort = () => controller.abort(new DOMException('Tool request cancelled', 'AbortError'));
  const onClose = () => {
    if (!req.res?.writableEnded) onAbort();
  };
  if (req.aborted || req.res?.destroyed) onAbort();
  req.once('aborted', onAbort);
  req.res?.once('close', onClose);
  const timer =
    deadlineAt !== undefined
      ? setTimeout(
          () => controller.abort(new DOMException('Turn deadline exceeded', 'TimeoutError')),
          Math.max(0, Math.min(2_147_483_647, deadlineAt - Date.now())),
        )
      : undefined;
  try {
    return await execution.run(
      {
        signal: controller.signal,
        deadlineAt,
        ...(capturePolicy ? { capturePolicy } : {}),
        ...(memoryCaptureRequest ? { memoryCaptureRequest } : {}),
      },
      async () => {
        assertMeriToolRequestActive();
        return run();
      },
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    req.removeListener('aborted', onAbort);
    req.res?.removeListener('close', onClose);
  }
}
