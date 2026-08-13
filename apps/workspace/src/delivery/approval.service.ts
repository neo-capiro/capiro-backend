// Approval Service — manages client-facing approval requests.
// A document changed after approval becomes approval-stale.

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canReview } from '../collaborators/role-policy.js';
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
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
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
    const isStale = existingApproval
      ? draft.updatedAt.getTime() > (existingApproval.decidedAt?.getTime() ?? 0) + 1000
      : false;

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
    await this.collaborators.assertCan(tenantId, draftId, actorId, canReview);

    const request = await this.prisma.wsApprovalRequest.findFirst({
      where: { id: requestId, tenantId, draftId },
    });
    if (!request) throw new NotFoundException('Approval request not found');
    if (request.status !== 'pending') {
      throw new ConflictException(`Approval request is already ${request.status}`);
    }

    await this.prisma.wsApprovalRequest.update({
      where: { id: requestId },
      data: {
        status: decision,
        reviewerId: actorId,
        decisionNote: note,
        decidedAt: new Date(),
      },
    });
    return { status: decision };
  }
}
