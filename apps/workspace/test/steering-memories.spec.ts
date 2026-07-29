import { WorkspaceContextCompilerService } from '../src/generation/context-compiler.service';
import { GenerationService } from '../src/generation/generation.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { AiCredentialService } from '../src/generation/ai-credential.service';
import type { PeResolverService } from '../src/generation/pe-resolver.service';
import type { MeriV2FlagsService } from '../src/meriv2/meriv2-flags.service';
import type { MeriV2OrchestratorClient } from '../src/meriv2/meriv2-orchestrator.client';
import type { CollaboratorsService } from '../src/collaborators/collaborators.service';

/**
 * Steering-memory regression locks (G1-c — history: the pre-#442 loader cast
 * the Clerk owner id straight to ::uuid, 22P02'd on every call, and never set
 * app.current_user, so NO steering memory ever reached a prod prompt; both
 * failure modes now live behind the shared Context Compiler's workspace
 * adapter). Pins:
 *   1. compileForClerkOwner resolves clerk id -> users.id BEFORE compiling,
 *      and an unknown owner compiles with userId null (firm-only, no crash);
 *   2. the adapter transaction sets BOTH GUCs (tenant always, user when
 *      resolved) and binds the RESOLVED uuid — never the raw Clerk id;
 *   3. the steering query carries no status filter (governance is
 *      compiler-side and traced as exclusions);
 *   4. GenerationService.loadSteeringMemories recomposes the packet into the
 *      exact legacy block labels + Phase 3.3 provenance shape, fail-open.
 */
const CLERK_ID = 'user_2NpQrsTuvWxYz';
const CAPIRO_UUID = '3f7c2a44-9d1e-4b6f-8a5c-0e9d8c7b6a51';
const CLIENT_UUID = '8b1d4c22-77aa-4f3e-9c1b-2d5e6f7a8b90';
const human = (heading: string, body: string) => ({ owner: 'human', heading, body });

const FIRM_ROW = {
  id: 'mi-1',
  type: 'firm-soul',
  slug: 'firm',
  title: 'Firm Soul',
  clientId: null,
  status: 'active',
  sections: [human('Who we are', 'A defense-focused firm.')],
};
const VOICE_ROW = {
  id: 'mi-2',
  type: 'user-voice',
  slug: 'voice',
  title: 'My Writing Style',
  clientId: null,
  status: 'active',
  sections: [human('Style', 'Plain, direct sentences.')],
};

function makeAdapter(opts: { userRows: Array<{ id: string }>; memoryRows: unknown[] }) {
  const executeRaw = jest.fn().mockResolvedValue(undefined);
  const queryRaw = jest.fn().mockImplementation((strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('FROM users')) return Promise.resolve(opts.userRows);
    if (sql.includes('FROM memory_items')) return Promise.resolve(opts.memoryRows);
    return Promise.resolve([]);
  });
  const tx = { $executeRaw: executeRaw, $queryRaw: queryRaw };
  const prisma = {
    // The clerk->user resolution runs OUTSIDE the transaction (top-level
    // $queryRaw); the steering query + trace INSERT run inside $transaction.
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const service = new WorkspaceContextCompilerService(prisma);
  return { service, executeRaw, queryRaw };
}

const sqlOf = (mock: jest.Mock, n: number): string =>
  (mock.mock.calls[n]![0] as TemplateStringsArray).join('|');
const paramsOf = (mock: jest.Mock, n: number): unknown[] => mock.mock.calls[n]!.slice(1);

