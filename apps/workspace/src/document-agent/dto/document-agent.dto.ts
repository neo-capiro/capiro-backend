// DTOs for the document-agent module. All mutation DTOs include `expectedRevision`
// for optimistic concurrency control.

// The ONE closed acknowledgement that a failed-unit retry is deliberate paid work,
// shared with the workspace intake retry contract so the two flows cannot drift.
import {
  RETRY_FAILED_UNITS_INTENT,
  type RetryFailedUnitsIntent,
} from '../../quick-draft/dto/intake.dto.js';

import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

/** Recommend a document setup. */
export class RecommendDocumentSetupDto {
  @IsString() @MinLength(3) goal!: string;
  @IsOptional() @IsString() client?: string;
}

/** Initialize agent state on a draft. */
export class InitializeAgentDto {
  @IsOptional() @IsObject() documentType?: { id: string; label: string; product: string };
  @IsOptional() @IsObject() blueprintPin?: {
    blueprintId: string;
    versionId: string;
    version: number;
    definitionHash: string;
  };
  @IsOptional() @IsObject() theme?: { id: string; name: string; settings: Record<string, unknown> };
  @IsOptional() @IsString() goal?: string;
}

/** Patch agent state (general mutation with optimistic revision). */
export class PatchAgentDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsOptional() @IsObject() documentType?: { id: string; label: string; product: string };
  @IsOptional() @IsObject() blueprintPin?: Record<string, unknown>;
  @IsOptional() @IsObject() theme?: Record<string, unknown>;
  @IsOptional() @IsObject() goal?: Record<string, unknown>;
  @IsOptional() @IsObject() generation?: { mode?: 'quick' | 'standard' | 'max' };
  @IsOptional() @IsString() phase?: string;
  @IsOptional() @IsString() status?: string;
}

/** Send a conversation message. */
export class SendMessageDto {
  @IsString() @MinLength(1) text!: string;
  @IsString() phase!: string;
  @IsInt() @Min(0) expectedRevision!: number;
  @IsOptional() @IsString() idempotencyKey?: string;
  @IsOptional() @IsObject() scope?: {
    kind: 'whole_document' | 'selection';
    documentId?: string;
    sectionId?: string;
    quote?: string;
    start?: number;
    end?: number;
  };
}

/** Update the brief. */
export class UpdateBriefDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsOptional() @IsString() objective?: string;
  @IsOptional() @IsString() audience?: string;
  @IsOptional() @IsString() desiredAction?: string;
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() centralArgument?: string;
  @IsOptional() @IsString() evidenceInstructions?: string;
  @IsOptional() @IsString() tone?: string;
  @IsOptional() @IsInt() targetPages?: number;
  @IsOptional() @IsString() deadline?: string;
  @IsOptional() @IsArray() assumptions?: Array<{
    id: string;
    text: string;
    status: 'open' | 'confirmed' | 'rejected';
  }>;
}

/** Approve the brief. */
export class ApproveBriefDto {
  @IsInt() @Min(0) expectedRevision!: number;
}

/** Synthesize the brief from the native conversation owner. */
export class SynthesizeBriefDto {
  @IsInt() @Min(0) expectedRevision!: number;
  /** Truthful explicit paid-generation intent: this route starts a paid native turn. */
  @IsBoolean() paidGeneration!: boolean;
}

/** Reopen the brief. */
export class ReopenBriefDto {
  @IsInt() @Min(0) expectedRevision!: number;
}

/** Recommend context items from the native conversation owner. */
export class RecommendContextDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsBoolean() paidGeneration!: boolean;
}

/** Analyze context with the native conversation owner. */
export class AnalyzeContextDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsBoolean() paidGeneration!: boolean;
}

/** Approve the context plan. */
export class ApproveContextDto {
  @IsInt() @Min(0) expectedRevision!: number;
}

/** Patch a context item's payload (extends WsContextItem.payload). */
export class PatchContextItemDto {
  @IsObject() payload!: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(0) expectedRevision?: number;
}

/** Resolve one source conflict explicitly. */
export class ResolveContextConflictDto {
  @IsString() @MinLength(1) conflictId!: string;
  @IsInt() @Min(0) expectedRevision!: number;
  @IsString() @MinLength(1) resolution!: string;
  @IsOptional() @IsString() keptItemId?: string;
  @IsOptional() @IsArray() excludedItemIds?: string[];
}

/** Generate the outline. */
export class GenerateOutlineDto {
  @IsInt() @Min(0) expectedRevision!: number;
  /** Truthful explicit paid-generation intent: this route starts a paid native turn. */
  @IsBoolean() paidGeneration!: boolean;
}

/** Update the outline. */
export class UpdateOutlineDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsArray() sections!: Array<{
    id: string;
    title: string;
    purpose: string;
    instructions: string;
    required: boolean;
    locked: boolean;
    targetWords: { min: number; max: number };
    evidenceItemIds: string[];
  }>;
}

/** Revise the outline (creates a proposal). */
export class ReviseOutlineDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsString() instruction!: string;
}

/** Approve the outline. */
export class ApproveOutlineDto {
  @IsInt() @Min(0) expectedRevision!: number;
}

/** Accept or reject a proposal. */
export class DecideProposalDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsOptional() @IsString() note?: string;
}

/** Generate the document. */
export class GenerateDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsOptional() @IsString() @IsIn(['quick', 'standard', 'max'])
  mode?: 'quick' | 'standard' | 'max';
  @IsOptional() @IsString() idempotencyKey?: string;
  /** Truthful explicit paid-generation intent: this route starts a paid native run. */
  @IsBoolean() paidGeneration!: boolean;
}

/** Retry failed sections. */
export class RetryGenerationDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsOptional() @IsArray() sectionIds?: string[];
  /**
   * The explicit acknowledgement that this retry starts NEW PAID native generation
   * for the units a terminal native run failed. It is what separates a deliberate
   * failed-unit retry from re-reading an uncertain attempt: without it a native run
   * is never turned again, and a legacy engine run keeps its existing behaviour.
   */
  @IsOptional() @IsIn([RETRY_FAILED_UNITS_INTENT]) intent?: RetryFailedUnitsIntent;
}

/** Cancel generation. */
export class CancelGenerationDto {
  @IsInt() @Min(0) expectedRevision!: number;
}

/** Fix a quality issue (creates a proposal). */
export class FixIssueDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsOptional() @IsString() instruction?: string;
}
