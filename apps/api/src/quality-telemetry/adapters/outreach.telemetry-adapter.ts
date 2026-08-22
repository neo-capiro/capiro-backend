import type { TenantContext } from '@capiro/shared';
import type { QualityTelemetryEditMetrics, RecordQualityTelemetryEventInput } from '@capiro/meriv2-core';

export interface OutreachVersionTelemetrySource {
  versionId: string;
  artifactId: string;
  version: number;
  /** 'generated' | 'manually_authored' — maps 1:1 to the telemetry eventType. */
  generationStatus: string;
  contextPacketId: string | null;
}

/**
 * Builds a QualityTelemetryEvent for a newly persisted OutreachDraftVersion.
 * Pure function — called from `OutreachDraftService.auditAndReload`, the one
 * point all three version-creation paths (`upsertGeneratedVersion`,
 * `createEditedVersion`, `upsertGeneratedVersionOrCandidate`) already funnel
 * through, so this adapter does not need to know which path produced the
 * version.
 *
 * `editMetrics` is optional and MUST already be computed ephemerally by the
 * caller (see `edit-metrics.helpers.ts`) — this function never receives or
 * touches subject/body text itself.
 */
export function buildOutreachVersionTelemetryEvent(
  ctx: TenantContext,
  version: OutreachVersionTelemetrySource,
  editMetrics: QualityTelemetryEditMetrics | null,
  observedAt: Date,
): RecordQualityTelemetryEventInput {
  return {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    surface: 'outreach',
    operation: 'outreach.draft_version.generate',
    eventType: version.generationStatus === 'generated' ? 'generated' : 'edited',
    artifactType: 'outreach_draft_version',
    artifactId: version.versionId,
    artifactVersionSeq: version.version,
    contextPacketId: version.contextPacketId,
    editMetrics: editMetrics ? { ...editMetrics, versionsCount: version.version } : { versionsCount: version.version },
    observedAt,
  };
}

/**
 * Builds a QualityTelemetryEvent for an author's approval decision on an
 * exact draft version (`OutreachV3DraftApprovalService.approve`). There is
 * currently no corresponding "reject"/"hold" event in this codebase — Phase
 * 27E records only what actually exists (approve), not the aspirational
 * vocabulary from the original handoff.
 */
export function buildOutreachApprovalTelemetryEvent(
  ctx: TenantContext,
  params: { versionId: string; artifactId: string; contextPacketId: string },
  observedAt: Date,
): RecordQualityTelemetryEventInput {
  return {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    surface: 'outreach',
    operation: 'outreach.draft_version.approve',
    eventType: 'approved',
    artifactType: 'outreach_draft_version',
    artifactId: params.versionId,
    contextPacketId: params.contextPacketId,
    observedAt,
  };
}
