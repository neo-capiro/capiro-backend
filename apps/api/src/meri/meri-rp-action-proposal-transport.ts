import { createHash, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import type { CreateMeriActionProposalInput } from './meri-action-proposal.service.js';
import {
  isResearchPortfolioProposalTool,
  type ResearchPortfolioProposalTurnScope,
} from './meri-rp-proposal-binding.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AdmittedMeriActionProposal {
  request: CreateMeriActionProposalInput;
  trustedTurn?: ResearchPortfolioProposalTurnScope;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function secretMatches(provided: string, expected: string): boolean {
  const actual = createHash('sha256').update(provided, 'utf8').digest();
  const wanted = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(actual, wanted);
}

function parseProposal(
  value: unknown,
): CreateMeriActionProposalInput & { input: Record<string, unknown> } {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !['tool', 'input', 'conversationId', 'surface'].includes(key),
    ) ||
    typeof value.tool !== 'string' ||
    value.tool.length < 1 ||
    value.tool.length > 120 ||
    !object(value.input) ||
    value.surface !== 'chat' ||
    (value.conversationId !== undefined &&
      (typeof value.conversationId !== 'string' || !UUID.test(value.conversationId)))
  ) {
    throw new BadRequestException('Action proposal request is invalid');
  }
  return value as unknown as CreateMeriActionProposalInput & {
    input: Record<string, unknown>;
  };
}

function requireServiceIdentity(req: Request): void {
  const expected = process.env.INTERNAL_SERVICE_SECRET?.trim();
  const rawHeader = req.headers['x-internal-service-secret'];
  const provided = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader)?.trim() ?? '';
  if (!expected) {
    throw new ForbiddenException('Internal service identity is not configured for this route');
  }
  if (!provided || !secretMatches(provided, expected)) {
    throw new ForbiddenException('This route requires a valid internal service identity');
  }
}

/** Strict admission applies only to RP proposal creation; ordinary proposals retain their body. */
export function admitMeriActionProposalTransport(
  rawBody: unknown,
  ctx: TenantContext,
  req: Request,
): AdmittedMeriActionProposal {
  if (!object(rawBody)) throw new BadRequestException('Action proposal request is invalid');
  const isEnvelope = ['version', 'proposal', 'currentTurn'].some((key) =>
    Object.hasOwn(rawBody, key),
  );
  if (!isEnvelope) {
    const request = parseProposal(rawBody);
    if (isResearchPortfolioProposalTool(request.tool.trim())) {
      requireServiceIdentity(req);
      throw new BadRequestException(
        'Trusted current-turn transport is required for a Research Portfolio action proposal.',
      );
    }
    return { request };
  }
  if (
    Object.keys(rawBody).some((key) => !['version', 'proposal', 'currentTurn'].includes(key)) ||
    rawBody.version !== 1 ||
    !object(rawBody.currentTurn)
  ) {
    throw new BadRequestException('Trusted Research Portfolio proposal transport is invalid');
  }
  const request = parseProposal(rawBody.proposal);
  if (!isResearchPortfolioProposalTool(request.tool.trim())) {
    throw new BadRequestException(
      'Trusted proposal transport is reserved for Research Portfolio tools',
    );
  }
  requireServiceIdentity(req);
  const currentTurn = rawBody.currentTurn;
  if (
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
      (typeof currentTurn.selectedClientId !== 'string' ||
        !UUID.test(currentTurn.selectedClientId)))
  ) {
    throw new BadRequestException('Trusted Research Portfolio current-turn scope is invalid');
  }
  if (currentTurn.tenantId !== ctx.tenantId || currentTurn.userId !== ctx.userId) {
    throw new ForbiddenException('Trusted Research Portfolio proposal actor does not match');
  }
  if (
    request.conversationId !== undefined &&
    request.conversationId !== currentTurn.conversationId
  ) {
    throw new BadRequestException(
      'Research Portfolio proposal does not match the current conversation',
    );
  }
  const suppliedInner = request.input.conversationId;
  if (suppliedInner !== undefined && suppliedInner !== currentTurn.conversationId) {
    throw new BadRequestException(
      'Research Portfolio proposal input does not match the current conversation',
    );
  }
  const trustedTurn = Object.freeze({
    conversationId: currentTurn.conversationId,
    selectedClientId: currentTurn.selectedClientId as string | null,
  });
  return {
    request: {
      ...request,
      input: { ...request.input, conversationId: trustedTurn.conversationId },
      conversationId: trustedTurn.conversationId,
    },
    trustedTurn,
  };
}
