import { types as nodeTypes } from 'node:util';
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { resolveEvidenceAccuracyModeForTenant } from '../common/meri-evidence-accuracy-flags.js';
import { isMeriEvidenceModeRead, type MeriEvidenceModeReadOperation } from '../meri/meri-funding-read-observation.js';
import { hasVerifiedToolServiceIdentity } from '../meri/tool-service-secret.guard.js';
import type { ApplicationMembershipControl } from './application-membership.js';
import { ApplicationMembershipService } from './application-membership.service.js';

export interface ApplicationReadModeObservationRequest {
  operation: { id: MeriEvidenceModeReadOperation; version: '0.2.0' };
  requestSha256: string;
}

function invalid(): never { throw new BadRequestException('Invalid read mode observation request'); }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

export function parseApplicationReadModeObservationRequest(raw: unknown): ApplicationReadModeObservationRequest {
  const body = closed(raw, ['operation', 'requestSha256']);
  const operation = closed(body.operation, ['id', 'version']);
  if (typeof operation.id !== 'string' || !isMeriEvidenceModeRead(operation.id) || operation.version !== '0.2.0' ||
      typeof body.requestSha256 !== 'string' || body.requestSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(body.requestSha256)) invalid();
  return { operation: { id: operation.id, version: '0.2.0' }, requestSha256: body.requestSha256 };
}

@Injectable()
export class ApplicationReadModeObservationService {
  constructor(private readonly membership: ApplicationMembershipService) {}

  async read(req: Request, ctx: TenantContext, raw: unknown, control: ApplicationMembershipControl) {
    const input = parseApplicationReadModeObservationRequest(raw);
    if (!hasVerifiedToolServiceIdentity(req)) throw new ForbiddenException('Read mode observation requires verified service identity');
    control.assertActive();
    // This existing owner rechecks native identity, active membership and current scope across its awaits.
    const current = await this.membership.read(req, ctx, control);
    control.assertActive();
    if (current.tenantId !== ctx.tenantId || current.actorId !== ctx.userId || current.status !== 'active') {
      throw new ForbiddenException('Current read mode principal unavailable');
    }
    const evidenceAccuracyMode = resolveEvidenceAccuracyModeForTenant(current.tenantId, 'chat');
    control.assertActive();
    return { operation: input.operation, requestSha256: input.requestSha256,
      principal: { tenantId: current.tenantId, actorId: current.actorId }, surface: 'chat' as const, evidenceAccuracyMode };
  }
}
