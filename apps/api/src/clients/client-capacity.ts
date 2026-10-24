import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { CLIENT_SLOT_LIMIT_CODE, effectiveClientSlots } from '@capiro/shared';
import type { Prisma } from '@prisma/client';

type CapacityTenant = {
  billingStatus: string;
  clientSlots: number;
  ldaRegistrantId: number | null;
};

/** PostgreSQL serializes the existing count-and-insert rule across all admissions.
 * Caller keeps this transaction open through its insert or status update.
 */
export async function requireClientCapacity(
  tx: Prisma.TransactionClient,
  tenantId: string,
  billingEnforced: boolean,
  transition?: { clientId: string; status: string },
): Promise<CapacityTenant> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`client-capacity:${tenantId}`},0))`;
  const [tenant] = await tx.$queryRaw<CapacityTenant[]>`
    SELECT billing_status::text AS "billingStatus",client_slots AS "clientSlots",lda_registrant_id AS "ldaRegistrantId"
    FROM tenants WHERE id=${tenantId}::uuid FOR SHARE`;
  if (!tenant) throw new NotFoundException('Tenant not found');
  if (transition) {
    const [current] = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM clients WHERE tenant_id=${tenantId}::uuid AND id=${transition.clientId}::uuid FOR UPDATE`;
    if (!current) throw new NotFoundException('Client not found');
    // Archive releases a slot; already-active updates do not consume another.
    if (transition.status === 'archived' || current.status !== 'archived') return tenant;
  }
  if (!billingEnforced || tenant.billingStatus === 'comped') return tenant;
  const limit = effectiveClientSlots(tenant.billingStatus, tenant.clientSlots);
  const current = await tx.client.count({ where: { tenantId, status: { not: 'archived' } } });
  if (current >= limit)
    throw new HttpException(
      {
        code: CLIENT_SLOT_LIMIT_CODE,
        message: `You've used all ${limit} client slots on your plan. Add more slots to create another client.`,
        limit,
        current,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  return tenant;
}
