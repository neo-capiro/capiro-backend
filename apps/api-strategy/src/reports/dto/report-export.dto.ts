import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from "class-validator";

export const REPORT_FORMATS = ["docx", "pptx"] as const;
export const REPORT_AUDIENCES = ["client", "internal"] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];
export type ReportAudience = (typeof REPORT_AUDIENCES)[number];

/** Query strings stay strict while mapping literal true/false to booleans. */
function QueryBoolean() {
  return Transform(({ value }: { value: unknown }) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  });
}

export class ReportPreflightDto {
  @IsOptional()
  @IsIn(REPORT_AUDIENCES)
  audience?: ReportAudience;

  @IsOptional()
  @IsIn(REPORT_FORMATS)
  format?: ReportFormat;

  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  useClientLogo?: boolean;

  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  includeRoadmap?: boolean;

  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  includeEvidenceAppendix?: boolean;

  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  includeChangeLog?: boolean;

  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  includeInternalNotes?: boolean;

  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  includeAgentHistory?: boolean;
}

/**
 * Options for a synchronous executive report export.
 *
 * Defaults deliberately produce a polished client-ready report. Internal-only
 * switches are still normalized server-side so a client export can never leak
 * notes, version commentary, or agent/runtime history even if a caller submits
 * those flags as true.
 */
export class ReportExportDto {
  @IsIn(REPORT_FORMATS)
  format!: ReportFormat;

  @IsIn(REPORT_AUDIENCES)
  audience!: ReportAudience;

  @IsOptional()
  @IsBoolean()
  useClientLogo?: boolean;

  @IsOptional()
  @IsBoolean()
  includeRoadmap?: boolean;

  @IsOptional()
  @IsBoolean()
  includeEvidenceAppendix?: boolean;

  @IsOptional()
  @IsBoolean()
  includeChangeLog?: boolean;

  @IsOptional()
  @IsBoolean()
  includeInternalNotes?: boolean;

  @IsOptional()
  @IsBoolean()
  includeAgentHistory?: boolean;

  /** Optional optimistic concurrency token returned by report preflight. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  expectedSnapshotHash?: string;
}
