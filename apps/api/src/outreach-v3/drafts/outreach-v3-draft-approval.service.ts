import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OutreachDraftService } from '../../engagement/outreach-draft.service.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import { OutreachUserDecisionEventService } from '../services/outreach-user-decision-event.service.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import {
  createOutreachV3DraftApprovalSnapshot,
  isOutreachV3ExactVersionApproved,
  type OutreachV3DraftApprovalSnapshot,
  type OutreachV3DraftVersionIdentity,
} from './outreach-v3-draft-lifecycle.js';
import {
  buildOutreachV3GenerationPlan,
  type OutreachV3GenerationPlan,
} from '../generation/outreach-v3-generation-plan.js';

export interface OutreachV3DraftApprovalResult {
  approval: OutreachV3DraftApprovalSnapshot;
  eventId: string;
  eventSequence: string;
  idempotent: boolean;
}

@Injectable()
export class OutreachV3DraftApprovalService {
  constructor(
    private readonly sessions: OutreachSessionService,
    private readonly drafts: OutreachDraftService,
    private readonly prisma: PrismaService,
    private readonly decisions: OutreachUserDecisionEventService,
  ) {}

  async approve(
    ctx: TenantContext,
    sessionId: string,
    versionId: string,
  ): Promise<OutreachV3DraftApprovalResult> {
    const current = await this.sessions.getSession(ctx, sessionId);
    if (current.session.status !== 'active') {
      throw new OutreachCommandError(
        'OUTREACH_SESSION_ARCHIVED',
        'Archived outreach sessions cannot approve draft versions.',
        409,
      );
    }
    const plan = buildOutreachV3GenerationPlan({
      sessionId,
      stateVersion: current.currentStateVersion,
      specHash: current.specHash,
      spec: current.spec,
      readiness: current.readiness,
      pendingProposalCount: current.pendingProposalCount,
    });
    if (!plan.eligible) {
      throw blocked(
        'The current campaign plan is not eligible for draft approval.',
        'generation_plan_not_eligible',
      );
    }

    const version = await this.drafts.getVersion(ctx, versionId);
    if (version.outreachRecordId !== sessionId) {
      throw new OutreachCommandError(
        'OUTREACH_REFERENCE_UNAUTHORIZED',
        'The draft version does not belong to this outreach campaign.',
        403,
      );
    }
    if (!plan.slots.some((slot) => slot.generationKey === version.generationKey)) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_INVALID',
        'The draft version does not belong to the current generation plan.',
        400,
      );
    }

    const persisted = await this.loadVersionArtifactAndPacket(ctx, version.id, version.artifactId);
    if (!persisted.contextPacketId) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'The draft version is missing its immutable evidence packet reference.',
        500,
      );
    }
    if (persisted.currentVersion !== version.version) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CONFLICT',
        'A newer version of this draft exists. Review the current version before approving.',
        409,
        { currentVersion: persisted.currentVersion },
      );
    }
    assertPacketMatchesPlan(persisted.packetRef, sessionId, plan);

    const identity: OutreachV3DraftVersionIdentity = {
      versionId: version.id,
      artifactId: version.artifactId,
      generationKey: version.generationKey,
      contentHash: version.contentHash,
      planHash: plan.planHash,
      generationStatus: version.generationStatus,
      auditStatus: version.auditStatus,
      baseApprovalStatus: version.approvalStatus,
    };

    let approval: OutreachV3DraftApprovalSnapshot;
    try {
      approval = createOutreachV3DraftApprovalSnapshot({
        sessionId,
        stateVersion: plan.stateVersion,
        specHash: plan.specHash,
        planHash: plan.planHash,
        version: identity,
      });
    } catch {
      throw blocked(
        'This exact draft version is not reviewable for author approval.',
        'draft_version_not_approvable',
      );
    }

    const committed = await this.decisions.append(ctx, sessionId, {
      eventType: 'draft_version_approved',
      expectedStateVersion: plan.stateVersion,
      payloadHash: approval.approvalHash,
      safeMetadata: {
        schemaVersion: approval.schemaVersion,
        approval,
      },
    });
    return {
      approval,
      eventId: committed.event.id,
      eventSequence: committed.event.sequence.toString(),
      idempotent: committed.idempotent,
    };
  }

  async getCurrentApproval(
    ctx: TenantContext,
    sessionId: string,
    versionId: string,
    plan?: OutreachV3GenerationPlan,
  ): Promise<OutreachV3DraftApprovalSnapshot | null> {
    const currentPlan = plan ?? (await this.currentPlan(ctx, sessionId));
    const version = await this.drafts.getVersion(ctx, versionId);
    if (version.outreachRecordId !== sessionId) return null;

    const persisted = await this.loadVersionArtifactAndPacket(ctx, version.id, version.artifactId);
    if (
      persisted.currentVersion !== version.version ||
      !persisted.contextPacketId ||
      !packetMatchesPlan(persisted.packetRef, sessionId, currentPlan)
    ) {
      return null;
    }

    const event = await this.loadLatestApprovalEvent(ctx, sessionId, versionId);
    if (!event) return null;
    const metadata = asRecord(event.safeMetadataJsonb);
    const approval = asRecord(metadata.approval) as unknown as OutreachV3DraftApprovalSnapshot;
    const identity: OutreachV3DraftVersionIdentity = {
      versionId: version.id,
      artifactId: version.artifactId,
      generationKey: version.generationKey,
      contentHash: version.contentHash,
      planHash: currentPlan.planHash,
      generationStatus: version.generationStatus,
      auditStatus: version.auditStatus,
      baseApprovalStatus: version.approvalStatus,
    };
    return isOutreachV3ExactVersionApproved(identity, currentPlan.planHash, approval)
      ? approval
      : null;
  }

  private async currentPlan(
    ctx: TenantContext,
    sessionId: string,
  ): Promise<OutreachV3GenerationPlan> {
    const current = await this.sessions.getSession(ctx, sessionId);
    return buildOutreachV3GenerationPlan({
      sessionId,
      stateVersion: current.currentStateVersion,
      specHash: current.specHash,
      spec: current.spec,
      readiness: current.readiness,
      pendingProposalCount: current.pendingProposalCount,
    });
  }

  private async loadVersionArtifactAndPacket(
    ctx: TenantContext,
    versionId: string,
    artifactId: string,
  ): Promise<{
    currentVersion: number;
    contextPacketId: string | null;
    packetRef: Record<string, unknown>;
  }> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.outreachDraftVersion.findFirst({
        where: { id: versionId, tenantId: ctx.tenantId, artifactId },
        select: {
          contextPacketId: true,
          artifact: {
            select: {
              currentVersion: true,
              createdByUserId: true,
            },
          },
        },
      });
      if (!row || row.artifact.createdByUserId !== ctx.userId) {
        throw new OutreachCommandError(
          'OUTREACH_REFERENCE_UNAUTHORIZED',
          'The draft artifact is not available to this user.',
          403,
        );
      }
      if (!row.contextPacketId) {
        return {
          currentVersion: row.artifact.currentVersion,
          contextPacketId: null,
          packetRef: {},
        };
      }
      const packet = await tx.contextPacket.findFirst({
        where: { id: row.contextPacketId, tenantId: ctx.tenantId },
        select: { ref: true },
      });
      if (!packet) {
        throw new OutreachCommandError(
          'OUTREACH_STATE_CORRUPT',
          'The draft evidence packet could not be found.',
          500,
        );
      }
      return {
        currentVersion: row.artifact.currentVersion,
        contextPacketId: row.contextPacketId,
        packetRef: asRecord(packet.ref),
      };
    });
  }

  private async loadLatestApprovalEvent(
    ctx: TenantContext,
    sessionId: string,
    versionId: string,
  ): Promise<{ safeMetadataJsonb: unknown } | null> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ safeMetadataJsonb: unknown }>>`
        SELECT safe_metadata_jsonb AS "safeMetadataJsonb"
        FROM outreach_events
        WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND session_id = CAST(${sessionId} AS uuid)
          AND event_type = 'draft_version_approved'
          AND safe_metadata_jsonb -> 'approval' ->> 'versionId' = ${versionId}
        ORDER BY sequence DESC
        LIMIT 1
      `;
      return rows[0] ?? null;
    });
  }
}

function assertPacketMatchesPlan(
  packetRef: Record<string, unknown>,
  sessionId: string,
  plan: OutreachV3GenerationPlan,
): void {
  if (!packetMatchesPlan(packetRef, sessionId, plan)) {
    throw new OutreachCommandError(
      'OUTREACH_STATE_CONFLICT',
      'This draft version was created from an older campaign plan.',
      409,
      { reason: 'draft_version_stale' },
    );
  }
}

function packetMatchesPlan(
  packetRef: Record<string, unknown>,
  sessionId: string,
  plan: OutreachV3GenerationPlan,
): boolean {
  return (
    asString(packetRef.outreachV3SessionId) === sessionId &&
    Number(packetRef.outreachV3StateVersion ?? NaN) === plan.stateVersion &&
    asString(packetRef.outreachV3SpecHash) === plan.specHash &&
    asString(packetRef.outreachV3PlanHash) === plan.planHash
  );
}

function blocked(message: string, reason: string): OutreachCommandError {
  return new OutreachCommandError('OUTREACH_COMMAND_BLOCKED', message, 409, { reason });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
