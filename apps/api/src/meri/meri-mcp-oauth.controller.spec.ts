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
    // Ordinary connectors resolve null; managed apps resolve their catalog row.
    appForServer: jest.fn(async (): Promise<{ id: string; name: string } | null> => ({
      id: 'hubspot',
      name: 'HubSpot',
    })),
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

describe('ordinary OAuth completion redirect', () => {
  /** Ordinary (non-managed) connector: no managed app row, so the browser is bounced back. */
  function ordinary(successRedirect: string, name = 'Field Notes & Co') {
    const fixture = make();
    fixture.oauth.getSuccessRedirect.mockReturnValue(successRedirect);
    fixture.oauth.handleCallback.mockResolvedValue({
      tenantId: 'tenant',
      serverId: 'server',
      name,
    });
    fixture.managed.appForServer.mockResolvedValue(null);
    return fixture;
  }

  test('success keeps a relative destination page, query and fragment', async () => {
    const { controller, res } = ordinary(
      '/settings/meri-preferences?page=connected-services#connected',
    );
    await controller.callback('code', 'state', undefined, undefined, res as never);
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      '/settings/meri-preferences?page=connected-services&provider=mcp&mcp_connected=Field%20Notes%20%26%20Co#connected',
    );
    // The page parameter is still exactly the configured value, not "connected-services?provider".
    const target = res.redirect.mock.calls[0][1] as string;
    expect(new URL(target, 'https://app.capiro.ai').searchParams.get('page')).toBe(
      'connected-services',
    );
  });

  test('success keeps an absolute destination and its existing parameters', async () => {
    const { controller, res } = ordinary(
      'https://app.capiro.ai/settings/meri-preferences?page=connected-services&tab=mine#connected',
    );
    await controller.callback('code', 'state', undefined, undefined, res as never);
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://app.capiro.ai/settings/meri-preferences?page=connected-services&tab=mine&provider=mcp&mcp_connected=Field%20Notes%20%26%20Co#connected',
    );
  });

  test('access_denied reports the failure on a relative destination', async () => {
    const { controller, oauth, res } = ordinary(
      '/settings/meri-preferences?page=connected-services#connected',
    );
    await controller.callback(undefined, 'signed-state', 'access_denied', undefined, res as never);
    expect(oauth.handleFailure).toHaveBeenCalledWith('signed-state', true, undefined);
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      '/settings/meri-preferences?page=connected-services&provider=mcp&mcp_error=Sign-in%20did%20not%20complete#connected',
    );
  });

  test('access_denied reports the failure on an absolute destination', async () => {
    const { controller, res } = ordinary(
      'https://app.capiro.ai/settings/meri-preferences?page=connected-services#connected',
      'ignored',
    );
    await controller.callback(undefined, 'signed-state', 'access_denied', undefined, res as never);
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://app.capiro.ai/settings/meri-preferences?page=connected-services&provider=mcp&mcp_error=Sign-in%20did%20not%20complete#connected',
    );
  });

  test('an outcome already present in the destination is replaced, not duplicated', async () => {
    const { controller, res } = ordinary(
      '/settings/meri-preferences?page=connected-services&provider=stale&mcp_connected=old',
      'Tavily',
    );
    await controller.callback('code', 'state', undefined, undefined, res as never);
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      '/settings/meri-preferences?page=connected-services&provider=mcp&mcp_connected=Tavily',
    );
  });
});
