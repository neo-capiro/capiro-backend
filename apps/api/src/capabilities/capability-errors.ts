export type CapabilityErrorCode =
  | 'CAPABILITY_UNAUTHORIZED'
  | 'CAPABILITY_NOT_FOUND'
  | 'CAPABILITY_INVALID_SCOPE'
  | 'CAPABILITY_ETHICAL_WALL'
  | 'CAPABILITY_STALE'
  | 'CAPABILITY_UNAVAILABLE'
  | 'CAPABILITY_TIMEOUT'
  | 'CAPABILITY_BUDGET_EXCEEDED'
  | 'CAPABILITY_INVALID_INPUT'
  | 'CAPABILITY_INTERNAL_ERROR';

export class CapabilityError extends Error {
  constructor(
    readonly code: CapabilityErrorCode,
    readonly safeMessage: string,
    readonly retryable = false,
    readonly scopeChanged = false,
  ) {
    super(safeMessage);
    this.name = 'CapabilityError';
  }

  toModelError() {
    return {
      code: this.code,
      safeMessage: this.safeMessage,
      retryable: this.retryable,
      scopeChanged: this.scopeChanged,
    };
  }
}

export function normalizeCapabilityError(error: unknown): CapabilityError {
  if (error instanceof CapabilityError) return error;
  return new CapabilityError(
    'CAPABILITY_INTERNAL_ERROR',
    'The requested Capiro capability could not complete safely.',
    false,
  );
}
