import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import {
  StrategyContextPlaneService,
  type StrategyArtifactKind,
  type StrategyContextMode,
} from './strategy-context-plane.service.js';

interface CompileStrategyContextBody {
  tenantId?: string;
  clerkUserId?: string;
  clientId?: string;
  mode?: StrategyContextMode;
  query?: string | null;
  strategyId?: string | null;
  nodeId?: string | null;
  traceId?: string | null;
  artifactKind?: StrategyArtifactKind | null;
}

/**
 * Backend-only bridge for the isolated api-strategy service.
 * Browser JWTs cannot call this route: the existing static service secret is
 * required and the main API independently re-resolves actor membership, client
 * status, ethical walls and mailbox ownership.
 */
@Controller('internal/strategy/context')
@UseGuards(InternalServiceGuard)
export class InternalStrategyContextController {
  constructor(private readonly strategyContext: StrategyContextPlaneService) {}

  @Post('compile')
  async compile(@Body() body: CompileStrategyContextBody) {
    const mode = body.mode;
    if (mode !== 'draft' && mode !== 'assistant' && mode !== 'document') {
      throw new BadRequestException('Unsupported Strategy context mode');
    }
    const artifactKind = artifactKindOrNull(body.artifactKind);
    if (mode === 'document' && !artifactKind) {
      throw new BadRequestException('Strategy document context requires an artifact kind');
    }
    if (mode !== 'document' && artifactKind) {
      throw new BadRequestException('artifactKind is valid only for Strategy document context');
    }

    return this.strategyContext.resolve({
      tenantId: required(body.tenantId, 'tenantId'),
      clerkUserId: required(body.clerkUserId, 'clerkUserId'),
      clientId: required(body.clientId, 'clientId'),
      mode,
      query: stringOrNull(body.query),
      strategyId: stringOrNull(body.strategyId),
      nodeId: stringOrNull(body.nodeId),
      traceId: stringOrNull(body.traceId),
      artifactKind,
    });
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

function artifactKindOrNull(value: unknown): StrategyArtifactKind | null {
  if (value == null || value === '') return null;
  if (value === 'workspace_draft' || value === 'outreach_record') return value;
  throw new BadRequestException('Unsupported Strategy artifact kind');
}
