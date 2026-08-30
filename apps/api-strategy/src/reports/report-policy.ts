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

/** Only committed delivery states are eligible for a client deliverable. */
export function includeNodeForAudience(
  status: string,
  audience: "client" | "internal",
): boolean {
  return (
    audience === "internal" || status === "in_progress" || status === "active"
  );
}

/** Preserve the stored workflow state; audience filtering is handled above. */
export function reportStatusForAudience(
  status: string,
  _audience: "client" | "internal",
): string {
  return status;
}

/** Obvious scaffolding must never make it into a polished client file. */
export function isPlaceholderReportTitle(title: string): boolean {
  const normalized = title.replace(/\s+/g, " ").trim().toLowerCase();
  return (
    /^(?:new|untitled)\s+(?:step|item|node)$/.test(normalized) ||
    /^(?:test|sample|example|placeholder)(?:\s|$)/.test(normalized)
  );
}