describe('WorkspaceContextCompilerService (adapter contract)', () => {
  it('resolves the Clerk owner, sets BOTH GUCs, binds the resolved uuid', async () => {
    const { service, executeRaw, queryRaw } = makeAdapter({
      userRows: [{ id: CAPIRO_UUID }],
      memoryRows: [FIRM_ROW, VOICE_ROW],
    });
    const packet = await service.compileForClerkOwner(
      { tenantId: 't1', surface: 'workspace-gen', layers: ['firm-identity', 'user-voice'] },
      CLERK_ID,
    );

    // users resolution ran with the CLERK id…
    expect(sqlOf(queryRaw, 0)).toContain('FROM users');
    expect(paramsOf(queryRaw, 0)).toContain(CLERK_ID);
    // …both GUCs set, user GUC with the RESOLVED uuid…
    expect(sqlOf(executeRaw, 0)).toContain('app.current_tenant');
    expect(sqlOf(executeRaw, 1)).toContain('app.current_user');
    expect(paramsOf(executeRaw, 1)).toContain(CAPIRO_UUID);
    // …and the memory query binds the uuid, never the Clerk id.
    const memCall = queryRaw.mock.calls.findIndex((c) =>
      (c[0] as TemplateStringsArray).join('').includes('FROM memory_items'),
    );
    expect(paramsOf(queryRaw, memCall)).toContain(CAPIRO_UUID);
    expect(paramsOf(queryRaw, memCall)).not.toContain(CLERK_ID);

    expect(packet.rendered.map((r) => r.type)).toEqual(['firm-soul', 'user-voice']);
  });

  it('unknown Clerk owner: compiles firm-only with userId null, sets no user GUC', async () => {
    const { service, executeRaw } = makeAdapter({
      userRows: [],
      memoryRows: [FIRM_ROW],
    });
    const packet = await service.compileForClerkOwner(
      { tenantId: 't1', surface: 'workspace-gen', layers: ['firm-identity', 'user-voice'] },
      CLERK_ID,
    );
    const gucCalls = executeRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join(''));
    expect(gucCalls.some((s) => s.includes('app.current_user'))).toBe(false);
    expect(packet.rendered.map((r) => r.type)).toEqual(['firm-soul']);
  });

  it('the steering query carries no status filter; superseded rows become exclusions', async () => {
    const { service, queryRaw } = makeAdapter({
      userRows: [{ id: CAPIRO_UUID }],
      memoryRows: [FIRM_ROW, { ...VOICE_ROW, id: 'mi-old', status: 'superseded' }],
    });
    const packet = await service.compileForClerkOwner(
      { tenantId: 't1', surface: 'workspace-gen', layers: ['firm-identity', 'user-voice'] },
      CLERK_ID,
    );
    const memCall = queryRaw.mock.calls.findIndex((c) =>
      (c[0] as TemplateStringsArray).join('').includes('FROM memory_items'),
    );
    expect(sqlOf(queryRaw, memCall)).not.toMatch(/status\s*=/i);
    expect(packet.exclusions).toEqual([
      expect.objectContaining({ id: 'mi-old', reason: 'superseded' }),
    ]);
  });
});

