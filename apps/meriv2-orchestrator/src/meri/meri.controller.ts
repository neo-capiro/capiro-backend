import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ToolInputValidationError, ToolNotFoundError } from '@capiro/meriv2-core';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { OrchestratorTenantContext } from '../auth/tenant-context.js';
import { MeriRegistryService } from './meri-registry.service.js';
import { MeriContextResolver } from './meri-context.resolver.js';
import {
  RequestCredentialsStore,
  type ResolvedAiProvider,
} from '../request/request-credentials.store.js';

interface InvokeBody {
  input?: unknown;
}

/**
 * Parse the caller-resolved tenant AI credential (BYOK option c) from the
 * `x-capiro-ai-provider` header: JSON `{provider,apiKey,model,usedTenantKey,
 * modelOverridden}` produced by apps/api's AiCredentialResolverService and sent
 * over the already-authenticated TLS request. Malformed/incomplete values are
 * DROPPED (global-fallback path) rather than rejected, and the header content
 * is never logged — it carries key material.
 */
export function parseAiProviderHeader(req: Request): ResolvedAiProvider | undefined {
  const raw = req.headers['x-capiro-ai-provider'];
  if (!raw || typeof raw !== 'string') return undefined;
  try {
    const p = JSON.parse(raw) as Partial<ResolvedAiProvider>;
    if (
      (p.provider === 'anthropic' || p.provider === 'openai') &&
      typeof p.apiKey === 'string' &&
      p.apiKey.length > 0 &&
      typeof p.model === 'string' &&
      p.model.length > 0
    ) {
      return {
        provider: p.provider,
        apiKey: p.apiKey,
        model: p.model,
        usedTenantKey: p.usedTenantKey === true,
        modelOverridden: p.modelOverridden === true,
      };
    }
  } catch {
    /* malformed → treated as absent */
  }
  return undefined;
}

/**
 * The orchestrator's HTTP surface for the tool registry, mounted under
 * `/meri-api/tools` (global prefix + this controller). Every route is gated by
 * TenantGuard (verified Clerk JWT → tenant context); a tool invocation resolves
 * the full MeriContext and runs inside the forwarded-credential scope.
 */
@Controller('tools')
@UseGuards(TenantGuard)
export class MeriController {
  constructor(
    private readonly registryService: MeriRegistryService,
    private readonly resolver: MeriContextResolver,
  ) {}

  @Get()
  list(): { tools: string[] } {
    return { tools: this.registryService.registry.list() };
  }

  @Post(':name/invoke')
  async invoke(
    @Param('name') name: string,
    @Body() body: InvokeBody,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ): Promise<{ tool: string; result: unknown }> {
    const meriCtx = await this.resolver.resolve(tc);
    const token = extractBearerToken(req);
    const aiProvider = parseAiProviderHeader(req);
    const exec = () => this.registryService.registry.invoke(name, body?.input ?? {}, meriCtx);

    try {
      const result =
        token || aiProvider
          ? await RequestCredentialsStore.run(
              { bearerToken: token ?? '', ...(aiProvider ? { aiProvider } : {}) },
              exec,
            )
          : await exec();
      return { tool: name, result };
    } catch (err) {
      if (err instanceof ToolNotFoundError) throw new NotFoundException(err.message);
      if (err instanceof ToolInputValidationError) throw new BadRequestException(err.message);
      // Gate outcomes are structured API responses, not 500s: a held write is a
      // 409 carrying the same {pendingApproval, message} shape the chat surface
      // returns, so a direct invoker can approve (POST /api/clio/approvals/
      // approve) and retry; a policy block is a 403.
      if ((err as Error).name === 'ApprovalPendingError') {
        throw new ConflictException({
          pendingApproval: true,
          tool: name,
          message: (err as Error).message,
        });
      }
      if ((err as Error).name === 'ComplianceBlockedError') {
        throw new ForbiddenException({
          blocked: true,
          tool: name,
          message: (err as Error).message,
        });
      }
      throw err;
    }
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? req.headers['Authorization'];
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}
