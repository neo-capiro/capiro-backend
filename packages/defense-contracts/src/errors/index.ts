export type DefenseErrorCode =
  | 'DEFENSE_BAD_REQUEST'
  | 'DEFENSE_NOT_FOUND'
  | 'DEFENSE_FORBIDDEN'
  | 'DEFENSE_CONFLICT'
  | 'DEFENSE_IDENTITY_CROSSWALK_REQUIRED'
  | 'DEFENSE_EVIDENCE_REQUIRED'
  | 'DEFENSE_MIXED_PROVENANCE'
  | 'DEFENSE_SNAPSHOT_MISMATCH'
  | 'DEFENSE_VERIFICATION_BLOCKED'
  | 'DEFENSE_PARSER_FAILED'
  | 'DEFENSE_DEPENDENCY_UNAVAILABLE';

export interface DefenseErrorEnvelope {
  readonly code: DefenseErrorCode;
  readonly message: string;
  readonly requestId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
}

export class DefenseContractError extends Error {
  readonly code: DefenseErrorCode;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(input: {
    code: DefenseErrorCode;
    message: string;
    retryable?: boolean;
    details?: Readonly<Record<string, unknown>>;
  }) {
    super(input.message);
    this.name = 'DefenseContractError';
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.details = input.details;
  }

  toEnvelope(requestId?: string): DefenseErrorEnvelope {
    return {
      code: this.code,
      message: this.message,
      requestId,
      details: this.details,
      retryable: this.retryable,
    };
  }
}
