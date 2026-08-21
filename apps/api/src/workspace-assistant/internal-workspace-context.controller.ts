import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { WorkspaceContextPlaneService, type WorkspaceContextOperation } from './workspace-context-plane.service.js';

interface ResolveClientBody {
  tenantId?: string;
  clientName?: string;
}

interface AuthorizeClientBody {
  tenantId?: string;
  clerkUserId?: string;
  clientId?: string;
}

interface CompileWorkspaceContextBody {
  tenantId?: string;
  clerkUserId?: string;
  operationId?: WorkspaceContextOperation;
  request?: {
    clientId?: string | null;
    traceId?: string | null;
    ref?: Record<string, string | null | undefined>;
    task?: string | null;
  };
}

/** Backend-only Phase 21 bridge used by the isolated apps/workspace service. */
@Controller('internal/workspace/context')
@UseGuards(InternalServiceGuard)
export class InternalWorkspaceContextController {
  constructor(private readonly contextPlane: WorkspaceContextPlaneService) {}

  @Post('resolve-client')
  async resolveClient(@Body() body: ResolveClientBody): Promise<{ clientId: string | null }> {
    const tenantId = required(body.tenantId, 'tenantId');
    const clientName = required(body.clientName, 'clientName');
    return {
      clientId: await this.contextPlane.resolveClientIdByExactName(tenantId, clientName),
    };
  }

  @Post('authorize-client')
  async authorizeClient(@Body() body: AuthorizeClientBody): Promise<{ allowed: boolean }> {
    const tenantId = required(body.tenantId, 'tenantId');
    const clerkUserId = required(body.clerkUserId, 'clerkUserId');
    const clientId = required(body.clientId, 'clientId');
    const userId = await this.contextPlane.resolveUserIdByClerkId(clerkUserId);
    return {
      allowed: await this.contextPlane.clientAuthorized(tenantId, userId, clientId),
    };
  }

  @Post('compile')
  async compile(@Body() body: CompileWorkspaceContextBody) {
    const tenantId = required(body.tenantId, 'tenantId');
    const clerkUserId = required(body.clerkUserId, 'clerkUserId');
    const operationId = body.operationId;
    if (operationId !== 'workspace.generate' && operationId !== 'workspace.editor-assist') {
      throw new BadRequestException('Unsupported Workspace Context Plane operation');
    }
    const userId = await this.contextPlane.resolveUserIdByClerkId(clerkUserId);
    if (!userId) throw new BadRequestException('Workspace actor could not be resolved');

    const ref = body.request?.ref ?? {};
    const documentId =
      stringOrNull(ref.documentId) ?? stringOrNull(ref.draftId) ?? null;
    const surface = operationId === 'workspace.generate' ? 'workspace-gen' : 'workspace-editor';
    const task =
      body.request?.task?.trim() ||
      (operationId === 'workspace.generate'
        ? 'Generate the current Workspace document using governed firm, client, and institutional context.'
        : 'Assist with the current Workspace document using governed firm, client, and institutional context.');

    const result = await this.contextPlane.resolveForActor(
      { tenantId, userId },
      {
        operationId,
        surface,
        task,
        clientId: stringOrNull(body.request?.clientId),
        documentId,
        traceId: stringOrNull(body.request?.traceId),
        requestId: documentId,
        ref,
      },
    );
    return {
      kind: result.kind,
      packet: result.packet,
      governedContext: result.governedContext,
      supplementalEvidence: result.supplementalEvidence,
    };
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} is required`);
  }
  return value.trim();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
