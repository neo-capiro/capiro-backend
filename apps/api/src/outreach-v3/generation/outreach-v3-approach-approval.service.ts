import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OutreachDraftService } from '../../engagement/outreach-draft.service.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import { OutreachUserDecisionEventService } from '../services/outreach-user-decision-event.service.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import {
  createOutreachV3ApproachApprovalSnapshot,
  createOutreachV3ReviewPacketApprovalSnapshot,
  isOutreachV3ApproachApprovalCurrent,
  isOutreachV3ReviewPacketApproval,
  type OutreachV3ApproachApprovalSnapshot,
  type OutreachV3SampleVersionRef,
} from './outreach-v3-generation-approach.js';
import {
  buildOutreachV3GenerationPlan,
  type OutreachV3GenerationPlan,
} from './outreach-v3-generation-plan.js';

export interface OutreachV3ApproachApprovalResult {
  approval: OutreachV3ApproachApprovalSnapshot;
  eventId: string;
  eventSequence: string;
  idempotent: boolean;
}

export interface OutreachV3ReviewPacketApprovalResult extends OutreachV3ApproachApprovalResult {
  /**
   * Existing workers load the historical approach-approved stream. This second
   * bounded marker carries the review-packet gateVersion and no sample ids;
   * the separate primary event remains the truthful audit decision.
   */
  compatibilityEventId: string;
  compatibilityEventSequence: string;
}

@Injectable()
export class OutreachV3ApproachApprovalService {
  constructor(
    private readonly sessions: OutreachSessionService,
    private readonly drafts: OutreachDraftService,
    private readonly prisma: PrismaService,
    private readonly decisions: OutreachUserDecisionEventService,
  ) {}

