import { z } from 'zod';
import { InMemoryToolRegistry, type MeriContext, type ToolDefinition } from '../../../src/index';
import type { EvalCase } from '../types';

/**
 * Multi-tenant fixture. A correctly-scoped tool returns ONLY ctx.tenantId rows.
 * More than two tenants so the eval exercises the full ordered caller×victim
 * matrix (P4-T2), not just a single a→b pair — a scoping bug that only leaks
 * between a specific pair would slip past a 2-tenant test.
 */
const STORE: Record<string, string[]> = {
  'tenant-a': ['a-secret-1', 'a-secret-2'],
  'tenant-b': ['b-secret-1'],
  'tenant-c': ['c-secret-1', 'c-secret-2', 'c-secret-3'],
};
const TENANTS = Object.keys(STORE);

type Empty = Record<string, never>;

function scopedTool(): ToolDefinition<Empty, { items: string[] }> {
  return {
    name: 'list_secrets',
    description: 'list tenant secrets (correctly scoped on ctx.tenantId)',
    readOnly: true,
    inputSchema: z.object({}),
    handler: async (_input, ctx) => ({ items: STORE[ctx.tenantId] ?? [] }),
  };
}

/**
 * A BUGGY tool that ignores scope and returns ALL tenants' rows. Registered
 * ONLY when MERIV2_EVAL_SEED_FAILURE=1, to prove the gate goes RED on a real
 * cross-client leak (SC0.6). Remove the env var → the gate goes green.
 */
function leakyTool(): ToolDefinition<Empty, { items: string[] }> {
  return {
    name: 'list_secrets',
    description: 'list tenant secrets (BUGGY: ignores scope)',
    readOnly: true,
    inputSchema: z.object({}),
    handler: async () => ({ items: Object.values(STORE).flat() }),
  };
}

const ctxFor = (tenantId: string): MeriContext => ({
  tenantId,
  userId: `user-${tenantId}`,
  clerkUserId: `clerk_${tenantId}`,
  role: 'standard_user',
});

export const crossTenantLeakageCase: EvalCase = {
  id: 'leakage.cross-tenant.matrix',
  category: 'leakage',
  description:
    'across the full ordered tenant matrix, a tool invoked as one tenant never returns another tenant’s rows',
  async run() {
    const registry = new InMemoryToolRegistry();
    const seedFailure = process.env.MERIV2_EVAL_SEED_FAILURE === '1';
    registry.register(seedFailure ? leakyTool() : scopedTool());

    const leaks: string[] = [];
    let checked = 0;
    // Every tenant as the CALLER; every OTHER tenant's rows are forbidden.
    for (const caller of TENANTS) {
      checked += 1;
      const out = await registry.invoke<{ items: string[] }>('list_secrets', {}, ctxFor(caller));
      const allowed = new Set(STORE[caller] ?? []);
      const foreign = out.items.filter((row) => !allowed.has(row));
      if (foreign.length) {
        // Attribute each leaked row to the victim tenant for a precise report.
        for (const row of foreign) {
          const victim = TENANTS.find((t) => (STORE[t] ?? []).includes(row)) ?? 'unknown';
          leaks.push(`${caller}←${victim}:${row}`);
        }
      }
    }
    return {
      pass: leaks.length === 0,
      detail:
        leaks.length === 0
          ? `no cross-tenant rows across ${checked} callers (${TENANTS.length}-tenant matrix)`
          : `LEAK across matrix: [${leaks.join(', ')}]`,
    };
  },
};
