import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { commitmentsAuditProcedureSkill } from './skills/commitments-audit.procedure.js';
import { builtinProcedureDigest } from './native-procedures/selected-procedure.js';
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
    service: new MeriProcedureRuntimeValidationService(
      prisma as never,
      firmSkills as never,
      { read: jest.fn() } as never,
    ),
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

describe('MeriProcedureRuntimeValidationService — native selected-procedure crossing', () => {
  const revisions = {
    identityRevision: 'a'.repeat(64),
    membershipRevision: 'b'.repeat(64),
    contextRevision: 'c'.repeat(64),
  };
  const builtinInput = {
    conversationId: CONVERSATION,
    clientId: CLIENT,
    scope: 'client' as const,
    toolName: 'get_client_context',
    selector: {
      source: 'builtin' as const,
      id: 'briefing' as const,
      version: 1,
      manifestDigest: builtinProcedureDigest('briefing'),
    },
  };

  function nativeHarness(
    options: {
      conversation?: { id: string; clientId: string | null } | null;
      wallAllowed?: boolean;
      post?: Record<string, string>;
      rows?: unknown[];
    } = {},
  ) {
    const conversation =
      options.conversation === undefined
        ? { id: CONVERSATION, clientId: CLIENT }
        : options.conversation;
    const findFirst = jest.fn(async () => conversation);
    const wallLookup = jest.fn(async () =>
      options.wallAllowed === false ? [{ allowed: false }] : [{ allowed: true }],
    );
    const prisma = {
      withTenantUser: jest.fn(
        async (_tenantId: string, _userId: string, run: (tx: unknown) => unknown) =>
          run({ clioConversation: { findFirst }, $queryRawUnsafe: wallLookup }),
      ),
    };
    const read = jest.fn();
    read
      .mockResolvedValueOnce({ ...revisions })
      .mockResolvedValueOnce({ ...revisions, ...(options.post ?? {}) });
    const list = jest.fn(async () => options.rows ?? []);
    const resolveProcedureReference = jest.fn();
    const service = new MeriProcedureRuntimeValidationService(
      prisma as never,
      { list, resolveProcedureReference } as never,
      { read } as never,
    );
    return { service, read, findFirst, wallLookup, list, resolveProcedureReference };
  }

  it('admits a stable builtin and traces the identity owner before and after resolution', async () => {
    const h = nativeHarness();

    const admission = await h.service.admitSelectedProcedure(ctx, {} as never, builtinInput);

    expect(admission.identity).toEqual({
      source: 'builtin',
      id: 'briefing',
      canonicalId: 'briefing',
      version: 1,
    });
    expect(admission.manifestDigest).toBe(builtinProcedureDigest('briefing'));
    expect(admission.policy.allowedTools).toContain('get_client_context');
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.read).toHaveBeenNthCalledWith(1, ctx, expect.anything(), {
      conversationId: CONVERSATION,
      clientId: CLIENT,
    });
    expect(h.read).toHaveBeenNthCalledWith(2, ctx, expect.anything(), {
      conversationId: CONVERSATION,
      clientId: CLIENT,
    });
    expect(h.findFirst).toHaveBeenCalledTimes(2);
    expect(h.wallLookup).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['identity', { identityRevision: 'd'.repeat(64) }],
    ['membership', { membershipRevision: 'e'.repeat(64) }],
    ['context', { contextRevision: 'f'.repeat(64) }],
  ])(
    'refuses admission when the %s revision drifts after resolution',
    async (_label, post) => {
      const h = nativeHarness({ post: post as Record<string, string> });
      await expect(
        h.service.admitSelectedProcedure(ctx, {} as never, builtinInput),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(h.read).toHaveBeenCalledTimes(2);
    },
  );

  it('refuses a prepared tool outside the resolved read surface', async () => {
    const h = nativeHarness();
    await expect(
      h.service.admitSelectedProcedure(ctx, {} as never, {
        ...builtinInput,
        toolName: 'send_email',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a prepared scope that does not match the resolved scope', async () => {
    const h = nativeHarness();
    await expect(
      h.service.admitSelectedProcedure(ctx, {} as never, { ...builtinInput, scope: 'general' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses before resolution when the conversation owner denies access', async () => {
    const h = nativeHarness({ conversation: null });
    await expect(
      h.service.admitSelectedProcedure(ctx, {} as never, builtinInput),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it('refuses before resolution when the ethical wall no longer permits the client', async () => {
    const h = nativeHarness({ wallAllowed: false });
    await expect(
      h.service.admitSelectedProcedure(ctx, {} as never, builtinInput),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it('refuses a firm selector replayed after the tenant row advanced', async () => {
    const h = nativeHarness({
      rows: [
        {
          id: 'row-1',
          skillId: 'commitments_audit',
          version: 4,
          enabled: true,
          runnable: true,
          procedureDigest: 'a'.repeat(64),
        },
      ],
    });
    await expect(
      h.service.admitSelectedProcedure(ctx, {} as never, {
        ...builtinInput,
        selector: { source: 'firm', recordId: 'row-1', version: 3, manifestDigest: 'a'.repeat(64) },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.resolveProcedureReference).not.toHaveBeenCalled();
  });

  it('refuses an unsupported selector instead of falling through to a legacy runtime', async () => {
    const h = nativeHarness();
    await expect(
      h.service.admitSelectedProcedure(ctx, {} as never, {
        ...builtinInput,
        selector: {
          source: 'builtin',
          id: 'not_a_procedure' as never,
          version: 1,
          manifestDigest: 'a'.repeat(64),
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.resolveProcedureReference).not.toHaveBeenCalled();
  });
});
