import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { normalizeIdentifierType } from './entity-normalization.js';
import type {
  ConfirmedEntityResolutionGovernanceResult,
  ConfirmResolutionGovernanceInput,
  EntityGovernanceReasonCode,
  GovernEntityLinkInput,
  RejectResolutionGovernanceInput,
  RejectedEntityResolutionResult,
} from './entity-identity-governance.types.js';
import { ENTITY_GOVERNANCE_REASON_CODES } from './entity-identity-governance.types.js';
import { EntityIdentityGovernanceRepository } from './entity-identity-governance.repository.js';
import { UniversalEntityResolutionService } from './universal-entity-resolution.service.js';

/**
 * Human-review boundary for canonical entity resolution and tenant-private
 * identity links. This service is internal; product surfaces should call it
 * through an authorization-aware application service/controller later.
 */
@Injectable()
export class EntityIdentityGovernanceService {
  constructor(
    private readonly repository: EntityIdentityGovernanceRepository,
    private readonly resolver: UniversalEntityResolutionService,
  ) {}

  async confirmResolution(
    tenantId: string,
    input: ConfirmResolutionGovernanceInput,
  ): Promise<ConfirmedEntityResolutionGovernanceResult> {
    requireActor(input.actorUserId);
    const result = await this.resolver.correctResolution(tenantId, {
      resolutionId: input.resolutionId,
      selectedEntityId: input.selectedEntityId,
      actorUserId: input.actorUserId,
      reason: input.reason ?? null,
    });
    const governanceEventId = await this.repository.recordResolutionConfirmation(
      tenantId,
      input.resolutionId,
      result.resolutionId,
      input.selectedEntityId,
      input.actorUserId,
      input.reason?.trim() || null,
      governanceIdempotencyKey({
        action: 'resolution_confirmed',
        tenantId,
        originalResolutionId: input.resolutionId,
        correctedResolutionId: result.resolutionId,
        selectedEntityId: input.selectedEntityId,
        actorUserId: input.actorUserId,
      }),
    );
    return { ...result, governanceEventId };
  }

  async rejectResolution(
    tenantId: string,
    input: RejectResolutionGovernanceInput,
  ): Promise<RejectedEntityResolutionResult> {
    requireActor(input.actorUserId);
    const reasonCode = normalizeReasonCode(input.reasonCode);
    return this.repository.rejectResolution(
      tenantId,
      input,
      governanceIdempotencyKey({
        action: 'resolution_rejected',
        tenantId,
        resolutionId: input.resolutionId,
        actorUserId: input.actorUserId,
        reasonCode,
        reason: input.reason?.trim() || null,
      }),
      reasonCode,
    );
  }

  confirmAlias(tenantId: string, input: GovernEntityLinkInput): Promise<string> {
    return this.governAlias(tenantId, 'confirm', input);
  }

  withdrawAlias(tenantId: string, input: GovernEntityLinkInput): Promise<string> {
    return this.governAlias(tenantId, 'withdraw', input);
  }

  confirmIdentifier(tenantId: string, input: GovernEntityLinkInput): Promise<string> {
    return this.governIdentifier(tenantId, 'confirm', input);
  }

  withdrawIdentifier(tenantId: string, input: GovernEntityLinkInput): Promise<string> {
    return this.governIdentifier(tenantId, 'withdraw', input);
  }

  private governAlias(
    tenantId: string,
    action: 'confirm' | 'withdraw',
    input: GovernEntityLinkInput,
  ): Promise<string> {
    requireActor(input.actorUserId);
    const reasonCode = normalizeReasonCode(input.reasonCode);
    return this.repository.governAlias(
      tenantId,
      action,
      input,
      governanceIdempotencyKey({
        action: `alias_${action}`,
        tenantId,
        linkId: input.linkId,
        actorUserId: input.actorUserId,
        reasonCode,
        reason: input.reason?.trim() || null,
      }),
      reasonCode,
    );
  }

  private governIdentifier(
    tenantId: string,
    action: 'confirm' | 'withdraw',
    input: GovernEntityLinkInput,
  ): Promise<string> {
    requireActor(input.actorUserId);
    const reasonCode = normalizeReasonCode(input.reasonCode);
    return this.repository.governIdentifier(
      tenantId,
      action,
      input,
      governanceIdempotencyKey({
        action: `identifier_${action}`,
        tenantId,
        linkId: input.linkId,
        actorUserId: input.actorUserId,
        reasonCode,
        reason: input.reason?.trim() || null,
      }),
      reasonCode,
    );
  }
}

function normalizeReasonCode(value: EntityGovernanceReasonCode | string): string {
  const normalized = normalizeIdentifierType(value);
  if (!(ENTITY_GOVERNANCE_REASON_CODES as readonly string[]).includes(normalized)) {
    throw new BadRequestException(`Unsupported entity governance reason: ${normalized}.`);
  }
  return normalized;
}

function requireActor(actorUserId: string): void {
  if (!actorUserId?.trim()) {
    throw new BadRequestException('Entity governance actions require actorUserId.');
  }
}

function governanceIdempotencyKey(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
