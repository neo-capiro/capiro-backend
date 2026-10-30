/** Persisted historical values, not a model execution contract. */
export type OutreachReasoningStateMode = 'capiro_managed' | 'provider_state';
export type OutreachReasoningEffort = 'low' | 'medium' | 'high';
export type OutreachReasoningErrorCode = 'OUTREACH_REASONING_NOT_FOUND';

export class OutreachReasoningError extends Error {
  readonly name = 'OutreachReasoningError';

  constructor(
    readonly code: OutreachReasoningErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly retryable = false,
    readonly safeMetadata?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
  }
}
