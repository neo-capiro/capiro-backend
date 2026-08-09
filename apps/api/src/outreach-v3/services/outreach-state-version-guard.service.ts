import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { OutreachStateRepository } from '../persistence/outreach-state.repository.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';

/**
 * Narrow read/concurrency seam exported for later phases that must prove the
 * Campaign Spec did not move between external work and a short commit step.
 * It cannot mutate campaign state and does not expose the command engine.
 */
@Injectable()
export class OutreachStateVersionGuardService {
  constructor(private readonly repository: OutreachStateRepository) {}

  async assertCurrentWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    expectedStateVersion: number,
  ): Promise<void> {
    const session = await this.repository.lockOwnedSession(tx, ctx, sessionId);
    if (session.status !== 'active') {
      throw new OutreachCommandError(
        'OUTREACH_SESSION_ARCHIVED',
        'The outreach session is not active.',
        409,
      );
    }
    if (session.currentStateVersion !== expectedStateVersion) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CONFLICT',
        'The outreach session changed while external work was running.',
        409,
        { currentStateVersion: session.currentStateVersion },
      );
    }
  }
}
