import { releaseVersion } from './release-version.js';
import { denyProspectTransfer } from '../prospect-resources/prospect-draft-access.js';
// Approval Service — manages client-facing approval requests.
// A document changed after approval becomes approval-stale.

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit, canRead, canReview } from '../collaborators/role-policy.js';
import { readAgentState } from '../document-agent/document-agent-state.js';

@Injectable()
export class ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
  ) {}

  /**
   * Preflight: check if the pinned blueprint requires client-facing approval.
   */
  async preflight(
    tenantId: string,
    draftId: string,
    actorId: string,
  ): Promise<{
    requiresApproval: boolean;
    approvalPolicy: { clientFacingApprovalRequired: boolean; permittedApproverRoles: string[] };
    isStale: boolean;
  }> {
    await this.collaborators.assertCan(tenantId, draftId, actorId, canRead);
    const draft = await this.prisma.wsDraft.findFirst({
      where: { prospectId: null, id: draftId, tenantId },
    });
    if (!draft) throw new NotFoundException('Draft not found');

    const state = readAgentState(draft.config as Record<string, unknown>);

    // Load the pinned blueprint version to check the approval policy.
    let requiresApproval = false;
    let permittedApproverRoles: string[] = [];
    if (state.blueprintPin) {
      const version = await this.prisma.wsBlueprintVersion.findFirst({
        where: { id: state.blueprintPin.versionId, tenantId },
      });
      if (version) {
        const definition = version.definition as {
          approvalPolicy?: { clientFacingApprovalRequired?: boolean; permittedApproverRoles?: string[] };
        };
        requiresApproval = definition.approvalPolicy?.clientFacingApprovalRequired ?? false;
        permittedApproverRoles = definition.approvalPolicy?.permittedApproverRoles ?? [];
      }
    }

    // Check if there's an existing approval and the document changed after.
    const existingApproval = await this.prisma.wsApprovalRequest.findFirst({
      where: { tenantId, draftId, status: 'approved' },
      orderBy: { decidedAt: 'desc' },
    });
    let isStale = false;
    if (existingApproval) {
      try {
        await releaseVersion(this.prisma, tenantId, draftId, existingApproval.versionId);
      } catch (error) {
        if (!(error instanceof ConflictException) && !(error instanceof NotFoundException)) throw error;
        isStale = true;
      }
    }

    return {
      requiresApproval,
      approvalPolicy: {
        clientFacingApprovalRequired: requiresApproval,
        permittedApproverRoles,
      },
      isStale,
    };
  }

  /**
   * Create an approval request. 409 if already pending.
   */
  async createRequest(
    tenantId: string,
    draftId: string,
    actorId: string,
    params: { versionId?: string; notes?: string; idempotencyKey?: string },
  ): Promise<{ requestId: string; status: string }> {
    denyProspectTransfer(await this.prisma.wsDraft.findFirst({ where: { tenantId: tenantId, id: draftId }, select: { prospectId: true } }));

    await this.collaborators.assertCan(tenantId, draftId, actorId, canEdit);
    await releaseVersion(this.prisma, tenantId, draftId, params.versionId);

    // Check for existing pending request.
    const existing = await this.prisma.wsApprovalRequest.findFirst({
      where: { tenantId, draftId, status: 'pending' },
    });
    if (existing) {
      throw new ConflictException('An approval request is already pending for this draft.');
    }

    // Idempotency check.
    if (params.idempotencyKey) {
      const idem = await this.prisma.wsApprovalRequest.findFirst({
        where: { tenantId, draftId, notes: { contains: params.idempotencyKey } },
      });
      if (idem) return { requestId: idem.id, status: idem.status };
    }

    const request = await this.prisma.wsApprovalRequest.create({
      data: {
        tenantId,
        draftId,
        requestedById: actorId,
        status: 'pending',
        versionId: params.versionId,
        notes: params.notes,
      },
    });
    return { requestId: request.id, status: 'pending' };
  }

  /**
   * Make a decision on an approval request. Only owner/reviewer can decide.
   */
  async decide(
    tenantId: string,
    draftId: string,
    requestId: string,
    actorId: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ): Promise<{ status: string }> {
    denyProspectTransfer(await this.prisma.wsDraft.findFirst({ where: { tenantId: tenantId, id: draftId }, select: { prospectId: true } }));

    const role = await this.collaborators.assertCan(tenantId, draftId, actorId, canReview);

    const request = await this.prisma.wsApprovalRequest.findFirst({
      where: { id: requestId, tenantId, draftId },
    });
    if (!request) throw new NotFoundException('Approval request not found');
    if (request.status !== 'pending') {
      throw new ConflictException(`Approval request is already ${request.status}`);
    }

    const { policy } = await releaseVersion(this.prisma, tenantId, draftId, request.versionId);
    if (policy.permittedApproverRoles.length && !policy.permittedApproverRoles.includes(role!))
      throw new ForbiddenException('Your document role may not approve this revision');
    await this.collaborators.assertCan(tenantId, draftId, actorId, currentRole =>
      canReview(currentRole) && (!policy.permittedApproverRoles.length || policy.permittedApproverRoles.includes(currentRole!)));
    const saved = await this.prisma.wsApprovalRequest.updateMany({
      where: { id: requestId, tenantId, draftId, status: 'pending', versionId: request.versionId },
      data: {
        status: decision,
        reviewerId: actorId,
        decisionNote: note,
        decidedAt: new Date(),
      },
    });
    if (saved.count !== 1) throw new ConflictException('This approval request already changed');
    return { status: decision };
  }
}
