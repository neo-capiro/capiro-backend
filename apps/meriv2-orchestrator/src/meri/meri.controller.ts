import {
  BadRequestException,
  Body,
  Controller,
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
import { RequestCredentialsStore } from '../request/request-credentials.store.js';

interface InvokeBody {
  input?: unknown;
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
    const exec = () => this.registryService.registry.invoke(name, body?.input ?? {}, meriCtx);

    try {
      const result = token
        ? await RequestCredentialsStore.run({ bearerToken: token }, exec)
        : await exec();
      return { tool: name, result };
    } catch (err) {
      if (err instanceof ToolNotFoundError) throw new NotFoundException(err.message);
      if (err instanceof ToolInputValidationError) throw new BadRequestException(err.message);
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
