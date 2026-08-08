export const OUTREACH_COMMAND_ERROR_CODES = [
  'OUTREACH_SESSION_NOT_FOUND',
  'OUTREACH_SESSION_ARCHIVED',
  'OUTREACH_STATE_CONFLICT',
  'OUTREACH_COMMAND_INVALID',
  'OUTREACH_COMMAND_FUTURE_PHASE',
  'OUTREACH_COMMAND_BLOCKED',
  'OUTREACH_COMMAND_BATCH_TOO_LARGE',
  'OUTREACH_COMMAND_ID_REUSE',
  'OUTREACH_SPONSOR_SCOPE_INVALID',
  'OUTREACH_REFERENCE_UNAUTHORIZED',
  'OUTREACH_PROPOSAL_NOT_FOUND',
  'OUTREACH_PROPOSAL_STALE',
  'OUTREACH_PROPOSAL_ALREADY_DECIDED',
  'OUTREACH_STATE_VERSION_NOT_FOUND',
  'OUTREACH_STATE_CORRUPT',
] as const;

export type OutreachCommandErrorCode = (typeof OUTREACH_COMMAND_ERROR_CODES)[number];

export type OutreachCommandResultStatus =
  | 'applied'
  | 'no_change'
  | 'unsupported'
  | 'blocked'
  | 'conflict'
  | 'failed_safely';

export class OutreachCommandError extends Error {
  readonly name = 'OutreachCommandError';

  constructor(
    readonly code: OutreachCommandErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly safeMetadata?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
  }
}

export function outreachNotFound(): OutreachCommandError {
  return new OutreachCommandError(
    'OUTREACH_SESSION_NOT_FOUND',
    'The requested outreach session was not found.',
    404,
  );
}