describe('GenerationService.loadSteeringMemories (packet recomposition)', () => {
  interface SteeringOut {
    firmContext?: string;
    userVoiceContext?: string;
    clientContext?: string;
    memoryFiles: Array<{ id: string; type: string; slug: string; label: string }>;
    contextPacketId: string | null;
    contextTraceHash: string | null;
    degraded: boolean;
    degradedReasons: string[];
  }

  function makeService(
    rendered: unknown[],
    opts: { persisted?: boolean; resolvedClientId?: string | null } = {},
  ) {
    const compiler = {
      resolveClientIdByExactName: jest.fn(async () => opts.resolvedClientId ?? null),
      // Server-derived ethical-wall decision (closeout §6). Allowed by default so
      // these recomposition fixtures keep testing block/provenance assembly; the
      // wall's fail-closed behaviour is covered in meriv2-core's compiler-v2 spec.
      resolveEthicalWallAllowedForClerkOwner: jest.fn(async () => true),
      compileForClerkOwner: jest.fn(async () => ({
        packetId: 'pkt-1',
        rendered,
        items: [],
        exclusions: [],
        traceHash: 'trace-hash-1',
        persisted: opts.persisted ?? true,
      })),
    } as unknown as WorkspaceContextCompilerService;
    const service = new GenerationService(
      {} as PrismaService,
      {} as AiCredentialService,
      {} as PeResolverService,
      {} as MeriV2FlagsService,
      {} as MeriV2OrchestratorClient,
      compiler,
      {} as CollaboratorsService,
    );
    return { service, compiler };
  }

  const call = (
    service: GenerationService,
    ownerId?: string,
    clientName?: string | null,
    draftId?: string,
  ) =>
    (
      service as unknown as {
        loadSteeringMemories: (
          t: string,
          o?: string,
          c?: string | null,
          d?: string,
        ) => Promise<SteeringOut>;
      }
    ).loadSteeringMemories('t1', ownerId, clientName, draftId);

  it('recomposes the legacy block labels + Phase 3.3 provenance from the packet', async () => {
    const { service, compiler } = makeService([
      {
        layer: 'firm-identity',
        id: 'mi-1',
        type: 'firm-soul',
        slug: 'firm',
        title: 'Firm Soul',
        body: 'Who we are: A defense-focused firm.',
      },
      {
        layer: 'firm-identity',
        id: 'mi-3',
        type: 'firm-compass',
        slug: 'firm',
        title: 'Firm Compass',
        body: 'Direction: Win FY27.',
      },
      {
        layer: 'user-voice',
        id: 'mi-2',
        type: 'user-voice',
        slug: 'voice',
        title: 'My Writing Style',
        body: 'Style: Plain, direct sentences.',
      },
    ]);
    const out = await call(service, CLERK_ID, null, 'draft-1');

    expect(
      (compiler as unknown as { compileForClerkOwner: jest.Mock }).compileForClerkOwner,
    ).toHaveBeenCalledWith(
      {
        tenantId: 't1',
        clientId: null,
        surface: 'workspace-gen',
        layers: ['firm-identity', 'user-voice'],
        ref: { draftId: 'draft-1' },
      },
      CLERK_ID,
    );
    expect(out.firmContext).toBe(
      'Firm identity (Firm Soul):\nWho we are: A defense-focused firm.\n\nFirm direction (Firm Compass):\nDirection: Win FY27.',
    );
    expect(out.userVoiceContext).toBe('Style: Plain, direct sentences.');
    expect(out.clientContext).toBeUndefined();
    expect(out.memoryFiles).toEqual([
      { id: 'mi-1', type: 'firm-soul', slug: 'firm', label: 'Firm Soul' },
      { id: 'mi-3', type: 'firm-compass', slug: 'firm', label: 'Firm Compass' },
      { id: 'mi-2', type: 'user-voice', slug: 'voice', label: 'My Writing Style' },
    ]);
    // A durable packet id + trace hash are claimed only because it persisted.
    expect(out.contextPacketId).toBe('pkt-1');
    expect(out.contextTraceHash).toBe('trace-hash-1');
    expect(out.degraded).toBe(false);
    expect(out.degradedReasons).toEqual([]);
  });

  it('adds the client layers and client blocks when the workspace client resolves', async () => {
    const { service, compiler } = makeService(
      [
        {
          layer: 'client-steering',
          id: 'mi-4',
          type: 'client-compass',
          slug: 'acme',
          title: null,
          body: 'Lead with readiness.',
        },
        {
          layer: 'client-people',
          id: 'mi-5',
          type: 'client-people',
          slug: 'acme',
          title: null,
          body: 'GC: Jane Doe',
        },
      ],
      { resolvedClientId: CLIENT_UUID },
    );
    const out = await call(service, CLERK_ID, 'Acme Defense', 'draft-1');

    expect(
      (compiler as unknown as { compileForClerkOwner: jest.Mock }).compileForClerkOwner,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_UUID,
        layers: ['firm-identity', 'user-voice', 'client-steering', 'client-people'],
      }),
      CLERK_ID,
    );
    expect(out.clientContext).toBe(
      'Client steering:\nLead with readiness.\n\nClient people (named principals):\nGC: Jane Doe',
    );
    expect(out.degraded).toBe(false);
  });

  it('degrades rather than guessing when the client name does not resolve', async () => {
    const { service, compiler } = makeService([], { resolvedClientId: null });
    const out = await call(service, CLERK_ID, 'Ambiguous Co', 'draft-1');

    expect(
      (compiler as unknown as { compileForClerkOwner: jest.Mock }).compileForClerkOwner,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: null, layers: ['firm-identity', 'user-voice'] }),
      CLERK_ID,
    );
    expect(out.clientContext).toBeUndefined();
    expect(out.degraded).toBe(true);
    expect(out.degradedReasons).toContain('client_not_resolved');
  });

  it('never claims a packet id when the trace was not persisted', async () => {
    const { service } = makeService([], { persisted: false });
    const out = await call(service, CLERK_ID);
    expect(out.contextPacketId).toBeNull();
    expect(out.degraded).toBe(true);
    expect(out.degradedReasons).toContain('context_packet_not_persisted');
  });

  it('a compile failure is non-fatal: empty context, no throw, marked degraded', async () => {
    const compiler = {
      resolveClientIdByExactName: jest.fn(async () => null),
      compileForClerkOwner: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as WorkspaceContextCompilerService;
    const service = new GenerationService(
      {} as PrismaService,
      {} as AiCredentialService,
      {} as PeResolverService,
      {} as MeriV2FlagsService,
      {} as MeriV2OrchestratorClient,
      compiler,
      {} as CollaboratorsService,
    );
    const out = await call(service);
    expect(out).toEqual({
      memoryFiles: [],
      contextPacketId: null,
      contextTraceHash: null,
      degraded: true,
      degradedReasons: ['context_compilation_failed'],
    });
  });
});
