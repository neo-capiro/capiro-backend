import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { commitmentsAuditProcedureSkill } from './skills/commitments-audit.procedure.js';
import { MeriProcedureRuntimeValidationService } from './meri-procedure-runtime-validation.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const ctx = { tenantId: TENANT, userId: USER } as TenantContext;
const resolved = {
  ...commitmentsAuditProcedureSkill,
  procedureBinding: {
    source: 'firm' as const,
    recordId: 'procedure-row-1',
    canonicalId: 'commitments_audit',
    version: 3,
  },
};
const manifestDigest = createHash('sha256')
  .update(JSON.stringify(commitmentsAuditProcedureSkill.procedure))
  .digest('hex');
const input = {
  conversationId: CONVERSATION,
  clientId: CLIENT,
  scope: 'client' as const,
  recordId: 'procedure-row-1',
  canonicalId: 'commitments_audit',
  procedureVersion: 3,
  manifestDigest,
  toolName: 'query_tasks',
};

function harness(
  conversation: { id: string; clientId: string | null } | null = {
    id: CONVERSATION,
    clientId: CLIENT,
  },
  wallAllowed = true,
) {
  let currentConversation = conversation;
  let currentWallAllowed = wallAllowed;
  const findFirst = jest.fn(async () => currentConversation);
  const wallLookup = jest.fn(async () =>
    currentWallAllowed ? [{ allowed: true }] : [{ allowed: false }],
  );
  const prisma = {
    withTenantUser: jest.fn(
      async (_tenantId: string, _userId: string, run: (tx: unknown) => unknown) =>
        run({ clioConversation: { findFirst }, $queryRawUnsafe: wallLookup }),
    ),
  };
  const firmSkills = { resolveProcedureReference: jest.fn(async () => resolved) };
  return {
    service: new MeriProcedureRuntimeValidationService(prisma as never, firmSkills as never),
    findFirst,
    wallLookup,
    firmSkills,
    setConversation(next: { id: string; clientId: string | null } | null) {
      currentConversation = next;
    },
    setWallAllowed(next: boolean) {
      currentWallAllowed = next;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('MeriProcedureRuntimeValidationService', () => {
  it('binds current authority to the authenticated conversation owner and exact prepared identity', async () => {
    const h = harness();
    await expect(h.service.validate(ctx, input)).resolves.toEqual({
      authorized: true,
      identity: resolved.procedureBinding,
      manifestDigest,
    });
    expect(h.findFirst).toHaveBeenCalledWith({
      where: {
        id: CONVERSATION,
        tenantId: TENANT,
        userId: USER,
        archivedAt: null,
      },
      select: { id: true, clientId: true },
    });
    expect(h.firmSkills.resolveProcedureReference).toHaveBeenCalledWith(
      TENANT,
      resolved.procedureBinding,
    );
    expect(h.findFirst).toHaveBeenCalledTimes(2);
    expect(h.wallLookup).toHaveBeenCalledTimes(2);
    expect(h.wallLookup).toHaveBeenNthCalledWith(1, expect.any(String), TENANT, CLIENT, USER);
    expect(h.wallLookup).toHaveBeenNthCalledWith(2, expect.any(String), TENANT, CLIENT, USER);
  });

  it('fails closed when the authenticated actor does not own the conversation', async () => {
    const h = harness(null);
    await expect(h.service.validate(ctx, input)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.firmSkills.resolveProcedureReference).not.toHaveBeenCalled();
  });

  it('fails closed when current ethical-wall membership no longer permits the selected client', async () => {
    const h = harness(undefined, false);
    await expect(h.service.validate(ctx, input)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.firmSkills.resolveProcedureReference).not.toHaveBeenCalled();
  });

  it.each([
    ['current client changed', { clientId: null }, input],
    ['prepared scope changed', { clientId: CLIENT }, { ...input, scope: 'general' as const }],
    ['manifest changed', { clientId: CLIENT }, { ...input, manifestDigest: 'b'.repeat(64) }],
    ['tool is no longer allowed', { clientId: CLIENT }, { ...input, toolName: 'send_email' }],
  ])('fails closed when %s', async (_label, conversation, changed) => {
    const h = harness({ id: CONVERSATION, ...conversation });
    await expect(h.service.validate(ctx, changed)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fails closed on revoke, disable, version drift, or canonical resolver unavailability', async () => {
    const h = harness();
    h.firmSkills.resolveProcedureReference.mockRejectedValueOnce(
      new NotFoundException('Procedure binding is unavailable'),
    );
    await expect(h.service.validate(ctx, input)).rejects.toThrow(
      'Current procedure execution authority is unavailable',
    );
  });

  it('fails closed when the selected client drifts while canonical resolution is pending', async () => {
    const h = harness();
    const resolverStarted = deferred<void>();
    const releaseResolver = deferred<void>();
    h.firmSkills.resolveProcedureReference.mockImplementationOnce(async () => {
      resolverStarted.resolve();
      await releaseResolver.promise;
      return resolved;
    });

    const validation = h.service.validate(ctx, input);
    await resolverStarted.promise;
    h.setConversation({ id: CONVERSATION, clientId: null });
    releaseResolver.resolve();

    await expect(validation).rejects.toBeInstanceOf(NotFoundException);
    expect(h.findFirst).toHaveBeenCalledTimes(2);
    expect(h.wallLookup).toHaveBeenCalledTimes(1);
  });

  it('fails closed when conversation ownership or archive authority disappears during resolution', async () => {
    const h = harness();
    const resolverStarted = deferred<void>();
    const releaseResolver = deferred<void>();
    h.firmSkills.resolveProcedureReference.mockImplementationOnce(async () => {
      resolverStarted.resolve();
      await releaseResolver.promise;
      return resolved;
    });

    const validation = h.service.validate(ctx, input);
    await resolverStarted.promise;
    h.setConversation(null);
    releaseResolver.resolve();

    await expect(validation).rejects.toBeInstanceOf(NotFoundException);
    expect(h.findFirst).toHaveBeenCalledTimes(2);
    expect(h.wallLookup).toHaveBeenCalledTimes(1);
  });

  it('fails closed when ethical-wall authority is revoked while resolution is pending', async () => {
    const h = harness();
    const resolverStarted = deferred<void>();
    const releaseResolver = deferred<void>();
    h.firmSkills.resolveProcedureReference.mockImplementationOnce(async () => {
      resolverStarted.resolve();
      await releaseResolver.promise;
      return resolved;
    });

    const validation = h.service.validate(ctx, input);
    await resolverStarted.promise;
    h.setWallAllowed(false);
    releaseResolver.resolve();

    await expect(validation).rejects.toBeInstanceOf(NotFoundException);
    expect(h.findFirst).toHaveBeenCalledTimes(2);
    expect(h.wallLookup).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the canonical version changes during validation', async () => {
    const h = harness();
    const resolverStarted = deferred<void>();
    const releaseResolver = deferred<void>();
    h.firmSkills.resolveProcedureReference.mockImplementationOnce(async () => {
      resolverStarted.resolve();
      await releaseResolver.promise;
      return {
        ...resolved,
        procedureBinding: { ...resolved.procedureBinding, version: 4 },
      };
    });

    const validation = h.service.validate(ctx, input);
    await resolverStarted.promise;
    releaseResolver.resolve();

    await expect(validation).rejects.toBeInstanceOf(NotFoundException);
    expect(h.findFirst).toHaveBeenCalledTimes(1);
    expect(h.wallLookup).toHaveBeenCalledTimes(1);
  });
});
