import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * Engine config blob (ws-config-v4 shape). Persisted as JSONB on ws_draft.
 * Loosely validated here (the cascade owns semantics); hot fields are promoted
 * to columns by the service.
 */
export class WsAskDto {
  @IsOptional() @IsString() amount?: string;
  @IsOptional() @IsString() pb?: string;
  @IsOptional() @IsString() delta?: string;
}

export class CreateDraftDto {
  @IsOptional() @IsUUID() prospectId?: string;
  @IsOptional() @IsUUID() requestId?: string;
  // Seed from a product (Library card click) — the service applies product
  // defaults (sections, pages, meta) from the cascade.
  @IsOptional() @IsString() industry?: string;
  @IsOptional() @IsString() product?: string;
  @IsOptional() @IsString() client?: string;
  @IsOptional() @IsString() docTitle?: string;
}

export class UpdateDraftDto {
  @IsOptional() @IsString() docTitle?: string;
  @IsOptional() @IsString() industry?: string;
  @IsOptional() @IsString() product?: string;
  @IsOptional() @IsString() client?: string;
  @IsOptional() @IsIn(['draft', 'complete']) status?: 'draft' | 'complete';
  // Full or partial engine config — merged into the persisted config blob.
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsObject() ask?: WsAskDto;
}

export class ListDraftsQueryDto {
  @IsOptional() @IsUUID() prospectId?: string;
  @IsOptional() @IsString() sector?: string; // industry filter
  @IsOptional() @IsIn(['all', 'mine', 'shared']) scope?: 'all' | 'mine' | 'shared';
}
