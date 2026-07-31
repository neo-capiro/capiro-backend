import type { TenantContext } from '@capiro/shared';
import { ContextPacketPersistenceError } from '@capiro/meriv2-core';
import { createGovernedMeriResearchService } from './governed-meri-research.factory.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

function makeHarness(mode: 'off' | 'shadow' | 'enforce') {
  const tx = {
    client: {
      findFirst: jest.fn().mockResolvedValue({
        name: 'Acme',
        description: 'Client description',
        productDescription: null,
      }),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const contextCompiler = {
    modeFor: jest.fn().mockResolvedValue(mode),
    compile: jest.fn().mockResolvedValue({
      version: mode === 'enforce' ? 2 : 1,
      rendered: [{ body: 'Firm-approved governed context.' }],
    }),
  };
  const service = createGovernedMeriResearchService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    contextCompiler as never,
  );
  const load = (service as unknown as {
    clientContext: (value: TenantContext, clientId: string | null) => Promise<string | null>;
  }).clientContext.bind(service);
  return { load, contextCompiler };
}

describe('createGovernedMeriResearchService', () => {
  it('keeps off mode byte-compatible and does not compile a packet', async () => {
    const { load, contextCompiler } = makeHarness('off');
    await expect(load(ctx, 'client-1')).resolves.toBe(
      'Client: Acme\nDescription: Client description',
    );
    expect(contextCompiler.compile).not.toHaveBeenCalled();
  });

  it('records shadow evidence without changing the prompt context', async () => {
    const { load, contextCompiler } = makeHarness('shadow');
    const result = await load(ctx, 'client-1');
    expect(result).toBe('Client: Acme\nDescription: Client description');
    expect(contextCompiler.compile).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'research', clientId: 'client-1' }),
    );
  });

  it('adds plain governed context only in enforce mode', async () => {
    const { load } = makeHarness('enforce');
    await expect(load(ctx, 'client-1')).resolves.toBe(
      'Client: Acme\nDescription: Client description\n\nFirm-approved governed context.',
    );
  });

  it('propagates a required persistence hold before research emits output', async () => {
    const { load, contextCompiler } = makeHarness('enforce');
    const failure = new ContextPacketPersistenceError(
      'context_packet_error',
      'attempt-1',
      'research',
    );
    contextCompiler.compile.mockRejectedValueOnce(failure);
    await expect(load(ctx, 'client-1')).rejects.toBe(failure);
  });
});
