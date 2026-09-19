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
    // Both default on for every audience: the narrative is generated only from
    // the already audience-filtered snapshot, and member-office profiles are
    // public-record reference data.
    includeNarrative: dto.includeNarrative ?? true,
    includeMemberProfiles: dto.includeMemberProfiles ?? true,
  };
}

const MEMBER_DIRECTORIES = new Set(["congress", "state", "staff"]);

/**
 * Reduce a stored node `targetRef` to the report-safe member reference. Only
 * congressional and state members are profiled; staff targets are not
 * "member offices" and are left as plain target labels.
 */
export function extractMemberRef(
  value: unknown,
): import("./report.types.js").ReportMemberRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const memberId =
    typeof record.memberId === "string" ? record.memberId.trim() : "";
  if (!memberId) return null;
  const text = (key: string): string | null => {
    const candidate = record[key];
    return typeof candidate === "string" && candidate.trim()
      ? candidate.trim()
      : null;
  };
  const sourceDirectory = text("sourceDirectory");
  return {
    memberId,
    memberName: text("memberName"),
    party: text("party"),
    state: text("state"),
    chamber: text("chamber"),
    committee: text("committee"),
    sourceDirectory:
      sourceDirectory && MEMBER_DIRECTORIES.has(sourceDirectory)
        ? (sourceDirectory as "congress" | "state" | "staff")
        : null,
  };
}

/**
 * Every live plan step is eligible for either audience. Workflow status is a
 * workflow signal, not a delivery gate: generated (suggested) and in-draft
 * steps belong in the export without a human promotion step. Intentional
 * exclusions stay possible by archiving/removing the step itself.
 */
export function includeNodeForAudience(
  status: string,
  audience: "client" | "internal",
): boolean {
  void status;
  void audience;
  return true;
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
