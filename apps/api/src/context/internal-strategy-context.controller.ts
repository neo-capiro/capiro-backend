import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { ObjectiveGenerationContextService } from './objective-generation-context.service.js';
import {
  StrategyContextPlaneService,
  type StrategyArtifactKind,
  type StrategyContextMode,
} from './strategy-context-plane.service.js';

interface CompileStrategyContextBody {
  objective?: { objectiveId: string; objectiveVersion: number };
  generationRequestId?: string;
  generationType?: string;
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
  constructor(private readonly strategyContext: StrategyContextPlaneService,
    private readonly objectiveContext?: ObjectiveGenerationContextService) {}

  @Post('objective-check')
  async objectiveCheck(@Body() body: CompileStrategyContextBody) {
    validateObjective(body);
    if (!body.objective || !this.objectiveContext) throw new BadRequestException('Objective selector required');
    return this.strategyContext.checkObjective({ ...body, mode: 'draft',
      tenantId: required(body.tenantId, 'tenantId'), clerkUserId: required(body.clerkUserId, 'clerkUserId'), clientId: required(body.clientId, 'clientId') });
  }

  @Post('compile')
  async compile(@Body() body: CompileStrategyContextBody) {
    validateObjective(body);
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
      ...(body.objective ? { objective: body.objective, generationRequestId: body.generationRequestId, generationType: body.generationType } : {}),
    });
  }
}

function validateObjective(body: CompileStrategyContextBody) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid Strategy context request');
  if (!body.objective && body.generationRequestId == null && body.generationType == null) return;
  const allowed = ['tenantId','clerkUserId','clientId','mode','query','strategyId','nodeId','traceId','artifactKind','objective','generationRequestId','generationType'];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const selector = body.objective;
  if (Object.keys(body).some(k => !allowed.includes(k)) || !selector ||
      Object.keys(selector).sort().join(',') !== 'objectiveId,objectiveVersion' ||
      body.mode !== 'draft' || body.strategyId != null || body.nodeId != null || body.artifactKind != null ||
      ![body.tenantId, body.clientId, body.generationRequestId, selector.objectiveId].every(v => typeof v === 'string' && uuid.test(v)) ||
      !Number.isInteger(selector.objectiveVersion) || selector.objectiveVersion < 1 || selector.objectiveVersion > 2147483647 ||
      !['appropriations','authorization','regulatory','coalition','procurement','earmark','amendment'].includes(body.generationType ?? ''))
    throw new BadRequestException('Invalid Objective context request');
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
