import 'reflect-metadata';
import { MeriController } from './meri.controller.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { bootstrapWorkspaceGenerationConversation } from './meri-conversation-bootstrap.js';

const source = { schemaVersion: 1, requestId: `wsgen:${'a'.repeat(64)}`,
  draftId: '00000000-0000-4000-8000-000000000001',
  prospectId: '00000000-0000-4000-8000-000000000002',
  sourceVersionId: '00000000-0000-4000-8000-000000000003', sourceSnapshotHash: 'b'.repeat(64) };

describe('Workspace generation bootstrap boundary', () => {
  it.each([null, { ...source, tenantId: source.draftId }, { ...source, clientId: source.draftId },
    { ...source, sourceVersionId: 'latest' }, { ...source, schemaVersion: 2 }])(
    'refuses malformed or widened sources before any database access: %j', async raw => {
      const owner = { withTenant: jest.fn() };
      await expect(bootstrapWorkspaceGenerationConversation(owner as never, {} as never, raw,
        { brand: 'Meri', runtime: 'native' })).rejects.toMatchObject({ status: 400 });
      expect(owner.withTenant).not.toHaveBeenCalled();
    });

  it('requires verified service identity even when the guard is in observe mode', async () => {
    const call = jest.fn(async () => ({ ok: true }));
    const controller = Object.assign(Object.create(MeriController.prototype), {
      service: { bootstrapWorkspaceGeneration: call },
    }) as MeriController;
    const guard = new ToolServiceSecretGuard({ get: (name: string) => ({
      NODE_ENV: 'test', MERI_TOOLS_REQUIRE_SERVICE_SECRET: false,
      INTERNAL_SERVICE_SECRET: 'synthetic-workspace-generation-service',
    } as Record<string, unknown>)[name] } as never);
    const bad = { headers: {} };
    expect(guard.verifyRequest(bad as never)).toBe(true);
    expect(() => controller.bootstrapWorkspaceGeneration({} as never, source, bad as never)).toThrow();
    expect(call).not.toHaveBeenCalled();
    const current = { headers: { 'x-internal-service-secret': 'synthetic-workspace-generation-service' } };
    const actor = { tenantId: 'current-tenant', userId: 'current-actor' };
    expect(guard.verifyRequest(current as never)).toBe(true);
    await expect(controller.bootstrapWorkspaceGeneration(actor as never, source, current as never)).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith(actor, source);
    expect(Reflect.getMetadata('__guards__', MeriController.prototype.bootstrapWorkspaceGeneration)).toContain(ToolServiceSecretGuard);
  });
});
