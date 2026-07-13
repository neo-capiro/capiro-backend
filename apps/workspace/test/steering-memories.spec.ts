import { GenerationService } from '../src/generation/generation.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { AiCredentialService } from '../src/generation/ai-credential.service';
import type { PeResolverService } from '../src/generation/pe-resolver.service';
import type { MeriV2FlagsService } from '../src/meriv2/meriv2-flags.service';
import type { MeriV2OrchestratorClient } from '../src/meriv2/meriv2-orchestrator.client';

/**
 * Regression tests for loadSteeringMemories' identity handling (G1 pre-fix).
 *
 * ws_draft.ownerId is a CLERK subject id (e.g. "user_2abc"), but
 * memory_items.owner_user_id is the Capiro users.id UUID. The original loader
 * cast the Clerk id straight to ::uuid — 22P02 on every call, swallowed by the
 * best-effort catch — so NO steering memory (not even the tenant-visible Firm
 * Soul/Compass) ever reached a prod prompt. It also never set
 * app.current_user, so even a correct UUID would have been filtered by the 1C
 * owner-aware RLS policy. These tests pin the fixed contract:
 *   1. resolve clerk id -> users.id inside the transaction,
 *   2. set app.current_user to the RESOLVED uuid,
 *   3. query memory_items with the resolved uuid (never the raw Clerk id),
 *   4. no owner => firm-only query, no user GUC, no crash.
 */
describe('GenerationService.loadSteeringMemories (Clerk->Capiro identity + RLS GUCs)', () => {
  const CLERK_ID = 'user_2NpQrsTuvWxYz';
  const CAPIRO_UUID = '3f7c2a44-9d1e-4b6f-8a5c-0e9d8c7b6a51';
  const FIRM_ROW = {
    id: 'mi-1',
    type: 'firm-soul',
    slug: 'firm',
    sections: [{ owner: 'human', heading: 'Who we are', body: 'A defense-focused firm.' }],
  };
  const VOICE_ROW = {
    id: 'mi-2',
    type: 'user-voice',
    slug: 'voice',
    sections: [{ owner: 'human', heading: 'Style', body: 'Plain, direct sentences.' }],
  };

  function makeService(opts: { userRows: Array<{ id: string }>; memoryRows: unknown[] }) {
    const executeRaw = jest.fn().mockResolvedValue(undefined);
    // First $queryRaw call = users resolution (only when ownerId given);
    // last call = the memory_items query. Distinguished by inspecting SQL text.
    const queryRaw = jest.fn().mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM users')) return Promise.resolve(opts.userRows);
      return Promise.resolve(opts.memoryRows);
    });
    const tx = { $executeRaw: executeRaw, $queryRaw: queryRaw };
    const prisma = {
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    const service = new GenerationService(
      prisma,
      {} as AiCredentialService,
      {} as PeResolverService,
      {} as MeriV2FlagsService,
      {} as MeriV2OrchestratorClient,
    );
    return { service, executeRaw, queryRaw };
  }

  /** SQL text of the nth template-tag call. */
  const sqlOf = (mock: jest.Mock, n: number): string =>
    (mock.mock.calls[n]![0] as TemplateStringsArray).join('¶');
  /** Bound parameter values of the nth template-tag call. */
  const paramsOf = (mock: jest.Mock, n: number): unknown[] => mock.mock.calls[n]!.slice(1);

  it('resolves the Clerk owner to users.id, sets app.current_user, and queries with the UUID', async () => {
    const { service, executeRaw, queryRaw } = makeService({
      userRows: [{ id: CAPIRO_UUID }],
      memoryRows: [FIRM_ROW, VOICE_ROW],
    });

    const result = await (
      service as unknown as {
        loadSteeringMemories: (
          t: string,
          o?: string,
        ) => Promise<{ firmContext?: string; userVoiceContext?: string; memoryFiles: unknown[] }>;
      }
    ).loadSteeringMemories('tenant-1', CLERK_ID);

    // (1) users resolution ran with the CLERK id.
    expect(sqlOf(queryRaw, 0)).toContain('FROM users');
    expect(paramsOf(queryRaw, 0)).toContain(CLERK_ID);

    // (2) BOTH GUCs set: tenant first, then the RESOLVED Capiro uuid.
    expect(sqlOf(executeRaw, 0)).toContain('app.current_tenant');
    expect(paramsOf(executeRaw, 0)).toContain('tenant-1');
    expect(sqlOf(executeRaw, 1)).toContain('app.current_user');
    expect(paramsOf(executeRaw, 1)).toContain(CAPIRO_UUID);

    // (3) the memory query binds the resolved UUID — never the raw Clerk id
    // (the old code's `clerkId::uuid` cast 22P02'd the whole query).
    const memParams = paramsOf(queryRaw, 1);
    expect(memParams).toContain(CAPIRO_UUID);
    expect(memParams).not.toContain(CLERK_ID);

    // (4) both families render.
    expect(result.firmContext).toContain('A defense-focused firm.');
    expect(result.userVoiceContext).toBe('Style: Plain, direct sentences.');
    expect(result.memoryFiles).toHaveLength(2);
  });

  it('unknown Clerk id: no user GUC, memory query binds null owner, firm rows still load', async () => {
    const { service, executeRaw, queryRaw } = makeService({
      userRows: [], // no matching Capiro user
      memoryRows: [FIRM_ROW],
    });

    const result = await (
      service as unknown as {
        loadSteeringMemories: (
          t: string,
          o?: string,
        ) => Promise<{ firmContext?: string; userVoiceContext?: string; memoryFiles: unknown[] }>;
      }
    ).loadSteeringMemories('tenant-1', CLERK_ID);

    // Only the tenant GUC — app.current_user must NOT be set to a junk value.
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(sqlOf(executeRaw, 0)).toContain('app.current_tenant');
    expect(paramsOf(queryRaw, 1)).not.toContain(CLERK_ID);

    expect(result.firmContext).toContain('A defense-focused firm.');
    expect(result.userVoiceContext).toBeUndefined();
    expect(result.memoryFiles).toHaveLength(1);
  });

  it('no ownerId at all: skips users resolution entirely, loads firm rows', async () => {
    const { service, executeRaw, queryRaw } = makeService({
      userRows: [],
      memoryRows: [FIRM_ROW],
    });

    const result = await (
      service as unknown as {
        loadSteeringMemories: (
          t: string,
          o?: string,
        ) => Promise<{ firmContext?: string; memoryFiles: unknown[] }>;
      }
    ).loadSteeringMemories('tenant-1');

    // Single query: memory_items only — no users lookup without an owner.
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(sqlOf(queryRaw, 0)).toContain('FROM memory_items');
    expect(executeRaw).toHaveBeenCalledTimes(1); // tenant GUC only
    expect(result.firmContext).toContain('A defense-focused firm.');
  });
});