  async approve(
    ctx: TenantContext,
    sessionId: string,
    versionIds: readonly string[],
  ): Promise<OutreachV3ApproachApprovalResult> {
    const current = await this.sessions.getSession(ctx, sessionId);
    if (current.session.status !== 'active') {
      throw new OutreachCommandError(
        'OUTREACH_SESSION_ARCHIVED',
        'Archived outreach sessions cannot accept approach approval.',
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
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'The current campaign plan is not eligible for approach approval.',
        409,
        { reason: 'generation_plan_not_eligible' },
      );
    }

    const uniqueVersionIds = [...new Set(versionIds)];
    if (
      uniqueVersionIds.length !== versionIds.length ||
      uniqueVersionIds.length !== plan.representativeSampleKeys.length ||
      uniqueVersionIds.length === 0 ||
      uniqueVersionIds.length > 3
    ) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_INVALID',
        'Approach approval must reference exactly the current representative sample versions.',
        400,
      );
    }

    const samples: OutreachV3SampleVersionRef[] = [];
    for (const versionId of uniqueVersionIds) {
      const version = await this.drafts.getVersion(ctx, versionId);
      if (version.outreachRecordId !== sessionId) {
        throw new OutreachCommandError(
          'OUTREACH_REFERENCE_UNAUTHORIZED',
          'A reviewed sample does not belong to this outreach campaign.',
          403,
        );
      }
      if (!plan.representativeSampleKeys.includes(version.generationKey)) {
        throw new OutreachCommandError(
          'OUTREACH_COMMAND_INVALID',
          'A reviewed draft is not one of the current representative samples.',
          400,
        );
      }

      const contextPacketId = await this.loadVersionContextPacketId(ctx, version.id);
      if (!contextPacketId) {
        throw new OutreachCommandError(
          'OUTREACH_STATE_CORRUPT',
          'A reviewed sample is missing its immutable evidence packet reference.',
          500,
        );
      }
      const packetRef = await this.loadPacketRef(ctx, contextPacketId);
      const packetPlanHash = asString(packetRef.outreachV3PlanHash);
      const packetSessionId = asString(packetRef.outreachV3SessionId);
      const packetStateVersion = Number(packetRef.outreachV3StateVersion ?? NaN);
      const packetSpecHash = asString(packetRef.outreachV3SpecHash);
      if (
        packetSessionId !== sessionId ||
        packetPlanHash !== plan.planHash ||
        packetStateVersion !== plan.stateVersion ||
        packetSpecHash !== plan.specHash
      ) {
        throw new OutreachCommandError(
          'OUTREACH_STATE_CONFLICT',
          'A reviewed sample was generated from an older campaign plan.',
          409,
          { reason: 'representative_sample_stale' },
        );
      }

      samples.push({
        generationKey: version.generationKey,
        artifactId: version.artifactId,
        versionId: version.id,
        contentHash: version.contentHash,
        planHash: packetPlanHash,
        auditStatus: version.auditStatus,
        generationStatus: version.generationStatus,
      });
    }

    let approval: OutreachV3ApproachApprovalSnapshot;
    try {
      approval = createOutreachV3ApproachApprovalSnapshot(plan, samples);
    } catch {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'Representative samples are not all reviewable under the current plan.',
        409,
        { reason: 'representative_samples_not_reviewable' },
      );
    }

    const committed = await this.decisions.append(ctx, sessionId, {
      eventType: 'approach_approved',
      expectedStateVersion: plan.stateVersion,
      payloadHash: approval.approvalHash,
      safeMetadata: {
        schemaVersion: approval.gateVersion,
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

  /**
   * Record the guided workflow's explicit acceptance of the exact review
   * packet. This is not sample approval: it carries no draft ids or bodies and
   * cannot approve a final version. It authorizes asynchronous draft generation
   * only while this exact Campaign Spec/plan remains current.
   */
  async approveReviewPacket(
    ctx: TenantContext,
    sessionId: string,
  ): Promise<OutreachV3ReviewPacketApprovalResult> {
    const current = await this.sessions.getSession(ctx, sessionId);
    if (current.session.status !== 'active') {
      throw new OutreachCommandError(
        'OUTREACH_SESSION_ARCHIVED',
        'Archived outreach sessions cannot accept review-packet approval.',
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
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'Complete the review packet before authorizing draft generation.',
        409,
        { reason: 'generation_plan_not_eligible' },
      );
    }

    const approval = createOutreachV3ReviewPacketApprovalSnapshot(plan);
    // Truthful audit event first. If the compatibility append fails, a retry is
    // safe and generation remains blocked until both durable markers exist.
    const committed = await this.decisions.append(ctx, sessionId, {
      eventType: 'review_packet_approved',
      expectedStateVersion: plan.stateVersion,
      payloadHash: approval.approvalHash,
      safeMetadata: {
        schemaVersion: approval.gateVersion,
        decisionMeaning: 'review_packet_accepted_for_draft_generation',
        approval,
      },
    });
    // The existing async worker intentionally reads only the established
    // approach-approved stream. Preserve that durable contract while the
    // gateVersion makes the different human decision explicit and fail-closed.
    const compatibility = await this.decisions.append(ctx, sessionId, {
      eventType: 'approach_approved',
      expectedStateVersion: plan.stateVersion,
      payloadHash: approval.approvalHash,
      safeMetadata: {
        schemaVersion: approval.gateVersion,
        compatibilitySource: 'review_packet_approved',
        decisionMeaning: 'review_packet_generation_gate',
        approval,
      },
    });

    return {
      approval,
      eventId: committed.event.id,
      eventSequence: committed.event.sequence.toString(),
      compatibilityEventId: compatibility.event.id,
      compatibilityEventSequence: compatibility.event.sequence.toString(),
      idempotent: committed.idempotent && compatibility.idempotent,
    };
  }

  async getCurrent(
    ctx: TenantContext,
    sessionId: string,
    plan?: OutreachV3GenerationPlan,
  ): Promise<OutreachV3ApproachApprovalSnapshot | null> {
    const currentPlan = plan ?? (await this.currentPlan(ctx, sessionId));
    const event = await this.decisions.latest(ctx, sessionId, 'approach_approved');
    if (!event) return null;
    const metadata = asRecord(event.safeMetadataJsonb);
    const approval = asRecord(metadata.approval) as unknown as OutreachV3ApproachApprovalSnapshot;
    if (!isOutreachV3ApproachApprovalCurrent(currentPlan, approval)) return null;
    if (isOutreachV3ReviewPacketApproval(approval)) return approval;

    const artifacts = await this.drafts.listForOutreach(ctx, sessionId);
    const currentByArtifact = new Map(
      artifacts.map((artifact) => [artifact.id, artifact.current] as const),
    );
    const samplesStillCurrent = approval.sampleVersions.every((sample) => {
      const current = currentByArtifact.get(sample.artifactId);
      return Boolean(
        current &&
        current.id === sample.versionId &&
        current.contentHash === sample.contentHash &&
        current.generationKey === sample.generationKey,
      );
    });
    return samplesStillCurrent ? approval : null;
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

  private async loadVersionContextPacketId(
    ctx: TenantContext,
    versionId: string,
  ): Promise<string | null> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.outreachDraftVersion.findFirst({
        where: { id: versionId, tenantId: ctx.tenantId },
        select: {
          contextPacketId: true,
          artifact: { select: { createdByUserId: true } },
        },
      });
      if (!row || row.artifact.createdByUserId !== ctx.userId) return null;
      return row.contextPacketId;
    });
  }

  private async loadPacketRef(
    ctx: TenantContext,
    contextPacketId: string,
  ): Promise<Record<string, unknown>> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const packet = await tx.contextPacket.findFirst({
        where: { id: contextPacketId, tenantId: ctx.tenantId },
        select: { ref: true },
      });
      if (!packet) {
        throw new OutreachCommandError(
          'OUTREACH_STATE_CORRUPT',
          'A reviewed sample evidence packet could not be found.',
          500,
        );
      }
      return asRecord(packet.ref);
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
