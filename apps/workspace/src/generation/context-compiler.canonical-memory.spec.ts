import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { WorkspaceContextCompilerService } from './context-compiler.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DRAFT = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const CLERK = 'user_phase21';

const PACKET = {
  version: 2 as const,
  tenantId: TENANT,
  effectiveTenantId: TENANT,
  surface: 'workspace-gen' as const,
  packetId: '44444444-4444-4444-8444-444444444444',
  generatedPacketId: '44444444-4444-4444-8444-444444444444',
  persistedPacketId: '44444444-4444-4444-8444-444444444444',
  persisted: true,
  userId: '55555555-5555-4555-8555-555555555555',
  actorUserId: '55555555-5555-4555-8555-555555555555',
  clientId: CLIENT,
  ref: { draftId: DRAFT },
  items: [],
  exclusions: [],
  rendered: [],
  traceHash: 'phase21-trace',
  contractVersion: 2 as const,
  traceId: null,
  promptVersion: 'workspace-phase21',
  policyVersion: 'workspace-phase21',
  compilerVersion: 'phase21',
  requiredLayers: [],
  health: { status: 'healthy' as const, reasons: [] },
  totalTokenBudget: 12000,
  usedTokens: 0,
  truncated: false,
  incomplete: false,
};

describe('Workspace Context Plane client — Phase 21', () => {
  const originalBase = process.env.API_BASE_URL;
  const originalSecret = process.env.INTERNAL_SERVICE_SECRET;

  beforeEach(() => {
    process.env.API_BASE_URL = 'https://api.example.test';
    process.env.INTERNAL_SERVICE_SECRET = 'phase21-secret';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalBase;
    if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
  });

  it('routes document generation through the backend Context Plane with the service secret', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          packet: PACKET,
          governedContext: { prompt: 'governed retrieval body' },
          supplementalEvidence: 'distinctive retrieval body',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const service = new WorkspaceContextCompilerService();

    const packet = await service.compileForClerkOwner(
      {
        tenantId: TENANT,
        surface: 'workspace-gen',
        layers: ['firm-identity', 'user-voice'],
        ref: { draftId: DRAFT },
      },
      CLERK,
    );

    expect(packet).toMatchObject({
      ...PACKET,
      governedContext: { prompt: 'governed retrieval body' },
      supplementalEvidence: 'distinctive retrieval body',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/api/internal/workspace/context/compile');
    expect((init?.headers as Record<string, string>)['x-internal-service-secret']).toBe(
      'phase21-secret',
    );
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({
        tenantId: TENANT,
        clerkUserId: CLERK,
        operationId: 'workspace.generate',
      }),
    );
  });

  it('routes editor/comment assistance to workspace.editor-assist', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          packet: { ...PACKET, surface: 'workspace-editor' },
          governedContext: { prompt: 'editor governed prompt' },
          supplementalEvidence: 'editor retrieval evidence',
        }),
        { status: 200 },
      ),
    );
    const service = new WorkspaceContextCompilerService();

    await service.compileForClerkOwner(
      {
        tenantId: TENANT,
        surface: 'workspace-gen',
        layers: ['firm-identity', 'user-voice'],
        ref: {},
      },
      CLERK,
    );

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({ operationId: 'workspace.editor-assist' }),
    );
  });

  it('delegates exact client lookup and ethical-wall authorization to apps/api', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ clientId: CLIENT }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ allowed: true }), { status: 200 }));
    const service = new WorkspaceContextCompilerService();

    await expect(service.resolveClientIdByExactName(TENANT, 'Acme')).resolves.toBe(CLIENT);
    await expect(
      service.resolveEthicalWallAllowedForClerkOwner(TENANT, CLERK, CLIENT),
    ).resolves.toBe(true);

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/resolve-client');
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain('/authorize-client');
  });

  it('fails closed when the governed runtime projection is missing', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ packet: PACKET }), { status: 200 }));
    const service = new WorkspaceContextCompilerService();
    await expect(
      service.compileForClerkOwner(
        {
          tenantId: TENANT,
          surface: 'workspace-gen',
          layers: ['firm-identity'],
          ref: { draftId: DRAFT },
        },
        CLERK,
      ),
    ).rejects.toThrow('workspace_context_plane_governed_projection_missing');
  });

  it('fails closed when the backend service secret is unavailable', async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    const service = new WorkspaceContextCompilerService();
    await expect(
      service.compileForClerkOwner(
        {
          tenantId: TENANT,
          surface: 'workspace-gen',
          layers: ['firm-identity'],
          ref: { draftId: DRAFT },
        },
        CLERK,
      ),
    ).rejects.toThrow('workspace_context_plane_internal_secret_missing');
  });
});
