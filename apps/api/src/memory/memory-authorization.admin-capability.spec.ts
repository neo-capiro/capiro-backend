import { describe, expect, it, jest } from '@jest/globals';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';

const subject = {
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: TENANT,
  clientId: null,
  ownerUserId: ADMIN,
  proposedByUserId: ADMIN,
  memoryClass: 'institutional_authoritative' as const,
  scope: 'firm' as const,
  status: 'pending_review' as const,
  legalHold: false,
  clientStatus: null,
};

function harness() {
  const executeRaw = jest.fn(async () => 1);
  const tx = { $executeRaw: executeRaw };
  const service = new MemoryAuthorizationService({} as PrismaService);
  return { service, tx, executeRaw };
}

describe('MemoryAuthorizationService administrator decision capability', () => {
  it('sets the transaction-local capability after an allowed admin decision', async () => {
    const h = harness();
    await expect(
      h.service.evaluateInTx(
        h.tx as never,
        { tenantId: TENANT, userId: ADMIN, role: 'user_admin' },
        subject,
        'approve',
      ),
    ).resolves.toEqual({ allowed: true, basis: 'admin' });
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
  });

  it('does not arm the capability during read-model simulations', async () => {
    const h = harness();
    await expect(
      h.service.evaluateInTx(
        h.tx as never,
        { tenantId: TENANT, userId: ADMIN, role: 'user_admin' },
        subject,
        'approve',
        { emitDenialMetrics: false },
      ),
    ).resolves.toEqual({ allowed: true, basis: 'admin' });
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it('does not give the admin capability to a standard-user decision', async () => {
    const h = harness();
    await expect(
      h.service.evaluateInTx(
        h.tx as never,
        { tenantId: TENANT, userId: '44444444-4444-4444-8444-444444444444', role: 'standard_user' },
        { ...subject, proposedByUserId: 'someone-else' },
        'approve',
      ),
    ).resolves.toEqual({ allowed: false, reason: 'admin_required' });
    expect(h.executeRaw).not.toHaveBeenCalled();
  });
});
