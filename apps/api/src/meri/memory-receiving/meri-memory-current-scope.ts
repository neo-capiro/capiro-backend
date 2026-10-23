import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { DelegationFacts } from '../../auth/read-delegation/read-delegation-facts.js';
import { assertGeneralOrigin } from '../../auth/read-delegation/read-delegation-general.js';
import { isUuid } from '../../auth/read-delegation/read-delegation.contract.js';
import { assertDelegatedClientVisible } from '../../auth/read-delegation/read-delegation-request.js';

/** Existing page/helper transactions already checked current member, consent,
 * run and reservation. General additionally needs the durable explicit origin;
 * every returned memory record is rechecked by canonical eligibility SQL. */
export async function assertMemoryCurrentScope(tx: Prisma.TransactionClient,
  d: DelegationFacts, clerkUserId: string, claims: { clientId: string | null; scopeKind?: 'general' }) {
  if (d.clientId !== claims.clientId || d.scopeKind !== claims.scopeKind)
    throw new ForbiddenException('Memory origin scope changed');
  if (d.scopeKind === 'general') {
    if (d.mode !== 'attended' || d.clientId !== null) throw new ForbiddenException('General memory scope refused');
    await assertGeneralOrigin(tx, { tenantId: d.tenantId, actorId: d.userId, conversationId: d.conversationId });
  } else {
    if (!isUuid(d.clientId)) throw new ForbiddenException('Client memory scope refused');
    await assertDelegatedClientVisible(tx, d.tenantId, clerkUserId, d.clientId);
  }
}
