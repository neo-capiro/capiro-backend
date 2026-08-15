import { IsObject, IsString, IsOptional, IsBoolean, Min } from 'class-validator';

/** DTO for creating a new blueprint (POST /template-studio/blueprints). */
export class CreateBlueprintDto {
  @IsString()
  slug!: string;

  @IsString()
  name!: string;

  @IsString()
  product!: string;

  @IsString()
  @IsOptional()
  description?: string;

  /** 'capiro' (global, tenantId null) or 'firm' (tenant-scoped). Defaults to
   *  'firm' when omitted — only capiro-authored blueprints use 'capiro'. */
  @IsString()
  @IsOptional()
  scope?: 'capiro' | 'firm';
}

/** DTO for creating a new draft version (POST /blueprints/:id/versions). */
export class CreateVersionDto {
  /** Carry-over note for the new draft (optional). The version number is
   *  auto-assigned as max(existing)+1. */
  @IsString()
  @IsOptional()
  note?: string;
}

/** DTO for updating a draft version's definition
 *  (PATCH /blueprints/:id/versions/:versionId). */
export class UpdateVersionDto {
  @IsObject()
  definition!: Record<string, unknown>;

  @IsString()
  @IsOptional()
  note?: string;
}

/** DTO for cloning a blueprint into a new draft version
 *  (POST /blueprints/:id/clone). Clones the latest version's definition. */
export class CloneBlueprintDto {
  @IsString()
  @IsOptional()
  note?: string;

  /** Optional specific source version id to clone from; defaults to the
   *  blueprint's latest version. */
  @IsString()
  @IsOptional()
  fromVersionId?: string;
}

/** DTO for the deterministic test run
 *  (POST /blueprints/:id/versions/:versionId/test). */
export class TestVersionDto {
  /** Simulated intake answers keyed by intake-question id. Optional — missing
   *  answers are treated as blank for the dry run. */
  @IsObject()
  @IsOptional()
  answers?: Record<string, unknown>;
}

/** Shape returned by the compare endpoint (GET /blueprints/:id/compare). */
export interface CompareVersionsResult {
  blueprintId: string;
  versions: Array<{
    versionId: string;
    version: number;
    status: string;
    definitionHash: string;
    createdAt: Date;
    publishedAt: Date | null;
  }>;
  /** Per-version structural diff summary (which top-level keys changed). */
  diffs: Array<{
    fromVersionId: string;
    toVersionId: string;
    changedKeys: string[];
  }>;
}

/** Re-export for convenience so callers can validate numeric bounds. */
export const MIN_VERSION = 1;
export class MinVersion {
  @Min(1)
  value = MIN_VERSION;
}
