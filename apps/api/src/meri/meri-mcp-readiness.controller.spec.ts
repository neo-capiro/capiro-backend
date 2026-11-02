import type { TenantContext } from '@capiro/shared';
import { MeriController } from './meri.controller.js';

// These unrelated route services pull in the product's external agent runtime.
jest.mock('./meri.service.js', () => ({ MeriService: class {} }));
jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('./meri-research.service.js', () => ({ MeriResearchService: class {} }));
jest.mock('./execution-capability/meri-execution-receiver.service.js', () => ({ MeriExecutionReceiverService: class {} }));

const ctx = { tenantId: 'tenant', userId: 'owner' } as TenantContext;

function fixture() {
  const mcpOAuth = { start: jest.fn(async () => ({ authUrl: null as string | null, alreadyConnected: true })) };
  const mcp = { discoverTools: jest.fn(async () => 1) };
  const managedMcp = {
    appForServer: jest.fn(async (): Promise<{ id: string } | null> => null),
    finalizeConnection: jest.fn(async () => 1),
  };
  // Exercise the production receiver without constructing unrelated route services.
  const controller: MeriController = Object.assign(Object.create(MeriController.prototype), {
    mcpOAuth, mcp, managedMcp,
  });
  return { controller, mcpOAuth, mcp, managedMcp };
}

describe('common OAuth start readiness receiver', () => {
  test('a redirect returns without discovery or managed finalization', async () => {
    const { controller, mcpOAuth, mcp, managedMcp } = fixture();
    mcpOAuth.start.mockResolvedValue({ authUrl: 'https://auth.example/authorize', alreadyConnected: false });
    await expect(controller.startMcpOAuth(ctx, 'server')).resolves.toMatchObject({
      authUrl: 'https://auth.example/authorize',
    });
    expect(mcp.discoverTools).not.toHaveBeenCalled();
    expect(managedMcp.finalizeConnection).not.toHaveBeenCalled();
  });

  test('generic no-redirect readiness waits for authenticated discovery', async () => {
    const { controller, mcpOAuth, mcp, managedMcp } = fixture();
    let release!: (count: number) => void;
    mcp.discoverTools.mockImplementation(() => new Promise<number>((resolve) => { release = resolve; }));
    let settled = false;
    const result = controller.startMcpOAuth(ctx, 'server').then((value) => { settled = true; return value; });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(mcpOAuth.start).toHaveBeenCalledWith(ctx, 'server');
    expect(mcp.discoverTools).toHaveBeenCalledWith('tenant', 'server');
    expect(settled).toBe(false);
    release(1);
    await expect(result).resolves.toEqual({ authUrl: null, alreadyConnected: true });
    expect(managedMcp.finalizeConnection).not.toHaveBeenCalled();
  });

  test.each([null, { id: 'google_drive' }])('zero usable tools refuses readiness (managed=%p)', async (app) => {
    const { controller, mcp, managedMcp } = fixture();
    managedMcp.appForServer.mockResolvedValue(app);
    mcp.discoverTools.mockResolvedValue(0);
    await expect(controller.startMcpOAuth(ctx, 'server')).rejects.toThrow('No permitted tools');
    expect(managedMcp.finalizeConnection).not.toHaveBeenCalled();
  });

  test('managed readiness uses and awaits the canonical finalizer once', async () => {
    const { controller, mcp, managedMcp } = fixture();
    managedMcp.appForServer.mockResolvedValue({ id: 'google_drive' });
    let release!: (count: number) => void;
    managedMcp.finalizeConnection.mockImplementation(() => new Promise<number>((resolve) => { release = resolve; }));
    let settled = false;
    const result = controller.startMcpOAuth(ctx, 'server').then((value) => { settled = true; return value; });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(mcp.discoverTools).toHaveBeenCalledTimes(1);
    expect(managedMcp.finalizeConnection).toHaveBeenCalledTimes(1);
    expect(managedMcp.finalizeConnection).toHaveBeenCalledWith('tenant', 'server');
    expect(settled).toBe(false);
    release(1);
    await expect(result).resolves.toMatchObject({ alreadyConnected: true });
  });

  test.each(['current authority', 'discovery', 'finalization'])('%s failure cannot report readiness', async (stage) => {
    const { controller, mcpOAuth, mcp, managedMcp } = fixture();
    if (stage === 'current authority') mcpOAuth.start.mockRejectedValue(new Error('revoked'));
    if (stage === 'discovery') mcp.discoverTools.mockRejectedValue(new Error('revoked'));
    if (stage === 'finalization') {
      managedMcp.appForServer.mockResolvedValue({ id: 'google_drive' });
      managedMcp.finalizeConnection.mockRejectedValue(new Error('revoked'));
    }
    await expect(controller.startMcpOAuth(ctx, 'server')).rejects.toThrow('revoked');
    if (stage === 'current authority') expect(mcp.discoverTools).not.toHaveBeenCalled();
  });
});
