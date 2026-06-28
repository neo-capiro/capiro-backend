import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { CollaboratorsService } from './collaborators.service.js';
import { canManageCollaborators, canRead } from './role-policy.js';
import { InviteCollaboratorDto, UpdateCollaboratorDto } from './dto/collaborator.dto.js';

/**
 * Collaborators on a work product (the WsDraft), surfaced in the UI as "this
 * document". All tenant-scoped via TenantGuard. Role enforcement uses the
 * central role matrix (role-policy.ts):
 *   - list   → any role with access (canRead)
 *   - invite / change role / remove → Owner only (canManageCollaborators)
 */
@Controller('drafts/:draftId/collaborators')
@UseGuards(TenantGuard)
export class CollaboratorsController {
  constructor(private readonly collaborators: CollaboratorsService) {}

  @Get()
  async list(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    await this.collaborators.assertCan(ctx.tenantId, draftId, ctx.clerkUserId, canRead);
    return this.collaborators.list(ctx.tenantId, draftId);
  }

  @Post()
  async invite(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: InviteCollaboratorDto,
  ) {
    await this.collaborators.assertCan(
      ctx.tenantId,
      draftId,
      ctx.clerkUserId,
      canManageCollaborators,
      'Only the document owner can invite collaborators',
    );
    return this.collaborators.invite(ctx.tenantId, draftId, ctx.clerkUserId, dto);
  }

  // E-19: the invitee accepts/declines their OWN pending invite. No owner gate —
  // the service verifies the actor is the invited subject. TenantGuard scopes it.
  @Post(':id/accept')
  accept(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('id') id: string,
  ) {
    return this.collaborators.accept(ctx.tenantId, draftId, id, ctx.clerkUserId);
  }

  @Post(':id/decline')
  decline(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('id') id: string,
  ) {
    return this.collaborators.decline(ctx.tenantId, draftId, id, ctx.clerkUserId);
  }

  @Patch(':id')
  async updateRole(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCollaboratorDto,
  ) {
    await this.collaborators.assertCan(
      ctx.tenantId,
      draftId,
      ctx.clerkUserId,
      canManageCollaborators,
      'Only the document owner can change roles',
    );
    return this.collaborators.updateRole(ctx.tenantId, draftId, id, dto);
  }

  @Delete(':id')
  async remove(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('id') id: string,
  ) {
    await this.collaborators.assertCan(
      ctx.tenantId,
      draftId,
      ctx.clerkUserId,
      canManageCollaborators,
      'Only the document owner can remove collaborators',
    );
    return this.collaborators.remove(ctx.tenantId, draftId, id);
  }
}
