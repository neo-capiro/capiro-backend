import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import type { AuthorizedCapabilityContext } from './capability-context.js';
import { CapabilityError } from './capability-errors.js';

export interface AuthorizedClientSummary {
  id: string;
  name: string;
  website: string | null;
  description: string | null;
  sectorTag: string | null;
  status: string;
  updatedAt: Date;
}

@Injectable()
export class CapabilityAuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  async authorizeClient(
    ctx: AuthorizedCapabilityContext,
    clientId: string,
  ): Promise<AuthorizedClientSummary> {
    if (ctx.clientScope && ctx.clientScope.clientId !== clientId) {
      throw new CapabilityError(
        'CAPABILITY_INVALID_SCOPE',
        'The requested client does not match the authorized client scope.',
        false,
        true,
      );
    }
    return this.prisma.withTenantUser(ctx.tenantId, ctx.actorUserId, (tx) =>
      this.authorizeClientWithinTx(tx, ctx, clientId),
    );
  }

  /**
   * Same tenant/client/ethical-wall authorization as authorizeClient(), but on
   * a transaction the caller already owns. Phase 2 needs this so reference
   * authorization, expected-version locking and state persistence are one
   * atomic decision boundary instead of a nested preflight transaction.
   */
  async authorizeClientWithinTx(
    tx: Prisma.TransactionClient,
    ctx: AuthorizedCapabilityContext,
    clientId: string,
  ): Promise<AuthorizedClientSummary> {
    if (ctx.clientScope && ctx.clientScope.clientId !== clientId) {
      throw new CapabilityError(
        'CAPABILITY_INVALID_SCOPE',
        'The requested client does not match the authorized client scope.',
        false,
        true,
      );
    }

    const client = await tx.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId },
      select: {
        id: true,
        name: true,
        website: true,
        description: true,
        sectorTag: true,
        status: true,
        updatedAt: true,
      },
    });
    if (!client) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', 'The requested record was not found.');
    }
    const allowed = await clientMemoryAllowed(
      tx,
      ctx.tenantId,
      ctx.actorUserId,
      clientId,
    );
    if (!allowed) {
      throw new CapabilityError(
        'CAPABILITY_ETHICAL_WALL',
        'The requested client context is restricted by an ethical wall.',
      );
    }
    return client;
  }
}
