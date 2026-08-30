import type { ReportExportDto } from "./dto/report-export.dto.js";
import type { NormalizedReportOptions } from "./report.types.js";

/** Normalize defaults and apply the non-negotiable client-facing redaction policy. */
export function normalizeReportOptions(
  dto: ReportExportDto,
): NormalizedReportOptions {
  const isClient = dto.audience === "client";
  return {
    format: dto.format,
    audience: dto.audience,
    useClientLogo: dto.useClientLogo ?? true,
    includeRoadmap: dto.includeRoadmap ?? true,
    includeEvidenceAppendix: dto.includeEvidenceAppendix ?? true,
    // These surfaces can contain practitioner commentary or automation detail.
    // The audience decision wins over every submitted switch.
    includeChangeLog: isClient ? false : (dto.includeChangeLog ?? false),
    includeInternalNotes: isClient
      ? false
      : (dto.includeInternalNotes ?? false),
    includeAgentHistory: isClient ? false : (dto.includeAgentHistory ?? false),
  };
}

/** Unaccepted Meri suggestions are working material, never client deliverables. */
export function includeNodeForAudience(
  status: string,
  audience: "client" | "internal",
): boolean {
  return audience === "internal" || status !== "suggested";
}

/** Replace workflow-only review state with client-safe delivery language. */
export function reportStatusForAudience(
  status: string,
  audience: "client" | "internal",
): string {
  return audience === "client" && status === "internal_review"
    ? "in_progress"
    : status;
}
