import { z } from 'zod';
import { InMemoryToolRegistry } from '../registry/tool-registry';
import { ScopingError } from './scoping-wrapper';
import type { MeriContext, ToolDefinition } from '../registry/types';
import {
  createGetClientContextTool,
  type ClientContextRepo,
  type ClientContextResult,
} from '../tools/client/get-client-context';

/**
 * A5 / SC0.7 — cross-tenant row-scoping parity, run deterministically.
 *
 * The guarantee is structural: a tool handler can only be reached through
 * `registry.invoke`, which validates the caller's `MeriContext` and forwards it
 * to the data port; the port MUST filter on `ctx.tenantId`. This test stands up
 * a tenant-partitioned fake datastore and proves, through the real registry,
 * that a caller in tenant A can never read tenant B's rows and that an
 * incomplete context cannot execute at all. (The prod parity harness runs the
 * same assertion against the live api/orchestrator over two seeded tenants;
 * this is the hermetic, always-on version.)
 */

const CLIENTS: Record<string, { tenantId: string; name: string }> = {
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa': { tenantId: 'tenant-A', name: 'Aperture (A)' },
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb': { tenantId: 'tenant-B', name: 'Beryl (B)' },
};

/**
 * Fake tenant-partitioned repo: it can ONLY see rows for the caller's tenant —
 * exactly the guarantee RLS + the api's withTenant enforce in prod. A row whose
 * tenantId != ctx.tenantId is invisible (returns "not found"), never leaked.
 */
class FakeScopedRepo implements ClientContextRepo {
  readonly seen: Array<{ tenantId: string; clientId: string }> = [];
  async loadClientContext(ctx: MeriContext, clientId: string): Promise<ClientContextResult> {
    this.seen.push({ tenantId: ctx.tenantId, clientId });
    const row = CLIENTS[clientId];
    if (!row || row.tenantId !== ctx.tenantId) {
      throw new Error('Client not found'); // 0 rows for a foreign tenant
    }
    return { client: { id: clientId, name: row.name } };
  }
}

const ctxA: MeriContext = {
  tenantId: 'tenant-A',
  userId: 'user-a',
  clerkUserId: 'cu-a',
  role: 'member' as never,
};
const ctxB: MeriContext = {
  tenantId: 'tenant-B',
  userId: 'user-b',
  clerkUserId: 'cu-b',
  role: 'member' as never,
};
const A_CLIENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B_CLIENT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeRegistry(repo: ClientContextRepo) {
  const registry = new InMemoryToolRegistry();
  registry.register(createGetClientContextTool(repo));
  return registry;
}

describe('cross-tenant row-scoping parity (SC0.7)', () => {
  it('a caller reads only its OWN tenant rows through the registry', async () => {
    const repo = new FakeScopedRepo();
    const registry = makeRegistry(repo);
    const out = await registry.invoke<ClientContextResult>(
      'get_client_context',
      { clientId: A_CLIENT },
      ctxA,
    );
    expect(out.client.id).toBe(A_CLIENT);
    expect(out.client.name).toBe('Aperture (A)');
    // The repo was queried with the CALLER's tenant, never a wildcard.
    expect(repo.seen).toEqual([{ tenantId: 'tenant-A', clientId: A_CLIENT }]);
  });

  it("a caller CANNOT read another tenant's row (cross-tenant read yields nothing)", async () => {
    const repo = new FakeScopedRepo();
    const registry = makeRegistry(repo);
    // Tenant A asks for tenant B's client id → the repo only ever sees A's
    // tenantId, so B's row is invisible: not found, never leaked.
    await expect(
      registry.invoke('get_client_context', { clientId: B_CLIENT }, ctxA),
    ).rejects.toThrow(/not found/i);
    expect(repo.seen).toEqual([{ tenantId: 'tenant-A', clientId: B_CLIENT }]);
    // And the same id IS visible to its real owner — proving the row exists and
    // only the scope changed the outcome.
    const owned = await registry.invoke<ClientContextResult>(
      'get_client_context',
      { clientId: B_CLIENT },
      ctxB,
    );
    expect(owned.client.name).toBe('Beryl (B)');
  });

  it('refuses to execute with an incomplete MeriContext (no unscoped run)', async () => {
    const repo = new FakeScopedRepo();
    const registry = makeRegistry(repo);
    const badCtx = {
      tenantId: '',
      userId: 'u',
      clerkUserId: 'c',
      role: 'member' as never,
    } as MeriContext;
    await expect(
      registry.invoke('get_client_context', { clientId: A_CLIENT }, badCtx),
    ).rejects.toBeInstanceOf(ScopingError);
    // The handler never ran → the repo was never queried.
    expect(repo.seen).toEqual([]);
  });

  it('applies the same scoping to every registered read tool (generic invariant)', async () => {
    // A second tenant-scoped tool proves the guarantee is registry-wide, not
    // special-cased to get_client_context.
    const seen: string[] = [];
    const echoTool: ToolDefinition<{ q: string }, { tenantId: string }> = {
      name: 'echo_scope',
      description: 'returns the caller tenant',
      readOnly: true,
      inputSchema: z.object({ q: z.string() }),
      handler: async (_input, ctx) => {
        seen.push(ctx.tenantId);
        return { tenantId: ctx.tenantId };
      },
    };
    const registry = new InMemoryToolRegistry();
    registry.register(echoTool);
    const a = await registry.invoke<{ tenantId: string }>('echo_scope', { q: 'x' }, ctxA);
    const b = await registry.invoke<{ tenantId: string }>('echo_scope', { q: 'x' }, ctxB);
    expect(a.tenantId).toBe('tenant-A');
    expect(b.tenantId).toBe('tenant-B');
    expect(seen).toEqual(['tenant-A', 'tenant-B']);
  });
});
