import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Aggregate, idempotent intake request (PR #964).
 *
 * The browser sends only identifiers — never server-backed source bodies.
 * The backend re-fetches and authorizes every selected ID.
 * Only `pastedContext` and `pastedSample` are browser-authored text.
 */
export class IntakeRequestDto {
  @IsString()
  @MinLength(3)
  @MaxLength(10_000)
  goal!: string;

  @IsOptional()
  @IsString()
  clientId?: string;

  @IsString()
  blueprintVersionId!: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  factualAttachmentIds!: string[];

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  sampleAttachmentIds!: string[];

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  priorWorkspaceDraftIds!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  selectedContextItemIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  selectedContextDomains?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  pastedContext?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  pastedSample?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  audience?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  tone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  deadline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  lengthInstruction?: string;
}

/**
 * The one workflow marker the retry-failed route accepts.
 *
 * It selects a WORKFLOW and nothing else: it grants no authority, carries no
 * secret, scan result or status, and every existing check (tenant, acting
 * actor, owner/editor edit ACL, prospect-transfer denial) still runs before it
 * is consulted.
 */
export const NATIVE_RETAINED_RETRY_WORKFLOW = 'native-retained';

export type NativeRetainedRetryWorkflow = typeof NATIVE_RETAINED_RETRY_WORKFLOW;

/**
 * The EXPLICIT paid-generation intent of a deliberate failed-unit retry.
 *
 * Recovering an uncertain attempt and RETRYING failed units are different acts:
 * only the second one can allocate new paid native work. The intent is a closed
 * body value, so it is validated before the route runs and can never be inferred
 * from a run's status — a run that merely LOOKS retryable is never turned into
 * new paid generation by a caller that did not ask for it in so many words.
 */
export const RETRY_FAILED_UNITS_INTENT = 'retry-failed-units';

export type RetryFailedUnitsIntent = typeof RETRY_FAILED_UNITS_INTENT;

/**
 * Optional body of POST /document-agent/runs/:runId/retry-failed.
 *
 * `workflow: 'native-retained'` is the closed native-only discriminator: it
 * asks the route to continue the run through its RETAINED native request only,
 * so a run that owner did not create is refused instead of falling through to
 * the legacy generation owner. An ABSENT marker keeps the route's historical
 * behaviour for callers that never opted into that flow.
 *
 * `intent: 'retry-failed-units'` is the caller's explicit acknowledgement that
 * this request may generate again for the units that actually failed. Without
 * it the route never binds a retry attempt and never issues a native turn: it
 * recovers what is deterministic (a run whose drafting already completed) and
 * otherwise reports the run's real status. Any other value — and any other field
 * in the body — is refused by the workspace ValidationPipe before the route
 * runs, so neither the workflow nor the intent can be guessed into existence.
 */
export class RetryFailedRequestDto {
  @IsOptional()
  @IsIn([NATIVE_RETAINED_RETRY_WORKFLOW])
  workflow?: NativeRetainedRetryWorkflow;

  @IsOptional()
  @IsIn([RETRY_FAILED_UNITS_INTENT])
  intent?: RetryFailedUnitsIntent;
}

/**
 * Response from the aggregate intake endpoint.
 * 202 Accepted — returned only after draft, sources, run, and job are persisted.
 */
export interface IntakeResponse {
  draftId: string;
  runId: string;
  status: 'queued' | 'active';
  agentRevision: number;
}

/**
 * Response for run status polling.
 */
export interface RunStatusResponse {
  runId: string;
  status: string;
  stage: string;
  stages: Array<{
    name: string;
    status: string;
    startedAt?: string;
    completedAt?: string;
    detail?: string;
  }>;
  sectionStates: Record<
    string,
    {
      status: string;
      error?: string;
      contentHash?: string;
      citations?: Array<{
        n: number;
        token: string;
        kind: string;
        refId: string;
        label: string;
      }>;
    }
  >;
  provider?: string;
  model?: string;
  reasoningLevel?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Capability flag response for the frontend.
 */
export interface TwoStepDraftCapabilityResponse {
  enabled: boolean;
}
