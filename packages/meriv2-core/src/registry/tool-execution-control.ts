/** Request-local execution controls, never model-supplied tool arguments. */
export interface ToolExecutionControl {
  signal?: AbortSignal;
  /** Absolute wall-clock deadline shared by the provider and every tool. */
  deadlineAt?: number;
}

export function assertToolExecutionActive(control?: ToolExecutionControl): void {
  if (control?.signal?.aborted) {
    throw control.signal.reason ?? new DOMException('Turn cancelled', 'AbortError');
  }
  if (control?.deadlineAt !== undefined && Date.now() >= control.deadlineAt) {
    throw new DOMException('Turn deadline exceeded', 'TimeoutError');
  }
}
