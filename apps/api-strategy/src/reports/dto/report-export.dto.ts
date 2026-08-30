import { IsBoolean, IsIn, IsOptional } from "class-validator";

export const REPORT_FORMATS = ["docx", "pptx"] as const;
export const REPORT_AUDIENCES = ["client", "internal"] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];
export type ReportAudience = (typeof REPORT_AUDIENCES)[number];

export class ReportPreflightDto {
  @IsOptional()
  @IsIn(REPORT_AUDIENCES)
  audience?: ReportAudience;
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
}
