import { MeriMcpOAuthController } from './meri-mcp-oauth.controller.js';

function make() {
  const oauth = {
    getSuccessRedirect: jest.fn(() => '/settings/integrations'),
    handleCallback: jest.fn(async () => ({
      tenantId: 'tenant',
      serverId: 'server',
      name: 'meriv3-hubspot',
    })),
    handleFailure: jest.fn(async () => ({ tenantId: 'tenant', serverId: 'server' })),
  };
  const mcp = { discoverTools: jest.fn(async () => 1), invalidate: jest.fn() };
  const managed = {
    appForServer: jest.fn(async () => ({ id: 'hubspot', name: 'HubSpot' })),
    finalizeConnection: jest.fn(async () => 1),
  };
  const res = { status: jest.fn(), type: jest.fn(), send: jest.fn(), redirect: jest.fn() };
  res.status.mockReturnValue(res);
  res.type.mockReturnValue(res);
  const controller = new MeriMcpOAuthController(oauth as never, mcp as never, managed as never);
  return { controller, oauth, mcp, managed, res };
}

describe('managed OAuth completion', () => {
  test('never shows connected when authenticated discovery fails', async () => {
    const { controller, mcp, managed, res } = make();
    mcp.discoverTools.mockResolvedValue(0);
    await controller.callback('code', 'signed-state', undefined, undefined, res as never);
    expect(managed.finalizeConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Sign-in did not complete'));
  });

  test('success follows discovery and read-only finalization', async () => {
    const { controller, mcp, managed, res } = make();
    await controller.callback('code', 'signed-state', undefined, undefined, res as never);
    expect(mcp.discoverTools).toHaveBeenCalledWith('tenant', 'server');
    expect(managed.finalizeConnection).toHaveBeenCalledWith('tenant', 'server');
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('HubSpot connected'));
  });

  test('cancellation consumes signed state and does not reflect provider error text', async () => {
    const { controller, oauth, mcp, res } = make();
    await controller.callback(
      undefined,
      'signed-state',
      'access_denied',
      '<script>secret</script>',
      res as never,
    );
    expect(oauth.handleFailure).toHaveBeenCalledWith('signed-state', true, undefined);
    expect(mcp.discoverTools).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Sign-in cancelled'));
    expect(res.send.mock.calls[0][0]).not.toContain('<script>');
  });

  test('invalid or missing state cannot change a connection', async () => {
    const { controller, oauth, res } = make();
    await controller.callback(undefined, undefined, 'access_denied', undefined, res as never);
    expect(oauth.handleFailure).not.toHaveBeenCalled();
    expect(oauth.handleCallback).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('a concurrent disconnect that blocks finalization cannot show success', async () => {
    const { controller, managed, res } = make();
    managed.finalizeConnection.mockRejectedValue(new Error('no longer active'));
    await controller.callback('code', 'state', undefined, undefined, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send.mock.calls[0][0]).not.toContain('HubSpot connected');
  });
});
