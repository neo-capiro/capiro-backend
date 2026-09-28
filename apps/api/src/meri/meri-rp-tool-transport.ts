import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  authorizeMeriResearchPortfolioScope,
  ResearchPortfolioMeriScopeService,
} from '../research-portfolios/research-portfolio-meri-scope.service.js';
import { isResearchPortfolioProposalTool } from './meri-rp-proposal-binding.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MeriResearchPortfolioToolTurnScope {
  tenantId: string;
  userId: string;
  conversationId: string;
  selectedClientId: string | null;
}

interface ResearchPortfolioToolEnvelope {
  version: 1;
  input: Record<string, unknown>;
  currentTurn: MeriResearchPortfolioToolTurnScope;
}

const storage = new AsyncLocalStorage<MeriResearchPortfolioToolTurnScope>();

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function secretMatches(provided: string, expected: string): boolean {
  const actual = createHash('sha256').update(provided, 'utf8').digest();
  const wanted = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(actual, wanted);
}

function parseEnvelope(value: unknown): ResearchPortfolioToolEnvelope {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['version', 'input', 'currentTurn'].includes(key))
  ) {
    throw new BadRequestException('Trusted Research Portfolio tool transport context is required');
  }
  const currentTurn = value.currentTurn;
  if (
    value.version !== 1 ||
    !object(value.input) ||
    !object(currentTurn) ||
    Object.keys(currentTurn).some(
      (key) => !['tenantId', 'userId', 'conversationId', 'selectedClientId'].includes(key),
    ) ||
    typeof currentTurn.tenantId !== 'string' ||
    !UUID.test(currentTurn.tenantId) ||
    typeof currentTurn.userId !== 'string' ||
    !UUID.test(currentTurn.userId) ||
    typeof currentTurn.conversationId !== 'string' ||
    !UUID.test(currentTurn.conversationId) ||
    (currentTurn.selectedClientId !== null &&
      (typeof currentTurn.selectedClientId !== 'string' || !UUID.test(currentTurn.selectedClientId)))
  ) {
    throw new BadRequestException('Trusted Research Portfolio tool transport context is invalid');
  }
  return value as unknown as ResearchPortfolioToolEnvelope;
}

/** Strict admission is confined to the canonical RP tool names, including the future guard. */
export function admitMeriResearchPortfolioToolTransport(
  name: string,
  rawBody: unknown,
  ctx: TenantContext,
  req: Request,
): { input: Record<string, unknown>; scope?: MeriResearchPortfolioToolTurnScope } {
  if (!isResearchPortfolioProposalTool(name)) {
    return { input: object(rawBody) ? rawBody : {} };
  }
  const expected = process.env.INTERNAL_SERVICE_SECRET?.trim();
  const rawHeader = req.headers['x-internal-service-secret'];
  const provided = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader)?.trim() ?? '';
  if (!expected) {
    throw new ForbiddenException('Internal service identity is not configured for this route');
  }
  if (!provided || !secretMatches(provided, expected)) {
    throw new ForbiddenException('This route requires a valid internal service identity');
  }
  const envelope = parseEnvelope(rawBody);
  if (
    envelope.currentTurn.tenantId !== ctx.tenantId ||
    envelope.currentTurn.userId !== ctx.userId
  ) {
    throw new ForbiddenException('Trusted Research Portfolio tool actor context does not match');
  }
  const suppliedConversation = envelope.input.conversationId;
  if (
    suppliedConversation !== undefined &&
    suppliedConversation !== envelope.currentTurn.conversationId
  ) {
    throw new BadRequestException(
      'Research Portfolio tool input does not match the current conversation',
    );
  }
  return {
    input: { ...envelope.input, conversationId: envelope.currentTurn.conversationId },
    scope: Object.freeze({ ...envelope.currentTurn }),
  };
}

export function withMeriResearchPortfolioToolTurnScope<T>(
  scope: MeriResearchPortfolioToolTurnScope,
  run: () => T,
): T {
  return storage.run(scope, run);
}

/**
 * Rechecks the authenticated current conversation and RP grant immediately at
 * the canonical delegation boundary. The final conversation read catches
 * client/receipt drift while the asynchronous grant is being resolved.
 */
export async function executeMeriResearchPortfolioToolAtCurrentUse<T>(options: {
  prisma: PrismaService;
  scopeService: ResearchPortfolioMeriScopeService | undefined;
  ctx: TenantContext;
  name: string;
  input: Record<string, unknown>;
  execute: () => Promise<T>;
}): Promise<T> {
  const currentTurn = storage.getStore();
  // Durable action-proposal execution and the genuine legacy in-process owner
  // path have separate server authority. Only delegated RP HTTP transport sets
  // this scope; once set, it is mandatory through dispatch.
  if (!currentTurn) return options.execute();
  if (
    currentTurn.tenantId !== options.ctx.tenantId ||
    currentTurn.userId !== options.ctx.userId ||
    options.input.conversationId !== currentTurn.conversationId
  ) {
    throw new ForbiddenException('Research Portfolio current-turn authority does not match');
  }
  if (!options.scopeService) {
    throw new ForbiddenException('Research Portfolio current-turn authority is unavailable');
  }
  const loadConversation = () =>
    options.prisma.withTenant(options.ctx.tenantId, (tx) =>
      tx.clioConversation.findFirst({
        where: {
          id: currentTurn.conversationId,
          tenantId: options.ctx.tenantId,
          userId: options.ctx.userId,
          archivedAt: null,
        },
        select: { metadata: true, clientId: true },
      }),
    );
  const conversation = await loadConversation();
  if (!conversation) throw new NotFoundException('Meri conversation not found');
  if (conversation.clientId !== currentTurn.selectedClientId) {
    throw new BadRequestException('The current conversation client no longer matches this turn');
  }
  const granted = await authorizeMeriResearchPortfolioScope(
    options.scopeService,
    options.ctx,
    conversation.metadata,
  );
  if (!granted) {
    throw new BadRequestException('This conversation is not scoped to a Research Portfolio');
  }
  const fresh = await loadConversation();
  if (!fresh) throw new NotFoundException('Meri conversation not found');
  if (fresh.clientId !== currentTurn.selectedClientId) {
    throw new BadRequestException(
      'The current conversation client changed while Research Portfolio access was checked',
    );
  }
  if (!isDeepStrictEqual(fresh.metadata, conversation.metadata)) {
    throw new BadRequestException(
      'The current Research Portfolio conversation scope changed while access was checked',
    );
  }
  return options.execute();
}