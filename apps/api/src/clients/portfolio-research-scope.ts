import { BadRequestException, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';

export type PortfolioResearchPurpose = 'capabilities' | 'alignment' | 'business_units';
export type PortfolioResearchScope = {
  purpose: PortfolioResearchPurpose;
  capabilityId?: string;
  capabilityVersion?: number;
};
export function portfolioResearchScope(input: {
  purpose?: unknown;
  capabilityId?: unknown;
}): PortfolioResearchScope | undefined {
  if (input.purpose === undefined && input.capabilityId === undefined) return undefined;
  if (!['capabilities', 'alignment', 'business_units'].includes(String(input.purpose)))
    throw new BadRequestException('Invalid portfolio research purpose');
  if (
    input.capabilityId !== undefined &&
    (typeof input.capabilityId !== 'string' || !isUUID(input.capabilityId))
  )
    throw new BadRequestException('Invalid capability research scope');
  if (input.purpose === 'alignment' && !input.capabilityId)
    throw new BadRequestException('Alignment research requires a capability');
  if (input.purpose === 'business_units' && input.capabilityId)
    throw new BadRequestException('Business unit research belongs to the company');
  return {
    purpose: input.purpose as PortfolioResearchPurpose,
    ...(input.capabilityId ? { capabilityId: String(input.capabilityId).toLowerCase() } : {}),
  };
}
export async function authorizePortfolioResearchScope(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  scope?: PortfolioResearchScope,
) {
  if (!scope?.capabilityId) return scope;
  const cap = await tx.clientCapability.findFirst({
    where: { id: scope.capabilityId, tenantId: ctx.tenantId, clientId },
    select: { id: true, version: true },
  });
  if (!cap) throw new NotFoundException('Capability not found');
  return { ...scope, capabilityVersion: cap.version };
}
export function readPortfolioResearchScope(value: unknown): PortfolioResearchScope | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Invalid saved portfolio scope');
  const input = value as Record<string, unknown>;
  const scope = portfolioResearchScope(input);
  if (
    !scope ||
    (scope.capabilityId &&
      (!Number.isInteger(input.capabilityVersion) || Number(input.capabilityVersion) < 1))
  )
    throw new BadRequestException('Invalid saved capability revision');
  return {
    ...scope,
    ...(scope.capabilityId ? { capabilityVersion: Number(input.capabilityVersion) } : {}),
  };
}
