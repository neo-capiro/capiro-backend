import type { TenantContext } from '@capiro/shared';
import { MeriV2OrchestratorClient } from './meriv2-orchestrator.client.js';
import type { WorkspaceContextPlaneService } from './workspace-context-plane.service.js';
import type { WorkspaceAssistantDto } from './workspace-assistant.dto.js';

describe('MeriV2 editor authenticated delegation', () => {
  const savedUrl = process.env.MERIV2_ORCHESTRATOR_URL;
  const savedSecret = process.env.INTERNAL_SERVICE_SECRET;
  const ctx = { tenantId: 'trusted-tenant', userId: 'local-user-uuid', clerkUserId: 'user_clerk_authenticated' } as TenantContext;
  const dto = {
    messages: [{ role: 'user', text: 'Refine this draft' }],
    document: { title: 'Hearing recap', sections: [] },
    tenantId: 'forged-tenant', clerkUserId: 'forged-user',
  } as unknown as WorkspaceAssistantDto;
  const governedContext = { version: 1, operationId: 'workspace.editor-assist' };
  const resolveEditor = jest.fn();
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    process.env.MERIV2_ORCHESTRATOR_URL = 'https://orchestrator.example';
    process.env.INTERNAL_SERVICE_SECRET = 'test-internal-secret';
    resolveEditor.mockReset().mockResolvedValue({ governedContext });
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ reply: 'Done', edits: [] }), { status: 200 }));
  });
  afterEach(() => {
    fetchMock.mockRestore();
    if (savedUrl === undefined) delete process.env.MERIV2_ORCHESTRATOR_URL;
    else process.env.MERIV2_ORCHESTRATOR_URL = savedUrl;
    if (savedSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = savedSecret;
  });
  const client = () => new MeriV2OrchestratorClient({ resolveEditor } as unknown as WorkspaceContextPlaneService);

  it('delegates only authenticated tenant and Clerk identity while retaining bearer, secret and governed context', async () => {
    await expect(client().runInEditorAssistant(ctx, dto, 'caller-token')).resolves.toEqual({ reply: 'Done', edits: [] });
    expect(resolveEditor).toHaveBeenCalledWith(ctx, dto);
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://orchestrator.example/meri-api/in-editor-assistant');
    expect(request.headers).toEqual({
      authorization: 'Bearer caller-token',
      'content-type': 'application/json',
      'x-internal-service-secret': 'test-internal-secret',
      'x-capiro-delegated-tenant': 'trusted-tenant',
      'x-capiro-delegated-user': 'user_clerk_authenticated',
    });
    expect(JSON.parse(request.body).governedContext).toEqual(governedContext);
  });

  it.each([{ tenantId: '' }, { tenantId: '   ' }, { clerkUserId: '' }, { clerkUserId: '   ' }])('refuses incomplete authenticated identity %j before context resolution or an external request', async (patch) => {
    await expect(client().runInEditorAssistant({ ...ctx, ...patch }, dto, 'caller-token')).rejects.toThrow('requires authenticated tenant and Clerk user identities');
    expect(resolveEditor).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains the required caller bearer and service-secret gates', async () => {
    await expect(client().runInEditorAssistant(ctx, dto, undefined)).rejects.toThrow('requires the caller bearer token');
    delete process.env.INTERNAL_SERVICE_SECRET;
    await expect(client().runInEditorAssistant(ctx, dto, 'caller-token')).rejects.toThrow('requires INTERNAL_SERVICE_SECRET');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
