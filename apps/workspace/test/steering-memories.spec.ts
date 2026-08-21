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

/**
 * Phase 21 moved governed-memory loading out of the Workspace service: the
 * compiler is now a thin backend Context Plane client, not a Prisma reader.
 * The former "adapter contract" block here asserted the retired behaviour
 * (direct memory_items reads, GUC setting, local trace INSERT) and could no
 * longer even compile. Its replacement is
 * src/generation/context-compiler.canonical-memory.spec.ts, which covers the
 * HTTP contract and both fail-closed paths. The packet-recomposition contract
 * below is still live behaviour and is retained unchanged.
 */


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
        // Phase 21 made Workspace generation packet-required, so the request now
        // carries the governed contract explicitly. These are asserted rather
        // than loosened away: `persistence: 'required'` and `contractVersion: 2`
        // are the fields that stop an ungoverned provider call.
        contractVersion: 2,
        persistence: 'required',
        render: 'all',
        tokenBudget: 12_000,
        budgetUnit: 'tokens',
        ethicalWallAllowed: true,
        traceId: expect.any(String),
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
    expect(out.degradedReasons).toContain('context_plane_packet_not_persisted');
  });

  /**
   * Phase 21 made both Workspace operations packet-required, so a Context Plane
   * outage is now FAIL-CLOSED. This test previously asserted the opposite (an
   * empty, "degraded" context returned to the caller), which is precisely the
   * path that would let generation continue into an ungoverned provider call.
   */
  it('a compile failure is fail-closed: it reaches the caller instead of degrading', async () => {
    const compiler = {
      resolveClientIdByExactName: jest.fn(async () => null),
      resolveEthicalWallAllowedForClerkOwner: jest.fn(async () => true),
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

    await expect(call(service)).rejects.toThrow('db down');
    expect(
      (compiler as unknown as { compileForClerkOwner: jest.Mock }).compileForClerkOwner,
    ).toHaveBeenCalledTimes(1);
  });
});
