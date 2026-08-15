import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
